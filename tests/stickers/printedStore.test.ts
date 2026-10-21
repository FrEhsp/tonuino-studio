/**
 * "Noch nie gedruckt" on the sticker page (audit 0.4 #11): which folders of
 * a card have no printed sticker yet, remembered on this computer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const db = new Map<string, unknown>();

vi.mock('../../src/platform/web/idb', () => ({
  kv: {
    get: async (key: string) => db.get(key),
    set: async (key: string, value: unknown) => void db.set(key, value),
  },
}));

/** A fresh page load: new modules, the same store. */
async function load() {
  vi.resetModules();
  const store = await import('../../src/features/stickers/printedStore');
  await store.loadPrinted();
  return store;
}

const folders = [
  { folder: 1, title: 'Konzert am Herd' },
  { folder: 2, title: 'Unter meinem Bett 7' },
  { folder: 45, title: 'Der Räuber Hotzenplotz' },
];

afterEach(() => db.clear());

describe('folders never printed', () => {
  it('offers nothing before anything of the card was printed: that would be a second "Alle"', async () => {
    const s = await load();
    expect(s.neverPrinted(s.printedRecord.value, 'karte-a', folders)).toBeNull();
    expect(s.neverPrinted(s.printedRecord.value, undefined, folders)).toBeNull();
  });

  it('names the folders without a printed sticker, also after a reload', async () => {
    const first = await load();
    first.markPrinted('karte-a', folders.slice(0, 2));
    await new Promise((r) => setTimeout(r, 0));
    const again = await load();
    expect(again.neverPrinted(again.printedRecord.value, 'karte-a', folders)).toEqual([folders[2]]);
    // Another card has its own record.
    expect(again.neverPrinted(again.printedRecord.value, 'karte-b', folders)).toBeNull();
  });

  it('counts a folder with other content under its number as never printed', async () => {
    const s = await load();
    s.markPrinted('karte-a', folders);
    expect(s.neverPrinted(s.printedRecord.value, 'karte-a', folders)).toEqual([]);
    const changed = [...folders.slice(0, 2), { folder: 45, title: 'Die kleine Hexe' }];
    expect(s.neverPrinted(s.printedRecord.value, 'karte-a', changed)).toEqual([changed[2]]);
  });

  it('leaves out special cards and own pictures, which have no folder', async () => {
    const s = await load();
    s.markPrinted('karte-a', [{ title: 'Schlummerkarte' }, folders[0]]);
    expect(s.printedRecord.value).toEqual({ 'karte-a': { '1': 'Konzert am Herd' } });
    expect(s.neverPrinted(s.printedRecord.value, 'karte-a', [{ title: 'Schlummerkarte' }, ...folders])).toEqual(folders.slice(1));
  });
});
