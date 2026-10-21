import { describe, expect, it, vi } from 'vitest';
import { memDir } from '../../src/platform/memory';
import {
  applyPlanToCatalog,
  buildShelf,
  folderChanges,
  folderFingerprint,
  forgetFolder,
  loadCatalog,
  matchLibraryCatalog,
  newCatalog,
  parseCatalog,
  saveCatalog,
  serializeCatalog,
  touchFolder,
  trackRows,
  unusedFolderNumbers,
  type FolderOrigin,
} from '../../src/core/tonuino/catalog';
import { coverEntryName, loadCovers, saveCovers } from '../../src/core/tonuino/covers';
import { checkHealth } from '../../src/core/tonuino/health';
import { doneSteps, executePlan, planFix, planReorder, repairAll, touchedFolders } from '../../src/core/tonuino/repair';
import { scanSd } from '../../src/core/tonuino/sd';

describe('forgetFolder', () => {
  it('drops a deleted folder with its cards and the pictures nothing else shows', () => {
    const c = newCatalog('Box');
    c.folders['05'] = { title: 'Die drei ???', kind: 'hoerspiel', card: { mode: 5 }, tracks: [], cover: '05.jpg', addedAt: 1, updatedAt: 1 };
    c.folders['06'] = { title: 'Paw Patrol', kind: 'hoerspiel', card: { mode: 5 }, tracks: [], cover: '06.jpg', addedAt: 1, updatedAt: 1 };
    const card = (id: string, folder: number, cover?: string) => ({ id, label: id, folder, mode: 4, special: 1, special2: 2, ...(cover ? { cover } : {}) });
    c.extraCards = [card('a', 5, 'folge-a.jpg'), card('b', 5, 'folge-b.jpg'), card('c', 5), card('d', 6, 'folge-d.jpg'), card('e', 6, 'folge-b.jpg')];
    const gone = forgetFolder(c, 5, ['05.jpg', '05.png', '06.jpg', 'folge-a.jpg', 'folge-b.jpg', 'folge-d.jpg']);
    expect(c.folders['05']).toBeUndefined();
    expect(c.extraCards.map((x) => x.id)).toEqual(['d', 'e']);
    // "folge-b.jpg" stays: a card of folder 06 still shows it. "05.png" was under the number without the catalog knowing.
    expect(gone.sort()).toEqual(['05.jpg', '05.png', 'folge-a.jpg']);
  });

  it('keeps everything of other folders', () => {
    const c = newCatalog('Box');
    c.folders['07'] = { title: 'Abbey Road', kind: 'musik', card: { mode: 2 }, tracks: [], cover: '07.jpg', addedAt: 1, updatedAt: 1 };
    expect(forgetFolder(c, 8, ['07.jpg'])).toEqual([]);
    expect(c.folders['07']?.cover).toBe('07.jpg');
  });
});

