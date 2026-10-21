/**
 * The extra "Mehr als 99 Hörspiele" on the add page: albums go onto the end
 * of one folder as its episodes, the tracks there keep their numbers, and
 * every new track notes its episode in the catalog.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { card, platform, settings } from '../../src/app/state';
import { createBrowserAudioBackend } from '../../src/core/audio';
import type { DraftTrack } from '../../src/core/library/grouping';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { detectEpisodes } from '../../src/core/tonuino/episodes';
import { scanSd } from '../../src/core/tonuino/sd';
import { gatherInto, plannedRanges, problems, resetImport, resultNotes, runImport, session, spreadOut, type ImportAlbum } from '../../src/features/add/session';
import { memDir, memSource, type MemTree } from '../../src/platform/memory';
import type { Platform } from '../../src/platform/types';
import { fakeWebCodecs } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { monoMp3 } from '../audio/fixtures';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });
const defaults = settings.value;

async function useCard(tree: MemTree = {}) {
  const root = memDir(tree);
  platform.value = { kind: 'web', os: 'linux', audio, volumes: { info: async () => ({}) } } as unknown as Platform;
  card.value = {
    volume: { id: 'sd', label: 'SD', root, info: {}, canEject: false },
    status: 'ready',
    scan: await scanSd(root),
    catalog: newCatalog(),
    catalogOnCard: true,
    covers: new Map(),
    coverUrls: new Map(),
    info: {},
  };
  resetImport();
  return root;
}

function album(id: string, title: string, files: number, target: number): ImportAlbum {
  const tracks: DraftTrack[] = Array.from({ length: files }, (_, i) => ({ source: memSource(`${id}${i + 1}.mp3`, monoMp3()), info: { codec: 'mp3', durationSec: 12 }, title: `${title} ${i + 1}` }));
  return { id, title, kind: 'hoerspiel', tracks, split: 'none', splitMinutes: 5, target, append: false };
}

afterEach(() => {
  settings.value = defaults;
});

describe('episodes onto the end of a folder', { timeout: 30_000 }, () => {
  it('appends every album after the tracks there and notes its episode on its tracks', async () => {
    const root = await useCard({ '05': { '001.mp3': monoMp3(), '002.mp3': monoMp3(), '003.mp3': monoMp3() } });
    settings.value = { ...defaults, normalizeLoudness: false, episodePlanner: true };
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'Folge 1: Im Wald', 2, 1), album('b', 'Folge 2: Am See', 1, 2)] };
    gatherInto(5);
    expect(session.value.albums.map((a) => [a.target, a.append])).toEqual([
      [5, true],
      [5, true],
    ]);
    const scan = card.value!.scan!;
    expect([...plannedRanges(session.value, scan)]).toEqual([
      ['a', { first: 4, last: 5, exact: true }],
      ['b', { first: 6, last: 6, exact: true }],
    ]);
    expect(problems(session.value, scan)).toEqual([]);

    await runImport();
    // The folder counts once (the done screen keys its tiles by it), the albums twice.
    expect(session.value.result?.folders).toEqual([5]);
    expect(session.value.result?.albums).toBe(2);
    // The done screen sends to „Folgen in diesem Ordner“: each new episode wants a card of its own.
    expect(session.value.result?.episodes).toEqual([5]);
    expect(resultNotes(session.value.result!)).toEqual(['2 Alben sind angekommen.']);
    expect((await (await root.dir('05')).list()).map((e) => e.name).sort()).toEqual(['001.mp3', '002.mp3', '003.mp3', '004.mp3', '005.mp3', '006.mp3']);
    const tracks = card.value!.catalog!.folders['05'].tracks;
    expect(tracks.map((t) => [t.file, t.episode])).toEqual([
      ['004.mp3', 'Folge 1: Im Wald'],
      ['005.mp3', 'Folge 1: Im Wald'],
      ['006.mp3', 'Folge 2: Am See'],
    ]);
    const numbered = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, episode: tracks.find((t) => t.file === `00${n}.mp3`)?.episode }));
    expect(detectEpisodes(numbered, 'Ordner 05')).toEqual([
      { title: 'Ordner 05', first: 1, last: 3 },
      { title: 'Folge 1: Im Wald', first: 4, last: 5 },
      { title: 'Folge 2: Am See', first: 6, last: 6 },
    ]);
  });

  it('makes a new folder with the first album and appends the others; undoing gives each a folder again', async () => {
    await useCard({ '01': { '001.mp3': monoMp3() } });
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'A', 1, 2), album('b', 'B', 2, 3), album('c', 'C', 1, 4)] };
    gatherInto(7);
    expect(session.value.albums.map((a) => [a.target, a.append])).toEqual([
      [7, false],
      [7, true],
      [7, true],
    ]);
    expect([...plannedRanges(session.value, card.value!.scan!).values()].map((r) => [r.first, r.last])).toEqual([
      [1, 1],
      [2, 3],
      [4, 4],
    ]);
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    spreadOut(7);
    expect(session.value.albums.map((a) => [a.target, a.append])).toEqual([
      [2, false],
      [3, false],
      [4, false],
    ]);
  });

  it('notes no episode while the extra is off', async () => {
    await useCard({ '05': { '001.mp3': monoMp3() } });
    settings.value = { ...defaults, normalizeLoudness: false };
    session.value = { phase: 'review', rejected: [], albums: [{ ...album('a', 'Folge', 1, 5), append: true }] };
    await runImport();
    expect(card.value!.catalog!.folders['05'].tracks.map((t) => t.episode)).toEqual([undefined]);
    expect(session.value.result?.episodes).toBeUndefined();
  });

  it('stops at 255 titles in a folder', async () => {
    const full: MemTree = {};
    for (let n = 1; n <= 254; n++) full[`${String(n).padStart(3, '0')}.mp3`] = new Uint8Array(4);
    await useCard({ '09': full });
    session.value = { phase: 'review', rejected: [], albums: [album('a', 'A', 1, 1), album('b', 'B', 1, 2)] };
    gatherInto(9);
    expect(problems(session.value, card.value!.scan!).map((p) => [p.album, p.text])).toEqual([['b', 'In Ordner 09 passen nur 255 Titel. Es wären 256. Nimm ein paar Dateien heraus.']]);
  });
});
