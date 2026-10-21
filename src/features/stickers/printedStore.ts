/**
 * Which folders of a card already have a printed sticker, kept on this
 * computer, so "Noch nie gedruckt" picks the new ones among 80 folders
 * (audit 0.4 #11). Per card (Catalog.id) the title each folder had when
 * printed: a folder that got other content under its number since counts
 * as never printed. Not on the SD card: printing is no change to the card,
 * and in Firefox or Safari it would need a Paket for nothing.
 */
import { signal } from '@preact/signals';
import { kv } from '../../platform/web/idb';

const KEY = 'sticker-printed';

/** Card id → folder number → the title printed for it. */
export type PrintedRecord = Record<string, Record<string, string>>;

export const printedRecord = signal<PrintedRecord>({});

let loading: Promise<void> | null = null;
let writing: Promise<void> = Promise.resolve();

/** Reads the record of earlier prints once per page load. */
export function loadPrinted(): Promise<void> {
  loading ??= kv
    .get<PrintedRecord>(KEY)
    .then((stored) => {
      if (stored) printedRecord.value = withPrinted(stored, printedRecord.value);
    })
    // Without the store every folder counts as never printed, nothing worse.
    .catch(() => undefined);
  return loading;
}

/** The folders just printed or saved for printing, with the titles they had. */
export function markPrinted(cardId: string | undefined, folders: readonly { folder?: number; title: string }[]): void {
  if (!cardId) return;
  const now: PrintedRecord = { [cardId]: {} };
  for (const f of folders) if (f.folder !== undefined) now[cardId][String(f.folder)] = f.title;
  if (!Object.keys(now[cardId]).length) return;
  printedRecord.value = withPrinted(printedRecord.value, now);
  const record = printedRecord.value;
  writing = writing.then(() => kv.set(KEY, record)).catch(() => undefined);
}

/** `a` with the folders of `b` added (b wins). */
export function withPrinted(a: PrintedRecord, b: PrintedRecord): PrintedRecord {
  const out: PrintedRecord = { ...a };
  for (const [id, folders] of Object.entries(b)) out[id] = { ...out[id], ...folders };
  return out;
}

/**
 * Of `folders`, those never printed with their current title. Null when
 * nothing of this card was ever printed here: then "Noch nie gedruckt" would
 * only be a second "Alle".
 */
export function neverPrinted<T extends { folder?: number; title: string }>(record: PrintedRecord, cardId: string | undefined, folders: readonly T[]): T[] | null {
  const done = cardId ? record[cardId] : undefined;
  if (!done || !Object.keys(done).length) return null;
  return folders.filter((f) => f.folder !== undefined && done[String(f.folder)] !== f.title);
}
