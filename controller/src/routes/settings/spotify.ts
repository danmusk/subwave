// Spotify music-source settings: credentials, the one-time OAuth connect, a
// non-mutating probe, and disconnect. Admin-gated except the OAuth callback,
// which Spotify's redirect reaches without the admin's Basic-auth header — it is
// protected by a one-time `state` nonce instead (standard OAuth posture).
//
// Storage follows the house rules: the client id/secret and refresh token are
// SECRETS → state/secrets.env via saveSecrets (env always wins; env-managed
// fields are refused rather than shadowed), never settings.json. The catalog
// knobs (pool, device name…) are ordinary settings under `settings.spotify` and
// ride the normal /settings patch path — nothing here touches them.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { requireAdmin } from '../../middleware/auth.js';
import { saveSecrets } from '../../setup/secrets.js';
import { SpotifyClient, SPOTIFY_SCOPES } from '../../music/sources/spotify/client.js';
import { spotifyClient, spotifyCredentials, spotifyPool } from '../../music/sources/spotify/source.js';
import { writeLibrespotToken } from '../../music/sources/spotify/token-file.js';
import { queue } from '../../broadcast/queue.js';

export const router = express.Router();

// Pending OAuth states: nonce → issued-at. Ten minutes is generous for a
// consent screen; anything older is refused so a stale link cannot be replayed.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepStates(now = Date.now()) {
  for (const [k, at] of pendingStates) if (now - at > STATE_TTL_MS) pendingStates.delete(k);
}

// The redirect URI must match the Developer app EXACTLY. SITE_URL is the
// operator's public origin (the same one tune-in links use); the request host is
// the fallback for a LAN install without one.
export function spotifyRedirectUri(req: express.Request): string {
  const explicit = (process.env.SPOTIFY_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const site = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  const origin = site || `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/settings/spotify/callback`;
}

export function spotifyStatus(req: express.Request) {
  const c = spotifyCredentials();
  return {
    clientIdSet: !!c.clientId,
    clientSecretSet: !!c.clientSecret,
    connected: !!c.refreshToken,
    env: {
      clientId: !!process.env.SPOTIFY_CLIENT_ID && envManaged('SPOTIFY_CLIENT_ID'),
      clientSecret: !!process.env.SPOTIFY_CLIENT_SECRET && envManaged('SPOTIFY_CLIENT_SECRET'),
      refreshToken: !!process.env.SPOTIFY_REFRESH_TOKEN && envManaged('SPOTIFY_REFRESH_TOKEN'),
    },
    redirectUri: spotifyRedirectUri(req),
    scopes: SPOTIFY_SCOPES,
    pool: spotifyPool().peek()
      ? {
          tracks: spotifyPool().peek()!.tracks.size,
          albums: spotifyPool().peek()!.albums.size,
          playlists: spotifyPool().peek()!.playlists.length,
          builtAt: spotifyPool().peek()!.builtAt,
          partial: spotifyPool().peek()!.partial,
        }
      : null,
  };
}

// A key is "env-managed" when it came from the root .env rather than from
// state/secrets.env. secrets.ts loads the file into process.env at boot without
// overwriting keys already set, and records which ones it loaded.
import { loadedSecretKeys } from '../../setup/secrets.js';
function envManaged(key: string): boolean {
  return !loadedSecretKeys().has(key);
}

router.get('/settings/spotify', requireAdmin, (req, res) => {
  res.json(spotifyStatus(req));
});

// Client id/secret from the Developer app. Blank secret = keep the one on file.
router.post('/settings/spotify/credentials', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch: Record<string, string> = {};
    if (typeof b.clientId === 'string') patch.SPOTIFY_CLIENT_ID = b.clientId.trim();
    if (typeof b.clientSecret === 'string' && b.clientSecret !== '') patch.SPOTIFY_CLIENT_SECRET = b.clientSecret.trim();
    for (const key of Object.keys(patch)) {
      if (process.env[key] && envManaged(key)) {
        return res.status(400).json({ ok: false, error: `${key} is managed by the root .env — env always wins on boot; remove it there to manage it here` });
      }
    }
    if (patch.SPOTIFY_CLIENT_ID !== undefined && !/^[0-9a-f]{32}$/i.test(patch.SPOTIFY_CLIENT_ID)) {
      return res.status(400).json({ ok: false, error: 'clientId should be the 32-hex Client ID from the Spotify Developer dashboard' });
    }
    if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'nothing to save' });
    await saveSecrets(patch);
    res.json({ ok: true, ...spotifyStatus(req) });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || 'save failed' });
  }
});

