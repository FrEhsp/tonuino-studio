/**
 * Vorher/nachher (TODO #110, #133, #134): Frank's folders (faelle.ts)
 * against the modelled services (dienste.ts), with the time the search
 * takes on a fake clock (answer times of the services, the spacing and the
 * MusicBrainz limit included). Prints a table; with MESSUNG_OUT set, also
 * writes the numbers there as JSON.
 */
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverlessFolders, newRows, runBulkSearch, withResult, chosenCandidate, type BulkRow } from '../../../src/core/stickers/bulkcover';
import { searchCovers } from '../../../src/core/stickers/coversearch';
import * as v05 from './v05/bulkcover';
import { searchCovers as searchCoversV05 } from './v05/coversearch';
import { findCovers, searchOptionsFor, type FolderFiles } from '../../../src/core/covers/autofind';
import { clearAnswers, gates, resetServiceHealth } from '../../../src/core/covers/net';
import { newCatalog, type Catalog } from '../../../src/core/tonuino/catalog';
import type { SdFolder } from '../../../src/core/tonuino/sd';
import { FAELLE } from './faelle';
import { modelFetch, pictureOf, type Counts } from './dienste';

const sdFolder = (n: number): SdFolder =>
  ({ number: n, name: String(n).padStart(2, '0'), tracks: [], wrongDigits: [], unnumbered: [], others: [], junk: [], subfolders: [], empty: [] }) as unknown as SdFolder;

function box(): { scan: { folders: SdFolder[] }; catalog: Catalog; covers: Map<string, Uint8Array> } {
  const catalog = newCatalog();
  const covers = new Map<string, Uint8Array>();
  for (const c of FAELLE) {
    const name = String(c.folder).padStart(2, '0');
    catalog.folders[name] = { ...c.entry, tracks: [], addedAt: 1, updatedAt: 1, ...(c.own ? { cover: `${name}.jpg` } : {}) };
    if (c.own) covers.set(`${name}.jpg`, new Uint8Array([1, 2, 3]));
  }
  return { scan: { folders: FAELLE.map((c) => sdFolder(c.folder)) }, catalog, covers };
}

export interface Outcome {
  folder: number;
  /** Picture taken without asking (ticked in the dialog, saved by the automatic search). */
  taken?: string;
  /** Picture proposed first. */
  first?: string;
  /** All pictures offered. */
  offered: string[];
  /** Came from the files on the card. */
  local?: boolean;
}

export interface Measured {
  label: string;
  outcomes: Outcome[];
  ms: number;
  counts: Counts;
}

/** v05: "Cover suchen" for every folder without a cover, as BulkCoverDialog runs it. */
export async function pipelineV05(fetchFn: ReturnType<typeof modelFetch>['fetchFn']): Promise<Outcome[]> {
  const { scan, catalog, covers } = box();
  const targets = v05.coverlessFolders(scan, catalog, covers);
  let rows: v05.BulkRow[] = v05.newRows(targets);
  await v05.runBulkSearch(targets, {
    search: (query, signal) => searchCoversV05(query, { fetchFn, signal }),
    onResult: (folder, r) => {
      rows = rows.map((row) => (row.target.folder === folder ? v05.withResult(row, r) : row));
    },
  });
  return rows.map((r) => {
    const first = v05.chosenCandidate(r);
    return { folder: r.target.folder, taken: r.checked && first ? pictureOf(first.thumbUrl) : undefined, first: first && pictureOf(first.thumbUrl), offered: r.candidates.map((c) => pictureOf(c.thumbUrl) ?? '') };
  });
}

/** 0.6: "Cover suchen" for every folder without a cover (BulkCoverDialog), online only. */
export async function pipelineDialog06(fetchFn: ReturnType<typeof modelFetch>['fetchFn']): Promise<Outcome[]> {
  const { scan, catalog, covers } = box();
  const targets = coverlessFolders(scan, catalog, covers);
  let rows: BulkRow[] = newRows(targets);
  await runBulkSearch(targets, {
    search: (query, signal, target) => searchCovers(query, { fetchFn, ...searchOptionsFor(target, signal) }),
    onResult: (folder, r) => {
      rows = rows.map((row) => (row.target.folder === folder ? withResult(row, r) : row));
    },
  });
  return rows.map((r) => {
    const first = chosenCandidate(r);
    return { folder: r.target.folder, taken: r.checked && first ? pictureOf(first.thumbUrl) : undefined, first: first && pictureOf(first.thumbUrl), offered: r.candidates.map((c) => pictureOf(c.thumbUrl) ?? '') };
  });
}

