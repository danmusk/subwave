// SpotifyMusicSource: the pure mappers, the pool build against a canned client,
// and the source's behaviour through the facade with settings.music.source =
// spotify. No network — the client is a stub returning fixture pages.
//
// Load-bearing assertions:
//   • a Spotify track maps to the Subsonic-shaped Song the walk/picker read
//     (id, artist string, album year, duration in SECONDS, coverArt = id, the
//     era flags the Navidrome walk stamps);
//   • the pool dedupes across playlists/saved, caps at maxTracks, stamps artist
//     genres from the batched artist call, and marks a compilation untrusted;
//   • the facade returns neutral empties for capabilities spotify lacks
//     (similar songs, lyrics, scrobble) and THROWS on a request-URI builder;
//   • the picker tool set drops the server-only tools spotify cannot serve.
//
// Run: npm test -- spotify-source

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-spotify-source-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { mapTrack, mapAlbum, mapArtist, unwrapItem, pickImage, releaseYear, trackIdFromUri } = await import('../src/music/sources/spotify/map.js');
const { SpotifyPoolCache, sample } = await import('../src/music/sources/spotify/pool.js');
const facade = await import('../src/music/source.js');
const { capabilitiesFor } = await import('../src/music/sources/capabilities.js');
const { buildPickerContext } = await import('../src/llm/internal/tools/picker/scope.js');
const { PICKER_TOOLS } = await import('../src/llm/internal/tools/picker/index.js');
const { pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');

// ── fixtures ───────────────────────────────────────────────────────────────

const img = (w: number) => ({ url: `https://i.scdn.co/${w}`, width: w, height: w });
const artist = (id: string, name: string) => ({ id, name, type: 'artist' });
const album = (id: string, name: string, extra: any = {}) => ({
  id, name, album_type: 'album', release_date: '1994-03-08', release_date_precision: 'day',
  images: [img(640), img(300), img(64)], artists: [artist('ar1', 'Portishead')], total_tracks: 11, ...extra,
});
const track = (id: string, name: string, extra: any = {}) => ({
  id, name, uri: `spotify:track:${id}`, duration_ms: 245_400, explicit: false, popularity: 61,
  track_number: 3, disc_number: 1, artists: [artist('ar1', 'Portishead')], album: album('al1', 'Dummy'),
  external_urls: { spotify: `https://open.spotify.com/track/${id}` }, ...extra,
});

test('mapTrack → the Subsonic-shaped Song every consumer reads', () => {
  const s = mapTrack(track('1a2b3c4d5e6f7g8h9i0j1k', 'Glory Box'))!;
  assert.equal(s.id, '1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(s.title, 'Glory Box');
  assert.equal(s.artist, 'Portishead');
  assert.equal(s.artistId, 'ar1');
  assert.equal(s.album, 'Dummy');
  assert.equal(s.albumId, 'al1');
  assert.equal(s.year, 1994, 'album release year');
  assert.equal(s.duration, 245, 'SECONDS, rounded — Subsonic parity');
  assert.equal(s.coverArt, s.id, '/cover/:id resolves through the source by track id');
  assert.equal(s.spotifyUri, 'spotify:track:1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(s.albumIsCompilation, false);
  assert.equal(s.albumOriginalYear, null, 'Spotify has no original-release date');
  assert.equal(s._imageUrl, 'https://i.scdn.co/640', 'smallest image ≥ 512 wide');
  assert.deepEqual(s.genres, [], 'no artist cache → no genres, never undefined');
});

test('mapTrack joins multiple artists and flags compilations two ways', () => {
  const multi = mapTrack(track('t2', 'Duet', { artists: [artist('a', 'A'), artist('b', 'B')] }))!;
  assert.equal(multi.artist, 'A, B');
  assert.deepEqual(multi.artists, ['A', 'B']);
  const comp = mapTrack(track('t3', 'X', { album: album('c1', 'Now 42', { album_type: 'compilation' }) }))!;
  assert.equal(comp.albumIsCompilation, true);
  const va = mapTrack(track('t4', 'Y', { album: album('c2', 'Sampler', { artists: [artist('va', 'Various Artists')] }) }))!;
  assert.equal(va.albumIsCompilation, true, 'a Various Artists album artist is the compilation marker');
  assert.equal(va.albumArtist, 'Various Artists');
});

test('mapTrack stamps genres from the artist cache and honours the album extra', () => {
  const genres = new Map([['ar1', ['trip hop', 'downtempo']]]);
  const s = mapTrack({ ...track('t5', 'Roads'), album: undefined }, { album: album('al1', 'Dummy'), artistGenres: genres })!;
  assert.deepEqual(s.genres, ['trip hop', 'downtempo']);
  assert.equal(s.genre, 'trip hop');
  assert.equal(s.album, 'Dummy');
});

test('mappers refuse junk and unwrapItem drops locals, episodes and removed tracks', () => {
  assert.equal(mapTrack(null), null);
  assert.equal(mapTrack({ name: 'no id' }), null);
  assert.equal(mapAlbum({}), null);
  assert.equal(mapArtist(undefined), null);
  assert.equal(unwrapItem({ track: null }), null);
  assert.equal(unwrapItem({ track: { id: 'x', is_local: true } }), null);
  assert.equal(unwrapItem({ track: { id: 'x', type: 'episode' } }), null);
  assert.equal(unwrapItem({ track: { id: 'x', type: 'track' } })?.id, 'x');
  assert.equal(releaseYear('1994'), 1994);
  assert.equal(releaseYear('0000'), undefined);
  assert.equal(pickImage([img(64), img(300)], 512), 'https://i.scdn.co/300', 'largest when none reaches the size');
  assert.equal(trackIdFromUri('spotify:track:1a2b3c4d5e6f7g8h9i0j1k'), '1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(trackIdFromUri('https://open.spotify.com/track/1a2b3c4d5e6f7g8h9i0j1k?si=abc'), '1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(trackIdFromUri('not an id'), null);
});

test('sample is a permutation prefix', () => {
  const out = sample([1, 2, 3, 4, 5], 3, () => 0.5);
  assert.equal(out.length, 3);
  assert.equal(new Set(out).size, 3);
  assert.deepEqual([...sample([1, 2], 9)].sort((a, b) => a - b), [1, 2], 'size is capped at the input length');
});

// ── the pool ───────────────────────────────────────────────────────────────

function fakeClient(opts: { failSaved?: boolean } = {}) {
  const calls: string[] = [];
  const t1 = track('AAAAAAAAAAAAAAAAAAAAAA', 'Glory Box');
  const t2 = track('BBBBBBBBBBBBBBBBBBBBBB', 'Roads');
  const comp = track('CCCCCCCCCCCCCCCCCCCCCC', 'Hit', { artists: [artist('ar2', 'Someone')], album: album('cmp', 'Now 42', { album_type: 'compilation', artists: [artist('va', 'Various Artists')] }) });
  const client: any = {
    async getMyPlaylists() { calls.push('playlists'); return { items: [{ id: 'PL1', name: 'Night', tracks: { total: 2 } }], next: null }; },
    async getPlaylist(id: string) { calls.push(`playlist:${id}`); return { id, name: `ext ${id}`, tracks: { total: 1 } }; },
    async getPlaylistItems(id: string) {
      calls.push(`items:${id}`);
      return id === 'PL1'
        ? { items: [{ track: t1, added_at: '2024-01-01T00:00:00Z' }, { track: t2, added_at: '2024-01-02T00:00:00Z' }, { track: null }], next: null }
        : { items: [{ track: comp }], next: null };
    },
    async getSavedTracks() {
      calls.push('saved');
      if (opts.failSaved) throw new Error('saved down');
      return { items: [{ track: t1, added_at: '2023-01-01T00:00:00Z' }, { track: comp }], next: null }; // t1 is a dup
    },
    async getSavedAlbums() { calls.push('saved-albums'); return { items: [], next: null }; },
    async getArtists(ids: string[]) {
      calls.push(`artists:${ids.join('+')}`);
      return { artists: ids.map((id) => ({ id, genres: id === 'ar1' ? ['trip hop'] : ['pop'] })) };
    },
    async *paginate<T>(page: (o: number) => Promise<any>) { const p = await page(0); for (const it of p.items ?? []) yield it as T; },
  };
  return { client, calls };
}

test('the pool dedupes, caps, stamps genres and marks compilations untrusted', async () => {
  const { client, calls } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: ['PL1', 'EXT1'], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }));
  const p = await pool.get();
  assert.equal(p.tracks.size, 3, 'two playlist tracks + one saved, the duplicate collapsed');
  assert.equal(p.playlists.length, 2, 'the owned playlist and the configured external one');
  assert.ok(calls.includes('playlist:EXT1'), 'an unowned configured playlist is fetched by id');
  assert.deepEqual(p.tracks.get('AAAAAAAAAAAAAAAAAAAAAA')!.genres, ['trip hop']);
  assert.equal(p.genres.get('trip hop'), 2);
  const c = p.tracks.get('CCCCCCCCCCCCCCCCCCCCCC')!;
  assert.equal(c.albumIsCompilation, true);
  assert.equal(c.albumEraUntrusted, true, 'the era pipeline reads this exactly as it does for Navidrome');
  assert.equal(calls.filter((x) => x.startsWith('artists:')).length, 1, 'genres batched in one call');
  assert.equal(p.partial, false);
  // memoised
  await pool.get();
  assert.equal(calls.filter((x) => x === 'playlists').length, 1);
});

test('a failed source page leaves the pool usable and marked partial; a cap stops the walk', async () => {
  const { client } = fakeClient({ failSaved: true });
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }));
  const p = await pool.get();
  assert.equal(p.partial, true);
  assert.equal(p.tracks.size, 2);

  const capped = new SpotifyPoolCache(() => fakeClient().client, () => ({ playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 1 }));
  assert.equal((await capped.get()).tracks.size, 1);
});

