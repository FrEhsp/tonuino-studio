/**
 * What "Anhören" needs to know about an MP3 before the browser plays it:
 * the playing time as the list shows it (mp3DurationSec), and, for VBR
 * files without a Xing frame, a copy the browser can seek in.
 *
 * Browsers guess the length of such a file from its first frame (a quiet
 * intro at 32 kbit/s makes 2 minutes look like 7) and jump to a byte
 * position estimated from that guess: the bar shows another length than the
 * list, and a jump lands somewhere else than the bar says. A Xing frame with
 * a table of contents in front of the audio tells them both. The copy is a
 * Blob of slices of the original plus that one frame: nothing is copied.
 */
import type { ByteSource } from '../../platform/types';
import { buildXingFrame } from './mp3cut';
import { mp3DurationOf, mp3DurationSec, probeMp3, quickDuration, scanMp3, type Mp3Index } from './mp3frames';

export interface PlaybackInfo {
  /** The playing time, the same the track list shows for the same `tagged` value. */
  durationSec?: number;
  /** For VBR files without a Xing frame: the frame index, to build a copy with a table of contents (withSeekTable). */
  index?: Mp3Index;
}

/**
 * Length and, when needed, the frame index of an MP3. `tagged` is the length
 * the list shows (catalog or tags): kept when the file confirms it, as in
 * mp3DurationSec. Reads the whole file only for VBR files without a Xing
 * frame. Never throws: what cannot be read stays as the list has it.
 */
export async function mp3PlaybackInfo(source: ByteSource, tagged: number | undefined, signal?: AbortSignal): Promise<PlaybackInfo> {
  try {
    const probe = await probeMp3(source, signal, 16 << 10);
    const quick = await quickDuration(source, probe, tagged, signal);
    if (quick !== undefined) return { durationSec: quick };
    // A joined file whose Info frame counts only its first part: the frames tell the time, the browser copes with the rest.
    if (probe.xing?.frames) return { durationSec: await mp3DurationSec(source, tagged, signal) };
    const index = await scanMp3(source, { signal });
    return { durationSec: mp3DurationOf(index, tagged), index: index.cbr ? undefined : index };
  } catch {
    return { durationSec: tagged };
  }
}

/** Offsets (relative to the first audio frame) of the frames at 0 %, 1 %, … 99 % of the playing time. */
export function tocOffsets(index: Pick<Mp3Index, 'frameOffsets' | 'frameCount'>): number[] {
  const first = index.frameOffsets[0] ?? 0;
  const out: number[] = [];
  for (let i = 0; i < 100; i++) {
    const f = Math.min(index.frameCount - 1, Math.floor((i * index.frameCount) / 100));
    out.push((index.frameOffsets[Math.max(0, f)] ?? first) - first);
  }
  return out;
}

/** The Xing frame (with table of contents) that tells a browser where each part of the file starts. */
export function seekTableFrame(index: Mp3Index): Uint8Array {
  const first = index.frameOffsets[0] ?? index.audioStart;
  return buildXingFrame(
    { version: index.version, sampleRate: index.sampleRate, channelMode: index.channelMode },
    { kind: 'Xing', frames: index.frameCount, audioBytes: index.audioEnd - first, tocOffsets: tocOffsets(index) },
  );
}

/**
 * The file as the browser should get it: tags, a Xing frame with a table of
 * contents, then the audio frames. Slices of `blob`, nothing copied.
 */
export function withSeekTable(blob: Blob, index: Mp3Index): Blob {
  const first = index.frameOffsets[0] ?? index.audioStart;
  return new Blob([blob.slice(0, first), seekTableFrame(index) as BlobPart, blob.slice(first)], { type: 'audio/mpeg' });
}
