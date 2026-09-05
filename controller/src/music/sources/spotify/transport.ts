// SpotifyTransport — the queue's PlaybackTransport in spotify mode. Owns the
// SEQUENCE the spec describes: the queue hands over pick B → at A's seam the
// controller commands B on the receiver → librespot reports track_changed →
// the mixer is told (telnet spotify_track, a real boundary + metadata) → the
// existing now-playing.json path fires onTrackStarted, airs the link over B's
// intro, scrobbles, runs the next pick. Nothing above the mixer changes.
//
// Three rules from CLAUDE.md shape it:
//   • the station must keep making sound — no pick by the seam means a random
//     pool track (the auto.m3u analogue), and a stopped/paused feed is restarted
//     after `idleMs`;
//   • policy lives in pure modules — every decision is seam-pure.ts, this file
//     is IO and wiring;
//   • degrade silently — every marker/telnet/API failure logs once and the tick
//     tries again; nothing here throws into the queue.
//
// Dependencies are injected for scripts/spotify-transport.test.ts; the
// production wiring is `startSpotifyTransportIfActive()` at the bottom.

import type { QueueItem } from '../../../broadcast/queue/types.js';
import type { PlaybackTransport } from '../../../broadcast/queue/transport.js';
import type { SpotifyPlayerEvent, SpotifyAudioState } from '../../../broadcast/spotify-player-pure.js';
import {
  applyEvent, seamDecision, mismatchAction, mixerMetadataFor, remainingMs,
  DEFAULT_START_TIMEOUT_MS, DEFAULT_IDLE_MS,
  type CurrentTrack, type MismatchPolicy,
} from './seam-pure.js';

export interface TransportDeps {
  // player commands
  play: (trackId: string) => Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  transferHere: (play: boolean) => Promise<boolean>;
  // mixer (telnet)
  mixerTrack: (meta: Record<string, string>) => Promise<{ lagSec: number } | null>;
  mixerGap: (on: boolean) => Promise<boolean>;
  // markers
  readPlayerEvent: () => SpotifyPlayerEvent | null;
  readAudioState: () => SpotifyAudioState | null;
  // catalog
  songById: (id: string) => Promise<any | null>;
  fallbackSong: () => Promise<any | null>;
  // queue hooks
  onUnplayable: (item: QueueItem, reason: string) => void;
  log: (kind: string, line: string) => void;
  // settings
  seamLeadMs: () => number;
  mismatchPolicy: () => MismatchPolicy;
  now?: () => number;
  startTimeoutMs?: number;
  idleMs?: number;
}

interface Expected {
  id: string;
  item: QueueItem | null; // null = a pool fallback the queue never saw
  // The pool song a fallback command chose — what the mixer is told when it
  // starts, so now-playing names the track that is actually playing.
  song: any | null;
  commandedAt: number;
  attempts: number;
}

export class SpotifyTransport implements PlaybackTransport {
  readonly id = 'spotify';
  private pending: QueueItem | null = null;
  private expected: Expected | null = null;
  private current: CurrentTrack | null = null;
  private lastEventAt = 0;
  private lastCommandAt: number | null = null;
  private reclaimAttempts = 0;
  private gapOn = false;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private lastLog = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: TransportDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    (this.timer as any).unref?.();
    this.deps.log('scheduler', 'Spotify transport started — picks play on the Spotify Connect receiver');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── PlaybackTransport ────────────────────────────────────────────────────

  async handoff(item: QueueItem): Promise<void> {
    if (this.pending && this.pending !== item) {
      this.deps.log('scheduler', `Spotify transport: "${this.pending.track?.title}" replaced by "${item.track?.title}" before it aired`);
    }
    this.pending = item;
    // Nothing on air (boot, or the previous track ended while no pick was
    // ready): start it now rather than waiting for the tick's idle window.
    if (!this.expected && (!this.current || this.current.ended)) await this.tick(true);
  }

  async skip(): Promise<boolean> {
    if (this.busy) return false;
    this.deps.log('scheduler', 'Spotify transport: operator skip — commanding the next track now');
    await this.commandNext('operator skip');
    return true;
  }

  status(): Record<string, unknown> {
    const now = this.now();
    return {
      transport: 'spotify',
      current: this.current ? { id: this.current.id, playing: this.current.playing, ended: this.current.ended, remainingMs: remainingMs(this.current, now) } : null,
      awaitingStart: this.expected ? { id: this.expected.id, forMs: now - this.expected.commandedAt } : null,
      pending: this.pending ? { id: this.pending.track?.id ?? null, title: this.pending.track?.title ?? null } : null,
      gap: this.gapOn,
      lastEventAgoMs: this.lastEventAt ? now - this.lastEventAt : null,
      audio: this.deps.readAudioState(),
    };
  }

  // ── the tick ─────────────────────────────────────────────────────────────

