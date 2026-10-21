import { effect, untracked } from '@preact/signals';
import type { Catalog } from '../core/tonuino/catalog';
import { memoryCatalog } from '../core/tonuino/remember';
import { folderName } from '../core/tonuino/sd';
import { applyLooks, hasWaiting, parseWaiting, waitingCoverEntry, withWaiting, type WaitingChanges, type WaitingLook } from '../core/tonuino/waiting';
import { kv } from '../platform/web/idb';
import { toast } from '../ui/components/Toast';
import { card, NEEDS_CARD, remembered, setCovers, shownMemory, updateCatalog, type CardState, type CoverChange, type RememberedView } from './state';

/**
 * Sticker changes to the remembered box, made without its SD card (the
 * rules are in core/tonuino/waiting.ts): kept on this device next to the
 * memory, shown at once, and put onto the card when it is open again.
 */

/** Kept per box, under the id of its catalog. */
const WAITING_PREFIX = 'box-memory-waiting:';

/** „Gemerkte Box vergessen“: what waited for its card goes too. */
export function forgetWaiting(id: string): Promise<void> {
  return kv.delete(WAITING_PREFIX + id);
}

export async function readWaiting(id: string): Promise<WaitingChanges> {
  return parseWaiting(await kv.get(WAITING_PREFIX + id).catch(() => undefined));
}

/** The remembered view with the changes waiting for the card: its catalog, and their covers among its pictures. */
export function withWaitingShown(view: RememberedView, w: WaitingChanges, base: Catalog = view.catalog): RememberedView {
  const coverUrls = new Map(view.coverUrls);
  for (const [entry, url] of view.coverUrls) {
    if (!entry.startsWith('wartet-')) continue;
    URL.revokeObjectURL(url);
    coverUrls.delete(entry);
  }
  for (const [name, c] of Object.entries(w.covers)) {
    if (c.data) coverUrls.set(waitingCoverEntry(name, c.mimeType), URL.createObjectURL(new Blob([c.data as BlobPart], { type: c.mimeType ?? 'image/jpeg' })));
  }
  return { ...view, catalog: withWaiting(base, w), coverUrls };
}

/** Cards whose waiting changes were looked for since they opened (volume and catalog). */
const broughtTo = new Set<string>();

async function changeWaiting(change: (w: WaitingChanges, at: number) => void): Promise<void> {
  const view = shownMemory.peek();
  if (!view) throw new Error(NEEDS_CARD);
  const id = view.catalog.id;
  const w = await readWaiting(id);
  change(w, Date.now());
  try {
    await kv.set(WAITING_PREFIX + id, w);
  } catch {
    throw new Error('Ich konnte die Änderung auf diesem Gerät nicht speichern. Vielleicht ist der Speicher voll, oder der Browser erlaubt es in diesem Fenster nicht.');
  }
  broughtTo.clear();
  const now = remembered.peek();
  const base = now?.memory === view.memory ? memoryCatalog(now.memory) : null;
  if (now && base) remembered.value = withWaitingShown(now, w, base);
}

/** "Sticker anpassen" without the card: shown at once, onto the card when it is open again. */
export function changeLookWithoutCard(target: { folder: number } | { extra: string }, look: Omit<WaitingLook, 'at'>): Promise<void> {
  return changeWaiting((w, at) => {
    if ('folder' in target) w.looks[folderName(target.folder)] = { ...look, at };
    else w.extras[target.extra] = { ...look, at };
  });
}

/** New covers (or none) without the card, as setCovers. Returns the folders changed. */
export async function setCoversWithoutCard(changes: readonly CoverChange[], opts: { onlyMissing?: boolean } = {}): Promise<number[]> {
  const view = shownMemory.peek();
  const todo = opts.onlyMissing ? changes.filter((ch) => !view?.catalog.folders[folderName(ch.folder)]?.cover) : changes;
  if (!todo.length) return [];
  await changeWaiting((w, at) => {
    for (const ch of todo) w.covers[folderName(ch.folder)] = { data: ch.data, mimeType: ch.mimeType, source: ch.source, orientation: ch.orientation, at };
  });
  return todo.map((ch) => ch.folder);
}

/** Covers for the open card, or for the remembered box shown in its place. */
export function setCoversAnywhere(changes: readonly CoverChange[], opts: { onlyMissing?: boolean } = {}): Promise<number[]> {
  return card.peek() ? setCovers(changes, opts) : setCoversWithoutCard(changes, opts);
}

/**
 * The box's card is open again: what was changed without it goes onto it,
 * covers first. A folder changed on the card after the change keeps what
 * the card says. Kept on this device until the card has it.
 */
async function bringWaiting(s: CardState & { catalog: Catalog }): Promise<void> {
  const id = s.catalog.id;
  const w = await readWaiting(id);
  if (!hasWaiting(w)) return;
  const before = s.catalog;
  const since = (name: string) => before.folders[name]?.updatedAt ?? 0;
  const covers: CoverChange[] = Object.entries(w.covers)
    .filter(([name, c]) => before.folders[name] && since(name) <= c.at)
    .map(([name, c]) => ({ folder: Number(name), data: c.data, mimeType: c.mimeType, source: c.source, orientation: c.orientation }));
  if (covers.length) await setCovers(covers);
  let looks = 0;
  await updateCatalog((c) => {
    looks = applyLooks(c, w, since);
  });
  await kv.delete(WAITING_PREFIX + id);
  const n = covers.length + looks;
  if (n) toast.info('Auf die SD-Karte übernommen', n === 1 ? 'Die Sticker-Änderung von vorhin ist jetzt auf der Karte.' : `${n} Sticker-Änderungen von vorhin sind jetzt auf der Karte.`);
}

if (typeof window !== 'undefined') {
  effect(() => {
    const s = card.value;
    if (!s || s.status !== 'ready' || !s.catalog || !s.catalogOnCard || s.writeDenied) return;
    const key = `${s.volume.id}\n${s.catalog.id}`;
    if (broughtTo.has(key)) return;
    broughtTo.add(key);
    const open = s as CardState & { catalog: Catalog };
    untracked(() => void bringWaiting(open).catch((e) => toast.error('Sticker-Änderungen noch nicht auf der Karte', e instanceof Error ? e.message : String(e))));
  });
}
