// SpotifyMusicSource — "what music exists" on Spotify, in the MusicSource
// contract. Catalog only: playback is the SpotifyPlaybackController's job and
// audio transport is librespot's (see docs/spotify-source.md).
//
// The Spotify catalog is unbounded, so the station's LIBRARY on Spotify is the
// operator's pool (sources/spotify/pool.ts): their playlists, optionally saved
// tracks/albums. Random, genre, browse and the tagger walk draw from the pool;
// search, lookups and artist queries go to the Web API directly.
//
// Every song list passes through blocklist.rejectBlocked — the same chokepoint
// the Subsonic client uses — so the never-play list is enforced identically.
//
// What February 2026's Web API restrictions cost this source (client.ts has the
// full list): no top-songs at all (hasTopSongs:false), search answers ten at a
// time so anything wanting more pages, and /me no longer reports the account
// tier so ping() can require Premium but not verify it.

import * as settings from '../../../settings.js';
import * as blocklist from '../../blocklist.js';
import { saveSecrets } from '../../../setup/secrets.js';
import type { MusicSource, Song, Album, Artist, CoverArt, AnalyzableRef } from '../types.js';
import { SpotifyClient, SPOTIFY_PAGE_MAX, SPOTIFY_SEARCH_MAX, type SpotifyCredentials } from './client.js';
import { SpotifyPoolCache, sample, type PoolConfig } from './pool.js';
import { mapTrack, mapAlbum, mapArtist, mapPlaylist, unwrapItem, trackIdFromUri } from './map.js';

export const SPOTIFY_SOURCE_ID = 'spotify';

const log = (line: string) => console.log(line);

// Credentials are read LAZILY from process.env: state/secrets.env is loaded
// into the environment at boot (setup/secrets.ts), after module evaluation.
export function spotifyCredentials(): SpotifyCredentials {
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || '',
  };
}

let client: SpotifyClient | null = null;
export function spotifyClient(): SpotifyClient {
  if (!client) {
    client = new SpotifyClient({
      credentials: spotifyCredentials,
      log,
      // A rotated refresh token must land in secrets.env or the next boot logs
      // in with a dead one. saveSecrets also updates process.env.
      onRefreshToken: async (token) => {
        try { await saveSecrets({ SPOTIFY_REFRESH_TOKEN: token }); }
        catch (err: any) { log(`[spotify] could not persist rotated refresh token: ${err?.message ?? err}`); }
      },
      // No onAccessToken: this app's tokens are NOT what the receiver logs in
      // with (see receiver-auth.ts) — writing them to the token file is what
      // produced INVALID_CREDENTIALS at the Connect handshake.
    });
  }
  return client;
}

export function spotifySettings(): any {
  return (settings.get() as any)?.spotify ?? {};
}

function poolConfig(): PoolConfig {
  const s = spotifySettings();
  const pool = s.pool ?? {};
  return {
    playlistIds: Array.isArray(pool.playlistIds) ? pool.playlistIds.map(String) : [],
    includeSaved: pool.includeSaved !== false,
    includeSavedAlbums: pool.includeSavedAlbums === true,
    maxTracks: Number.isFinite(Number(pool.maxTracks)) && Number(pool.maxTracks) > 0 ? Number(pool.maxTracks) : 5000,
  };
}

