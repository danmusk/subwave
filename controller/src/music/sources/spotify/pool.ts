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
// Artist genres used to come from the batch endpoint, 50 ids per call.
// February 2026 removed GET /artists?ids=, so they are fetched one at a time —
// which is why the genre cache lives on the CACHE rather than inside a build
// and survives invalidate(). A 5000-track pool holds low thousands of distinct
// artists; re-asking for all of them every 30 minutes would be a rate-limit
// incident, and artist genres do not change. Only genuinely new artists cost a
// request, at bounded concurrency, and a miss is remembered as a miss.

import type { Song, Album } from '../types.js';
import type { SpotifyClient } from './client.js';
import { mapTrack, mapAlbum, unwrapItem } from './map.js';
import { albumEraSuspect } from '../../era-suspect.js';

export const POOL_TTL_MS = 30 * 60 * 1000;

// A build that produced NOTHING is not worth half an hour of silence: the
// transport's fallback reads an empty pool as "nothing to play" and the dead-air
// guard covers the air until the memo lapses. Retry soon instead.
export const POOL_EMPTY_RETRY_MS = 2 * 60 * 1000;

// Spotify's page cap. Asking for more is not clamped politely — the server
// trims the page and `paginate` reads a short page as the last one.
const PAGE = 50;

// Concurrent GET /artists/{id} calls during a genre fill.
const ARTIST_FETCH_CONCURRENCY = 4;

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
  // OUTSIDE the pool object: it survives invalidate() and every rebuild, which
  // is what makes one-request-per-artist affordable.
  private readonly genreCache = new Map<string, string[] | null>();

  constructor(
    private readonly client: () => SpotifyClient,
    private readonly cfg: () => PoolConfig,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
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
    if (!this.building) {
      this.building = this.build().finally(() => { this.building = null; });
    }
    return this.building;
  }

  // Fill `genreCache` for every id it does not already hold, at bounded
  // concurrency. Returns true when every fetch succeeded.
  private async fetchArtistGenres(ids: string[]): Promise<boolean> {
    const missing = ids.filter((id) => !this.genreCache.has(id));
    if (!missing.length) return true;
    const c = this.client();
    let ok = true;
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const id = missing[cursor++];
        try {
          const a: any = await c.getArtist(id);
          this.genreCache.set(id, Array.isArray(a?.genres) ? a.genres.map(String) : null);
        } catch (err: any) {
          ok = false;
          this.log(`[spotify] artist ${id} genres failed: ${err?.message ?? err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ARTIST_FETCH_CONCURRENCY, missing.length) }, worker));
    return ok;
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
    //    the pool has; a failed fetch leaves those tracks untagged. One request
    //    per artist since the batch endpoint was removed — see the cache note
    //    at the top of this file for why that is affordable.
    const artistIds = [...new Set([...tracks.values()].map((s) => s.artistId).filter((x): x is string => !!x))];
    if (!(await this.fetchArtistGenres(artistIds))) fail('some artist genres could not be read — those tracks stay untagged');
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

    this.pool = { tracks, albums, artistGenres, genres, playlists, builtAt: this.now(), partial, notes, cfgSig: poolConfigSignature(cfg) };
    const retry = this.ttlFor(this.pool) === POOL_EMPTY_RETRY_MS ? `, retrying in ${Math.round(POOL_EMPTY_RETRY_MS / 1000)}s` : '';
    this.log(`[spotify] pool built: ${tracks.size} tracks, ${albums.size} albums, ${playlists.length} playlists, ${genres.size} genres in ${Math.round((this.now() - started) / 1000)}s${partial ? ' (partial)' : ''}${retry}`);
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
