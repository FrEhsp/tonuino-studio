import { computed, effect, signal, untracked } from '@preact/signals';
import { coverMimeType } from '../core/tonuino/covers';
import {
  buildBoxMemory,
  coverStamps,
  memoryBytes,
  memoryCatalog,
  memoryScan,
  memorySummary,
  mergeThumbs,
  parseBoxMemory,
  sameThumbs,
  thumbPlan,
  THUMB_PX,
  type BoxMemory,
  type MemorySummary,
  type MemoryThumbs,
} from '../core/tonuino/remember';
import { crc32 } from '../core/zip/crc32';
import { kv } from '../platform/web/idb';
import { normalizeCover } from '../ui/image';
import { quietMoment } from '../ui/quiet';
import { packageState } from './pending';
import { card, remembered, selection, settings, transferredToCard, updateSettings, type CardState, type RememberedView } from './state';
import { forgetWaiting, readWaiting, withWaitingShown } from './waiting';
import { writeGuard } from './writeguard';

/**
 * „Box merken“: with the switch on, the app keeps what is on each box it
 * opens on this device (IndexedDB, never sent anywhere; the logic is in
 * src/core/tonuino/remember.ts). Without the card, "Meine Box" offers the
 * remembered box read only, and "Karten beschreiben" and "Sticker drucken"
 * work with it as with the card (state.ts: shownMemory, catalog, boxScan).
 *
 * Nothing here runs at the start: the list is read when a page without a
 * card asks for it, a memory only when someone opens it, and a refresh
 * waits for a quiet moment after the open card changed.
 */

const MEMORY_PREFIX = 'box-memory:';
const THUMBS_PREFIX = 'box-memory-thumbs:';
/** The question on "Meine Box" was answered (yes or no): it does not come again. */
const ASKED_KEY = 'tonuino-studio:remember-asked';
/** After the last change of the open card, before the memory follows it. */
const REFRESH_AFTER_MS = 1500;

function readAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    return false;
  }
}

const asked = signal(readAsked());

/**
 * The question comes once, right after the first transfer to a card, not on
 * every look at the shelf (audit 0.4 #1): shown once, it never comes again,
 * answered or not. In the session it was shown it stays until answered.
 */
const OFFERED_KEY = 'tonuino-studio:remember-offered';

function readOffered(): boolean {
  try {
    return localStorage.getItem(OFFERED_KEY) === '1';
  } catch {
    return false;
  }
}

const offeredBefore = readOffered();
/** The question is on screen: it does not come again after this session. */
export function markOffered(): void {
  try {
    localStorage.setItem(OFFERED_KEY, '1');
  } catch {
    // Not kept: the question may come once more after the next transfer.
  }
}
/** Measuring mode (src/app/measure.ts): its made-up box is neither offered nor remembered. */
const held = signal(false);

export function holdMemories(): void {
  held.value = true;
}

/** Remembered boxes, newest first; null until a page asked for them (loadMemories). */
export const memories = signal<(MemorySummary & { bytes: number })[] | null>(null);

/** Whether the open card can be remembered: set up by the app, read completely, nothing waiting for it. */
function rememberable(s: CardState | null): s is CardState & Required<Pick<CardState, 'scan' | 'catalog'>> {
  if (!s || s.status !== 'ready' || !s.catalogOnCard || !s.catalog || !s.scan) return false;
  // Firefox, Safari: only what is on the card, not what waits for it in the next Paket.
  return s.volume.access !== 'snapshot' || packageState.value.kind === 'clean';
}

/** The quiet line on "Meine Box" after the first transfer: „Box auf diesem Gerät merken?“, as the setting says. */
export const offerRemember = computed(() => !held.value && !asked.value && !offeredBefore && transferredToCard.value && !settings.value.rememberBoxes && rememberable(card.value));

function setAsked(): void {
  asked.value = true;
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // Not kept: the question may come once more after a restart.
  }
}

/** The switch in the settings: also answers the question on "Meine Box". On, the open box is remembered soon (see the effect below). */
export function setRemembering(on: boolean): void {
  setAsked();
  updateSettings({ rememberBoxes: on });
}

/** The answer to the question on "Meine Box". Yes remembers the open box right away. */
export async function answerOffer(yes: boolean): Promise<boolean> {
  setAsked();
  if (!yes) return false;
  updateSettings({ rememberBoxes: true });
  return rememberNow();
}

/* ------------------------------------------------------------------ reading */

let loading: Promise<void> | null = null;

/** Reads the list of remembered boxes (once; refreshes keep it up to date). */
export function loadMemories(): Promise<void> {
  loading ??= (async () => {
    const list: (MemorySummary & { bytes: number })[] = [];
    // Only the small records: the thumbnails stay unread until a box is opened.
    for (const key of await kv.keys(MEMORY_PREFIX)) {
      const m = parseBoxMemory(await kv.get(key));
      if (m) list.push({ ...memorySummary(m), bytes: memoryBytes(m) });
    }
    memories.value = list.sort((a, b) => b.at - a.at);
  })().catch(() => {
    memories.value = [];
  });
  return loading;
}

function noteInList(m: BoxMemory, thumbs: MemoryThumbs): void {
  const list = memories.peek();
  if (!list) return;
  const item = { ...memorySummary(m), bytes: memoryBytes(m, thumbs) };
  memories.value = [item, ...list.filter((x) => x.id !== m.id)].sort((a, b) => b.at - a.at);
}

function revoke(view: RememberedView | null): void {
  for (const url of view?.coverUrls.values() ?? []) URL.revokeObjectURL(url);
}

