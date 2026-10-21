/**
 * The same sound under two names: broken downloads put one chapter into
 * several files, each with its own title (Frank, 13.10.2026: in „Mein
 * verhextes Halloween“ four pairs of files held the very same sound). The
 * tags differ, so the files differ; the sound between the tags does not.
 *
 * A fingerprint is the length of the part between the tags and a few small
 * pieces of it: cheap to read, and two different recordings practically
 * never agree in all of them.
 */
import type { ByteSource } from '../../platform/types';

const PIECE = 4096;
const AT = [0.2, 0.5, 0.8];
/** Shorter files are jingles and silence: those may well be the same on purpose. */
const MIN_BYTES = 256 * 1024;

/** Where the sound starts: after an ID3v2 tag, when there is one. */
function id3v2Size(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const footer = head[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function fnv(hash: number, bytes: Uint8Array): number {
  let h = hash;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h;
}

/** Undefined for short files and files that cannot be read. */
export async function soundFingerprint(source: ByteSource): Promise<string | undefined> {
  if (source.size < MIN_BYTES) return undefined;
  try {
    const start = id3v2Size(await source.read(0, 10));
    const tail = await source.read(source.size - 128, 128);
    const end = tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47 ? source.size - 128 : source.size;
    const length = end - start;
    if (length < MIN_BYTES) return undefined;
    let h = 0x811c9dc5;
    for (const at of AT) h = fnv(h, await source.read(start + Math.floor((length - PIECE) * at), PIECE));
    return `${length}:${h.toString(36)}`;
  } catch {
    return undefined;
  }
}

/** Groups of two or more items with the same fingerprint, in their order. */
export function sameSoundGroups<T>(items: readonly T[], print: (item: T) => string | undefined): T[][] {
  const by = new Map<string, T[]>();
  for (const item of items) {
    const p = print(item);
    if (!p) continue;
    const group = by.get(p);
    if (group) group.push(item);
    else by.set(p, [item]);
  }
  return [...by.values()].filter((g) => g.length > 1);
}