describe('catalog', () => {
  it('round-trips through JSON and survives broken fields', () => {
    const c = newCatalog('Emmas Box');
    c.folders['05'] = { title: 'Bibi Blocksberg 1', kind: 'hoerspiel', card: { mode: 5 }, tracks: [{ file: '001.mp3', title: 'Teil 1', durationSec: 61.5 }], addedAt: 1, updatedAt: 2 };
    const back = parseCatalog(serializeCatalog(c))!;
    expect(back).toEqual(c);

    const broken = parseCatalog(
      JSON.stringify({ app: 'tonuino-studio', folders: { '5': { title: 'x' }, '07': { tracks: [{ title: 'no file' }, { file: '001.mp3' }], kind: 'quatsch', card: { mode: 300 } } }, extraCards: [{ folder: 0, mode: 1, special: 15 }] }),
    )!;
    expect(Object.keys(broken.folders)).toEqual(['07']);
    expect(broken.folders['07']).toMatchObject({ title: 'Ordner 07', tracks: [{ file: '001.mp3' }], kind: undefined, card: undefined });
    expect(broken.extraCards[0]).toMatchObject({ folder: 0, mode: 1, special: 15, special2: 0 });
    expect(parseCatalog('{"app":"something-else"}')).toBeNull();
    expect(parseCatalog('kein json')).toBeNull();
  });

  it('marks guessed track titles and checked lengths without a new format: older versions read the catalog as before', () => {
    const c = newCatalog('Emmas Box');
    c.folders['22'] = {
      title: 'Igel sucht den Mond',
      tracks: [{ file: '001.mp3', title: 'Intro', titleAuto: true, durationSec: 66, durationExact: true }, { file: '002.mp3', title: 'Selbst getippt', durationSec: 181 }],
      addedAt: 1,
      updatedAt: 2,
    };
    const text = serializeCatalog(c);
    expect(JSON.parse(text).format).toBe(1);
    expect(parseCatalog(text)).toEqual(c);
    // Only `true` counts, and only with a title; a field the version does not know is passed over (as 0.2 does with this one).
    const odd = parseCatalog(JSON.stringify({ app: 'tonuino-studio', folders: { '01': { title: 'x', tracks: [{ file: '001.mp3', title: 'a', titleAuto: 'ja' }, { file: '002.mp3', titleAuto: true, durationExact: true }, { file: '003.mp3', title: 'c', future: 1 }] } } }))!;
    expect(odd.folders['01'].tracks).toEqual([
      { file: '001.mp3', title: 'a' },
      { file: '002.mp3' },
      { file: '003.mp3', title: 'c' },
    ]);
  });

  it('keeps the episode a track belongs to (extra „Mehr als 99 Hörspiele“)', () => {
    const c = newCatalog('Emmas Box');
    c.folders['30'] = { title: 'Sammlung', tracks: [{ file: '001.mp3', title: 'Teil 1', episode: 'Folge 1' }, { file: '002.mp3', title: 'Teil 2' }], addedAt: 1, updatedAt: 2 };
    expect(parseCatalog(serializeCatalog(c))).toEqual(c);
    const odd = parseCatalog(JSON.stringify({ app: 'tonuino-studio', folders: { '01': { title: 'x', tracks: [{ file: '001.mp3', episode: '  ' }, { file: '002.mp3', episode: 7 }, { file: '003.mp3', episode: ' Folge 3 ' }] } } }))!;
    expect(odd.folders['01'].tracks).toEqual([{ file: '001.mp3' }, { file: '002.mp3' }, { file: '003.mp3', episode: 'Folge 3' }]);
  });

  it('keeps the note that someone saw FAT32 on a computer', () => {
    const c = newCatalog('Emmas Box');
    c.formatChecked = 1_790_000_000_000;
    expect(parseCatalog(serializeCatalog(c))!.formatChecked).toBe(1_790_000_000_000);
    expect(parseCatalog(JSON.stringify({ app: 'tonuino-studio', formatChecked: 'ja' }))!.formatChecked).toBeUndefined();
  });

  it('keeps sticker adjustments, also the whole picture and a turned sticker', () => {
    const c = newCatalog('Emmas Box');
    c.folders['01'] = { title: 'Bilder', tracks: [], sticker: { focusX: 0.3, zoom: 0, orientation: 'portrait' }, addedAt: 1, updatedAt: 2 };
    c.folders['02'] = { title: 'Fotos', tracks: [], sticker: { zoom: 0.45, orientation: 'landscape' }, addedAt: 1, updatedAt: 2 };
    expect(parseCatalog(serializeCatalog(c))).toEqual(c);
    const odd = parseCatalog(
      JSON.stringify({ app: 'tonuino-studio', folders: { '03': { title: 'x', tracks: [], sticker: { zoom: -1, orientation: 'schräg', focusY: 2 } }, '04': { title: 'y', tracks: [], sticker: { zoom: 5, title: 'Kurz' } } } }),
    )!;
    expect(odd.folders['03'].sticker).toBeUndefined();
    expect(odd.folders['04'].sticker).toEqual({ title: 'Kurz' });
  });

  it('keeps the shelf card recipe and drops a strange one', () => {
    const c = newCatalog('Emmas Box');
    c.folders['01'] = { title: 'Gespenst', tracks: [], sticker: { recipe: 'kleines-gespenst' }, addedAt: 1, updatedAt: 2 };
    c.folders['02'] = { title: 'Fotos', tracks: [], sticker: { recipe: '-' }, addedAt: 1, updatedAt: 2 };
    expect(parseCatalog(serializeCatalog(c))).toEqual(c);
    const odd = parseCatalog(JSON.stringify({ app: 'tonuino-studio', folders: { '03': { title: 'x', tracks: [], sticker: { recipe: '<script>' } } } }))!;
    expect(odd.folders['03'].sticker).toBeUndefined();
  });

  it('keeps the origins of tracks from "Entdecken" and drops broken ones', () => {
    const origin: FolderOrigin = {
      id: 'o1',
      entry: 'radio-klops',
      item: 'radio-klops/7',
      title: 'Folge 7',
      series: 'Radio Klops',
      publisher: 'Domenik Schuster',
      pageUrl: 'https://radioklops.podigee.io/',
      licence: { kind: 'podcast', label: 'Podcast · nur privat' },
      credit: '„Folge 7“. Radio Klops. Quelle: Domenik Schuster, https://radioklops.podigee.io/. Podcast, nur privat.',
      changes: ['tags'],
      retrievedAt: 1_700_000_000_000,
    };
    const c = newCatalog('Box');
    c.folders['03'] = { title: 'Folge 7', tracks: [{ file: '001.mp3', title: 'Folge 7', origin: 'o1' }], origins: [origin], addedAt: 1, updatedAt: 2 };
    expect(parseCatalog(serializeCatalog(c))).toEqual(c);

    const raw = JSON.parse(serializeCatalog(c));
    raw.folders['03'].origins.push({ id: 'o2', entry: 'x' }, { ...origin, id: 'o3', licence: { kind: 'stolen', label: 'x' } }, { ...origin });
    raw.folders['03'].tracks.push({ file: '002.mp3', origin: 'o2' }, { file: '003.mp3', origin: 'weg' });
    const back = parseCatalog(JSON.stringify(raw))!;
    expect(back.folders['03'].origins!.map((o) => o.id)).toEqual(['o1']);
    expect(back.folders['03'].tracks.map((t) => [t.file, t.origin])).toEqual([
      ['001.mp3', 'o1'],
      ['002.mp3', undefined],
      ['003.mp3', undefined],
    ]);
  });

  it('forgets the origin of tracks that left the card', async () => {
    const scan = await scanSd(memDir({ '03': { '001.mp3': 10 } }));
    const c = newCatalog();
    const base = { entry: 'e', title: 't', publisher: 'p', pageUrl: 'https://x.de/', licence: { kind: 'cc' as const, label: 'CC BY 4.0' }, credit: 'c', changes: [], retrievedAt: 0 };
    c.folders['03'] = {
      title: 'Geschichten',
      tracks: [
        { file: '001.mp3', origin: 'a' },
        { file: '002.mp3', origin: 'b' },
      ],
      origins: [
        { ...base, id: 'a', item: 'e/1' },
        { ...base, id: 'b', item: 'e/2' },
      ],
      addedAt: 0,
      updatedAt: 0,
    };
    touchFolder(c, scan.folders[0]);
    expect(c.folders['03'].origins!.map((o) => o.id)).toEqual(['a']);
    c.folders['03'].tracks[0].origin = undefined;
    touchFolder(c, scan.folders[0]);
    expect(c.folders['03'].origins).toBeUndefined();
  });

  it('is stored on the card', async () => {
    const root = memDir({});
    expect(await loadCatalog(root)).toBeNull();
    const c = newCatalog();
    await saveCatalog(root, c);
    expect((await loadCatalog(root))!.id).toBe(c.id);
    expect((await scanSd(root)).hasCatalog).toBe(true);
  });

  it('builds the shelf from card and catalog', async () => {
    const scan = await scanSd(memDir({ '01': { '001.mp3': 10, '002 Lied.mp3': 20 }, '02': { '001.mp3': 5 }, '04': { '001.mp3': 7 } }));
    const c = newCatalog();
    c.folders['01'] = { title: 'Lieder', tracks: [{ file: '001.mp3', title: 'Eins', durationSec: 60 }, { file: '002 Lied.mp3', durationSec: 30 }], fingerprint: folderFingerprint(scan.folders[0]), addedAt: 0, updatedAt: 0 };
    c.folders['02'] = { title: 'Geändert', tracks: [], fingerprint: '3:100', addedAt: 0, updatedAt: 0 };
    c.folders['03'] = { title: 'Weg', tracks: [], addedAt: 0, updatedAt: 0 };
    const shelf = buildShelf(scan, c);
    expect(shelf.map((s) => [s.name, s.state, s.title])).toEqual([
      ['01', 'ok', 'Lieder'],
      ['02', 'changed', 'Geändert'],
      ['03', 'missing', 'Weg'],
      ['04', 'unknown', 'Ordner 04'],
    ]);
    expect(shelf[0].durationSec).toBe(90);
    expect(shelf[1].durationSec).toBeUndefined();
    expect(trackRows(scan.folders[0], c.folders['01']).map((r) => r.title)).toEqual(['Eins', 'Lied']);
    expect(unusedFolderNumbers(scan, c)[0]).toBe(5);
  });

  it('keeps titles attached to files that a repair renamed', async () => {
    const root = memDir({ '02': { '001.mp3': 1, '003 B.mp3': 2, '005.mp3': 3 } });
    const c = newCatalog();
    c.folders['02'] = { title: 'X', tracks: [{ file: '001.mp3', title: 'A' }, { file: '003 B.mp3', title: 'B' }, { file: '005.mp3', title: 'C' }], addedAt: 0, updatedAt: 0 };
    const result = await repairAll(root, (s) => checkHealth(s, { profile: 'tng' }), { onExecuted: (_i, plan, done) => applyPlanToCatalog(c, plan, done) });
    // The words after a number are a risk for some players: renamed first, the title stays.
    expect(result.steps.map((s) => s.issue.id)).toEqual(['suffix:02', 'gap:02']);
    const scan = await scanSd(root);
    touchFolder(c, scan.folders[0]);
    expect(trackRows(scan.folders[0], c.folders['02']).map((r) => [r.file, r.title])).toEqual([
      ['001.mp3', 'A'],
      ['002.mp3', 'B'],
      ['003.mp3', 'C'],
    ]);
    expect(buildShelf(scan, c)[0].state).toBe('ok');
  });

  it('drops the entry of a removed empty folder', async () => {
    const root = memDir({ '01': { '001.mp3': 1 }, '02': {} });
    const c = newCatalog();
    c.folders['02'] = { title: 'Leer', tracks: [], addedAt: 0, updatedAt: 0 };
    applyPlanToCatalog(c, planFix(await scanSd(root), { kind: 'remove-empty-folder', folder: 2 }));
    expect(c.folders['02']).toBeUndefined();
  });
});

