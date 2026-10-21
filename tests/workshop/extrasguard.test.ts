import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BaukastenBuild, BaukastenManifest } from '../../src/core/firmware/baukasten';
import { parseIntelHex, toIntelHex } from '../../src/core/firmware/intelhex';
import { getBoard } from '../../src/core/firmware/variants';
import { FlashSession, type StartFlash } from '../../src/features/workshop/flashsession';
import { backupCheckFor } from '../../src/features/workshop/extrasguard';
import { knownBuild, knownFrom, noteManifestBuilds, rememberBuild, rememberFlashed } from '../../src/features/workshop/boxbuild';
import { takeOverExtras } from '../../src/features/workshop/ExtrasLost';
import { initialWizard, type FirmwareChoice } from '../../src/features/workshop/wizard';
import { FAST_TIMING, SIM_PORT, SimulatedSerialAccess, firmwareBytes, nanoBoard } from '../firmware/simulator';

const DIR = join(__dirname, '../../public/firmware/baukasten/');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as BaukastenManifest;
const knobRing = manifest.builds.find((b) => b.board === 'classic' && b.buttons === '3' && b.knob === 'encoder' && b.light === 'ring' && !b.headphones && !b.speakerOff && !b.traeger && b.preset === 'standard')!;
const imageOf = (b: BaukastenBuild) => gunzipSync(readFileSync(join(DIR, b.pack))).subarray(b.offset, b.offset + b.bytes);

const readyMade = (data: Uint8Array): FirmwareChoice => ({ kind: 'download', board: 'classic', variant: '3', fileName: 'x.hex', url: 'x', fileBytes: data.length, image: parseIntelHex(toIntelHex(data)) });

describe('the check before an update, in the app', () => {
  beforeEach(() => rememberBuild(null));

  it('is there only with a backup, not after "Trotzdem aufspielen" and not when the backup goes back on', () => {
    const base: StartFlash = { serial: new SimulatedSerialAccess(nanoBoard('old')), port: SIM_PORT, board: getBoard('classic'), os: 'linux', firmware: readyMade(firmwareBytes(100)) };
    expect(backupCheckFor(base, manifest)).toBeUndefined();
    expect(backupCheckFor({ ...base, backup: true }, manifest)).toBeTypeOf('function');
    expect(backupCheckFor({ ...base, backup: true, skipExtrasCheck: true }, manifest)).toBeUndefined();
    expect(backupCheckFor({ ...base, backup: true, firmware: { ...readyMade(firmwareBytes(100)), kind: 'backup' } as FirmwareChoice }, manifest)).toBeUndefined();
  });

  it('stops a ready-made build over the knob-and-ring build on the simulated box, writes nothing and remembers the build', async () => {
    const board = nanoBoard('optiboot');
    const old = new Uint8Array(imageOf(knobRing));
    board.flash.set(old, 0);
    const serial = new SimulatedSerialAccess(board);
    const session = new FlashSession({ timing: FAST_TIMING, prepareCheck: async (r) => backupCheckFor(r, manifest) });
    const request: StartFlash = { serial, port: SIM_PORT, board: getBoard('classic'), os: 'linux', firmware: readyMade(firmwareBytes(3000, 5)), backup: true };
    await session.start(request);
    const run = session.run.value;
    expect(run.phase === 'failed' ? run.problem : run.phase).toMatchObject({ code: 'extras-lost' });
    expect(board.pagesWritten).toBe(0);
    expect(knownBuild.value).toMatchObject({ id: knobRing.id, knob: 'encoder', light: 'ring', from: 'read' });

    // "Trotzdem aufspielen"
    await session.retry({ skipExtrasCheck: true });
    expect(session.run.value.phase).toBe('done');
    expect(board.read(0, 3000)).toEqual(firmwareBytes(3000, 5));
  });

  it('takes the extras over into the wizard for the same board and keys only', () => {
    const k = knownFrom({ ...knobRing, traeger: true }, 'read');
    const s = { ...initialWizard(), board: 'classic' as const, variant: '3' as const, step: 'flash' as const };
    const taken = takeOverExtras(s, k)!;
    expect(taken.step).toBe('source');
    expect(taken.extras).toEqual({ knob: 'encoder', light: 'ring' });
    expect(taken.shutdown).toBe('traeger');
    expect(takeOverExtras({ ...s, variant: '5' }, k)).toBeUndefined();
  });

  it('remembers what went on the box after an upload', () => {
    noteManifestBuilds([knobRing]);
    rememberFlashed({ firmware: { kind: 'download', baukasten: { id: knobRing.id } } });
    expect(knownBuild.value).toMatchObject({ id: knobRing.id, from: 'flashed' });
    rememberFlashed({ firmware: { kind: 'backup' } });
    expect(knownBuild.value?.id).toBe(knobRing.id);
    rememberFlashed({ firmware: { kind: 'download' } });
    expect(knownBuild.value).toBeNull();
  });
});
