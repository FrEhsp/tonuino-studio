import { describe, expect, it, vi } from 'vitest';
import { MemDir, memDir, memTreeNames, type MemTree } from '../../src/platform/memory';
import type { Dir } from '../../src/platform/types';
import { buildSmallId3, readTags } from '../../src/core/audio/id3';
import { concat } from '../audio/helpers';
import { applyPlanToCatalog, newCatalog, type CatalogFolder } from '../../src/core/tonuino/catalog';
import { checkHealth, isComputerDrive, isFatFilesystem, type FixAction, type HealthContext } from '../../src/core/tonuino/health';
import {
  coverCandidate,
  doneSteps,
  executePlan,
  isAutoFixable,
  noteNewFolder,
  planFix,
  planReorder,
  repairAll,
  type PlanStep,
  type RepairPlan,
} from '../../src/core/tonuino/repair';
import {
  folderName,
  helperTrackName,
  importTrackName,
  freeFolderNumbers,
  isJunk,
  MAX_FILE_TIMES,
  missingTrackNumbers,
  nextFolderNumber,
  parseHelperTrackName,
  parseNamedFolder,
  parseNumberedAudio,
  parseTempDir,
  scanSd,
  systemFolderTypo,
  tempDirName,
} from '../../src/core/tonuino/sd';
import { checkSystemSounds, isOversizedSound, TNG_SEPTEMBER_SOUNDS, TNG_SYSTEM_SOUNDS } from '../../src/core/tonuino/systemsounds';

const ctx: HealthContext = { profile: 'tng', trustsDirectoryOrder: true };

/** mp3/ and advert/ with every announcement TNG 3.3.3 expects. */
function systemSounds(): MemTree {
  const mp3: MemTree = {};
  for (const n of TNG_SYSTEM_SOUNDS.mp3) mp3[`${String(n).padStart(4, '0')}.mp3`] = 10;
  const advert: MemTree = {};
  for (const n of TNG_SYSTEM_SOUNDS.advert) advert[`${String(n).padStart(4, '0')}.mp3`] = 10;
  return { mp3, advert };
}

function card(folders: MemTree, extra: MemTree = {}): MemTree {
  return { ...systemSounds(), ...folders, ...extra };
}

/** The files a plan gives a new name, in place or on their way through the helper folder. */
function renamesIn(steps: PlanStep[]): string[] {
  return steps.flatMap((st) => {
    if (st.op === 'rename') return [`${st.from} → ${st.to}`];
    if (st.op === 'move' && st.from.at(-1) !== st.name) return [`${st.from.at(-1)} → ${st.name}`];
    return [];
  });
}

async function fixAndRescan(root: ReturnType<typeof memDir>, fix: FixAction) {
  const scan = await scanSd(root);
  const plan = planFix(scan, fix);
  const result = await executePlan(root, plan);
  expect(result.error).toBeUndefined();
  return { plan, scan: await scanSd(root) };
}

describe('SD naming rules', () => {
  it('recognises junk from all operating systems', () => {
    for (const n of ['._001.mp3', '.DS_Store', 'System Volume Information', '$RECYCLE.BIN', '.Trash-1000', '.Trashes', '.Spotlight-V100', 'Thumbs.db', '001.mp3.crswap', 'tonuino-studio.json.tonuino-tmp']) {
      expect(isJunk(n), n).toBe(true);
    }
    for (const n of ['001.mp3', 'mp3', 'advert', 'tonuino-studio.json', '.hidden-but-not-junk']) expect(isJunk(n), n).toBe(false);
  });

  it('parses track names with digits and suffixes', () => {
    expect(parseNumberedAudio('001.mp3')).toEqual({ number: 1, suffix: '', ext: 'mp3', digits: 3 });
    expect(parseNumberedAudio('012 Kapitel 3.MP3')).toEqual({ number: 12, suffix: ' Kapitel 3', ext: 'mp3', digits: 3 });
    expect(parseNumberedAudio('0300_new_tag.mp3')?.number).toBe(300);
    expect(parseNumberedAudio('Kapitel 1.mp3')).toBeNull();
    expect(parseNumberedAudio('001.m4a')).toBeNull();
  });

  it('recognises helper folders of interrupted repairs', () => {
    expect(tempDirName(5)).toBe('_tonuino-studio-temp-05');
    expect(parseTempDir('_tonuino-studio-temp-05')).toBe(5);
    expect(parseTempDir('_tonuino-studio-temp')).toBeNull();
    expect(parseTempDir('05')).toBeUndefined();
  });

  it('names tracks in the helper folder of a reorder with both numbers', () => {
    expect(helperTrackName(2, '005 Zwei.mp3', true)).toBe('002=005 Zwei.mp3');
    expect(helperTrackName(2, '005 Zwei.mp3', false)).toBe('002+005 Zwei.mp3');
    expect(parseHelperTrackName('002=005 Zwei.mp3')).toEqual({ oldName: '005 Zwei.mp3', newName: '002.mp3' });
    expect(parseHelperTrackName('002+005 Zwei.MP3')).toEqual({ oldName: '005 Zwei.MP3', newName: '002 Zwei.mp3' });
    // Plain names of other files are never read as encoded.
    for (const n of ['001.mp3', '001=cover.jpg', '300=001.mp3', '000=001.mp3', 'cover.jpg']) expect(parseHelperTrackName(n), n).toBeNull();
  });

  it('tells FAT from exFAT and NTFS', () => {
    for (const fs of ['vfat', 'FAT32', 'FAT', 'msdos', 'fat16']) expect(isFatFilesystem(fs), fs).toBe(true);
    for (const fs of ['exfat', 'exFAT', 'NTFS', 'ext4', 'fuseblk', 'apfs']) expect(isFatFilesystem(fs), fs).toBe(false);
  });
});

describe('importTrackName', () => {
  it('uses pure numbers by default and readable ASCII text otherwise', () => {
    expect(importTrackName(7, 'Der Bär läuft', true)).toBe('007.mp3');
    expect(importTrackName(7, 'Der Bär läuft', false)).toBe('007_Der_Baer_laeuft.mp3');
    expect(importTrackName(12, 'Kapitel 3: Süßes Café!', false)).toBe('012_Kapitel_3_Suesses_Cafe.mp3');
    expect(importTrackName(255, '???', false)).toBe('255.mp3');
    expect(importTrackName(1, 'x'.repeat(80), false)).toBe(`001_${'x'.repeat(40)}.mp3`);
  });
});