// Step 1 of Connect: hand the browser the authorize URL. The state nonce is
// remembered server-side so the callback can tell a real return from a forged
// or replayed one.
router.get('/settings/spotify/auth', requireAdmin, (req, res) => {
  const c = spotifyCredentials();
  if (!c.clientId) return res.status(400).json({ ok: false, error: 'save the Spotify client id first' });
  sweepStates();
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  res.json({ ok: true, url: SpotifyClient.authorizeUrl({ clientId: c.clientId, redirectUri: spotifyRedirectUri(req), state }) });
});

// Step 2: Spotify redirects the operator's browser here. NOT admin-gated (the
// redirect carries no Authorization header); the nonce is the gate. Exchanges
// the code, persists the refresh token, writes librespot's first-login token,
// and sends the operator back to the settings section.
router.get('/settings/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const back = (q: string) => res.redirect(`/admin/settings?section=music&spotify=${encodeURIComponent(q)}`);
  sweepStates();
  if (!state || !pendingStates.has(state)) return back('error:invalid-state');
  pendingStates.delete(state);
  if (error || !code) return back(`error:${error || 'no-code'}`);
  const c = spotifyCredentials();
  if (!c.clientId || !c.clientSecret) return back('error:no-credentials');
  try {
    const tok = await SpotifyClient.exchangeCode({ clientId: c.clientId, clientSecret: c.clientSecret, code, redirectUri: spotifyRedirectUri(req) });
    await saveSecrets({ SPOTIFY_REFRESH_TOKEN: tok.refreshToken });
    await writeLibrespotToken(tok.accessToken, Date.now() + tok.expiresIn * 1000).catch(() => {});
    spotifyClient().resetToken();
    spotifyPool().invalidate();
    queue.log('scheduler', 'Spotify connected — refresh token stored');
    return back('connected');
  } catch (err: any) {
    queue.log('error', `Spotify connect failed: ${err?.message || err}`);
    return back('error:exchange-failed');
  }
});

// The paste-a-token alternative for operators who ran the OAuth flow elsewhere.
router.post('/settings/spotify/token', requireAdmin, async (req, res) => {
  const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (!token) return res.status(400).json({ ok: false, error: 'refreshToken is required' });
  if (process.env.SPOTIFY_REFRESH_TOKEN && envManaged('SPOTIFY_REFRESH_TOKEN')) {
    return res.status(400).json({ ok: false, error: 'SPOTIFY_REFRESH_TOKEN is managed by the root .env' });
  }
  await saveSecrets({ SPOTIFY_REFRESH_TOKEN: token });
  spotifyClient().resetToken();
  spotifyPool().invalidate();
  res.json({ ok: true, ...spotifyStatus(req) });
});

// Non-mutating probe: refreshes a token and asks who we are. Reports the
// account product because Connect playback needs Premium.
router.post('/settings/spotify/test', requireAdmin, async (_req, res) => {
  const c = spotifyClient();
  if (!c.hasCredentials()) return res.json({ ok: false, error: 'not connected' });
  try {
    const me: any = await c.getMe();
    res.json({ ok: true, displayName: me?.display_name ?? me?.id, product: me?.product ?? 'unknown', country: me?.country });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || 'probe failed' });
  }
});

router.post('/settings/spotify/disconnect', requireAdmin, async (req, res) => {
  if (process.env.SPOTIFY_REFRESH_TOKEN && envManaged('SPOTIFY_REFRESH_TOKEN')) {
    return res.status(400).json({ ok: false, error: 'SPOTIFY_REFRESH_TOKEN is managed by the root .env' });
  }
  await saveSecrets({ SPOTIFY_REFRESH_TOKEN: '' });
  spotifyClient().resetToken();
  spotifyPool().invalidate();
  res.json({ ok: true, ...spotifyStatus(req) });
});

// Rebuild the pool now (after editing playlists) rather than waiting out the TTL.
router.post('/settings/spotify/pool/refresh', requireAdmin, async (_req, res) => {
  try {
    spotifyPool().invalidate();
    const p = await spotifyPool().get();
    res.json({ ok: true, tracks: p.tracks.size, albums: p.albums.size, playlists: p.playlists, genres: p.genres.size, partial: p.partial });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message || 'pool build failed' });
  }
});