test('a pool-definition change rebuilds on the next get() without an explicit invalidate', async () => {
  const { client, calls } = fakeClient();
  let ids = ['PL1'];
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: ids, includeSaved: false, includeSavedAlbums: false, maxTracks: 5000 }));
  await pool.get();
  ids = ['PL1', 'EXT1'];
  const p = await pool.get();
  assert.equal(p.playlists.length, 2);
  assert.equal(calls.filter((x) => x === 'playlists').length, 2);
});

// ── through the facade ─────────────────────────────────────────────────────

test('with music.source = spotify the facade routes to the Spotify source and degrades honestly', async () => {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ music: { source: 'spotify' } }));
  setCache(null);
  await settings.load();
  assert.equal(facade.activeSourceId(), 'spotify');
  const caps = capabilitiesFor('spotify');
  assert.equal(caps.hasLiveTransport, true);
  assert.equal(caps.hasAudio, false);
  // Neutral empties for what Spotify lacks — no request is attempted.
  assert.deepEqual(await facade.getSimilarSongs('x'), []);
  assert.equal(await facade.getLyrics('x'), '');
  assert.equal(await facade.supportsSonicSimilarity(), false);
  assert.equal(await facade.scrobble('x', { submission: true }), undefined);
  assert.equal(await facade.getAnalyzableRef('x'), null, 'no audio bytes → analyzer skips cleanly');
  // A request-URI builder must THROW, never hand Liquidsoap a URI that plays nothing.
  assert.throws(() => facade.getAnnotatedUri({ id: 'x', title: 't', artist: 'a', album: 'b' }), /live transport/);
  assert.equal(facade.getLocalPath({ id: 'x' }), null);
  // Without credentials ping says so, in the operator's words.
  const p = await facade.ping();
  assert.equal(p.ok, false);
  assert.match(p.reason ?? '', /not connected/);
  // The picker never offers the server-only tools.
  const ctx = buildPickerContext(pickerScope());
  const names = PICKER_TOOLS.filter((m) => !m.available || m.available(ctx)).map((m) => m.name);
  for (const n of ['similarSongs']) assert.ok(!names.includes(n), `${n} off on spotify`);
  for (const n of ['starredSongs', 'topSongsByArtist', 'recentlyAdded', 'searchLibrary', 'randomSongs']) assert.ok(names.includes(n), `${n} on for spotify`);
  // and back to the default
  writeFileSync(path.join(stateRoot, 'settings.json'), '{}');
  setCache(null);
  await settings.load();
  assert.equal(facade.activeSourceId(), 'subsonic');
});