describe('scanSd', () => {
  it('classifies empty, foreign and TonUINO cards', async () => {
    expect((await scanSd(memDir({}))).kind).toBe('empty');
    expect((await scanSd(memDir({ '.Trash-1000': {}, 'System Volume Information': {} }))).kind).toBe('empty');
    expect((await scanSd(memDir({ DCIM: { '100CANON': {} } }))).kind).toBe('foreign');
    expect((await scanSd(memDir({ '01': { '001.mp3': 5 } }))).kind).toBe('tonuino');
    expect((await scanSd(memDir({ MP3: { '0001.mp3': 5 } }))).kind).toBe('tonuino');
  });

  it('sorts folder content into tracks, wrong names, junk and others', async () => {
    const scan = await scanSd(
      memDir({
        '01': { '002.mp3': 2, '001.mp3': 1, '._001.mp3': 1, 'cover.jpg': 3, '1.mp3': 1, 'Intro.mp3': 4, '000.mp3': 1, Bonus: {} },
        '5': {},
        'Fotos': {},
        'tonuino-studio.json': '{}',
      }),
    );
    expect(scan.kind).toBe('tonuino');
    expect(scan.hasCatalog).toBe(true);
    const f = scan.folders[0];
    expect(f.tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3']);
    expect(f.tracks.map((t) => t.order)).toEqual([1, 0]);
    expect(f.wrongDigits.map((t) => t.name)).toEqual(['1.mp3']);
    expect(f.unnumbered.map((e) => e.name)).toEqual(['Intro.mp3', '000.mp3']);
    expect(f.others.map((e) => e.name)).toEqual(['cover.jpg']);
    expect(f.junk.map((e) => e.name)).toEqual(['._001.mp3']);
    expect(f.subfolders.map((e) => e.name)).toEqual(['Bonus']);
    expect(scan.invalidFolders.map((e) => e.name)).toEqual(['5']);
    expect(scan.rootOthers.map((e) => e.name)).toEqual(['Fotos']);
  });

  it('finds free folder numbers', async () => {
    const scan = await scanSd(memDir({ '01': { '001.mp3': 1 }, '03': { '001.mp3': 1 } }));
    expect(nextFolderNumber(scan)).toBe(2);
    expect(nextFolderNumber(scan, [2])).toBe(4);
    expect(freeFolderNumbers(scan)).toHaveLength(97);
  });
});

describe('system sounds', () => {
  it('reports missing, incomplete, outdated and complete sets', async () => {
    expect(checkSystemSounds(await scanSd(memDir({ '01': {} })), 'tng').state).toBe('missing');
    expect(checkSystemSounds(await scanSd(memDir(card({}))), 'tng').state).toBe('ok');

    const old = systemSounds() as { mp3: MemTree; advert: MemTree };
    delete old.mp3['0340.mp3'];
    expect(checkSystemSounds(await scanSd(memDir(old)), 'tng').state).toBe('outdated');
    expect(checkSystemSounds(await scanSd(memDir(old)), 'classic21').state).toBe('ok');

    // The start tone of TNG is no newer extra: without it the box hangs after the first card (forum 12980).
    const noTone = systemSounds() as { mp3: MemTree; advert: MemTree };
    delete noTone.mp3['0262.mp3'];
    expect(checkSystemSounds(await scanSd(memDir(noTone)), 'tng').state).toBe('incomplete');
    const toneIssue = checkHealth(await scanSd(memDir(noTone)), ctx).issues.find((i) => i.id === 'system-outdated')!;
    expect(toneIssue).toMatchObject({ severity: 'error', title: 'Eine wichtige Systemansage fehlt', items: ['mp3/0262.mp3'], help: '#/hilfe/keine-ansagen' });
    // Only the tone is missing: one sentence about it, no "Ansagen … darunter" and no "auch".
    expect(toneIssue.detail).toBe(
      'Es fehlt mp3/0262.mp3, der kurze Ton, wenn du eine Karte auflegst. Ohne ihn spielt die erste Karte noch, danach reagiert die Box oft nicht mehr („Fehler 6“).',
    );
    // With a newer extra missing as well, that one is named after it.
    delete noTone.mp3['0340.mp3'];
    expect(checkHealth(await scanSd(memDir(noTone)), ctx).issues.find((i) => i.id === 'system-outdated')!.detail).toMatch(
      /„Fehler 6“\)\. Außerdem fehlt eine Ansage, die neuere Firmware-Versionen nutzen\.$/,
    );
    // With other important ones missing, the tone is named among them.
    delete noTone.mp3['0900.mp3'];
    const many = checkHealth(await scanSd(memDir(noTone)), ctx).issues.find((i) => i.id === 'system-outdated')!;
    expect(many.title).toBe('Wichtige Systemansagen fehlen');
    expect(many.detail).toMatch(/^Es fehlen 3 Ansagen, darunter solche, die jede Box braucht\. .* Darunter ist auch mp3\/0262\.mp3, /);
    expect(many.detail.match(/Fehler 6/g)).toHaveLength(1);
    // Empty announcements are not missing ones: the health check names them once, as empty.
    const empty = systemSounds() as { mp3: MemTree; advert: MemTree };
    empty.advert['0262.mp3'] = 0;
    expect(checkSystemSounds(await scanSd(memDir(empty)), 'tng')).toMatchObject({ state: 'ok', empty: { mp3: [], advert: ['0262.mp3'] } });
    expect(checkHealth(await scanSd(memDir(empty)), ctx).issues.filter((i) => i.id.startsWith('system-')).map((i) => i.id)).toEqual(['system-empty:advert']);
    // An empty file next to a missing newer extra: still "älter als die Firmware", not "wichtige fehlen".
    delete empty.mp3['0340.mp3'];
    expect(checkSystemSounds(await scanSd(memDir(empty)), 'tng').state).toBe('outdated');
    const both = checkHealth(await scanSd(memDir(empty)), ctx).issues.filter((i) => i.id.startsWith('system-'));
    expect(both.map((i) => [i.id, i.severity, i.title])).toEqual([
      ['system-empty:advert', 'error', 'Leere Ansagen im Ordner advert'],
      ['system-outdated', 'warning', 'Die Systemansagen sind älter als die Firmware'],
    ]);
    expect(both[1].detail).toBe('Es fehlt eine Ansage, die neuere Firmware-Versionen nutzen. Nach einem Firmware-Update gehören auch die passenden Systemansagen auf die Karte.');
    expect(both[1].detail).not.toContain('Fehler 6');

    delete old.mp3['0300.mp3'];
    const st = checkSystemSounds(await scanSd(memDir(old)), 'tng');
    expect(st.state).toBe('incomplete');
    expect(st.missing.mp3).toEqual([300, 340]);
  });

  it('asks the files new on 17.09.2026 only of boxes that new (Endlos card, last Hörbuch folder)', async () => {
    // sd-card of the release tag V3.3.3_2026.02.25: advert ends at 0324, mp3 has no 0302 and no 0981.
    const tag = systemSounds() as { mp3: MemTree; advert: MemTree };
    for (const n of TNG_SEPTEMBER_SOUNDS.mp3) delete tag.mp3[`${String(n).padStart(4, '0')}.mp3`];
    for (const n of TNG_SEPTEMBER_SOUNDS.advert) delete tag.advert[`${String(n).padStart(4, '0')}.mp3`];
    const scan = await scanSd(memDir(tag));
    expect(TNG_SEPTEMBER_SOUNDS).toEqual({ mp3: [302, 981], advert: [325, 326] });
    for (const release of ['unknown', 'older'] as const) {
      const st = checkSystemSounds(scan, 'tng', release);
      expect(st.state, release).toBe('ok');
      expect(st.missing, release).toEqual({ mp3: [], advert: [] });
      expect(st.september, release).toEqual({ mp3: [302, 981], advert: [325, 326] });
    }
    const newer = checkSystemSounds(scan, 'tng', 'newer');
    expect(newer.state).toBe('outdated');
    expect(newer.missing).toEqual({ mp3: [302, 981], advert: [325, 326] });
    expect(newer.september).toEqual({ mp3: [], advert: [] });
    // A box with the older release is not told its card is older than its firmware.
    expect(checkHealth(scan, { ...ctx, tngRelease: 'older' }).issues.filter((i) => i.id.startsWith('system-'))).toEqual([]);
    expect(checkHealth(scan, ctx).issues.filter((i) => i.id.startsWith('system-'))).toEqual([]);
    expect(checkHealth(scan, { ...ctx, tngRelease: 'newer' }).issues.find((i) => i.id === 'system-outdated')?.severity).toBe('warning');
    // Nothing of it for 2.1.
    expect(checkSystemSounds(scan, 'classic21').september).toEqual({ mp3: [], advert: [] });
  });

  it('counts a number twice when the official name with text sits next to the pure one', async () => {
    const s = systemSounds() as { mp3: MemTree; advert: MemTree };
    s.mp3['0300_new_tag.mp3'] = 10;
    const st = checkSystemSounds(await scanSd(memDir(s)), 'tng');
    expect(st.duplicates.mp3).toEqual([300]);
  });
});

