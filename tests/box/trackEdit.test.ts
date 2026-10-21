import { describe, expect, it } from 'vitest';
import { parseId3v2 } from '../../src/core/audio/id3';
import { loadMp3Encoder, Mp3StreamEncoder } from '../../src/core/audio/mp3encoder';
import { scanMp3 } from '../../src/core/audio/mp3frames';
import { mergeMp3Files } from '../../src/core/audio/mp3join';
import { planTrim, trimMp3 } from '../../src/core/audio/mp3trim';
import { bufferSource } from '../../src/core/audio/source';
import type { CatalogFolder } from '../../src/core/tonuino/catalog';
import { executePlan, planReorder } from '../../src/core/tonuino/repair';
import { scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import type { AudioBackend } from '../../src/platform/types';
import { noteRewritten, parseSeconds, planJoin } from '../../src/features/box/trackEdit';
import { SR } from '../audio/fixtures';
import { concat, synth } from '../audio/helpers';

await loadMp3Encoder();

const rows = (...files: string[]) => files.map((file) => ({ file }));

function chapter(sec: number, freq: number): Uint8Array {
  const enc = new Mp3StreamEncoder({ inputChannels: 1, sampleRate: SR, bitrateKbps: 64 });
  enc.push({ channels: [synth(SR, [{ sec, freq }])], sampleRate: SR });
  const frames = [...enc.takeOutput(), ...enc.finish()];
  return concat([enc.infoFrame(), ...frames]);
}

const noBackend: AudioBackend = { analyze: () => Promise.reject(new Error('not used')), openPcm: () => Promise.reject(new Error('not used')) };

describe('planJoin', () => {
  it('joins in the order of the list, keeps the first and closes the gap', () => {
    const p = planJoin(rows('001.mp3', '002.mp3', '003.mp3', '004.mp3', '005.mp3'), new Set(['004.mp3', '002.mp3', '003.mp3']));
    expect(p.files).toEqual(['002.mp3', '003.mp3', '004.mp3']);
    expect(p.first).toBe('002.mp3');
    expect(p.removed).toEqual(['003.mp3', '004.mp3']);
    expect(p.order).toEqual(['001.mp3', '002.mp3', '005.mp3']);
    expect(p.problem).toBeUndefined();
  });

  it('takes tracks that are apart, and says what is missing', () => {
    const p = planJoin(rows('001.mp3', '002.mp3', '003.mp3'), new Set(['001.mp3', '003.mp3']));
    expect(p.order).toEqual(['001.mp3', '002.mp3']);
    expect(planJoin(rows('001.mp3', '002.mp3'), new Set(['001.mp3'])).problem).toMatch(/mindestens zwei/);
    expect(planJoin(rows('001.wav', '002.mp3'), new Set(['001.wav', '002.mp3'])).problem).toMatch(/keine MP3/);
  });
});

describe('noteRewritten', () => {
  const entry = (): CatalogFolder => ({
    title: 'Hörspiel',
    tracks: [
      { file: '001.mp3', title: 'Kapitel 1', size: 100, durationSec: 60, titleAuto: true },
      { file: '002.mp3', title: 'Kapitel 2', size: 200, durationSec: 70 },
    ],
    fingerprint: '2:300',
    addedAt: 0,
    updatedAt: 0,
  });

  it('notes size, exact length and a new title, and the new fingerprint', () => {
    const e = entry();
    noteRewritten(e, [{ file: '001.mp3', oldSize: 100, size: 250, durationSec: 130.5, title: ' Folge 1 ' }], { before: '2:300', after: '2:450' });
    expect(e.tracks[0]).toEqual({ file: '001.mp3', title: 'Folge 1', size: 250, durationSec: 130.5, durationExact: true });
    expect(e.tracks[1].size).toBe(200);
    expect(e.fingerprint).toBe('2:450');
  });

  it('leaves a folder changed elsewhere marked, and keeps a title when none is given', () => {
    const e = entry();
    e.fingerprint = '5:999';
    noteRewritten(e, [{ file: '002.mp3', oldSize: 200, size: 150, durationSec: 40 }], { before: '2:300', after: '2:250' });
    expect(e.fingerprint).toBe('5:999');
    expect(e.tracks[1]).toMatchObject({ title: 'Kapitel 2', size: 150, durationSec: 40 });
    // A file the catalog did not know yet is added.
    noteRewritten(e, [{ file: '003.mp3', oldSize: 1, size: 2 }]);
    expect(e.tracks[2]).toEqual({ file: '003.mp3', size: 2 });
  });
});

describe('parseSeconds', () => {
  it('reads seconds as people type them', () => {
    expect(parseSeconds('')).toBe(0);
    expect(parseSeconds('12')).toBe(12);
    expect(parseSeconds(' 2,5 ')).toBe(2.5);
    expect(parseSeconds('1:30')).toBe(90);
    expect(parseSeconds('0:07,5')).toBe(7.5);
    expect(parseSeconds('abc')).toBeNaN();
    expect(parseSeconds('-3')).toBeNaN();
    expect(parseSeconds('1:75')).toBeNaN();
  });
});

describe('joining on the card', { timeout: 30_000 }, () => {
  it('puts the joined file in place of the first and closes the gap through the reorder', async () => {
    const files = { '001.mp3': chapter(1, 300), '002.mp3': chapter(1, 400), '003.mp3': chapter(1, 500), '004.mp3': chapter(1, 600) };
    const root = memDir({ '01': { ...files } });
    const dir = await root.dir('01');
    const plan = planJoin(rows('001.mp3', '002.mp3', '003.mp3', '004.mp3'), new Set(['002.mp3', '003.mp3']));
    const merged = await mergeMp3Files(noBackend, await Promise.all(plan.files.map((f) => dir.source(f))), { tags: { title: 'Folge 2' } });
    expect(merged.lossless).toBe(true);
    await dir.write(plan.first, merged.blob);
    const scan = await scanSd(root);
    const reorder = planReorder(scan.folders[0], plan.order, { pureNumbers: true, tempDirs: scan.tempDirs });
    expect(reorder.leftovers).toEqual([]);
    expect((await executePlan(root, reorder)).error).toBeUndefined();
    const after = (await scanSd(root)).folders[0];
    expect(after.tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    const d = await root.dir('01');
    expect(await d.read('001.mp3')).toEqual(files['001.mp3']);
    expect(await d.read('003.mp3')).toEqual(files['004.mp3']);
    const joined = await d.read('002.mp3');
    expect(parseId3v2(joined)?.tags.title).toBe('Folge 2');
    const [a, b, j] = await Promise.all([files['002.mp3'], files['003.mp3'], joined].map((x) => scanMp3(bufferSource(x))));
    expect(j.frameCount).toBe(a.frameCount + b.frameCount);
    expect(j.xing?.frames).toBe(j.frameCount);
  });

  it('cuts every track of a folder the same way', async () => {
    const root = memDir({ '01': { '001.mp3': chapter(4, 300), '002.mp3': chapter(5, 400) } });
    const dir = await root.dir('01');
    for (const f of ['001.mp3', '002.mp3']) {
      const src = await dir.source(f);
      const idx = await scanMp3(src);
      const p = planTrim(idx, 1.5, 0.5)!;
      await dir.write(f, await trimMp3(src, idx, 1.5, 0.5));
      const now = await scanMp3(await dir.source(f));
      expect(now.frameCount).toBe(p.endFrame - p.startFrame);
    }
    const lengths = await Promise.all(['001.mp3', '002.mp3'].map(async (f) => (await scanMp3(await dir.source(f))).durationSec));
    expect(lengths[0]).toBeCloseTo(2, 1);
    expect(lengths[1]).toBeCloseTo(3, 1);
  });
});
