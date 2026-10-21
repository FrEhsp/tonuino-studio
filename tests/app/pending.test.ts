/**
 * The card in a browser that cannot write to it: read once, changed in the
 * app, brought to the card as a Paket, checked, and taken as the new start.
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptCheckedCard,
  BUSY_TEXT,
  canChangeCard,
  copyBusy,
  cardChangedElsewhere,
  foreignPackageChecked,
  rereadChangedCard,
  takeChangedCard,
  cardNote,
  cardReading,
  changesWouldBeLost,
  checkReading,
  chooseCardFolder,
  chooserOpen,
  discardedPackages,
  discardPackage,
  foldersNotOnCard,
  isSnapshotCard,
  makePackage,
  openSnapshot,
  packageState,
  plan,
  readDroppedCard,
  rereadCard,
  snapshotOfCard,
  startPackageDownload,
  systemSoundsPending,
} from '../../src/app/pending';
import { writeGuard } from '../../src/app/writeguard';
import { boot, card, closeCard, healthContext, rescan, setCover, updateCatalog } from '../../src/app/state';
import { newCatalog, parseCatalog, serializeCatalog } from '../../src/core/tonuino/catalog';
import { CATALOG_FILE, COVERS_FILE } from '../../src/core/tonuino/sd';
import { checkCard, checkCardContent } from '../../src/core/tonuino/verify';
import { cloneTree, type BlobFolder } from '../../src/platform/blobtree';
import { memoryScratch, OverlayLockedError, type ScratchStore } from '../../src/platform/overlay';
import { snapshotFromFiles, type SnapshotProblem, type SnapshotResult } from '../../src/platform/snapshot';
import type { CardSnapshotAccess, Platform, SnapshotPurpose, Volume, VolumeInfo } from '../../src/platform/types';
import { GoneBlob } from '../platform/blobfixtures';
import { readAgain, unpack } from '../tonuino/unpack';

const enc = new TextEncoder();

/** A card as the folder chooser hands it over. */
function reading(tree: Record<string, string>, label = 'TONUINO', at = 1000): SnapshotResult {
  const items = Object.entries(tree).map(([path, text]) => ({ path: `${label}/${path}`, blob: new File([text], path.split('/').pop()!) }));
  const r = snapshotFromFiles(items, at);
  if ('kind' in r) throw new Error(r.kind);
  return r;
}

const CATALOG = serializeCatalog(newCatalog('Annas Box'));

const CARD = {
  'mp3/0001.mp3': 'ton',
  'advert/0001.mp3': 'werbung',
  '01/001.mp3': 'eins',
  '01/002.mp3': 'zwei',
  // Left by macOS in the root: the box ignores it, a Paket cannot delete it.
  '.Trashes/501/x': 'müll',
  [CATALOG_FILE]: CATALOG,
};

type Chosen = Parameters<Parameters<CardSnapshotAccess['onChosen']>[0]>[0];

interface FakeDownload {
  name: string;
  size: number;
  blob: Blob;
  disposed: boolean;
  again: () => void;
  dispose: () => void;
}

let chosen: ((o: Chosen) => void) | undefined;
let emitVolumes: ((v: Volume[]) => void) | undefined;
let choices: SnapshotPurpose[];
let stores: (ScratchStore & { dispose: ReturnType<typeof vi.fn> })[];
let downloads: FakeDownload[];
let drop: Promise<SnapshotResult | SnapshotProblem> | null;