/** A JPEG's first bytes, as a picture in a file or folder. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

/** The files of a folder on the card: three tracks, a picture where the case says so; reading takes a little. */
function filesOf(folder: number): FolderFiles {
  const c = FAELLE.find((x) => x.folder === folder)!;
  const slow = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 30));
  return {
    tracks: ['001.mp3', '002.mp3', '003.mp3'],
    others: c.folderImage ? [c.folderImage] : [],
    read: () => slow(JPEG),
    embedded: () => slow(c.embedded ? { data: JPEG, mimeType: 'image/jpeg' } : null),
  };
}

/** 0.6: the automatic search on an open card (autoCovers.ts): the folders' own pictures first, sure hits taken. */
export async function pipelineAuto06(fetchFn: ReturnType<typeof modelFetch>['fetchFn']): Promise<Outcome[]> {
  const { scan, catalog, covers } = box();
  const targets = coverlessFolders(scan, catalog, covers);
  const out: Outcome[] = [];
  await findCovers(targets, {
    search: (query, o) => searchCovers(query, { fetchFn, ...o }),
    files: async (folder) => filesOf(folder),
    onFind: (t, find) => {
      if (find.kind === 'local') out.push({ folder: t.folder, taken: 'local', first: 'local', offered: [], local: true });
      else if (find.kind === 'sure' || find.kind === 'unsure') {
        const pics = find.candidates.map((c) => pictureOf(c.thumbUrl) ?? '');
        out.push({ folder: t.folder, taken: find.kind === 'sure' ? pictureOf(find.candidate.thumbUrl) : undefined, first: pics[0], offered: pics });
      } else out.push({ folder: t.folder, offered: [] });
    },
  });
  return out;
}

/** Fresh services: no answers kept, nobody unreachable, every queue empty. */
export function freshNet() {
  clearAnswers();
  resetServiceHealth();
  for (const g of Object.values(gates)) g.reset();
}

let clockBase = Date.UTC(2026, 9, 27, 8);

/** Runs `pipeline` on a fake clock and returns how long it took there. */
export async function onFakeClock<T>(pipeline: () => Promise<T>): Promise<{ value: T; ms: number }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // Far after the last run: limiters kept in modules have nothing left to wait for.
  clockBase += 24 * 3600 * 1000;
  vi.setSystemTime(clockBase);
  freshNet();
  let settled = false;
  const p = pipeline().finally(() => (settled = true));
  while (!settled) await vi.advanceTimersByTimeAsync(25);
  const value = await p;
  const ms = Date.now() - clockBase;
  vi.useRealTimers();
  return { value, ms };
}

export interface Score {
  folders: number;
  searched: number;
  takenRight: number;
  takenWrong: number;
  firstRight: number;
  offeredRight: number;
  local: number;
  /** Has a right picture somewhere, but it was not taken. */
  toChoose: number;
  nothingRight: number;
  seconds: number;
  requests: Counts;
  ownTouched: number;
  /** Cases taken wrong and cases to choose from, by id. */
  wrong: string[];
  unsure: string[];
}

export function score(m: Measured): Score {
  const byFolder = new Map(FAELLE.map((c) => [c.folder, c]));
  const s: Score = { folders: FAELLE.length, searched: m.outcomes.length, takenRight: 0, takenWrong: 0, firstRight: 0, offeredRight: 0, local: 0, toChoose: 0, nothingRight: 0, seconds: Math.round(m.ms / 100) / 10, requests: m.counts, ownTouched: 0, wrong: [], unsure: [] };
  for (const o of m.outcomes) {
    const c = byFolder.get(o.folder)!;
    if (c.own) s.ownTouched++;
    const right = (p?: string) => !!p && c.want.includes(p);
    if (o.local) s.local++;
    if (o.taken) {
      if (right(o.taken) || o.local) s.takenRight++;
      else {
        s.takenWrong++;
        s.wrong.push(c.id);
      }
    }
    if (right(o.first)) s.firstRight++;
    if (o.offered.some(right) || (o.local && o.taken)) s.offeredRight++;
    else if (c.want.length) s.nothingRight++;
    if (!o.taken && o.offered.some(right)) s.toChoose++;
    if (!o.taken && o.offered.length) s.unsure.push(c.id);
  }
  return s;
}

