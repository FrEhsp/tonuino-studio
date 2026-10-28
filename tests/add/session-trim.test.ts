/**
 * „Zuschneiden …“ for titles not on the card yet (0.6, #131): the cut is
 * kept with the title, the picked file stays as it is, and the card gets
 * the cut title when it is copied.
 */
import { describe, expect, it } from 'vitest';
import { card, platform } from '../../src/app/state';
import { createBrowserAudioBackend, scanMp3 } from '../../src/core/audio';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { addSources, resetImport, runImport, session, trimPendingProblem, trimTracks, untrimTrack } from '../../src/features/add/session';
import { memDir, memSource, type MemTree } from '../../src/platform/memory';
import type { Dir, Platform } from '../../src/platform/types';
import { fakeWebCodecs } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { monoMp3, stereoMp3 } from '../audio/fixtures';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });

async function useCard(tree: MemTree = {}): Promise<Dir> {
  const root = memDir(tree);
  platform.value = { kind: 'web', os: 'linux', audio, volumes: { info: async () => ({}) } } as unknown as Platform;
  card.value = { volume: { id: 'sd', label: 'SD', root, info: {}, canEject: false }, status: 'ready', scan: await scanSd(root), catalog: newCatalog(), catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
  resetImport();
  return root;
}

const SLOW = { timeout: 30_000 };

describe('cutting a title before it goes to the card', SLOW, () => {
  it('keeps the cut with the title and copies the cut title to the card', async () => {
    const root = await useCard();
    resetImport(1);
    const picked = memSource('Eins.mp3', monoMp3());
    await addSources([picked, memSource('Zwei.mp3', stereoMp3())]);
    const a = session.value.albums[0];
    expect(a.tracks[0].info?.durationSec).toBeCloseTo(12, 0);
    const r = await trimTracks(a.id, new Map([[picked, { startSec: 2, endSec: 9, cuts: [] }]]));
    expect(r).toEqual({ cut: 1, skipped: [] });
    const t = session.value.albums[0].tracks[0];
    expect(t.trimmed?.source).toBe(picked);
    expect(t.source).not.toBe(picked);
    expect(t.source.name).toBe('Eins.mp3');
    expect(t.info?.durationSec).toBeGreaterThan(6.9);
    expect(t.info?.durationSec).toBeLessThan(7.1);
    // The picked file is as it was.
    expect((await scanMp3(picked)).durationSec).toBeCloseTo(12, 0);

    await runImport();
    expect(session.value.phase).toBe('done');
    const dir = await root.dir('01');
    const first = await scanMp3(await dir.source('001.mp3'));
    expect(first.durationSec).toBeGreaterThan(6.9);
    expect(first.durationSec).toBeLessThan(7.1);
    expect((await scanMp3(await dir.source('002.mp3'))).durationSec).toBeCloseTo(3, 0);
  });

  it('cuts a cut title again from the whole file, and gives the whole file back', async () => {
    await useCard();
    resetImport(1);
    const picked = memSource('Eins.mp3', monoMp3());
    await addSources([picked]);
    const id = session.value.albums[0].id;
    await trimTracks(id, new Map([[picked, { startSec: 0, endSec: 6, cuts: [] }]]));
    const once = session.value.albums[0].tracks[0];
    // Longer than the first cut left: only possible from the picked file.
    await trimTracks(id, new Map([[once.source, { startSec: 0, endSec: 10, cuts: [] }]]));
    const twice = session.value.albums[0].tracks[0];
    expect(twice.trimmed?.source).toBe(picked);
    expect(twice.info?.durationSec).toBeCloseTo(10, 0);
    // An edit that leaves the whole title: its own file again.
    await trimTracks(id, new Map([[twice.source, { startSec: 0, endSec: 12.1, cuts: [] }]]));
    expect(session.value.albums[0].tracks[0].source).toBe(picked);
    expect(session.value.albums[0].tracks[0].trimmed).toBeUndefined();
    // „Schnitt zurücknehmen“ does the same.
    await trimTracks(id, new Map([[picked, { startSec: 1, endSec: 11, cuts: [] }]]));
    untrimTrack(id, session.value.albums[0].tracks[0].source);
    expect(session.value.albums[0].tracks[0].source).toBe(picked);
    expect(session.value.albums[0].tracks[0].info?.durationSec).toBeCloseTo(12, 0);
  });

  it('says why a title cannot be cut here', async () => {
    await useCard();
    resetImport(1);
    await addSources([memSource('Eins.mp3', monoMp3())]);
    const a = session.value.albums[0];
    expect(trimPendingProblem(a, a.tracks[0])).toBeNull();
    expect(trimPendingProblem({ ...a, unchanged: true }, a.tracks[0])?.title).toBe('Diesen Titel darf ich nicht verändern');
    expect(trimPendingProblem(a, { ...a.tracks[0], info: { ...a.tracks[0].info, codec: 'flac' } })?.title).toBe('Zuschneiden geht hier nur bei MP3-Dateien');
  });
});