describe('repairAll', () => {
  it('fixes everything in a safe order and reports what it could not fix', async () => {
    const root = memDir({
      '.DS_Store': 1,
      '3': { '1.mp3': 1, '._1.mp3': 1, 'Intro.mp3': 2, '004.mp3': 4 },
      '04': { '001.mp3': 1, '001 Kopie.mp3': 1 },
      '05': {},
    });
    const result = await repairAll(root, (s) => checkHealth(s, { profile: 'tng', trustsDirectoryOrder: true }));
    expect(result.error).toBeUndefined();
    expect(result.steps.map((s) => s.issue.id)).toEqual(['junk', 'invalid-folder:3', 'digits:03', 'dup:04', 'unnumbered:03', 'gap:03', 'empty:05']);
    const scan = result.scan;
    expect(scan.folders.map((f) => [f.name, f.tracks.map((t) => [t.name, t.size])])).toEqual([
      ['03', [['001.mp3', 1], ['002.mp3', 4], ['003.mp3', 2]]],
      ['04', [['001.mp3', 1], ['002 Kopie.mp3', 1]]],
    ]);
    // Left: the system sounds (they need the installer) and a hint about names with text.
    expect(result.report.issues.map((i) => [i.id, i.severity])).toEqual([
      ['system-missing', 'error'],
      ['suffix:04', 'warning'],
    ]);
  });
});

