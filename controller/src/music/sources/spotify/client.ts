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
//
// RATE LIMITING IS SHARED STATE, and that is the load-bearing part. Spotify
// meters a rolling 30-second window, and this station is stuck in Development
// Mode for good (extended quota is organisations-only, ≥250k MAU), so the
// window is not something we can buy our way out of — see docs/spotify-source.md.
// A 429 therefore sets ONE gate that every other caller reads, instead of each
// caller discovering the limit by spending a request against it. The measured
// failure: the per-artist genre fill hit a long `Retry-After`, every worker
// independently retried, and the old code — which only waited when Retry-After
// fitted inside its cap and otherwise fell straight through to the throw —
// spun through ~2000 remaining artists as fast as it could, turning a rate
// limit into a rate-limit storm. Never restore per-request-only 429 handling.
//
// THREE LANES, and the rule they encode is: the gate slows down what the
// station can afford to lose, and NEVER what keeps it on air.
//   • CRITICAL (`critical: true`) — the Spotify Connect player calls. Bypasses
//     the gate entirely: attempted however long the window, never spaced.
//   • FOREGROUND (default) — catalogue reads, walking the pool. Waits out a
//     short window, gives up on a long one, and is never spaced.
//   • BACKGROUND (`background: true`) — droppable enrichment. Spaced by a
//     global promise chain, and while the gate is closed it does not send a
//     request AT ALL. That is what turns 2000 doomed calls into zero.
//
// CRITICAL exists because the first version of this gate did not have it, and a
// 1800s window meant THIRTY MINUTES OF GUARANTEED SILENCE: play() resolves the
// device before every command, getDevices() was foreground, so every play died
// before reaching the network. Making the player calls obey the gate looks like
// a consistency fix and is the opposite of one. The transport already owns
// exactly the backoff the gate was trying to provide — a 3s hard floor between
// commands plus a 30s→10min exponential hold (transport.ts) — and a play is ONE
// request per track, perhaps seven across a whole window. Denying it protects
// nothing measurable and only stops the station recovering early when Spotify's
// Retry-After was conservative.
//
// Background is deliberately NOT put on the same queue as foreground: a line of
// spaced enrichment requests sitting in front of a play command is exactly the
// priority inversion this split exists to prevent.
//
// THIS CLIENT TARGETS THE POST-FEBRUARY-2026 WEB API. Spotify removed a large
// slice of the surface for Development Mode apps (enforced on existing apps
// 2026-03-09); a removed route answers 403 with no useful body, which reads as
// a permissions problem and is not one. What that costs us, so nobody
// "restores" one of them:
//   • GET /playlists/{id}/tracks → /playlists/{id}/items, and the row's `track`
//     key is now `item` (map.ts:unwrapItem absorbs both). Page size max 50.
//   • the batch reads (GET /tracks?ids, /albums?ids, /artists?ids) are gone —
//     fetch by id, one at a time.
//   • GET /artists/{id}/top-tracks is gone with NO replacement, which is why
//     spotify declares hasTopSongs:false.
//   • /search caps `limit` at 10 (was 50) — callers wanting more must page.
//   • /me no longer reports `product` or `country`, so Premium is unprobeable.
//   • `available_markets` and GET /markets are gone and nothing can derive a
//     market any more, so the legacy `market=from_token` is not sent at all.
//     The user token's own country applies server-side.
// Extended-quota apps are exempt from all of it, but that needs Spotify's
// commercial approval and is not something a station can count on.

export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';

// Spotify's own caps, named because both this module and its callers page
// against them. Passing more than the cap is not clamped politely: the server
// trims the page, and `paginate` reads a short page as the last one.
export const SPOTIFY_PAGE_MAX = 50;
export const SPOTIFY_SEARCH_MAX = 10;

// Scopes the station needs. `streaming` is for librespot's login (the Connect
// receiver), the player scopes for commanding it, the rest for the catalog.
// `user-read-private` no longer buys `product` on /me (February 2026 removed
// the field) but stays in the list: dropping it would force every connected
// operator through the consent screen again for nothing.
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
  // Longest a FOREGROUND call will sit waiting for the rate-limit gate before
  // giving up (ms). Bounded so a transition never stalls behind Spotify's
  // limiter — the transport's own backoff is the better place to lose time.
  // Background calls never wait at all.
  maxRetryAfterMs?: number;
  // Minimum gap between BACKGROUND request starts (ms). The politeness floor
  // that keeps a wide enrichment pool from becoming a burst.
  backgroundGapMs?: number;
  // Injected sleep, so the tests do not spend real seconds proving the waits.
  sleep?: (ms: number) => Promise<void>;
}

