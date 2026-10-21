/**
 * Own pictures for stickers (no SD card) kept on this computer, with their
 * title, colour, section and orientation, so they are still there after the
 * page is closed or reloaded. The list goes under one key, every picture
 * under its own: a picture is written once, a new colour only rewrites the
 * small list.
 */
import { effect } from '@preact/signals';
import { kv } from '../../platform/web/idb';
import { loosePictureId, looseStickers, type LooseSticker } from './content';

const LIST_KEY = 'sticker-loose';
const PICTURE_PREFIX = 'sticker-loose:';

type StoredLoose = Omit<LooseSticker, 'blob' | 'url'>;

interface StoredPicture {
  data: ArrayBuffer;
  type: string;
}

/** Picture ids that are in the store. */
const stored = new Set<string>();
let restoring: Promise<void> | null = null;
let writing: Promise<void> = Promise.resolve();

/**
 * Brings back the own pictures of the last visit (before any added since),
 * then keeps the store up to date with every change. Runs once per page load.
 */
export function restoreLooseStickers(): Promise<void> {
  restoring ??= (async () => {
    const back: LooseSticker[] = [];
    try {
      for (const s of (await kv.get<StoredLoose[]>(LIST_KEY)) ?? []) {
        const id = loosePictureId(s);
        const picture = await kv.get<StoredPicture>(PICTURE_PREFIX + id);
        if (!picture) continue;
        const blob = new Blob([picture.data], { type: picture.type });
        stored.add(id);
        back.push({ ...s, blob, url: URL.createObjectURL(blob) });
      }
      // Pictures no list names, e.g. when the page closed while one was written.
      for (const key of await kv.keys(PICTURE_PREFIX)) {
        if (!stored.has(key.slice(PICTURE_PREFIX.length))) void kv.delete(key).catch(() => undefined);
      }
    } catch {
      // Without the store the page starts without own pictures, as it did before.
    }
    const now = new Set(looseStickers.value.map((l) => l.id));
    if (back.length) looseStickers.value = [...back.filter((l) => !now.has(l.id)), ...looseStickers.value];
    effect(() => {
      const list = looseStickers.value;
      writing = writing.then(() => save(list)).catch(() => undefined);
    });
  })();
  return restoring;
}

/** Resolves once the store holds the latest change. */
export function looseStickersSaved(): Promise<void> {
  return (restoring ?? Promise.resolve()).then(() => writing);
}

async function save(list: readonly LooseSticker[]): Promise<void> {
  for (const l of list) {
    const id = loosePictureId(l);
    if (stored.has(id)) continue;
    const picture: StoredPicture = { data: await l.blob.arrayBuffer(), type: l.blob.type };
    await kv.set(PICTURE_PREFIX + id, picture);
    stored.add(id);
  }
  await kv.set(LIST_KEY, list.map(meta));
  const keep = new Set(list.map(loosePictureId));
  for (const id of [...stored]) {
    if (keep.has(id)) continue;
    await kv.delete(PICTURE_PREFIX + id);
    stored.delete(id);
  }
}

function meta(l: LooseSticker): StoredLoose {
  return { id: l.id, title: l.title, number: l.number, file: l.file, rev: l.rev, color: l.color, focusX: l.focusX, focusY: l.focusY, zoom: l.zoom, orientation: l.orientation, pictogram: l.pictogram, off: l.off };
}