describe('covers zip', () => {
  it('stores and reads covers', async () => {
    const root = memDir({});
    const covers = new Map([[coverEntryName(5), new Uint8Array([0xff, 0xd8, 1, 2, 3])], [coverEntryName(12, 'image/png'), new Uint8Array([0x89, 0x50])]]);
    await saveCovers(root, covers);
    const back = await loadCovers(root);
    expect([...back.keys()].sort()).toEqual(['05.jpg', '12.png']);
    expect([...back.get('05.jpg')!]).toEqual([0xff, 0xd8, 1, 2, 3]);
    await saveCovers(root, new Map());
    expect(await root.exists('tonuino-studio-covers.zip')).toBe(false);
  });
});

describe('planReorder', () => {
  it('reorders, deletes and keeps titles with their files', async () => {
    const { planReorder } = await import('../../src/core/tonuino/repair');
    const { executePlan } = await import('../../src/core/tonuino/repair');
    const root = memDir({ '03': { '001.mp3': 1, '002 Zwei.mp3': 2, '003.mp3': 3, '004.mp3': 4, 'cover.jpg': 9 } });
    const c = newCatalog();
    c.folders['03'] = { title: 'X', tracks: [{ file: '001.mp3', title: 'Eins' }, { file: '002 Zwei.mp3', title: 'Zwei' }, { file: '003.mp3', title: 'Drei' }, { file: '004.mp3', title: 'Vier' }], addedAt: 0, updatedAt: 0 };
    const scan = await scanSd(root);
    const plan = planReorder(scan.folders[0], ['004.mp3', '001.mp3', '002 Zwei.mp3'], { pureNumbers: true });
    applyPlanToCatalog(c, plan);
    const result = await executePlan(root, plan);
    expect(result.error).toBeUndefined();
    const after = await scanSd(root);
    touchFolder(c, after.folders[0]);
    expect(trackRows(after.folders[0], c.folders['03']).map((r) => [r.file, r.title, r.size])).toEqual([
      ['001.mp3', 'Vier', 4],
      ['002.mp3', 'Eins', 1],
      ['003.mp3', 'Zwei', 2],
    ]);
    expect(after.folders[0].others.map((e) => e.name)).toEqual(['cover.jpg']);
    expect(after.tempDirs).toEqual([]);
  });

  it('keeps every title with its audio when the reorder stops half way and is put back', async () => {
    const tree = { '03': { '001.mp3': 1, '002.mp3': 2, '003.mp3': 3, '004.mp3': 4 } };
    const titles: Record<number, string> = { 1: 'Eins', 2: 'Zwei', 3: 'Drei', 4: 'Vier' };
    const full = planReorder((await scanSd(memDir(tree))).folders[0], ['003.mp3', '001.mp3', '002.mp3'], { pureNumbers: true });
    for (let k = 0; k <= full.steps.length; k++) {
      const root = memDir(tree);
      const c = newCatalog();
      c.folders['03'] = { title: 'X', tracks: ['001.mp3', '002.mp3', '003.mp3', '004.mp3'].map((file, i) => ({ file, title: titles[i + 1] })), addedAt: 0, updatedAt: 0 };
      // The app updates the catalog after running, with the steps that went through.
      const partial = { ...full, steps: full.steps.slice(0, k) };
      applyPlanToCatalog(c, full, doneSteps(partial, await executePlan(root, partial)));
      const scan = await scanSd(root);
      if (scan.tempDirs.length) {
        const recover = planFix(scan, { kind: 'recover-temp' });
        applyPlanToCatalog(c, recover, doneSteps(recover, await executePlan(root, recover)));
      }
      const after = await scanSd(root);
      touchFolder(c, after.folders[0]);
      const rows = trackRows(after.folders[0], c.folders['03']);
      for (const r of rows) expect(r.title, `step ${k}: ${r.file}`).toBe(titles[r.size]);
      expect(rows.length, `step ${k}`).toBe(k === 0 ? 4 : 3);
    }
  });

  it('notes which folders a repair touched', () => {
    expect(touchedFolders([{ op: 'delete', path: ['.DS_Store'] }, { op: 'rename', dir: ['04'], from: '003.mp3', to: '002.mp3' }])).toEqual([4]);
    expect(touchedFolders([{ op: 'rename', dir: [], from: '5', to: '05' }, { op: 'move', from: ['_tonuino-studio-temp-07', '001.mp3'], toDir: ['07'], name: '001.mp3' }])).toEqual([5, 7]);
  });
});

