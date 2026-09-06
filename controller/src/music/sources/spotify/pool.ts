// The Spotify "library": SUB/WAVE's catalog on Spotify is a POOL the operator
// curates — their playlists (settings.spotify.pool.playlistIds, or every playlist
// they own when empty) plus, optionally, their saved tracks and saved albums.
// Spotify's catalog is unbounded, so random/genre/browse/walk all need a finite
// set to draw from, and this is it.
//
// The pool is built lazily, memoised for POOL_TTL_MS, and single-flight, the
// same posture as the pool picker's 30-minute Subsonic memo. The client is
// INJECTED so the build is testable against canned pages
// (scripts/spotify-source.test.ts).
//
// ARTIST GENRES ARE THE EXPENSIVE PART, and the reason this file has a budget.
// Spotify tags ARTISTS, never tracks, and February 2026 removed the batch read
// (GET /artists?ids=), so genres now cost ONE REQUEST PER ARTIST — low thousands
// on a 5000-track pool. Asking for all of them in one build is a rate-limit
// incident, and this station cannot buy its way out of the limit: extended quota
// is organisations-only (≥250k MAU), so Development Mode's rolling 30-second
// window is permanent. Spotify's own advice for rate limits is "use the batch
// APIs" — the very thing that was taken away. So the answer has to be FEWER
// REQUESTS, and three rules deliver it:
//
//   1. the cache is PERSISTED (state/spotify/artist-genres.json). In memory
//      alone it was a promise the code could not keep: every restart re-asked
//      for every artist. Artist genres do not change, so on disk this is a
//      one-time cost for the life of the station.
//   2. each build fills at most ARTIST_GENRE_BUDGET NEW artists, hardest-working
//      first (most pool tracks), so a build is never a burst and the budget buys
//      the most coverage per request. A warm pool spends nothing here.
//   3. the fill is BACKGROUND work: it stands down the instant the client's
//      shared rate-limit gate closes, and an unfilled genre is `genresPending`,
//      NOT `partial` — an enrichment that has not finished is not a broken pool,
//      and conflating the two would drive the empty-pool retry and the doctor.
//
// A miss is remembered as a miss so it is not re-queried every pass.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Song, Album } from '../types.js';
import type { SpotifyClient } from './client.js';
import { mapTrack, mapAlbum, unwrapItem } from './map.js';
import { albumEraSuspect } from '../../era-suspect.js';
import { mapPool } from '../../../util/async-pool.js';
import { writeFileAtomic } from '../../../util/atomic-file.js';
import { SPOTIFY_STATE_DIR } from './token-file.js';

export const POOL_TTL_MS = 30 * 60 * 1000;

// A build that produced NOTHING is not worth half an hour of silence: the
// transport's fallback reads an empty pool as "nothing to play" and the dead-air
// guard covers the air until the memo lapses. Retry soon instead.
export const POOL_EMPTY_RETRY_MS = 2 * 60 * 1000;

// Spotify's page cap. Asking for more is not clamped politely — the server
// trims the page and `paginate` reads a short page as the last one.
const PAGE = 50;

// NEW artists a single build may look up. Cached ones are free, so this bounds
// the burst, not the coverage: the rest fill on later builds and the disk cache
// makes that progress permanent.
export const ARTIST_GENRE_BUDGET = 100;
// Concurrent GET /artists/{id} calls during a genre fill. Low on purpose — the
// client also spaces background starts, so width here buys very little and
// costs a deeper hole when the limit does bite.
const ARTIST_FETCH_CONCURRENCY = 2;

// Where the persisted genre cache lives. Not a credential, so no 0600 — and
// deliberately NOT in routes/backup.ts's INCLUDE_FILES: it is a cache, and it
// should rebuild rather than restore.
export const ARTIST_GENRE_CACHE_PATH = path.join(SPOTIFY_STATE_DIR, 'artist-genres.json');