  async tick(immediate = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // 1. Fold any new player event.
      const ev = this.deps.readPlayerEvent();
      if (ev && ev.at > this.lastEventAt) {
        this.lastEventAt = ev.at;
        await this.handleEvent(ev);
      }
      // 2. Decide about the seam.
      const now = this.now();
      const d = seamDecision({
        now,
        current: this.current,
        awaitingStart: !!this.expected,
        commandedAt: this.expected?.commandedAt ?? null,
        hasPending: !!this.pending,
        seamLeadMs: this.deps.seamLeadMs(),
        lastCommandAt: this.lastCommandAt,
        startTimeoutMs: this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        idleMs: immediate ? 0 : (this.deps.idleMs ?? DEFAULT_IDLE_MS),
      });
      if (d.action === 'command-next') {
        await this.commandNext(d.reason);
      } else if (d.action === 'command-timeout') {
        const exp = this.expected!;
        this.expected = null;
        this.logOnce(`timeout:${exp.id}`, 'error', `Spotify transport: "${exp.item?.track?.title ?? exp.id}" ${d.reason} — ${exp.attempts >= 2 ? 'giving up on it' : 'retrying once'}`);
        if (exp.attempts >= 2) {
          if (exp.item) this.deps.onUnplayable(exp.item, 'never started');
          if (this.pending === exp.item) this.pending = null;
          await this.commandNext('after a track that never started');
        } else {
          await this.command(exp.id, exp.item, exp.attempts + 1, 'retry', exp.song);
        }
      }
    } catch (err: any) {
      this.logOnce('tick-error', 'error', `Spotify transport tick failed: ${err?.message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  private async handleEvent(ev: SpotifyPlayerEvent): Promise<void> {
    const { current, meaning } = applyEvent(this.current, ev);
    this.current = current;
    switch (meaning.kind) {
      case 'started': {
        const exp = this.expected;
        if (exp && exp.id === meaning.trackId) {
          // The commanded track began: tell the mixer, release the item.
          this.expected = null;
          this.reclaimAttempts = 0;
          if (this.pending === exp.item) this.pending = null;
          await this.setGap(false);
          const song = exp.item?.track ?? exp.song ?? (await this.deps.songById(meaning.trackId).catch(() => null)) ?? { id: meaning.trackId };
          const lag = await this.deps.mixerTrack(mixerMetadataFor({ ...song, id: meaning.trackId }));
          this.deps.log('scheduler', `Spotify: "${song.title ?? meaning.trackId}" started on the receiver${lag ? ` (mixer mark in ${lag.lagSec.toFixed(1)}s)` : ''}${exp.item ? '' : ' — pool fallback, nothing was picked in time'}`);
          return;
        }
        // A track we did not command (a phone on the same account, autoplay,
        // a reclaim that lost the race).
        const action = mismatchAction(this.deps.mismatchPolicy(), this.reclaimAttempts);
        if (action === 'reclaim' && (exp || this.pending)) {
          this.reclaimAttempts++;
          const want = exp ?? { id: this.pending!.track!.id!, item: this.pending, song: null, commandedAt: this.now(), attempts: 0 };
          this.deps.log('error', `Spotify: receiver started "${meaning.trackId}" instead of "${want.item?.track?.title ?? want.id}" — reclaiming (attempt ${this.reclaimAttempts})`);
          await this.deps.transferHere(false);
          await this.command(want.id, want.item, (exp?.attempts ?? 0) + 1, 'reclaim', want.song);
          return;
        }
        // Adopt: publish what is actually playing so now-playing is never wrong
        // for long (spec §15). The queue sees an unknown id → source 'auto'.
        this.expected = null;
        this.reclaimAttempts = 0;
        await this.setGap(false);
        const song = (await this.deps.songById(meaning.trackId).catch(() => null)) ?? { id: meaning.trackId };
        await this.deps.mixerTrack(mixerMetadataFor({ ...song, id: meaning.trackId }));
        this.deps.log('scheduler', `Spotify: following "${song.title ?? meaning.trackId}" — started outside the station`);
        return;
      }
      case 'ended':
        // Silence until the next track starts is ours, not dead air.
        await this.setGap(true);
        return;
      case 'unavailable': {
        const exp = this.expected;
        if (exp && (!meaning.trackId || meaning.trackId === exp.id)) {
          this.expected = null;
          this.deps.log('error', `Spotify: "${exp.item?.track?.title ?? exp.id}" is unavailable on this account/market — dropping it`);
          if (exp.item) this.deps.onUnplayable(exp.item, 'unavailable');
          if (this.pending === exp.item) this.pending = null;
          await this.commandNext('after an unavailable track');
        }
        return;
      }
      case 'session': {
        this.deps.log('scheduler', `Spotify receiver session ${meaning.connected ? 'connected' : 'disconnected'}`);
        if (meaning.connected && (this.current?.playing || this.expected)) {
          // librespot restarted mid-track: playback is gone with it. Take the
          // receiver back and restart what should be playing.
          const want = this.expected ?? (this.pending ? { id: this.pending.track!.id!, item: this.pending, song: null, commandedAt: this.now(), attempts: 0 } : null);
          this.expected = null;
          this.current = null;
          await this.deps.transferHere(false);
          if (want) await this.command(want.id, want.item, 1, 'after reconnect', want.song);
          else await this.commandNext('after reconnect');
        }
        return;
      }
      default:
        return;
    }
  }

  // Command whatever should play next: the pending pick, else a pool fallback.
  private async commandNext(reason: string): Promise<void> {
    const item = this.pending;
    if (item?.track?.id) {
      await this.command(item.track.id, item, 1, reason);
      return;
    }
    const song = await this.deps.fallbackSong().catch(() => null);
    if (!song?.id) {
      this.logOnce('no-fallback', 'error', `Spotify transport: nothing to play (${reason}) and the pool is empty — the mixer's emergency loop covers the air`);
      await this.setGap(false); // let the guard speak
      return;
    }
    this.deps.log('scheduler', `Spotify transport: no pick ready (${reason}) — playing "${song.title}" from the pool`);
    await this.command(song.id, null, 1, reason, song);
  }