let pool: SpotifyPoolCache | null = null;
export function spotifyPool(): SpotifyPoolCache {
  if (!pool) pool = new SpotifyPoolCache(spotifyClient, poolConfig, log);
  return pool;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const keep = (songs: Array<Song | null>, includeBlocked = false): Song[] => {
  const list = songs.filter((s): s is Song => !!s && s.isPlayable !== false);
  return includeBlocked ? list : blocklist.rejectBlocked(list);
};

// Stamp artist genres from the pool's cache onto API-fetched tracks (search,
// lookups) when we happen to have them — no extra request either way.
function withPoolGenres(songs: Song[]): Song[] {
  const p = spotifyPool().peek();
  if (!p) return songs;
  for (const s of songs) {
    if (s.genres?.length) continue;
    const g = s.artistId ? p.artistGenres.get(s.artistId) : undefined;
    if (g?.length) { s.genres = g; s.genre = g[0]; }
  }
  return songs;
}

const normGenre = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normName = (s: unknown) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// /search caps `limit` at 10 since February 2026, but the picker asks for 25–40
// in one call. Page until the caller's count is satisfied rather than silently
// answering a tenth of what was asked for. Bounded: a search that has to walk
// more than this is a search that isn't finding anything.
const SEARCH_MAX_PAGES = 5;

async function searchPaged(q: string, type: 'track' | 'artist', want: number, offset = 0): Promise<any[]> {
  const c = spotifyClient();
  const out: any[] = [];
  const target = Math.max(1, want);
  for (let page = 0; page < SEARCH_MAX_PAGES && out.length < target; page++) {
    const r: any = await c.search(q, [type], { limit: SPOTIFY_SEARCH_MAX, offset: offset + page * SPOTIFY_SEARCH_MAX });
    const items: any[] = (type === 'track' ? r?.tracks?.items : r?.artists?.items) ?? [];
    out.push(...items);
    if (items.length < SPOTIFY_SEARCH_MAX) break; // short page — that was the last one
  }
  return out.slice(0, target);
}

function yearOk(s: Song, fromYear?: number, toYear?: number): boolean {
  if (fromYear == null && toYear == null) return true;
  if (s.year == null) return false;
  if (fromYear != null && s.year < fromYear) return false;
  if (toYear != null && s.year > toYear) return false;
  return true;
}

// ── core ────────────────────────────────────────────────────────────────────

async function ping(): Promise<{ ok: boolean; reason?: string }> {
  const c = spotifyClient();
  if (!c.hasCredentials()) {
    return { ok: false, reason: 'Spotify is not connected — add the client id/secret and press Connect in Settings → Music source' };
  }
  try {
    const me: any = await c.getMe();
    // February 2026 removed `product` (and `country`) from /me, so Premium can
    // no longer be PROBED — only required. Report what the account is, and say
    // plainly that the tier is unknown rather than asserting "· premium" off a
    // check that now always passes because the field is simply absent.
    const product = String(me?.product ?? '');
    if (product && product !== 'premium') {
      return { ok: false, reason: `Spotify account "${me?.display_name ?? me?.id}" is ${product}; Spotify Connect playback needs Premium` };
    }
    const who = me?.display_name ?? me?.id ?? 'account';
    return { ok: true, reason: product ? `${who} · ${product}` : `${who} · connected (Spotify no longer reports the account tier; Connect playback needs Premium)` };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'unreachable' };
  }
}

async function search(query: any, { songCount = 20, songOffset = 0, includeBlocked = false } = {}): Promise<Song[]> {
  const q = String(query ?? '').trim();
  if (!q) return [];
  // A pasted Spotify link/URI is a lookup, not a search.
  const direct = trackIdFromUri(q);
  if (direct) {
    const one = await getSong(direct);
    return one ? keep([one], includeBlocked) : [];
  }
  const items = await searchPaged(q, 'track', songCount, songOffset);
  return withPoolGenres(keep(items.map((t: any) => mapTrack(t)), includeBlocked));
}

async function getSong(id: any): Promise<Song | null> {
  const key = trackIdFromUri(String(id ?? '')) ?? String(id ?? '');
  const cached = spotifyPool().peek()?.tracks.get(key);
  if (cached) return cached;
  const t: any = await spotifyClient().getTrack(key);
  const song = mapTrack(t);
  return song ? withPoolGenres([song])[0] : null;
}