describe('health check and repairs', () => {
  it('is happy with a clean card', async () => {
    const report = checkHealth(await scanSd(memDir(card({ '01': { '001.mp3': 1, '002.mp3': 1 } }))), ctx);
    expect(report.issues).toEqual([]);
    expect(report.status).toBe('ok');
  });

  it('warns about exFAT, big cards and small clusters', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1 } })));
    const ids = (volume: HealthContext['volume']) => checkHealth(scan, { ...ctx, volume }).issues.map((i) => i.id);
    expect(ids({ fsType: 'exfat' })).toContain('fs-type');
    expect(ids({ fsType: 'vfat', clusterSize: 32768, totalBytes: 31e9 })).toEqual([]);
    expect(ids({ fsType: 'vfat', totalBytes: 64e9 })).toEqual(['size']);
    expect(ids({ fsType: 'vfat', clusterSize: 4096 })).toEqual(['cluster']);
  });

  it('a folder on the computer is no card: its disk gives no alarm about format or size', async () => {
    // As Linux reports a folder on the computer's own disk (e.g. 937 GB ext4): no red mark for "the card".
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1 } })));
    const disk = { fsType: 'ext4', removable: false, totalBytes: 937.5 * 1024 ** 3, freeBytes: 761.3 * 1024 ** 3, clusterSize: 4096 };
    const report = checkHealth(scan, { ...ctx, volume: disk });
    expect(report.issues.map((i) => [i.id, i.severity])).toEqual([['not-a-card', 'info']]);
    expect(report.status).toBe('ok');
    for (const fs of ['ext4', 'btrfs', 'NTFS', 'fuseblk', 'apfs', '']) expect(isComputerDrive({ fsType: fs, removable: false }), fs).toBe(true);
    // A card in a reader the system does not call removable is still checked as a card.
    expect(isComputerDrive({ fsType: 'vfat', removable: false })).toBe(false);
    expect(isComputerDrive({ fsType: 'exfat', removable: false })).toBe(false);
    expect(checkHealth(scan, { ...ctx, volume: { fsType: 'exfat', removable: false } }).issues.map((i) => i.id)).toContain('fs-type');
    // A removable drive, or one the platform says nothing about (browser), is a card.
    expect(isComputerDrive({ fsType: 'ntfs', removable: true })).toBe(false);
    expect(isComputerDrive({})).toBe(false);
    expect(isComputerDrive(undefined)).toBe(false);
  });

  it('does not send big cards to the SD Card Formatter, which makes them exFAT again', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1 } })));
    const issues = (volume: HealthContext['volume']) => checkHealth(scan, { ...ctx, volume }).issues;
    const detail = (volume: HealthContext['volume']) => issues(volume).find((i) => i.id === 'fs-type')?.detail ?? '';
    expect(detail({ fsType: 'exfat', totalBytes: 31e9 })).toContain('am besten mit dem Programm „SD Card Formatter“');
    expect(detail({ fsType: 'exfat', totalBytes: 64e9 })).toContain('immer mit exFAT');
    expect(detail({ fsType: 'exfat', totalBytes: 64e9 })).toContain('höchstens 32 GB');
    expect(issues({ fsType: 'vfat', clusterSize: 16384, totalBytes: 64e9 }).map((i) => i.id)).toEqual(['size']);
  });

  it('treats AppleDouble files in audio folders as an error and cleans them', async () => {
    const root = memDir(card({ '01': { '001.mp3': 1, '._001.mp3': 1 } }, { '.Spotlight-V100': { x: 1 }, '.DS_Store': 1 }));
    const report = checkHealth(await scanSd(root), ctx);
    const junk = report.issues.find((i) => i.id === 'junk')!;
    expect(junk.severity).toBe('error');
    expect(junk.detail).toContain('macOS');
    const { scan } = await fixAndRescan(root, junk.fix!);
    expect(checkHealth(scan, ctx).issues).toEqual([]);
  });

  it('closes gaps without changing the order', async () => {
    const root = memDir(card({ '02': { '001.mp3': 1, '002 Zwei.mp3': 2, '004.mp3': 4, '007 Sieben.mp3': 7 } }));
    const report = checkHealth(await scanSd(root), ctx);
    const gap = report.issues.find((i) => i.id === 'gap:02')!;
    expect(gap.detail).toContain('003, 005, 006');
    expect(gap.fixWarning).toBeTruthy();
    const { scan } = await fixAndRescan(root, gap.fix!);
    expect(scan.folders[0].tracks.map((t) => [t.name, t.size])).toEqual([
      ['001.mp3', 1],
      ['002 Zwei.mp3', 2],
      ['003.mp3', 4],
      ['004 Sieben.mp3', 7],
    ]);
    expect(missingTrackNumbers(scan.folders[0])).toEqual([]);
  });

  it('moves duplicate numbers to the end, keeping the plain name', async () => {
    const root = memDir(card({ '03': { '001_Startsound.mp3': 9, '001.mp3': 1, '002.mp3': 2 } }));
    const report = checkHealth(await scanSd(root), ctx);
    const dup = report.issues.find((i) => i.id === 'dup:03')!;
    expect(dup.severity).toBe('error');
    const { scan } = await fixAndRescan(root, dup.fix!);
    expect(scan.folders[0].tracks.map((t) => [t.name, t.size])).toEqual([
      ['001.mp3', 1],
      ['002.mp3', 2],
      ['003_Startsound.mp3', 9],
    ]);
  });

  it('numbers unnumbered files in natural order after the last track', async () => {
    const root = memDir(card({ '04': { '001.mp3': 1, 'Kapitel 10.mp3': 10, 'Kapitel 2.mp3': 2, 'Kapitel 1.mp3': 1 } }));
    const issue = checkHealth(await scanSd(root), ctx).issues.find((i) => i.id === 'unnumbered:04')!;
    const { plan, scan } = await fixAndRescan(root, issue.fix!);
    expect(plan.summary).toEqual(['Kapitel 1.mp3 → 002.mp3', 'Kapitel 2.mp3 → 003.mp3', 'Kapitel 10.mp3 → 004.mp3']);
    expect(scan.folders[0].tracks.map((t) => t.size)).toEqual([1, 1, 2, 10]);
  });

  it('fixes wrong digit counts, and does not report them as gaps', async () => {
    const root = memDir(card({ '05': { '1.mp3': 1, '0002.mp3': 2, '003.mp3': 3 } }));
    const report = checkHealth(await scanSd(root), ctx);
    expect(report.issues.map((i) => i.id)).toEqual(['digits:05']);
    const { scan } = await fixAndRescan(root, report.issues[0].fix!);
    expect(scan.folders[0].tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(checkHealth(scan, ctx).issues.filter((i) => i.folder === 5)).toEqual([]);
  });

  it('ignores case-only differences when normalizing names', async () => {
    const scan = await scanSd(memDir(card({ '06': { '001.MP3': 1, '002 Titel.mp3': 1 } })));
    const plan = planFix(scan, { kind: 'normalize-names', folder: 6 });
    expect(plan.steps.filter((st) => st.op === 'title')).toEqual([{ op: 'title', dir: ['06'], file: '002 Titel.mp3', title: 'Titel' }]);
    expect(renamesIn(plan.steps)).toEqual(['002 Titel.mp3 → 002.mp3']);
  });

  it('strips text after the number for that info, also when titles in names are switched on', async () => {
    const scan = await scanSd(memDir(card({ '06': { '001 Kapitel 1.mp3': 1, '002.mp3': 1 } })));
    const issue = checkHealth(scan, ctx).issues.find((i) => i.id === 'suffix:06')!;
    expect(issue.fix).toEqual({ kind: 'normalize-names', folder: 6, pure: true });
    expect(issue.severity).toBe('warning');
    expect(issue.fixLabel).toBe('Sicher umbenennen');
    expect(issue.fixWarning).toContain('die Reihenfolge bleibt');
    const plan = planFix(scan, issue.fix!, { pureNumbers: false });
    expect(plan.steps.filter((st) => st.op === 'title')).toEqual([{ op: 'title', dir: ['06'], file: '001 Kapitel 1.mp3', title: 'Kapitel 1' }]);
    expect(renamesIn(plan.steps)).toEqual(['001 Kapitel 1.mp3 → 001.mp3']);
    // Names with words chosen in the settings: only a hint.
    expect(checkHealth(scan, { ...ctx, pureNumbers: false }).issues.find((i) => i.id === 'suffix:06')!.severity).toBe('info');
  });

  it('renames safely without mixing up the order of the files on the card', async () => {
    // On FAT a renamed file gets a new entry, mostly at the end of the folder (as in the browser's
    // file access): renamed in place, the check found „Reihenfolge auf der Karte stimmt nicht“ in a
    // folder it had just repaired. memDir keeps the entry where it was, so rename like FAT here.
    const fatRename = vi.spyOn(MemDir.prototype, 'rename').mockImplementation(function (this: MemDir, from: string, to: string) {
      return this.move(from, this, to);
    });
    const root = memDir(card({ '06': { '001 Kapitel 1.mp3': 1, '002.mp3': 2, '003 Kapitel 3.mp3': 3, 'cover.jpg': 4 } }));
    const issue = checkHealth(await scanSd(root), ctx).issues.find((i) => i.id === 'suffix:06')!;
    const { scan } = await fixAndRescan(root, issue.fix!).finally(() => fatRename.mockRestore());
    expect(scan.folders[0].tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(scan.folders[0].others.map((e) => e.name)).toEqual(['cover.jpg']);
    expect(scan.tempDirs).toEqual([]);
    // Only the hint about the picture is left, which was there before.
    expect(checkHealth(scan, ctx).issues.filter((i) => i.folder === 6).map((i) => i.id)).toEqual(['others:06']);
  });

  it('renames safely: the words of the old name go into an empty title, in order', async () => {
    const tagged = concat([buildSmallId3({ title: 'Schon da' }), new Uint8Array(20)]);
    const root = memDir(card({ '06': { '001_Intro.mp3': new Uint8Array(20), '002-Der_Hund.mp3': tagged, '003 7.mp3': new Uint8Array(20), '004.mp3': 1 } }));
    const scan = await scanSd(root);
    const plan = planFix(scan, { kind: 'normalize-names', folder: 6, pure: true });
    expect(plan.summary[0]).toContain('Die Reihenfolge bleibt');
    expect(plan.steps.filter((st) => st.op === 'title')).toEqual([
      { op: 'title', dir: ['06'], file: '001_Intro.mp3', title: 'Intro' },
      { op: 'title', dir: ['06'], file: '002-Der_Hund.mp3', title: 'Der Hund' },
    ]);
    const c = newCatalog();
    c.folders['06'] = { title: 'X', tracks: [{ file: '001_Intro.mp3' }, { file: '002-Der_Hund.mp3', title: 'Hund' }], addedAt: 0, updatedAt: 0 };
    const result = await executePlan(root, plan);
    expect(result.error).toBeUndefined();
    applyPlanToCatalog(c, plan);
    const dir = await root.dir('06');
    const titleOf = async (f: string) => (await readTags(await dir.source(f))).tags.title;
    expect(await titleOf('001.mp3')).toBe('Intro');
    expect(await titleOf('002.mp3')).toBe('Schon da'); // a title stays as it is
    expect(await dir.read('003.mp3')).toEqual(new Uint8Array(20)); // only a number after the number: nothing to keep
    expect(c.folders['06'].tracks).toEqual([
      { file: '001.mp3', title: 'Intro' },
      { file: '002.mp3', title: 'Hund' },
    ]);
  });

  it('rebuilds the directory order even when junk files are in the folder', async () => {
    const root = memDir(card({ '07': { '003.mp3': 3, '001.mp3': 1, '._002.mp3': 1, '002.mp3': 2 } }));
    const order = checkHealth(await scanSd(root), ctx).issues.find((i) => i.id === 'order:07')!;
    expect(order.severity).toBe('warning');
    await fixAndRescan(root, order.fix!);
    const tree = (await memTreeNames(root)) as Record<string, Record<string, number>>;
    expect(Object.keys(tree['07'])).toEqual(['001.mp3', '002.mp3', '003.mp3']);
  });

  it('stops before deleting a folder that still holds files', async () => {
    const root = memDir(card({ '07': { '002.mp3': 2, '001.mp3': 1 } }));
    const plan = planFix(await scanSd(root), { kind: 'rebuild-order', folder: 7 });
    // Someone copied a file into the folder between planning and running.
    await (await root.dir('07')).write('003.mp3', new Uint8Array(3));
    const result = await executePlan(root, plan);
    expect(result.error?.message).toMatch(/nicht leer/);
    expect(result.error?.step.op).toBe('rmdir');
    // Nothing is lost: the moved files wait in the helper folder and the health check offers to put them back.
    const scan = await scanSd(root);
    expect(scan.tempDirs[0].entries.map((e) => e.name).sort()).toEqual(['001.mp3', '002.mp3']);
    const { scan: after } = await fixAndRescan(root, { kind: 'recover-temp' });
    expect(after.tempDirs).toEqual([]);
    expect(after.folders[0].tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
  });

  it('rebuilds the directory order end to end', async () => {
    const root = memDir(card({ '07': { '003.mp3': 3, '001.mp3': 1, '002.mp3': 2, 'cover.jpg': 5 } }));
    const { scan } = await fixAndRescan(root, { kind: 'rebuild-order', folder: 7 });
    const tree = (await memTreeNames(root)) as Record<string, Record<string, number>>;
    expect(Object.keys(tree['07'])).toEqual(['001.mp3', '002.mp3', '003.mp3', 'cover.jpg']);
    expect(Object.keys(tree)).not.toContain(tempDirName(7));
    // The order is right now; the picture stays and is a matter of its own.
    expect(checkHealth(scan, ctx).issues.map((i) => i.id)).toEqual(['others:07']);
  });

  it('refuses to rebuild a folder with subfolders', async () => {
    const scan = await scanSd(memDir(card({ '08': { '002.mp3': 2, '001.mp3': 1, Bonus: { 'a.mp3': 1 } } })));
    const plan = planFix(scan, { kind: 'rebuild-order', folder: 8 });
    expect(plan.steps).toEqual([]);
    expect(plan.leftovers[0]).toMatch(/Unterordner/);
  });

  it('puts files of an interrupted repair back into their folder', async () => {
    const root = memDir(card({ '01': { '001.mp3': 1 } }, { [tempDirName(9)]: { '002.mp3': 2, '001.mp3': 1, '._001.mp3': 1 } }));
    const report = checkHealth(await scanSd(root), ctx);
    const temp = report.issues.find((i) => i.id === 'temp')!;
    expect(temp.severity).toBe('error');
    const { scan } = await fixAndRescan(root, temp.fix!);
    expect(scan.tempDirs).toEqual([]);
    expect(scan.folders.find((f) => f.number === 9)!.tracks.map((t) => [t.name, t.order])).toEqual([
      ['001.mp3', 0],
      ['002.mp3', 1],
    ]);
  });

  it('never overwrites when putting files back: a taken track number moves to the end', async () => {
    const root = memDir(card({ '09': { '001.mp3': 1, 'cover.jpg': 4 } }, { [tempDirName(9)]: { '001.mp3': 7, '002.mp3': 2, 'cover.jpg': 3 } }));
    const plan = planFix(await scanSd(root), { kind: 'recover-temp' });
    expect(plan.summary).toContain('001.mp3 gibt es in Ordner 09 schon. Die Datei aus dem Hilfsordner kommt als 003.mp3 ans Ende.');
    // A file that is not a track has no number to move to: it waits in the helper folder.
    expect(plan.leftovers).toEqual([`${tempDirName(9)}/cover.jpg: In Ordner 09 gibt es schon eine Datei mit diesem Namen.`]);
    expect(plan.steps.some((s) => s.op === 'rmdir')).toBe(false);
    expect((await executePlan(root, plan)).error).toBeUndefined();
    const after = await scanSd(root);
    expect(after.folders[0].tracks.map((t) => [t.name, t.size])).toEqual([
      ['001.mp3', 1],
      ['002.mp3', 2],
      ['003.mp3', 7],
    ]);
    expect(after.folders[0].others.map((e) => [e.name, e.size])).toEqual([['cover.jpg', 4]]);
    expect(after.tempDirs[0].entries.map((e) => [e.name, e.size])).toEqual([['cover.jpg', 3]]);
  });

  it('removes empty folders only when they are really empty', async () => {
    const root = memDir(card({ '01': { '001.mp3': 1 }, '02': { '.DS_Store': 1 }, '03': { 'cover.jpg': 1 } }));
    const report = checkHealth(await scanSd(root), ctx);
    const e2 = report.issues.find((i) => i.id === 'empty:02')!;
    const e3 = report.issues.find((i) => i.id === 'empty:03')!;
    expect(e2.fix).toEqual({ kind: 'remove-empty-folder', folder: 2 });
    expect(e3.fix).toBeUndefined();
    expect(e3.title).toMatch(/keine Audiodateien/);
    const { scan } = await fixAndRescan(root, e2.fix!);
    expect(scan.folders.map((f) => f.name)).toEqual(['01', '03']);
  });

  it('renames invalid folder names', async () => {
    const root = memDir(card({ '5': { '001.mp3': 1 }, '100': {} }));
    const report = checkHealth(await scanSd(root), ctx);
    const inv = report.issues.find((i) => i.id === 'invalid-folder:5')!;
    expect(inv.fixLabel).toBe('In 05 umbenennen');
    expect(report.issues.find((i) => i.id === 'invalid-folder:100')!.fix).toBeUndefined();
    const { scan } = await fixAndRescan(root, inv.fix!);
    expect(scan.folders.map((f) => f.name)).toEqual(['05']);
  });

  it('normalizes system sound names but leaves duplicates alone', async () => {
    const s = systemSounds() as { mp3: MemTree; advert: MemTree };
    delete s.mp3['0300.mp3'];
    s.mp3['0300_new_tag.mp3'] = 10;
    s.mp3['301.mp3'] = 10;
    delete s.mp3['0301.mp3'];
    s.advert['0001_x.mp3'] = 10;
    const root = memDir(s);
    const report = checkHealth(await scanSd(root), ctx);
    // 0001_x.mp3 is no case for system-suffix: renaming it would clash with 0001.mp3.
    expect(report.issues.map((i) => i.id)).toEqual(['system-digits:mp3', 'system-outdated', 'system-suffix:mp3', 'system-dup:advert']);
    expect(report.issues.find((i) => i.id === 'system-suffix:mp3')!.items).toEqual(['mp3/0300_new_tag.mp3']);
    const plan = planFix(await scanSd(root), { kind: 'normalize-system-names' });
    expect(plan.steps).toEqual([
      { op: 'title', dir: ['mp3'], file: '0300_new_tag.mp3', title: 'new tag' },
      { op: 'rename', dir: ['mp3'], from: '0300_new_tag.mp3', to: '0300.mp3' },
      { op: 'rename', dir: ['mp3'], from: '301.mp3', to: '0301.mp3' },
    ]);
    expect(plan.leftovers).toEqual(['advert/0001_x.mp3: Nummer doppelt vergeben.']);
  });
});

/** Name → size of every file in a folder, in name order. */
async function sizes(root: ReturnType<typeof memDir>, folder: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of (await (await root.dir(folder)).list()).sort((a, b) => a.name.localeCompare(b.name))) out[e.name] = e.size ?? -1;
  return out;
}

