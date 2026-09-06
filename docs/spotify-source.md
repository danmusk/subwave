# Spotify as the music source

> **Experimental.** Works end to end in this fork; not a Spotify-endorsed
> integration. It uses [librespot](https://github.com/librespot-org/librespot),
> an open-source Spotify Connect client, whose README says connecting to
> Spotify this way "is probably forbidden by them". You need your own basis
> for using it (a Premium account and, for restreaming, whatever agreement
> covers your station). SUB/WAVE ships no credentials and no audio.

SUB/WAVE's music backend is pluggable (`settings.music.source`). With
`spotify` selected, the AI DJ picks from Spotify's catalog, the picks play on a
Spotify Connect receiver that runs **inside the broadcast container**, and the
audio flows into the same Liquidsoap mixer as always — jingles, DJ talk,
requests, scheduling, the web player and the Icecast stream all keep working.
Nothing runs on your desktop, no virtual audio cable, no OBS.

```
AI DJ picks track B ─▶ controller ─▶ Spotify Web API: play B on "SUB/WAVE"
                                              │
                          broadcast container │
                          ┌───────────────────▼──────────────────────┐
                          │ librespot (Spotify Connect receiver)     │
                          │   └─ PCM ─▶ Liquidsoap music input       │
                          │   └─ events ─▶ spotify-player.json ─▶ controller
                          │ Liquidsoap: + DJ voice + jingles ─▶ Icecast
                          └──────────────────────────────────────────┘
```

## What you need

- A **Spotify Premium** account (Connect playback is Premium-only).
- A **Spotify Developer app** at <https://developer.spotify.com/dashboard>:
  create one, tick *Web API*, and add the redirect URI the admin page shows
  (`<your SITE_URL>/api/settings/spotify/callback`). Copy the client id and
  secret.
- A broadcast image built from this fork (librespot is compiled into it:
  `docker compose build broadcast`, or pull the fork's published image).

## Setting it up

Best done on a **fresh station profile** (see `docs/multi-station.md`): every
music source keeps its own `library.db`, and a Spotify library holds Spotify
track ids where a Navidrome library holds Navidrome ids.

1. **Admin → Settings → Music source** — choose *Spotify*. The mixer needs a
   restart after this (the banner offers it); the mixer boots in Spotify mode
   from then on.
2. Paste the **client id** and **client secret**, *Save credentials*.
3. **Connect Spotify** — you are sent to Spotify's consent screen and back.
   This stores a refresh token in `state/secrets.env` and writes a first
   access token for the receiver to `state/spotify/token`.
4. *Test* should report your account name and `premium`.
5. **Library pool** — paste the playlists the station may draw from (ids,
   `spotify:playlist:` URIs or links, one per line; empty = every playlist the
   account owns or follows) and choose whether saved tracks / albums count.
   *Rebuild pool now* shows how many tracks it found.
6. **Sign the receiver in** (Playback card). This is a second, separate login:
   the receiver (librespot) talks to Spotify as Spotify's own desktop client,
   and a token from your Developer app is refused at the Connect handshake
   (`INVALID_CREDENTIALS`). Spotify sends the browser to
   `http://127.0.0.1:5588/login` afterwards, which is librespot's registered
   redirect, not yours:
   - with `docker compose -f docker-compose.yml -f docker-compose.spotify.yml`
     the controller is published on that loopback port and completes the
     sign-in itself, bouncing you back to the settings page;
   - without the overlay the page fails to load — copy the whole address from
     the address bar into *Finish sign-in*.
   The token lands in `state/spotify/token`; librespot caches reusable
   credentials on its next start and the controller renews the token from its
   refresh token, so this is a one-time step.
7. Restart the mixer if you have not yet. Within a few seconds the receiver
   (named `SUB/WAVE`, or `spotify.deviceName`) appears in your Spotify apps'
   device list, and the station starts playing from the pool. The DJ's picks
   follow. The receiver's name is deliberately not the station name: the
   receiver keeps the name it booted with, and renaming the station must not
   orphan it.

Optional: run the tagger (*Library → Tagging*) over the pool. Text tagging
needs no audio, and it is what gives the picker mood tools on Spotify.

### Environment alternative

For IaC-style installs the three secrets can live in the root `.env`
(`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`,
optionally `SPOTIFY_REDIRECT_URI`). Env always wins; the admin fields then
show as env-managed.

## How a track plays

The controller never lets Spotify choose. It commands each track on the
receiver over the Web API, learns from librespot's own events when it
actually started, and then tells the mixer — which inserts a real track
boundary carrying the title/artist/album/id. From there everything is the
station's normal path: `now-playing.json`, the ICY title, the DJ link ducking
the intro, scrobbles, webhooks, the next pick. Autoplay is never enabled on
the receiver.

- **Seam**: the next track is commanded `spotify.seamLeadMs` (default 1.5 s)
  before the current one ends, or the instant the player reports it ended.
  Tracks meet at a hard cut; the DJ's link plays over the incoming intro as
  usual.
- **Nothing picked in time**: the transport plays a random track from the pool
  (the equivalent of `auto.m3u`) and says so in the booth log.
- **Jingles**: automatic and manual jingles work unchanged — they play at the
  boundary, and the receiver simply waits (the pipe back-pressures) and resumes
  from the same sample afterwards.
- **Someone moves playback to a phone**: `spotify.mismatch` decides —
  *reclaim* (default) transfers playback back and plays the DJ's pick once,
  then adopts what is playing if that fails; *follow* adopts immediately and
  publishes the real track so now-playing is never wrong for long.
- **Operator skip** (`/dj/skip`) commands the next pick immediately.

## What is different from Navidrome

Spotify exposes no audio file, so everything the acoustic analyzer derives is
off: BPM/key, measured loudness, intro/outro analysis, silence trim, CLAP
"sounds-like" search and sonic journeys, vocal-aware links, stem blends,
ending-aware crossfades and the DJ transition effects (the mixer bypasses
`cross` in this mode). Loudness normalisation comes from Spotify's own
ReplayGain data via librespot instead. Also off: Last.fm similar-songs and the
OpenSubsonic sonic extension (the picker tools for them are simply not
offered), lyrics, Navidrome scrobbling/starring, playlist editing, beds.

Spotify's own **February 2026 API restrictions** take a further slice, for every
app that is not in extended quota mode:

- **an artist's top songs are gone entirely** (`/artists/{id}/top-tracks` was
  removed with no replacement, and `popularity` went with it), so the
  `topSongsByArtist` picker tool is not offered on Spotify;
- **the pool can only be built from playlists this account owns or collaborates
  on** — a followed playlist gives its name and cover but no tracks;
- **search answers ten results a page** instead of fifty, so wide searches page;
- **the account tier is no longer readable**, so *Test* can confirm who you are
  but not that you are Premium. Connect playback still requires it.

Everything else is on: the agent and pool pickers, text tagging and
embeddings over the pool, era filtering (album-level; compilations read as
unknown-year as they do on Navidrome), requests, ducked links/idents/banter/
programmes, jingles, sfx, likes, webhooks, Last.fm/ListenBrainz scrobbling,
all skins, the MCP server.

Settings under `spotify`: `deviceName`, `bitrate` (96/160/320), `pool.*`,
`seamLeadMs`, `healthPollSec`, `mismatch`. Device name and bitrate are
receiver launch flags and need a mixer restart; the rest apply live.

## Troubleshooting

| Symptom | Where to look | Likely cause |
|---|---|---|
| Emergency loop on air, `/state` says `musicStarved` | `docker compose logs broadcast` (`librespot-run:` lines) | receiver not running: not connected yet, token stale, or the image lacks librespot |
| `librespot-run: no cached credentials and no token file` | admin → Music source → Playback | *Sign the receiver in* has not been done on this station |
| `could not initialize spirc: … INVALID_CREDENTIALS` in the broadcast log | Playback card | the token file holds a Developer-app token (older build) — *Sign the receiver in*; a newer token replaces the stale credential cache |
| Pool builds to **0 tracks**, booth log says `nothing to play … the pool is empty` | admin → Music source → Library pool (it names the reason) | Spotify serves playlist CONTENTS only for playlists the connected account **owns or collaborates on** — a followed or someone else's playlist resolves its name and returns nothing. Put the tracks in a playlist this account owns, or turn on saved tracks/albums |
| `Refresh token revoked` on the RECEIVER, hourly | Playback card | the receiver sign-in has expired — *Sign the receiver in* again. (Fixed at the source since the refresher now persists Spotify's rotated token; a token stranded by an older build still needs one manual re-sign-in) |
| Test can't say whether the account is Premium | — | expected: Spotify removed `product` from `/me` in February 2026. Premium is still required, it just cannot be probed |
| Any Web API call answering **403** on an endpoint that used to work | `docker compose logs controller` (`[spotify] GET … → 403 …`) | the February 2026 Development Mode restrictions removed a slice of the API. The station targets the new surface; a 403 on something else means another endpoint went the same way |
| Receiver missing from the device list | `spotify.deviceName`, `docker compose logs broadcast` | librespot not authenticated; the name is matched case-insensitively |
| Picks never start, booth log says `no-device` | as above | the receiver is down; picks stay queued until it returns |
| `unavailable` in the booth log | track/market | not playable on this account or market — dropped and re-picked |
| Silence but `/state` transport shows `playing` | `state/spotify-audio.json` | receiver stalled; the transport re-commands after the idle window |
| Doctor: `spotify connectivity` fails | credentials | refresh token revoked — reconnect |

State files: `state/spotify/` (receiver credential cache, token),
`state/spotify-player.json` (last player event), `state/spotify-audio.json`
(silence detector), `state/logs/spotify-events.log` (rolling event log),
`state/liquidsoap_music_mode.txt` and `state/liquidsoap_spotify.txt` (mixer
handoffs).

## The fallback nobody should need

If librespot cannot be used, the same architecture takes a different audio
leg: the Spotify desktop app on a Windows host, a virtual audio device, and a
small bridge that pushes the capture into Liquidsoap over its Icecast-source
input (`input.harbor`), with the Web API's playback state standing in for the
player events. That variant is documented in the design plan, not built.
