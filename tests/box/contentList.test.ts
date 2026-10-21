import { describe, expect, it } from 'vitest';
import { memDir } from '../../src/platform/memory';
import { buildShelf, folderFingerprint, newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { contentAbout, contentLayout, contentRows, listBox, rowDetails, rowHeight, LIST_HEAD } from '../../src/features/box/contentList';

async function sample() {
  const scan = await scanSd(memDir({ '01': { '001.mp3': 10, '002.mp3': 20 }, '02': { '001.mp3': 5 }, '04': { '001.mp3': 7 }, '05': {} }));
  const c = newCatalog('Emmas Box');
  c.folders['01'] = {
    title: 'Die Olchis',
    kind: 'hoerbuch',
    tracks: [
      { file: '001.mp3', durationSec: 1500 },
      { file: '002.mp3', durationSec: 1700 },
    ],
    fingerprint: folderFingerprint(scan.folders[0]),
    addedAt: 0,
    updatedAt: 0,
  };
  c.folders['02'] = { title: 'Schlaflieder', kind: 'lieder', card: { mode: 4, special: 1 }, tracks: [{ file: '001.mp3', durationSec: 20 }], addedAt: 0, updatedAt: 0 };
  c.folders['03'] = { title: 'Nicht mehr da', tracks: [], addedAt: 0, updatedAt: 0 };
  return buildShelf(scan, c);
}

describe('the list of what is on the card', () => {
  it('lists the folders on the card with tracks, length and how their card plays', async () => {
    const rows = contentRows(await sample());
    expect(rows.map((r) => [r.name, r.title, r.tracks, r.minutes, r.card])).toEqual([
      ['01', 'Die Olchis', 2, 53, 'Hörbuch'],
      ['02', 'Schlaflieder', 1, 1, 'Einzeltitel · Titel 1'],
      ['04', 'Ordner 04', 1, undefined, undefined],
      ['05', 'Ordner 05', 0, undefined, undefined],
    ]);
  });

  it('says it in one short line per folder', async () => {
    const rows = contentRows(await sample());
    expect(rows.map(rowDetails)).toEqual(['2 Titel · 53 Min. · Karte: Hörbuch', '1 Titel · 1 Min. · Karte: Einzeltitel · Titel 1', '1 Titel', 'leer']);
    expect(rowDetails({ number: 7, name: '07', title: 'Lang', tracks: 30, minutes: 125 })).toBe('30 Titel · 2 Std. 5 Min.');
  });

  it('sums the length only when every folder knows it', async () => {
    const date = new Date(2026, 9, 13);
    const rows = contentRows(await sample());
    expect(contentAbout(rows, date)).toBe('4 Ordner · Stand 13.10.2026');
    const known = rows.slice(0, 2);
    expect(contentAbout(known, date)).toBe('2 Ordner · 54 Min. · Stand 13.10.2026');
    // An empty folder has no length to wait for.
    expect(contentAbout([...known, rows[3]], date)).toBe('3 Ordner · 54 Min. · Stand 13.10.2026');
  });
});

describe('fitting the list on paper', () => {
  const fits = (count: number) => {
    const l = contentLayout(count);
    return Math.ceil(count / l.columns) * rowHeight(l.pt) <= listBox(l.sheet).height - LIST_HEAD;
  };

  it('puts a usual card twice on a sheet, in big type', () => {
    expect(contentLayout(8)).toEqual({ sheet: 'a5x2', columns: 1, pt: 12 });
    expect(contentLayout(18).sheet).toBe('a5x2');
    expect(contentLayout(30)).toMatchObject({ sheet: 'a5x2', columns: 2 });
  });

  it('takes the whole sheet for very many folders, and fits all 99', () => {
    expect(contentLayout(60).sheet).toBe('a4');
    expect(contentLayout(99)).toMatchObject({ sheet: 'a4', columns: 3 });
    for (const n of [1, 10, 17, 18, 19, 25, 40, 42, 43, 64, 65, 80, 99]) expect(fits(n), `${n} folders`).toBe(true);
  });

  it('never gets smaller when there are fewer folders', () => {
    const size = (n: number) => {
      const l = contentLayout(n);
      // Bigger is better: A5 before A4, fewer columns, bigger type.
      return (l.sheet === 'a5x2' ? 1000 : 0) - l.columns * 100 + l.pt;
    };
    for (let n = 2; n <= 99; n++) expect(size(n), `${n} folders`).toBeLessThanOrEqual(size(n - 1));
  });
});
