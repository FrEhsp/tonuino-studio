import { describe, expect, it } from 'vitest';
import type { FlashFirmwareOptions, FlashProblem, FlashResult, FlashSuccess } from '../../src/core/firmware/flash';
import { parseIntelHex, toIntelHex } from '../../src/core/firmware/intelhex';
import { getBoard } from '../../src/core/firmware/variants';
import { FlashSession, type StartFlash } from '../../src/features/workshop/flashsession';
import { WriteGuard, type WriteKind } from '../../src/app/writeguard';
import { backupFileName, chooseBoard, chooseFirmware, chooseVariant, goTo, initialWizard, type FirmwareChoice } from '../../src/features/workshop/wizard';
import type { SerialAccess, SerialPortInfo } from '../../src/platform/types';
import { FAST_TIMING, SIM_PORT, SimulatedSerialAccess, firmwareBytes, nanoBoard } from '../firmware/simulator';

const classic = getBoard('classic');
const AT = new Date(2026, 9, 5, 15, 40).getTime();

/** Records what the session does with the question before the app closes. */
class TestGuard extends WriteGuard {
  taken = 0;
  override hold(kind: WriteKind): () => void {
    expect(kind).toBe('firmware');
    this.taken++;
    return super.hold(kind);
  }
  get armed(): boolean {
    return this.running.value.length > 0;
  }
}

/** Firmware that is on the box before the upload; its last byte is not 0xFF. */
function oldFirmware(length: number): Uint8Array {
  const data = firmwareBytes(length, 7);
  data[length - 1] = 0x42;
  return data;
}

const NEW_FIRMWARE: FirmwareChoice = {
  kind: 'file',
  board: 'classic',
  fileName: 'neu.hex',
  fileBytes: 100,
  image: parseIntelHex(toIntelHex(firmwareBytes(2000, 3))),
};

function request(serial: SerialAccess, extra: Partial<StartFlash> = {}): StartFlash {
  return { serial, port: SIM_PORT, board: classic, os: 'linux', firmware: NEW_FIRMWARE, ...extra };
}

/** A session that flashes the simulated board for real. */
function simulated() {
  const board = nanoBoard('old');
  const serial = new SimulatedSerialAccess(board);
  const guard = new TestGuard();
  const session = new FlashSession({ guard, timing: FAST_TIMING, now: () => AT });
  return { board, serial, guard, session };
}

const SUCCESS: FlashSuccess = { ok: true, baud: 57600, signature: [0x1e, 0x95, 0x0f], bytesWritten: 2048, verified: true, durationMs: 1000 };
const NO_SYNC: FlashProblem = { code: 'no-answer', title: 'Die Box antwortet nicht', explanation: 'x', steps: ['y'] };

/** Serial access that only lists ports (the injected flash never opens one). */
function lister(ports: () => SerialPortInfo[] | Promise<SerialPortInfo[]>): SerialAccess {
  return {
    supported: true,
    list: async () => ports(),
    open: async () => {
      throw new Error('not used');
    },
  };
}

/** A session with a scripted flash: each call takes the next result. */
function scripted(...results: FlashResult[]) {
  const calls: FlashFirmwareOptions[] = [];
  const guard = new TestGuard();
  const session = new FlashSession({
    guard,
    now: () => AT,
    flash: async (opts) => {
      calls.push(opts);
      const next = results.shift();
      if (!next) throw new Error('no result left');
      return next;
    },
  });
  return { calls, guard, session };
}