function fakePlatform(info: VolumeInfo = {}): Platform {
  const access: CardSnapshotAccess = {
    choose: (purpose) => void choices.push(purpose),
    onChosen: (cb) => {
      chosen = cb;
      return () => {
        if (chosen === cb) chosen = undefined;
      };
    },
    fromDrop: () => drop,
    createScratch: async () => {
      const s = memoryScratch();
      const store = Object.assign(s, { dispose: vi.fn(s.dispose) });
      stores.push(store);
      return store;
    },
    download: (blob, name) => {
      const d: FakeDownload = {
        name,
        size: blob.size,
        blob,
        disposed: false,
        again: vi.fn(),
        dispose: () => {
          d.disposed = true;
        },
      };
      downloads.push(d);
      return d;
    },
  };
  return {
    kind: 'web',
    os: 'linux',
    volumes: {
      subscribe: (cb: (v: Volume[]) => void) => {
        emitVolumes = cb;
        cb([]);
        return () => undefined;
      },
      info: async () => info,
    },
    cardSnapshot: access,
    capabilities: { sd: false, sdPackage: true, sdAutoDetect: false, eject: false, fsDetails: false, serial: false, nfcReader: false, wifiBox: false, builtInMic: false },
  } as unknown as Platform;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function root() {
  return card.value!.volume.root;
}

async function addFolder(name: string, files: Record<string, string>) {
  const dir = await root().dir(name, { create: true });
  for (const [f, text] of Object.entries(files)) await dir.write(f, enc.encode(text));
}

/** What the card holds after the Paket was unpacked on it, as the user would do. */
async function unpacked(base: BlobFolder, blob: Blob, deleteFirst: string[]): Promise<BlobFolder> {
  const c = cloneTree(base);
  c.children = c.children.filter((n) => !deleteFirst.includes(n.name));
  return unpack(c, new Uint8Array(await blob.arrayBuffer()));
}

async function zipPaths(blob: Blob): Promise<string[]> {
  const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
  return Object.keys(zip.files);
}

beforeEach(() => {
  chosen = undefined;
  choices = [];
  stores = [];
  downloads = [];
  drop = null;
  boot(fakePlatform());
});

afterEach(() => {
  closeCard();
  cardNote.value = null;
  checkReading.value = null;
});

describe('a card read as a snapshot', () => {
  it('opens as a card that stays open, though no drive list knows it', async () => {
    const r = reading(CARD);
    await openSnapshot(r);
    expect(card.value?.status).toBe('ready');
    expect(card.value?.volume.access).toBe('snapshot');
    expect(card.value?.volume.label).toBe('TONUINO');
    expect(isSnapshotCard()).toBe(true);
    expect(snapshotOfCard.value).toBe(r);
    expect(packageState.value.kind).toBe('clean');
    expect(plan.value?.count).toBe(0);
    emitVolumes?.([]);
    expect(card.value?.volume.access).toBe('snapshot');
  });

  it('does not judge the order the browser listed, and leaves junk in the root alone', async () => {
    await openSnapshot(reading({ ...CARD, '01/._001.mp3': 'mac' }));
    const ctx = healthContext(card.value!);
    expect(ctx.trustsDirectoryOrder).toBe(false);
    expect(ctx.keepRootJunk).toBe(true);
    const junk = card.value?.report?.issues.find((i) => i.id === 'junk');
    // Only the hidden file in folder 01: deleting that folder and unpacking it again removes it.
    expect(junk?.items).toEqual(['01/._001.mp3']);
  });

  it('does not judge the format by the times its copy made up for new files', async () => {
    // As in the browser: the platform says the times come from the card. For a snapshot they do only for what was read.
    boot(fakePlatform({ fileTimesFromCard: true }));
    // Times as FAT stores them: whole even seconds.
    const fat = 1_600_000_000_000;
    const items = Object.entries(CARD).map(([path, text], i) => ({ path: `TONUINO/${path}`, blob: new File([text], path.split('/').pop()!), modified: fat + i * 2000 }));
    const r = snapshotFromFiles(items, fat);
    if ('kind' in r) throw new Error(r.kind);
    await openSnapshot(r);
    expect(card.value?.report?.issues.map((i) => i.id)).not.toContain('fs-type');
    await addFolder('02', { '001.mp3': 'neu eins', '002.mp3': 'neu zwei', '003.mp3': 'neu drei' });
    await updateCatalog((c) => {
      c.name = 'Annas Hörspiele';
    });
    await rescan();
    expect(card.value?.info.fileTimesFromCard).toBeFalsy();
    expect(card.value?.report?.issues.map((i) => i.id)).not.toContain('fs-type');
  });

  it('brings changes to the card in a Paket, and takes the checked card as the new start', async () => {
    const first = reading(CARD);
    await openSnapshot(first);
    await addFolder('02', { '001.mp3': 'neu eins', '002.mp3': 'neu zwei' });
    await updateCatalog((c) => {
      c.name = 'Annas Hörspiele';
    });
    expect(plan.value?.changes.map((c) => [c.kind, c.name])).toEqual([['add', '02']]);
    expect(plan.value?.appFiles.map((a) => a.name)).toEqual([CATALOG_FILE]);
    expect(packageState.value.kind).toBe('pending');
    expect(changesWouldBeLost.value).toBe(true);

    const { blob, manifest, needsClick } = await makePackage('changes');
    // Everything in it was made in the app, so no file of the card had to be read.
    expect(needsClick).toBe(false);
    expect(await zipPaths(blob)).toEqual(['02/', '02/001.mp3', '02/002.mp3', CATALOG_FILE]);
    expect(manifest.name).toMatch(/^TonUINO-Paket-\d{4}-\d{4}-[A-Z2-9]{3}\.zip$/);

    const download = startPackageDownload(blob, manifest);
    expect(downloads.map((d) => d.name)).toEqual([manifest.name]);
    expect(download.size).toBe(blob.size);
    expect(packageState.value.kind).toBe('downloaded');
    expect(canChangeCard()).toBe(false);
    expect(changesWouldBeLost.value).toBe(false);

    // Until the card was checked, the Paket has to fit it: no new folders …
    await expect(root().dir('03', { create: true })).rejects.toBeInstanceOf(OverlayLockedError);
    // … but names and pictures may change, and go into the next Paket.
    await updateCatalog((c) => {
      c.name = 'Annas TonUINO';
    });
    expect(changesWouldBeLost.value).toBe(true);

    const after = await readAgain(await unpacked(first.root, blob, manifest.deleteFirst), 2000);
    expect(checkCard(after.root, after.label, manifest).ok).toBe(true);
    await acceptCheckedCard(after);

    expect(card.value?.status).toBe('ready');
    expect(snapshotOfCard.value).toBe(after);
    expect(card.value?.scan?.folders.map((f) => f.number)).toEqual([1, 2]);
    // The name changed after the download waits for the next Paket.
    expect(card.value?.catalog?.name).toBe('Annas TonUINO');
    expect(plan.value?.changes).toEqual([]);
    expect(plan.value?.appFiles.map((a) => a.name)).toEqual([CATALOG_FILE]);
    expect(packageState.value.kind).toBe('pending');
    expect(canChangeCard()).toBe(true);
    expect(downloads[0].disposed).toBe(true);
    expect(stores[0].dispose).toHaveBeenCalled();
    expect(stores[1].dispose).not.toHaveBeenCalled();
  });

  it('names what is only in the copy: new folders and new announcements', async () => {
    await openSnapshot(reading(CARD));
    expect([...foldersNotOnCard.value]).toEqual([]);
    expect(systemSoundsPending.value).toBe(false);
    await addFolder('02', { '001.mp3': 'neu' });
    // A changed folder is on the card already, in its old form: the box can play it.
    await (await root().dir('01')).write('003.mp3', enc.encode('drei'));
    expect([...foldersNotOnCard.value]).toEqual([2]);
    expect(systemSoundsPending.value).toBe(false);
    await (await root().dir('mp3')).write('0002.mp3', enc.encode('ansage'));
    expect(systemSoundsPending.value).toBe(true);
  });

  it('a special card added and taken out again leaves nothing for the card', async () => {
    await openSnapshot(reading(CARD));
    const sleep = { id: 'x', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 };
    await updateCatalog((c) => void c.extraCards.push(sleep));
    expect(plan.value?.appFiles.map((f) => f.name)).toEqual([CATALOG_FILE]);
    await updateCatalog((c) => void (c.extraCards = []));
    expect(plan.value?.count).toBe(0);
    expect(packageState.value.kind).toBe('clean');
  });

  it('starts clean after a check when nothing changed after the download', async () => {
    const first = reading(CARD);
    await openSnapshot(first);
    await addFolder('02', { '001.mp3': 'neu' });
    const { blob, manifest } = await makePackage('changes');
    startPackageDownload(blob, manifest);
    await acceptCheckedCard(await readAgain(await unpacked(first.root, blob, manifest.deleteFirst), 2000));
    expect(packageState.value.kind).toBe('clean');
    expect(changesWouldBeLost.value).toBe(false);
  });

  it('carries a removed cover file over as a change', async () => {
    const first = reading(CARD);
    await openSnapshot(first);
    await setCover(1, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg', 'Datei');
    const { blob, manifest } = await makePackage('changes');
    // The catalog has no entry for folder 01, so it stays as it is and does not come along.
    expect(await zipPaths(blob)).toEqual([COVERS_FILE]);
    startPackageDownload(blob, manifest);
    await setCover(1, null);
    const after = await readAgain(await unpacked(first.root, blob, manifest.deleteFirst), 2000);
    await acceptCheckedCard(after);
    expect(card.value?.covers.size).toBe(0);
    expect(plan.value?.appFiles).toContainEqual({ name: COVERS_FILE, empty: true });
  });

  it('lets the card change again when the Paket is thrown away', async () => {
    await openSnapshot(reading(CARD));
    await addFolder('02', { '001.mp3': 'neu' });
    const { blob, manifest } = await makePackage('changes');
    startPackageDownload(blob, manifest);
    discardPackage();
    expect(downloads[0].disposed).toBe(true);
    expect(packageState.value.kind).toBe('pending');
    expect(canChangeCard()).toBe(true);
    expect(discardedPackages.value).toBe(1);
    await addFolder('03', { '001.mp3': 'noch neuer' });
    expect(plan.value?.changes.map((c) => c.name)).toEqual(['02', '03']);
  });

  it('does not download a Paket that no longer fits the copy', async () => {
    await openSnapshot(reading(CARD));
    await addFolder('02', { '001.mp3': 'neu' });
    const { blob, manifest } = await makePackage('changes');
    await addFolder('03', { '001.mp3': 'später' });
    expect(() => startPackageDownload(blob, manifest)).toThrow('Seit dem Packen hat sich etwas geändert. Packe das Paket noch einmal.');
    expect(packageState.value.kind).toBe('pending');
    expect(downloads).toEqual([]);
  });

  it('makes no Paket while the app still writes into the copy', async () => {
    await openSnapshot(reading(CARD));
    await addFolder('02', { '001.mp3': 'neu' });
    // The add flow holds the guard while it converts and stores titles, also between two of them.
    const release = writeGuard.hold('tracks');
    expect(copyBusy.value).toBe(true);
    await expect(makePackage('changes')).rejects.toThrow(BUSY_TEXT);
    release();
    expect(copyBusy.value).toBe(false);
    // Loading from Entdecken or firmware for the box does not touch the copy.
    const other = writeGuard.hold('downloads');
    expect(copyBusy.value).toBe(false);
    other();

    const { blob, manifest } = await makePackage('changes');
    const late = writeGuard.hold('repair');
    expect(() => startPackageDownload(blob, manifest)).toThrow(BUSY_TEXT);
    late();
    // A file still being stored does not change the version yet: the download waits for it too.
    const dir = await root().dir('02');
    const storing = dir.write('002.mp3', enc.encode('noch eins'));
    expect(() => startPackageDownload(blob, manifest)).toThrow(BUSY_TEXT);
    await storing;
    expect(() => startPackageDownload(blob, manifest)).toThrow('Seit dem Packen hat sich etwas geändert.');
    expect(downloads).toEqual([]);
    expect(packageState.value.kind).toBe('pending');
    const again = await makePackage('changes');
    startPackageDownload(again.blob, again.manifest);
    expect(await zipPaths(again.blob)).toEqual(['02/', '02/001.mp3', '02/002.mp3']);
  });

  it('reads the card once for a full Paket, without the junk', async () => {
    await openSnapshot(reading(CARD));
    const progress: number[] = [];
    const { blob, manifest, needsClick } = await makePackage('full', { onProgress: (done) => progress.push(done) });
    expect(needsClick).toBe(true);
    expect(progress.at(-1)).toBe(['ton', 'werbung', 'eins', 'zwei', CATALOG].reduce((n, t) => n + enc.encode(t).length, 0));
    expect(await zipPaths(blob)).toEqual(['mp3/', 'mp3/0001.mp3', 'advert/', 'advert/0001.mp3', '01/', '01/001.mp3', '01/002.mp3', CATALOG_FILE]);
    expect(manifest.name).toMatch(/^TonUINO-Karte-komplett-/);
  });

  it('drops what waited when the card is read again', async () => {
    await openSnapshot(reading(CARD));
    await addFolder('02', { '001.mp3': 'neu' });
    await rereadCard(reading(CARD, 'TONUINO', 3000));
    expect(plan.value?.count).toBe(0);
    expect(stores[0].dispose).toHaveBeenCalled();
    expect(card.value?.volume.snapshotAt).toBe(3000);
  });

  it('takes its copy along when the card is closed', async () => {
    await openSnapshot(reading(CARD));
    await addFolder('02', { '001.mp3': 'neu' });
    closeCard();
    expect(plan.value).toBeNull();
    expect(packageState.value.kind).toBe('clean');
    expect(stores[0].dispose).toHaveBeenCalled();
  });
});

describe('readings of the card', () => {
  it('open the card, whichever page opened the chooser', async () => {
    chooseCardFolder('card');
    expect(choices).toEqual(['card']);
    expect(chooserOpen.value?.purpose).toBe('card');
    chosen?.({ purpose: 'card', result: reading(CARD) });
    expect(chooserOpen.value).toBeNull();
    await settle();
    await settle();
    expect(card.value?.status).toBe('ready');
    expect(cardNote.value).toBeNull();
  });

  it('end when the chooser was closed', () => {
    chooseCardFolder('card');
    chosen?.({ purpose: 'card', cancelled: true });
    expect(chooserOpen.value).toBeNull();
    expect(card.value).toBeNull();
  });

  it('open an empty card, and say it could be the wrong folder', async () => {
    chosen?.({ purpose: 'card', result: { kind: 'empty' } });
    await settle();
    await settle();
    expect(card.value?.status).toBe('ready');
    expect(card.value?.volume.label).toBe('SD-Karte');
    expect(card.value?.scan?.kind).toBe('empty');
    expect(cardNote.value).toEqual({ kind: 'looks-empty' });
  });

  it('wait when a folder of the card was chosen instead of the card', async () => {
    const sub = reading({ '001.mp3': 'eins', '002.mp3': 'zwei' }, '05');
    chosen?.({ purpose: 'card', result: sub });
    await settle();
    expect(card.value).toBeNull();
    expect(cardNote.value).toEqual({ kind: 'picked-subfolder', result: sub });
    // "Trotzdem so nehmen"
    await openSnapshot(sub);
    expect(card.value?.volume.label).toBe('05');
    expect(cardNote.value).toBeNull();
  });

  it('report problems and keep the open card', async () => {
    await openSnapshot(reading(CARD));
    const id = card.value?.volume.id;
    chosen?.({ purpose: 'card', result: { kind: 'read-failed', path: '05/003.mp3', message: 'NotReadableError' } });
    await settle();
    expect(cardNote.value).toEqual({ kind: 'problem', problem: { kind: 'read-failed', path: '05/003.mp3', message: 'NotReadableError' }, source: 'chooser' });
    expect(card.value?.volume.id).toBe(id);
  });

  it('for checking go to the check, not to the open card', async () => {
    await openSnapshot(reading(CARD));
    const id = card.value?.volume.id;
    chooseCardFolder('check');
    const again = reading(CARD, 'TONUINO', 5000);
    chosen?.({ purpose: 'check', result: again });
    await settle();
    expect(checkReading.value?.result).toBe(again);
    expect(card.value?.volume.id).toBe(id);
  });

  it('come from a drop too, with the files counted on the way', async () => {
    let finish: (r: SnapshotResult) => void = () => undefined;
    drop = new Promise((ok) => (finish = ok));
    expect(readDroppedCard({} as DataTransfer, 'card')).toBe(true);
    expect(cardReading.value).toEqual({ purpose: 'card', files: 0 });
    finish(reading(CARD));
    await settle();
    await settle();
    expect(cardReading.value).toBeNull();
    expect(card.value?.status).toBe('ready');
    drop = null;
    expect(readDroppedCard({} as DataTransfer, 'card')).toBe(false);
  });
});

describe('a check after only names changed', () => {
  it('does not take a card where nothing was unpacked for one that has the Paket', async () => {
    const first = reading(CARD);
    await openSnapshot(first);
    // A typo fixed: the catalog keeps its size.
    await updateCatalog((c) => {
      c.name = 'Annas Boy';
    });
    const { blob, manifest } = await makePackage('changes');
    expect(manifest.files.map((f) => f.path)).toEqual([CATALOG_FILE]);
    startPackageDownload(blob, manifest);
    const onCard = (await readAgain(first.root, 2000)).root;
    const before = onCard.children.find((c) => c.name === CATALOG_FILE);
    expect(before?.kind === 'file' && before.blob.size).toBe(manifest.files[0].size);
    // Sizes alone would pass it, and the name would be lost when the card is taken as the new start.
    expect(checkCard(onCard, 'TONUINO', manifest).ok).toBe(true);
    expect(await checkCardContent(onCard, 'TONUINO', manifest)).toEqual({ ok: false, findings: [{ kind: 'outdated', paths: [CATALOG_FILE] }] });
    // Unpacked, it passes.
    const after = await readAgain(await unpacked(first.root, blob, manifest.deleteFirst), 3000);
    expect((await checkCardContent(after.root, after.label, manifest)).ok).toBe(true);
    await acceptCheckedCard(after);
    expect(card.value?.catalog?.name).toBe('Annas Boy');
  });
});

describe('a Paket from elsewhere on the card', () => {
  /** What the card holds after someone else's Paket with folder 07 was unpacked on it. */
  function withOther(at = 7000) {
    return reading({ ...CARD, '07/001.mp3': 'von oma' }, 'TONUINO', at);
  }

  it('opens the checked card as the new start when nothing waits in the app', async () => {
    await openSnapshot(reading(CARD));
    expect(await foreignPackageChecked(withOther(), 'TonUINO-Paket-oma.zip')).toBe('opened');
    expect(cardChangedElsewhere.value).toBeNull();
    expect(card.value?.scan?.folders.map((f) => f.number)).toEqual([1, 7]);
  });

  it('holds back own changes planned for the card as it was, until the user takes the new card', async () => {
    await openSnapshot(reading(CARD));
    await addFolder('02', { '001.mp3': 'eigenes album' });
    expect(await foreignPackageChecked(withOther(), 'TonUINO-Paket-oma.zip')).toBe('held');
    // Nothing silent: the copy is an old reading now, and the app says so.
    expect(cardChangedElsewhere.value?.packageName).toBe('TonUINO-Paket-oma.zip');
    expect(plan.value?.changes.map((c) => [c.kind, c.name])).toEqual([['add', '02']]);
    expect(canChangeCard()).toBe(false);
    await expect(makePackage('changes')).rejects.toThrow(/anderes Paket/);
    // The user takes the card as it is now: own changes are gone, 07 is there.
    await takeChangedCard();
    expect(cardChangedElsewhere.value).toBeNull();
    expect(packageState.value.kind).toBe('clean');
    expect(canChangeCard()).toBe(true);
    expect(card.value?.scan?.folders.map((f) => f.number)).toEqual([1, 7]);
  });

  it('can also read the card once more instead', async () => {
    await openSnapshot(reading(CARD));
    await addFolder('02', { '001.mp3': 'eigenes album' });
    await foreignPackageChecked(withOther(), 'TonUINO-Paket-oma.zip');
    rereadChangedCard();
    expect(choices).toEqual(['card']);
    chosen?.({ purpose: 'card', result: withOther(8000) });
    await settle();
    await settle();
    expect(cardChangedElsewhere.value).toBeNull();
    expect(snapshotOfCard.value?.takenAt).toBe(8000);
    expect(card.value?.scan?.folders.map((f) => f.number)).toEqual([1, 7]);
  });

  describe('while an own Paket waits for unpacking', () => {
    let stored: Map<string, string>;

    beforeEach(() => {
      stored = new Map();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, v),
        removeItem: (k: string) => void stored.delete(k),
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('says the own Paket no longer fits, and forgets it when the new card is taken', async () => {
      await openSnapshot(reading(CARD));
      await addFolder('02', { '001.mp3': 'eigenes album' });
      const { blob, manifest } = await makePackage('changes');
      startPackageDownload(blob, manifest);
      expect(stored.size).toBe(1);
      expect(await foreignPackageChecked(withOther(), 'TonUINO-Paket-oma.zip')).toBe('held');
      expect(packageState.value.kind).toBe('downloaded');
      expect(cardChangedElsewhere.value).not.toBeNull();
      await takeChangedCard();
      // The own Paket does not lock the new reading, though the card has the same catalog.
      expect(packageState.value.kind).toBe('clean');
      expect(stored.size).toBe(0);
      expect(downloads[0].disposed).toBe(true);
    });
  });
});

describe('a Paket thrown away', () => {
  /** A file of the card that can disappear from it, as when the user deletes its folder. */
  class CardFile extends File {
    gone = false;
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return this.gone ? new GoneBlob(this.size).stream() : super.stream();
    }
  }

  it('lets the next Paket read the card again, so a file gone from the card shows before any download', async () => {
    const track = new CardFile(['eins'], '001.mp3');
    const items = Object.entries(CARD).map(([path, text]) => ({ path: `TONUINO/${path}`, blob: path === '01/001.mp3' ? track : new File([text], path.split('/').pop()!) }));
    const r = snapshotFromFiles(items, 1000);
    if ('kind' in r) throw new Error(r.kind);
    await openSnapshot(r);
    await (await root().dir('01')).write('003.mp3', enc.encode('drei'));
    const one = await makePackage('changes');
    // 001 and 002 come from the card: read once for their checksums.
    expect(one.needsClick).toBe(true);
    startPackageDownload(one.blob, one.manifest);
    // The user deleted folder 01 on the card as the guide said, then threw the Paket away anyway.
    track.gone = true;
    discardPackage();
    await expect(makePackage('changes')).rejects.toThrow(
      'Die Datei „01/001.mp3“ auf der Karte ließ sich nicht lesen. Steckt die Karte noch? Lies die Karte neu ein und versuche es noch einmal.',
    );
    expect(downloads).toHaveLength(1);
  });
});

describe('a Paket from an earlier visit', () => {
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Downloads a Paket with a new album in 02, then the tab is closed. */
  async function downloadAndClose() {
    const first = reading(CARD);
    await openSnapshot(first);
    await addFolder('02', { '001.mp3': 'album a', '002.mp3': 'album a zwei' });
    const { blob, manifest } = await makePackage('changes');
    startPackageDownload(blob, manifest);
    closeCard();
    expect(packageState.value.kind).toBe('clean');
    return { first, blob, manifest };
  }

  it('still waits when the card is read again before it was unpacked: nothing new on top of it', async () => {
    const { manifest } = await downloadAndClose();
    await openSnapshot(reading(CARD, 'TONUINO', 5000));
    const st = packageState.value;
    expect(st.kind).toBe('downloaded');
    expect(st.kind === 'downloaded' && st.restored).toBe(true);
    expect(st.kind === 'downloaded' && st.manifest.files).toEqual(manifest.files);
    expect(st.kind === 'downloaded' && st.manifest.name).toBe(manifest.name);
    expect(canChangeCard()).toBe(false);
    // Folder 02 looks free on this card, but the Paket brings it: no second album may take it.
    await expect(root().dir('02', { create: true })).rejects.toBeInstanceOf(OverlayLockedError);
    // Names neither: the Paket brings its own, and these would overwrite them.
    await expect(updateCatalog((c) => void (c.name = 'Anders'))).rejects.toBeInstanceOf(OverlayLockedError);
    expect(changesWouldBeLost.value).toBe(false);
  });

  it('is checked like a fresh one, and then forgotten', async () => {
    const { first, blob, manifest } = await downloadAndClose();
    await openSnapshot(reading(CARD, 'TONUINO', 5000));
    const after = await readAgain(await unpacked(first.root, blob, manifest.deleteFirst), 6000);
    expect((await checkCardContent(after.root, after.label, manifest)).ok).toBe(true);
    await acceptCheckedCard(after);
    expect(packageState.value.kind).toBe('clean');
    expect(stored.size).toBe(0);
    expect(card.value?.scan?.folders.map((f) => f.number)).toEqual([1, 2]);
  });

  it('is let go when the card read again holds it already', async () => {
    const { first, blob, manifest } = await downloadAndClose();
    await openSnapshot(await readAgain(await unpacked(first.root, blob, manifest.deleteFirst), 6000));
    expect(packageState.value.kind).toBe('clean');
    expect(canChangeCard()).toBe(true);
    expect(stored.size).toBe(0);
  });

  it('can be thrown away, and then the card is free again', async () => {
    await downloadAndClose();
    await openSnapshot(reading(CARD, 'TONUINO', 5000));
    discardPackage();
    expect(packageState.value.kind).toBe('clean');
    expect(canChangeCard()).toBe(true);
    expect(stored.size).toBe(0);
    await addFolder('02', { '001.mp3': 'album b' });
    expect(plan.value?.changes.map((c) => [c.kind, c.name])).toEqual([['add', '02']]);
  });

  it('does not stand in the way of another box’s card', async () => {
    await downloadAndClose();
    const other = serializeCatalog(newCatalog('Pauls Box'));
    await openSnapshot(reading({ ...CARD, [CATALOG_FILE]: other }, 'PAUL', 5000));
    expect(packageState.value.kind).toBe('clean');
    expect(canChangeCard()).toBe(true);
    // It still waits for its own card.
    expect(stored.size).toBe(1);
    expect(parseCatalog(other)?.id).not.toBe(parseCatalog(CATALOG)?.id);
  });

  describe('for a card without a catalog', () => {
    // An older card that never had the app's catalog on it.
    const BARE = { 'mp3/0001.mp3': 'ton', 'advert/0001.mp3': 'werbung', '01/001.mp3': 'eins', '01/002.mp3': 'zwei' };

    async function downloadBareAndClose() {
      const first = reading(BARE);
      await openSnapshot(first);
      expect(card.value?.catalog).toBeFalsy();
      await addFolder('02', { '001.mp3': 'album a' });
      const { blob, manifest } = await makePackage('changes');
      startPackageDownload(blob, manifest);
      closeCard();
      return { first, blob, manifest };
    }

    it('does not lock another card without a catalog', async () => {
      await downloadBareAndClose();
      // Another box's card, also without a catalog: other folders, other files.
      await openSnapshot(reading({ 'mp3/0001.mp3': 'ton', '01/001.mp3': 'anderes hörspiel', '03/001.mp3': 'musik' }, 'PAUL', 5000));
      expect(packageState.value.kind).toBe('clean');
      expect(canChangeCard()).toBe(true);
      await addFolder('02', { '001.mp3': 'pauls album' });
      expect(plan.value?.changes.map((c) => [c.kind, c.name])).toEqual([['add', '02']]);
      // The Paket still waits for its own card.
      expect(stored.size).toBe(1);
    });

    it('does not lock a card that has the same folders with other files', async () => {
      await downloadBareAndClose();
      await openSnapshot(reading({ ...BARE, '01/002.mp3': 'zwei, aber länger' }, 'TONUINO', 5000));
      expect(packageState.value.kind).toBe('clean');
    });

    it('still waits on its own card, read again before unpacking', async () => {
      await downloadBareAndClose();
      await openSnapshot(reading(BARE, 'TONUINO', 5000));
      expect(packageState.value.kind).toBe('downloaded');
      expect(canChangeCard()).toBe(false);
    });

    it('lets go of its own card once unpacked, and waits while the user deletes what the Paket replaces', async () => {
      const first = reading(BARE);
      await openSnapshot(first);
      // A new version of a track in 01: the Paket replaces the whole folder, so 01 is deleted first.
      await (await root().dir('01')).write('002.mp3', enc.encode('zwei, neu aufgenommen'));
      const { blob, manifest } = await makePackage('changes');
      expect(manifest.deleteFirst).toEqual(['01']);
      startPackageDownload(blob, manifest);
      closeCard();
      // 01 deleted, the Paket not unpacked yet: still the same card.
      const deleted = cloneTree(first.root);
      deleted.children = deleted.children.filter((c) => c.name !== '01');
      await openSnapshot(await readAgain(deleted, 5000));
      expect(packageState.value.kind).toBe('downloaded');
      closeCard();
      // Unpacked: the card holds the Paket and it is forgotten.
      await openSnapshot(await readAgain(await unpacked(first.root, blob, manifest.deleteFirst), 6000));
      expect(packageState.value.kind).toBe('clean');
      expect(stored.size).toBe(0);
    });

    it('does not take a card without that folder for its own when the Paket does not delete it', async () => {
      await downloadBareAndClose();
      const { '01/001.mp3': _a, '01/002.mp3': _b, ...rest } = BARE;
      await openSnapshot(reading(rest, 'TONUINO', 5000));
      expect(packageState.value.kind).toBe('clean');
    });

    it('can be thrown away on its own card', async () => {
      await downloadBareAndClose();
      await openSnapshot(reading(BARE, 'TONUINO', 5000));
      discardPackage();
      expect(canChangeCard()).toBe(true);
      expect(stored.size).toBe(0);
    });

    it('forgets an old record without a fingerprint only for its catalog id, not for every card without one', async () => {
      await downloadBareAndClose();
      const rec = JSON.parse(stored.get('tonuino-studio:waiting-package')!) as Record<string, unknown>;
      expect(rec.v).toBe(2);
      stored.set('tonuino-studio:waiting-package', JSON.stringify({ ...rec, v: 1, print: undefined }));
      await openSnapshot(reading({ '05/001.mp3': 'fremd' }, 'FREMD', 5000));
      expect(packageState.value.kind).toBe('clean');
    });
  });

  it('waits on a formatted card for a whole-card Paket', async () => {
    await openSnapshot(reading(CARD));
    const { blob, manifest } = await makePackage('full');
    startPackageDownload(blob, manifest);
    closeCard();
    await openSnapshot(reading({ '.Trashes/501/x': 'müll' }, 'TONUINO', 5000));
    expect(packageState.value.kind).toBe('downloaded');
  });
});