function sorted(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

describe('interrupted reorder', () => {
  const cases: { label: string; folder: Record<string, number>; order: string[]; pure: boolean; deleted: Record<string, number>; after: Record<string, number> }[] = [
    {
      label: 'pure numbers, one track deleted',
      folder: { '001.mp3': 1, '002.mp3': 2, '003.mp3': 3, '004.mp3': 4, '005.mp3': 5, 'cover.jpg': 9 },
      order: ['005.mp3', '001.mp3', '002.mp3', '003.mp3'],
      pure: true,
      deleted: { '001.mp3': 1, '002.mp3': 2, '003.mp3': 3, '005.mp3': 5, 'cover.jpg': 9 },
      after: { '001.mp3': 5, '002.mp3': 1, '003.mp3': 2, '004.mp3': 3, 'cover.jpg': 9 },
    },
    {
      label: 'names with text after the number',
      folder: { '001 Eins.mp3': 1, '002 Zwei.mp3': 2, '003 Drei.mp3': 3 },
      order: ['003 Drei.mp3', '001 Eins.mp3', '002 Zwei.mp3'],
      pure: false,
      deleted: { '001 Eins.mp3': 1, '002 Zwei.mp3': 2, '003 Drei.mp3': 3 },
      after: { '001 Drei.mp3': 3, '002 Eins.mp3': 1, '003 Zwei.mp3': 2 },
    },
  ];

  for (const c of cases) {
    it(`can be put back after every single step (${c.label})`, async () => {
      const full = planReorder((await scanSd(memDir(card({ '05': c.folder })))).folders[0], c.order, { pureNumbers: c.pure });
      expect(full.leftovers).toEqual([]);
      const newFrom = full.steps.findIndex((s) => s.op === 'mkdir' && s.path[1] === 'neue-nummern') + 1;
      for (let k = 0; k <= full.steps.length; k++) {
        const root = memDir(card({ '05': c.folder }));
        const partial: RepairPlan = { ...full, steps: full.steps.slice(0, k) };
        expect((await executePlan(root, partial)).error, `step ${k}`).toBeUndefined();
        const scan = await scanSd(root);
        if (scan.tempDirs.length) {
          const recover = planFix(scan, { kind: 'recover-temp' });
          expect(recover.leftovers, `step ${k}`).toEqual([]);
          expect((await executePlan(root, recover)).error, `step ${k}`).toBeUndefined();
        }
        expect((await scanSd(root)).tempDirs, `step ${k}`).toEqual([]);
        // Nothing lost and no mix: the old names until the folder was recreated, the new order after.
        const expected = k === 0 ? c.folder : k < newFrom ? c.deleted : c.after;
        expect(await sizes(root, '05'), `step ${k}`).toEqual(sorted(expected));
      }
    });
  }

  it('does not start while a helper folder of the same folder is still there', async () => {
    const root = memDir(card({ '05': { '001.mp3': 1, '002.mp3': 2 } }, { [tempDirName(5)]: { '003.mp3': 3 } }));
    const scan = await scanSd(root);
    const plan = planReorder(scan.folders[0], ['002.mp3', '001.mp3'], { pureNumbers: true, tempDirs: scan.tempDirs });
    expect(plan.steps).toEqual([]);
    expect(plan.leftovers[0]).toMatch(/Dateien zurücklegen/);
    expect(planFix(scan, { kind: 'rebuild-order', folder: 5 }).leftovers[0]).toMatch(/Dateien zurücklegen/);
  });

  it('stops before touching a helper folder that appeared after planning', async () => {
    const root = memDir(card({ '05': { '001.mp3': 1, '002.mp3': 2 } }));
    const plan = planReorder((await scanSd(root)).folders[0], ['002.mp3', '001.mp3'], { pureNumbers: true });
    await (await root.dir(tempDirName(5), { create: true })).write('001=002.mp3', new Uint8Array(7));
    const result = await executePlan(root, plan);
    expect(result.error?.step).toMatchObject({ op: 'mkdir', fresh: true });
    expect(result.completed).toBe(0);
    expect(await sizes(root, '05')).toEqual({ '001.mp3': 1, '002.mp3': 2 });
    expect(await sizes(root, tempDirName(5))).toEqual({ '001=002.mp3': 7 });
  });
});

/** A card on which the top-level ".Spotlight-V100" cannot be deleted, as on a Mac. */
function protectedCard(tree: MemTree) {
  const root = memDir(tree);
  const remove = root.remove.bind(root);
  root.remove = async (name, opts) => {
    if (name === '.Spotlight-V100') throw new Error('.Spotlight-V100 löschen: Zugriff verweigert.');
    return remove(name, opts);
  };
  return root;
}

describe('cleaning up junk', () => {
  it('counts every hidden file, names each system once and the Linux bin apart', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1, '._001.mp3': 1 } }, { '.Trash-1000': { x: 1 } })));
    const junk = checkHealth(scan, ctx).issues.find((i) => i.id === 'junk')!;
    expect(junk.title).toBe('1 Begleitdatei von macOS bei den Titeln, dazu 1 weitere versteckte Datei');
    expect(junk.detail).toMatch(/^macOS und Linux haben unsichtbare Begleitdateien angelegt\./);
    expect(junk.detail).toContain('Papierkorb von Linux');
    expect(planFix(scan, { kind: 'clean-junk' }).summary[0]).toBe('1 versteckte Datei und 1 versteckter Ordner werden gelöscht.');
  });

  it('names the macOS companions apart from other hidden files, wherever they lie', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1, '._001.mp3': 1 }, '02': { '001.mp3': 1, '.DS_Store': 1 } }, { mp3: { '0001.mp3': 1, '._0001.mp3': 1 } })));
    const junk = checkHealth(scan, ctx).issues.find((i) => i.id === 'junk')!;
    expect(junk.title).toBe('2 Begleitdateien von macOS bei den Titeln, dazu 1 weitere versteckte Datei');
  });

  it('says how many announcements are missing when it lists only the first', async () => {
    const scan = await scanSd(memDir({ mp3: { '0001.mp3': 10 }, advert: { '0001.mp3': 10 }, '01': { '001.mp3': 1 } }));
    const missing = checkHealth(scan, ctx).issues.find((i) => i.id === 'system-outdated')!;
    expect(missing.items!.length).toBeLessThan(missing.itemsTotal!);
    // Without knowing the TNG release, the four files new on 17.09.2026 do not count.
    const september = TNG_SEPTEMBER_SOUNDS.mp3.length + TNG_SEPTEMBER_SOUNDS.advert.length;
    expect(missing.itemsTotal).toBe(TNG_SYSTEM_SOUNDS.mp3.length + TNG_SYSTEM_SOUNDS.advert.length - 2 - september);
    const newer = checkHealth(scan, { ...ctx, tngRelease: 'newer' }).issues.find((i) => i.id === 'system-outdated')!;
    expect(newer.itemsTotal).toBe(TNG_SYSTEM_SOUNDS.mp3.length + TNG_SYSTEM_SOUNDS.advert.length - 2);
  });

  it('goes on when one file cannot be deleted, audio folders first', async () => {
    const root = protectedCard(card({ '01': { '001.mp3': 1, '._001.mp3': 1, '002.mp3': 2 } }, { '.Spotlight-V100': { x: 1 }, '.DS_Store': 1 }));
    const plan = planFix(await scanSd(root), { kind: 'clean-junk' });
    expect(plan.steps.map((s) => (s.op === 'delete' ? s.path.join('/') : ''))).toEqual(['01/._001.mp3', '.Spotlight-V100', '.DS_Store']);
    const result = await executePlan(root, plan);
    expect(result.error).toBeUndefined();
    expect(result.skipped.map((x) => x.message)).toEqual(['.Spotlight-V100 löschen: Zugriff verweigert.']);
    expect(result.completed).toBe(2);
    const scan = await scanSd(root);
    expect(scan.folders[0].junk).toEqual([]);
    expect(scan.rootJunk.map((e) => e.name)).toEqual(['.Spotlight-V100']);
  });

  it('lets "Alles reparieren" carry on and lists what is left', async () => {
    const root = protectedCard(card({ '01': { '001.mp3': 1, '._001.mp3': 1, '003.mp3': 3 } }, { '.Spotlight-V100': { x: 1 } }));
    const result = await repairAll(root, (s) => checkHealth(s, ctx));
    expect(result.error).toBeUndefined();
    expect(result.steps.map((s) => [s.issue.id, s.skipped.length])).toEqual([
      ['junk', 1],
      ['gap:01', 0],
    ]);
    expect(result.leftovers).toEqual(['.Spotlight-V100 löschen: Zugriff verweigert.']);
    expect(result.scan.folders[0].tracks.map((t) => [t.name, t.size])).toEqual([
      ['001.mp3', 1],
      ['002.mp3', 3],
    ]);
  });

  it('leaves the top level of a built-in drive alone', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1, '._001.mp3': 1 } }, { '$RECYCLE.BIN': { x: 1 }, 'System Volume Information': {} })));
    const builtIn = { ...ctx, volume: { fsType: 'vfat', removable: false } };
    const junk = checkHealth(scan, builtIn).issues.find((i) => i.id === 'junk')!;
    expect(junk.items).toEqual(['01/._001.mp3']);
    expect(planFix(scan, junk.fix!).steps).toEqual([{ op: 'delete', path: ['01', '._001.mp3'], recursive: false }]);
    // Only junk at the top level: nothing to report at all.
    const rootOnly = await scanSd(memDir(card({ '01': { '001.mp3': 1 } }, { '$RECYCLE.BIN': { x: 1 } })));
    expect(checkHealth(rootOnly, builtIn).issues).toEqual([]);
    expect(checkHealth(rootOnly, { ...ctx, volume: { fsType: 'vfat', removable: true } }).issues.map((i) => i.id)).toEqual(['junk']);
  });

  it('treats half-written files of an interrupted save as junk', async () => {
    const report = checkHealth(await scanSd(memDir(card({ '01': { '001.mp3': 1 } }, { 'tonuino-studio.json.crswap': 5 }))), ctx);
    const junk = report.issues.find((i) => i.id === 'junk')!;
    expect(junk.title).toBe('1 Rest von abgebrochenem Speichern');
    expect(junk.items).toEqual(['tonuino-studio.json.crswap']);
  });
});

