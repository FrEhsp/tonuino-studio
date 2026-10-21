/**
 * A transfer that stops (cancelled, or an error) keeps what did not reach the
 * card, and goes on with it where it stopped: also inside a cut file, with
 * the loudness change it had. Downloaded files stay until then and go once
 * the import is over. The audio work is faked; tests/add/process.test.ts
 * covers the cutting itself.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { card, platform, settings, type CardState } from '../../src/app/state';
import type { DraftTrack } from '../../src/core/library/grouping';
import { scanSd } from '../../src/core/tonuino/sd';
import { newCatalog } from '../../src/core/tonuino/catalog';
import type { AlbumGain, FileError, PreparedAlbum, ProcessOptions, TrackJob } from '../../src/features/add/process';
import {
  addSources,
  cancelImport,
  problems,
  resetImport,
  resumeImport,
  runImport,
  session,
  totalBytes,
  trackCountOf,
  updateTracks,
  type ImportAlbum,
} from '../../src/features/add/session';
import { memDir, type MemDir } from '../../src/platform/memory';
import type { ByteSource, Dir, Platform } from '../../src/platform/types';

/**
 * What the faked audio work saw and does: parts per file title, a part that
 * fails and stops the transfer, a part that is broken (the file is left
 * out), files that cannot be read at all.
 */
const fake = vi.hoisted(() => ({
  prepared: [] as { tracks: string[]; opts: ProcessOptions }[],
  parts: new Map<string, number>(),
  failOn: undefined as string | undefined,
  brokenOn: undefined as string | undefined,
  unreadable: new Set<string>(),
}));

vi.mock('../../src/features/add/process', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/features/add/process')>();
  return {
    ...original,
    prepareAlbum: async (album: ImportAlbum, opts: ProcessOptions): Promise<PreparedAlbum> => {
      fake.prepared.push({ tracks: album.tracks.map((t) => t.title), opts });
      const gain: AlbumGain = opts.gain ?? { steps: -2, convertDb: -3 };
      const jobs: TrackJob[] = [];
      const skipped: FileError[] = [];
      for (const t of album.tracks) {
        if (fake.unreadable.has(t.title)) {
          skipped.push(new original.FileError(t, new Error('Die Datei ist kaputt.')));
          continue;
        }
        const parts = fake.parts.get(t.title) ?? 1;
        for (let part = opts.skipParts?.get(t.source) ?? 0; part < parts; part++) {
          const title = parts > 1 ? `${t.title} – Teil ${part + 1}` : t.title;
          jobs.push({
            track: t,
            source: t.source,
            part,
            parts,
            title,
            estimateBytes: 100,
            work: 'copy',
            changes: [],
            worked: () => 0,
            produce: async () => {
              if (fake.failOn === title) throw new Error(`„${title}“ lässt sich nicht lesen.`);
              if (fake.brokenOn === title) throw new original.FileError(t, new Error('Die Datei ist kaputt.'));
              return new Blob([`${title} (${gain.steps})`]);
            },
          });
        }
      }
      return { jobs, gain, skipped, rebuilt: [], close: () => undefined };
    },
  };
});

const MP3 = new Uint8Array(readFileSync(new URL('../fixtures/library/short.mp3', import.meta.url)));

function file(name: string): ByteSource {
  return { name, size: MP3.length, read: async (start, length) => MP3.subarray(start, start + length) };
}

