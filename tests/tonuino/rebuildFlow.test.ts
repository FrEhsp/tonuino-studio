import { describe, expect, it } from 'vitest';
import { loadCatalog, newCatalog, serializeCatalog } from '../../src/core/tonuino/catalog';
import { BACKUP_MANIFEST, copyEntries, CopyError, entryPath, judgeTarget, markRestoreStarted, planBackup, readBackupManifest, restoreOrder, type BackupManifest } from '../../src/core/tonuino/rebuild';
import { CATALOG_FILE, scanSd } from '../../src/core/tonuino/sd';
import { backupErrorText, canRestoreTo, copyErrorText, isDiskFull, restoreErrorText, sizeAndTime, verdictText } from '../../src/features/box/rebuildTexts';
import { checkTarget, checkTargetAgain, PlaceError, prepareBackupPlace, readCardForBackup, runBackup, TARGET_RECHECK_MS, targetCandidates, tidyAfterRestore, type TargetMemo } from '../../src/features/box/rebuildFlow';
import { memDir, type MemTree } from '../../src/platform/memory';
import type { Dir, FolderInfo, Volume, VolumeInfo } from '../../src/platform/types';
import { WrapDir } from './dirwrap';

const catalog = { ...newCatalog('Emmas Box'), id: 'karte-1' };

function card(): MemTree {
  return {
    mp3: { '0001.mp3': 'ansage-1' },
    advert: { '0001.mp3': 'werbung-1' },
    '01': { '001.mp3': 'eins-eins', '002.mp3': 'zwei-eins' },
    '02': { '001.mp3': 'eins-zwei' },
    Fotos: { 'urlaub.jpg': 'x' },
    [CATALOG_FILE]: serializeCatalog(catalog),
  };
}

const FAT: VolumeInfo = { fsType: 'vfat', clusterSize: 32768, totalBytes: 16e9, freeBytes: 15e9, removable: true };

function volume(root: Dir, info: VolumeInfo = FAT, extra: Partial<Volume> = {}): Volume {
  return { id: root.name, label: root.name, root, info, canEject: true, ...extra };
}

/** A platform stub: the card lives under /media/SD, everything else on the computer. */
function platformStub(o: { onCard?: Dir[]; free?: number } = {}) {
  return {
    isWithin: async (inner: Dir, outer: Dir) => (o.onCard ?? []).includes(inner) || inner === outer,
    folderInfo: async (d: Dir): Promise<FolderInfo> =>
      (o.onCard ?? []).includes(d) ? { mountPath: '/media/SD', freeBytes: 1e9 } : { mountPath: `/drive/${d.name}`, freeBytes: o.free ?? 100e9 },
  };
}

async function backup(cardDir: Dir = memDir(card())): Promise<{ manifest: BackupManifest; dir: Dir }> {
  const parent = memDir({}, 'Dokumente');
  const { entries } = await readCardForBackup(cardDir);
  const place = await prepareBackupPlace(platformStub(), parent, cardDir, { boxName: 'Emmas Box', catalogId: 'karte-1', bytes: 100, now: new Date(2026, 9, 6) });
  const manifest = await runBackup(cardDir, place, entries, { boxName: 'Emmas Box', catalogId: 'karte-1' });
  return { manifest, dir: place.dir };
}

