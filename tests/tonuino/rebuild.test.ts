import { describe, expect, it } from 'vitest';
import {
  BACKUP_MANIFEST,
  backupBlocker,
  backupFolderName,
  bytesOnCard,
  copyEntries,
  CopyError,
  durationText,
  entryPath,
  estimateMinutes,
  findBackups,
  leftOut,
  parseBackupManifest,
  planBackup,
  planRestore,
  readBackupManifest,
  restoreOrder,
  type BackupManifest,
} from '../../src/core/tonuino/rebuild';
import { CATALOG_FILE, COVERS_FILE, scanSd } from '../../src/core/tonuino/sd';
import { memDir, type MemTree } from '../../src/platform/memory';
import type { Dir } from '../../src/platform/types';
import { WrapDir } from './dirwrap';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A card filled piece by piece: folder 10 and 05 before mp3 (object keys
 * like "10" come first in JavaScript), tracks out of order, junk from a
 * Mac and Windows, a picture and a folder the box does not play.
 */
function card(): MemTree {
  return {
    '05': { '002.mp3': 'zwei-fuenf', '001.mp3': 'eins-fuenf', '._001.mp3': 'mac', 'cover.jpg': 'bild', '010.mp3': 'zehn-fuenf' },
    advert: { '0002.mp3': 'werbung-2', '0001.mp3': 'werbung-1' },
    '.DS_Store': 'junk',
    mp3: { '0002.mp3': 'ansage-2', '0001.mp3': 'ansage-1', 'Thumbs.db': 'junk' },
    '01': { '002.mp3': 'zwei-eins', '001_Intro.mp3': 'eins-eins' },
    [COVERS_FILE]: 'covers-zip',
    Fotos: { 'urlaub.jpg': 'x' },
    [CATALOG_FILE]: '{"app":"tonuino-studio","id":"karte-1"}',
    '10': { '001.mp3': 'eins-zehn' },
  };
}

const ORDER = [
  'mp3/0001.mp3',
  'mp3/0002.mp3',
  'advert/0001.mp3',
  'advert/0002.mp3',
  '01/001_Intro.mp3',
  '01/002.mp3',
  '05/001.mp3',
  '05/002.mp3',
  '05/010.mp3',
  '10/001.mp3',
  CATALOG_FILE,
  COVERS_FILE,
];

async function planned(root: Dir) {
  return planBackup(await scanSd(root), await root.list());
}

/** Backs up `cardDir` into a fresh folder and returns it with the manifest. */
async function backedUp(cardDir: Dir = memDir(card())) {
  const backup = memDir({}, 'Sicherung');
  const list = await planned(cardDir);
  const result = await copyEntries(cardDir, backup, list, { backup: { boxName: 'Emmas Box', catalogId: 'karte-1' } });
  return { backup, list, result, manifest: result.manifest! };
}

/** Names in directory order (memTreeNames would put "10" first: it is an object key). */
async function names(dir: Dir): Promise<string[]> {
  return (await dir.list()).map((e) => e.name);
}

async function fileText(root: Dir, path: string): Promise<string> {
  const [dir, name] = path.includes('/') ? path.split('/') : ['', path];
  return dec.decode(await (dir ? await root.dir(dir) : root).read(name));
}

describe('planBackup', () => {
  it('lists mp3, advert, then 01 … 99 with tracks by number, the catalog and covers last', async () => {
    const list = await planned(memDir(card()));
    expect(list.map(entryPath)).toEqual(ORDER);
    expect(list.find((e) => e.name === CATALOG_FILE)!.size).toBe(enc.encode(card()[CATALOG_FILE] as string).length);
  });

  it('leaves junk out and names what else stays behind', async () => {
    const scan = await scanSd(memDir(card()));
    const paths = planBackup(scan).map(entryPath);
    expect(paths.some((p) => /\._|ds_store|thumbs/i.test(p))).toBe(false);
    expect(leftOut(scan)).toEqual(['05/cover.jpg', 'Fotos/']);
  });

  it('keeps unnumbered audio and wrong digit counts, so nothing the box might play is lost', async () => {
    const scan = await scanSd(memDir({ '03': { '1.mp3': 'a', 'Lied.mp3': 'b', '002.mp3': 'c' }, mp3: { '01.mp3': 'x', '0001.mp3': 'y' } }));
    expect(planBackup(scan).map(entryPath)).toEqual(['mp3/0001.mp3', 'mp3/01.mp3', '03/1.mp3', '03/002.mp3', '03/Lied.mp3']);
  });

  it('waits for an interrupted repair to be put back first', async () => {
    expect(backupBlocker(await scanSd(memDir({ '05': { '001.mp3': 'a' }, '_tonuino-studio-temp-05': { '002.mp3': 'b' } })))).toBe('temp');
    expect(backupBlocker(await scanSd(memDir(card())))).toBeNull();
  });
});