  private async command(trackId: string, item: QueueItem | null, attempts: number, reason: string, song: any | null = null): Promise<void> {
    this.lastCommandAt = this.now();
    this.expected = { id: trackId, item, song, commandedAt: this.now(), attempts };
    const r = await this.deps.play(trackId);
    if (r.ok) return;
    this.expected = null;
    this.deps.log('error', `Spotify: play "${item?.track?.title ?? trackId}" failed (${r.reason}: ${r.message}) [${reason}]`);
    if (r.reason === 'unplayable' && item) {
      this.deps.onUnplayable(item, r.message);
      if (this.pending === item) this.pending = null;
    }
    // no-device / auth / error: leave `pending` in place; the next tick's idle
    // window retries, and the doctor/status shows why.
  }

  private async setGap(on: boolean): Promise<void> {
    if (this.gapOn === on) return;
    this.gapOn = on;
    await this.deps.mixerGap(on);
  }

  private logOnce(key: string, kind: string, line: string, everyMs = 60_000): void {
    const last = this.lastLog.get(key) ?? 0;
    if (this.now() - last < everyMs) return;
    this.lastLog.set(key, this.now());
    this.deps.log(kind, line);
  }
}

// ── production wiring ───────────────────────────────────────────────────────

let instance: SpotifyTransport | null = null;

export async function startSpotifyTransportIfActive(): Promise<SpotifyTransport | null> {
  const source = await import('../../source.js');
  if (!source.activeCapabilities().hasLiveTransport || source.activeSourceId() !== 'spotify') return null;
  const { queue } = await import('../../../broadcast/queue.js');
  const { setLiveTransport } = await import('../../../broadcast/queue/transport.js');
  const liq = await import('../../../broadcast/liquidsoap-control.js');
  const markers = await import('../../../broadcast/spotify-player.js');
  const settings = await import('../../../settings.js');
  const { spotifyClient, spotifySettings, spotifySource } = await import('./source.js');
  const { SpotifyPlaybackController } = await import('./playback.js');

  const controller = new SpotifyPlaybackController({
    client: spotifyClient,
    deviceName: () => spotifySettings().deviceName || (settings.get() as any).station || 'SUB/WAVE',
    log: (l) => queue.log('scheduler', l),
  });
  instance = new SpotifyTransport({
    play: (id) => controller.play(id),
    transferHere: (p) => controller.transferHere(p),
    mixerTrack: (m) => liq.spotifyTrack(m),
    mixerGap: (on) => liq.spotifyGap(on),
    readPlayerEvent: () => markers.currentSpotifyPlayerEvent(),
    readAudioState: () => markers.currentSpotifyAudioState(),
    songById: (id) => spotifySource.getSong(id),
    fallbackSong: async () => (await spotifySource.getRandomSongs({ size: 1 }))[0] ?? null,
    onUnplayable: (item) => queue.onPushResolveFailed(item),
    log: (kind, line) => queue.log(kind, line),
    seamLeadMs: () => Number(spotifySettings().seamLeadMs ?? 1500),
    mismatchPolicy: () => (spotifySettings().mismatch === 'follow' ? 'follow' : 'reclaim'),
  });
  setLiveTransport(instance);
  instance.start();

  // Keep the receiver's login token fresh from its refresh token, so a wiped
  // librespot credential cache re-signs in without the operator. Hourly
  // tokens, refreshed every 50 minutes; a failure just logs (the cache is the
  // normal path — this file is only read on a cold login).
  const { readLibrespotToken, writeLibrespotToken } = await import('./token-file.js');
  const { refreshReceiverToken } = await import('./receiver-auth.js');
  const refresh = async () => {
    const rt = process.env.SPOTIFY_RECEIVER_REFRESH_TOKEN;
    if (!rt) return;
    const cur = await readLibrespotToken();
    if (cur && cur.expiresAt - Date.now() > 15 * 60 * 1000) return;
    try {
      const tok = await refreshReceiverToken(rt);
      await writeLibrespotToken(tok.accessToken, tok.expiresAt);
    } catch (err: any) {
      queue.log('error', `Spotify receiver token refresh failed: ${err?.message ?? err}`);
    }
  };
  void refresh();
  const t = setInterval(() => { void refresh(); }, 50 * 60 * 1000);
  (t as any).unref?.();
  return instance;
}

export function spotifyTransport(): SpotifyTransport | null {
  return instance;
}
