/**
 * "Lautstärke angleichen" and "Kleiner machen" for a folder on the card
 * (src/features/box/folderSound.ts), with the browser audio backend on fake
 * workers as in tests/add/process.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { albumLoudness, analyzeAudio, buildSmallId3, createBrowserAudioBackend, fileSource, GAIN_STEP_DB, readTags, scanMp3, TARGET_LUFS, type Mp3Index } from '../../src/core/audio';
import { checkNewFile, fileEdges, measureFolder, planLevel, planShrink, runFolderPlan, sameOnCard, shrinkTarget, worthShrinking, type FolderPlan, type Measured } from '../../src/features/box/folderSound';
import { memDir, type MemDir } from '../../src/platform/memory';
import type { AudioAnalysis, Dir } from '../../src/platform/types';
import { fakeWebCodecs } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { monoMp3, SR, stereoMp3 } from '../audio/fixtures';
import { concat, encodeMp3, synth } from '../audio/helpers';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });

/** Real audio work: slow while the whole suite keeps the machine busy. */
const SLOW = { timeout: 60_000 };

const quietTone = (freq: number, amp: number, sec = 3) => encodeMp3([synth(SR, [{ sec, freq, amp }])], SR, 128);

async function folderFiles(dir: Dir): Promise<{ file: string; source: Awaited<ReturnType<Dir['source']>> }[]> {
  const names = (await dir.list()).filter((e) => e.kind === 'file').map((e) => e.name);
  return Promise.all(names.map(async (file) => ({ file, source: await dir.source(file) })));
}

async function measure(dir: Dir, analyze = true): Promise<Measured[]> {
  return measureFolder(await folderFiles(dir), audio, { analyze });
}

async function bytesOf(dir: Dir, file: string): Promise<Uint8Array> {
  return dir.read(file);
}

const analyzeBytes = (bytes: Uint8Array) => analyzeAudio(fileSource(new Blob([bytes as BlobPart]), 'x.mp3'));

/** A measured file with a made-up loudness, for planning alone. */
function fake(file: string, lufs: number, opts: { peak?: number; channels?: 1 | 2; durationSec?: number; audioBytes?: number } = {}): Measured {
  const p = 10 ** ((lufs + 0.691) / 10);
  const analysis: AudioAnalysis = { durationSec: 10, sampleRate: SR, channels: opts.channels ?? 2, windowSec: 0.1, power: new Float32Array(100).fill(p), peak: opts.peak ?? 0.2 };
  const index = { layer: 3, channels: opts.channels ?? 2, durationSec: opts.durationSec ?? 10, audioBytes: opts.audioBytes ?? 160_000, avgBitrateKbps: 128, frameCount: 383, tags: { audioStart: 0 } } as unknown as Mp3Index;
  return { file, source: { name: file, size: index.audioBytes, read: async () => new Uint8Array() }, index, analysis };
}

describe('planLevel', () => {
  it('leaves a folder alone that is within 1 dB of the target', () => {
    const plan = planLevel([fake('001.mp3', TARGET_LUFS - 0.6), fake('002.mp3', TARGET_LUFS - 0.6)], { boostQuietMp3: true, bitrateKbps: 128 });
    expect(plan.already).toBe(true);
    expect(plan.actions.every((a) => a.kind === 'keep')).toBe(true);
  });

  it('gives every MP3 the same steps and leaves other files out', () => {
    const wav: Measured = { file: '003.wav', source: { name: '003.wav', size: 10, read: async () => new Uint8Array() } };
    const plan = planLevel([fake('001.mp3', -22), fake('002.mp3', -22), wav], { boostQuietMp3: false, bitrateKbps: 128 });
    expect(plan.actions).toEqual([
      { kind: 'gain', steps: 4 },
      { kind: 'gain', steps: 4 },
      { kind: 'keep', reason: 'not-mp3' },
    ]);
    expect(plan.gain?.convertDb).toBeCloseTo(4 * GAIN_STEP_DB);
  });

  it('converts a quiet folder whose peaks leave no room only when allowed, at no lower bitrate', () => {
    const files = [fake('001.mp3', -30, { peak: 0.99 })];
    expect(planLevel(files, { boostQuietMp3: false, bitrateKbps: 96 }).actions).toEqual([{ kind: 'keep' }]);
    const plan = planLevel(files, { boostQuietMp3: true, bitrateKbps: 96 });
    expect(plan.gain?.boosted).toBe(true);
    expect(plan.actions).toEqual([{ kind: 'convert', gainDb: 12, bitrateKbps: 128, mono: false }]);
  });
});

describe('planShrink', () => {
  it('converts only files that get much smaller, and levels the rest losslessly to match', () => {
    const big = fake('001.mp3', -22, { audioBytes: 160_000, durationSec: 10 }); // 128 kbit/s stereo
    const small = fake('002.mp3', -22, { audioBytes: 80_000, durationSec: 10 }); // 64 kbit/s
    const target = shrinkTarget('speech', 128);
    expect(worthShrinking(big.index!, target)).toBe(true);
    expect(worthShrinking(small.index!, target)).toBe(false);
    expect(planShrink([big, small], target, { level: false }).actions).toEqual([
      { kind: 'convert', gainDb: 0, mono: true, bitrateKbps: 64 },
      { kind: 'keep', reason: 'small' },
    ]);
    const leveled = planShrink([big, small], target, { level: true });
    expect(leveled.actions[1]).toEqual({ kind: 'gain', steps: 4 });
    expect(leveled.actions[0]).toMatchObject({ kind: 'convert', gainDb: 4 * GAIN_STEP_DB });
  });
});