async function getAlbum(id: any): Promise<Song[]> {
  const c = spotifyClient();
  const a: any = await c.getAlbum(String(id));
  if (!a) return [];
  const items: any[] = [...(a.tracks?.items ?? [])];
  // Albums over 50 tracks page.
  if (a.tracks?.next) {
    for await (const t of c.paginate<any>((o) => c.getAlbumTracks(a.id, { offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX })) {
      if (!items.some((x) => x.id === t.id)) items.push(t);
    }
  }
  return withPoolGenres(keep(items.map((t) => mapTrack(t, { album: a }))));
}

async function getArtist(id: any): Promise<Artist | null> {
  const c = spotifyClient();
  const a: any = await c.getArtist(String(id));
  const artist = mapArtist(a);
  if (!artist) return null;
  let album: Album[] = [];
  try {
    const r: any = await c.getArtistAlbums(artist.id, { limit: SPOTIFY_PAGE_MAX });
    album = (r?.items ?? []).map(mapAlbum).filter(Boolean) as Album[];
  } catch { /* an artist with no readable albums is still an artist */ }
  return { ...artist, album };
}

async function searchArtists(query: any, { artistCount = 5 } = {}): Promise<Artist[]> {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const items = await searchPaged(q, 'artist', artistCount);
  return items.map(mapArtist).filter(Boolean) as Artist[];
}

async function getGenres() {
  const p = await spotifyPool().get();
  return [...p.genres.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, songCount]) => ({ value, songCount }));
}

async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}): Promise<Song[]> {
  const p = await spotifyPool().get();
  const g = genre ? normGenre(genre) : null;
  const candidates = [...p.tracks.values()].filter((s) =>
    (!g || (s.genres ?? []).some((x: string) => normGenre(x) === g)) && yearOk(s, fromYear, toYear));
  return keep(sample(candidates, size));
}

async function getSongsByGenre(genre: any, { count = 20 } = {}): Promise<Song[]> {
  const fromPool = await getRandomSongs({ size: count, genre: String(genre) });
  if (fromPool.length) return fromPool;
  // Off-pool fallback: Spotify's own genre filter, at a random page so repeat
  // calls do not return the same handful.
  try {
    const offset = Math.floor(Math.random() * 5) * SPOTIFY_SEARCH_MAX;
    const items = await searchPaged(`genre:"${String(genre)}"`, 'track', count, offset);
    return keep(sample(items.map((t: any) => mapTrack(t)), count));
  } catch {
    return [];
  }
}

async function getSongsByGenreSampled(genre: any, { count = 20 } = {}): Promise<Song[]> {
  return getSongsByGenre(genre, { count });
}

