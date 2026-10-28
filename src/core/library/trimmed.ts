/**
 * „Zuschneiden …“ for a title that is not on the card yet (0.6, #131): the
 * picked file stays as it is; the title gets the cut file (in memory, cut
 * without converting, core/audio/trimedit.ts) and goes to the card like
 * that. What it knew about its own time (where its tracks or chapters
 * begin) moves with the sound.
 */
import { keptSec, timeAfterEdit, type TrimEdit } from '../audio/trimedit';
import type { AlbumCuts, DraftTrack } from './grouping';
import type { TrackInfo } from './tags';

/** Two starts closer than this are one (the title between them was cut away). */
const SAME_START_SEC = 1;

/**
 * Starts (tracks of a whole album in one file, chapters) after `edit`: each
 * where its sound now is. A title cut away entirely drops out; one that
 * begins in what is gone begins where the cut is. The first begins at 0.
 */
export function startsAfterTrim<T extends { startSec: number }>(starts: readonly T[], edit: TrimEdit): T[] {
  const total = keptSec(edit);
  const out: T[] = [];
  for (const s of starts) {
    const at = timeAfterEdit(edit, s.startSec);
    if (at >= total - SAME_START_SEC) continue;
    const last = out[out.length - 1];
    // The one before was cut away: this one begins in its place.
    if (last && at - last.startSec < SAME_START_SEC) out[out.length - 1] = { ...s, startSec: last.startSec };
    else out.push({ ...s, startSec: at });
  }
  if (out.length) out[0] = { ...out[0], startSec: 0 };
  return out;
}

/** The album cuts of a file after `edit`; none when fewer than two tracks are left. */
export function albumCutsAfterTrim(cuts: AlbumCuts | undefined, edit: TrimEdit): AlbumCuts | undefined {
  if (!cuts) return undefined;
  const tracks = startsAfterTrim(cuts.tracks, edit);
  return tracks.length > 1 ? { ...cuts, tracks } : undefined;
}

/** What the title knows about the cut file: its new playing time, its chapters moved. */
export function infoAfterTrim(info: TrackInfo | undefined, edit: TrimEdit, durationSec: number): TrackInfo {
  const chapters = info?.chapters ? startsAfterTrim(info.chapters, edit) : undefined;
  return { ...info, durationSec, chapters: chapters && chapters.length > 1 ? chapters : undefined };
}

/** The title with the cut file in place of the picked one (`original`: the title as it was picked, maybe cut before). */
export function trimmedTrack(t: DraftTrack, edit: TrimEdit, cut: { source: DraftTrack['source']; info?: TrackInfo }): DraftTrack {
  const from = t.trimmed ?? { source: t.source, info: t.info, albumCuts: t.albumCuts, edit };
  return {
    ...t,
    source: cut.source,
    info: cut.info,
    albumCuts: albumCutsAfterTrim(from.albumCuts, edit),
    trimmed: { source: from.source, info: from.info, albumCuts: from.albumCuts, edit },
  };
}

/** The title as it was picked again („Schnitt zurücknehmen“). */
export function untrimmedTrack(t: DraftTrack): DraftTrack {
  if (!t.trimmed) return t;
  const { trimmed, ...rest } = t;
  return { ...rest, source: trimmed.source, info: trimmed.info, albumCuts: trimmed.albumCuts };
}