export function table(rows: { label: string; s: Score }[]): string {
  const head = '| | Ordner gesucht | sicher übernommen, richtig | sicher übernommen, falsch | zur Auswahl (richtiges dabei) | richtiges nicht gefunden | aus den Dateien | Zeit | Anfragen iTunes/Deezer/MB |';
  const sep = '|---|---|---|---|---|---|---|---|---|';
  const line = ({ label, s }: { label: string; s: Score }) =>
    `| ${label} | ${s.searched} | ${s.takenRight} | ${s.takenWrong} | ${s.toChoose} | ${s.nothingRight} | ${s.local} | ${s.seconds} s | ${s.requests.itunes}/${s.requests.deezer}/${s.requests.musicbrainz} |`;
  return [head, sep, ...rows.map(line)].join('\n');
}

afterEach(() => {
  vi.useRealTimers();
});

const SCENARIOS: { label: string; opts: Parameters<typeof modelFetch>[0] }[] = [
  { label: 'alle Dienste erreichbar', opts: {} },
  { label: 'Deezer gesperrt (Webfilter)', opts: { blocked: ['deezer', 'images'] } },
  { label: 'MusicBrainz anfangs ausgelastet (503)', opts: { busyMusicBrainz: 3 } },
];

describe('Frank folders, 0.6 (after)', () => {
  it('measures dialog and automatic search against 0.5.1', async () => {
    const rows: { label: string; s: Score }[] = [];
    const json: Record<string, unknown> = {};
    for (const sc of SCENARIOS) {
      for (const [name, pipeline] of [
        ['0.5.1 Dialog', pipelineV05],
        ['0.6 Dialog', pipelineDialog06],
        ['0.6 automatisch', pipelineAuto06],
      ] as const) {
        const model = modelFetch(sc.opts);
        const { value, ms } = await onFakeClock(() => pipeline(model.fetchFn));
        const s = score({ label: name, outcomes: value, ms, counts: { ...model.counts } });
        rows.push({ label: `${name}, ${sc.label}`, s });
        json[`${name} | ${sc.label}`] = { score: s, outcomes: value };
        expect(s.ownTouched, `${name}, ${sc.label}`).toBe(0);
      }
    }
    console.log(`\n${table(rows)}\n`);
    for (const r of rows) console.log(`${r.label}: falsch ${r.s.wrong.join(', ') || '–'}; zur Auswahl ${r.s.unsure.join(', ') || '–'}`);
    if (process.env.MESSUNG_OUT) writeFileSync(process.env.MESSUNG_OUT, JSON.stringify(json, null, 1));
    const get = (label: string) => rows.find((r) => r.label === label)!.s;
    const before = get('0.5.1 Dialog, alle Dienste erreichbar');
    const dialog = get('0.6 Dialog, alle Dienste erreichbar');
    const auto = get('0.6 automatisch, alle Dienste erreichbar');
    // More taken without a look, none of them wrong, and faster.
    expect(dialog.takenRight).toBeGreaterThan(before.takenRight);
    // The automatic run also takes the pictures in the folders, without asking a service.
    expect(auto.takenRight).toBeGreaterThanOrEqual(dialog.takenRight);
    expect(auto.local).toBeGreaterThan(0);
    expect(dialog.takenWrong).toBe(0);
    expect(auto.takenWrong).toBe(0);
    expect(dialog.seconds).toBeLessThan(before.seconds);
    expect(auto.seconds).toBeLessThan(before.seconds);
    // With Deezer blocked, nothing gets worse than in 0.5.1.
    expect(get('0.6 Dialog, Deezer gesperrt (Webfilter)').takenRight).toBeGreaterThanOrEqual(before.takenRight);
  }, 120_000);
});

describe('Frank folders, v05 (before)', () => {
  it('measures the search of 0.5.1', async () => {
    const model = modelFetch();
    const { value, ms } = await onFakeClock(() => pipelineV05(model.fetchFn));
    const s = score({ label: 'v05', outcomes: value, ms, counts: model.counts });
    console.log(`\n${table([{ label: '0.5.1', s }])}\n`);
    expect(s.ownTouched).toBe(0);
  }, 60_000);
});