describe('restoring a catalog from this computer', () => {
  it('only takes a copy whose folders match exactly, the newest first', async () => {
    const scan = await scanSd(memDir({ '01': { '001.mp3': 10 }, '02': { '001.mp3': 5, '002.mp3': 6 } }));
    const copy = (name: string, fps: [string, string | undefined][], updatedAt: number) => {
      const c = newCatalog(name);
      for (const [key, fingerprint] of fps) c.folders[key] = { title: key, tracks: [], fingerprint, addedAt: 0, updatedAt: 0 };
      c.updatedAt = updatedAt;
      return c;
    };
    const exact = folderFingerprint(scan.folders[0]);
    const exact2 = folderFingerprint(scan.folders[1]);
    const otherBox = copy('Andere Box', [['01', '1:99'], ['02', exact2]], 9);
    const older = copy('Alt', [['01', exact], ['02', exact2]], 1);
    const newer = copy('Neu', [['01', exact], ['02', exact2]], 2);
    const noPrint = copy('Ohne', [['01', undefined], ['02', exact2]], 10);
    const more = copy('Mehr', [['01', exact], ['02', exact2], ['03', '1:1']], 11);
    expect(matchLibraryCatalog(scan, [otherBox, noPrint, more])).toBeNull();
    expect(matchLibraryCatalog(scan, [otherBox, older, newer, noPrint, more])?.name).toBe('Neu');
  });
});

