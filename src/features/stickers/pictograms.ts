/**
 * ARASAAC pictograms chosen for Bildkarten (core/stickers/arasaac.ts), kept on
 * this device: the picture is loaded once, when it is chosen, and stored in
 * IndexedDB; the card's sticker only keeps its number (StickerTweaks.pictogram).
 * Printing and previews never go online: a pictogram missing here (another
 * computer, cleared browser data) shows the card's own motif until it is
 * chosen again. So this works for a remembered box without its SD card too.
 */
import { signal } from '@preact/signals';
import { downloadPictogram, isPictogramId, searchPictograms, type PictogramHit } from '../../core/stickers/arasaac';
import { loadImageBitmap, type DrawableImage, type FetchLike } from '../../core/stickers/image';
import { kv } from '../../platform/web/idb';

const PREFIX = 'arasaac|';

/** Counts pictograms stored in this session, so previews drawn without one draw again. */
export const pictogramRev = signal(0);

const decoded = new Map<number, Promise<DrawableImage | null>>();
/** Stored here, by id; filled as they are looked up. */
const known = new Map<number, boolean>();

export function pictogramKey(id: number): string {
  return PREFIX + id;
}

/** Searches ARASAAC: the only time the app asks it anything (besides loading the one chosen). */
export function findPictograms(query: string, fetchFn: FetchLike, signal?: AbortSignal): Promise<PictogramHit[]> {
  return searchPictograms(query, { fetchFn, signal });
}

/** Loads the chosen pictogram and keeps it on this device. Already here: nothing is loaded. */
export async function keepPictogram(id: number, fetchFn: FetchLike, signal?: AbortSignal): Promise<void> {
  if (await hasPictogram(id)) return;
  const blob = await downloadPictogram(id, { fetchFn, signal });
  await kv.set(pictogramKey(id), blob);
  known.set(id, true);
  decoded.delete(id);
  pictogramRev.value++;
}

/** True when the pictogram is stored on this device. */
export async function hasPictogram(id: number): Promise<boolean> {
  if (!isPictogramId(id)) return false;
  const k = known.get(id);
  if (k !== undefined) return k;
  const blob = await storedBlob(id);
  known.set(id, !!blob);
  return !!blob;
}

/** The stored pictogram, synchronously known: undefined while not looked up yet. */
export function pictogramKnown(id: number): boolean | undefined {
  return known.get(id);
}

async function storedBlob(id: number): Promise<Blob | undefined> {
  const b = await kv.get<Blob>(pictogramKey(id)).catch(() => undefined);
  return b instanceof Blob && b.size > 0 ? b : undefined;
}

/** The stored pictogram as a picture to draw; null when it is not on this device (never fetched here). */
export function pictogramImage(id: number): Promise<DrawableImage | null> {
  if (!isPictogramId(id)) return Promise.resolve(null);
  let p = decoded.get(id);
  if (!p) {
    p = storedBlob(id)
      .then((blob) => {
        known.set(id, !!blob);
        return blob ? loadImageBitmap(blob) : null;
      })
      .catch(() => null);
    // A miss is looked up again next time: it may be chosen (stored) meanwhile.
    void p.then((img) => img || decoded.delete(id));
    decoded.set(id, p);
  }
  return p;
}