describe('backup', () => {
  it('copies every planned file, checks it and writes the manifest; the card is only read', async () => {
    const source = new WrapDir(memDir(card()));
    const { backup, manifest, result } = await backedUp(source);
    expect(source.log).toEqual([]);
    expect(result).toMatchObject({ copied: ORDER.length, skipped: 0 });
    expect(manifest.complete).toBe(true);
    expect(manifest.files.map((f) => f.path)).toEqual(ORDER);
    expect(await readBackupManifest(backup)).toEqual(manifest);
    for (const p of ORDER) expect(await fileText(backup, p)).toBe(await fileText(source, p));
    expect((await names(backup)).filter((n) => n !== BACKUP_MANIFEST)).toEqual(['mp3', 'advert', '01', '05', '10', CATALOG_FILE, COVERS_FILE]);
  });

  it('goes on from the manifest after it was stopped', async () => {
    const cardDir = memDir(card());
    const backup = memDir({}, 'Sicherung');
    const list = await planned(cardDir);
    const ctrl = new AbortController();
    let n = 0;
    const first = new WrapDir(backup, [], {
      onWrite: (path) => {
        if (path !== BACKUP_MANIFEST && ++n === 5) ctrl.abort();
      },
    });
    await expect(copyEntries(cardDir, first, list, { backup: { boxName: 'Box', catalogId: 'karte-1' }, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const halfway = (await readBackupManifest(backup))!;
    expect(halfway.complete).toBe(false);
    expect(halfway.files.map((f) => f.path)).toEqual(ORDER.slice(0, 4));

    const second = new WrapDir(backup);
    const result = await copyEntries(cardDir, second, list, { backup: { boxName: 'Box', catalogId: 'karte-1' } });
    expect(result).toMatchObject({ skipped: 4, copied: ORDER.length - 4 });
    expect(second.log.filter((p) => p !== BACKUP_MANIFEST)).toEqual(ORDER.slice(4));
    expect(result.manifest!.complete).toBe(true);
  });

  it('copies a file again that was changed in the backup since', async () => {
    const cardDir = memDir(card());
    const { backup, list } = await backedUp(cardDir);
    await (await backup.dir('05')).write('002.mp3', enc.encode('ZWEI-FUENF'));
    const again = new WrapDir(backup);
    const result = await copyEntries(cardDir, again, list, { backup: { boxName: 'Box', catalogId: 'karte-1' } });
    expect(again.log.filter((p) => p !== BACKUP_MANIFEST)).toEqual(['05/002.mp3']);
    expect(result.skipped).toBe(ORDER.length - 1);
    expect(await fileText(backup, '05/002.mp3')).toBe('zwei-fuenf');
  });

  it('stops before formatting when a copy has the wrong size', async () => {
    const cardDir = memDir(card());
    const backup = memDir({}, 'Sicherung');
    const short = new WrapDir(backup, [], { onWrite: (p, d) => (p === '05/002.mp3' ? d.slice(0, 3) : undefined) });
    const err = await copyEntries(cardDir, short, await planned(cardDir), { backup: { boxName: 'Box' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CopyError);
    expect(err).toMatchObject({ stage: 'check', path: '05/002.mp3' });
    expect((err as Error).message).toContain('nicht vollständig');
    const m = (await readBackupManifest(backup))!;
    expect(m.complete).toBe(false);
    expect(planRestore(m, await scanSd(memDir({})))).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('stops before formatting when a copy differs from the original (CRC)', async () => {
    const cardDir = memDir(card());
    const flip = (d: Uint8Array) => {
      const c = d.slice();
      c[0] ^= 0xff;
      return c;
    };
    const bad = new WrapDir(memDir({}, 'Sicherung'), [], { onWrite: (p, d) => (p === '01/002.mp3' ? flip(d) : undefined) });
    const err = await copyEntries(cardDir, bad, await planned(cardDir), { backup: { boxName: 'Box' } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ stage: 'check', path: '01/002.mp3' });
    expect((err as Error).message).toContain('weicht vom Original ab');
  });

  it('tries a file once more when only one copy went wrong', async () => {
    const cardDir = memDir(card());
    let once = true;
    const flaky = new WrapDir(memDir({}, 'Sicherung'), [], {
      onWrite: (p, d) => {
        if (p !== '01/002.mp3' || !once) return;
        once = false;
        return d.slice(1);
      },
    });
    const result = await copyEntries(cardDir, flaky, await planned(cardDir), { backup: { boxName: 'Box' } });
    expect(result.manifest!.complete).toBe(true);
    expect(flaky.log.filter((p) => p === '01/002.mp3')).toHaveLength(2);
  });

  it('reports progress up to the end', async () => {
    const cardDir = memDir(card());
    const seen: number[] = [];
    let last = { files: 0, totalFiles: 0, done: 0, total: 0 };
    await copyEntries(cardDir, memDir({}), await planned(cardDir), {
      backup: { boxName: 'Box' },
      onProgress: (p) => {
        seen.push(p.done);
        last = p;
      },
    });
    expect(last.files).toBe(ORDER.length);
    expect(last.done).toBe(last.total);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe('restore', () => {
  it('writes mp3, advert, then 01 … 99 with tracks by number, catalog and covers last, under the same names', async () => {
    const { backup, manifest } = await backedUp();
    const target = memDir({}, 'TONUINO');
    const plan = planRestore(manifest, await scanSd(target));
    expect(plan).toMatchObject({ ok: true, resume: false, files: ORDER.length });
    if (!plan.ok) return;
    const rec = new WrapDir(target);
    await copyEntries(new WrapDir(backup), rec, plan.entries, { expected: manifest.files });
    expect(rec.log).toEqual(ORDER);
    expect(await names(target)).toEqual(['mp3', 'advert', '01', '05', '10', CATALOG_FILE, COVERS_FILE]);
    expect(await names(await target.dir('05'))).toEqual(['001.mp3', '002.mp3', '010.mp3']);
    for (const p of ORDER) expect(await fileText(target, p)).toBe(await fileText(memDir(card()), p));
  });

  it('keeps the spelling of the folder names', async () => {
    const files = [
      { path: '07/002.mp3', size: 1, crc32: 0 },
      { path: CATALOG_FILE, size: 1, crc32: 0 },
      { path: 'ADVERT/0001.mp3', size: 1, crc32: 0 },
      { path: '07/001.mp3', size: 1, crc32: 0 },
      { path: 'MP3/0001.mp3', size: 1, crc32: 0 },
    ];
    expect(restoreOrder(files).map(entryPath)).toEqual(['MP3/0001.mp3', 'ADVERT/0001.mp3', '07/001.mp3', '07/002.mp3', CATALOG_FILE]);
  });

  it('refuses a card with other things on it', async () => {
    const { manifest } = await backedUp();
    const other = memDir({ '07': { '001.mp3': 'fremd' }, 'System Volume Information': {} });
    expect(planRestore(manifest, await scanSd(other))).toEqual({ ok: false, reason: 'not-empty', items: ['07/001.mp3'] });
    // Junk of a freshly formatted card does not count.
    expect(planRestore(manifest, await scanSd(memDir({ 'System Volume Information': {}, '.Trashes': {} })))).toMatchObject({ ok: true, resume: false });
  });

  it('refuses files of this backup that are not a clean beginning', async () => {
    const { manifest } = await backedUp();
    const odd = memDir({ '05': { '001.mp3': 'eins-fuenf' } });
    expect(planRestore(manifest, await scanSd(odd))).toMatchObject({ ok: false, reason: 'not-empty' });
  });

  it('goes on after it was stopped, and the card ends up in the right order', async () => {
    const { backup, manifest } = await backedUp();
    const target = memDir({}, 'TONUINO');
    const plan = planRestore(manifest, await scanSd(target));
    if (!plan.ok) throw new Error('plan');
    const ctrl = new AbortController();
    let n = 0;
    const first = new WrapDir(target, [], {
      onWrite: () => {
        if (++n === 6) ctrl.abort();
      },
    });
    await expect(copyEntries(backup, first, plan.entries, { expected: manifest.files, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.log).toEqual(ORDER.slice(0, 5));

    const again = planRestore(manifest, await scanSd(target));
    expect(again).toMatchObject({ ok: true, resume: true });
    if (!again.ok) return;
    const second = new WrapDir(target);
    const result = await copyEntries(backup, second, again.entries, { expected: manifest.files });
    expect(result).toMatchObject({ skipped: 5, copied: ORDER.length - 5 });
    expect(second.log).toEqual(ORDER.slice(5));
    expect(await names(target)).toEqual(['mp3', 'advert', '01', '05', '10', CATALOG_FILE, COVERS_FILE]);
  });

  it('writes a half-written file again', async () => {
    const { backup, manifest } = await backedUp();
    const target = memDir({ mp3: { '0001.mp3': 'ansage-1', '0002.mp3': '' } }, 'TONUINO');
    const plan = planRestore(manifest, await scanSd(target));
    expect(plan).toMatchObject({ ok: true, resume: true });
    if (!plan.ok) return;
    const rec = new WrapDir(target);
    await copyEntries(backup, rec, plan.entries, { expected: manifest.files });
    expect(rec.log[0]).toBe('mp3/0002.mp3');
    expect(await fileText(target, 'mp3/0002.mp3')).toBe('ansage-2');
  });

  it('does not write a file that was damaged in the backup', async () => {
    const { backup, manifest } = await backedUp();
    await (await backup.dir('05')).write('001.mp3', enc.encode('EINS-FUENF'));
    const target = memDir({}, 'TONUINO');
    const plan = planRestore(manifest, await scanSd(target));
    if (!plan.ok) throw new Error('plan');
    const rec = new WrapDir(target);
    const err = await copyEntries(backup, rec, plan.entries, { expected: manifest.files }).catch((e: unknown) => e);
    expect(err).toMatchObject({ stage: 'damaged', path: '05/001.mp3' });
    expect(rec.log).toEqual(ORDER.slice(0, 6));
  });

  it('never removes anything from the backup', async () => {
    const { backup, manifest } = await backedUp();
    const plan = planRestore(manifest, await scanSd(memDir({})));
    if (!plan.ok) throw new Error('plan');
    const source = new WrapDir(backup);
    await copyEntries(source, memDir({}), plan.entries, { expected: manifest.files });
    expect(source.log).toEqual([]);
  });
});

describe('manifest', () => {
  it('reads what it wrote and refuses paths out of the folder', async () => {
    const { manifest } = await backedUp();
    const text = JSON.stringify(manifest);
    expect(parseBackupManifest(text)).toEqual(manifest);
    expect(parseBackupManifest(text.replace('"05/001.mp3"', '"../001.mp3"'))).toBeNull();
    expect(parseBackupManifest('{"app":"tonuino-studio"}')).toBeNull();
    expect(parseBackupManifest('kaputt')).toBeNull();
  });

  it('finds backups in a folder, newest first, or the backup folder itself', async () => {
    const m = (at: number, complete: boolean): BackupManifest => ({
      app: 'tonuino-studio',
      kind: 'sicherung',
      format: 1,
      boxName: 'Box',
      createdAt: at,
      updatedAt: at,
      complete,
      planned: { files: 0, bytes: 0 },
      files: [],
    });
    const parent = memDir({
      'TonUINO-Sicherung Box 01.10.2026': { [BACKUP_MANIFEST]: JSON.stringify(m(1, true)) },
      'TonUINO-Sicherung Box 06.10.2026': { [BACKUP_MANIFEST]: JSON.stringify(m(2, false)) },
      Fotos: {},
    });
    expect((await findBackups(parent)).map((b) => b.name)).toEqual(['TonUINO-Sicherung Box 06.10.2026', 'TonUINO-Sicherung Box 01.10.2026']);
    const own = await findBackups(await parent.dir('TonUINO-Sicherung Box 01.10.2026'));
    expect(own).toHaveLength(1);
    expect(own[0].name).toBe('');
  });
});

describe('texts and numbers', () => {
  it('names the backup folder after the box and the day', () => {
    expect(backupFolderName('Emmas TonUINO', new Date(2026, 9, 6))).toBe('TonUINO-Sicherung Emmas TonUINO 06.10.2026');
    expect(backupFolderName('A/B: C?*', new Date(2026, 0, 2))).toBe('TonUINO-Sicherung A B C 02.01.2026');
    expect(backupFolderName('  ', new Date(2026, 0, 2))).toBe('TonUINO-Sicherung 02.01.2026');
  });

  it('estimates the time for backing up and writing back', () => {
    expect(durationText(estimateMinutes(9.4e9))).toBe('etwa 20 Minuten');
    expect(durationText(estimateMinutes(50e6))).toBe('ein paar Minuten');
    expect(durationText(estimateMinutes(30e9))).toBe('etwa 1 Stunde');
    expect(durationText(85)).toBe('etwa 1 Stunde 30 Minuten');
  });

  it('counts the space on the card in clusters', () => {
    expect(bytesOnCard([{ dir: '05', name: '001.mp3', size: 1 }, { dir: '05', name: '002.mp3', size: 40_000 }, { dir: '', name: CATALOG_FILE, size: 10 }])).toBe(32768 * 5);
  });
});
