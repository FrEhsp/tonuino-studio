/**
 * Adding to a card read as a snapshot (Firefox, Safari): the files go into
 * the app's copy, and the folder is not rebuilt for its order, because the
 * Paket brings every folder in the order of the numbers anyway. On a card
 * the app writes to directly the order is still fixed right away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { card, platform, settings, type CardState } from '../../src/app/state';
import { scanSd } from '../../src/core/tonuino/sd';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { diffForPackage } from '../../src/core/tonuino/writeplan';
import type { PreparedAlbum, TrackJob } from '../../src/features/add/process';
import { problems, resetImport, runImport, session, shownTitle, type ImportAlbum } from '../../src/features/add/session';
import { memDir } from '../../src/platform/memory';
import { createOverlay, memoryScratch, type Overlay } from '../../src/platform/overlay';
import type { ByteSource, Dir, Platform, Volume } from '../../src/platform/types';
import { blobTree } from '../platform/blobfixtures';

vi.mock('../../src/features/add/process', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/features/add/process')>();
  return {
    ...original,
    prepareAlbum: async (album: ImportAlbum): Promise<PreparedAlbum> => {
      const jobs: TrackJob[] = album.tracks.map((t) => ({
        track: t,
        source: t.source,
        part: 0,
        parts: 1,
        title: t.title,
        estimateBytes: 10,
        work: 'copy',
        changes: [],
        worked: () => 0,
        produce: async () => new Blob([t.title]),
      }));
      return { jobs, gain: { steps: 0, convertDb: 0 }, skipped: [], rebuilt: [], close: () => undefined };
    },
  };
});

function source(name: string): ByteSource {
  return { name, size: 3, read: async () => new Uint8Array(3) };
}

/** Folder 05 as the browser listed it: 002 before 001. */
const LISTED = { '05': { '002.mp3': 'zwei', '001.mp3': 'eins' } };

async function insert(volume: Volume) {
  card.value = {
    volume,
    status: 'ready',
    scan: await scanSd(volume.root),
    info: {},
    covers: new Map(),
    coverUrls: new Map(),
    catalogOnCard: false,
  } as CardState;
}

function album(id: string, target: number, append: boolean, title: string): ImportAlbum {
  return {
    id,
    title,
    kind: 'hoerspiel',
    tracks: [{ source: source(`${title}.mp3`), title, info: { codec: 'mp3', durationSec: 60 } }],
    split: 'none',
    splitMinutes: 5,
    target,
    append,
  };
}

/** One more track for 05, and a new folder 06. */
function addToFiveAndSix() {
  session.value = { phase: 'review', albums: [album('a1', 5, true, 'Drei'), album('a2', 6, false, 'Neu')], rejected: [] };
}

async function names(root: Dir, folder: string): Promise<string[]> {
  return (await (await root.dir(folder)).list()).map((e) => e.name);
}

beforeEach(() => {
  platform.value = { audio: {}, volumes: { info: async () => ({}) } } as unknown as Platform;
  settings.value = { ...settings.value, pureNumbers: true };
  resetImport();
});

describe('adding to a card read as a snapshot', () => {
  it('leaves the order to the Paket', async () => {
    const base = blobTree(LISTED, 'TONUINO');
    const ov: Overlay = createOverlay(base, memoryScratch(), 'TONUINO');
    await insert({ id: 'snap-1', label: 'TONUINO', root: ov.root, info: {}, canEject: false, access: 'snapshot', snapshotAt: 1 });
    addToFiveAndSix();
    await runImport();
    expect(session.value.phase).toBe('done');
    expect(session.value.result).toMatchObject({ folders: [5, 6], reordered: [] });
    // Nothing moved through a helper folder: the new file was simply added.
    expect(await names(ov.root, '05')).toEqual(['002.mp3', '001.mp3', '003.mp3']);
    expect(await names(ov.root, '06')).toEqual(['001.mp3']);
    expect(ov.tree.children.map((c) => c.name)).toEqual(['05', '06']);
    expect(diffForPackage(base, ov.tree).changes.map((c) => [c.kind, c.name])).toEqual([
      ['replace', '05'],
      ['add', '06'],
    ]);
    // The base stays as the card was read.
    expect(base.children.map((c) => c.name)).toEqual(['05']);
  });

  it('still fixes the order on a card the app writes to', async () => {
    const root = memDir(LISTED);
    await insert({ id: 'sd', label: 'SD', root, info: {}, canEject: false });
    addToFiveAndSix();
    await runImport();
    expect(session.value.result).toMatchObject({ folders: [5, 6], reordered: [5] });
    expect(await names(root, '05')).toEqual(['001.mp3', '002.mp3', '003.mp3']);
  });
});

