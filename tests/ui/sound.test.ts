import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { SdScan, SdSystemDir, SdTrack } from '../../src/core/tonuino/sd';
import { DEFAULT_SETTINGS } from '../../src/app/state';
import { BOX_SOUND_MAX_BYTES, CUE_GAP_MS, MIN_GAP_MS, createCue, createDoneSound, findBoxSound, playCue, playDoneSound, type CueDeps, type DoneSoundDeps, type FilePlay } from '../../src/ui/sound';

function track(name: string, size = 6000): SdTrack {
  const number = Number(name.slice(0, 4));
  return { number, name, size, suffix: '', ext: name.endsWith('.wav') ? 'wav' : 'mp3', order: 0 };
}

function scanWith(advert?: Partial<SdSystemDir>): SdScan {
  return {
    system: advert ? { advert: { name: 'advert', dirName: 'advert', files: [], wrongDigits: [], others: [], junk: [], empty: [], totalBytes: 0, ...advert } } : {},
  } as unknown as SdScan;
}

function fakes(over: Partial<DoneSoundDeps> = {}) {
  let time = 100_000;
  const deps = {
    enabled: vi.fn(() => true),
    canPlay: vi.fn(() => true),
    boxSound: vi.fn(async (): Promise<Blob | null> => null),
    playFile: vi.fn(async (): Promise<FilePlay> => 'played'),
    playChime: vi.fn(async () => undefined),
    now: vi.fn(() => time),
    ...over,
  };
  return { deps, play: createDoneSound(deps), later: (ms: number) => (time += ms) };
}

const pling = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], { type: 'audio/mpeg' });

describe('findBoxSound', () => {
  it('finds 0262.mp3 in advert, also under another spelling of the folder', () => {
    expect(findBoxSound(scanWith({ files: [track('0001.mp3'), track('0262.mp3', 5200)] }))).toEqual({ dir: 'advert', file: '0262.mp3', size: 5200 });
    expect(findBoxSound(scanWith({ dirName: 'ADVERT', files: [track('0262_pling.mp3')] }))).toEqual({ dir: 'ADVERT', file: '0262_pling.mp3', size: 6000 });
  });

  it('nothing without the file, for an empty or a big file, and without a card', () => {
    expect(findBoxSound(undefined)).toBeNull();
    expect(findBoxSound(scanWith())).toBeNull();
    expect(findBoxSound(scanWith({ files: [track('0261.mp3'), track('0263.mp3')] }))).toBeNull();
    expect(findBoxSound(scanWith({ files: [track('0262.wav')] }))).toBeNull();
    expect(findBoxSound(scanWith({ files: [track('0262.mp3', 0)] }))).toBeNull();
    expect(findBoxSound(scanWith({ files: [track('0262.mp3', BOX_SOUND_MAX_BYTES + 1)] }))).toBeNull();
  });
});

describe('createDoneSound', () => {
  it('plays the box sound from the card when there is one', async () => {
    const { deps, play } = fakes({ boxSound: vi.fn(async () => pling) });
    await play('songs');
    expect(deps.playFile).toHaveBeenCalledWith(pling);
    expect(deps.playChime).not.toHaveBeenCalled();
  });

  it('plays the chime without a box sound, or when the file cannot be played here', async () => {
    const none = fakes();
    await none.play('songs');
    expect(none.deps.playFile).not.toHaveBeenCalled();
    expect(none.deps.playChime).toHaveBeenCalledTimes(1);

    const odd = fakes({ boxSound: vi.fn(async () => pling), playFile: vi.fn(async (): Promise<FilePlay> => 'unsupported') });
    await odd.play('songs');
    expect(odd.deps.playChime).toHaveBeenCalledTimes(1);

    const broken = fakes({ boxSound: vi.fn(async () => Promise.reject(new Error('card gone'))) });
    await broken.play('songs');
    expect(broken.deps.playChime).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the browser blocks sound', async () => {
    const { deps, play } = fakes({ boxSound: vi.fn(async () => pling), playFile: vi.fn(async (): Promise<FilePlay> => 'blocked') });
    await play('songs');
    expect(deps.playChime).not.toHaveBeenCalled();
  });

  it('respects the switch and does not touch the card when it is off', async () => {
    const { deps, play } = fakes({ enabled: vi.fn(() => false) });
    await play('songs');
    expect(deps.boxSound).not.toHaveBeenCalled();
    expect(deps.playFile).not.toHaveBeenCalled();
    expect(deps.playChime).not.toHaveBeenCalled();
  });

  it('does nothing where there is no audio', async () => {
    const { deps, play } = fakes({ canPlay: vi.fn(() => false) });
    await play('songs');
    expect(deps.boxSound).not.toHaveBeenCalled();
    expect(deps.playChime).not.toHaveBeenCalled();
  });

  it('never twice in quick succession', async () => {
    const { deps, play, later } = fakes();
    await play('songs');
    await play('songs');
    later(MIN_GAP_MS - 1);
    await play('songs');
    expect(deps.playChime).toHaveBeenCalledTimes(1);
    later(1);
    await play('songs');
    expect(deps.playChime).toHaveBeenCalledTimes(2);
  });

  it('a call while switched off does not hold back the next one', async () => {
    let on = false;
    const { deps, play } = fakes({ enabled: vi.fn(() => on) });
    await play('songs');
    on = true;
    await play('songs');
    expect(deps.playChime).toHaveBeenCalledTimes(1);
  });

  it('stays quiet in the Paket mode until the Paket is checked on the card', async () => {
    const { deps, play, later } = fakes({ packageMode: vi.fn(() => true) });
    for (const occasion of ['songs', 'sounds', 'rebuild', 'copy'] as const) {
      await play(occasion);
      later(MIN_GAP_MS);
    }
    expect(deps.playChime).not.toHaveBeenCalled();
    expect(deps.boxSound).not.toHaveBeenCalled();
    await play('package');
    expect(deps.playChime).toHaveBeenCalledTimes(1);
  });

  it('a Paket-mode call does not hold back the "Pling" of the checked Paket', async () => {
    const { deps, play } = fakes({ packageMode: vi.fn(() => true) });
    await play('songs');
    await play('package');
    expect(deps.playChime).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    const { play } = fakes({ playChime: vi.fn(async () => Promise.reject(new Error('no audio'))), now: vi.fn(() => Number.NaN) });
    await expect(play('songs')).resolves.toBeUndefined();
    const sync = fakes({
      enabled: () => {
        throw new Error('boom');
      },
    });
    await expect(sync.play('songs')).resolves.toBeUndefined();
  });
});

