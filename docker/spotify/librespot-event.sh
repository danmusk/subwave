#!/usr/bin/env bash
# librespot --onevent target: turn the player's event (env vars, see
# https://github.com/librespot-org/librespot/wiki/Events) into ONE marker file
# the controller reads, state/spotify-player.json — the same shape of contract
# as now-playing.json / voice-playing.json. librespot runs event scripts in
# order and waits for each, so this must stay quick and must never block.
#
# Only ids, positions and the event name are written: the controller already
# holds the catalog data for the track it commanded, and a title with an odd
# character has no business being escaped in bash. Written atomically (rename on
# the same filesystem) so the 500 ms reader never sees a torn file.
set -u
STATE_DIR="${SUBWAVE_STATE_DIR:-/var/sub-wave}"
OUT="$STATE_DIR/spotify-player.json"
TMP="$OUT.tmp.$$"

ev="${PLAYER_EVENT:-}"
[ -z "$ev" ] && exit 0

num() { case "$1" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }
# ids are base62 / plain tokens — anything else is dropped rather than escaped.
tok() { case "$1" in *[!A-Za-z0-9:_-]*|'') printf '' ;; *) printf '%s' "$1" ;; esac; }
now_ms="$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")"

printf '{"event":"%s","trackId":"%s","uri":"%s","positionMs":%s,"durationMs":%s,"at":%s}\n' \
    "$(tok "$ev")" "$(tok "${TRACK_ID:-}")" "$(tok "${URI:-}")" \
    "$(num "${POSITION_MS:-}")" "$(num "${DURATION_MS:-}")" "$now_ms" > "$TMP" \
  && mv -f "$TMP" "$OUT"

# A short rolling log for operators debugging the seam (last ~200 events).
LOG="$STATE_DIR/logs/spotify-events.log"
if [ -d "$STATE_DIR/logs" ]; then
    printf '%s %s track=%s pos=%s dur=%s\n' "$now_ms" "$ev" "${TRACK_ID:-}" "${POSITION_MS:-}" "${DURATION_MS:-}" >> "$LOG" 2>/dev/null || true
    if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 400 ]; then
        tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
    fi
fi
exit 0