export class SpotifyApiError extends Error {
  // How long Spotify said to wait, when it said so. Carried on the error so a
  // caller can report the window instead of guessing from a log line.
  public retryAfterMs?: number;
  constructor(public readonly status: number, message: string, public readonly endpoint: string) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

// Thrown when the shared gate is closed and the caller was not willing to wait
// it out. Distinct from a 429 that came back from Spotify: NO request was sent,
// which is the whole point — a rate-limited station must stop asking.
export class SpotifyRateLimitError extends SpotifyApiError {
  constructor(endpoint: string, retryAfterMs: number) {
    super(429, `${endpoint} skipped — Spotify rate limit, ${Math.ceil(retryAfterMs / 1000)}s left`, endpoint);
    this.name = 'SpotifyRateLimitError';
    this.retryAfterMs = retryAfterMs;
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

// A page size Spotify will actually honour. Asking beyond the cap is worse than
// it looks: the server trims the page and `paginate` reads a short page as the
// last one, so an over-asked walk silently stops after its first page.
export function clampPage(n: unknown, max = SPOTIFY_PAGE_MAX): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : max;
}

// Default politeness floor between background request starts. 150ms ≈ 6/s ≈ 200
// per rolling 30s window, comfortably under a Development Mode app's budget
// while still filling a few thousand artists over a handful of pool builds.
export const DEFAULT_BACKGROUND_GAP_MS = 150;

// Spotify sends `Retry-After` in SECONDS. A 429 without one is still a 429, so
// assume a window rather than treating it as "retry immediately" — guessing low
// here is what keeps a limit alive.
const FALLBACK_RETRY_AFTER_MS = 5_000;
// Never trust a pathological header into a multi-hour hold; the gate is advisory
// and the next build can ask again.
const MAX_GATE_MS = 30 * 60_000;

export interface RequestOpts {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  // 404 on player endpoints means "no active device" — callers often want
  // null rather than a throw for that.
  allow404?: boolean;
  // Droppable enrichment rather than something the station needs to keep
  // playing. Spaced by the global gap, and abandoned outright — without
  // reaching the network — while the rate-limit gate is closed.
  background?: boolean;
  // The opposite end: a call the station cannot stay on air without. Skips the
  // gate entirely — see the three-lane note at the top of this file.
  critical?: boolean;
}

export class SpotifyClient {
  private token: TokenState | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxRetryAfterMs: number;
  private readonly backgroundGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  // The shared gate: ms-epoch until which Spotify has told us to stop asking.
  private limitedUntil = 0;
  // The window we have already logged, so a flood of callers hitting one limit
  // produces ONE line instead of one per request.
  private limitLogged = 0;
  // Serialises background request STARTS, spacing them by backgroundGapMs.
  // Foreground deliberately bypasses this queue (see the header note).
  private bgGate: Promise<void> = Promise.resolve();
  private bgLastStart = 0;

