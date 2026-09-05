// SpotifyTransport end to end against injected fakes: the queue hands over a
// pick → at the seam the transport commands it → librespot's track_changed
// arrives → the mixer is told (which is where now-playing.json comes from).
// Plus the failure paths the spec lists: mismatch under both policies, an
// unavailable track, a track that never starts, a device that is missing, an
// empty seam with a pool fallback, and the gap gate's ordering.
//
// Run: npm test -- spotify-transport

import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyTransport, type TransportDeps } from '../src/music/sources/spotify/transport.js';
import type { SpotifyPlayerEvent } from '../src/broadcast/spotify-player-pure.js';

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const ID_X = 'XXXXXXXXXXXXXXXXXXXXXX';

function harness(over: Partial<TransportDeps> & { mismatch?: 'reclaim' | 'follow'; playResult?: any } = {}) {
  let now = 1_700_000_000_000;
  const calls: string[] = [];
  const logs: string[] = [];
  let marker: SpotifyPlayerEvent | null = null;
  const deps: TransportDeps = {
    play: async (id) => { calls.push(`play:${id}`); return over.playResult ?? { ok: true }; },
    transferHere: async () => { calls.push('transfer'); return true; },
    mixerTrack: async (m) => { calls.push(`mixer:${m.subsonic_id}:${m.title}`); return { lagSec: 2 }; },
    mixerGap: async (on) => { calls.push(`gap:${on}`); return true; },
    readPlayerEvent: () => marker,
    readAudioState: () => null,
    songById: async (id) => ({ id, title: `song ${id.slice(0, 1)}`, artist: 'X', album: 'Y' }),
    fallbackSong: async () => ({ id: ID_X, title: 'pool track', artist: 'P', album: 'Q' }),
    onUnplayable: (item, reason) => { calls.push(`unplayable:${item.track.id}:${reason}`); },
    log: (kind, line) => { logs.push(`${kind}: ${line}`); },
    seamLeadMs: () => 1500,
    mismatchPolicy: () => over.mismatch ?? 'reclaim',
    now: () => now,
    startTimeoutMs: 12_000,
    idleMs: 15_000,
    ...over,
  };
  const t = new SpotifyTransport(deps);
  const emit = (event: string, o: Partial<SpotifyPlayerEvent> = {}) => { marker = { event, trackId: null, positionMs: null, durationMs: null, at: now, ...o }; };
  const advance = (ms: number) => { now += ms; };
  const item = (id: string, title: string) => ({ track: { id, title, artist: 'Portishead', album: 'Dummy', duration: 200 } } as any);
  return { t, calls, logs, emit, advance, item, deps };
}

test('happy path: handoff → seam → play → track_changed → mixer told; gap off/on around the seam', async () => {
  const h = harness();
  // Track A is playing (a previous cycle). Start with its track_changed.
  h.emit('track_changed', { trackId: ID_A, durationMs: 200_000 });
  await h.t.tick();
  assert.deepEqual(h.calls.filter((c) => c.startsWith('mixer')), ['mixer:AAAAAAAAAAAAAAAAAAAAAA:song A'], 'an uncommanded start is adopted (nothing pending yet)');
  h.calls.length = 0;

  // The queue hands over B mid-track: nothing happens until the seam.
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.advance(100_000);
  await h.t.tick();
  assert.deepEqual(h.calls, [], 'held: 100s left');

  // 1.4s before the end: command B.
  h.advance(98_600);
  await h.t.tick();
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
  assert.equal(h.t.status().awaitingStart !== null, true);

  // A ends (gap on), then B starts (gap off, mixer told with the ITEM's metadata).
  h.emit('end_of_track', { trackId: ID_A }); h.advance(500); await h.t.tick();
  h.emit('track_changed', { trackId: ID_B, durationMs: 180_000 }); h.advance(700); await h.t.tick();
  assert.deepEqual(h.calls.slice(1), ['gap:true', 'gap:false', `mixer:${ID_B}:Roads`]);
  assert.equal(h.t.status().pending, null, 'the item left the transport');
  assert.equal((h.t.status().current as any).id, ID_B);
  assert.ok(h.logs.some((l) => /"Roads" started on the receiver/.test(l)));
});

