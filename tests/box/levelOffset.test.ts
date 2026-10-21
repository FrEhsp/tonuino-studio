/**
 * A folder made quieter or louder on purpose ("Leiser für die Nacht"): the
 * gain math (offset, steps, the limiter's ceiling), how the catalog keeps
 * the offset, the words for it, and how the dialog, the folder page, the
 * shelf and the add flow are wired to it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { VNode } from 'preact';
import { describe, expect, it } from 'vitest';
import { GAIN_STEP_DB, LIMITER_CEILING_DB, levelTarget, PeakLimiter, planAlbumGain, TARGET_LUFS, type Mp3Index } from '../../src/core/audio';
import { cleanLevelOffset, LEVEL_OFFSET_MAX_DB, LEVEL_OFFSET_MIN_DB, newCatalog, parseCatalog, serializeCatalog } from '../../src/core/tonuino/catalog';
import { buildBoxMemory, memoryCatalog } from '../../src/core/tonuino/remember';
import { scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import { planLevel, planShrink, shrinkTarget, type FolderPlan, type Measured } from '../../src/features/box/folderSound';
import { LevelPick } from '../../src/features/box/LevelPick';
import { formatOffset, LEVEL_CHOICES, levelChoiceOf, levelNote, levelOffsetOf } from '../../src/features/box/levelOffset';
import type { AudioAnalysis } from '../../src/platform/types';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** A measured file with a made-up loudness and peak, for planning alone. */
function fake(file: string, lufs: number, peak = 0.2): Measured {
  const p = 10 ** ((lufs + 0.691) / 10);
  const analysis: AudioAnalysis = { durationSec: 10, sampleRate: 44100, channels: 2, windowSec: 0.1, power: new Float32Array(100).fill(p), peak };
  const index = { layer: 3, channels: 2, durationSec: 10, audioBytes: 160_000, avgBitrateKbps: 128, frameCount: 383, tags: { audioStart: 0 } } as unknown as Mp3Index;
  return { file, source: { name: file, size: index.audioBytes, read: async () => new Uint8Array() }, index, analysis };
}

const opts = (offsetDb: number, boostQuietMp3 = true) => ({ boostQuietMp3, bitrateKbps: 128, offsetDb });
const dbOf = (x: number) => 20 * Math.log10(x);

/** The loudest sample of each file after the plan's lossless steps, in dBFS. */
function peaksAfter(files: Measured[], plan: FolderPlan): number[] {
  return files.map((m, i) => {
    const a = plan.actions[i];
    return dbOf(m.analysis!.peak!) + (a.kind === 'gain' ? a.steps * GAIN_STEP_DB : 0);
  });
}

describe('the level a folder is brought to', () => {
  it('is the level of the others without an offset, with the old room up to full scale', () => {
    expect(levelTarget()).toEqual({ targetLufs: TARGET_LUFS, ceilingDb: 0 });
    expect(levelTarget(0)).toEqual({ targetLufs: TARGET_LUFS, ceilingDb: 0 });
  });

  it('moves by the offset, and keeps the limiter’s room for lossless steps', () => {
    expect(levelTarget(-8)).toEqual({ targetLufs: TARGET_LUFS - 8, ceilingDb: LIMITER_CEILING_DB });
    expect(levelTarget(4)).toEqual({ targetLufs: TARGET_LUFS + 4, ceilingDb: LIMITER_CEILING_DB });
    expect(LIMITER_CEILING_DB).toBe(-1.5);
  });

  it('planAlbumGain aims at the target given and stops lossless steps at the ceiling', () => {
    // 0.5 is -6 dBFS: up to -1.5 dBFS leaves 4.5 dB, three steps; full scale would allow four.
    expect(planAlbumGain({ lufs: TARGET_LUFS, mp3Peaks: [0.5], targetLufs: TARGET_LUFS + 6 }).steps).toBe(4);
    const g = planAlbumGain({ lufs: TARGET_LUFS, mp3Peaks: [0.5], targetLufs: TARGET_LUFS + 6, ceilingDb: LIMITER_CEILING_DB });
    expect(g.steps).toBe(3);
    expect(g.quietDb).toBeCloseTo(6 - 3 * GAIN_STEP_DB);
  });

  it('a converted file made as loud as allowed stays under -1.5 dBTP, also between the samples', () => {
    // A quarter of the sample rate at 45 degrees: the wave peaks √2 above its samples. Loud music (0.98), 6 dB louder.
    const gain = 10 ** (LEVEL_OFFSET_MAX_DB / 20);
    const x = Float32Array.from({ length: 22050 }, (_, i) => 0.98 * gain * Math.sin((Math.PI / 2) * i + Math.PI / 4));
    const lim = new PeakLimiter(44100, 1);
    const y = [...lim.process([x])[0], ...lim.flush()[0]];
    const truePeak = Math.max(...y.slice(2000).map(Math.abs)) * Math.SQRT2;
    expect(20 * Math.log10(truePeak)).toBeLessThan(LIMITER_CEILING_DB + 0.1);
  });
});