export interface PoolConfig {
  playlistIds: string[];
  includeSaved: boolean;
  includeSavedAlbums: boolean;
  // Hard cap on tracks per build — a runaway playlist set must not turn every
  // rebuild into thousands of requests.
  maxTracks: number;
}

export interface SpotifyPool {
  tracks: Map<string, Song>;
  albums: Map<string, Album>;
  // artist id → genres
  artistGenres: Map<string, string[]>;
  // genre → track count
  genres: Map<string, number>;
  playlists: Array<{ id: string; name: string; songCount?: number }>;
  builtAt: number;
  partial: boolean; // true when a source page failed — the pool is still usable
  // Why it is partial, in operator words. `partial` alone sent the admin UI to
  // the container logs to find out what broke, which is where an afternoon of
  // 403s went unread; these ride out on /settings/spotify instead.
  notes: string[];
  // Artists in the pool whose genres are not looked up yet. Enrichment still to
  // do — NOT a fault, and deliberately not folded into `partial`, which drives
  // the empty-pool retry and the doctor.
  genresPending: number;
  // The walk stopped at `maxTracks` rather than at the end of the operator's
  // playlists, so this pool is a PREFIX of the library, not the library. Unlike
  // `partial` this is not a failure and nothing should retry over it — but it
  // does mean the walk can never be read as "everything that exists", which is
  // what the orphan reconcile needs (music/prune-policy.ts).
  truncated: boolean;
  // The pool definition it was built from; a settings edit changes it and the
  // next get() rebuilds rather than serving a stale curation.
  cfgSig: string;
}

export function poolConfigSignature(cfg: PoolConfig): string {
  return JSON.stringify([[...cfg.playlistIds].sort(), cfg.includeSaved, cfg.includeSavedAlbums, cfg.maxTracks]);
}

export class SpotifyPoolCache {
  private pool: SpotifyPool | null = null;
  private building: Promise<SpotifyPool> | null = null;
  // artist id → genres, or null for "asked, Spotify had nothing". Deliberately
  // OUTSIDE the pool object: it survives invalidate() and every rebuild, and it
  // is mirrored to disk, which together are what make one-request-per-artist
  // affordable at all.
  private readonly genreCache = new Map<string, string[] | null>();
  private genreCacheLoaded = false;
  private genreCacheDirty = false;

  constructor(
    private readonly client: () => SpotifyClient,
    private readonly cfg: () => PoolConfig,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
    // Injected so the tests can drive the persisted cache without a state dir.
    private readonly cachePath: string = ARTIST_GENRE_CACHE_PATH,
  ) {}

  invalidate(): void { this.pool = null; }

  peek(): SpotifyPool | null { return this.pool; }

  // How long the current pool may be served. A build that came back empty AND
  // partial is a failure, not a curation — hold it briefly so the next tick can
  // try again, rather than for the full TTL.
  private ttlFor(p: SpotifyPool): number {
    return p.tracks.size === 0 && p.partial ? POOL_EMPTY_RETRY_MS : POOL_TTL_MS;
  }

  async get(): Promise<SpotifyPool> {
    if (this.pool && this.now() - this.pool.builtAt < this.ttlFor(this.pool) && this.pool.cfgSig === poolConfigSignature(this.cfg())) return this.pool;
    // Never rebuild into a closed rate-limit gate. The short empty-pool retry
    // exists so a transient failure costs one track instead of half an hour —
    // but if the emptiness IS the rate limit, retrying every two minutes is
    // just the same storm on a timer. Serve what we have and wait it out.
    if (this.pool && this.client().rateLimitedForMs() > 0) return this.pool;
    if (!this.building) {
      this.building = this.build().finally(() => { this.building = null; });
    }
    return this.building;
  }

