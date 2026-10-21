/**
 * Testlabor, SD-Kartenleser (TODO #69): the app's card code, from the
 * desktop bridge up, on real FAT32 and exFAT images (sd/simcard.ts). Every
 * card is checked with fsck.fat after the app wrote to it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { boot, card, closeCard, ejectCard, fixCardAccess, rescan, runRepair, updateCatalog } from '../../src/app/state';
import { checkHealth } from '../../src/core/tonuino/health';
import { planFix } from '../../src/core/tonuino/repair';
import { thoroughCheck } from '../../src/core/tonuino/thorough';
import { isJunk } from '../../src/core/tonuino/sd';
import type { Platform } from '../../src/platform/types';
import { monoMp3 } from '../audio/fixtures';
import { concat } from '../audio/helpers';
import { has, laborOn, scratch, skipNote, sleep } from './labor';
import { SimCard, SimReader, type FormatOptions } from './sd/simcard';
import { listDir, readFile } from './sd/fat';

const tools = laborOn && has('mformat', ['--version']) && has('fsck.fat', ['--help']);
if (laborOn && !tools) skipNote('SD-Karten', 'mtools oder dosfstools fehlen (apt-get install mtools dosfstools)');
const exfatTool = laborOn && has('mkfs.exfat', ['-V']);
if (laborOn && tools && !exfatTool) skipNote('SD-Karten', 'exFAT: mkfs.exfat fehlt (apt-get install exfatprogs)');

// No IndexedDB in Node: the app's local library (restoreFromLibrary) finds nothing, as on a new computer.
(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= { bound: () => undefined };

const mp3 = monoMp3();
const enc = new TextEncoder();

let tmp: { dir: string; drop: () => void };
let reader: SimReader;
const made: SimCard[] = [];

function newCard(name: string, o: FormatOptions & { mountPath?: string; fsType?: string; totalBytes?: number }): SimCard {
  const image = join(tmp.dir, `${name}.img`);
  SimCard.format(image, o);
  const c = new SimCard({ image, mountPath: o.mountPath ?? `/media/ben/${name}`, fsType: o.fsType, totalBytes: o.totalBytes });
  made.push(c);
  return c;
}

/** A card as the box knows it: system sounds, two folders. */
function boxCard(name: string, mib = 64): SimCard {
  const c = newCard(name, { mib, label: 'TONUINO' });
  for (const n of ['0262', '0300', '0400']) c.put(`mp3/${n}.mp3`, mp3);
  c.put('advert/0001.mp3', mp3);
  for (const n of ['001', '002', '003']) c.put(`01/${n}.mp3`, mp3);
  c.put('02/001.mp3', mp3);
  return c;
}

function platformOf(r: SimReader): Platform {
  return { os: 'linux', volumes: r.volumes, capabilities: { sdAutoDetect: true } } as unknown as Platform;
}

async function until(test: () => boolean, ms = 10_000, what = 'Zustand'): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`${what} nicht erreicht`);
    await sleep(20);
  }
}

async function ready(): Promise<void> {
  await until(() => card.value?.status === 'ready' || card.value?.status === 'error', 30_000, 'Karte geöffnet');
  if (card.value?.status === 'error') throw new Error(`Karte nicht lesbar: ${card.value.error}`);
}
const issueIds = () => card.value?.report?.issues.map((i) => i.id) ?? [];
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error & { code?: string });

