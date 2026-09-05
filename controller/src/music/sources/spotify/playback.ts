// SpotifyPlaybackController — "what is Spotify playing, and make it play X".
// Commands go over the Web API to the station's own Spotify Connect receiver
// (librespot in the broadcast container, named settings.spotify.deviceName or
// the station name). Truth about what is playing comes from librespot's events
// (broadcast/spotify-player.ts), not from polling — this class only COMMANDS
// and resolves the device.
//
// Everything is injected (client, device name, clock, log) so
// scripts/spotify-transport.test.ts drives it without an account.

import { SpotifyApiError, type SpotifyClient } from './client.js';

export interface PlaybackControllerDeps {
  client: () => Pick<SpotifyClient, 'getDevices' | 'play' | 'pause' | 'transfer' | 'getPlaybackState'>;
  deviceName: () => string;
  log?: (line: string) => void;
  now?: () => number;
  deviceCacheMs?: number;
}

export interface SpotifyDevice { id: string; name: string; is_active: boolean; type?: string; volume_percent?: number }

export class SpotifyPlaybackController {
  private device: { id: string; at: number } | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly cacheMs: number;

  constructor(private readonly deps: PlaybackControllerDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.cacheMs = deps.deviceCacheMs ?? 60_000;
  }

  // The receiver's device id, by name. Cached — Spotify's device list is a
  // slow call and the id is stable for a librespot session.
  async deviceId(force = false): Promise<string | null> {
    if (!force && this.device && this.now() - this.device.at < this.cacheMs) return this.device.id;
    const want = this.deps.deviceName().trim().toLowerCase();
    const r: any = await this.deps.client().getDevices();
    const devices: SpotifyDevice[] = Array.isArray(r?.devices) ? r.devices : [];
    const hit = devices.find((d) => String(d.name ?? '').trim().toLowerCase() === want)
      ?? devices.find((d) => String(d.name ?? '').trim().toLowerCase().startsWith(want));
    if (!hit?.id) {
      this.device = null;
      this.log(`[spotify] receiver "${this.deps.deviceName()}" not among the account's devices (${devices.map((d) => d.name).join(', ') || 'none'})`);
      return null;
    }
    this.device = { id: hit.id, at: this.now() };
    return hit.id;
  }

  // Start one track on the receiver. Resolves the device, retries once with a
  // fresh device list on "device not found", and reports the outcome rather
  // than throwing — the transport decides what a failure means.
  async play(trackId: string, positionMs?: number): Promise<{ ok: true } | { ok: false; reason: 'no-device' | 'unplayable' | 'auth' | 'error'; message: string }> {
    const attempt = async (force: boolean) => {
      const dev = await this.deviceId(force);
      if (!dev) return { ok: false as const, reason: 'no-device' as const, message: 'receiver not found' };
      await this.deps.client().play({ deviceId: dev, uris: [`spotify:track:${trackId}`], positionMs });
      return { ok: true as const };
    };
    try {
      const first = await attempt(false);
      if (first.ok || first.reason !== 'no-device') return first;
      return await attempt(true);
    } catch (err: any) {
      if (err instanceof SpotifyApiError) {
        if (err.status === 404) {
          try { return await attempt(true); } catch (e2: any) { return { ok: false, reason: 'no-device', message: e2?.message || 'device vanished' }; }
        }
        if (err.status === 401) return { ok: false, reason: 'auth', message: err.message };
        if (err.status === 403) return { ok: false, reason: 'unplayable', message: err.message };
      }
      return { ok: false, reason: 'error', message: err?.message || String(err) };
    }
  }

  async pause(): Promise<void> {
    try {
      const dev = await this.deviceId();
      await this.deps.client().pause(dev ?? undefined);
    } catch (err: any) {
      this.log(`[spotify] pause failed: ${err?.message ?? err}`);
    }
  }

  // Bring playback back to the receiver (tuify's transfer-back on reconnect).
  async transferHere(play = false): Promise<boolean> {
    try {
      const dev = await this.deviceId(true);
      if (!dev) return false;
      await this.deps.client().transfer(dev, play);
      return true;
    } catch (err: any) {
      this.log(`[spotify] transfer failed: ${err?.message ?? err}`);
      return false;
    }
  }

  // Whether the receiver is the account's ACTIVE device right now.
  async receiverActive(): Promise<boolean | null> {
    try {
      const st: any = await this.deps.client().getPlaybackState();
      if (!st) return false;
      const dev = await this.deviceId();
      return dev != null && st.device?.id === dev;
    } catch {
      return null;
    }
  }
}
