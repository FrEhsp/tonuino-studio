import { describe, expect, it } from 'vitest';
import { memDir } from '../../src/platform/memory';
import { loadCatalog, newCatalog, saveCatalog, serializeCatalog } from '../../src/core/tonuino/catalog';
import { loadCovers, packCovers, saveCovers } from '../../src/core/tonuino/covers';
import { CATALOG_FILE, COVERS_FILE } from '../../src/core/tonuino/sd';
import { forgetUnreadable, UnreadableCardFile, unreadableFiles } from '../../src/core/tonuino/unreadable';

/** A card whose reader drops off: reading the app files fails while `broken` is true (0.5.1, cover loss). */
async function card() {
  const root = memDir({ '01': { '001.mp3': new Uint8Array(10) } });
  await root.write(CATALOG_FILE, new TextEncoder().encode(serializeCatalog(newCatalog('Box'))));
  await root.write(COVERS_FILE, await packCovers(new Map([['01.jpg', new Uint8Array([1, 2, 3])]])));
  const state = { broken: true };
  const read = root.read.bind(root);
  (root as { read: typeof root.read }).read = async (name: string) => {
    if (state.broken && (name === CATALOG_FILE || name === COVERS_FILE)) throw new Error('Eingabe-/Ausgabefehler');
    return read(name);
  };
  return { root, state, read };
}

describe('app files that failed to read', () => {
  it('are never overwritten or removed while they cannot be read', async () => {
    const { root, read } = await card();
    await expect(loadCovers(root)).rejects.toBeInstanceOf(UnreadableCardFile);
    await expect(loadCatalog(root)).rejects.toThrow();
    expect(unreadableFiles(root).sort()).toEqual([CATALOG_FILE, COVERS_FILE].sort());
    // What a session with the covers "gone" would write: one new picture, or none at all.
    await expect(saveCovers(root, new Map([['51.jpg', new Uint8Array([9])]]))).rejects.toBeInstanceOf(UnreadableCardFile);
    await expect(saveCovers(root, new Map())).rejects.toBeInstanceOf(UnreadableCardFile);
    await expect(saveCatalog(root, newCatalog('Neu'))).rejects.toBeInstanceOf(UnreadableCardFile);
    expect(await root.exists(COVERS_FILE)).toBe(true);
    expect((await loadCoversFrom(read)).size).toBe(1);
  });

  it('a broken zip or a half-written catalog counts as unreadable, not as empty', async () => {
    const root = memDir();
    await root.write(COVERS_FILE, new Uint8Array([80, 75, 3, 4, 0, 0]));
    await root.write(CATALOG_FILE, new TextEncoder().encode('{"app":"tonuino-studio","folders":{"01":'));
    await expect(loadCovers(root)).rejects.toBeInstanceOf(UnreadableCardFile);
    await expect(loadCatalog(root)).rejects.toBeInstanceOf(UnreadableCardFile);
    await expect(saveCovers(root, new Map())).rejects.toThrow(/Cover/);
    await expect(saveCatalog(root, newCatalog('Neu'))).rejects.toThrow(/Namen/);
  });

  it('a later good reading lifts the block', async () => {
    const { root, state } = await card();
    await loadCovers(root).catch(() => undefined);
    state.broken = false;
    expect((await loadCovers(root)).size).toBe(1);
    expect(unreadableFiles(root)).toEqual([]);
    await saveCovers(root, new Map([['02.jpg', new Uint8Array([4])]]));
    expect([...(await loadCovers(root)).keys()]).toEqual(['02.jpg']);
  });

  it('a card without app files is no problem', async () => {
    const root = memDir();
    expect(await loadCatalog(root)).toBeNull();
    expect((await loadCovers(root)).size).toBe(0);
    expect(unreadableFiles(root)).toEqual([]);
    await saveCovers(root, new Map([['01.jpg', new Uint8Array([1])]]));
    expect(await root.exists(COVERS_FILE)).toBe(true);
  });

  it('a deliberate copy onto the card replaces them anyway', async () => {
    const { root } = await card();
    await loadCovers(root).catch(() => undefined);
    forgetUnreadable(root);
    await saveCovers(root, new Map([['03.jpg', new Uint8Array([5])]]));
    expect(unreadableFiles(root)).toEqual([]);
  });
});

/** The covers as the card holds them, read past the broken reader. */
async function loadCoversFrom(read: (name: string) => Promise<Uint8Array>) {
  const copy = memDir();
  await copy.write(COVERS_FILE, await read(COVERS_FILE));
  return loadCovers(copy);
}
