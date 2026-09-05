// settings.spotify + the spotify entry in MUSIC_SOURCES — a COLD-LOAD round trip
// (the three-edit rule: a field missing from load()'s composition saves, works,
// then vanishes on restart) plus the patch schema's strict half, and the secrets
// allowlist that lets the Connect flow persist a refresh token at all.
//
// Run: npm test -- spotify-settings

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-spotify-settings-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { spotifyPatchSchema, spotifyPlaylistIdsSchema, MUSIC_SOURCES } = await import('../src/schemas/settings.js');
const { SECRET_ENV_KEYS } = await import('../src/setup/secrets.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');
async function coldLoad(body: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(body));
  setCache(null);
  await settings.load();
  return settings.get() as any;
}

test('an absent block loads as the shipped defaults (byte-identical upgrade)', async () => {
  const s = await coldLoad({});
  assert.deepEqual(s.spotify, {
    deviceName: '', bitrate: 320,
    pool: { playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 },
    seamLeadMs: 1500, healthPollSec: 60, mismatch: 'reclaim',
  });
  assert.equal(s.music.source, 'subsonic');
});

test('every field survives a controller restart', async () => {
  const s = await coldLoad({
    music: { source: 'spotify' },
    spotify: {
      deviceName: 'SUB/WAVE booth', bitrate: 160,
      pool: { playlistIds: ['37i9dQZF1DXcBWIGoYBM5M', '37i9dQZF1DX0XUsuxWHRQd'], includeSaved: false, includeSavedAlbums: true, maxTracks: 1200 },
      seamLeadMs: 3000, healthPollSec: 120, mismatch: 'follow',
    },
  });
  assert.equal(s.music.source, 'spotify');
  assert.equal(s.spotify.deviceName, 'SUB/WAVE booth');
  assert.equal(s.spotify.bitrate, 160);
  assert.deepEqual(s.spotify.pool.playlistIds, ['37i9dQZF1DXcBWIGoYBM5M', '37i9dQZF1DX0XUsuxWHRQd']);
  assert.equal(s.spotify.pool.includeSaved, false);
  assert.equal(s.spotify.pool.includeSavedAlbums, true);
  assert.equal(s.spotify.pool.maxTracks, 1200);
  assert.equal(s.spotify.seamLeadMs, 3000);
  assert.equal(s.spotify.healthPollSec, 120);
  assert.equal(s.spotify.mismatch, 'follow');
});

test('a hand-edited block repairs rather than wedging boot', async () => {
  const s = await coldLoad({ spotify: { bitrate: 999, mismatch: 'panic', pool: { playlistIds: 'nope', maxTracks: -5 }, seamLeadMs: 'x', healthPollSec: 99999 } });
  assert.equal(s.spotify.bitrate, 320);
  assert.equal(s.spotify.mismatch, 'reclaim');
  assert.deepEqual(s.spotify.pool.playlistIds, []);
  assert.equal(s.spotify.pool.maxTracks, 100, 'clamped to the floor');
  assert.equal(s.spotify.seamLeadMs, 1500);
  assert.equal(s.spotify.healthPollSec, 600, 'clamped to the ceiling');
});

test('the patch path is strict where load() is lenient', () => {
  assert.equal(spotifyPatchSchema.safeParse({ bitrate: 999 }).success, false);
  assert.equal(spotifyPatchSchema.safeParse({ mismatch: 'panic' }).success, false);
  assert.equal(spotifyPatchSchema.safeParse({ pool: { maxTracks: 5 } }).success, false);
  const ok = spotifyPatchSchema.parse({ bitrate: '160', pool: { includeSaved: 'true', maxTracks: '250.4' }, deviceName: ' Booth ' });
  assert.equal(ok.bitrate, 160);
  assert.equal(ok.pool?.includeSaved, true);
  assert.equal(ok.pool?.maxTracks, 250);
});

test('playlist ids accept pasted links and URIs and refuse anything else, naming it', () => {
  const parsed = spotifyPlaylistIdsSchema.parse('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M, https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd?si=x\n37i9dQZF1DXcBWIGoYBM5M');
  assert.deepEqual(parsed, ['37i9dQZF1DXcBWIGoYBM5M', '37i9dQZF1DX0XUsuxWHRQd'], 'deduped, in order');
  const bad = spotifyPlaylistIdsSchema.safeParse(['not a playlist']);
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /not a Spotify playlist id or link/);
  assert.equal(spotifyPlaylistIdsSchema.safeParse(42).success, false);
});

test('update() applies the block through the shared schema, including a source switch', async () => {
  await coldLoad({});
  await settings.update({ spotify: { pool: { playlistIds: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' }, mismatch: 'follow' }, music: { source: 'spotify' } });
  const s = settings.get() as any;
  assert.deepEqual(s.spotify.pool.playlistIds, ['37i9dQZF1DXcBWIGoYBM5M']);
  assert.equal(s.spotify.mismatch, 'follow');
  assert.equal(s.spotify.bitrate, 320, 'untouched fields keep their values');
  assert.equal(s.music.source, 'spotify');
  await assert.rejects(settings.update({ spotify: { bitrate: 128 } }), /spotify\.bitrate must be one of/);
});

test('spotify is a valid music source and its three secrets are on the allowlist', () => {
  assert.ok(MUSIC_SOURCES.includes('spotify'));
  for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN']) {
    assert.ok(SECRET_ENV_KEYS.includes(k), `${k} must be persistable by saveSecrets`);
  }
});