  constructor(private readonly deps: SpotifyClientDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.maxRetryAfterMs = deps.maxRetryAfterMs ?? 10_000;
    this.backgroundGapMs = deps.backgroundGapMs ?? DEFAULT_BACKGROUND_GAP_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── rate-limit gate ────────────────────────────────────────────────────────

  // How long Spotify has told us to wait, 0 when clear. Callers use this to
  // stand down (the genre fill) and the admin/doctor to say so out loud.
  rateLimitedForMs(): number {
    return Math.max(0, this.limitedUntil - this.now());
  }

  // Record a 429. Only ever EXTENDS the window — a later, shorter header must
  // not shorten a hold another response already earned.
  private noteRateLimited(retryAfterMs: number, endpoint: string): number {
    const until = this.now() + Math.min(retryAfterMs, MAX_GATE_MS);
    if (until > this.limitedUntil) this.limitedUntil = until;
    const left = this.rateLimitedForMs();
    if (this.limitedUntil > this.limitLogged) {
      this.limitLogged = this.limitedUntil;
      this.log(`[spotify] rate limited on ${endpoint} — holding every request for ${Math.ceil(left / 1000)}s`);
    }
    return left;
  }

  // Spotify's Retry-After is in SECONDS. A present-and-numeric header is taken
  // at face value including 0, which means "you may retry now" — inventing a
  // window there would hold the station off for no reason. Only a missing or
  // unparseable header falls back, and it falls back to a real wait: a 429 is
  // still a 429, and guessing low is how a limit stays alive.
  private retryAfterFrom(res: { headers: { get(k: string): string | null } }): number {
    const raw = res.headers.get('retry-after');
    const n = Number(raw);
    return raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? n * 1000 : FALLBACK_RETRY_AFTER_MS;
  }

  // Space background starts on one chain, so a wide pool stays polite.
  private throttleBackground<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.bgGate.then(async () => {
      const wait = this.bgLastStart + this.backgroundGapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.bgLastStart = this.now();
      return fn();
    });
    // Keep the chain alive past failures — a rejected link would poison every
    // queued caller behind it (music/musicbrainz.ts learned this first).
    this.bgGate = run.then(() => undefined, () => undefined);
    return run;
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

  // Drop the cached access token so the next call refreshes. Needed whenever the
  // refresh token changes underneath us (a reconnect that added scopes, a pasted
  // token, a disconnect): an access token lives an hour and carries the scopes
  // it was minted with, so without this a reconnect looked like it had not
  // happened until the old token expired.
  resetToken(): void {
    this.token = null;
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
    return opts.background
      ? this.throttleBackground(() => this.send<T>(url, endpoint, opts))
      : this.send<T>(url, endpoint, opts);
  }

  private async send<T>(url: URL, endpoint: string, opts: RequestOpts): Promise<T | null> {
    // The gate, consulted BEFORE the network. A caller that asks anyway is how
    // a rate limit renews itself — except for the one lane that must ask.
    const held = opts.critical ? 0 : this.rateLimitedForMs();
    if (held > 0) {
      // Background work is droppable by definition: stand down, cost nothing.
      if (opts.background) throw new SpotifyRateLimitError(endpoint, held);
      // Foreground waits out a SHORT window — a track boundary can afford a few
      // seconds — and gives up on a long one so the caller's own backoff takes
      // over rather than the seam hanging.
      if (held > this.maxRetryAfterMs) throw new SpotifyRateLimitError(endpoint, held);
      // Jitter, so a fleet released by one header does not stampede back in
      // sync (llm/internal/core/retry.ts keeps it for the same reason).
      await this.sleep(held + Math.floor(Math.random() * 200));
    }

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
      // Publish the window to every other caller FIRST — that is what stops the
      // storm — then decide whether this one call can afford to wait it out.
      const left = this.noteRateLimited(this.retryAfterFrom(res), endpoint);
      // `left <= max` includes 0 — a Retry-After of 0 is a licence to retry at
      // once, not a reason to skip the retry.
      if (!opts.background && left <= this.maxRetryAfterMs) {
        await this.sleep(left + Math.floor(Math.random() * 200));
        res = await attempt(await this.accessToken());
        if (res.status === 429) this.noteRateLimited(this.retryAfterFrom(res), endpoint);
      }
    }
    if (res.status === 204) return null;
    if (res.status === 404 && opts.allow404) return null;
    if (!res.ok) {
      // Read the body ONCE, as text, then try to shape it. A removed endpoint
      // answers 403 with no `error.message` at all — falling straight through
      // to `statusText` printed a bare "Forbidden" that named nothing and cost
      // an afternoon, so the raw prefix goes in the line too.
      const raw = await res.text().catch(() => '');
      let j: any = {};
      try { j = raw ? JSON.parse(raw) : {}; } catch { /* not JSON — the prefix is all we get */ }
      const msg = j?.error?.message || j?.error_description || j?.error || res.statusText || `HTTP ${res.status}`;
      const body = raw.trim().slice(0, 300);
      const detail = body && !String(msg).includes(body) ? ` · body: ${redactSpotify(body)}` : '';
      // A 429 has already been logged ONCE by noteRateLimited, for the window
      // rather than the request. Logging it again here is precisely the flood.
      if (res.status !== 429) this.log(`[spotify] ${endpoint} → ${res.status} ${redactSpotify(String(msg))}${detail}`);
      const err = new SpotifyApiError(res.status, `${endpoint} failed (${res.status}): ${msg}`, endpoint);
      if (res.status === 429) err.retryAfterMs = this.rateLimitedForMs();
      throw err;
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  // ── catalog ────────────────────────────────────────────────────────────────

  // `limit` caps at SPOTIFY_SEARCH_MAX (10) since February 2026 — a caller
  // wanting 25 pages through `offset`, it does not ask for 25.
  search(q: string, types: Array<'track' | 'artist' | 'album' | 'playlist'>, opts: { limit?: number; offset?: number } = {}) {
    return this.api('/search', { query: { q, type: types.join(','), limit: clampPage(opts.limit, SPOTIFY_SEARCH_MAX), offset: opts.offset ?? 0 } });
  }
  getTrack(id: string) { return this.api(`/tracks/${encodeURIComponent(id)}`, { allow404: true }); }
  // `background` marks the pool's genre fill: droppable, spaced, and abandoned
  // without a request while the rate-limit gate is closed. The batch read this
  // replaced is gone, so this is the highest-volume call the station makes.
  getArtist(id: string, opts: { background?: boolean } = {}) {
    return this.api(`/artists/${encodeURIComponent(id)}`, { allow404: true, background: opts.background });
  }
  getArtistAlbums(id: string, opts: { limit?: number; offset?: number; includeGroups?: string } = {}) {
    return this.api(`/artists/${encodeURIComponent(id)}/albums`, { query: { limit: clampPage(opts.limit ?? 20), offset: opts.offset ?? 0, include_groups: opts.includeGroups ?? 'album,single' } });
  }
  getAlbum(id: string) { return this.api(`/albums/${encodeURIComponent(id)}`, { allow404: true }); }
  getAlbumTracks(id: string, opts: { limit?: number; offset?: number } = {}) {
    return this.api(`/albums/${encodeURIComponent(id)}/tracks`, { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } });
  }
  getMyPlaylists(opts: { limit?: number; offset?: number } = {}) { return this.api('/me/playlists', { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } }); }
  getPlaylist(id: string) { return this.api(`/playlists/${encodeURIComponent(id)}`, { query: { fields: 'id,name,description,owner(display_name),items(total),images' }, allow404: true }); }
  // /items, not /tracks: the old route was removed and now 403s. Contents come
  // back only for playlists the connected account owns or collaborates on —
  // anything else answers metadata with an empty page, not an error.
  getPlaylistItems(id: string, opts: { limit?: number; offset?: number } = {}) {
    return this.api(`/playlists/${encodeURIComponent(id)}/items`, { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0, additional_types: 'track' } });
  }
  getSavedTracks(opts: { limit?: number; offset?: number } = {}) { return this.api('/me/tracks', { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } }); }
  getSavedAlbums(opts: { limit?: number; offset?: number } = {}) { return this.api('/me/albums', { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } }); }
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
  //
  // EVERY call here is `critical`, and that is the whole block's defining
  // property: these are what keep the station on air, so they skip the
  // rate-limit gate rather than being denied by it. Low volume by construction
  // (one command per track, behind the transport's 3s floor and exponential
  // hold), so they cost the quota almost nothing — while blocking them costs the
  // whole window in dead air. Do not "tidy" the flag away.

  getDevices() { return this.api('/me/player/devices', { critical: true }); }
  getPlaybackState() { return this.api('/me/player', { query: { additional_types: 'track' }, allow404: true, critical: true }); }
  play(opts: { deviceId?: string; uris?: string[]; contextUri?: string; positionMs?: number } = {}) {
    const body: Record<string, unknown> = {};
    if (opts.uris) body.uris = opts.uris;
    if (opts.contextUri) body.context_uri = opts.contextUri;
    if (opts.positionMs != null) body.position_ms = opts.positionMs;
    return this.api('/me/player/play', { method: 'PUT', query: { device_id: opts.deviceId }, body: Object.keys(body).length ? body : undefined, critical: true });
  }
  pause(deviceId?: string) { return this.api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId }, allow404: true, critical: true }); }
  queue(uri: string, deviceId?: string) { return this.api('/me/player/queue', { method: 'POST', query: { uri, device_id: deviceId }, critical: true }); }
  transfer(deviceId: string, play = false) { return this.api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play }, critical: true }); }
  seek(positionMs: number, deviceId?: string) { return this.api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId }, critical: true }); }
}