describe.skipIf(!tools)('Testlabor: SD-Kartenleser', () => {
  beforeAll(() => {
    tmp = scratch('sd');
  });
  afterAll(() => {
    for (const c of made) c.dispose();
    tmp?.drop();
  });
  afterEach(async () => {
    closeCard();
    // Let the last volume events and catalog writes settle before the next reader.
    await sleep(50);
  });

  it('neue leere FAT32-Karte: öffnet von selbst, Katalog landet auf der Karte, fsck sauber', async () => {
    reader = new SimReader();
    const c = newCard('LEER', { mib: 64 });
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    expect(card.value?.scan?.kind).toBe('empty');
    expect(card.value?.info.fsType).toBe('vfat');
    expect(issueIds()).not.toContain('fs-type');
    await updateCatalog((cat) => {
      cat.name = 'Labor-Box';
    });
    expect(c.names()).toEqual(['tonuino-studio.json']);
    expect(JSON.parse(new TextDecoder().decode(readFile(c.image, 'tonuino-studio.json'))).name).toBe('Labor-Box');
    // Written again: replaced in place, no helper file left, same slot.
    await updateCatalog((cat) => {
      cat.name = 'Labor-Box 2';
    });
    expect(c.names()).toEqual(['tonuino-studio.json']);
    expect(c.fsck()).toBe('');
  });

  it('Datum-Rundung: FAT speichert Zeiten in 2-s-Schritten, der Browser-Check schlägt nicht falsch an', async () => {
    reader = new SimReader();
    const c = boxCard('ZEIT');
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    await updateCatalog((cat) => {
      cat.name = 'Zeit';
    });
    const scan = (await rescan())!;
    expect(scan.catalogTime! % 2000).toBe(0);
    expect(scan.fileTimes.every((t) => t % 2000 === 0)).toBe(true);
    // What the web app sees on the same card: no file system named, times straight from the card.
    const web = checkHealth(scan, { profile: 'tng', volume: { removable: true, fileTimesFromCard: true }, trustsDirectoryOrder: true, foldersWithRangeCards: new Set() } as never);
    expect(web.issues.map((i) => i.id)).not.toContain('fs-type');
    // Control: times off the two-second grid (exFAT, NTFS) are noticed.
    const odd = { ...scan, catalogTime: scan.catalogTime! + 1010 };
    const warned = checkHealth(odd, { profile: 'tng', volume: { removable: true, fileTimesFromCard: true }, trustsDirectoryOrder: true, foldersWithRangeCards: new Set() } as never);
    expect(warned.issues.map((i) => i.id)).toContain('fs-type');
  });

  it('Mac-Müll und Windows-Müll: erkannt, beim Aufräumen entfernt, Titel zählen richtig', async () => {
    reader = new SimReader();
    const c = boxCard('MAC');
    c.put('01/._001.mp3', new Uint8Array(4096));
    c.put('01/._002.mp3', new Uint8Array(4096));
    c.put('.DS_Store', new Uint8Array(6148));
    c.put('.Spotlight-V100/Store-V2/x', 'x');
    c.put('.fseventsd/fseventsd-uuid', 'x');
    c.put('.Trashes/501/a', 'x');
    c.put('._.Trashes', new Uint8Array(4096));
    c.put('System Volume Information/IndexerVolumeGuid', 'x');
    c.put('02/Thumbs.db', 'x');
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    const scan = card.value!.scan!;
    expect(scan.kind).toBe('tonuino');
    expect(scan.folders.find((f) => f.number === 1)?.tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    const junk = card.value!.report!.issues.find((i) => i.fix?.kind === 'clean-junk');
    expect(junk).toBeTruthy();
    await runRepair(planFix(scan, junk!.fix!), { kind: 'repair' });
    const left = [...c.names(), ...c.names('01').map((n) => `01/${n}`), ...c.names('02').map((n) => `02/${n}`)].filter(isJunk);
    expect(left).toEqual([]);
    expect(c.fsck()).toBe('');
  });

  it('Mac-Müll beim Auswerfen: macOS legt ihn neu an, „Auswerfen“ räumt ihn weg', async () => {
    reader = new SimReader();
    const c = boxCard('AUSWURF');
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    // The card went through a Mac meanwhile.
    c.put('.fseventsd/fseventsd-uuid', 'x');
    c.put('01/._003.mp3', new Uint8Array(4096));
    const note = await ejectCard();
    expect(note).toBeTruthy();
    expect(c.names().filter(isJunk)).toEqual([]);
    expect(c.names('01')).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(card.value).toBeNull();
    expect(c.fsck()).toBe('');
  });

  it('FAT-Reihenfolge: falsch einsortierte Titel werden gemeldet und auf der Karte neu geordnet', async () => {
    reader = new SimReader();
    const c = newCard('ORDNUNG', { mib: 64 });
    c.put('mp3/0262.mp3', mp3);
    // Copied in the wrong order (a file manager sorting by size, or by hand).
    for (const n of ['003', '001', '002']) c.put(`01/${n}.mp3`, concat([mp3, enc.encode(n)]));
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    const issue = card.value!.report!.issues.find((i) => i.fix?.kind === 'rebuild-order');
    expect(issue?.folder).toBe(1);
    const run = await runRepair(planFix(card.value!.scan!, issue!.fix!), { kind: 'order' });
    expect(run.result.error).toBeUndefined();
    expect(run.result.skipped).toEqual([]);
    expect(c.names('01')).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    // The content went with its number.
    for (const n of ['001', '002', '003']) expect(new TextDecoder().decode(readFile(c.image, `01/${n}.mp3`).slice(-3))).toBe(n);
    expect(issueIds().some((id) => id.startsWith('order:'))).toBe(false);
    expect(c.fsck()).toBe('');
  });

  it('schreibgeschützte Karte (Schieber): Schreiben scheitert mit klarer Meldung, die Karte bleibt unberührt', async () => {
    reader = new SimReader();
    const c = boxCard('SPERRE');
    c.readOnly = true;
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    expect(card.value?.info).toMatchObject({ readOnly: true, writable: false });
    const before = c.names();
    const err = await failure(updateCatalog((cat) => (cat.name = 'x')));
    expect(err?.code).toBe('read-only');
    expect(err?.message).toMatch(/schreibgeschützt/);
    expect(c.names()).toEqual(before);
    // Ejecting does not try to tidy a locked card.
    const writes = c.log.filter((cmd) => /write|remove|rename|mkdir/.test(cmd)).length;
    await ejectCard();
    expect(c.log.filter((cmd) => /write|remove|rename|mkdir/.test(cmd)).length).toBe(writes);
  });

  it('Karte für root eingehängt: Schreiben verweigert, „Schreibrechte holen“ hilft, danach geht es', async () => {
    reader = new SimReader();
    const c = boxCard('ROOT');
    c.foreignOwner = true;
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    expect(card.value?.info).toMatchObject({ foreignOwner: true, canFixAccess: true, writable: false });
    const err = await failure(updateCatalog((cat) => (cat.name = 'x')));
    expect(err?.code).toBe('permission');
    expect(err?.message).toMatch(/Schreibrechte/);
    await until(() => !!card.value?.writeDenied, 2000, '„Schreibrechte fehlen“ gemerkt');
    await fixCardAccess();
    await ready();
    await updateCatalog((cat) => {
      cat.name = 'Jetzt geht es';
    });
    expect(c.names()).toContain('tonuino-studio.json');
    expect(c.fsck()).toBe('');
  });

  it('große Platte ohne TonUINO (1 TB, NTFS über FUSE, Monatsordner 01–12) wird nicht als Box-Karte geöffnet', async () => {
    reader = new SimReader();
    const disk = newCard('Fotos', { mib: 64, fsType: 'fuseblk', totalBytes: 1_000_204_886_016, mountPath: '/media/ben/Fotos' });
    for (let m = 1; m <= 12; m++) disk.put(`${String(m).padStart(2, '0')}/IMG_${1000 + m}.JPG`, 'jpeg');
    disk.put('DCIM/100CANON/IMG_0001.JPG', 'jpeg');
    disk.put('Dokumente/Steuer.pdf', '%PDF');
    reader.insert(disk);
    boot(platformOf(reader));
    await sleep(500);
    expect(card.value).toBeNull();
    // With the real card plugged in too, the app opens the card, never the disk.
    const sd = boxCard('SD');
    reader.insert(sd);
    await ready();
    expect(card.value?.volume.id).toBe('/media/ben/SD');
  });

  it('große exFAT-Platte mit fremden Ordnern und eine ext4-Platte werden nicht von selbst geöffnet', async () => {
    reader = new SimReader();
    const big = newCard('Backup', { mib: 64, fsType: 'exfat', totalBytes: 2_000_398_934_016 });
    big.put('Musik/Lied.mp3', mp3);
    big.put('Filme/a.mkv', 'x');
    const linux = newCard('Daten', { mib: 64, fsType: 'ext4', totalBytes: 937_000_000_000 });
    linux.put('tonuino-studio.json', '{}');
    linux.put('01/001.mp3', mp3);
    reader.insert(big);
    reader.insert(linux);
    boot(platformOf(reader));
    await sleep(500);
    expect(card.value).toBeNull();
  });

  it('volle Karte: neuer Titel und Katalog scheitern mit „kein Platz“, nichts Halbes bleibt, der alte Katalog bleibt heil', async () => {
    reader = new SimReader();
    const c = boxCard('VOLL', 34);
        reader.insert(c);
    boot(platformOf(reader));
    await ready();
    await updateCatalog((cat) => {
      cat.name = 'Alt';
    });
    const oldCatalog = readFile(c.image, 'tonuino-studio.json');
    // Fill the card up to the last cluster.
    const free = (await reader.volumes.info(card.value!.volume)).freeBytes!;
    c.put('Film.mkv', new Uint8Array(free));
    const info = await reader.volumes.info(card.value!.volume);
    expect(info.freeBytes).toBe(0);
    const dir = await card.value!.volume.root.dir('02');
    const err = await failure(dir.write('002.mp3', concat(Array.from({ length: 40 }, () => mp3))));
    expect(err?.code).toBe('no-space');
    expect(err?.message).toMatch(/kein Platz/);
    expect(c.names('02')).toEqual(['001.mp3']);
    const err2 = await failure(updateCatalog((cat) => (cat.name = 'Neu')));
    expect(err2?.code).toBe('no-space');
    expect(readFile(c.image, 'tonuino-studio.json')).toEqual(oldCatalog);
    expect(c.names().filter((n) => n.endsWith('.tonuino-tmp'))).toEqual([]);
    expect(c.fsck()).toBe('');
  });

  it('Karte mitten im Schreiben gezogen: Fehler sagt es, der halbe Titel fällt beim nächsten Öffnen auf', async () => {
    reader = new SimReader();
    const c = boxCard('GEZOGEN');
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    // About 9 MB: three chunks of 4 MiB; the card goes after the first.
    const big = concat(Array.from({ length: Math.ceil(9_000_000 / mp3.length) }, () => mp3));
    c.pullAfterChunks = 1;
    const dir = await card.value!.volume.root.dir('02');
    const err = await failure(dir.write('002.mp3', big));
    expect(err?.code).toBe('io');
    expect(err?.message).toMatch(/herausgezogen/);
    // As the add session does: remove the half file (fails, the card is gone).
    await dir.remove('002.mp3').catch(() => undefined);
    reader.remove(c);
    await until(() => card.value === null, 2000, 'Karte geschlossen');
    // Back in the reader: the first 4 MiB are on the card as 02/002.mp3, with the marker of the unfinished write.
    reader.insert(c);
    await ready();
    const half = listDir(c.image, '02').find((e) => e.name === '002.mp3');
    expect(half?.size).toBe(4 * 1024 * 1024);
    expect(c.names('02')).toEqual(['001.mp3', '002.mp3', '002.mp3.tonuino-open']);
    const scan = card.value!.scan!;
    expect(scan.folders.find((f) => f.number === 2)!.unfinished).toEqual(['002.mp3']);
    // The quick check reports it, "Gründlich prüfen" calls it broken.
    const issue = checkHealth(scan, { profile: 'tng', trustsDirectoryOrder: true }).issues.find((i) => i.id === 'unfinished-tracks:02');
    expect(issue?.items).toEqual(['02/002.mp3']);
    const thorough = await thoroughCheck(card.value!.volume.root, scan);
    expect(thorough.damaged).toContainEqual({ folder: 2, folderName: '02', file: '002.mp3' });
    // The repair deletes file and marker; written again, the track is whole.
    await runRepair(planFix(scan, issue!.fix!), { kind: 'repair' });
    expect(c.names('02')).toEqual(['001.mp3']);
    await (await card.value!.volume.root.dir('02')).write('002.mp3', big);
    expect(c.names('02')).toEqual(['001.mp3', '002.mp3']);
    expect(c.fsck()).toBe('');
  });

  it('langsamer Kartenleser: die Karte öffnet trotzdem, mit Fortschritt', async () => {
    reader = new SimReader();
    const c = boxCard('LANGSAM');
    for (let f = 3; f <= 8; f++) c.put(`${String(f).padStart(2, '0')}/001.mp3`, mp3);
    c.delayMs = 40;
    reader.insert(c);
    let progress = 0;
    boot(platformOf(reader));
    await until(() => {
      if (card.value?.progress) progress++;
      return card.value?.status === 'ready';
    }, 30_000);
    expect(progress).toBeGreaterThan(0);
    expect(card.value!.scan!.folders).toHaveLength(8);
  });

  it.skipIf(!exfatTool)('neue 64-GB-Karte mit exFAT (wie gekauft): öffnet, sagt klar, dass die Box FAT32 braucht', async () => {
    reader = new SimReader();
    const c = newCard('SDXC', { mib: 64 * 1024, fs: 'exfat', label: 'SDXC' });
    reader.insert(c);
    boot(platformOf(reader));
    await ready();
    expect(card.value?.info).toMatchObject({ fsType: 'exfat', clusterSize: 131072 });
    expect(card.value?.scan?.kind).toBe('empty');
    const fsIssue = card.value!.report!.issues.find((i) => i.id === 'fs-type');
    expect(fsIssue?.severity).toBe('error');
    expect(fsIssue?.detail).toMatch(/32 GB/);
    expect(issueIds()).toContain('size');
  });
});