describe('planLevel with an offset', () => {
  it('makes a folder that matches the others quieter by whole steps, every track the same', () => {
    const files = [fake('001.mp3', TARGET_LUFS), fake('002.mp3', TARGET_LUFS, 0.6)];
    const plan = planLevel(files, opts(-8));
    expect(plan.offsetDb).toBe(-8);
    // MP3 steps are 1.5 dB: 8 dB quieter is five of them.
    expect(plan.actions).toEqual([
      { kind: 'gain', steps: -5 },
      { kind: 'gain', steps: -5 },
    ]);
    expect(plan.gain?.convertDb).toBeCloseTo(-5 * GAIN_STEP_DB);
  });

  it('keeps the levels between the tracks for every quieter offset', () => {
    const files = [fake('001.mp3', -14, 0.9), fake('002.mp3', -20, 0.3), fake('003.mp3', -17, 0.5)];
    for (let offset = LEVEL_OFFSET_MIN_DB; offset < 0; offset += 0.5) {
      const plan = planLevel(files, opts(offset));
      if (plan.already) continue;
      const steps = new Set(plan.actions.map((a) => (a.kind === 'gain' ? a.steps : 0)));
      expect(steps.size, `offset ${offset}`).toBe(1);
      // Quieter only ever loses level (the folder starts near the others).
      expect([...steps][0], `offset ${offset}`).toBeLessThanOrEqual(0);
    }
  });

  it('never lifts a peak above the limiter’s ceiling, for any offset and any peak', () => {
    for (let offset = LEVEL_OFFSET_MIN_DB; offset <= LEVEL_OFFSET_MAX_DB; offset += 0.5) {
      if (!offset) continue;
      for (const lufs of [-30, -24, -20, -16, -12]) {
        for (const peak of [0.05, 0.2, 0.5, 0.8, 0.84, 0.9, 0.99]) {
          const files = [fake('001.mp3', lufs, peak), fake('002.mp3', lufs - 3, peak / 2)];
          for (const boost of [false, true]) {
            const plan = planLevel(files, opts(offset, boost));
            const lossless = plan.actions.every((a) => a.kind !== 'convert');
            // Lossless steps have no limiter: they stop under its ceiling (or keep a peak that was higher already).
            if (lossless) for (const [i, p] of peaksAfter(files, plan).entries()) expect(p, `offset ${offset}, ${lufs} LUFS, peak ${peak}`).toBeLessThanOrEqual(Math.max(LIMITER_CEILING_DB, dbOf(files[i].analysis!.peak!)) + 1e-9);
            // Louder past that: converted, through the limiter (-1.5 dBTP), never with steps.
            else expect(plan.actions.every((a) => a.kind === 'convert')).toBe(true);
          }
        }
      }
    }
  });

  it('converts a folder made louder when its peaks leave no room, only when allowed', () => {
    const files = [fake('001.mp3', TARGET_LUFS, 0.9)];
    expect(planLevel(files, opts(6, false)).actions).toEqual([{ kind: 'keep' }]);
    const plan = planLevel(files, opts(6, true));
    expect(plan.gain?.boosted).toBe(true);
    expect(plan.actions).toEqual([{ kind: 'convert', gainDb: expect.closeTo(6, 3), bitrateKbps: 128, mono: false }]);
  });

  it('has nothing to do when the folder has the chosen level already', () => {
    const plan = planLevel([fake('001.mp3', TARGET_LUFS - 8.4)], opts(-8));
    expect(plan.already).toBe(true);
    expect(plan.actions).toEqual([{ kind: 'keep' }]);
    // The same folder, back to the others: 8 dB up, in whole steps.
    expect(planLevel([fake('001.mp3', TARGET_LUFS - 8.4)], opts(0)).actions).toEqual([{ kind: 'gain', steps: 6 }]);
  });

  it('is kept by "Kleiner machen" with the loudness on the way', () => {
    const big = fake('001.mp3', TARGET_LUFS);
    const plan = planShrink([big], shrinkTarget('speech', 128), { level: true, offsetDb: -8 });
    expect(plan.offsetDb).toBe(-8);
    // Every file is converted: no steps to match, the converter takes the whole change.
    expect(plan.actions[0]).toMatchObject({ kind: 'convert', gainDb: expect.closeTo(-8, 3) });
    // Without the loudness the offset plays no part.
    expect(planShrink([big], shrinkTarget('speech', 128), { level: false, offsetDb: -8 }).offsetDb).toBe(0);
  });
});

