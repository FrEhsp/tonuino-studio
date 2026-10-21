import { describe, expect, it } from 'vitest';
import { newCatalog, parseCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { cloneCatalog, cloneCovers, cloneSpace, DEFAULT_CLUSTER, executeClone, planClone, prepareExportFolder, soundsFit, takenText, type CloneInput } from '../../src/core/tonuino/clone';
import { loadCovers } from '../../src/core/tonuino/covers';
import { entryPath } from '../../src/core/tonuino/rebuild';
import { CATALOG_FILE, COVERS_FILE, scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import type { Dir } from '../../src/platform/types';
import { WrapDir } from './dirwrap';

const dec = new TextDecoder();

function sourceCatalog(): Catalog {
  const c = newCatalog('Emmas Box', 'classic21');
  c.id = 'quelle';
  const folder = (title: string, cover?: string) => ({ title, tracks: [{ file: '001.mp3', title: 'Anfang' }], card: { mode: 5 }, cover, fingerprint: 'x', addedAt: 1, updatedAt: 1 });
  c.folders['02'] = folder('Pumuckl', '02.jpg');
  c.folders['05'] = folder('Bibi Blocksberg 3', '05.png');
  c.folders['07'] = folder('Kinderlieder');
  c.extraCards = [
    { id: 'teil', label: 'Bibi Teil 2', folder: 5, mode: 4, special: 3, special2: 0 },
    { id: 'lieder', label: 'Lieder 1-5', folder: 7, mode: 4, special: 1, special2: 5 },
  ];
  c.systemSounds = { version: '2.1', installedAt: 5 };
  return c;
}

function sourceCard(): Dir {
  return memDir({
    '07': { '002.mp3': 'l2', '001.mp3': 'l1' },
    mp3: { '0001.mp3': 'ansage' },
    '02': { '001.mp3': 'p1', 'cover.jpg': 'bild' },
    advert: { '0001.mp3': 'werbung' },
    '05': { '001.mp3': 'b1', '._001.mp3': 'mac' },
  });
}

function targetCatalog(): Catalog {
  const c = newCatalog('Omas Box', 'tng');
  c.id = 'ziel';
  c.folders['05'] = { title: 'Benjamin Blümchen', tracks: [], addedAt: 1, updatedAt: 1, cover: '05.jpg' };
  c.extraCards = [{ id: 'teil', label: 'Benjamin Teil 1', folder: 5, mode: 4, special: 1, special2: 0 }];
  return c;
}

function targetCard(): Dir {
  return memDir({ '05': { '001.mp3': 'benjamin' }, mp3: { '0001.mp3': 'alte ansage' } }, 'OMA');
}

async function input(over: Partial<CloneInput> = {}): Promise<CloneInput> {
  return {
    source: await scanSd(sourceCard()),
    sourceCatalog: sourceCatalog(),
    folders: [7, 5, 2],
    sounds: true,
    target: await scanSd(targetCard()),
    targetCatalog: targetCatalog(),
    ...over,
  };
}

describe('planClone', () => {
  it('keeps the numbers, puts mp3 and advert first, then the folders by number', async () => {
    const plan = planClone(await input({ target: await scanSd(memDir({})), targetCatalog: null }));
    expect(plan.entries.map(entryPath)).toEqual(['mp3/0001.mp3', 'advert/0001.mp3', '02/001.mp3', '05/001.mp3', '07/001.mp3', '07/002.mp3']);
    expect(plan.folders.map((f) => [f.number, f.name, f.action])).toEqual([
      [2, '02', 'copy'],
      [5, '05', 'copy'],
      [7, '07', 'copy'],
    ]);
    expect(plan.remove).toEqual([]);
  });

  it('never gives a folder another number on the other card', async () => {
    for (const decisions of [undefined, new Map([[5, 'replace' as const]])]) {
      const plan = planClone(await input({ decisions }));
      for (const e of plan.entries) {
        if (e.dir === 'mp3' || e.dir === 'advert') continue;
        const f = plan.folders.find((x) => x.name === e.dir)!;
        expect(e.dir).toBe(f.name);
        expect(Number(e.dir)).toBe(f.number);
      }
    }
  });

  it('leaves a taken number out unless the user chose to replace it', async () => {
    const plan = planClone(await input());
    const five = plan.folders.find((f) => f.number === 5)!;
    expect(five).toMatchObject({ taken: true, targetTitle: 'Benjamin Blümchen', action: 'skip' });
    expect(takenText(five)).toBe('Ordner 05 ist auf der anderen Karte schon belegt („Benjamin Blümchen“). Nummern ändere ich nicht.');
    expect(plan.entries.some((e) => e.dir === '05')).toBe(false);
    // The other card has announcements already: kept unless replaced.
    expect(plan.system.map((s) => [s.name, s.action])).toEqual([
      ['mp3', 'skip'],
      ['advert', 'copy'],
    ]);
    expect(plan.entries.map(entryPath)[0]).toBe('advert/0001.mp3');

    const replace = planClone(await input({ decisions: new Map<number | 'mp3' | 'advert', 'skip' | 'replace'>([[5, 'replace'], ['mp3', 'replace']]) }));
    expect(replace.remove).toEqual(['mp3', '05']);
    expect(replace.entries.map(entryPath)).toEqual(['mp3/0001.mp3', 'advert/0001.mp3', '02/001.mp3', '05/001.mp3', '07/001.mp3', '07/002.mp3']);
  });

  it('copies only what was chosen, and junk never', async () => {
    const plan = planClone(await input({ folders: [2], sounds: false }));
    expect(plan.entries.map(entryPath)).toEqual(['02/001.mp3']);
    expect(plan.system).toEqual([]);
  });

  it('says plainly when a folder has no title on the other card', () => {
    expect(takenText({ name: '03', targetTitle: 'Ordner 03' })).toBe('Ordner 03 ist auf der anderen Karte schon belegt. Nummern ändere ich nicht.');
  });
});

describe('catalog and covers', () => {
  it('carries titles, covers and card entries into the other card’s catalog', async () => {
    const plan = planClone(await input({ decisions: new Map([[5, 'replace']]) }));
    const c = cloneCatalog(targetCatalog(), sourceCatalog(), plan, { now: 9 });
    expect(c.id).toBe('ziel');
    expect(c.name).toBe('Omas Box');
    expect(c.profile).toBe('tng');
    expect(Object.keys(c.folders).sort()).toEqual(['02', '05', '07']);
    expect(c.folders['05']).toMatchObject({ title: 'Bibi Blocksberg 3', card: { mode: 5 }, cover: '05.png', updatedAt: 9 });
    expect(c.extraCards.map((x) => x.label)).toEqual(['Bibi Teil 2', 'Lieder 1-5']);
    // The id "teil" was taken by the replaced folder's card, which is gone now: no clash.
    expect(new Set(c.extraCards.map((x) => x.id)).size).toBe(2);
    expect(c.systemSounds).toEqual({ version: '2.1', installedAt: 5 });
  });

  it('keeps the other card’s folder and its cards when the number is skipped', async () => {
    const plan = planClone(await input());
    const c = cloneCatalog(targetCatalog(), sourceCatalog(), plan);
    expect(c.folders['05'].title).toBe('Benjamin Blümchen');
    expect(c.extraCards.map((x) => x.label)).toEqual(['Benjamin Teil 1', 'Lieder 1-5']);
  });

  it('makes a catalog for a card without one, with this box’s firmware', async () => {
    const plan = planClone(await input({ target: await scanSd(memDir({})), targetCatalog: null }));
    const c = cloneCatalog(null, sourceCatalog(), plan, { name: ' Omas Box ' });
    expect(c.name).toBe('Omas Box');
    expect(c.profile).toBe('classic21');
    expect(c.id).not.toBe('quelle');
  });

  it('brings the covers of the copied folders and replaces those of replaced ones', async () => {
    const plan = planClone(await input({ decisions: new Map([[5, 'replace']]) }));
    const target = new Map([['05.jpg', new Uint8Array([1])], ['09.jpg', new Uint8Array([9])]]);
    const source = new Map([['02.jpg', new Uint8Array([2])], ['05.png', new Uint8Array([5])]]);
    const out = cloneCovers(target, source, sourceCatalog(), plan);
    expect([...out.keys()].sort()).toEqual(['02.jpg', '05.png', '09.jpg']);
  });

  it('brings the pictures of the copied folders’ own cards (episodes of a packed series)', async () => {
    const plan = planClone(await input({ decisions: new Map([[5, 'replace']]) }));
    const c = sourceCatalog();
    c.extraCards[0].cover = 'folge-teil.jpg';
    c.extraCards.push({ id: 'fremd', label: 'Anders', folder: 9, mode: 8, special: 1, special2: 2, cover: 'folge-fremd.jpg' });
    const source = new Map([['folge-teil.jpg', new Uint8Array([3])], ['folge-fremd.jpg', new Uint8Array([4])]]);
    expect([...cloneCovers(new Map(), source, c, plan).keys()]).toEqual(['folge-teil.jpg']);
  });
});

describe('executeClone', () => {
  it('writes in order onto the other card and only reads this one', async () => {
    const source = new WrapDir(sourceCard());
    const target = memDir({}, 'OMA');
    const rec = new WrapDir(target);
    const i = await input({ target: await scanSd(target), targetCatalog: null });
    const plan = planClone(i);
    const catalog = cloneCatalog(null, i.sourceCatalog, plan, { name: 'Omas Box' });
    const covers = cloneCovers(new Map(), new Map([['02.jpg', new Uint8Array([2])]]), i.sourceCatalog, plan);
    await executeClone(source, rec, plan, { catalog, covers });
    expect(source.log).toEqual([]);
    expect(rec.log).toEqual(['mp3/0001.mp3', 'advert/0001.mp3', '02/001.mp3', '05/001.mp3', '07/001.mp3', '07/002.mp3', CATALOG_FILE, COVERS_FILE]);
    const saved = parseCatalog(dec.decode(await target.read(CATALOG_FILE)))!;
    expect(saved.folders['07'].title).toBe('Kinderlieder');
    expect([...(await loadCovers(target)).keys()]).toEqual(['02.jpg']);
    expect(dec.decode(await (await target.dir('07')).read('002.mp3'))).toBe('l2');
  });

  it('replaces a taken folder only when the plan says so', async () => {
    const target = targetCard();
    const i = await input({ target: await scanSd(target), decisions: new Map([[5, 'replace']]) });
    const plan = planClone(i);
    const rec = new WrapDir(target, [], { noRemove: false });
    await executeClone(new WrapDir(sourceCard()), rec, plan, { catalog: cloneCatalog(i.targetCatalog, i.sourceCatalog, plan), covers: new Map() });
    expect(dec.decode(await (await target.dir('05')).read('001.mp3'))).toBe('b1');
    // The other card's announcements were not replaced.
    expect(dec.decode(await (await target.dir('mp3')).read('0001.mp3'))).toBe('alte ansage');
  });
});

describe('checking what arrived on the other card', () => {
  it('finds a file that arrived with the right size but other bytes, and tries once more', async () => {
    const target = memDir({}, 'OMA');
    let spoilt = 0;
    // The first write of 07/001.mp3 comes out garbled, same length.
    const rec = new WrapDir(target, [], { noRemove: true, onWrite: (path, data) => (path === '07/001.mp3' && !spoilt++ ? new Uint8Array(data.length).fill(0x58) : undefined) });
    const i = await input({ target: await scanSd(target), targetCatalog: null });
    const plan = planClone(i);
    await executeClone(new WrapDir(sourceCard()), rec, plan, { catalog: cloneCatalog(null, i.sourceCatalog, plan), covers: new Map() });
    expect(spoilt).toBe(2);
    expect(dec.decode(await (await target.dir('07')).read('001.mp3'))).toBe('l1');
  });

  it('stops with a plain message when the copy keeps coming out wrong', async () => {
    const target = memDir({}, 'OMA');
    const rec = new WrapDir(target, [], { noRemove: true, onWrite: (path, data) => (path === '05/001.mp3' ? new Uint8Array(data.length).fill(0x58) : undefined) });
    const i = await input({ target: await scanSd(target), targetCatalog: null });
    const plan = planClone(i);
    await expect(executeClone(new WrapDir(sourceCard()), rec, plan, { catalog: cloneCatalog(null, i.sourceCatalog, plan), covers: new Map() })).rejects.toThrow(
      '„05/001.mp3“ kam nicht heil an: Die Kopie weicht vom Original ab.',
    );
    // No catalog that claims a folder which did not arrive.
    expect(await target.exists(CATALOG_FILE)).toBe(false);
  });
});

describe('cloneSpace', () => {
  it('counts every file and folder in whole clusters, the covers too', async () => {
    const plan = planClone(await input({ target: await scanSd(memDir({})), targetCatalog: null }));
    // mp3, advert, 02, 05, 07: 6 files of a few bytes, 5 folders.
    expect(plan.bytes).toBeLessThan(100);
    expect(cloneSpace(plan, await scanSd(memDir({})))).toEqual({ need: 11 * DEFAULT_CLUSTER, freed: 0, net: 11 * DEFAULT_CLUSTER });
    expect(cloneSpace(plan, await scanSd(memDir({})), { cluster: 4096, coverBytes: 5000 }).need).toBe((11 + 2) * 4096);
    // The catalog written with the copy counts in whole clusters as well.
    expect(cloneSpace(plan, await scanSd(memDir({})), { cluster: 4096, coverBytes: 5000, catalogBytes: 4097 }).need).toBe((11 + 2 + 2) * 4096);
  });

  it('takes off what the replaced folders free on the other card', async () => {
    const target = memDir({ '05': { '001.mp3': new Uint8Array(70 * 1024), '002.mp3': 1 }, mp3: { '0001.mp3': 'alte ansage' } }, 'OMA');
    const scan = await scanSd(target);
    const plan = planClone(await input({ target: scan, decisions: new Map([[5, 'replace']]) }));
    expect(plan.remove).toEqual(['05']);
    // advert, 02, 05, 07: 5 files, 4 folders; 05 there: 3 + 1 clusters, its folder 1 more.
    expect(cloneSpace(plan, scan)).toEqual({ need: 9 * DEFAULT_CLUSTER, freed: 5 * DEFAULT_CLUSTER, net: 4 * DEFAULT_CLUSTER });
    // Kept folders free nothing.
    const kept = planClone(await input({ target: scan }));
    expect(cloneSpace(kept, scan).freed).toBe(0);
  });
});

describe('announcements and the other box\'s firmware', () => {
  it('go along only when the other box is known to run the same firmware', () => {
    expect(soundsFit('tng', 'tng')).toBe(true);
    expect(soundsFit('classic21', 'classic21')).toBe(true);
    expect(soundsFit('tng', 'classic21')).toBe(false);
    expect(soundsFit('tng', 'unknown')).toBe(false);
    expect(soundsFit(undefined, 'tng')).toBe(false);
  });

  it('gives a new catalog the firmware the user named for the other box', () => {
    const plan = planClone({ source: { folders: [], system: {} } as never, sourceCatalog: null, folders: [], sounds: false, target: { folders: [], system: {} } as never, targetCatalog: null });
    expect(cloneCatalog(null, sourceCatalog(), plan, { profile: 'tng' }).profile).toBe('tng');
    expect(cloneCatalog(null, sourceCatalog(), plan).profile).toBe('classic21');
  });
});

describe('prepareExportFolder', () => {
  const at = new Date(2026, 9, 6);
  it('writes into an empty folder or an earlier copy as it is', async () => {
    const empty = memDir({}, 'Oma');
    expect((await prepareExportFolder(empty, at)).dir).toBe(empty);
    const earlier = memDir({ mp3: { '0001.mp3': 'a' }, '01': { '001.mp3': 'x' } }, 'Oma');
    expect((await prepareExportFolder(earlier, at)).dir).toBe(earlier);
  });

  it('makes a folder of its own inside a folder with other things and leaves them alone', async () => {
    const docs = memDir({ 'Brief.txt': 'x', Fotos: { 'a.jpg': 'y' }, 'TonUINO-Kopie 06.10.2026': { 'notiz.txt': 'fremd' } }, 'Dokumente');
    const r = await prepareExportFolder(new WrapDir(docs), at);
    expect(r.made).toBe('TonUINO-Kopie 06.10.2026 (2)');
    expect(r.scan.kind).toBe('empty');
    expect((await docs.list()).map((e) => e.name).sort()).toEqual(['Brief.txt', 'Fotos', 'TonUINO-Kopie 06.10.2026', 'TonUINO-Kopie 06.10.2026 (2)']);
    // Picked again later the same day: the copy goes on in the same folder.
    await (await docs.dir('TonUINO-Kopie 06.10.2026 (2)')).dir('01', { create: true }).then((d) => d.write('001.mp3', new Uint8Array([1])));
    expect((await prepareExportFolder(docs, at)).made).toBe('TonUINO-Kopie 06.10.2026 (2)');
  });
});