/** Shows a remembered box in place of the card: on "Meine Box", "Karten beschreiben" and "Sticker drucken". */
export async function showMemory(id: string): Promise<void> {
  const m = parseBoxMemory(await kv.get(MEMORY_PREFIX + id));
  const catalog = m && memoryCatalog(m);
  if (!m || !catalog) throw new Error('Die gemerkte Box ließ sich nicht lesen. Stecke die SD-Karte ein, dann merke ich sie mir neu.');
  const thumbs = (await kv.get<MemoryThumbs>(THUMBS_PREFIX + id)) ?? {};
  const coverUrls = new Map<string, string>();
  for (const t of Object.values(thumbs)) {
    if (t?.data && t.stamp?.entry) coverUrls.set(t.stamp.entry, URL.createObjectURL(new Blob([t.data as BlobPart], { type: t.type || 'image/jpeg' })));
  }
  // A card opened meanwhile wins.
  if (card.peek()) {
    for (const url of coverUrls.values()) URL.revokeObjectURL(url);
    return;
  }
  const waiting = await readWaiting(id);
  if (card.peek()) {
    for (const url of coverUrls.values()) URL.revokeObjectURL(url);
    return;
  }
  revoke(remembered.peek());
  remembered.value = withWaitingShown({ memory: m, scan: memoryScan(m, coverUrls.size > 0), catalog, coverUrls }, waiting);
  selection.value = new Set();
}

/** Back to the page without a card. */
export function closeMemory(): void {
  const view = remembered.peek();
  if (!view) return;
  revoke(view);
  remembered.value = null;
  selection.value = new Set();
}

/** „Gemerkte Box vergessen“: gone from this device. */
export async function forgetMemory(id: string): Promise<void> {
  if (remembered.peek()?.memory.id === id) closeMemory();
  await kv.delete(MEMORY_PREFIX + id);
  await kv.delete(THUMBS_PREFIX + id);
  await forgetWaiting(id);
  const list = memories.peek();
  if (list) memories.value = list.filter((x) => x.id !== id);
}

/* ------------------------------------------------------------------ remembering */

/** CRC-32 of the covers, by their bytes: the card's cover map keeps them until a cover changes. */
const crcs = new WeakMap<Uint8Array, number>();
const crcOf = (bytes: Uint8Array) => {
  let c = crcs.get(bytes);
  if (c === undefined) crcs.set(bytes, (c = crc32(bytes)));
  return c;
};

/** The refresh going on: the next one waits for it, so two never write over each other. */
let running: Promise<boolean> | null = null;

/**
 * Takes the open card into its memory. Thumbnails are made only for covers
 * that are new or changed (thumbPlan), the rest stays. False when there is
 * nothing to remember (no card set up by the app, or a write going on).
 */
async function refresh(): Promise<boolean> {
  const s = card.peek();
  if (held.peek() || !rememberable(s)) return false;
  const label = s.volume.label;
  const catalog = s.catalog;
  const id = catalog.id;
  const before = parseBoxMemory(await kv.get(MEMORY_PREFIX + id));
  const have = await kv.get<MemoryThumbs>(THUMBS_PREFIX + id);
  const want = coverStamps(catalog, s.covers, crcOf);
  const plan = thumbPlan(have, want);
  const made: MemoryThumbs = {};
  for (const name of plan.make) {
    const stamp = want[name];
    const bytes = s.covers.get(stamp.entry);
    if (!bytes) continue;
    await quietMoment();
    try {
      const small = await normalizeCover(bytes, coverMimeType(stamp.entry), THUMB_PX);
      made[name] = { stamp, type: small.mimeType, data: small.data, px: THUMB_PX };
    } catch {
      // A picture the browser cannot open: the shelf draws the folder's sticker instead.
    }
  }
  // Kept even when the card went meanwhile: it is what was on it. A change made meanwhile comes with the next refresh.
  const thumbs = mergeThumbs(have, made, want);
  const memory = buildBoxMemory(s.scan, catalog, { label, at: Date.now(), before, thumbs });
  const entries: [string, unknown][] = [[MEMORY_PREFIX + id, memory]];
  if (!sameThumbs(have, thumbs)) entries.push([THUMBS_PREFIX + id, thumbs]);
  try {
    await kv.setMany(entries);
  } catch {
    throw new Error('Ich konnte die Box auf diesem Gerät nicht speichern. Vielleicht ist der Speicher voll, oder der Browser erlaubt es in diesem Fenster nicht.');
  }
  noteInList(memory, thumbs);
  return true;
}

function refreshOnce(): Promise<boolean> {
  const run = (running ?? Promise.resolve(false)).then(() => refresh());
  running = run.catch(() => false);
  return run;
}

let timer = 0;

/** "Ja" on "Meine Box", or the switch turned on: the open box, now. */
export function rememberNow(): Promise<boolean> {
  clearTimeout(timer);
  return refreshOnce();
}

if (typeof window !== 'undefined') {
  // With the switch on, the memory follows the open card: when it opens and after each change.
  effect(() => {
    const s = card.value;
    const on = settings.value.rememberBoxes;
    if (!on || held.value || !rememberable(s)) return;
    untracked(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Not in the middle of a write: the card is read again after it anyway.
        if (writeGuard.running.peek().some((k) => k !== 'selection')) return;
        void refreshOnce().catch(() => undefined);
      }, REFRESH_AFTER_MS);
    });
  });
  // A card opened: it shows itself, not the memory.
  effect(() => {
    if (card.value) untracked(closeMemory);
  });
}