describe('the catalog keeps the offset', () => {
  it('survives saving and reading, also on the remembered box', async () => {
    const c = newCatalog('Box');
    c.folders['01'] = { title: 'Schlaflieder', tracks: [], levelOffsetDb: -8, addedAt: 1, updatedAt: 1 };
    c.folders['02'] = { title: 'Disco', tracks: [], levelOffsetDb: 3, addedAt: 1, updatedAt: 1 };
    const back = parseCatalog(serializeCatalog(c))!;
    expect(back.folders['01'].levelOffsetDb).toBe(-8);
    expect(back.folders['02'].levelOffsetDb).toBe(3);
    const scan = await scanSd(memDir({ '01': { '001.mp3': new Uint8Array(100) } }));
    expect(memoryCatalog(buildBoxMemory(scan, c, { label: 'TONUINO', at: 1 }))!.folders['01'].levelOffsetDb).toBe(-8);
  });

  it('keeps it within the range, in half dB, and drops 0 and nonsense', () => {
    expect(cleanLevelOffset(-40)).toBe(LEVEL_OFFSET_MIN_DB);
    expect(cleanLevelOffset(9)).toBe(LEVEL_OFFSET_MAX_DB);
    expect(cleanLevelOffset(-3.3)).toBe(-3.5);
    expect(cleanLevelOffset(0)).toBeUndefined();
    expect(cleanLevelOffset(0.1)).toBeUndefined();
    expect(cleanLevelOffset('-8')).toBeUndefined();
    expect(cleanLevelOffset(Number.NaN)).toBeUndefined();
    const raw = { app: 'tonuino-studio', folders: { '03': { title: 'x', tracks: [], levelOffsetDb: 'laut' }, '04': { title: 'y', tracks: [], levelOffsetDb: -100 } } };
    const parsed = parseCatalog(JSON.stringify(raw))!;
    expect(parsed.folders['03'].levelOffsetDb).toBeUndefined();
    expect(parsed.folders['04'].levelOffsetDb).toBe(-12);
  });
});

describe('the words for it', () => {
  it('has four plain choices without dB, from the night to a little louder', () => {
    expect(LEVEL_CHOICES.map((c) => c.label)).toEqual(['Leiser für die Nacht', 'Etwas leiser', 'Wie die anderen', 'Etwas lauter']);
    for (const c of LEVEL_CHOICES) {
      expect(c.label).not.toMatch(/dB/);
      expect(c.db).toBeGreaterThanOrEqual(LEVEL_OFFSET_MIN_DB);
      expect(c.db).toBeLessThanOrEqual(LEVEL_OFFSET_MAX_DB);
      expect(levelChoiceOf(c.db)).toBe(c.id);
    }
    expect(levelChoiceOf(-6)).toBeUndefined();
  });

  it('notes a folder made quieter or louder, and nothing for one like the others', () => {
    expect(levelNote(-8)).toBe('leiser gestellt');
    expect(levelNote(2)).toBe('lauter gestellt');
    expect(levelNote(0)).toBeUndefined();
    expect(levelOffsetOf(undefined)).toBe(0);
    expect(levelOffsetOf({ levelOffsetDb: -4 })).toBe(-4);
    expect(formatOffset(-8)).toBe('−8 dB');
    expect(formatOffset(3)).toBe('+3 dB');
    expect(formatOffset(-2.5)).toBe('−2,5 dB');
    expect(formatOffset(0)).toBe('0 dB');
  });
});

