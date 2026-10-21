/**
 * What "Hinzufügen" knows about whole albums in one file (TODO 0.4 #52),
 * kept beside the albums, not in them: the cue sheet found next to a file,
 * the measurement of a file whose cuts were looked at (so the transfer does
 * not decode it again), and the answer of the shops per file.
 */
import { signal } from '@preact/signals';
import { cueTracksFor, decodeCueText, parseCue, type CueSheet, type CueTrack } from '../../core/library/albumcut';
import type { LookupAlbum } from '../../core/library/tracklookup';
import type { AudioAnalysis, ByteSource } from '../../platform/types';

/** Cue sheets bigger than this are no cue sheets. */
const MAX_CUE_BYTES = 256 * 1024;

const cues = new WeakMap<ByteSource, { sheet: CueSheet; tracks: CueTrack[] }>();
const measured = new WeakMap<ByteSource, AudioAnalysis>();

/** Reads a picked .cue file; null when it is none or cannot be read. */
export async function readCue(source: ByteSource): Promise<CueSheet | null> {
  if (source.size <= 0 || source.size > MAX_CUE_BYTES) return null;
  try {
    return parseCue(decodeCueText(await source.read(0, source.size)));
  } catch {
    return null;
  }
}

/**
 * Gives each audio file the cue sheet beside it that describes it: one in
 * the same folder that names it, or the only one in a folder with only one
 * audio file. `dirOf` tells the folder of a file as the add page groups them.
 */
export function matchCues(sheets: { source: ByteSource; sheet: CueSheet }[], audio: { source: ByteSource; durationSec?: number }[], dirOf: (s: ByteSource) => string): void {
  if (!sheets.length) return;
  for (const a of audio) {
    const dir = dirOf(a.source);
    const here = sheets.filter((c) => dirOf(c.source) === dir);
    const alone = here.length === 1 && audio.filter((x) => dirOf(x.source) === dir).length === 1;
    for (const c of here) {
      const tracks = cueTracksFor(c.sheet, a.source.name, { alone, durationSec: a.durationSec });
      if (tracks) {
        cues.set(a.source, { sheet: c.sheet, tracks });
        break;
      }
    }
  }
}

/** The cue sheet's tracks for this file, when one came with it. */
export function cueFor(source: ByteSource): { sheet: CueSheet; tracks: CueTrack[] } | undefined {
  return cues.get(source);
}

export function rememberMeasured(source: ByteSource, analysis: AudioAnalysis): void {
  measured.set(source, analysis);
}

/** The measurement of the review, for prepareAlbum (ProcessOptions.analysisOf). */
export function measuredOf(source: ByteSource): AudioAnalysis | undefined {
  return measured.get(source);
}

/**
 * The shops' answer for a file: searching, found, nothing found (`query`:
 * what was looked for; while searching: what was typed), or not reachable. `tried`: the cover chosen in an
 * online search whose album was looked at already.
 */
export type ShopAnswer = { state: 'searching'; query?: string } | { state: 'found'; album: LookupAlbum } | { state: 'none'; query: string; tried?: string } | { state: 'failed'; tried?: string };

/** Per file, so a file looked up once is not looked up again when its album card is drawn anew. */
export const shopAnswers = signal<ReadonlyMap<ByteSource, ShopAnswer>>(new Map());

export function setShopAnswer(source: ByteSource, answer: ShopAnswer | undefined): void {
  const next = new Map(shopAnswers.value);
  if (answer) next.set(source, answer);
  else next.delete(source);
  shopAnswers.value = next;
}