describe('empty files', () => {
  it('finds tracks with 0 bytes and deletes only those', async () => {
    const root = memDir(card({ '03': { '001.mp3': 1, '002.mp3': 0, '003.mp3': 3 } }));
    const issue = checkHealth(await scanSd(root), ctx).issues.find((i) => i.id === 'empty-tracks:03')!;
    expect(issue.severity).toBe('error');
    expect(issue.items).toEqual(['03/002.mp3']);
    const { scan } = await fixAndRescan(root, issue.fix!);
    expect(scan.folders[0].tracks.map((t) => [t.name, t.size])).toEqual([
      ['001.mp3', 1],
      ['003.mp3', 3],
    ]);
    // The gap that is left is the next thing to fix.
    expect(checkHealth(scan, ctx).issues.map((i) => i.id)).toEqual(['gap:03']);
  });

  it('are left to the user by "Alles reparieren", so no track gets a new number', async () => {
    // Deleting 002 would leave a gap the run then closes: 003 would become 002 without asking.
    const root = memDir(card({ '03': { '001.mp3': 1, '002.mp3': 0, '003.mp3': 3 }, '04': { '001.mp3': 0 } }));
    const result = await repairAll(root, (s) => checkHealth(s, ctx));
    expect(result.steps).toEqual([]);
    expect(await sizes(root, '03')).toEqual({ '001.mp3': 1, '002.mp3': 0, '003.mp3': 3 });
    expect(await sizes(root, '04')).toEqual({ '001.mp3': 0 });
    expect(result.report.issues.map((i) => i.id)).toEqual(['empty-tracks:03', 'empty-tracks:04']);
  });

  it('finds a track cut off while written (its marker is left) and deletes it with the marker (Testlabor)', async () => {
    const root = memDir(card({ '03': { '001.mp3': 1, '002.mp3': 4, '002.mp3.tonuino-open': 0, 'cover.jpg.tonuino-open': 0 }, '04': { '001.mp3.tonuino-open': 0 } }));
    const scan = await scanSd(root);
    const f = scan.folders.find((x) => x.number === 3)!;
    expect(f.unfinished).toEqual(['002.mp3']);
    // The marker of the half track is no junk to be cleaned away first; markers without their audio file are.
    expect(f.junk.map((e) => e.name)).toEqual(['cover.jpg.tonuino-open']);
    expect(scan.folders.find((x) => x.number === 4)!.junk.map((e) => e.name)).toEqual(['001.mp3.tonuino-open']);
    const issue = checkHealth(scan, ctx).issues.find((i) => i.id === 'unfinished-tracks:03')!;
    expect(issue.severity).toBe('error');
    expect(issue.title).toBe('Ordner 03: ein Titel ist nur halb kopiert');
    expect(issue.items).toEqual(['03/002.mp3']);
    const { plan, scan: after } = await fixAndRescan(root, issue.fix!);
    expect(plan.summary).toContain('Dieser Titel ist nur halb kopiert und wird gelöscht:');
    expect(Object.keys(await sizes(root, '03')).sort()).toEqual(['001.mp3', 'cover.jpg.tonuino-open']);
    expect(after.folders.find((x) => x.number === 3)!.unfinished).toBeUndefined();
  });

  it('calls a cut-off announcement empty, so the sound installer writes it again', async () => {
    const sounds = systemSounds();
    (sounds.mp3 as MemTree)['0300.mp3.tonuino-open'] = 0;
    const scan = await scanSd(memDir({ ...sounds, '01': { '001.mp3': 1 } }));
    expect(scan.system.mp3!.empty).toEqual(['0300.mp3']);
    expect(scan.system.mp3!.junk).toEqual([]);
  });

  it('keeps a file that got its content after planning', async () => {
    const root = memDir(card({ '03': { '001.mp3': 1, '002.mp3': 0 } }));
    const plan = planFix(await scanSd(root), { kind: 'remove-empty-tracks', folder: 3 });
    await (await root.dir('03')).write('002.mp3', new Uint8Array(5));
    const result = await executePlan(root, plan);
    expect(result.skipped.map((x) => x.message)).toEqual(['03/002.mp3 ist nicht mehr leer und bleibt.']);
    expect(await sizes(root, '03')).toEqual({ '001.mp3': 1, '002.mp3': 5 });
  });

  it('does not call a file empty when its size is unknown', async () => {
    const root = memDir(card({ '03': { '001.mp3': 0 } }));
    const dir = root.dir.bind(root);
    root.dir = async (name, opts) => {
      const d = await dir(name, opts);
      if (name === '03') {
        const list = d.list.bind(d);
        d.list = async () => (await list()).map(({ name: n, kind }) => ({ name: n, kind }));
      }
      return d;
    };
    const scan = await scanSd(root);
    expect(scan.folders[0].empty).toEqual([]);
    expect(checkHealth(scan, ctx).issues).toEqual([]);
  });

  it('reports empty announcements and offers to install them again', async () => {
    const s = systemSounds() as { mp3: MemTree; advert: MemTree };
    s.mp3['0300.mp3'] = 0;
    const issue = checkHealth(await scanSd(memDir(s)), ctx).issues.find((i) => i.id === 'system-empty:mp3')!;
    expect(issue.items).toEqual(['mp3/0300.mp3']);
    expect(issue.fix).toEqual({ kind: 'install-system-sounds' });
  });
});