/** Every element of a rendered tree, with its props (function components are called). */
function walk(node: unknown, out: VNode<Record<string, unknown>>[] = []): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const v = node as VNode<Record<string, unknown>>;
  if (typeof v.type === 'function') return walk((v.type as (p: unknown) => unknown)(v.props), out);
  out.push(v);
  walk(v.props?.children, out);
  return out;
}

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  const v = node as VNode<{ children?: unknown }>;
  if (typeof v.type === 'function') return textOf((v.type as (p: unknown) => unknown)(v.props));
  return textOf(v.props?.children);
};

describe('the choice in the sound dialog', () => {
  it('offers the four words as buttons and the slider from -12 to +6 with its dB beside it', () => {
    const picked: number[] = [];
    const tree = LevelPick({ value: -8, onChange: (db) => picked.push(db) });
    const all = walk(tree);
    const buttons = all.filter((n) => n.type === 'button');
    expect(buttons.map((b) => textOf(b))).toEqual(LEVEL_CHOICES.map((c) => c.label));
    expect(buttons.map((b) => b.props['aria-pressed'])).toEqual([true, false, false, false]);
    (buttons[3].props.onClick as () => void)();
    const slider = all.find((n) => n.type === 'input')!;
    expect(slider.props).toMatchObject({ type: 'range', min: -12, max: 6, step: 1, value: -8, 'aria-valuetext': '−8 dB' });
    (slider.props.onInput as (e: unknown) => void)({ currentTarget: { value: '-5' } });
    expect(picked).toEqual([3, -5]);
    expect(textOf(tree)).toMatch(/Genauer.*−8 dB/);
  });

  it('chooses none of the words for a value of the slider between them', () => {
    const buttons = walk(LevelPick({ value: -6, onChange: () => undefined })).filter((n) => n.type === 'button');
    expect(buttons.every((b) => b.props['aria-pressed'] === false)).toBe(true);
  });

  it('plans with the chosen offset, keeps it after the run, and starts from what the folder had', () => {
    const src = read('src/features/box/SoundDialog.tsx');
    expect(src).toMatch(/const saved = levelOffsetOf\(card\.value\?\.catalog\?\.folders\[folderName\(folder\)\]\);/);
    expect(src).toMatch(/useState\(saved\)/);
    expect(src).toMatch(/helpers\.planLevel\(measured, \{[^}]*offsetDb: offset \}\)/);
    expect(src).toMatch(/await keepOffset\(plan\.offsetDb\)/);
    expect(src).toMatch(/e\.levelOffsetDb = cleanLevelOffset\(db\)/);
    expect(src).toMatch(/planShrink\([^;]*offsetDb: saved \}\)/);
    expect(src).toMatch(/<LevelPick value=\{offset\} onChange=\{setOffset\} \/>/);
  });
});

describe('where the offset shows and lasts', () => {
  it('shows "leiser gestellt" on the folder page, opening the dialog', () => {
    const src = read('src/features/box/FolderPage.tsx');
    expect(src).toMatch(/const offset = levelOffsetOf\(entry\);/);
    expect(src).toMatch(/onClick=\{\(\) => setSoundAsk\('level'\)\}>\s*\{levelNote\(offset\)\}/);
    expect(src).toMatch(/label: 'Lautstärke anpassen …'/);
  });

  it('shows it on the shelf list and tooltip, not on the sticker card', () => {
    const src = read('src/features/box/ShelfViews.tsx');
    expect(src).toMatch(/level \? levelNote\(levelOffsetOf\(item\.entry\)\) : null/);
    expect(src).toMatch(/folderFacts\(item, true, false\)/);
  });

  it('gives tracks added to such a folder its level, and a new album the level of the others', () => {
    const src = read('src/features/add/session.ts');
    expect(src).toMatch(/levelOffsetDb: a\.append \? card\.value\?\.catalog\?\.folders\[name\]\?\.levelOffsetDb : undefined/);
    expect(src).toMatch(/delete entry\.levelOffsetDb;/);
    expect(read('src/features/add/process.ts')).toMatch(/\.\.\.levelTarget\(ctx\.opts\.levelOffsetDb\)/);
  });
});