function draft(title: string, durationSec = 60): DraftTrack {
  return { source: file(`${title}.mp3`), title, info: { codec: 'mp3', durationSec } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: MemDir;

async function insertCard() {
  root = memDir();
  card.value = {
    volume: { id: 'sd', label: 'SD', root, info: {}, canEject: false },
    status: 'ready',
    scan: await scanSd(root),
    info: {},
    covers: new Map(),
    coverUrls: new Map(),
    catalogOnCard: false,
  } as CardState;
}

/** The files in a folder on the card, with what the fake wrote into them. */
async function folderFiles(name: string): Promise<[string, string][] | undefined> {
  if (!(await root.exists(name))) return undefined;
  const dir: Dir = await root.dir(name);
  const out: [string, string][] = [];
  for (const e of await dir.list()) out.push([e.name, new TextDecoder().decode(await dir.read(e.name))]);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Presses "Abbrechen" when the transfer gets to this file of the first album. */
function stopAt(track: number) {
  let stopped = false;
  const stop = session.subscribe((s) => {
    if (stopped || s.phase !== 'writing' || s.write?.album !== 0 || s.write.track !== track || s.write.step === 'prepare') return;
    stopped = true;
    queueMicrotask(() => stop());
    cancelImport();
  });
}

function review(albums: ImportAlbum[]) {
  session.value = { phase: 'review', albums, rejected: [] };
}

function album(tracks: DraftTrack[], patch: Partial<ImportAlbum> = {}): ImportAlbum {
  return { id: 'a1', title: 'Das Hörbuch', kind: 'hoerbuch', tracks, split: 'pauses', splitMinutes: 5, target: 1, append: false, ...patch };
}

beforeEach(async () => {
  fake.prepared.length = 0;
  fake.parts.clear();
  fake.failOn = undefined;
  fake.brokenOn = undefined;
  fake.unreadable.clear();
  platform.value = { audio: {}, volumes: { info: async () => ({}) } } as unknown as Platform;
  settings.value = { ...settings.value, pureNumbers: true };
  await insertCard();
  resetImport();
});

describe('a transfer that stops', () => {
  it('keeps the rest of a download, goes on with it, and removes the download once all is on the card', async () => {
    const one = file('Zuerst.mp3');
    const two = file('Danach.mp3');
    const release = vi.fn();
    await addSources([one, two], {
      hints: new Map([
        [one, { title: 'Folge 1', album: 'Hörspiele', albumArtist: 'Kanal', trackNo: 1 }],
        [two, { title: 'Folge 2', album: 'Hörspiele', albumArtist: 'Kanal', trackNo: 2 }],
      ]),
      release,
    });
    expect(session.value.phase).toBe('review');

    stopAt(1);
    await runImport();
    const done = session.value;
    expect(done.phase).toBe('done');
    expect(done.result).toMatchObject({ cancelled: true, partial: { folder: 1, written: 1 } });
    expect(await folderFiles('01')).toEqual([['001.mp3', 'Folge 1 (-2)']]);
    // The second file is still there, ready to go on with.
    expect(done.result?.rest?.map((a) => [a.title, a.target, a.append, a.tracks.map((t) => t.title)])).toEqual([['Hörspiele', 1, true, ['Folge 2']]]);
    expect(done.result?.rest?.[0].resume).toEqual({ parts: new Map(), gain: { steps: -2, convertDb: -3 }, last: 1 });
    await flush();
    expect(release).not.toHaveBeenCalled();

    resumeImport();
    expect(session.value.phase).toBe('review');
    expect(session.value.albums.map((a) => a.tracks.map((t) => t.title))).toEqual([['Folge 2']]);
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    await runImport();
    expect(session.value.phase).toBe('done');
    expect(session.value.result).toMatchObject({ folders: [1] });
    expect(session.value.result?.cancelled).toBeUndefined();
    expect(session.value.result?.rest).toEqual([]);
    // Same loudness change as the first part of the album.
    expect(fake.prepared[1].opts.gain).toEqual({ steps: -2, convertDb: -3 });
    expect(await folderFiles('01')).toEqual([
      ['001.mp3', 'Folge 1 (-2)'],
      ['002.mp3', 'Folge 2 (-2)'],
    ]);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('goes on inside a cut file with the parts that are missing', async () => {
    fake.parts.set('Teil B', 4);
    review([album([draft('Teil A'), draft('Teil B', 7200), draft('Teil C')])]);
    // Stops after A and the first two parts of B.
    stopAt(3);
    await runImport();
    const [rest] = session.value.result?.rest ?? [];
    expect(rest.tracks.map((t) => t.title)).toEqual(['Teil B', 'Teil C']);
    expect([...(rest.resume?.parts ?? [])].map(([s, p]) => [s.name, p])).toEqual([['Teil B.mp3', { done: 2, of: 4, files: ['002.mp3', '003.mp3'] }]]);
    expect(rest).toMatchObject({ append: true, target: 1 });
    // Two parts of B and C are left.
    expect(trackCountOf(rest)).toEqual({ count: 3, exact: true });

    resumeImport();
    expect(totalBytes(session.value)).toBeGreaterThan(0);
    await runImport();
    expect([...(fake.prepared[1].opts.skipParts ?? [])].map(([s, n]) => [s.name, n])).toEqual([['Teil B.mp3', 2]]);
    expect(session.value.result).toMatchObject({ folders: [1] });
    expect((await folderFiles('01'))?.map(([name, text]) => `${name}: ${text}`)).toEqual([
      '001.mp3: Teil A (-2)',
      '002.mp3: Teil B – Teil 1 (-2)',
      '003.mp3: Teil B – Teil 2 (-2)',
      '004.mp3: Teil B – Teil 3 (-2)',
      '005.mp3: Teil B – Teil 4 (-2)',
      '006.mp3: Teil C (-2)',
    ]);
  });

  it('says so when a file would now be cut into other parts', async () => {
    fake.parts.set('Teil B', 4);
    review([album([draft('Teil B', 7200)])]);
    stopAt(2);
    await runImport();
    fake.parts.set('Teil B', 5);
    resumeImport();
    await runImport();
    expect(session.value.result?.error).toMatch(/^„Teil B“ lässt sich nicht mehr genauso teilen wie vorhin\. Lösche die Teile in Ordner 01/);
    expect((await folderFiles('01'))?.map(([name]) => name)).toEqual(['001.mp3', '002.mp3']);
  });

  it('does not go on when the folder changed since the stop, or another card is in', async () => {
    fake.parts.set('Teil B', 4);
    review([album([draft('Teil A'), draft('Teil B', 7200)])]);
    stopAt(2);
    await runImport();
    const [rest] = session.value.result?.rest ?? [];
    expect(rest.resume?.last).toBe(2);
    const changed = /^In Ordner 01 hat sich seit dem Abbruch etwas geändert, oder es steckt eine andere SD-Karte im Computer\./;

    // A file came into the folder meanwhile.
    await (await root.dir('01')).write('003.mp3', new Uint8Array(8));
    card.value = { ...card.value!, scan: await scanSd(root) };
    resumeImport();
    expect(problems(session.value, card.value.scan!).map((p) => p.text)).toEqual([expect.stringMatching(changed)]);
    // Also when the transfer starts anyway: nothing is written, the rest stays.
    await runImport();
    expect(session.value.result?.error).toMatch(changed);
    expect((await folderFiles('01'))?.map(([name]) => name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(session.value.result?.rest?.[0].resume?.last).toBe(2);

    // Another card, without folder 01.
    await insertCard();
    resumeImport();
    expect(problems(session.value, card.value!.scan!).map((p) => p.text)).toEqual([expect.stringMatching(changed)]);
    await runImport();
    expect(session.value.result?.error).toMatch(changed);
    expect(await root.exists('01')).toBe(false);
  });

  it('takes away the parts on the card of a cut file that breaks when it goes on', async () => {
    card.value = { ...card.value!, catalog: newCatalog(), catalogOnCard: true };
    fake.parts.set('Buch', 4);
    review([album([draft('Buch', 7200), draft('Ende')])]);
    stopAt(2);
    await runImport();
    expect((await folderFiles('01'))?.map(([, text]) => text)).toEqual(['Buch – Teil 1 (-2)', 'Buch – Teil 2 (-2)']);
    expect(card.value!.catalog!.folders['01'].tracks.map((t) => t.file)).toEqual(['001.mp3', '002.mp3']);

    // The third part is broken: the file is left out with all its parts, also those from before the stop.
    fake.brokenOn = 'Buch – Teil 3';
    resumeImport();
    await runImport();
    const r = session.value.result;
    expect(r).toMatchObject({ folders: [1], skipped: [{ name: 'Buch.mp3', reason: 'Die Datei ist kaputt.' }], rest: [] });
    expect(r?.error).toBeUndefined();
    // The next file takes the first number, so the box finds it.
    expect(await folderFiles('01')).toEqual([['001.mp3', 'Ende (-2)']]);
    expect(card.value!.catalog!.folders['01'].tracks.map((t) => [t.file, t.title])).toEqual([['001.mp3', 'Ende']]);
  });

  it('leaves no gap in the numbers when a cut file moved down the list breaks', async () => {
    card.value = { ...card.value!, catalog: newCatalog(), catalogOnCard: true };
    fake.parts.set('Buch', 4);
    review([album([draft('Anfang'), draft('Buch', 7200), draft('Ende')])]);
    // Stops after Anfang and the first two parts of Buch.
    stopAt(3);
    await runImport();
    expect((await folderFiles('01'))?.map(([name]) => name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);

    // "Ende" goes first now; then the third part of Buch is broken.
    resumeImport();
    updateTracks(session.value.albums[0].id, (list) => [list[1], list[0]]);
    fake.brokenOn = 'Buch – Teil 3';
    await runImport();
    expect(session.value.result).toMatchObject({ folders: [1], skipped: [{ name: 'Buch.mp3' }], rest: [] });
    // Ende moves up to the first free number: the box finds it.
    expect(await folderFiles('01')).toEqual([
      ['001.mp3', 'Anfang (-2)'],
      ['002.mp3', 'Ende (-2)'],
    ]);
    expect(card.value!.catalog!.folders['01'].tracks.map((t) => [t.file, t.title])).toEqual([
      ['001.mp3', 'Anfang'],
      ['002.mp3', 'Ende'],
    ]);
  });

  it('moves up the parts of another cut file from before, titles and all', async () => {
    card.value = { ...card.value!, catalog: newCatalog(), catalogOnCard: true };
    fake.parts.set('Buch', 3);
    fake.parts.set('Brief', 3);
    review([album([draft('Buch', 7200), draft('Brief', 7200)])]);
    // Run 1 stops after the first part of Buch.
    stopAt(1);
    await runImport();
    // Run 2 does Brief first and stops after its first part.
    resumeImport();
    updateTracks(session.value.albums[0].id, (list) => [list[1], list[0]]);
    stopAt(1);
    await runImport();
    expect((await folderFiles('01'))?.map(([, text]) => text)).toEqual(['Buch – Teil 1 (-2)', 'Brief – Teil 1 (-2)']);
    // Run 3: Buch cannot be read any more. Its part goes, the part of Brief takes its number.
    fake.unreadable.add('Buch');
    resumeImport();
    await runImport();
    expect(session.value.result?.error).toBeUndefined();
    expect((await folderFiles('01'))?.map(([name, text]) => `${name}: ${text}`)).toEqual([
      '001.mp3: Brief – Teil 1 (-2)',
      '002.mp3: Brief – Teil 2 (-2)',
      '003.mp3: Brief – Teil 3 (-2)',
    ]);
    expect(card.value!.catalog!.folders['01'].tracks.map((t) => [t.file, t.title])).toEqual([
      ['001.mp3', 'Brief – Teil 1'],
      ['002.mp3', 'Brief – Teil 2'],
      ['003.mp3', 'Brief – Teil 3'],
    ]);
  });

  it('can still go on when the parts of a cut file went and the run stopped before a new file arrived', async () => {
    card.value = { ...card.value!, catalog: newCatalog(), catalogOnCard: true };
    fake.parts.set('Buch', 4);
    review([album([draft('Anfang'), draft('Buch', 7200), draft('Ende')])]);
    // Run 1 stops after Anfang and the first two parts of Buch.
    stopAt(3);
    await runImport();
    expect((await folderFiles('01'))?.map(([name]) => name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    // Run 2: Buch cannot be read any more, its parts go; then Ende fails before it is written.
    resumeImport();
    fake.unreadable.add('Buch');
    fake.failOn = 'Ende';
    await runImport();
    expect(session.value.result?.error).toBeDefined();
    expect((await folderFiles('01'))?.map(([name]) => name)).toEqual(['001.mp3']);
    expect(session.value.result?.rest[0].resume?.last).toBe(1);
    // Run 3 goes on: nothing changed on the card outside the app.
    fake.failOn = undefined;
    resumeImport();
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    await runImport();
    expect(session.value.result?.error).toBeUndefined();
    expect(await folderFiles('01')).toEqual([
      ['001.mp3', 'Anfang (-2)'],
      ['002.mp3', 'Ende (-2)'],
    ]);
  });

  it('takes away the parts of a cut file that cannot be read any more, and goes on with the next albums', async () => {
    card.value = { ...card.value!, catalog: newCatalog(), catalogOnCard: true };
    fake.parts.set('Buch', 4);
    review([album([draft('Buch', 7200)]), album([draft('Anderes')], { id: 'a2', title: 'Zweites', target: 2 })]);
    stopAt(2);
    await runImport();
    expect((await folderFiles('01'))?.map(([name]) => name)).toEqual(['001.mp3', '002.mp3']);

    fake.unreadable.add('Buch');
    resumeImport();
    await runImport();
    const r = session.value.result;
    // No "cannot be cut the same way": the file is left out, nothing else stops.
    expect(r?.error).toBeUndefined();
    expect(r).toMatchObject({ folders: [2], skipped: [{ name: 'Buch.mp3', reason: 'Die Datei ist kaputt.' }], rest: [] });
    // Folder 01 only held the parts: it goes, and so does its entry.
    expect(await root.exists('01')).toBe(false);
    expect(card.value!.catalog!.folders['01']).toBeUndefined();
    expect(await folderFiles('02')).toEqual([['001.mp3', 'Anderes (-2)']]);
  });

  it('keeps later albums for later, and takes away the empty folder it made', async () => {
    fake.failOn = 'Kaputt';
    review([album([draft('Kaputt'), draft('Gut')]), album([draft('Anderes')], { id: 'a2', title: 'Zweites', target: 2 })]);
    await runImport();
    const r = session.value.result;
    expect(r?.error).toBe('„Kaputt“ lässt sich nicht lesen.');
    expect(r?.partial).toBeUndefined();
    // Nothing got there: no empty folder 01 is left on the card.
    expect(await root.exists('01')).toBe(false);
    expect(r?.rest?.map((a) => [a.title, a.target, a.append, !!a.resume, a.tracks.length])).toEqual([
      ['Das Hörbuch', 1, false, false, 2],
      ['Zweites', 2, false, false, 1],
    ]);
    // Without the broken file, the rest goes on the card as planned.
    fake.failOn = undefined;
    resumeImport();
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    await runImport();
    expect(session.value.result).toMatchObject({ folders: [1, 2] });
  });

  it('forgets the rest and its downloads when the import is discarded', async () => {
    const one = file('Eins.mp3');
    const two = file('Zwei.mp3');
    const release = vi.fn();
    await addSources([one, two], {
      hints: new Map([
        [one, { title: 'Eins', album: 'Lieder', albumArtist: 'Chor', trackNo: 1 }],
        [two, { title: 'Zwei', album: 'Lieder', albumArtist: 'Chor', trackNo: 2 }],
      ]),
      release,
    });
    stopAt(1);
    await runImport();
    expect(session.value.result?.rest).toHaveLength(1);
    await flush();
    expect(release).not.toHaveBeenCalled();
    resetImport();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('a transfer that ends well', () => {
  it('removes the downloaded files once everything is on the card', async () => {
    const src = file('Lied.mp3');
    const release = vi.fn();
    await addSources([src], { hints: new Map([[src, { title: 'Lied', album: 'Lieder', albumArtist: 'Chor' }]]), release });
    await runImport();
    expect(session.value.phase).toBe('done');
    expect(session.value.result).toMatchObject({ folders: [1] });
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