describe('prepareBackupPlace', () => {
  it('makes a dated folder for the box in the chosen folder', async () => {
    const parent = memDir({}, 'Dokumente');
    const place = await prepareBackupPlace(platformStub(), parent, memDir(card()), { boxName: 'Emmas Box', catalogId: 'karte-1', bytes: 100, now: new Date(2026, 9, 6) });
    expect(place.name).toBe('TonUINO-Sicherung Emmas Box 06.10.2026');
    expect(place.resumed).toBe(false);
    expect(await parent.exists(place.name)).toBe(true);
  });

  it('refuses a folder on the card: it would be gone after formatting', async () => {
    const cardDir = memDir(card());
    const inside = await cardDir.dir('Fotos');
    const err = await prepareBackupPlace(platformStub(), cardDir, cardDir, { boxName: 'B', catalogId: 'karte-1', bytes: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaceError);
    expect((err as Error).message).toMatch(/liegt auf der SD-Karte.*Computer/);
    // Same drive, told by the mount path (desktop), although not inside the opened folder.
    const err2 = await prepareBackupPlace(platformStub({ onCard: [inside, cardDir] }), inside, memDir({}, 'anders'), { boxName: 'B', catalogId: 'x', bytes: 1 }).catch((e) => e);
    expect(err2).toBeInstanceOf(PlaceError);
  });

  it('says so when the drive is too small', async () => {
    const err = await prepareBackupPlace(platformStub({ free: 2 * 1024 ** 3 }), memDir({}, 'D'), memDir(card()), { boxName: 'B', catalogId: 'k', bytes: 5 * 1024 ** 3 }).catch((e) => e);
    expect((err as Error).message).toBe('Auf diesem Laufwerk ist zu wenig Platz. Die Sicherung braucht 5 GB, frei sind 2 GB. Wähle einen Ordner auf einem anderen Laufwerk oder mache dort Platz.');
  });

  it('goes on with an unfinished backup of the same card and leaves other folders alone', async () => {
    const cardDir = memDir(card());
    const parent = memDir({ 'TonUINO-Sicherung Emmas Box 06.10.2026': { 'notiz.txt': 'fremd' } }, 'Dokumente');
    const opts = { boxName: 'Emmas Box', catalogId: 'karte-1', bytes: 100, now: new Date(2026, 9, 6) };
    const first = await prepareBackupPlace(platformStub(), parent, cardDir, opts);
    expect(first.name).toBe('TonUINO-Sicherung Emmas Box 06.10.2026 (2)');
    // Stopped after two files.
    const { entries } = await readCardForBackup(cardDir);
    const ctl = new AbortController();
    await copyEntries(cardDir, first.dir, entries, {
      backup: { boxName: 'Emmas Box', catalogId: 'karte-1' },
      signal: ctl.signal,
      onProgress: (p) => p.files === 2 && ctl.abort(),
    }).catch(() => undefined);
    const again = await prepareBackupPlace(platformStub(), parent, cardDir, opts);
    expect(again).toMatchObject({ name: first.name, resumed: true });
    // Another card's backup is never continued.
    const other = await prepareBackupPlace(platformStub(), parent, cardDir, { ...opts, catalogId: 'karte-2' });
    expect(other).toMatchObject({ name: 'TonUINO-Sicherung Emmas Box 06.10.2026 (3)', resumed: false });
  });

  it('backs up without touching the card', async () => {
    const log: string[] = [];
    const cardDir = new WrapDir(memDir(card()), log, { noRemove: true });
    const { manifest, dir } = await backup(cardDir);
    expect(manifest.complete).toBe(true);
    expect(log).toEqual([]);
    expect(await dir.exists(BACKUP_MANIFEST)).toBe(true);
    expect((await readBackupManifest(dir))?.files).toEqual(manifest.files);
    expect(manifest.files.map((f) => f.path).sort()).toEqual(['01/001.mp3', '01/002.mp3', '02/001.mp3', 'advert/0001.mp3', 'mp3/0001.mp3', CATALOG_FILE]);
  });
});

describe('checkTarget: the card after formatting', () => {
  it('finds the empty FAT card ready', async () => {
    const { manifest } = await backup();
    const empty = memDir({ 'System Volume Information': { IndexerVolumeGuid: 'x' } }, 'NO NAME');
    const c = await checkTarget(volume(empty), manifest, FAT);
    expect(c.judgement.verdict).toBe('ok');
    expect(c.plan?.entries.map(entryPath)).toEqual(restoreOrder(manifest.files).map(entryPath));
  });

  it('refuses an exFAT card and names its format', async () => {
    const { manifest } = await backup();
    const c = await checkTarget(volume(memDir({}, 'SD')), manifest, { ...FAT, fsType: 'exfat', totalBytes: 64e9 });
    expect(c.judgement).toMatchObject({ verdict: 'not-fat', fsType: 'exfat', big: true });
    expect(c.plan).toBeDefined();
  });

  it('refuses the card when it still holds its old content (not formatted yet)', async () => {
    const original = memDir(card());
    const { manifest } = await backup(original);
    const c = await checkTarget(volume(original), manifest, FAT);
    expect(c.judgement.verdict).toBe('not-empty');
    expect(c.judgement.items).toEqual(['Fotos/']);
  });

  it('refuses the card when it holds the same folders filled again', async () => {
    const { manifest } = await backup();
    const c = await checkTarget(volume(memDir({ '01': { '005.mp3': 'x' } })), manifest, FAT);
    expect(c.judgement.verdict).toBe('not-empty');
  });

  it('goes on with a restore that stopped', async () => {
    const { manifest: before, dir } = await backup();
    const manifest = await markRestoreStarted(dir, before, 1234);
    expect((await readBackupManifest(dir))?.restoreStartedAt).toBe(1234);
    const target = memDir({}, 'NEU');
    const first = restoreOrder(manifest.files).slice(0, 3);
    await copyEntries(dir, target, first, { expected: manifest.files });
    const c = await checkTarget(volume(target), manifest, FAT);
    expect(c.judgement.verdict).toBe('resume');
  });

  it('knows the old card put back without formatting, even when nothing else is on it', async () => {
    const tidy = card();
    delete tidy.Fotos;
    const original = memDir(tidy);
    const { manifest } = await backup(original);
    const c = await checkTarget(volume(original), manifest, FAT);
    expect(c.judgement.verdict).toBe('not-formatted');
  });

  it('knows when the card is too small and when its format is unknown', async () => {
    const { manifest } = await backup();
    const small = await checkTarget(volume(memDir()), manifest, { fsType: 'FAT32', freeBytes: 1000 });
    expect(small.judgement).toMatchObject({ verdict: 'too-small', free: 1000 });
    expect(small.judgement.need).toBeGreaterThan(1000);
    const web = await checkTarget(volume(memDir()), manifest, {});
    expect(web.judgement).toMatchObject({ verdict: 'ok', fsUnknown: true });
  });
});

describe('checkTarget: the old card', () => {
  it('names what the backup left out instead of only saying format, and never asks to format it when moving', async () => {
    const original = memDir(card());
    const { manifest } = await backup(original);
    const c = await checkTarget(volume(original), manifest, FAT);
    expect(c.judgement.verdict).toBe('not-empty');
    expect(c.sameBox).toBe(true);
    const rebuild = verdictText(c.judgement, { start: 'rebuild', oldCard: c.sameBox });
    expect(rebuild).toContain('Nicht in der Sicherung: „Fotos“.');
    expect(rebuild).toContain('Kopiere das vorher selbst');
    const move = verdictText(c.judgement, { start: 'move', oldCard: c.sameBox });
    expect(move).toBe('Das ist noch die alte Karte. Nimm sie heraus und stecke die neue Karte ein.');
    expect(move).not.toMatch(/Formatier/);
    // A new card with something on it is not the old one.
    const other = await checkTarget(volume(memDir({ Fotos: { 'a.jpg': 'x' } }, 'NEU')), manifest, FAT);
    expect(other.sameBox).toBe(false);
    expect(verdictText(other.judgement, { start: 'move', oldCard: other.sameBox })).toMatch(/Formatiere sie zuerst/);
  });

  it('is not offered to go on with after a restore elsewhere stopped', async () => {
    const tidy = card();
    delete tidy.Fotos;
    const original = memDir(tidy);
    const { manifest: before, dir } = await backup(original);
    // Writing back to the new card began and stopped.
    const manifest = await markRestoreStarted(dir, before, 1234);
    const fresh = memDir({}, 'NEU');
    await copyEntries(dir, fresh, restoreOrder(manifest.files).slice(0, 2), { expected: manifest.files });
    expect((await checkTarget(volume(fresh), manifest, FAT)).judgement.verdict).toBe('resume');
    // The untouched old card holds all of it: nothing to go on with.
    const old = await checkTarget(volume(original), manifest, FAT);
    expect(old.judgement.verdict).toBe('not-formatted');
    expect(canRestoreTo(old.judgement)).toBe(false);
    expect(old.sameBox).toBe(true);
    expect(verdictText(old.judgement, { start: 'move', oldCard: true })).toBe('Das ist noch die alte Karte. Nimm sie heraus und stecke die neue Karte ein.');
    expect(verdictText(old.judgement, { start: 'restore' })).toMatch(/schon alles aus der Sicherung/);
  });
});

/** A card that counts how often any of its folders is listed. */
function counting(d: Dir, n: { lists: number }): Dir {
  return new Proxy(d, {
    get(target, prop, receiver) {
      if (prop === 'list') return () => (n.lists++, target.list());
      if (prop === 'dir') return async (name: string, o?: { create?: boolean }) => counting(await target.dir(name, o), n);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('checkTargetAgain: watching the drives every few seconds', () => {
  it('reads the old card through once, then only its root until something changes', async () => {
    const tidy = card();
    delete tidy.Fotos;
    const original = memDir(tidy, 'ALT');
    const { manifest } = await backup(original);
    const n = { lists: 0 };
    const v = volume(counting(original, n));
    const memo = new Map<string, TargetMemo>();
    const first = await checkTargetAgain(v, manifest, FAT, memo, { now: 0 });
    expect(first.judgement.verdict).toBe('not-formatted');
    expect(n.lists).toBeGreaterThan(3);

    // Every 4 seconds for most of a minute: one listing of the root each time.
    for (let t = 4000; t < TARGET_RECHECK_MS; t += 4000) {
      n.lists = 0;
      const again = await checkTargetAgain(v, manifest, FAT, memo, { now: t });
      expect(n.lists).toBe(1);
      expect(again.judgement).toEqual(first.judgement);
    }

    // After a while, or when the window comes back to the front, all of it again.
    n.lists = 0;
    await checkTargetAgain(v, manifest, FAT, memo, { now: TARGET_RECHECK_MS + 1000 });
    expect(n.lists).toBeGreaterThan(3);
    n.lists = 0;
    await checkTargetAgain(v, manifest, FAT, memo, { now: TARGET_RECHECK_MS + 2000, force: true });
    expect(n.lists).toBeGreaterThan(3);
  });

  it('sees at once that the card was formatted or another file system came', async () => {
    const tidy = card();
    delete tidy.Fotos;
    const original = memDir(tidy, 'ALT');
    const { manifest } = await backup(original);
    const memo = new Map<string, TargetMemo>();
    const v = volume(original);
    expect((await checkTargetAgain(v, manifest, FAT, memo, { now: 0 })).judgement.verdict).toBe('not-formatted');
    // Formatted: the same drive, now empty.
    for (const e of await original.list()) await original.remove(e.name, { recursive: true });
    expect((await checkTargetAgain(v, manifest, FAT, memo, { now: 4000 })).judgement.verdict).toBe('ok');
    // Formatted as exFAT this time.
    const exfat = await checkTargetAgain(v, manifest, { ...FAT, fsType: 'exfat', totalBytes: 64e9 }, memo, { now: 8000 });
    expect(exfat.judgement.verdict).not.toBe('ok');
  });
});

describe('judgeTarget', () => {
  const plan = { ok: true as const, entries: [], files: 0, bytes: 0, resume: false, present: 0 };
  it('reads the format names of every system', () => {
    for (const fs of ['vfat', 'FAT32', 'msdos', 'fat16']) expect(judgeTarget({ fsType: fs }, plan).verdict).toBe('ok');
    for (const fs of ['exfat', 'exFAT', 'NTFS', 'apfs']) expect(judgeTarget({ fsType: fs }, plan).verdict).toBe('not-fat');
  });
  it('notes small clusters but lets them pass', () => {
    expect(judgeTarget({ fsType: 'vfat', clusterSize: 4096 }, plan)).toMatchObject({ verdict: 'ok', smallClusters: true });
    expect(judgeTarget({ fsType: 'vfat', clusterSize: 32768 }, plan).smallClusters).toBe(false);
  });
  it('says when the backup is not finished', () => {
    expect(judgeTarget(FAT, { ok: false, reason: 'incomplete' }).verdict).toBe('incomplete');
  });
});

describe('prepareBackupPlace: a backup folder chosen itself', () => {
  it('refuses a finished backup as the place for a new one', async () => {
    const { dir } = await backup();
    const err = await prepareBackupPlace(platformStub(), dir, memDir(card()), { boxName: 'Emmas Box', catalogId: 'karte-1', bytes: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaceError);
    expect((err as Error).message).toMatch(/schon eine fertige Sicherung/);
    expect((await dir.list()).filter((e) => e.kind === 'directory' && e.name.startsWith('TonUINO-Sicherung'))).toEqual([]);
  });
});

describe('targetCandidates', () => {
  it('keeps removable cards only, no copies read once in the browser', () => {
    const a = volume(memDir({}, 'A'));
    const b = volume(memDir({}, 'B'), { ...FAT, removable: false });
    const c = volume(memDir({}, 'C'), FAT, { access: 'snapshot' });
    const d = volume(memDir({}, 'D'), {});
    expect(targetCandidates([a, b, c, d]).map((v) => v.id)).toEqual(['A', 'D']);
  });
});

describe('tidyAfterRestore', () => {
  it('removes what the computer left on the card meanwhile and keeps the rest', async () => {
    const { manifest, dir } = await backup();
    const target = memDir({}, 'NEU');
    const plan = (await checkTarget(volume(target), manifest, FAT)).plan!;
    await copyEntries(dir, target, plan.entries, { expected: manifest.files });
    await (await target.dir('01')).write('._001.mp3', new Uint8Array([1]));
    await target.write('.DS_Store', new Uint8Array([1]));
    const report = await tidyAfterRestore(volume(target), (c) => ({ profile: c?.profile ?? 'tng', trustsDirectoryOrder: true }), false);
    expect(report.issues.some((i) => i.fix?.kind === 'clean-junk')).toBe(false);
    expect(await target.exists('.DS_Store')).toBe(false);
    expect(await (await target.dir('01')).exists('._001.mp3')).toBe(false);
    const scan = await scanSd(target);
    expect(scan.folders.map((f) => f.number)).toEqual([1, 2]);
    expect(planBackup(scan, await target.list()).length).toBe(manifest.files.length);
  });
});

describe('tidyAfterRestore: the format seen on the old card', () => {
  it('forgets that FAT32 was confirmed: that was the old card, not this one', async () => {
    const checked = card();
    delete checked.Fotos;
    checked[CATALOG_FILE] = serializeCatalog({ ...catalog, formatChecked: 123 });
    const { manifest, dir } = await backup(memDir(checked));
    const target = memDir({}, 'NEU');
    const plan = (await checkTarget(volume(target), manifest, {})).plan!;
    await copyEntries(dir, target, plan.entries, { expected: manifest.files });
    expect((await loadCatalog(target))?.formatChecked).toBe(123);
    let seen: number | undefined = -1;
    await tidyAfterRestore(volume(target, {}), (c) => ((seen = c?.formatChecked), { profile: 'tng', trustsDirectoryOrder: true, formatChecked: !!c?.formatChecked }), false);
    expect(seen).toBeUndefined();
    expect((await loadCatalog(target))?.formatChecked).toBeUndefined();
    expect((await loadCatalog(target))?.id).toBe('karte-1');
  });
});

describe('what the dialog says about a card', () => {
  it('tells a full card apart and says how big the next one must be', () => {
    const full = new CopyError('„05/001.mp3“ ließ sich nicht schreiben. 05/001.mp3: Die SD-Karte ist voll.', '05/001.mp3', 'write');
    expect(isDiskFull(full)).toBe(true);
    expect(isDiskFull(new Error('No space left on device (os error 28)'))).toBe(true);
    expect(isDiskFull(new Error('Auf dem Datenträger ist nicht genügend Speicherplatz vorhanden. (os error 112)'))).toBe(true);
    expect(isDiskFull(new Error('nicht gefunden'))).toBe(false);
    const lines = restoreErrorText(full, { need: 40 * 1024 ** 3 });
    expect(lines[1]).toBe('Die Karte ist zu klein. Die Sicherung braucht 40 GB. Nimm eine größere Karte mit höchstens 32 GB, formatiere sie mit FAT32 und spiele die Sicherung dort zurück.');
    expect(restoreErrorText(new Error('kaputt'))[1]).toMatch(/mach dort weiter/);
  });

  it('turns an exFAT card down with the FAT32 hint', async () => {
    const { manifest } = await backup();
    const c = await checkTarget(volume(memDir({}, 'SD')), manifest, { ...FAT, fsType: 'exfat', totalBytes: 64e9 });
    expect(canRestoreTo(c.judgement)).toBe(false);
    const text = verdictText(c.judgement);
    expect(text).toContain('Die Karte hat das Format exFAT. Die Box liest nur FAT32. Formatiere sie noch einmal mit FAT32.');
    expect(text).toContain('höchstens 32 GB');
  });

  it('offers the empty FAT card and says what it cannot see in the browser', () => {
    const plan = { ok: true as const, entries: [], files: 0, bytes: 0, resume: false, present: 0 };
    expect(verdictText(judgeTarget(FAT, plan))).toBe('Leer und bereit.');
    expect(verdictText(judgeTarget({}, plan), { browser: true })).toMatch(/^Leer und bereit\. Ob sie FAT32 hat, kann ich im Browser nicht sehen\./);
    expect(verdictText({ verdict: 'not-formatted', big: false, smallClusters: false, fsUnknown: false })).toBe('Auf der Karte liegt noch alles von vorher. Formatiere sie zuerst.');
    expect(verdictText({ verdict: 'not-empty', big: false, smallClusters: false, fsUnknown: false, items: ['Fotos/', 'a', 'b', 'c', 'd'] })).toBe(
      'Auf der Karte liegt noch etwas: „Fotos“, „a“, „b“, „c“ und 1 mehr. Formatiere sie zuerst.',
    );
  });

  it('says the folders on the card are unchanged when the backup stops', () => {
    const lines = backupErrorText(new CopyError('„01/001.mp3“ kam nicht heil an: Die Kopie weicht vom Original ab.', '01/001.mp3', 'check'));
    expect(lines[1]).toMatch(/^An deinen Ordnern auf der Karte hat sich nichts geändert\./);
    expect(lines[1]).toContain('Formatiere die Karte dann nicht.');
    expect(sizeAndTime(9.4 * 1024 ** 3)).toBe('9,4 GB · etwa 20 Minuten');
  });

  it('tells what to do when a file did not arrive whole on the other card', () => {
    const check = new CopyError('„05/001.mp3“ kam nicht heil an: Die Kopie weicht vom Original ab.', '05/001.mp3', 'check');
    expect(copyErrorText(check, 'card')).toEqual([
      'Auf der anderen Karte ist eine Datei nicht heil angekommen.',
      '„05/001.mp3“ kam nicht heil an: Die Kopie weicht vom Original ab.',
      'Diese Karte ist unverändert. Versuche es noch einmal und wähle bei den belegten Nummern „Ersetzen“. Passiert das wieder, ist die andere Karte vielleicht kaputt. Nimm dann eine andere Karte.',
    ]);
    expect(copyErrorText(check, 'folder')[2]).toMatch(/ist das Laufwerk vielleicht kaputt\. Wähle dann einen anderen Ordner\.$/);
    // Other errors keep the general advice.
    expect(copyErrorText(new Error('Die SD-Karte ist voll.'), 'card')).toEqual([
      'Das Kopieren hat nicht geklappt.',
      'Die SD-Karte ist voll.',
      'Diese Karte ist unverändert. Stecke die andere Karte neu ein und versuche es noch einmal.',
    ]);
  });
});
