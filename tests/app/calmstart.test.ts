import { afterEach, describe, expect, it } from 'vitest';
import { boot, card, closeCard, rescan, sameScan, startingUp } from '../../src/app/state';
import { newCatalog, serializeCatalog } from '../../src/core/tonuino/catalog';
import { CATALOG_FILE, scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import type { Platform, Volume } from '../../src/platform/types';

function platformWith(list: Volume[], settled?: Promise<void>): Platform {
  return {
    volumes: {
      subscribe: (cb: (v: Volume[]) => void) => {
        cb(list);
        return () => undefined;
      },
      info: async (v: Volume) => v.info,
      ...(settled ? { settled: () => settled } : {}),
    },
  } as unknown as Platform;
}

function tonuinoCard(): Volume {
  const root = memDir(
    {
      mp3: { '0001.mp3': new Uint8Array(10) },
      '01': { '001.mp3': new Uint8Array(20), '002.mp3': new Uint8Array(30) },
      // With its catalog, as the app leaves a card (nothing to look up on this computer).
      [CATALOG_FILE]: new TextEncoder().encode(serializeCatalog(newCatalog('Box'))),
    },
    'BOX',
  );
  return { id: 'box', label: 'BOX', root, info: { removable: true, fsType: 'vfat' }, canEject: true };
}

async function until(test: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${JSON.stringify({ status: card.value?.status, error: card.value?.error })}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('a calm start', () => {
  afterEach(() => closeCard());

  it('says nothing about a missing card until the platform has looked', async () => {
    let done!: () => void;
    const looked = new Promise<void>((r) => (done = r));
    boot(platformWith([], looked));
    await new Promise((r) => setTimeout(r, 20));
    // Still looking: the start page waits instead of saying "no card".
    expect(startingUp.value).toBe(true);
    done();
    await until(() => !startingUp.value);
    expect(card.value).toBeNull();
  });

  it('is not starting up any more once the card is open', async () => {
    boot(platformWith([tonuinoCard()]));
    await until(() => card.value?.status === 'ready');
    expect(startingUp.value).toBe(false);
  });
});

describe('reading the card again', () => {
  afterEach(() => closeCard());

  it('compares scans without the time they were made', async () => {
    const v = tonuinoCard();
    const a = await scanSd(v.root);
    const b = { ...(await scanSd(v.root)), scannedAt: a.scannedAt + 5000 };
    expect(sameScan(a, b)).toBe(true);
    await v.root.dir('01').then((d) => d.write('003.mp3', new Uint8Array(5)));
    expect(sameScan(a, await scanSd(v.root))).toBe(false);
  });

  it('keeps the state as it is when nothing changed, so nothing is drawn again', async () => {
    const v = tonuinoCard();
    boot(platformWith([v]));
    await until(() => card.value?.status === 'ready');
    const before = card.value;
    await rescan();
    expect(card.value).toBe(before);
    await v.root.dir('01').then((d) => d.write('003.mp3', new Uint8Array(5)));
    await rescan();
    expect(card.value).not.toBe(before);
    expect(card.value?.scan?.folders.find((f) => f.number === 1)?.tracks.length).toBe(3);
  });
});