  // ── persisted genre cache ──────────────────────────────────────────────────
  //
  // Load-once, repair rows, never block boot: a missing file is the normal first
  // run and a corrupt one starts empty rather than wedging the station
  // (music/blocklist.ts's load() is the pattern).
  private async loadGenreCache(): Promise<void> {
    if (this.genreCacheLoaded) return;
    this.genreCacheLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.cachePath, 'utf8'));
      let kept = 0;
      for (const [id, genres] of Object.entries(raw ?? {})) {
        if (typeof id !== 'string' || !id) continue;
        if (genres === null) { this.genreCache.set(id, null); kept++; continue; }
        if (Array.isArray(genres)) { this.genreCache.set(id, genres.map(String)); kept++; }
      }
      if (kept) this.log(`[spotify] artist genre cache: ${kept} artists loaded from disk`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') this.log(`[spotify] artist genre cache unreadable, starting empty: ${err?.message ?? err}`);
    }
  }

  private async saveGenreCache(): Promise<void> {
    if (!this.genreCacheDirty) return;
    this.genreCacheDirty = false;
    try {
      mkdirSync(path.dirname(this.cachePath), { recursive: true });
      await writeFileAtomic(this.cachePath, JSON.stringify(Object.fromEntries(this.genreCache)));
    } catch (err: any) {
      // A cache that cannot be written is slower, not broken.
      this.log(`[spotify] artist genre cache could not be saved: ${err?.message ?? err}`);
    }
  }

  // Fill `genreCache` for every id it does not already hold, at bounded
  // concurrency. Returns true when every fetch succeeded.
  // Look up genres for at most ARTIST_GENRE_BUDGET artists this build, busiest
  // first. `ranked` is every artist in the pool ordered by track count, so the
  // budget always buys the most genre coverage per request — an artist with one
  // track can wait for a later build.
  //
  // Returns how many artists still have no entry afterwards, which is the
  // pool's `genresPending`. Note what this does NOT do: it never reports a
  // failure as a broken pool, and it stops the moment the client's shared gate
  // closes rather than grinding the remaining queue into a live rate limit.
  private async fetchArtistGenres(ranked: string[]): Promise<number> {
    await this.loadGenreCache();
    const missing = ranked.filter((id) => !this.genreCache.has(id));
    if (!missing.length) return 0;

    const c = this.client();
    const batch = missing.slice(0, ARTIST_GENRE_BUDGET);
    let done = 0;
    let limited = false;

    await mapPool(batch, ARTIST_FETCH_CONCURRENCY, async (id) => {
      // One worker hitting the limit ends the pass for all of them; the client
      // would refuse these anyway, and asking is how a limit renews itself.
      if (limited || c.rateLimitedForMs() > 0) { limited = true; return; }
      try {
        const a: any = await c.getArtist(id, { background: true });
        this.genreCache.set(id, Array.isArray(a?.genres) ? a.genres.map(String) : null);
        this.genreCacheDirty = true;
        done++;
      } catch (err: any) {
        // A 429 is transient and must NOT be cached as a miss, or the artist is
        // written off permanently over a moment. Anything else already resolved
        // to null via allow404, so this is a genuine failure: leave it unset and
        // let a later build retry it.
        if (err?.status === 429) limited = true;
      }
    });

    await this.saveGenreCache();
    const pending = ranked.filter((id) => !this.genreCache.has(id)).length;
    if (done || pending) {
      const held = c.rateLimitedForMs();
      const why = limited && held > 0 ? `, paused ${Math.ceil(held / 1000)}s by Spotify's rate limit` : '';
      this.log(`[spotify] artist genres: +${done} this build, ${pending} still pending${why}`);
    }
    return pending;
  }

  private async build(): Promise<SpotifyPool> {
    const c = this.client();
    const cfg = this.cfg();
    const tracks = new Map<string, Song>();
    const albums = new Map<string, Album>();
    const artistGenres = new Map<string, string[]>();
    const rawByAlbum = new Map<string, any[]>(); // for era suspicion
    const started = this.now();

    // One chokepoint for "this build lost something": marks the pool partial,
    // logs it, and keeps the reason for the admin UI. Capped so a pool of a
    // thousand unreachable artists cannot grow an unbounded status payload.
    let partial = false;
    const notes: string[] = [];
    const fail = (note: string) => {
      partial = true;
      this.log(`[spotify] ${note}`);
      if (notes.length < 10 && !notes.includes(note)) notes.push(note);
    };

    const add = (raw: any, addedAt?: string | null) => {
      const t = unwrapItem(raw);
      if (!t || tracks.size >= cfg.maxTracks) return;
      const song = mapTrack(t, { addedAt });
      if (!song) return;
      tracks.set(song.id, song);
      if (t.album?.id) {
        if (!albums.has(t.album.id)) {
          const a = mapAlbum(t.album);
          if (a) albums.set(a.id, a);
        }
        const list = rawByAlbum.get(t.album.id) ?? [];
        list.push(t);
        rawByAlbum.set(t.album.id, list);
      }
    };

    // 1. Playlists — the configured ids, or everything the account owns/follows.
    let playlists: SpotifyPool['playlists'] = [];
    try {
      const mine: any[] = [];
      for await (const p of c.paginate<any>((o) => c.getMyPlaylists({ offset: o, limit: PAGE }), { pageSize: PAGE })) mine.push(p);
      const wanted = cfg.playlistIds.length ? mine.filter((p) => cfg.playlistIds.includes(p.id)) : mine;
      // Configured ids the account does not own/follow still RESOLVE, so the
      // name and cover render — but since February 2026 only a playlist the
      // connected account owns or collaborates on returns its contents. Someone
      // else's playlist answers metadata and an empty page, no error, which is
      // why the walk below reports a zero-item playlist explicitly.
      for (const id of cfg.playlistIds) {
        if (!wanted.some((p) => p.id === id)) {
          try {
            const p = await c.getPlaylist(id);
            if (p) wanted.push(p);
            else fail(`playlist ${id} not found`);
          } catch (err: any) {
            fail(`playlist ${id} unavailable: ${err?.message ?? err}`);
          }
        }
      }
      playlists = wanted.map((p) => ({ id: p.id, name: p.name ?? '', songCount: p.items?.total ?? p.tracks?.total }));
      for (const p of wanted) {
        // Count what the WALK yielded, not how much the pool grew: `add`
        // de-duplicates, so a playlist whose every track is already in the pool
        // would otherwise read as unreadable.
        let seen = 0;
        const claimed = p.items?.total ?? p.tracks?.total;
        try {
          for await (const item of c.paginate<any>((o) => c.getPlaylistItems(p.id, { offset: o, limit: PAGE }), { pageSize: PAGE })) {
            seen++;
            add(item, item?.added_at ?? null);
            if (tracks.size >= cfg.maxTracks) break;
          }
          if (seen === 0 && claimed !== 0) {
            fail(`playlist "${p.name}" returned no items — since February 2026 Spotify serves playlist contents only for playlists this account owns or collaborates on`);
          }
        } catch (err: any) {
          fail(`playlist "${p.name}" walk failed: ${err?.message ?? err}`);
        }
        if (tracks.size >= cfg.maxTracks) break;
      }
    } catch (err: any) {
      fail(`playlist listing failed: ${err?.message ?? err}`);
    }

    // 2. Saved tracks.
    if (cfg.includeSaved && tracks.size < cfg.maxTracks) {
      try {
        for await (const item of c.paginate<any>((o) => c.getSavedTracks({ offset: o, limit: PAGE }), { pageSize: PAGE })) {
          add(item, item?.added_at ?? null);
          if (tracks.size >= cfg.maxTracks) break;
        }
      } catch (err: any) {
        fail(`saved-tracks walk failed: ${err?.message ?? err}`);
      }
    }

    // 3. Saved albums (their tracks lack the album object — attach it).
    if (cfg.includeSavedAlbums && tracks.size < cfg.maxTracks) {
      try {
        for await (const item of c.paginate<any>((o) => c.getSavedAlbums({ offset: o, limit: PAGE }), { pageSize: PAGE })) {
          const album = item?.album;
          if (!album?.id) continue;
          const a = mapAlbum(album);
          if (a) { a.created = item?.added_at ?? undefined; albums.set(a.id, a); }
          for (const t of album.tracks?.items ?? []) add({ ...t, album }, item?.added_at ?? null);
          if (tracks.size >= cfg.maxTracks) break;
        }
      } catch (err: any) {
        fail(`saved-albums walk failed: ${err?.message ?? err}`);
      }
    }

    // 4. Artist genres. Spotify tags ARTISTS, so this is the only genre signal
    //    the pool has, and since the batch endpoint was removed each one costs a
    //    request — so the fill is budgeted and ranked rather than exhaustive.
    //    Rank by how many pool tracks the artist has: coverage per request is
    //    the whole game when the budget is 100 and the queue is thousands.
    const trackCount = new Map<string, number>();
    for (const s of tracks.values()) {
      if (s.artistId) trackCount.set(s.artistId, (trackCount.get(s.artistId) ?? 0) + 1);
    }
    const artistIds = [...trackCount.keys()].sort((a, b) => (trackCount.get(b) ?? 0) - (trackCount.get(a) ?? 0));
    // Deliberately NOT `fail()`: unfilled genres are enrichment still to do, not
    // a broken pool. Calling it partial would drive the empty-pool retry and
    // turn a cosmetic gap into a rebuild loop against a live rate limit.
    const genresPending = await this.fetchArtistGenres(artistIds);
    for (const id of artistIds) artistGenres.set(id, this.genreCache.get(id) ?? []);
    const genres = new Map<string, number>();
    for (const s of tracks.values()) {
      const g = s.artistId ? artistGenres.get(s.artistId) ?? [] : [];
      s.genres = g;
      s.genre = g[0];
      for (const name of g) genres.set(name, (genres.get(name) ?? 0) + 1);
    }

    // 5. Era suspicion per album, from the tracks the pool actually holds —
    //    the same call the Navidrome walk makes, on the same facts.
    for (const [albumId, raws] of rawByAlbum) {
      const album = albums.get(albumId);
      const first = raws[0]?.album ?? {};
      const suspicion = albumEraSuspect({
        isCompilation: first.album_type === 'compilation' ? true : null,
        albumArtist: album?.artist ?? null,
        title: album?.name ?? null,
        year: album?.year ?? null,
        trackArtists: raws.map((t) => (Array.isArray(t.artists) ? t.artists.map((a: any) => a?.name).filter(Boolean).join(', ') : '')),
      });
      for (const t of raws) {
        const s = tracks.get(t.id);
        if (!s) continue;
        s.albumIsCompilation = s.albumIsCompilation || suspicion.suspect && suspicion.reason === 'compilation-flag';
        s.albumEraUntrusted = suspicion.suspect;
        s.albumEraReason = suspicion.reason;
      }
    }

    this.pool = {
      tracks, albums, artistGenres, genres, playlists, builtAt: this.now(),
      partial, notes, genresPending,
      truncated: tracks.size >= cfg.maxTracks,
      cfgSig: poolConfigSignature(cfg),
    };
    const retry = this.ttlFor(this.pool) === POOL_EMPTY_RETRY_MS ? `, retrying in ${Math.round(POOL_EMPTY_RETRY_MS / 1000)}s` : '';
    const pending = genresPending ? `, ${genresPending} artists awaiting genres` : '';
    this.log(`[spotify] pool built: ${tracks.size} tracks, ${albums.size} albums, ${playlists.length} playlists, ${genres.size} genres in ${Math.round((this.now() - started) / 1000)}s${partial ? ' (partial)' : ''}${pending}${retry}`);
    return this.pool;
  }
}

// Fisher–Yates over a copy; `size` capped at the input length.
export function sample<T>(list: T[], size: number, rand: () => number = Math.random): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, Math.min(size, a.length)));
}