test('no pick by the seam → a pool track plays and is published as a fallback', async () => {
  const h = harness();
  h.emit('track_changed', { trackId: ID_A, durationMs: 10_000 }); await h.t.tick();
  h.advance(9_000); await h.t.tick();
  assert.ok(h.calls.includes(`play:${ID_X}`), 'fallback commanded');
  h.emit('track_changed', { trackId: ID_X, durationMs: 100_000 }); h.advance(1000); await h.t.tick();
  assert.ok(h.calls.includes(`mixer:${ID_X}:pool track`));
  assert.ok(h.logs.some((l) => /pool fallback, nothing was picked/.test(l)));
});

test('mismatch under reclaim: one reclaim (transfer + play) then adopt', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));   // nothing playing → commands B at once
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
  h.emit('track_changed', { trackId: ID_X, durationMs: 100_000 }); h.advance(500); await h.t.tick();
  assert.deepEqual(h.calls.slice(1), ['transfer', `play:${ID_B}`], 'reclaimed once');
  h.emit('track_changed', { trackId: ID_X, durationMs: 100_000, at: h.deps.now!() + 1 }); h.advance(500); await h.t.tick();
  assert.ok(h.calls.includes(`mixer:${ID_X}:song X`), 'second mismatch → adopted and published');
  assert.ok(h.logs.some((l) => /following "song X"/.test(l)));
});

test('mismatch under follow adopts immediately and publishes the real track', async () => {
  const h = harness({ mismatch: 'follow' });
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.emit('track_changed', { trackId: ID_X, durationMs: 100_000 }); h.advance(500); await h.t.tick();
  // No gap toggle: the gate was never on, so there is nothing to clear.
  assert.deepEqual(h.calls, [`play:${ID_B}`, `mixer:${ID_X}:song X`]);
});

test('an unavailable track is dropped through the queue hook and the next thing plays', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.emit('unavailable', { trackId: ID_B }); h.advance(300); await h.t.tick();
  assert.ok(h.calls.includes(`unplayable:${ID_B}:unavailable`));
  assert.ok(h.calls.includes(`play:${ID_X}`), 'fell through to the pool');
});

test('a play that the API refuses as unplayable drops the item; a missing device keeps it pending', async () => {
  const h1 = harness({ playResult: { ok: false, reason: 'unplayable', message: 'restricted' } });
  await h1.t.handoff(h1.item(ID_B, 'Roads'));
  assert.ok(h1.calls.includes(`unplayable:${ID_B}:restricted`));
  assert.equal(h1.t.status().pending, null);

  const h2 = harness({ playResult: { ok: false, reason: 'no-device', message: 'receiver not found' } });
  await h2.t.handoff(h2.item(ID_B, 'Roads'));
  assert.equal((h2.t.status().pending as any).id, ID_B, 'kept — the receiver may come back');
  assert.ok(h2.logs.some((l) => /no-device/.test(l)));
});

test('a commanded track that never starts is retried once, then dropped', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
  h.advance(13_000); await h.t.tick();
  assert.deepEqual(h.calls, [`play:${ID_B}`, `play:${ID_B}`], 'retried');
  h.advance(13_000); await h.t.tick();
  assert.ok(h.calls.includes(`unplayable:${ID_B}:never started`));
});

test('operator skip commands the pending pick now', async () => {
  const h = harness();
  h.emit('track_changed', { trackId: ID_A, durationMs: 200_000 }); await h.t.tick();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.calls.length = 0;
  assert.equal(await h.t.skip(), true);
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
});

test('a receiver reconnect mid-track takes the receiver back and restarts the track', async () => {
  const h = harness();
  h.emit('track_changed', { trackId: ID_A, durationMs: 200_000 }); await h.t.tick();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.calls.length = 0;
  // A marker is new only when its clock moved (the reader dedups on `at`).
  h.advance(500); h.emit('session_connected'); await h.t.tick();
  assert.deepEqual(h.calls, ['transfer', `play:${ID_B}`]);
});
