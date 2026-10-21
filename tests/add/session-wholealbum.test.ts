/**
 * A whole album in one file on "Hinzufügen" (TODO 0.4 #52): the cue sheet
 * beside it is found while reading, and an album cut at its tracks goes to
 * the card as one title per track, with the tracks' names.
 */
import { describe, expect, it } from 'vitest';
import { card, platform } from '../../src/app/state';
import { createBrowserAudioBackend, encodeWav16 } from '../../src/core/audio';
import { albumCutsOf } from '../../src/core/library/albumcut';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { addSources, resetImport, runImport, session, trackCountOf, updateAlbum, updateTracks } from '../../src/features/add/session';
import { cueFor } from '../../src/features/add/wholeAlbum';
import { memDir, memSource } from '../../src/platform/memory';
import type { Platform } from '../../src/platform/types';
import { fakeWebCodecs } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { monoMp3, SR } from '../audio/fixtures';
import { concat, synth } from '../audio/helpers';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });

async function useCard() {
  const root = memDir({});
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

/** Three songs of 2, 2.5 and 1.5 seconds, each ending in a short silence. */
function albumWav(): Uint8Array {
  const song = (sec: number, freq: number) => [
    { sec: sec - 0.3, freq, amp: 0.2 },
    { sec: 0.3, freq: 0 },
  ];
  return encodeWav16([synth(SR, [...song(2, 440), ...song(2.5, 660), ...song(1.5, 880)])], SR);
}

const CUE = [
  'PERFORMER "Die Apfelbaum-Band"',
  'TITLE "Lieder vom Apfelbaum"',
  'FILE "Lieder vom Apfelbaum.wav" WAVE',
  '  TRACK 01 AUDIO',
  '    TITLE "Guten Morgen, Apfelbaum"',
  '    INDEX 01 00:00:00',
  '  TRACK 02 AUDIO',
  '    TITLE "Regenbogenlied"',
  '    INDEX 01 00:02:00',
  '  TRACK 03 AUDIO',
  '    TITLE "Gute Nacht, Apfelbaum"',
  '    INDEX 01 00:04:38',
].join('\r\n');

const SLOW = { timeout: 30_000 };

describe('a whole album in one file', SLOW, () => {
  it('finds the cue sheet beside the file and goes to the card as one title per track', async () => {
    const root = await useCard();
    const wav = memSource('Lieder vom Apfelbaum.wav', albumWav(), 'Apfelbaum/Lieder vom Apfelbaum.wav');
    const cue = memSource('Lieder vom Apfelbaum.cue', new TextEncoder().encode(CUE), 'Apfelbaum/Lieder vom Apfelbaum.cue');
    const added = await addSources([wav, cue]);
    // The cue sheet is no audio file, but nothing to complain about.
    expect(added.rejected).toEqual([]);
    const [a] = session.value.albums;
    const [t] = a.tracks;
    expect(cueFor(t.source)?.tracks.map((x) => x.title)).toEqual(['Guten Morgen, Apfelbaum', 'Regenbogenlied', 'Gute Nacht, Apfelbaum']);
    // Short files are not cut unless asked.
    expect(a.split).toBe('none');
    expect(trackCountOf(a)).toEqual({ count: 1, exact: true });

    // "So teilen" in the preview: the cuts in the silences.
    updateTracks(a.id, (list) => list.map((x) => ({ ...x, albumCuts: albumCutsOf('Cue-Datei', ['Guten Morgen, Apfelbaum', 'Regenbogenlied', 'Gute Nacht, Apfelbaum'], [1.85, 4.35]) })));
    updateAlbum(a.id, { split: 'tracks' });
    expect(trackCountOf(session.value.albums[0])).toEqual({ count: 3, exact: true });

    await runImport();
    expect(session.value.phase).toBe('done');
    const folder = await root.dir('01');
    expect((await folder.list()).map((e) => e.name).sort()).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(card.value?.catalog?.folders['01']?.tracks.map((x) => x.title)).toEqual(['Guten Morgen, Apfelbaum', 'Regenbogenlied', 'Gute Nacht, Apfelbaum']);
  });

  it('takes no cue sheet that names another file', async () => {
    await useCard();
    const wav = memSource('CD1.wav', albumWav(), 'Album/CD1.wav');
    const other = memSource('CD2.wav', albumWav(), 'Album/CD2.wav');
    const cue = memSource('Album.cue', new TextEncoder().encode(CUE), 'Album/Album.cue');
    await addSources([wav, other, cue]);
    for (const t of session.value.albums.flatMap((a) => a.tracks)) expect(cueFor(t.source)).toBeUndefined();
  });

  it('cuts the other long files at pauses again when the whole album leaves', async () => {
    await useCard();
    const wav = memSource('Lieder vom Apfelbaum.wav', albumWav(), 'Apfelbaum/Lieder vom Apfelbaum.wav');
    // About 22 minutes: long enough to be cut at pauses.
    const book = memSource('Bonus.mp3', concat(Array.from({ length: 110 }, () => monoMp3())), 'Apfelbaum/Bonus.mp3');
    await addSources([wav, book]);
    const [a] = session.value.albums;
    updateTracks(a.id, (list) => list.map((x) => (x.source === wav ? { ...x, albumCuts: albumCutsOf('iTunes', ['A', 'B', 'C'], [2, 4.5]) } : x)));
    updateAlbum(a.id, { split: 'tracks' });
    expect(trackCountOf(session.value.albums[0]).count).toBeGreaterThan(3);
    updateTracks(a.id, (list) => list.filter((x) => x.source !== wav));
    expect(session.value.albums[0].split).toBe('pauses');
  });
});
