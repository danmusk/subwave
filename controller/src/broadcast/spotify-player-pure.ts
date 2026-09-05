// Pure parsers for the two Spotify-mode marker files the mixer side writes:
// spotify-player.json (docker/spotify/librespot-event.sh — one librespot event)
// and spotify-audio.json (radio.liq's blank.detect handlers). Every failure
// resolves to null: a marker is a convenience the controller reads on a timer,
// and a torn or absent file must never turn into a decision.

export type SpotifyPlayerEventName =
  | 'track_changed' | 'playing' | 'paused' | 'seeked' | 'position_correction'
  | 'end_of_track' | 'stopped' | 'unavailable' | 'preload_next' | 'preloading' | 'loading'
  | 'session_connected' | 'session_disconnected' | 'session_client_changed'
  | 'volume_changed' | 'shuffle_changed' | 'repeat_changed' | 'auto_play_changed'
  | 'filter_explicit_content_changed' | string;

export interface SpotifyPlayerEvent {
  event: SpotifyPlayerEventName;
  trackId: string | null;
  positionMs: number | null;
  durationMs: number | null;
  // ms epoch when the event script ran — the marker's own clock.
  at: number;
}

const ID_RE = /^[0-9A-Za-z]{22}$/;

export function parseSpotifyPlayerEvent(raw: unknown): SpotifyPlayerEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const event = typeof o.event === 'string' ? o.event.trim() : '';
  if (!event || !/^[a-z_]+$/.test(event)) return null;
  const at = Number(o.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const idRaw = typeof o.trackId === 'string' ? o.trackId : '';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    event,
    trackId: ID_RE.test(idRaw) ? idRaw : null,
    positionMs: num(o.positionMs),
    durationMs: num(o.durationMs),
    at,
  };
}

export interface SpotifyAudioState {
  state: 'silent' | 'audio';
  // seconds epoch (Liquidsoap's time()) → converted to ms here.
  atMs: number;
}

export function parseSpotifyAudioState(raw: unknown): SpotifyAudioState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.state !== 'silent' && o.state !== 'audio') return null;
  const at = Number(o.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return { state: o.state, atMs: Math.round(at * 1000) };
}