describe('two picks onto the end of one folder', () => {
  const twoOntoFive = () => {
    session.value = { phase: 'review', albums: [album('a1', 5, true, 'Drei'), album('a2', 5, true, 'Vier')], rejected: [] };
  };

  it('is no clash, and both land behind the tracks there', async () => {
    const root = memDir(LISTED);
    await insert({ id: 'sd', label: 'SD', root, info: {}, canEject: false });
    card.value = { ...card.value!, catalog: newCatalog(), catalogOnCard: true };
    twoOntoFive();
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    await runImport();
    expect(session.value.phase).toBe('done');
    expect(await names(root, '05')).toEqual(['001.mp3', '002.mp3', '003.mp3', '004.mp3']);
    // A folder without an entry keeps its number as name, as the review showed it, not "Drei".
    expect(card.value!.catalog?.folders['05']?.title).toBe('Ordner 05');
  });

  it('the review, the progress and the notes all name the folder, not the new files', async () => {
    await insert({ id: 'sd', label: 'SD', root: memDir(LISTED), info: {}, canEject: false });
    const a = album('a1', 5, true, 'Drei');
    expect(shownTitle(a)).toBe('Ordner 05');
    card.value = { ...card.value!, catalog: { folders: { '05': { title: 'Bibi Blocksberg', tracks: [], addedAt: 1, updatedAt: 1 } } } } as unknown as CardState;
    expect(shownTitle(a)).toBe('Bibi Blocksberg');
    expect(shownTitle(album('a2', 6, false, 'Neu'))).toBe('Neu');
    const titles: string[] = [];
    const stop = session.subscribe((x) => {
      if (x.write?.title && !titles.includes(x.write.title)) titles.push(x.write.title);
    });
    session.value = { phase: 'review', albums: [a], rejected: [] };
    await runImport().finally(stop);
    expect(titles).toEqual(['Bibi Blocksberg']);
  });

  it('works the same in the Paket', async () => {
    const base = blobTree(LISTED, 'TONUINO');
    const ov: Overlay = createOverlay(base, memoryScratch(), 'TONUINO');
    await insert({ id: 'snap-2', label: 'TONUINO', root: ov.root, info: {}, canEject: false, access: 'snapshot', snapshotAt: 1 });
    twoOntoFive();
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    await runImport();
    expect(session.value.phase).toBe('done');
    expect((await names(ov.root, '05')).sort()).toEqual(['001.mp3', '002.mp3', '003.mp3', '004.mp3']);
  });

  it('counts the tracks of both against the limit of the folder', async () => {
    await insert({ id: 'sd', label: 'SD', root: memDir(LISTED), info: {}, canEject: false });
    const big = (id: string, title: string): ImportAlbum => ({
      ...album(id, 5, true, title),
      tracks: Array.from({ length: 130 }, (_, i) => ({ source: source(`${title}${i}.mp3`), title: `${title} ${i}`, info: { codec: 'mp3', durationSec: 60 } })),
    });
    session.value = { phase: 'review', albums: [big('a1', 'A'), big('a2', 'B')], rejected: [] };
    expect(problems(session.value, card.value!.scan!).map((p) => [p.album, p.text])).toEqual([['a2', expect.stringMatching(/passen nur 255 Titel\. Es wären 262\./)]]);
  });

  it('still stops two new folders under one number', async () => {
    await insert({ id: 'sd', label: 'SD', root: memDir(LISTED), info: {}, canEject: false });
    session.value = { phase: 'review', albums: [album('a1', 6, false, 'Eins'), album('a2', 6, false, 'Zwei')], rejected: [] };
    expect(problems(session.value, card.value!.scan!).map((p) => p.text)).toEqual(['„Zwei“ und „Eins“ wollen beide in Ordner 06.']);
  });
});
