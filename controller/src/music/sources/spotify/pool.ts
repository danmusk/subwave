// The Spotify "library": SUB/WAVE's catalog on Spotify is a POOL the operator
// curates — their playlists (settings.spotify.pool.playlistIds, or every playlist
// they own when empty) plus, optionally, their saved tracks and saved albums.
// Spotify's catalog is unbounded, so random/genre/browse/walk all need a finite
// set to draw from, and this is it.
//
// The pool is built lazily, memoised for POOL_TTL_MS, and single-flight, the
// same posture as the pool picker's 30-minute Subsonic memo. Artist genres are
// batch-fetched (50 ids per call) once per build so the walk can stamp `genres`
// without a request per track. The client is INJECTED so the build is testable
// against canned pages (scripts/spotify-source.test.ts).

import type { Song, Album } from '../types.js';
import type { SpotifyClient } from './client.js';
import { mapTrack, mapAlbum, unwrapItem } from './map.js';
import { albumEraSuspect } from '../../era-suspect.js';

export const POOL_TTL_MS = 30 * 60 * 1000;

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

  constructor(
    private readonly client: () => SpotifyClient,
    private readonly cfg: () => PoolConfig,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void { this.pool = null; }

  peek(): SpotifyPool | null { return this.pool; }

  async get(): Promise<SpotifyPool> {
    if (this.pool && this.now() - this.pool.builtAt < POOL_TTL_MS && this.pool.cfgSig === poolConfigSignature(this.cfg())) return this.pool;
    if (!this.building) {
      this.building = this.build().finally(() => { this.building = null; });
    }
    return this.building;
  }

  private async build(): Promise<SpotifyPool> {
    const c = this.client();
    const cfg = this.cfg();
    const tracks = new Map<string, Song>();
    const albums = new Map<string, Album>();
    const artistGenres = new Map<string, string[]>();
    const rawByAlbum = new Map<string, any[]>(); // for era suspicion
    let partial = false;
    const started = this.now();

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
      for await (const p of c.paginate<any>((o) => c.getMyPlaylists({ offset: o, limit: 50 }))) mine.push(p);
      const wanted = cfg.playlistIds.length ? mine.filter((p) => cfg.playlistIds.includes(p.id)) : mine;
      // Configured ids the account does not own/follow are still fetchable
      // (public playlists) — resolve them individually.
      for (const id of cfg.playlistIds) {
        if (!wanted.some((p) => p.id === id)) {
          try {
            const p = await c.getPlaylist(id);
            if (p) wanted.push(p);
          } catch (err: any) {
            partial = true;
            this.log(`[spotify] playlist ${id} unavailable: ${err?.message ?? err}`);
          }
        }
      }
      playlists = wanted.map((p) => ({ id: p.id, name: p.name ?? '', songCount: p.tracks?.total }));
      for (const p of wanted) {
        try {
          for await (const item of c.paginate<any>((o) => c.getPlaylistItems(p.id, { offset: o, limit: 100 }), { pageSize: 100 })) {
            add(item, item?.added_at ?? null);
            if (tracks.size >= cfg.maxTracks) break;
          }
        } catch (err: any) {
          partial = true;
          this.log(`[spotify] playlist "${p.name}" walk failed: ${err?.message ?? err}`);
        }
        if (tracks.size >= cfg.maxTracks) break;
      }
    } catch (err: any) {
      partial = true;
      this.log(`[spotify] playlist listing failed: ${err?.message ?? err}`);
    }

    // 2. Saved tracks.
    if (cfg.includeSaved && tracks.size < cfg.maxTracks) {
      try {
        for await (const item of c.paginate<any>((o) => c.getSavedTracks({ offset: o, limit: 50 }))) {
          add(item, item?.added_at ?? null);
          if (tracks.size >= cfg.maxTracks) break;
        }
      } catch (err: any) {
        partial = true;
        this.log(`[spotify] saved-tracks walk failed: ${err?.message ?? err}`);
      }
    }

    // 3. Saved albums (their tracks lack the album object — attach it).
    if (cfg.includeSavedAlbums && tracks.size < cfg.maxTracks) {
      try {
        for await (const item of c.paginate<any>((o) => c.getSavedAlbums({ offset: o, limit: 50 }))) {
          const album = item?.album;
          if (!album?.id) continue;
          const a = mapAlbum(album);
          if (a) { a.created = item?.added_at ?? undefined; albums.set(a.id, a); }
          for (const t of album.tracks?.items ?? []) add({ ...t, album }, item?.added_at ?? null);
          if (tracks.size >= cfg.maxTracks) break;
        }
      } catch (err: any) {
        partial = true;
        this.log(`[spotify] saved-albums walk failed: ${err?.message ?? err}`);
      }
    }

    // 4. Artist genres, batched. Spotify tags ARTISTS, so this is the only
    //    genre signal the pool has; a failed batch leaves those tracks untagged.
    const artistIds = [...new Set([...tracks.values()].map((s) => s.artistId).filter((x): x is string => !!x))];
    for (let i = 0; i < artistIds.length; i += 50) {
      try {
        const r = await c.getArtists(artistIds.slice(i, i + 50));
        for (const a of r?.artists ?? []) {
          if (a?.id) artistGenres.set(a.id, Array.isArray(a.genres) ? a.genres.map(String) : []);
        }
      } catch (err: any) {
        partial = true;
        this.log(`[spotify] artist genre batch failed: ${err?.message ?? err}`);
      }
    }
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

    this.pool = { tracks, albums, artistGenres, genres, playlists, builtAt: this.now(), partial, cfgSig: poolConfigSignature(cfg) };
    this.log(`[spotify] pool built: ${tracks.size} tracks, ${albums.size} albums, ${playlists.length} playlists, ${genres.size} genres in ${Math.round((this.now() - started) / 1000)}s${partial ? ' (partial)' : ''}`);
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