describe('file system of the card', () => {
  it('says so when it cannot tell the format instead of calling the card fine', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1 } })));
    const report = checkHealth(scan, { ...ctx, volume: {} });
    expect(report.issues.map((i) => [i.id, i.severity])).toEqual([['fs-unknown', 'info']]);
    expect(report.status).toBe('ok');
    expect(checkHealth(scan, { ...ctx, volume: { fsType: 'vfat' } }).issues).toEqual([]);
  });

  it('calls a card in the browser not FAT32 when the times of its files say so', async () => {
    // exFAT keeps times in steps of 10 ms, FAT in steps of two seconds.
    let n = 0;
    const scan = await scanSd(timed(memDir(card({ '01': { '001.mp3': 1, '002.mp3': 1 } })), () => at(0, 1, 230) + 1000 * n++));
    expect(scan.fileTimes.length).toBeGreaterThan(3);
    const report = checkHealth(scan, { ...ctx, volume: webCard });
    // Only a guess: a warning the parent can answer, never an error.
    expect(report.issues.map((i) => [i.id, i.severity])).toEqual([['fs-type', 'warning']]);
    expect(report.status).toBe('warning');
    const issue = report.issues[0];
    expect(issue.title).toBe('Die SD-Karte ist wahrscheinlich nicht mit FAT32 formatiert');
    expect(issue.detail).toContain('exFAT oder NTFS');
    // What to do in either case. Without a known system it points to the help, which has every way to look.
    expect(issue.detail).toContain('Steht dort FAT32, ist die Karte in Ordnung');
    expect(issue.detail).toContain('in der Hilfe');
    // Only the way of the computer in use (audit 0.4 #3): never all systems at once.
    const on = (system: HealthContext['system']) => checkHealth(scan, { ...ctx, volume: webCard, system }).issues[0].detail;
    expect(on('windows')).toContain('Explorer');
    expect(on('windows')).not.toContain('Finder');
    expect(on('macos')).toContain('Finder');
    expect(on('macos')).not.toContain('Explorer');
    expect(on('linux')).toContain('„Laufwerke“');
    expect(on('chromeos')).toContain('Chromebook');
    expect(on('chromeos')).not.toContain('Laufwerke');
    expect(issue.detail).not.toContain('Zeitstempel');
    expect(issue.help).toBe('#/hilfe/sd-karte-geht-nicht');
    expect(issue.fix).toEqual({ kind: 'confirm-fat32' });
    expect(issue.fixLabel).toBe('Ist FAT32');
    expect(issue.detail).toContain(`„${issue.fixLabel}“`);
    expect(isAutoFixable(issue)).toBe(false);
    expect(() => planFix(scan, issue.fix!)).toThrow();
  });

  it('stays quiet about the format once someone saw FAT32 on a computer', async () => {
    let n = 0;
    const scan = await scanSd(timed(memDir(card({ '01': { '001.mp3': 1, '002.mp3': 1 } })), () => at(0, 1, 230) + 1000 * n++));
    expect(checkHealth(scan, { ...ctx, volume: webCard, formatChecked: true }).issues).toEqual([]);
    // A file system the platform reports still counts.
    expect(checkHealth(scan, { ...ctx, volume: { ...webCard, fsType: 'exfat' }, formatChecked: true }).issues.map((i) => i.id)).toEqual(['fs-type']);
  });

  it('only guesses from times the card itself stored', async () => {
    // Staged writes (Firefox, Safari) or a demo card get Date.now() from the app, which says nothing about the card.
    const scan = await scanSd(timed(memDir(card({ '01': { '001.mp3': 1, '002.mp3': 1 }, 'tonuino-studio.json': '{}' })), () => at(0, 1, 230)));
    expect(checkHealth(scan, { ...ctx, volume: {} }).issues.map((i) => i.id)).toEqual(['fs-unknown']);
    const written = memDir(card({ '01': { '001.mp3': 1 } }));
    await written.write('tonuino-studio.json', new TextEncoder().encode('{}'));
    const catalogNow = await scanSd(written);
    expect(checkHealth(catalogNow, { ...ctx, volume: {} }).issues.map((i) => i.id)).toEqual(['fs-unknown']);
  });

  it('never calls a card FAT32 for its times: copied files keep even times on any card', async () => {
    const scan = await scanSd(timed(memDir(card({ '01': { '001.mp3': 1, '002.mp3': 1 } })), () => at(0, 2)));
    expect(checkHealth(scan, { ...ctx, volume: webCard }).issues.map((i) => i.id)).toEqual(['fs-unknown']);
  });

  it('catches a freshly set up exFAT card by the time of the catalog the app wrote', async () => {
    const setUp = (time: number) => {
      const root = memDir({ 'tonuino-studio.json': '{}' });
      return scanSd(timed(root, (name) => (name === 'tonuino-studio.json' ? time : 0)));
    };
    const exfat = await setUp(at(0, 1, 230));
    expect(exfat.catalogTime).toBe(at(0, 1, 230));
    // The catalog has its own field and is no file of the box.
    expect(exfat.fileTimes).toEqual([]);
    expect(checkHealth(exfat, { ...ctx, volume: webCard }).issues.map((i) => i.id)).toContain('fs-type');
    const fat = checkHealth(await setUp(at(0, 2)), { ...ctx, volume: webCard }).issues.map((i) => i.id);
    expect(fat).toContain('fs-unknown');
    expect(fat).not.toContain('fs-type');
  });

  it('goes by the file system the platform reports, whatever the times say', async () => {
    const scan = await scanSd(timed(memDir(card({ '01': { '001.mp3': 1 } })), () => at(0, 1, 230)));
    expect(checkHealth(scan, { ...ctx, volume: { fsType: 'vfat' } }).issues).toEqual([]);
    expect(checkHealth(scan, { ...ctx, volume: { fsType: 'exfat' } }).issues.map((i) => [i.id, i.title])).toEqual([['fs-type', 'Die SD-Karte ist als exfat formatiert']]);
  });

  it('keeps a few times per folder and no more than it needs', async () => {
    const tree: MemTree = {};
    for (let f = 1; f <= 20; f++) {
      const folder: MemTree = {};
      for (let t = 1; t <= 30; t++) folder[`${String(t).padStart(3, '0')}.mp3`] = 1;
      tree[folderName(f)] = folder;
    }
    const scan = await scanSd(timed(memDir(tree), () => at(0, 1, 230)));
    expect(scan.fileTimes).toHaveLength(MAX_FILE_TIMES);
    // Times the platform does not know are left out: memDir files say 0.
    expect((await scanSd(memDir(tree))).fileTimes).toEqual([]);
  });
});

/** What the web app reports for a card: no format, but the card's own file times. */
const webCard = { fileTimesFromCard: true };

/** A time on 6 October 2026, 12:mm:ss.ms (UTC). */
function at(m: number, s: number, ms = 0): number {
  return Date.UTC(2026, 9, 6, 12, m, s, ms);
}

/** A card whose files report the given modification time, as File.lastModified does in the browser. */
function timed<T extends Dir>(root: T, time: (name: string) => number): T {
  const list = root.list.bind(root);
  const dir = root.dir.bind(root);
  root.list = async () => (await list()).map((e) => (e.kind === 'file' ? { ...e, modified: time(e.name) } : e));
  root.dir = async (name, opts) => timed(await dir(name, opts), time);
  return root;
}

/** Card with the full set of announcements and these changes in mp3/ and advert/. */
function soundsCard(change: (s: { mp3: MemTree; advert: MemTree }) => void, extra: MemTree = {}): ReturnType<typeof memDir> {
  const s = systemSounds() as { mp3: MemTree; advert: MemTree };
  change(s);
  return memDir({ ...s, '01': { '001.mp3': 1 }, ...extra });
}

describe('announcements with text in the name', () => {
  const suffixed = () =>
    soundsCard((s) => {
      delete s.mp3['0300.mp3'];
      s.mp3['0300_new_tag.mp3'] = 10;
    });

  it('get a warning that some players do not find them, and the plain number as fix', async () => {
    const root = suffixed();
    const report = checkHealth(await scanSd(root), ctx);
    expect(report.issues.map((i) => i.id)).toEqual(['system-suffix:mp3']);
    const issue = report.issues[0];
    expect(issue.severity).toBe('warning');
    expect(issue.title).toBe('Ansagen mit Text im Namen (Ordner mp3)');
    expect(issue.detail).toContain('„0300_new_tag.mp3“');
    expect(issue.detail).toContain('AiO-Platine');
    expect(issue.detail).toContain('LKP-Player');
    expect(issue.detail).toContain('„0300.mp3“');
    expect(issue.items).toEqual(['mp3/0300_new_tag.mp3']);
    expect(issue.fix).toEqual({ kind: 'normalize-system-names' });
    expect(issue.fixLabel).toBe('Sicher umbenennen');
    expect(issue.fixWarning).toContain('Rückgängig machen lässt sich das nicht');
    const plan = planFix(await scanSd(root), issue.fix!);
    expect(plan.steps).toEqual([
      { op: 'title', dir: ['mp3'], file: '0300_new_tag.mp3', title: 'new tag' },
      { op: 'rename', dir: ['mp3'], from: '0300_new_tag.mp3', to: '0300.mp3' },
    ]);
    expect(plan.summary).toEqual([
      'Eine Ansage bekommt eine reine Nummer als Namen. Was sie sagen, bleibt gleich.',
      'Die Reihenfolge bleibt. Hat eine Datei noch keinen Titel, schreibe ich die Wörter aus ihrem alten Namen hinein, damit sie nicht verloren gehen.',
      'mp3/0300_new_tag.mp3 → 0300.mp3',
    ]);
  });

  it('are renamed by "Alles reparieren"', async () => {
    const root = suffixed();
    const result = await repairAll(root, (s) => checkHealth(s, ctx));
    expect(result.error).toBeUndefined();
    expect(result.steps.map((st) => st.issue.id)).toEqual(['system-suffix:mp3']);
    expect(result.report.issues).toEqual([]);
    // The 10 bytes plus a small tag with the old words as its title.
    expect((await sizes(root, 'mp3'))['0300.mp3']).toBeGreaterThan(10);
    expect(Object.keys(await sizes(root, 'mp3'))).not.toContain('0300_new_tag.mp3');
  });

  it('are not reported on a clean card', async () => {
    const issues = checkHealth(await scanSd(soundsCard(() => undefined)), ctx).issues;
    expect(issues.filter((i) => i.id.startsWith('system-'))).toEqual([]);
  });
});

