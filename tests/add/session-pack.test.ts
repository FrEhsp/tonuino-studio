/**
 * "Reihe in einen Ordner packen" on the add page (Frank 16.10.2026):
 * several albums of one series, or albums with no folder left, get the
 * offer to go as episodes into one folder, also with the extra "Mehr als
 * 99 Hörspiele" off; one click takes it back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { card, platform, settings } from '../../src/app/state';
import { createBrowserAudioBackend } from '../../src/core/audio';
import type { DraftTrack } from '../../src/core/library/grouping';
import { newCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { packAlbums, packOffer, refillTargets, resetImport, runImport, session, unpackAlbums, type ImportAlbum } from '../../src/features/add/session';
import { memDir, memSource, type MemTree } from '../../src/platform/memory';
import type { Platform } from '../../src/platform/types';
import { fakeWebCodecs } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { monoMp3 } from '../audio/fixtures';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });
const defaults = settings.value;

async function useCard(tree: MemTree = {}, catalog: Catalog = newCatalog()) {
  const root = memDir(tree);
  platform.value = { kind: 'web', os: 'linux', audio, volumes: { info: async () => ({}) } } as unknown as Platform;
  card.value = { volume: { id: 'sd', label: 'SD', root, info: {}, canEject: false }, status: 'ready', scan: await scanSd(root), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
  resetImport();
  return root;
}

function album(id: string, title: string, files: number, target: number): ImportAlbum {
  const tracks: DraftTrack[] = Array.from({ length: files }, (_, i) => ({ source: memSource(`${id}${i + 1}.mp3`, monoMp3()), info: { codec: 'mp3', durationSec: 12 }, title: `${title} ${i + 1}` }));
  return { id, title, kind: 'hoerspiel', tracks, split: 'none', splitMinutes: 5, target, append: false };
}

afterEach(() => {
  settings.value = defaults;
});

describe('the offer on the add page', { timeout: 30_000 }, () => {
  it('puts several albums of a series into one new folder, named like the series, each an episode', async () => {
    const root = await useCard({ '01': { '001.mp3': monoMp3() } });
    settings.value = { ...defaults, normalizeLoudness: false, episodePlanner: false };
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'Paw Patrol 1', 1, 2), album('b', 'Paw Patrol 2', 2, 3), album('c', 'Abbey Road', 1, 4)] };
    const offer = packOffer(session.value, card.value!.scan!, card.value!.catalog);
    expect(offer).toEqual({ kind: 'gather', series: 'Paw Patrol', albums: ['a', 'b'], target: 2, existing: false });
    packAlbums(offer as Extract<typeof offer, { kind: 'gather' }>);
    expect(session.value.albums.map((a) => [a.id, a.target, a.append])).toEqual([
      ['a', 2, false],
      ['b', 2, true],
      ['c', 4, false],
    ]);
    expect(packOffer(session.value, card.value!.scan!, card.value!.catalog)).toEqual({ kind: 'packed', series: 'Paw Patrol', albums: ['a', 'b'], target: 2 });

    await runImport();
    expect(session.value.result?.episodes).toEqual([2]);
    expect((await (await root.dir('02')).list()).map((e) => e.name).sort()).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    const f = card.value!.catalog!.folders['02'];
    expect(f.title).toBe('Paw Patrol');
    expect(f.tracks.map((t) => t.episode)).toEqual(['Paw Patrol 1', 'Paw Patrol 2', 'Paw Patrol 2']);
    // An album on its own stays an album.
    expect(card.value!.catalog!.folders['04'].tracks.map((t) => t.episode)).toEqual([undefined]);
  });

  it('can be taken back: each album gets a folder of its own again', async () => {
    await useCard({});
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'TKKG 1', 1, 1), album('b', 'TKKG 2', 1, 2)] };
    const offer = packOffer(session.value, card.value!.scan!, card.value!.catalog)!;
    packAlbums(offer as Extract<typeof offer, { kind: 'gather' }>);
    unpackAlbums(1);
    expect(session.value.packed).toEqual([]);
    expect(session.value.albums.map((a) => [a.target, a.append])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it('appends to a folder of the series on the card that has room, also a single album without a free folder', async () => {
    const tree: MemTree = { '05': { '001.mp3': monoMp3() } };
    const c = newCatalog();
    c.folders['05'] = { title: 'Die drei ???', tracks: [], addedAt: 0, updatedAt: 0 };
    await useCard(tree, c);
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'Die drei ??? 12 – Feuermond', 1, 0)] };
    expect(packOffer(session.value, card.value!.scan!, card.value!.catalog)).toEqual({ kind: 'gather', series: 'Die drei ???', albums: ['a'], target: 5, existing: true });
  });

  it('offers to pack a series on the card when no folder is free and nothing fits', async () => {
    await useCard({ '01': { '001.mp3': monoMp3() } });
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'Abbey Road', 1, 0), album('b', 'Blue', 1, 0)] };
    expect(packOffer(session.value, card.value!.scan!, card.value!.catalog)).toEqual({ kind: 'pack', albums: 2 });
    // After packing, the albums get the numbers that became free.
    refillTargets();
    expect(session.value.albums.map((a) => a.target)).toEqual([2, 3]);
  });

  it('says nothing for albums of different series, and nothing when adding to a folder', async () => {
    await useCard({});
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'Paw Patrol 1', 1, 1), album('b', 'TKKG 2', 1, 2)] };
    expect(packOffer(session.value, card.value!.scan!, card.value!.catalog)).toBeNull();
    expect(packOffer({ ...session.value, forFolder: 1 }, card.value!.scan!, card.value!.catalog)).toBeNull();
  });
});
