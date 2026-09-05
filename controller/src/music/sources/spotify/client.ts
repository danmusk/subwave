// Spotify Web API client — the ONLY module that speaks HTTP to Spotify.
//
// Two responsibilities, kept deliberately narrow: (1) OAuth — refresh the
// access token from a stored refresh token, exchange an authorization code once,
// build the authorize URL; (2) a thin `api()` over the REST surface the catalog
// source and the playback controller need. Nothing here knows about songs,
// queues or the mixer; it returns Spotify's own JSON shapes.
//
// `fetch` and the clock are INJECTED so every path is unit-testable without a
// Spotify account (scripts/spotify-client.test.ts). Credentials come from a
// getter (env / state/secrets.env) and are never logged: every log line carries
// the endpoint and the status, never a header or a body.
//
// Retry posture is deliberately mild, per CLAUDE.md's "don't add aggressive
// retry": one token refresh on 401, one bounded wait on 429, nothing else. A
// failure surfaces as SpotifyApiError and the caller decides.

export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';

// Scopes the station needs. `streaming` is for librespot's login (the Connect
// receiver), the player scopes for commanding it, the rest for the catalog.
// `user-read-private` is what makes /me report `product` — without it Spotify
// silently omits the field and the Premium check can only answer "unknown".
export const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
] as const;

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface SpotifyClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  credentials: () => SpotifyCredentials;
  // Spotify MAY rotate the refresh token on refresh; the caller persists it.
  onRefreshToken?: (token: string) => void | Promise<void>;
  // Fresh access tokens are also handed out so librespot's first login can use
  // one (state/spotify/token) — see docker/spotify/librespot-run.sh.
  onAccessToken?: (token: string, expiresAt: number) => void | Promise<void>;
  log?: (line: string) => void;
  // Max wait honoured on a 429 before giving up (ms). Bounded so a transition
  // never stalls behind Spotify's rate limiter.
  maxRetryAfterMs?: number;
}

export class SpotifyApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly endpoint: string) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

export class SpotifyAuthError extends SpotifyApiError {
  constructor(status: number, message: string) {
    super(status, message, 'token');
    this.name = 'SpotifyAuthError';
  }
}

interface TokenState {
  accessToken: string;
  expiresAt: number; // ms epoch
}