describe('announcements that are far too big', () => {
  it('warns about an audio play stored as an announcement', async () => {
    const root = soundsCard((s) => {
      s.mp3['0001.mp3'] = 5 * 1024 * 1024;
    });
    const issue = checkHealth(await scanSd(root), ctx).issues.find((i) => i.id === 'system-oversized:mp3')!;
    expect(issue.severity).toBe('warning');
    expect(issue.title).toBe('Sehr große Datei im Ordner mp3');
    expect(issue.detail).toContain('wie eingefroren');
    expect(issue.detail).toContain('beim Anlernen einer Karte');
    expect(issue.items).toEqual(['mp3/0001.mp3 (5\u00a0MB)']);
    expect(issue.fix).toEqual({ kind: 'install-system-sounds' });
    // The installer replaces the folder, so the user decides: not part of "Alles reparieren".
    expect(isAutoFixable(issue)).toBe(false);
  });

  it('names what the box does with the advert folder there', async () => {
    const root = soundsCard((s) => {
      s.advert['0001.mp3'] = 12 * 1024 * 1024;
    });
    const issue = checkHealth(await scanSd(root), ctx).issues.find((i) => i.id === 'system-oversized:advert')!;
    // Setting up a card uses mp3/; advert/ holds the numbers the box says while playing.
    expect(issue.detail).not.toContain('Anlernen');
    expect(issue.detail).toContain('die Nummer des Titels ansagt');
  });

  it('leaves the official announcements alone', async () => {
    // The biggest file of the TNG download has about 180 KB.
    const report = checkHealth(await scanSd(soundsCard((s) => (s.mp3['0001.mp3'] = 180 * 1024))), ctx);
    expect(report.issues).toEqual([]);
    expect(isOversizedSound({ size: 1024 * 1024, ext: 'mp3' })).toBe(false);
    expect(isOversizedSound({ size: 1024 * 1024 + 1, ext: 'mp3' })).toBe(true);
    // WAV takes about ten times the space for the same length.
    expect(isOversizedSound({ size: 5 * 1024 * 1024, ext: 'wav' })).toBe(false);
  });
});

describe('other files between the tracks', () => {
  const withOthers = () => memDir(card({ '01': { '001.mp3': 1, 'cover.jpg': 2, '002.mp3': 2, 'info.txt': 3 } }));
  const known = (entry: Partial<CatalogFolder> = {}) => ({ folders: { '01': { title: 'Bibi', tracks: [], addedAt: 0, updatedAt: 0, ...entry } } });

  it('get a warning, and the fix deletes exactly those files', async () => {
    const root = withOthers();
    const report = checkHealth(await scanSd(root), ctx);
    expect(report.issues.map((i) => i.id)).toEqual(['others:01']);
    const issue = report.issues[0];
    expect(issue.severity).toBe('warning');
    expect(issue.title).toBe('Ordner 01: Andere Dateien zwischen den Titeln');
    expect(issue.items).toEqual(['01/cover.jpg', '01/info.txt']);
    expect(issue.fix).toEqual({ kind: 'remove-others', folder: 1 });
    expect(issue.fixLabel).toBe('Entfernen');
    expect(issue.help).toBe('#/hilfe/dateinamen');
    // No claim about players the forum does not back: it advises removing such files at "Fehler 6".
    expect(issue.detail).not.toContain('zählen');
    expect(issue.detail).not.toContain('Musik');
    expect(isAutoFixable(issue)).toBe(false);
    const plan = planFix(await scanSd(root), issue.fix!, { catalog: known({ cover: '01.jpg' }) });
    expect(plan.steps).toEqual([
      { op: 'delete', path: ['01', 'cover.jpg'] },
      { op: 'delete', path: ['01', 'info.txt'] },
    ]);
    expect(plan.takeCover).toBeUndefined();
    expect(plan.summary).toEqual(['Diese 2 Dateien werden gelöscht:', 'cover.jpg', 'info.txt', 'Deine Titel bleiben, wie sie sind.']);
    expect((await executePlan(root, plan)).error).toBeUndefined();
    expect(await sizes(root, '01')).toEqual({ '001.mp3': 1, '002.mp3': 2 });
    expect(checkHealth(await scanSd(root), ctx).issues).toEqual([]);
  });

  it('stay when "Alles reparieren" runs: it never deletes files', async () => {
    const root = withOthers();
    const result = await repairAll(root, (s) => checkHealth(s, ctx));
    expect(result.steps).toEqual([]);
    expect(result.report.issues.map((i) => i.id)).toEqual(['others:01']);
  });

  it('do not change the issue of a folder that has nothing but a picture', async () => {
    const report = checkHealth(await scanSd(memDir(card({ '01': { '001.mp3': 1 }, '03': { 'cover.jpg': 1 } }))), ctx);
    expect(report.issues.map((i) => i.id)).toEqual(['empty:03']);
  });

  it('give their picture to the cover first when the catalog has none', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1, 'AlbumArtSmall.jpg': 1, 'Folder.jpg': 2, 'list.m3u': 1 } })));
    const fix: FixAction = { kind: 'remove-others', folder: 1 };
    const plan = planFix(scan, fix, { catalog: known() });
    expect(plan.takeCover).toEqual({ folder: 1, file: 'Folder.jpg' });
    expect(plan.summary[0]).toBe('Das Bild Folder.jpg übernehme ich vorher als Cover.');
    expect(plan.steps).toHaveLength(3);
    const unknown = planFix(scan, fix, { catalog: { folders: {} } });
    expect(unknown.takeCover).toEqual({ folder: 1, file: 'Folder.jpg' });
    expect(unknown.summary[0]).toBe('Ordner 01 kenne ich noch nicht. Ich übernehme ihn vorher mit den Angaben aus den Dateien und das Bild Folder.jpg als Cover.');
    expect(planFix(scan, fix, { catalog: known({ cover: '01.jpg' }) }).summary.join(' ')).not.toContain('Cover');
  });

  it('warn before music in other formats goes, and say how to keep it', async () => {
    const scan = await scanSd(memDir(card({ '01': { '001.mp3': 1, '002.m4a': 5 } })));
    const issue = checkHealth(scan, ctx).issues.find((i) => i.id === 'others:01')!;
    expect(issue.detail).toContain('Musik in einem Format, das die Box nicht abspielt');
    const plan = planFix(scan, { kind: 'remove-others', folder: 1 }, { catalog: known() });
    expect(plan.summary).toContain(
      '002.m4a ist Musik in einem Format, das die Box nicht abspielen kann. Brauchst du sie noch, kopiere sie vorher auf deinen Computer und füge sie dann über „Hinzufügen“ wieder hinzu. Ich wandle sie dabei in MP3 um.',
    );
  });

  it('wait until the folder has numbered tracks, so its picture is not lost as a cover', async () => {
    // All audio still without a number: that comes first; a cover can only be taken from a folder with tracks.
    const report = checkHealth(await scanSd(memDir(card({ '01': { 'Bibi 1.mp3': 1, 'folder.jpg': 1 } }))), ctx);
    expect(report.issues.map((i) => i.id)).toEqual(['unnumbered:01']);
  });

  it('pick a picture that makes a good cover', () => {
    expect(coverCandidate(['AlbumArtSmall.jpg', 'AlbumArt_{4E3A}_Large.jpg', 'info.txt'])).toBe('AlbumArt_{4E3A}_Large.jpg');
    expect(coverCandidate(['back.jpg', 'cover.png', 'folder.jpg'])).toBe('folder.jpg');
    expect(coverCandidate(['Bibi Blocksberg.jpg', 'info.txt'])).toBe('Bibi Blocksberg.jpg');
    // Two unknown pictures: which is the front? Better none.
    expect(coverCandidate(['a.jpg', 'b.png'])).toBeUndefined();
    expect(coverCandidate(['AlbumArtSmall.jpg'])).toBeUndefined();
  });
});

