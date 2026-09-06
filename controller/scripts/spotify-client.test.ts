// The Spotify Web API client (music/sources/spotify/client.ts) against an
// injected fetch — no account, no network. What is pinned:
//   • token refresh happens lazily, once, and is shared by concurrent callers;
//   • a 401 triggers exactly ONE refresh-and-retry, a second 401 surfaces;
//   • a 429 is honoured once when Retry-After is within the cap, never beyond;
//   • a rotated refresh token and every fresh access token reach their sinks;
//   • no token ever appears in a log line;
//   • 204 / allow404 return null, other errors throw SpotifyApiError with the
//     endpoint and status;
//   • the POST-FEBRUARY-2026 endpoint surface at the wire — playlist contents
//     come from /items not /tracks, page sizes never exceed Spotify's caps,
//     search never asks for more than ten, and no call still sends the legacy
//     market=from_token. Each of those was a silent failure mode: /tracks 403s,
//     an over-asked page is trimmed and `paginate` reads the short page as the
//     last one, and from_token has nothing left to resolve against.
//
// Run: npm test -- spotify-client

import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyClient, SpotifyApiError, SpotifyAuthError, redactSpotify, SPOTIFY_SCOPES } from '../src/music/sources/spotify/client.js';

type Step = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(script: Step[]) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch: ${url}`);
    // A raw string body goes out verbatim — that is how a removed endpoint
    // answers (an HTML error page, not JSON), and the client must survive it.
    const text = step.body === undefined ? '' : typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      statusText: `S${step.status}`,
      headers: { get: (k: string) => step.headers?.[k.toLowerCase()] ?? null },
      json: async () => (text ? JSON.parse(text) : {}),
      text: async () => text,
    } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const creds = () => ({ clientId: 'id', clientSecret: 'secret', refreshToken: 'REFRESH_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789' });
const tokenOk = (tok = 'ACCESS_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789'): Step => ({ status: 200, body: { access_token: tok, expires_in: 3600 } });

test('refreshes lazily, once, and shares the in-flight refresh across callers', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 200, body: { id: 'me' } }, { status: 200, body: { id: 'me' } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, now: () => 1_000_000 });
  const [a, b] = await Promise.all([c.getMe(), c.getMe()]);
  assert.equal((a as any).id, 'me');
  assert.equal((b as any).id, 'me');
  assert.equal(calls.filter((x) => x.url.includes('/api/token')).length, 1, 'one refresh for two concurrent calls');
  assert.equal(calls[0].init.headers.Authorization.startsWith('Basic '), true);
  assert.equal(String(calls[0].init.body), 'grant_type=refresh_token&refresh_token=REFRESH_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789');
});

test('a 401 refreshes once and retries; a second 401 surfaces as SpotifyApiError', async () => {
  const { fetchImpl, calls } = fakeFetch([
    tokenOk('T1'), { status: 401, body: { error: { message: 'expired' } } },
    tokenOk('T2'), { status: 200, body: { ok: true } },
  ]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  const r = await c.api('/me');
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[3].init.headers.Authorization, 'Bearer T2');

  const second = fakeFetch([tokenOk('T1'), { status: 401, body: {} }, tokenOk('T2'), { status: 401, body: { error: { message: 'still bad' } } }]);
  const c2 = new SpotifyClient({ fetch: second.fetchImpl, credentials: creds });
  await assert.rejects(c2.api('/me'), (e: any) => e instanceof SpotifyApiError && e.status === 401 && /still bad/.test(e.message));
});

test('a 429 within the cap is waited out once; beyond the cap it surfaces', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: { after: true } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, maxRetryAfterMs: 1000 });
  assert.deepEqual(await c.api('/search'), { after: true });

  const slow = fakeFetch([tokenOk(), { status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'rate' } } }]);
  const c2 = new SpotifyClient({ fetch: slow.fetchImpl, credentials: creds, maxRetryAfterMs: 1000 });
  await assert.rejects(c2.api('/search'), (e: any) => e instanceof SpotifyApiError && e.status === 429);
});

test('missing credentials fail with a SpotifyAuthError that names the three env keys', async () => {
  const c = new SpotifyClient({ fetch: fakeFetch([]).fetchImpl, credentials: () => ({ clientId: '', clientSecret: '', refreshToken: '' }) });
  assert.equal(c.hasCredentials(), false);
  await assert.rejects(c.api('/me'), (e: any) => e instanceof SpotifyAuthError && /SPOTIFY_REFRESH_TOKEN/.test(e.message));
});

test('a rotated refresh token and every access token reach their sinks; logs carry no token', async () => {
  const rotated: string[] = [];
  const access: string[] = [];
  const logs: string[] = [];
  const { fetchImpl } = fakeFetch([
    { status: 200, body: { access_token: 'NEWACCESS_abcdefghijklmnopqrstuvwxyz0123456789', expires_in: 60, refresh_token: 'ROTATED_abcdefghijklmnopqrstuvwxyz0123456789' } },
    { status: 200, body: {} },
    { status: 500, body: { error: { message: 'boom access_token=SHOULDNOTAPPEAR_abcdefghijklmnopqrstuvwxyz' } } },
  ]);
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, log: (l) => logs.push(l),
    onRefreshToken: (t) => { rotated.push(t); },
    onAccessToken: (t) => { access.push(t); },
  });
  await c.api('/me');
  assert.deepEqual(rotated, ['ROTATED_abcdefghijklmnopqrstuvwxyz0123456789']);
  assert.deepEqual(access, ['NEWACCESS_abcdefghijklmnopqrstuvwxyz0123456789']);
  await assert.rejects(c.api('/me'));
  for (const l of logs) {
    assert.ok(!/NEWACCESS|ROTATED|SHOULDNOTAPPEAR/.test(l), `token leaked into log: ${l}`);
  }
});

test('204 and allow404 read as null; other errors throw with endpoint + status', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 204 }, { status: 404, body: {} }, { status: 502, body: { error: { message: 'bad gateway' } } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  assert.equal(await c.pause('dev'), null);
  assert.equal(await c.getTrack('x'), null);
  await assert.rejects(c.getDevices(), (e: any) => e instanceof SpotifyApiError && e.status === 502 && e.endpoint === 'GET /v1/me/player/devices');
});

test('player commands carry device_id as a query param and the body only when it has content', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 204 }, { status: 204 }, { status: 204 }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  await c.play({ deviceId: 'D1', uris: ['spotify:track:abc'] });
  await c.play({ deviceId: 'D1' });
  await c.transfer('D1', true);
  const play1 = calls[1];
  assert.ok(play1.url.endsWith('/me/player/play?device_id=D1'));
  assert.deepEqual(JSON.parse(play1.init.body), { uris: ['spotify:track:abc'] });
  assert.equal(calls[2].init.body, undefined, 'resume carries no body');
  assert.deepEqual(JSON.parse(calls[3].init.body), { device_ids: ['D1'], play: true });
});

test('paginate walks `next` pages and honours `max`', async () => {
  const { fetchImpl } = fakeFetch([
    tokenOk(),
    { status: 200, body: { items: [1, 2], next: 'x' } },
    { status: 200, body: { items: [3, 4], next: 'y' } },
    { status: 200, body: { items: [5], next: null } },
  ]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  const out: number[] = [];
  for await (const n of c.paginate<number>((o) => c.api('/x', { query: { offset: o } }), { pageSize: 2 })) out.push(n);
  assert.deepEqual(out, [1, 2, 3, 4, 5]);

  const capped = fakeFetch([tokenOk(), { status: 200, body: { items: [1, 2], next: 'x' } }]);
  const c2 = new SpotifyClient({ fetch: capped.fetchImpl, credentials: creds });
  const few: number[] = [];
  for await (const n of c2.paginate<number>((o) => c2.api('/x', { query: { offset: o } }), { pageSize: 2, max: 1 })) few.push(n);
  assert.deepEqual(few, [1]);
});

test('authorizeUrl carries every scope librespot and the controller need', () => {
  const u = new URL(SpotifyClient.authorizeUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's1' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x/cb');
  assert.equal(u.searchParams.get('state'), 's1');
  const scopes = (u.searchParams.get('scope') ?? '').split(' ');
  for (const s of SPOTIFY_SCOPES) assert.ok(scopes.includes(s), `scope ${s}`);
  assert.ok(scopes.includes('streaming'), 'librespot login needs streaming');
});

test('playlist contents come from /items, capped at 50, with no market param', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 200, body: { items: [] } }, { status: 200, body: { items: [] } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  await c.getPlaylistItems('PL1');
  await c.getPlaylistItems('PL1', { limit: 100, offset: 50 });
  const u1 = new URL(calls[1].url);
  assert.equal(u1.pathname, '/v1/playlists/PL1/items', '/tracks was REMOVED and now 403s');
  assert.equal(u1.searchParams.get('limit'), '50');
  assert.equal(u1.searchParams.get('additional_types'), 'track');
  assert.equal(u1.searchParams.get('market'), null, 'from_token is gone — the user token carries the country');
  assert.equal(new URL(calls[2].url).searchParams.get('limit'), '50', 'an over-asked page is clamped, not passed through');
});

test('search never asks for more than ten, and the removed batch/top-tracks calls are gone from the client', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 200, body: { tracks: { items: [] } } }, { status: 200, body: { tracks: { items: [] } } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  await c.search('portishead', ['track'], { limit: 50 });
  await c.search('portishead', ['track'], {});
  for (const i of [1, 2]) {
    const u = new URL(calls[i].url);
    assert.equal(u.searchParams.get('limit'), '10', 'Spotify caps /search at 10 — asking 50 returns a trimmed page');
    assert.equal(u.searchParams.get('market'), null);
  }
  const surface = c as unknown as Record<string, unknown>;
  for (const gone of ['getTracks', 'getArtists', 'getArtistTopTracks']) {
    assert.equal(typeof surface[gone], 'undefined', `${gone} hits an endpoint Spotify removed`);
  }
  assert.equal(typeof c.getArtist, 'function', 'the per-id read is the replacement for the batch');
});

test('a failure with no error.message still says something — the bare "Forbidden" that named nothing', async () => {
  const logs: string[] = [];
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 403, body: undefined }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, log: (l) => logs.push(l) });
  await assert.rejects(c.getPlaylistItems('PL1'), (e: any) => e instanceof SpotifyApiError && e.status === 403);
  assert.match(logs.join('\n'), /playlists\/PL1\/items → 403/);

  // A non-JSON body — what a removed route actually answers — must not be
  // swallowed: the raw prefix is the only clue the operator gets.
  const logs2: string[] = [];
  const html = fakeFetch([tokenOk(), { status: 403, body: '<html>Forbidden: endpoint removed</html>' }]);
  const c2 = new SpotifyClient({ fetch: html.fetchImpl, credentials: creds, log: (l) => logs2.push(l) });
  await assert.rejects(c2.api('/playlists/PL1/items'), (e: any) => e.status === 403);
  assert.match(logs2.join('\n'), /endpoint removed/, 'the body reaches the log, not just "Forbidden"');
});

test('redactSpotify hides token-shaped values', () => {
  const s = redactSpotify('access_token=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd Bearer ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw');
  assert.ok(!/ABCDEFGHIJKLMNOP|ZYXWVUTSRQ/.test(s), s);
});