async function getAlbumList(offset = 0, size = 500): Promise<Album[]> {
  const p = await spotifyPool().get();
  return [...p.albums.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(offset, offset + size);
}

async function* iterateAllSongs(): AsyncGenerator<Song> {
  const p = await spotifyPool().get();
  for (const s of keep([...p.tracks.values()])) yield s;
}

async function getCoverArt(id: string): Promise<CoverArt | null> {
  const p = spotifyPool().peek();
  const fromPool = p?.tracks.get(id)?._imageUrl ?? p?.albums.get(id)?._imageUrl;
  if (fromPool) return { url: fromPool };
  const c = spotifyClient();
  const t: any = await c.getTrack(id);
  const song = mapTrack(t);
  if (song?._imageUrl) return { url: song._imageUrl };
  const a: any = await c.getAlbum(id).catch(() => null);
  const album = mapAlbum(a);
  return album?._imageUrl ? { url: album._imageUrl } : null;
}

// Spotify exposes no audio bytes — every analyzer-derived column stays NULL.
async function getAnalyzableRef(): Promise<AnalyzableRef | null> {
  return null;
}

async function resolveGenreName(name: any): Promise<string | null> {
  const target = normGenre(name);
  if (!target) return null;
  const genres = await getGenres();
  const exact = genres.find((g) => normGenre(g.value) === target);
  if (exact) return exact.value;
  const loose = genres.find((g) => {
    const gv = normGenre(g.value);
    return gv && (gv.includes(target) || target.includes(gv));
  });
  return loose?.value ?? null;
}

async function resolveArtist(name: any, { artistCount = 10 } = {}): Promise<Artist | null> {
  const query = normName(name);
  if (!query) return null;
  const found = await searchArtists(String(name), { artistCount });
  const exact = found.find((a) => normName(a.name) === query);
  if (exact) return exact;
  // Spotify's search already ranks fuzzily; accept the top hit only when it
  // shares a token with the query, so "Drake" cannot resolve to "Blake".
  const tokens = new Set(query.split(' ').filter((t) => t.length >= 2));
  const top = found[0];
  if (top && normName(top.name).split(' ').some((t) => tokens.has(t))) return top;
  return null;
}

async function getRecentSongsByArtist(artistName: any, { albums = 3, count = 20 } = {}): Promise<Song[]> {
  const artist = await resolveArtist(artistName);
  if (!artist?.id) return [];
  const c = spotifyClient();
  const r: any = await c.getArtistAlbums(artist.id, { limit: SPOTIFY_PAGE_MAX });
  const list = ((r?.items ?? []) as any[])
    .sort((x, y) => String(y.release_date ?? '').localeCompare(String(x.release_date ?? '')))
    .slice(0, albums);
  const songs: Song[] = [];
  for (const a of list) {
    try { songs.push(...(await getAlbum(a.id))); } catch { /* skip an unreadable album */ }
    if (songs.length >= count) break;
  }
  return songs.slice(0, count);
}

// ── optional (capabilities: starred, playlists, recently added) ─────────────
//
// No getTopSongs: February 2026 removed GET /artists/{id}/top-tracks with no
// replacement, and `popularity` went with it, so there is nothing left to rank
// by. capabilities.ts declares hasTopSongs:false for spotify rather than having
// this return [] — a picker tool offered without a backing index spends the
// model's discovery call on a guaranteed-empty answer.

async function getStarred(): Promise<Song[]> {
  const c = spotifyClient();
  const out: Song[] = [];
  for await (const item of c.paginate<any>((o) => c.getSavedTracks({ offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX, max: 100 })) {
    const t = unwrapItem(item);
    const s = t ? mapTrack(t, { addedAt: item?.added_at }) : null;
    if (s) out.push(s);
  }
  return withPoolGenres(keep(out));
}

// Memoised: the admin's shows/blocklist tabs ask /dj/playlists on every render
// and each answer used to be a fresh paginated walk — 429s within a minute on
// the first real run. Five minutes is the pool's own cadence.
let playlistsMemo: { at: number; value: any[] } | null = null;
const PLAYLISTS_MEMO_MS = 5 * 60 * 1000;
async function getPlaylists() {
  if (playlistsMemo && Date.now() - playlistsMemo.at < PLAYLISTS_MEMO_MS) return playlistsMemo.value;
  const c = spotifyClient();
  const out: any[] = [];
  for await (const p of c.paginate<any>((o) => c.getMyPlaylists({ offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX })) {
    const m = mapPlaylist(p);
    if (m) out.push(m);
  }
  playlistsMemo = { at: Date.now(), value: out };
  return out;
}

async function getPlaylist(id: any): Promise<Song[]> {
  const c = spotifyClient();
  const out: Song[] = [];
  for await (const item of c.paginate<any>((o) => c.getPlaylistItems(String(id), { offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX })) {
    const t = unwrapItem(item);
    const s = t ? mapTrack(t, { addedAt: item?.added_at }) : null;
    if (s) out.push(s);
  }
  return withPoolGenres(keep(out));
}

async function getRecentlyAddedAlbums({ size = 20 } = {}): Promise<Album[]> {
  const r: any = await spotifyClient().getSavedAlbums({ limit: Math.min(SPOTIFY_PAGE_MAX, size) });
  return ((r?.items ?? []) as any[])
    .map((it) => {
      const a = mapAlbum(it?.album);
      if (a) a.created = it?.added_at;
      return a;
    })
    .filter(Boolean) as Album[];
}

export const spotifySource: MusicSource = {
  id: SPOTIFY_SOURCE_ID,
  ping,
  search,
  getSong,
  getAlbum,
  getArtist,
  searchArtists,
  getGenres,
  getRandomSongs,
  getSongsByGenre,
  getSongsByGenreSampled,
  getAlbumList,
  iterateAllSongs,
  getCoverArt,
  getAnalyzableRef,
  resolveGenreName,
  resolveArtist,
  getRecentSongsByArtist,
  // No playback URI builders: Spotify plays through the live transport
  // (capabilities.hasLiveTransport) — the queue never asks for one.
  getStarred,
  getPlaylists,
  getPlaylist,
  getRecentlyAddedAlbums,
};