describe('folder names the box does not find', () => {
  it('reads names like "02 Bibi" and typos of the system folders', () => {
    expect(parseNamedFolder('02 Bibi')).toEqual({ number: 2, rest: 'Bibi' });
    expect(parseNamedFolder('2_Bibi_und_Tina')).toEqual({ number: 2, rest: 'Bibi und Tina' });
    expect(parseNamedFolder('05-Pumuckl')).toEqual({ number: 5, rest: 'Pumuckl' });
    expect(parseNamedFolder('7. Folge')).toEqual({ number: 7, rest: 'Folge' });
    for (const n of ['02', '02 ', '02 - ', '123 Bibi', 'Bibi 02', '2023-05 Urlaub', '12.12.2023 Weihnachtsfeier', '01 - 03', '1.2. Geburtstag', '02 3 Fragezeichen']) {
      expect(parseNamedFolder(n), n).toBeNull();
    }
    for (const [n, target] of [['advent', 'advert'], ['adverts', 'advert'], ['avert', 'advert'], ['Advertisement', null], ['mp3s', 'mp3'], ['MP 3', 'mp3'], ['mp3', null], ['ADVERT', null], ['Fotos', null], ['ad', null]] as const) {
      expect(systemFolderTypo(n), n).toBe(target);
    }
  });

  it('renames "02 Bibi" to 02 and takes "Bibi" as the title', async () => {
    const root = memDir(card({ '01': { '001.mp3': 1 }, '02 Bibi': { '001.mp3': 1, '002.mp3': 2 } }));
    const scan = await scanSd(root);
    expect(scan.nearFolders.map((x) => [x.entry.name, x.number, x.rest, x.audio])).toEqual([['02 Bibi', 2, 'Bibi', 2]]);
    const report = checkHealth(scan, ctx);
    // Once, and not again among the other files.
    expect(report.issues.map((i) => i.id)).toEqual(['named-folder:02 Bibi']);
    const issue = report.issues[0];
    expect(issue.severity).toBe('error');
    expect(issue.title).toBe('Ordner „02 Bibi“ wird nicht abgespielt');
    expect(issue.fix).toEqual({ kind: 'rename-invalid-folder', name: '02 Bibi', to: 2, title: 'Bibi' });
    expect(issue.fixLabel).toBe('In 02 umbenennen');
    expect(issue.help).toBe('#/hilfe/dateinamen');
    // A guess from a name the user chose: only after its own preview, never in "Alles reparieren".
    expect(isAutoFixable(issue)).toBe(false);
    expect(isAutoFixable({ ...issue, fix: { kind: 'rename-invalid-folder', name: '2', to: 2 } })).toBe(true);

    const catalog = newCatalog('Box', 'tng');
    const plan = planFix(scan, issue.fix!, { catalog });
    expect(plan.steps).toEqual([{ op: 'rename', dir: [], from: '02 Bibi', to: '02' }]);
    expect(plan.summary).toEqual(['„02 Bibi“ heißt danach „02“.', 'Den Namen „Bibi“ übernehme ich als Titel.']);
    const done = doneSteps(plan, await executePlan(root, plan));
    // As catalogAfterRepair does it: prepare, then follow the steps.
    noteNewFolder(catalog, plan, done);
    applyPlanToCatalog(catalog, plan, done);
    expect(catalog.folders['02']).toMatchObject({ title: 'Bibi', tracks: [] });
    const after = await scanSd(root);
    expect(after.folders.map((f) => f.name)).toEqual(['01', '02']);
    expect(checkHealth(after, ctx).issues).toEqual([]);
  });

  it('keeps a title the catalog already has for the number, and notes nothing when the rename did not run', async () => {
    const scan = await scanSd(memDir(card({ '02 Bibi': { '001.mp3': 1 } })));
    const fix: FixAction = { kind: 'rename-invalid-folder', name: '02 Bibi', to: 2, title: 'Bibi' };
    const catalog = newCatalog('Box', 'tng');
    catalog.folders['02'] = { title: 'Bibi Blocksberg', tracks: [{ file: '001.mp3', title: 'Hexen' }], addedAt: 0, updatedAt: 0 };
    const plan = planFix(scan, fix, { catalog });
    expect(plan.summary[1]).toBe('Ordner 02 kenne ich schon als „Bibi Blocksberg“ und behalte diesen Titel.');
    expect(plan.newTitle).toBeUndefined();
    const fresh = newCatalog('Box', 'tng');
    noteNewFolder(fresh, planFix(scan, fix, { catalog: fresh }), []);
    expect(fresh.folders).toEqual({});
  });

  it('only warns when the number is taken, and names a free one', async () => {
    const root = memDir(card({ '01': { '001.mp3': 1 }, '02': { '001.mp3': 1 }, '02 Bibi': { '001.mp3': 1 } }));
    const issue = checkHealth(await scanSd(root), ctx).issues.find((i) => i.id === 'named-folder:02 Bibi')!;
    expect(issue.severity).toBe('warning');
    expect(issue.fix).toBeUndefined();
    expect(issue.detail).toContain('die Nummer 02 hat schon ein anderer Ordner');
    expect(issue.detail).toContain('zum Beispiel „03“');
  });

  it('says which folder a number is meant for when no folder has it yet', async () => {
    const root = memDir(card({ '01 Bibi': { '001.mp3': 1 }, '01 Tina': { '001.mp3': 1 } }));
    const report = checkHealth(await scanSd(root), ctx);
    expect(report.issues.find((i) => i.id === 'named-folder:01 Bibi')!.severity).toBe('error');
    const tina = report.issues.find((i) => i.id === 'named-folder:01 Tina')!;
    expect(tina.severity).toBe('warning');
    expect(tina.detail).toContain('die Nummer 01 ist schon für den Ordner „01 Bibi“ vorgesehen');
    expect(tina.detail).not.toContain('hat schon ein anderer Ordner');
  });

  it('are left alone by "Alles reparieren"', async () => {
    const root = memDir(card({ '01': { '001.mp3': 1 }, '02 Bibi': { '001.mp3': 1 } }));
    const result = await repairAll(root, (s) => checkHealth(s, ctx));
    expect(result.steps).toEqual([]);
    expect((await scanSd(root)).nearFolders.map((x) => x.entry.name)).toEqual(['02 Bibi']);
  });

  it('leaves folders without audio files to the other files', async () => {
    const report = checkHealth(await scanSd(memDir(card({ '01': { '001.mp3': 1 }, '01 Urlaubsfotos': { 'IMG_0001.jpg': 1 } }))), ctx);
    expect(report.issues.map((i) => [i.id, i.items])).toEqual([['root-others', ['01 Urlaubsfotos/']]]);
  });

  it('renames a misspelt advert folder instead of asking for new announcements', async () => {
    const root = soundsCard(() => undefined);
    await root.rename('advert', 'advent');
    const scan = await scanSd(root);
    const report = checkHealth(scan, ctx);
    expect(report.issues.map((i) => i.id)).toEqual(['system-typo:advent']);
    const issue = report.issues[0];
    expect(issue.severity).toBe('error');
    expect(issue.title).toBe('Heißt der Ordner „advent“ richtig?');
    expect(issue.fix).toEqual({ kind: 'rename-root-folder', name: 'advent', to: 'advert' });
    expect(issue.fixLabel).toBe('In advert umbenennen');
    expect(issue.help).toBe('#/hilfe/dateinamen');
    // A guess about the user's folder: not without a look at the preview.
    expect(isAutoFixable(issue)).toBe(false);
    const { plan, scan: after } = await fixAndRescan(root, issue.fix!);
    expect(plan.steps).toEqual([{ op: 'rename', dir: [], from: 'advent', to: 'advert' }]);
    expect(checkHealth(after, ctx).issues).toEqual([]);
  });

  it('takes "advent" for a folder of its own while advert is there, or when it holds no announcements', async () => {
    const both = soundsCard(() => undefined, { advent: { '0001.mp3': 1 } });
    expect(checkHealth(await scanSd(both), ctx).issues.map((i) => [i.id, i.items])).toEqual([['root-others', ['advent/']]]);
    // Christmas songs in "Advent" while advert is missing: the announcements are missing, it is no typo.
    const xmas = memDir({ mp3: systemSounds().mp3 as MemTree, '01': { '001.mp3': 1 }, Advent: { '01 Kling Glöckchen.mp3': 1 } });
    expect(checkHealth(await scanSd(xmas), ctx).issues.map((i) => i.id)).toEqual(['system-missing', 'root-others']);
  });
});

describe('write-protected files', () => {
  /** A card whose listing reports some entries write-protected, as the desktop does for the FAT read-only attribute. */
  function lockedCard(locked: Set<string>, unlocked: string[][]): Dir {
    const wrap = (inner: Dir, prefix: string): Dir =>
      new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === 'list')
            return async () =>
              (await target.list()).map((e) => (locked.has(prefix + e.name) ? { ...e, readOnly: true } : e));
          if (prop === 'dir') return async (name: string, o?: { create?: boolean }) => wrap(await target.dir(name, o), `${prefix}${name}/`);
          if (prop === 'makeWritable' && prefix === '')
            return async (paths: string[]) => {
              unlocked.push(paths);
              const n = locked.size;
              if (paths.length) for (const p of paths) locked.delete(p);
              else locked.clear();
              return n - locked.size;
            };
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    return wrap(memDir({ '01': { '001.mp3': new Uint8Array(10), '002.mp3': new Uint8Array(10) } }), '');
  }

  it('lists them, offers "Schutz entfernen" on the desktop and clears exactly them', async () => {
    const locked = new Set(['01/002.mp3']);
    const unlocked: string[][] = [];
    const root = lockedCard(locked, unlocked);
    const scan = await scanSd(root);
    expect(scan.readOnly).toEqual(['01/002.mp3']);
    const issue = checkHealth(scan, { ...ctx, canUnlock: true }).issues.find((i) => i.id === 'read-only-files');
    expect(issue?.fixLabel).toBe('Schutz entfernen');
    expect(issue?.items).toEqual(['01/002.mp3']);
    expect(isAutoFixable(issue!)).toBe(true);
    const plan = planFix(scan, issue!.fix!);
    expect((await executePlan(root, plan)).error).toBeUndefined();
    expect(unlocked).toEqual([['01/002.mp3']]);
    const again = await scanSd(root);
    expect(again.readOnly).toBeUndefined();
    expect(checkHealth(again, { ...ctx, canUnlock: true }).issues.some((i) => i.id === 'read-only-files')).toBe(false);
  });

  it('only tells about them where the app cannot help, and stays quiet on a locked card', async () => {
    const scan = await scanSd(lockedCard(new Set(['01/001.mp3']), []));
    const browser = checkHealth(scan, ctx).issues.find((i) => i.id === 'read-only-files');
    expect(browser?.fix).toBeUndefined();
    const lockedCardCtx = { ...ctx, canUnlock: true, volume: { readOnly: true } };
    expect(checkHealth(scan, lockedCardCtx).issues.some((i) => i.id === 'read-only-files')).toBe(false);
  });
});