describe('flash session', () => {
  it('uploads, keeps the old firmware and lets the app close again', async () => {
    const { board, serial, guard, session } = simulated();
    const old = oldFirmware(3000);
    board.flash.set(old, 0);
    const steps: string[] = [];
    let guardedWhileRunning = true;
    let guardedBeforeWriting = false;
    const off = session.run.subscribe((r) => {
      steps.push(r.phase === 'running' ? r.status.step : r.phase);
      if (r.phase !== 'running') return;
      // Closing asks while the box is written, not while it is only read.
      if (['write', 'verify'].includes(r.status.step) && !guard.armed) guardedWhileRunning = false;
      if (['connect', 'sync', 'backup'].includes(r.status.step) && guard.armed) guardedBeforeWriting = true;
    });
    await session.start(request(serial, { backup: true }));
    off();

    expect(session.run.value).toMatchObject({ phase: 'done', result: { ok: true, verified: true } });
    expect(steps).toContain('backup');
    expect(steps.indexOf('backup')).toBeLessThan(steps.indexOf('write'));
    expect(steps.at(-1)).toBe('done');
    expect(guardedWhileRunning).toBe(true);
    expect(guardedBeforeWriting).toBe(false);
    expect(guard.armed).toBe(false);
    expect(guard.taken).toBe(1);
    expect(serial.allClosed).toBe(true);
    expect(board.read(0, 2000)).toEqual(NEW_FIRMWARE.image.data);
    expect(session.saved.value).toEqual({ board: 'classic', backup: { data: old, startAddress: 0 }, at: AT, fileName: backupFileName(classic, AT) });
  });

  it('can be cancelled, and closes the port', async () => {
    const { board, serial, guard, session } = simulated();
    const off = session.run.subscribe((r) => {
      if (r.phase === 'running' && r.status.step === 'write' && r.status.progress > 0.1) session.cancel();
    });
    await session.start(request(serial));
    off();
    expect(session.run.value).toMatchObject({ phase: 'failed', problem: { code: 'aborted' } });
    expect(board.pagesWritten).toBeLessThan(16);
    expect(serial.allClosed).toBe(true);
    expect(guard.armed).toBe(false);
    expect(session.saved.value).toBeNull();
  });

  it('ignores a second start while an upload runs', async () => {
    let finish: (r: FlashResult) => void = () => undefined;
    let calls = 0;
    const session = new FlashSession({
      guard: new TestGuard(),
      flash: () => {
        calls++;
        return new Promise((resolve) => (finish = resolve));
      },
    });
    const serial = lister(() => [SIM_PORT]);
    const first = session.start(request(serial));
    await session.start(request(serial, { port: { ...SIM_PORT, id: 'other' } }));
    expect(calls).toBe(1);
    // Nothing else may change the session while the box is written.
    session.reset();
    session.dismiss();
    session.useGuess({ board: 'aioplus' }, 'probe', true);
    expect(session.run.value.phase).toBe('running');
    expect(session.wizard.value.board).toBeUndefined();
    finish(SUCCESS);
    await first;
    expect(session.run.value).toMatchObject({ phase: 'done', request: { port: SIM_PORT } });
  });

  it('turns an error thrown by the flasher into a problem', async () => {
    const guard = new TestGuard();
    const session = new FlashSession({
      guard,
      flash: async () => {
        throw new Error('boom');
      },
    });
    await session.start(request(lister(() => [])));
    expect(session.run.value).toMatchObject({ phase: 'failed', problem: { code: 'unknown', technical: 'Error: boom' } });
    expect(guard.armed).toBe(false);
  });

  it('tries again on the same port while it is there', async () => {
    const { calls, session } = scripted({ ok: false, problem: NO_SYNC }, SUCCESS);
    const serial = lister(() => [{ ...SIM_PORT }]);
    await session.start(request(serial));
    expect(session.run.value.phase).toBe('failed');
    await session.retry({ ignoreUsbMismatch: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ port: { id: 'sim' }, ignoreUsbMismatch: true });
    expect(session.run.value.phase).toBe('done');
    expect(session.port.value?.id).toBe('sim');
  });

  it('finds the box under its new port after a pulled cable', async () => {
    const replugged: SerialPortInfo = { ...SIM_PORT, id: 'web-serial-7' };
    const { calls, session } = scripted({ ok: false, problem: { ...NO_SYNC, code: 'port-missing' } }, SUCCESS);
    let ports: SerialPortInfo[] = [SIM_PORT];
    await session.start(request(lister(() => ports)));
    ports = [replugged];
    await session.retry();
    expect(calls[1].port).toBe(replugged);
    expect(session.port.value).toBe(replugged);
    expect(session.run.value).toMatchObject({ phase: 'done', request: { port: replugged } });
  });

  it('asks for the port when the box cannot be found again', async () => {
    for (const ports of [() => [] as SerialPortInfo[], () => Promise.reject(new Error('no access'))]) {
      const { calls, session } = scripted({ ok: false, problem: NO_SYNC });
      const s = chooseFirmware(chooseVariant(chooseBoard(initialWizard(), 'classic'), '3'), NEW_FIRMWARE);
      session.wizard.value = goTo(goTo(goTo(s, 'variant'), 'source'), 'flash');
      session.port.value = SIM_PORT;
      await session.start(request(lister(ports)));
      session.wizard.value = { ...session.wizard.value, step: 'board' };
      await session.retry();
      expect(calls).toHaveLength(1);
      expect(session.run.value).toEqual({ phase: 'idle' });
      expect(session.portGone.value).toBe(true);
      expect(session.port.value).toBeUndefined();
      expect(session.wizard.value.step).toBe('flash');
      // The next start clears the note.
      await session.start(request(lister(() => [SIM_PORT]))).catch(() => undefined);
      expect(session.portGone.value).toBe(false);
    }
  });

  it('does nothing on retry after the result was put away', async () => {
    const { calls, session } = scripted({ ok: false, problem: NO_SYNC }, SUCCESS);
    let release: () => void = () => undefined;
    const serial = lister(() => new Promise<SerialPortInfo[]>((resolve) => (release = () => resolve([SIM_PORT]))));
    await session.start(request(serial));
    const retry = session.retry();
    // The user goes back to the wizard while the ports are listed.
    session.dismiss();
    release();
    await retry;
    expect(calls).toHaveLength(1);
    expect(session.run.value).toEqual({ phase: 'idle' });
  });

  it('keeps the backup of an upload that failed afterwards', async () => {
    const backup = { data: oldFirmware(100), startAddress: 0 };
    const { session } = scripted({ ok: false, problem: { ...NO_SYNC, code: 'connection-lost' }, backup });
    await session.start(request(lister(() => [SIM_PORT]), { backup: true }));
    expect(session.run.value.phase).toBe('failed');
    expect(session.saved.value?.backup).toBe(backup);
  });

  it('puts the old firmware back, without saving it again', async () => {
    const { board, serial, session } = simulated();
    const old = oldFirmware(3000);
    board.flash.set(old, 0);
    await session.start(request(serial, { backup: true }));
    const saved = session.saved.value;
    expect(saved?.backup.data).toEqual(old);

    await session.restore();
    const run = session.run.value;
    expect(run).toMatchObject({ phase: 'done', request: { backup: false, ignoreUsbMismatch: true, firmware: { kind: 'backup', fileName: saved?.fileName } } });
    expect(board.read(0, 3000)).toEqual(old);
    expect(session.saved.value).toBe(saved);
  });

  it('restores from the flash step on the port chosen there', async () => {
    const { calls, session } = scripted({ ok: false, problem: NO_SYNC, backup: { data: oldFirmware(100), startAddress: 0 } }, SUCCESS);
    await session.start(request(lister(() => [SIM_PORT])));
    session.dismiss();
    const chosen: SerialPortInfo = { ...SIM_PORT, id: 'chosen' };
    await session.restore({ serial: lister(() => [chosen]), port: chosen, board: classic, os: 'linux' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ port: chosen, backup: false, ignoreUsbMismatch: true });
    expect(calls[1].image).toMatchObject({ startAddress: 0, byteCount: 100 });
  });

  it('never puts a backup on another board or puts back nothing', async () => {
    const { calls, session } = scripted({ ok: false, problem: NO_SYNC, backup: { data: oldFirmware(100), startAddress: 0 } });
    await session.start(request(lister(() => [SIM_PORT])));
    await session.restore({ serial: lister(() => [SIM_PORT]), port: SIM_PORT, board: getBoard('aio'), os: 'linux' });
    expect(calls).toHaveLength(1);

    const empty = scripted({ ok: false, problem: NO_SYNC, backup: { data: new Uint8Array(0), startAddress: 0 } });
    await empty.session.start(request(lister(() => [SIM_PORT])));
    await empty.session.restore();
    expect(empty.calls).toHaveLength(1);
    expect(empty.session.run.value.phase).toBe('failed');
  });

  it('takes over what the box told, and starts over when asked', () => {
    const session = new FlashSession({ guard: new TestGuard() });
    session.wizard.value = goTo(chooseVariant(chooseBoard(initialWizard(), 'aio'), '5'), 'variant');
    session.useGuess({ board: 'aioplus', buttons: '3', variant: '3' }, 'probe');
    expect(session.wizard.value).toMatchObject({ step: 'variant', board: 'aioplus', variant: '3' });
    expect(session.guess.value).toEqual({ from: 'probe', guess: { board: 'aioplus', buttons: '3', variant: '3' } });

    session.portGone.value = true;
    session.useGuess({ board: 'classic', buttons: '5', variant: '5' }, 'logbook', true);
    expect(session.wizard.value).toEqual({ step: 'board', board: 'classic', variant: '5', firmware: undefined });
    expect(session.guess.value?.from).toBe('logbook');
    expect(session.portGone.value).toBe(false);
  });

  it('goes back to the wizard after a result, or starts over', async () => {
    const { session } = scripted(SUCCESS);
    const s = chooseFirmware(chooseVariant(chooseBoard(initialWizard(), 'classic'), '3'), NEW_FIRMWARE);
    session.wizard.value = s;
    session.guess.value = { from: 'probe', guess: { board: 'classic' } };
    await session.start(request(lister(() => [SIM_PORT])));
    session.dismiss();
    expect(session.run.value).toEqual({ phase: 'idle' });
    expect(session.wizard.value).toBe(s);
    session.reset();
    expect(session.wizard.value).toEqual(initialWizard());
    expect(session.guess.value).toBeNull();
  });
});

describe('flash session sound', () => {
  it('plays the "Pling" after a successful upload only', async () => {
    let plings = 0;
    const results: FlashResult[] = [{ ok: false, problem: NO_SYNC }, SUCCESS];
    const session = new FlashSession({ guard: new TestGuard(), now: () => AT, flash: async () => results.shift()!, done: () => plings++ });
    const serial = lister(() => [SIM_PORT]);
    await session.start(request(serial));
    expect(session.run.value.phase).toBe('failed');
    expect(plings).toBe(0);
    await session.start(request(serial));
    expect(session.run.value.phase).toBe('done');
    expect(plings).toBe(1);
  });
});
