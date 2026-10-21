/**
 * Packing on the open card (packRun.ts), as the dialog runs it: when the
 * target's own episode is not the first, the folder ends up in the order of
 * the episodes (Frank 16.10.2026: "Unter meinem Bett" before "… 7"), the
 * catalog and the cards "von … bis …" follow their tracks, and every card
 * to write anew is offered.
 */
import { describe, expect, it } from 'vitest';
import { card, platform, rescan } from '../../src/app/state';
import { loadCatalog, newCatalog } from '../../src/core/tonuino/catalog';
import { planPack } from '../../src/core/tonuino/pack';
import { isOutOfOrder, scanSd } from '../../src/core/tonuino/sd';
import { packOnCard } from '../../src/features/box/packRun';
import { memDir, type MemTree } from '../../src/platform/memory';
import type { Platform } from '../../src/platform/types';

const bytes = (folder: number, n: number) => new Uint8Array(30).fill(folder * 10 + n);
function tracks(folder: number, count: number): MemTree {
  const out: MemTree = {};
  for (let n = 1; n <= count; n++) out[`${String(n).padStart(3, '0')}.mp3`] = bytes(folder, n);
  return out;
}

describe('packing a series on the card', () => {
  it('puts the episodes into their order afterwards; titles, episodes and cards follow the tracks', async () => {
    const root = memDir({ '02': tracks(2, 2), '05': tracks(5, 3), '07': tracks(7, 1), '08': tracks(8, 1) });
    const c = newCatalog('Box', 'tng');
    const f = (title: string, names: string[]) => ({ title, tracks: names.map((t, i) => ({ file: `00${i + 1}.mp3`, title: t })), addedAt: 0, updatedAt: 0 });
    c.folders['02'] = f('Reihe 3', ['Drei A', 'Drei B']);
    c.folders['05'] = f('Reihe', ['Eins A', 'Eins B', 'Eins C']);
    c.folders['07'] = f('Reihe 2', ['Zwei']);
    c.folders['08'] = f('Anderes', ['Lied']);
    platform.value = { kind: 'web', os: 'linux', volumes: { info: async () => ({}) } } as unknown as Platform;
    card.value = { volume: { id: 'sd', label: 'SD', root, info: {}, canEject: false }, status: 'ready', scan: await scanSd(root), catalog: c, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    await rescan();

    const plan = planPack({ scan: card.value!.scan!, catalog: card.value!.catalog!, numbers: [2, 5, 7], name: 'Reihe', profile: 'tng', pureNumbers: true });
    let ordering = false;
    const out = await packOnCard(plan, { onOrder: () => (ordering = true) });
    expect(out.error).toBeUndefined();
    expect(ordering).toBe(true);

    const scan = await scanSd(root);
    expect(scan.folders.map((x) => x.name)).toEqual(['02', '08']);
    expect(scan.tempDirs).toEqual([]);
    // The files in the order of the episodes, numbered 1 to 6, and in that order in the folder.
    const f02 = scan.folders[0];
    expect(f02.tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3', '004.mp3', '005.mp3', '006.mp3']);
    expect(isOutOfOrder(f02.tracks)).toBe(false);
    const dir = await root.dir('02');
    const first = await Promise.all(f02.tracks.map(async (t) => (await dir.read(t.name))[0]));
    expect(first).toEqual([51, 52, 53, 71, 21, 22]);

    const cat = card.value!.catalog!;
    expect(cat.folders['02'].tracks.map((t) => [t.file, t.title, t.episode])).toEqual([
      ['001.mp3', 'Eins A', 'Reihe'],
      ['002.mp3', 'Eins B', 'Reihe'],
      ['003.mp3', 'Eins C', 'Reihe'],
      ['004.mp3', 'Zwei', 'Reihe 2'],
      ['005.mp3', 'Drei A', 'Reihe 3'],
      ['006.mp3', 'Drei B', 'Reihe 3'],
    ]);
    expect(cat.folders['05']).toBeUndefined();
    expect(cat.folders['08'].title).toBe('Anderes');
    const cards = cat.extraCards.map((x) => [x.label, x.folder, x.special, x.special2]).sort((a, b) => Number(a[2]) - Number(b[2]));
    expect(cards).toEqual([
      ['Reihe', 2, 1, 3],
      ['Reihe 2', 2, 4, 4],
      ['Reihe 3', 2, 5, 6],
    ]);
    expect(new Set(out.cards)).toEqual(new Set(cat.extraCards.map((x) => x.id)));
    // What is on the card says the same.
    const onCard = await loadCatalog(root);
    expect(onCard?.folders['02'].tracks.map((t) => t.episode)).toEqual(['Reihe', 'Reihe', 'Reihe', 'Reihe 2', 'Reihe 3', 'Reihe 3']);
  });
});
