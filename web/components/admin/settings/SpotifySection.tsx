'use client';

import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Textarea } from '../../ui/textarea';
import { Btn, Card, Toggle } from '../ui';
import { type SaveSettings, type SettingsData } from './shared';

// The Spotify music source's settings. Two stores, two save paths — on purpose:
//   • credentials (client id / secret / the Connect flow) are SECRETS and talk
//     to /settings/spotify/* (state/secrets.env), like NavidromeSection talks to
//     /settings/navidrome;
//   • the catalog knobs (pool, device name, mismatch policy) are ordinary
//     settings under `spotify` and ride the shared saveSettings patch path.
interface SpotifySectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

type Probe = { ok: boolean; displayName?: string; product?: string; country?: string; error?: string };

export function SpotifySection({ data, busy, saveSettings, adminFetch, refresh }: SpotifySectionProps) {
  const st = data.spotify;
  const sp = data.values?.spotify;
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const [poolBusy, setPoolBusy] = useState(false);
  const [playlistText, setPlaylistText] = useState(() => (sp?.pool?.playlistIds ?? []).join('\n'));
  const [deviceName, setDeviceName] = useState(() => sp?.deviceName ?? '');

  // The OAuth callback bounces back here with ?spotify=connected|error:<why>.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search).get('spotify');
    if (!q) return;
    if (q === 'connected') notify.ok('Spotify connected');
    else notify.err(`Spotify connect failed: ${q.replace(/^error:/, '')}`);
    const url = new URL(window.location.href);
    url.searchParams.delete('spotify');
    window.history.replaceState({}, '', url.toString());
    refresh();
  }, [refresh]);

  const post = async (path: string, body?: unknown) => {
    const r = await adminResponse(adminFetch, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await r.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  };

  const saveCredentials = async () => {
    if (!clientId && !clientSecret) return notify.err('Enter the client id and/or secret first');
    setSaving(true);
    try {
      const j = await post('/settings/spotify/credentials', { clientId: clientId || undefined, clientSecret: clientSecret || undefined });
      if (j.ok === false) return notify.err(j.error || 'save failed');
      notify.ok('Spotify app credentials saved');
      setClientSecret('');
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const connect = async () => {
    try {
      const r = await adminResponse(adminFetch, '/settings/spotify/auth');
      const j = (await r.json()) as { ok?: boolean; url?: string; error?: string };
      if (!j.ok || !j.url) return notify.err(j.error || 'could not start the Spotify login');
      window.location.href = j.url;
    } catch (err) { notify.err(errorMessage(err)); }
  };

  const pasteToken = async () => {
    if (!refreshToken.trim()) return;
    setSaving(true);
    try {
      const j = await post('/settings/spotify/token', { refreshToken: refreshToken.trim() });
      if (j.ok === false) return notify.err(j.error || 'save failed');
      notify.ok('Refresh token stored');
      setRefreshToken('');
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      const j = await post('/settings/spotify/disconnect');
      if (j.ok === false) return notify.err(j.error || 'disconnect failed');
      notify.ok('Spotify disconnected');
      setProbe(null);
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setProbing(true);
    try { setProbe(await post('/settings/spotify/test') as Probe); }
    catch (err) { setProbe({ ok: false, error: errorMessage(err) }); }
    finally { setProbing(false); }
  };

  const rebuildPool = async () => {
    setPoolBusy(true);
    try {
      const j = await post('/settings/spotify/pool/refresh');
      if (j.ok === false) return notify.err(j.error || 'pool build failed');
      notify.ok(`Pool rebuilt: ${j.tracks} tracks from ${(j.playlists as unknown[])?.length ?? 0} playlists`);
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setPoolBusy(false); }
  };

  const savePool = () => saveSettings({ spotify: { pool: { playlistIds: playlistText } } });
  const envHint = (envVar: string) => (
    <div className="field-hint">Set via <code>{envVar}</code> in the root <code>.env</code> — env always wins on boot.</div>
  );

  return (
    <>
      <Card title="Spotify account" sub="A Spotify Developer app + a Premium account. Music plays on a Spotify Connect receiver inside the broadcast container.">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="sp-client-id">Client ID</Label>
            <Input id="sp-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)}
              placeholder={st?.clientIdSet ? '•••••••• (set)' : '32-hex id from developer.spotify.com'} disabled={!!st?.env?.clientId} />
            {st?.env?.clientId ? envHint('SPOTIFY_CLIENT_ID') : null}
          </div>
          <div>
            <Label htmlFor="sp-client-secret">Client secret</Label>
            <Input id="sp-client-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
              placeholder={st?.clientSecretSet ? '•••••••• (set — leave blank to keep)' : ''} disabled={!!st?.env?.clientSecret} />
            {st?.env?.clientSecret ? envHint('SPOTIFY_CLIENT_SECRET') : null}
          </div>
        </div>
        <div className="field-hint mt-2">
          Register this redirect URI on the app: <code>{st?.redirectUri ?? '…/api/settings/spotify/callback'}</code>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn sm onClick={saveCredentials} disabled={saving || (!clientId && !clientSecret)}>Save credentials</Btn>
          <Btn sm tone="accent" onClick={connect} disabled={saving || !st?.clientIdSet || !st?.clientSecretSet}>
            {st?.connected ? 'Reconnect Spotify' : 'Connect Spotify'}
          </Btn>
          <Btn sm onClick={test} disabled={probing || !st?.connected}>{probing ? 'Testing…' : 'Test'}</Btn>
          {st?.connected ? <Btn sm onClick={disconnect} disabled={saving || !!st?.env?.refreshToken}>Disconnect</Btn> : null}
          <span className="text-sm opacity-80">
            {st?.connected ? 'connected' : 'not connected'}
            {probe ? (probe.ok ? ` · ${probe.displayName} · ${probe.product}${probe.country ? ` · ${probe.country}` : ''}` : ` · ${probe.error}`) : ''}
          </span>
        </div>
        {probe?.ok && probe.product === 'unknown' ? (
          <div className="field-hint mt-2">Spotify did not report the account type — the token predates the <code>user-read-private</code> scope. Press <b>Reconnect Spotify</b> once to grant it.</div>
        ) : null}
        {probe?.ok && probe.product && probe.product !== 'unknown' && probe.product !== 'premium' ? (
          <div className="field-hint mt-2">This account is <b>{probe.product}</b>. Spotify Connect playback needs Premium.</div>
        ) : null}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">Paste a refresh token instead</summary>
          <div className="mt-2 flex gap-2">
            <Input value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="refresh token from an OAuth flow you ran elsewhere" disabled={!!st?.env?.refreshToken} />
            <Btn sm onClick={pasteToken} disabled={saving || !refreshToken.trim()}>Store</Btn>
          </div>
          {st?.env?.refreshToken ? envHint('SPOTIFY_REFRESH_TOKEN') : null}
        </details>
      </Card>

      <Card title="Library pool" sub="What counts as the station's library on Spotify. Random picks, genre browsing and the mood tagger draw from this pool; search reaches the whole catalog.">
        <Label htmlFor="sp-playlists">Playlists (one per line — ids, spotify:playlist: URIs or open.spotify.com links; empty = every playlist the account owns or follows)</Label>
        <Textarea id="sp-playlists" className="min-h-28 font-mono text-sm" value={playlistText}
          onChange={(e) => setPlaylistText(e.target.value)} disabled={busy} />
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <Toggle on={sp?.pool?.includeSaved !== false} disabled={busy}
              onClick={() => saveSettings({ spotify: { pool: { includeSaved: !(sp?.pool?.includeSaved !== false) } } })} ariaLabel="include saved tracks" />
            Include saved (liked) tracks
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Toggle on={!!sp?.pool?.includeSavedAlbums} disabled={busy}
              onClick={() => saveSettings({ spotify: { pool: { includeSavedAlbums: !sp?.pool?.includeSavedAlbums } } })} ariaLabel="include saved albums" />
            Include saved albums
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn sm onClick={savePool} disabled={busy || playlistText === (sp?.pool?.playlistIds ?? []).join('\n')}>Save playlists</Btn>
          <Btn sm onClick={rebuildPool} disabled={poolBusy || !st?.connected}>{poolBusy ? 'Rebuilding…' : 'Rebuild pool now'}</Btn>
          <span className="text-sm opacity-80">
            {st?.pool
              ? `${st.pool.tracks} tracks · ${st.pool.albums} albums · ${st.pool.playlists} playlists${st.pool.partial ? ' · partial' : ''}`
              : 'pool not built yet — it builds on first use'}
          </span>
        </div>
      </Card>

      <Card title="Playback" sub="The Spotify Connect receiver (librespot) runs inside the broadcast container and is commanded by the station.">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="sp-device">Device name</Label>
            <Input id="sp-device" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="(station name)" disabled={busy}
              onBlur={() => { if (deviceName !== (sp?.deviceName ?? '')) saveSettings({ spotify: { deviceName } }); }} />
            <div className="field-hint">How the receiver appears in Spotify apps. Changing it needs a mixer restart.</div>
          </div>
          <div>
            <Label>If playback is moved to another device</Label>
            <div className="mt-1 flex gap-2">
              <Btn sm tone={sp?.mismatch !== 'follow' ? 'accent' : undefined} disabled={busy} onClick={() => saveSettings({ spotify: { mismatch: 'reclaim' } })}>Reclaim it</Btn>
              <Btn sm tone={sp?.mismatch === 'follow' ? 'accent' : undefined} disabled={busy} onClick={() => saveSettings({ spotify: { mismatch: 'follow' } })}>Follow it</Btn>
            </div>
            <div className="field-hint">Reclaim transfers playback back to the station and plays what the DJ picked; follow adopts whatever is playing.</div>
          </div>
        </div>
      </Card>
    </>
  );
}