describe('folderChanges', () => {
  it('names new, missing and swapped tracks after a change with another program', async () => {
    const c = newCatalog();
    c.folders['01'] = { title: 'Lieder', tracks: [{ file: '001.mp3', title: 'Eins' }, { file: '002.mp3', title: 'Zwei' }, { file: '003.mp3', title: 'Drei' }], addedAt: 0, updatedAt: 0 };
    touchFolder(c, (await scanSd(memDir({ '01': { '001.mp3': 10, '002.mp3': 20, '003.mp3': 30 } }))).folders[0]);
    expect(c.folders['01'].tracks.map((t) => t.size)).toEqual([10, 20, 30]);
    // 002 swapped for another file, 003 gone, 004 new.
    const after = (await scanSd(memDir({ '01': { '001.mp3': 10, '002.mp3': 25, '004.mp3': 40 } }))).folders[0];
    const d = folderChanges(after, c.folders['01']);
    expect(d.added).toEqual(['004.mp3']);
    expect(d.missing.map((t) => t.title)).toEqual(['Drei']);
    expect(d.replaced).toEqual(['002.mp3']);
  });

  it('calls nothing new when the catalog knows no track', async () => {
    const after = (await scanSd(memDir({ '01': { '001.mp3': 10 } }))).folders[0];
    expect(folderChanges(after, { title: 'X', tracks: [], addedAt: 0, updatedAt: 0 })).toEqual({ added: [], missing: [], replaced: [] });
  });
});

describe('saveCatalog', () => {
  it('leaves the file alone when nothing but the time would change', async () => {
    const root = memDir({});
    const c = newCatalog();
    await saveCatalog(root, c);
    const at = c.updatedAt;
    const write = vi.spyOn(root, 'write');
    // A card added and taken out again: the same catalog as before.
    await saveCatalog(root, { ...structuredClone(c), updatedAt: at + 5000 });
    expect(write).not.toHaveBeenCalled();
    await saveCatalog(root, { ...structuredClone(c), name: 'Emmas Box' });
    expect(write).toHaveBeenCalledTimes(1);
    expect((await loadCatalog(root))!.name).toBe('Emmas Box');
  });
});