describe('createCue', () => {
  function cues(over: Partial<CueDeps> = {}) {
    let time = 50_000;
    const knock = vi.fn((_at: number, _pitch: number) => undefined);
    const deps = {
      enabled: vi.fn(() => true),
      canPlay: vi.fn(() => true),
      knock,
      now: vi.fn(() => time),
      ...over,
    };
    return { deps, knock, play: createCue(deps), later: (ms: number) => (time += ms) };
  }

  it('one knock for a written card, two upwards for the finished test', async () => {
    const { knock, play } = cues();
    await play('cardWritten');
    expect(knock).toHaveBeenCalledTimes(1);
    await play('testDone');
    expect(knock).toHaveBeenCalledTimes(3);
    const [, second, third] = knock.mock.calls;
    expect(third[0]).toBeGreaterThan(second[0]);
    expect(third[1]).toBeGreaterThan(second[1]);
  });

  it('cards one after the other each get their Klack, but not twice at once', async () => {
    const { deps, play, later } = cues();
    await play('cardWritten');
    await play('cardWritten');
    expect(deps.knock).toHaveBeenCalledTimes(1);
    later(CUE_GAP_MS.cardWritten);
    await play('cardWritten');
    expect(deps.knock).toHaveBeenCalledTimes(2);
    expect(CUE_GAP_MS.cardWritten).toBeLessThan(MIN_GAP_MS);
  });

  it('follows the switch "Töne" and never throws', async () => {
    const off = cues({ enabled: vi.fn(() => false) });
    await off.play('cardWritten');
    expect(off.deps.knock).not.toHaveBeenCalled();
    const broken = cues({
      knock: vi.fn(() => {
        throw new Error('no audio');
      }),
    });
    await expect(broken.play('testDone')).resolves.toBeUndefined();
    await expect(playCue('cardWritten')).resolves.toBeUndefined();
  });
});

describe('the app', () => {
  it('has the switch on from the start', () => {
    expect(DEFAULT_SETTINGS.doneSound).toBe(true);
  });

  it('plays nothing in Node, without failing', async () => {
    await expect(playDoneSound('songs')).resolves.toBeUndefined();
  });

  it('brings no sound file of its own along', () => {
    const src = readFileSync(new URL('../../src/ui/sound.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/import [^;]*\.(mp3|wav|ogg)['"]/);
    expect(src).not.toMatch(/https?:\/\//);
  });

  it('plays for big completions only, from the places that finish them', () => {
    // Where the "Pling" may come from. Repairs, single cards, renaming and saving stay quiet:
    // heard after every small fix it got on the nerves.
    const allowed: Record<string, string[]> = {
      'features/add/session.ts': ['songs'],
      'features/box/CheckCard.tsx': ['package'],
      'features/box/RebuildDialog.tsx': ['rebuild'],
      'features/box/CopyToCardDialog.tsx': ['copy'],
      'features/box/SoundsDialog.tsx': ['sounds'],
    };
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const found: Record<string, string[]> = {};
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !full.endsWith(join('ui', 'sound.ts'))) {
          const calls = [...readFileSync(full, 'utf8').matchAll(/playDoneSound\(([^)]*)\)/g)].map((m) => m[1].replace(/['"]/g, ''));
          if (calls.length) found[relative(root, full).split(sep).join('/')] = [...new Set(calls)];
        }
      }
    };
    walk(root);
    expect(found).toEqual(allowed);
  });

  it('knocks only at the reader (writing and deleting) and in the box test', () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const found: Record<string, string[]> = {};
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !full.endsWith(join('ui', 'sound.ts'))) {
          const calls = [...readFileSync(full, 'utf8').matchAll(/playCue\(([^)]*)\)/g)].map((m) => m[1].replace(/['"]/g, ''));
          if (calls.length) found[relative(root, full).split(sep).join('/')] = [...new Set(calls)].sort();
        }
      }
    };
    walk(root);
    expect(found).toEqual({ 'features/cards/ReadCardActions.tsx': ['cardWritten'], 'features/cards/ReaderPanel.tsx': ['cardWritten'], 'features/workshop/BoxTestTool.tsx': ['testDone'], 'features/workshop/PartsTestTool.tsx': ['testDone'] });
  });
});
