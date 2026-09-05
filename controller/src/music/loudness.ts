// Loudness gain resolution (feature: LUFS gain) — the single answer to "how
// many dB does this track get on air".
//
// Two consumers, and they MUST agree (#1240): the queue drain stamps the
// figure as `liq_amplify` so Liquidsoap applies it per track, and the
// stem-blend render bakes the same figure into the clip (the clip carries no
// liq_amplify of its own — see subsonic.getClipUri). When the two diverged,
// a rendered seam played at a different level than the track it handed off
// to, which is what "the stem files aren't volume matched to the regular
// track" was.
//
// The resolution order is the operator's `settings.loudness.source`: the
// embedded ReplayGain tag (whole-file R128, via Navidrome's OpenSubsonic
// replayGain field) first by default, else the analyzer's measured LUFS
// (leading window only — which is exactly why the render can't just use the
// measured value and call it equivalent). Null loudness from every allowed
// source → null gain → unity, today's behaviour for an untagged, unanalysed
// library.

import * as settings from '../settings.js';
import * as subsonic from './source.js';
import * as library from './library.js';
import * as mix from './mix.js';

export interface LoudnessTrack {
  id?: string | null;
  loudnessLufs?: number | null;
  peakDb?: number | null;
  replayGain?: { trackGain?: number | null; trackPeak?: number | null } | null;
  [k: string]: unknown;
}

// Resolves the dB offset this track plays at. Caches the ReplayGain answer
// onto the track object (`replayGain`), so a second call for the same object
// — the stem-blend render warming a successor the drain will re-resolve
// moments later — costs no extra Subsonic round-trip.
//
// `onWarn` surfaces an unreachable Navidrome to the caller's log; the lookup
// itself is best-effort and falls through to the measured value.
export async function resolveGainDb(
  track: LoudnessTrack | null | undefined,
  onWarn?: (msg: string) => void,
): Promise<number | null> {
  if (!track) return null;
  const loud = settings.get().loudness;
  const source = loud?.source ?? 'replaygain-then-measured';
  let lufs: number | null | undefined = null;
  let peakDb: number | null | undefined = null;
  if (source !== 'measured') {
    let rg = mix.loudnessFromReplayGain(track.replayGain);
    if (!rg && track.replayGain === undefined && track.id) {
      try {
        const song = await subsonic.getSong(track.id);
        track.replayGain = song?.replayGain ?? null; // cache the answer either way
        rg = mix.loudnessFromReplayGain(song?.replayGain);
      } catch (err) {
        // Best-effort — an unreachable Navidrome falls through to measured.
        onWarn?.(`replayGain lookup failed for ${track.id}: ${(err as Error).message}`);
      }
    }
    if (rg) {
      lufs = rg.lufs;
      peakDb = rg.peakDb;
    }
  }
  if (lufs == null && source !== 'replaygain') {
    lufs = track.loudnessLufs;
    peakDb = track.peakDb;
    if ((lufs == null || peakDb == null) && track.id) {
      const rec = library.get(track.id);
      if (lufs == null) lufs = rec?.loudnessLufs ?? null;
      if (peakDb == null) peakDb = rec?.peakDb ?? null;
    }
  }
  return mix.gainForLoudness(lufs, {
    peakDb,
    targetLufs: loud?.targetLufs,
    maxBoostDb: loud?.maxBoostDb,
  });
}