describe('on the card', SLOW, () => {
  it('levels a quiet folder losslessly: same frames, louder by the same steps', async () => {
    const a = quietTone(440, 0.03);
    const b = quietTone(660, 0.06);
    const dir = memDir({ '001.mp3': a, '002.mp3': b });
    const measured = await measure(dir);
    const plan = planLevel(measured, { boostQuietMp3: true, bitrateKbps: 128 });
    expect(plan.actions.map((x) => x.kind)).toEqual(['gain', 'gain']);
    const steps = (plan.actions[0] as { steps: number }).steps;
    expect(steps).toBeGreaterThan(0);
    const run = await runFolderPlan(dir, measured, plan, { audio, signal: new AbortController().signal });
    expect(run.left).toEqual([]);
    expect(run.written.map((w) => w.file)).toEqual(['001.mp3', '002.mp3']);
    const a2 = await bytesOf(dir, '001.mp3');
    const b2 = await bytesOf(dir, '002.mp3');
    expect(a2.length).toBe(a.length);
    expect((await scanMp3(fileSource(new Blob([a2 as BlobPart]), 'a'))).frameCount).toBe(measured[0].index!.frameCount);
    const [la, lb, la2, lb2] = await Promise.all([a, b, a2, b2].map(analyzeBytes));
    expect(la2.lufs! - la.lufs!).toBeCloseTo(steps * GAIN_STEP_DB, 0);
    // The levels between the tracks stay as they were.
    expect(Math.abs(lb2.lufs! - la2.lufs! - (lb.lufs! - la.lufs!))).toBeLessThan(0.3);
  });

  it('converts a quiet folder with a loud click when allowed, keeping its tags, without clipping', async () => {
    const clicky = encodeMp3([synth(SR, [{ sec: 3, freq: 440, amp: 0.03 }, { sec: 0.05, freq: 1000, amp: 0.98 }])], SR, 128);
    const tagged = concat([buildSmallId3({ title: 'Der alte Titel', album: 'Hörspiel' }), clicky]);
    const dir = memDir({ '001.mp3': tagged });
    const measured = await measure(dir);
    const plan = planLevel(measured, { boostQuietMp3: true, bitrateKbps: 128 });
    expect(plan.actions[0].kind).toBe('convert');
    const run = await runFolderPlan(dir, measured, plan, { audio, signal: new AbortController().signal });
    expect(run.written).toHaveLength(1);
    const after = await bytesOf(dir, '001.mp3');
    const tags = await readTags(fileSource(new Blob([after as BlobPart]), '001.mp3'));
    expect(tags.tags.title).toBe('Der alte Titel');
    const [before, now] = await Promise.all([analyzeBytes(clicky), analyzeBytes(after)]);
    expect(now.lufs! - before.lufs!).toBeGreaterThan(9);
    expect(now.peak!).toBeLessThan(1);
  });

  it('makes a folder quieter for the night: the same steps for every track, at the chosen level', async () => {
    const a = quietTone(440, 0.2);
    const b = quietTone(660, 0.1);
    const dir = memDir({ '001.mp3': a, '002.mp3': b });
    const measured = await measure(dir);
    const plan = planLevel(measured, { boostQuietMp3: true, bitrateKbps: 128, offsetDb: -8 });
    expect(plan.actions.map((x) => x.kind)).toEqual(['gain', 'gain']);
    const steps = (plan.actions[0] as { steps: number }).steps;
    expect(plan.actions[1]).toEqual({ kind: 'gain', steps });
    expect(steps).toBeLessThan(0);
    const run = await runFolderPlan(dir, measured, plan, { audio, signal: new AbortController().signal });
    expect(run.written).toHaveLength(2);
    const [la, lb, la2, lb2] = await Promise.all([a, b, await bytesOf(dir, '001.mp3'), await bytesOf(dir, '002.mp3')].map(analyzeBytes));
    // The folder now sits 8 dB under the others (within half a step), the tracks as far apart as before.
    expect(Math.abs(albumLoudness([la2, lb2]) - (TARGET_LUFS - 8))).toBeLessThan(GAIN_STEP_DB / 2 + 0.3);
    expect(Math.abs(lb2.lufs! - la2.lufs! - (lb.lufs! - la.lufs!))).toBeLessThan(0.3);
    // Matching it again with the offset kept: nothing more to do.
    expect(planLevel(await measure(dir), { boostQuietMp3: true, bitrateKbps: 128, offsetDb: -8 }).already).toBe(true);
  });

  it('makes a folder with a loud click louder through the limiter, never up to full scale', async () => {
    const clicky = encodeMp3([synth(SR, [{ sec: 3, freq: 440, amp: 0.15 }, { sec: 0.05, freq: 1000, amp: 0.98 }])], SR, 128);
    const dir = memDir({ '001.mp3': clicky });
    const measured = await measure(dir);
    const plan = planLevel(measured, { boostQuietMp3: true, bitrateKbps: 128, offsetDb: 6 });
    // No room for a single lossless step under the ceiling: converted, with the limiter.
    expect(plan.actions[0].kind).toBe('convert');
    const run = await runFolderPlan(dir, measured, plan, { audio, signal: new AbortController().signal });
    expect(run.written).toHaveLength(1);
    const [before, now] = await Promise.all([analyzeBytes(clicky), analyzeBytes(await bytesOf(dir, '001.mp3'))]);
    expect(now.lufs! - before.lufs!).toBeGreaterThan(5);
    // The limiter holds -1.5 dBTP; the MP3 coding itself may add a few tenths.
    expect(20 * Math.log10(now.peak!)).toBeLessThan(-1);
  });

  it('makes a folder smaller in mono and keeps the words of the tags', async () => {
    const stereo = concat([buildSmallId3({ title: 'Kapitel 1' }), stereoMp3()]);
    const dir = memDir({ '001.mp3': stereo, '002.mp3': monoMp3() });
    const measured = await measure(dir, false);
    const plan = planShrink(measured, shrinkTarget('speech', 128), { level: false });
    expect(plan.actions.map((x) => x.kind)).toEqual(['convert', 'keep']);
    expect(plan.bytesAfter).toBeLessThan(plan.bytesBefore);
    const run = await runFolderPlan(dir, measured, plan, { audio, signal: new AbortController().signal });
    expect(run.written).toHaveLength(1);
    const after = await bytesOf(dir, '001.mp3');
    expect(after.length).toBeLessThan(stereo.length * 0.7);
    const source = fileSource(new Blob([after as BlobPart]), '001.mp3');
    expect((await scanMp3(source)).channels).toBe(1);
    expect((await readTags(source)).tags.title).toBe('Kapitel 1');
    expect(await bytesOf(dir, '002.mp3')).toEqual(monoMp3());
  });

  it('does not let a new file in that is shorter or built otherwise', async () => {
    const dir = memDir({ '001.mp3': stereoMp3() });
    const [m] = await measure(dir, false);
    const half = new Blob([stereoMp3().slice(0, Math.floor(stereoMp3().length / 2)) as BlobPart]);
    expect(await checkNewFile(m, { kind: 'convert', gainDb: 0, bitrateKbps: 64, mono: true }, half)).toEqual({ ok: false, reason: 'Die neue Datei ist anders lang als die alte.' });
    expect(await checkNewFile(m, { kind: 'gain', steps: 2 }, half)).toEqual({ ok: false, reason: 'Die neue Datei ist anders aufgebaut als die alte.' });
    expect(await checkNewFile(m, { kind: 'gain', steps: 2 }, new Blob([new Uint8Array(500) as BlobPart]))).toEqual({ ok: false, reason: 'Die neue Datei ließ sich nicht lesen.' });
  });

  it('compares with the edges of the new file read before writing (its tags may be slices of the old one)', async () => {
    const dir = memDir({ '001.mp3': quietTone(440, 0.03) });
    const blob = new Blob([quietTone(660, 0.03) as BlobPart]);
    const edges = await fileEdges(blob);
    expect(edges.size).toBe(blob.size);
    expect(edges.parts.map((p) => p.start)).toEqual([0, blob.size - Math.min(64 * 1024, blob.size)].filter((x, i, a) => a.indexOf(x) === i));
    expect(await sameOnCard(dir, '001.mp3', edges)).toBe(false);
    await dir.write('001.mp3', blob);
    expect(await sameOnCard(dir, '001.mp3', edges)).toBe(true);
    // runFolderPlan takes them before it writes: Chrome cannot read a slice of a file written over.
    const src = (await import('node:fs')).readFileSync(new URL('../../src/features/box/folderSound.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const edges = await fileEdges\(blob\);\s*await dir\.write\(m\.file, blob\);\s*if \(!\(await sameOnCard\(dir, m\.file, edges\)\)\)/);
  });

  it('stops when a written file does not read back the same', async () => {
    const dir: MemDir = memDir({ '001.mp3': quietTone(440, 0.03), '002.mp3': quietTone(440, 0.03) });
    const measured = await measure(dir);
    const plan: FolderPlan = planLevel(measured, { boostQuietMp3: false, bitrateKbps: 128 });
    // A card that loses the last byte of every file.
    const write = dir.write.bind(dir);
    dir.write = async (name, data) => write(name, data instanceof Blob ? data.slice(0, data.size - 1) : data.slice(0, -1));
    const into = { written: [], left: [] };
    await expect(runFolderPlan(dir, measured, plan, { audio, signal: new AbortController().signal, into })).rejects.toThrow(/nicht richtig auf der SD-Karte/);
    expect(into.written).toEqual([]);
    expect(await sameOnCard(dir, '002.mp3', new Blob([quietTone(440, 0.03) as BlobPart]))).toBe(true); // the second one was never touched
  });
});