// Strip anything that looks like a bearer/refresh token from free text before
// it reaches a log line. Spotify tokens are long base62/urlsafe strings.
export function redactSpotify(text: string): string {
  return String(text ?? '')
    .replace(/(access_token|refresh_token|Authorization|Bearer|code)(["'=:\s]+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9_-]{100,}/g, '[redacted]');
}

export interface RequestOpts {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  // 404 on player endpoints means "no active device" — callers often want
  // null rather than a throw for that.
  allow404?: boolean;
}

export class SpotifyClient {
  private token: TokenState | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxRetryAfterMs: number;

  constructor(private readonly deps: SpotifyClientDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.maxRetryAfterMs = deps.maxRetryAfterMs ?? 5000;
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────

  static authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; scopes?: readonly string[] }): string {
    const u = new URL(`${SPOTIFY_ACCOUNTS}/authorize`);
    u.searchParams.set('client_id', opts.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', opts.redirectUri);
    u.searchParams.set('scope', (opts.scopes ?? SPOTIFY_SCOPES).join(' '));
    u.searchParams.set('state', opts.state);
    // Force the consent screen so a re-connect can add scopes.
    u.searchParams.set('show_dialog', 'true');
    return u.toString();
  }

  // One-time: authorization code → { refreshToken, accessToken, expiresIn }.
  static async exchangeCode(
    opts: { clientId: string; clientSecret: string; code: string; redirectUri: string },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
    const res = await fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token || !j.refresh_token) {
      throw new SpotifyAuthError(res.status, `code exchange failed: ${j.error_description || j.error || res.status}`);
    }
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: Number(j.expires_in) || 3600, scope: String(j.scope || '') };
  }

  hasCredentials(): boolean {
    const c = this.deps.credentials();
    return Boolean(c.clientId && c.clientSecret && c.refreshToken);
  }

  // A valid access token, refreshing when absent or within 60s of expiry.
  // Concurrent callers share one in-flight refresh.
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - this.now() > 60_000) return this.token.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const c = this.deps.credentials();
    if (!c.clientId || !c.clientSecret || !c.refreshToken) {
      throw new SpotifyAuthError(0, 'Spotify is not connected — SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN are required');
    }
    const res = await this.fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      this.log(`[spotify] token refresh failed: ${res.status} ${redactSpotify(String(j.error_description || j.error || ''))}`);
      throw new SpotifyAuthError(res.status, `token refresh failed (${res.status}): ${j.error_description || j.error || 'no access_token'}`);
    }
    const expiresAt = this.now() + (Number(j.expires_in) || 3600) * 1000;
    this.token = { accessToken: j.access_token, expiresAt };
    if (j.refresh_token && j.refresh_token !== c.refreshToken) await this.deps.onRefreshToken?.(j.refresh_token);
    await this.deps.onAccessToken?.(j.access_token, expiresAt);
    this.log(`[spotify] token refreshed (expires in ${Math.round((expiresAt - this.now()) / 1000)}s)`);
    return j.access_token;
  }

  // ── REST ───────────────────────────────────────────────────────────────────

  async api<T = any>(path: string, opts: RequestOpts = {}): Promise<T | null> {
    const url = new URL(path.startsWith('http') ? path : `${SPOTIFY_API}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const endpoint = `${opts.method ?? 'GET'} ${url.pathname}`;
    const attempt = async (token: string) => this.fetchImpl(url.toString(), {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    let res = await attempt(await this.accessToken());
    if (res.status === 401) {
      // Exactly one refresh-and-retry: a second 401 is a real auth problem.
      res = await attempt(await this.accessToken(true));
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after') || '1') * 1000;
      if (after <= this.maxRetryAfterMs) {
        this.log(`[spotify] 429 on ${endpoint} — waiting ${after}ms once`);
        await new Promise((r) => setTimeout(r, after));
        res = await attempt(await this.accessToken());
      }
    }
    if (res.status === 204) return null;
    if (res.status === 404 && opts.allow404) return null;
    if (!res.ok) {
      const j: any = await res.json().catch(() => ({}));
      const msg = j?.error?.message || j?.error_description || j?.error || res.statusText || `HTTP ${res.status}`;
      this.log(`[spotify] ${endpoint} → ${res.status} ${redactSpotify(String(msg))}`);
      throw new SpotifyApiError(res.status, `${endpoint} failed (${res.status}): ${msg}`, endpoint);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  // ── catalog ────────────────────────────────────────────────────────────────

  search(q: string, types: Array<'track' | 'artist' | 'album' | 'playlist'>, opts: { limit?: number; offset?: number; market?: string } = {}) {
    return this.api('/search', { query: { q, type: types.join(','), limit: opts.limit ?? 20, offset: opts.offset ?? 0, market: opts.market ?? 'from_token' } });
  }
  getTrack(id: string, market = 'from_token') { return this.api(`/tracks/${encodeURIComponent(id)}`, { query: { market }, allow404: true }); }
  getTracks(ids: string[], market = 'from_token') { return this.api('/tracks', { query: { ids: ids.slice(0, 50).join(','), market } }); }
  getArtist(id: string) { return this.api(`/artists/${encodeURIComponent(id)}`, { allow404: true }); }
  getArtists(ids: string[]) { return this.api('/artists', { query: { ids: ids.slice(0, 50).join(',') } }); }
  getArtistTopTracks(id: string, market = 'from_token') { return this.api(`/artists/${encodeURIComponent(id)}/top-tracks`, { query: { market } }); }
  getArtistAlbums(id: string, opts: { limit?: number; offset?: number; includeGroups?: string; market?: string } = {}) {
    return this.api(`/artists/${encodeURIComponent(id)}/albums`, { query: { limit: opts.limit ?? 20, offset: opts.offset ?? 0, include_groups: opts.includeGroups ?? 'album,single', market: opts.market ?? 'from_token' } });
  }
  getAlbum(id: string, market = 'from_token') { return this.api(`/albums/${encodeURIComponent(id)}`, { query: { market }, allow404: true }); }
  getAlbumTracks(id: string, opts: { limit?: number; offset?: number; market?: string } = {}) {
    return this.api(`/albums/${encodeURIComponent(id)}/tracks`, { query: { limit: opts.limit ?? 50, offset: opts.offset ?? 0, market: opts.market ?? 'from_token' } });
  }
  getMyPlaylists(opts: { limit?: number; offset?: number } = {}) { return this.api('/me/playlists', { query: { limit: opts.limit ?? 50, offset: opts.offset ?? 0 } }); }
  getPlaylist(id: string) { return this.api(`/playlists/${encodeURIComponent(id)}`, { query: { fields: 'id,name,description,owner(display_name),tracks(total),images' }, allow404: true }); }
  getPlaylistItems(id: string, opts: { limit?: number; offset?: number; market?: string } = {}) {
    return this.api(`/playlists/${encodeURIComponent(id)}/tracks`, { query: { limit: opts.limit ?? 100, offset: opts.offset ?? 0, market: opts.market ?? 'from_token', additional_types: 'track' } });
  }
  getSavedTracks(opts: { limit?: number; offset?: number; market?: string } = {}) { return this.api('/me/tracks', { query: { limit: opts.limit ?? 50, offset: opts.offset ?? 0, market: opts.market ?? 'from_token' } }); }
  getSavedAlbums(opts: { limit?: number; offset?: number; market?: string } = {}) { return this.api('/me/albums', { query: { limit: opts.limit ?? 50, offset: opts.offset ?? 0, market: opts.market ?? 'from_token' } }); }
  getMe() { return this.api('/me'); }

  // Walk a paginated endpoint: `page(offset)` returns Spotify's paging object.
  async *paginate<T>(page: (offset: number) => Promise<any>, opts: { pageSize?: number; max?: number } = {}): AsyncGenerator<T> {
    const size = opts.pageSize ?? 50;
    let offset = 0;
    let seen = 0;
    while (true) {
      const p = await page(offset);
      const items: T[] = Array.isArray(p?.items) ? p.items : [];
      for (const it of items) {
        yield it;
        if (opts.max && ++seen >= opts.max) return;
      }
      if (!p?.next || items.length === 0 || items.length < size) return;
      offset += items.length;
    }
  }

  // ── player (Spotify Connect) ───────────────────────────────────────────────

  getDevices() { return this.api('/me/player/devices'); }
  getPlaybackState() { return this.api('/me/player', { query: { additional_types: 'track' }, allow404: true }); }
  play(opts: { deviceId?: string; uris?: string[]; contextUri?: string; positionMs?: number } = {}) {
    const body: Record<string, unknown> = {};
    if (opts.uris) body.uris = opts.uris;
    if (opts.contextUri) body.context_uri = opts.contextUri;
    if (opts.positionMs != null) body.position_ms = opts.positionMs;
    return this.api('/me/player/play', { method: 'PUT', query: { device_id: opts.deviceId }, body: Object.keys(body).length ? body : undefined });
  }
  pause(deviceId?: string) { return this.api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId }, allow404: true }); }
  queue(uri: string, deviceId?: string) { return this.api('/me/player/queue', { method: 'POST', query: { uri, device_id: deviceId } }); }
  transfer(deviceId: string, play = false) { return this.api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } }); }
  seek(positionMs: number, deviceId?: string) { return this.api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId } }); }
}
