import { describe, expect, it } from 'vitest';
import {
  FirmwareDownloadError,
  describeFlashError,
  describePortError,
  downloadFirmware,
  downloadFirmwareFile,
  flashFirmware,
  type FetchFn,
  type FlashFirmwareOptions,
  type FlashProblem,
  type FlashResult,
  type FlashStatus,
} from '../../src/core/firmware/flash';
import { HexError, parseIntelHex, toIntelHex, type HexImage } from '../../src/core/firmware/intelhex';
import { FlashError } from '../../src/core/firmware/stk500';
import { firmwareUrl, type BoardId } from '../../src/core/firmware/variants';
import type { SerialPortInfo } from '../../src/platform/types';
import { FAST_TIMING, SIM_PORT, SimulatedBoard, SimulatedSerialAccess, aioPlusBoard, firmwareBytes, nanoBoard } from './simulator';

async function run(board: SimulatedBoard, boardId: BoardId, image: Uint8Array | HexImage, extra: Partial<FlashFirmwareOptions> = {}) {
  const serial = new SimulatedSerialAccess(board);
  const statuses: FlashStatus[] = [];
  const result = await flashFirmware({
    serial,
    port: SIM_PORT,
    board: boardId,
    image,
    timing: FAST_TIMING,
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { serial, statuses, result };
}

function problemOf(result: FlashResult): FlashProblem {
  if (result.ok) throw new Error('expected a problem');
  return result.problem;
}

/** A board that never answers: no bootloader, or an AiO that switched itself off. */
function silentBoard(baudRate: number): SimulatedBoard {
  return new SimulatedBoard({ baudRate, listenAfterMs: 1e9 });
}

const hexOf = (data: Uint8Array, start = 0): HexImage => parseIntelHex(toIntelHex(data, start));

/** USB ids of the AiO's own USB chip (port filter of the official aio_update.html). */
const AIO_PORT: SerialPortInfo = { id: 'aio', label: 'AiO (HT42B534)', usbVendorId: 0x04d9, usbProductId: 0xb534 };

/** An error shaped like the desktop platform's (TauriPlatformError): code, German message, detail, hints. */
function desktopError(code: string, message: string, detail: string, hints: { id: string; text: string; command?: string }[] = []) {
  return Object.assign(new Error(message), { name: 'TauriPlatformError', code, detail, hints });
}

async function openProblem(error: Error, os: FlashFirmwareOptions['os'], board: BoardId = 'classic', port: SerialPortInfo = SIM_PORT): Promise<FlashProblem> {
  const serial = new SimulatedSerialAccess(nanoBoard('optiboot'), port);
  serial.openError = error;
  return problemOf(await flashFirmware({ serial, port, board, image: firmwareBytes(100), os }));
}

describe('flashFirmware', () => {
  it('falls back from 57600 to 115200 for a Nano with the new bootloader', async () => {
    const board = nanoBoard('optiboot');
    const image = hexOf(firmwareBytes(5000));
    const { serial, statuses, result } = await run(board, 'classic', image);

    expect(result).toMatchObject({ ok: true, baud: 115200, signature: [0x1e, 0x95, 0x0f], bootloaderVersion: '8.0', bytesWritten: 5120, verified: true });
    expect(serial.openedBauds).toEqual([57600, 115200]);
    expect(serial.allClosed).toBe(true);
    expect(board.read(0, 5000)).toEqual(image.data);

    expect(statuses.slice(0, 4).map((s) => `${s.step}@${s.baud}`)).toEqual(['connect@57600', 'sync@57600', 'connect@115200', 'sync@115200']);
    expect(statuses[0].message).toBe('Verbindung zur Box wird aufgebaut …');
    expect(statuses[2].message).toBe('Neuer Versuch mit anderer Geschwindigkeit …');
    const progress = statuses.map((s) => s.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(statuses.filter((s) => s.step === 'write').every((s) => s.progress <= 0.5)).toBe(true);
    expect(statuses.filter((s) => s.step === 'verify').at(-1)?.progress).toBe(1);
    expect(statuses.at(-1)).toEqual({ step: 'done', baud: 115200, progress: 1, message: 'Fertig! Die Box startet mit der neuen Firmware.' });
  });

  it('flashes a Nano with the old bootloader at the first speed', async () => {
    const board = nanoBoard('old');
    const { serial, result } = await run(board, 'classic', firmwareBytes(3000));
    expect(result).toMatchObject({ ok: true, baud: 57600, bootloaderVersion: '1.16' });
    expect(serial.openedBauds).toEqual([57600]);
    expect(board.read(0, 3000)).toEqual(firmwareBytes(3000));
  });

  it('flashes an AiO+ behind its bootloader and reminds to hold Play/Pause', async () => {
    const board = aioPlusBoard();
    const data = firmwareBytes(4000, 2);
    const { statuses, result } = await run(board, 'aioplus', hexOf(data, 0x200));
    expect(result).toMatchObject({ ok: true, baud: 115200, signature: [0x1e, 0x96, 0x51] });
    expect(board.read(0x200, 4000)).toEqual(data);
    expect(board.violations).toEqual([]);
    expect(statuses.find((s) => s.step === 'sync')?.message).toBe('Warte auf die Box … Halte Play/Pause gedrückt.');
    expect(statuses.find((s) => s.step === 'write')?.message).toBe('Firmware wird aufgespielt … Play/Pause weiter gedrückt halten.');
    expect(statuses.find((s) => s.step === 'verify')?.message).toBe('Firmware wird geprüft … Play/Pause weiter gedrückt halten.');
    expect(statuses.at(-1)?.message).toBe('Fertig! Du kannst Play/Pause jetzt loslassen.');
  });

  it('skips the erased gap in front of an AiO+ firmware', async () => {
    const board = aioPlusBoard();
    const data = firmwareBytes(1000, 4);
    const image = new Uint8Array(0x200 + data.length).fill(0xff);
    image.set(data, 0x200);
    const { result } = await run(board, 'aioplus', image);
    expect(result.ok).toBe(true);
    expect(board.read(0x200, 1000)).toEqual(data);
    expect(board.violations).toEqual([]);
    expect(board.commands).not.toContain('LOAD_ADDRESS 0x0000');
  });

  it('refuses a firmware that would overwrite the AiO+ bootloader, without opening the port', async () => {
    const { serial, result } = await run(aioPlusBoard(), 'aioplus', firmwareBytes(2000));
    const problem = problemOf(result);
    expect(problem.code).toBe('bad-image');
    expect(problem.explanation).toContain('andere Platine');
    expect(serial.connections).toHaveLength(0);
  });

  it('explains that an AiO+ was selected but a Nano answered', async () => {
    const { serial, result } = await run(nanoBoard('optiboot'), 'aioplus', hexOf(firmwareBytes(500), 0x200));
    const problem = problemOf(result);
    expect(problem.code).toBe('wrong-board');
    expect(problem.title).toBe('Das ist eine andere Platine');
    expect(problem.explanation).toContain('ATmega328P');
    expect(problem.explanation).toContain('Ausgewählt ist aber „AiO+“');
    expect(problem.steps[0]).toBe('Wähle „Classic“ oder „AiO“ aus und starte noch einmal.');
    expect(serial.allClosed).toBe(true);
  });

  it('explains that Classic was selected but an AiO+ answered', async () => {
    const board = aioPlusBoard();
    const { serial, result } = await run(board, 'classic', firmwareBytes(500));
    const problem = problemOf(result);
    expect(problem.code).toBe('wrong-board');
    expect(problem.explanation).toContain('AiO+-Platine');
    expect(problem.steps[0]).toBe('Wähle „AiO+“ aus und starte noch einmal.');
    expect(serial.openedBauds).toEqual([57600, 115200]);
    expect(board.pagesWritten).toBe(0);
  });

  it('does not write the Classic build onto an AiO, which has the same chip', async () => {
    // The LGT8F328P bootloader of the AiO answers at 57600 with the ATmega328P signature.
    const board = nanoBoard('old');
    const { serial, result } = await run(board, 'classic', firmwareBytes(500), { port: AIO_PORT });
    const problem = problemOf(result);
    expect(problem).toMatchObject({ code: 'wrong-board', title: 'Ist das wirklich die richtige Platine?' });
    expect(problem.explanation).toBe(
      'Ausgewählt ist „Classic“, aber der USB-Anschluss gehört zu „AiO“. Beide haben denselben Chip, brauchen aber verschiedene Firmware. Deshalb wurde noch nichts aufgespielt.',
    );
    expect(problem.steps[0]).toBe('Wähle „AiO“ aus und starte noch einmal.');
    expect(problem.action).toEqual({ kind: 'flash-anyway', label: 'Trotzdem aufspielen' });
    expect(problem.technical).toBe('signature 1e 95 0f fits classic; USB 04d9:b534 points to aio');
    expect(board.pagesWritten).toBe(0);
    expect(serial.allClosed).toBe(true);

    const again = await run(board, 'classic', firmwareBytes(500), { port: AIO_PORT, ignoreUsbMismatch: true });
    expect(again.result.ok).toBe(true);
    expect(board.read(0, 500)).toEqual(firmwareBytes(500));
  });

  it('asks to hold Play/Pause when an AiO does not answer', async () => {
    const { serial, result } = await run(silentBoard(57600), 'aio', firmwareBytes(500), { port: AIO_PORT });
    const problem = problemOf(result);
    expect(problem.code).toBe('no-answer');
    expect(problem.title).toBe('Die Box antwortet nicht');
    expect(problem.explanation).toContain('Play/Pause-Taste');
    expect(problem.steps[0]).toContain('Halte die Play/Pause-Taste gedrückt');
    expect(problem.steps).toContain('AiO (Version 1) und AiO+ (Version 2) sehen sich ähnlich, brauchen aber verschiedene Firmware.');
    expect(problem.technical).toBe('no answer to GET_SYNC at 57600 baud (3 attempts); tried 57600 baud; USB 04d9:b534');
    expect(serial.allClosed).toBe(true);
  });

  it('points to the AiO when the AiO+ is selected but the USB ids belong to an AiO', async () => {
    const { result } = await run(silentBoard(57600), 'aioplus', hexOf(firmwareBytes(500), 0x200), { port: AIO_PORT });
    const problem = problemOf(result);
    expect(problem.code).toBe('no-answer');
    expect(problem.explanation).toContain('Der USB-Anschluss gehört eher zu „AiO“ als zu „AiO+“.');
    expect(problem.steps[0]).toBe('Wähle „AiO“ aus und starte noch einmal.');
    expect(problem.steps[1]).toContain('Halte die Play/Pause-Taste gedrückt');

    // A CH340 fits the AiO+ and Nano clones, but not the AiO.
    const aio = problemOf((await run(silentBoard(115200), 'aio', firmwareBytes(500))).result);
    expect(aio.steps[0]).toBe('Wähle „Classic“ oder „AiO+“ aus und starte noch einmal.');
  });

  it('tries both speeds before giving up on a Nano', async () => {
    const { serial, result } = await run(silentBoard(115200), 'classic', firmwareBytes(500));
    const problem = problemOf(result);
    expect(problem.code).toBe('no-answer');
    expect(problem.explanation).toContain('beide üblichen Geschwindigkeiten');
    expect(problem.steps).toContain('Probiere ein anderes USB-Kabel. Viele Kabel laden nur und übertragen keine Daten.');
    expect(serial.openedBauds).toEqual([57600, 115200]);
    expect(serial.allClosed).toBe(true);
  });

  it('explains why the port does not open', async () => {
    const attempt = (message: string, os: FlashFirmwareOptions['os'], name = 'Error') => {
      const error = new Error(message);
      error.name = name;
      return openProblem(error, os);
    };

    const permission = await attempt('Permission denied (os error 13): /dev/ttyUSB0', 'linux');
    expect(permission.code).toBe('port-permission');
    expect(permission.steps.join(' ')).toContain('sudo usermod -aG dialout $USER');
    expect(permission.action).toEqual({ kind: 'usb-access-setup', label: 'USB-Zugriff einrichten' });

    const busy = await attempt('Device or resource busy', 'linux');
    expect(busy).toMatchObject({ code: 'port-busy', title: 'Der Anschluss ist belegt' });
    expect(busy.action).toBeUndefined();
    // Windows: a COM port that another program holds.
    expect((await attempt('Opening COM3: Access denied', 'windows')).title).toBe('Der Anschluss ist belegt');

    const missing = await attempt('No such file or directory', 'windows');
    expect(missing.code).toBe('port-missing');
    expect(missing.steps.join(' ')).toContain('CH340');
    expect(missing.action).toEqual({ kind: 'link', label: 'CH340-Treiber herunterladen', url: 'https://www.wch-ic.com/downloads/CH341SER_EXE.html' });
    // The download page is in English: the step says what to click there.
    expect(missing.steps.join(' ')).toContain('auf „Download“, starte die Datei „CH341SER.EXE“ und klicke auf „INSTALL“');
    expect(missing.explanation).toBe('Der USB-Anschluss der Box ist nicht da. Vielleicht wurde das Kabel abgezogen, oder es fehlt ein Treiber.');

    const web = await attempt('Failed to open serial port.', 'windows', 'NetworkError');
    expect(web).toMatchObject({ code: 'port-busy', title: 'Der Anschluss lässt sich nicht öffnen' });
    expect(web.steps.join(' ')).toContain('CH340');
    // The forum's fix for this message: SerEnum on, before reinstalling the driver.
    const serEnum = web.steps.findIndex((t) => t.includes('„Enabling the Serial Port Enumerator (SerEnum)“'));
    expect(serEnum).toBeGreaterThan(-1);
    expect(serEnum).toBeLessThan(web.steps.findIndex((t) => t.includes('„CH341SER.EXE“')));
    expect(web.explanation).toBe('Der USB-Anschluss der Box lässt sich nicht öffnen. Meist benutzt ihn gerade ein anderes Programm, oder dem CH340-Treiber fehlt eine Einstellung.');
    // Only Windows has that setting.
    const mac = await attempt('Failed to open serial port.', 'macos', 'NetworkError');
    expect(mac.steps.join(' ')).not.toContain('SerEnum');
    expect(mac.explanation).toBe('Der USB-Anschluss der Box lässt sich nicht öffnen. Meist benutzt ihn gerade ein anderes Programm.');

    // Chrome on Linux cannot tell a missing permission from a busy port.
    const webLinux = await attempt('Failed to open serial port.', 'linux', 'NetworkError');
    expect(webLinux.steps.join(' ')).toContain('dialout');
    expect(webLinux.action?.kind).toBe('usb-access-setup');
  });

  it('understands the messages of the browser platform', async () => {
    const busy = await openProblem(
      new Error('Der Anschluss ist schon geöffnet, vielleicht in einem anderen Tab oder Programm (z. B. der Arduino IDE). Schließe es und versuche es noch einmal.'),
      'macos',
    );
    expect(busy).toMatchObject({ code: 'port-busy', title: 'Der Anschluss ist belegt' });

    const gone = await openProblem(new Error('Der Anschluss ist nicht mehr da. Stecke das USB-Kabel neu ein.'), 'macos');
    expect(gone.code).toBe('port-missing');
    expect(gone.steps.join(' ')).toContain('älteren Macs');
    expect(gone.action).toMatchObject({ kind: 'link', url: 'https://www.wch-ic.com/downloads/CH34XSER_MAC_ZIP.html' });
    expect(gone.steps.join(' ')).toContain('auf „Download“');

    // The AiO has no CH340, so no driver advice.
    const aio = await openProblem(new Error('Der Anschluss ist nicht mehr da. Stecke das USB-Kabel neu ein.'), 'windows', 'aio', AIO_PORT);
    expect(aio.steps.join(' ')).not.toContain('CH340');
    expect(aio.action).toBeUndefined();
  });

  it('gives CH340 driver steps only when the port has a CH340', async () => {
    const ftdi: SerialPortInfo = { id: 'COM4', label: 'USB Serial Port (COM4)', usbVendorId: 0x0403, usbProductId: 0x6001 };
    const cp2102: SerialPortInfo = { id: 'COM5', label: 'Silicon Labs CP210x (COM5)', usbVendorId: 0x10c4, usbProductId: 0xea60 };
    const gone = () => new Error('Der Anschluss ist nicht mehr da. Stecke das USB-Kabel neu ein.');
    const failed = () => Object.assign(new Error('Failed to open serial port.'), { name: 'NetworkError' });
    for (const port of [ftdi, cp2102]) {
      for (const os of ['windows', 'macos'] as const) {
        for (const problem of [await openProblem(gone(), os, 'classic', port), await openProblem(failed(), os, 'classic', port)]) {
          const text = [problem.explanation, ...problem.steps].join(' ');
          expect(text, `${port.label} ${os}`).not.toMatch(/CH340|SerEnum|WCH|Treiber/);
          expect(problem.action, `${port.label} ${os}`).toBeUndefined();
        }
      }
      // Nor does the explanation blame a driver it gives no step for.
      for (const os of ['windows', 'macos', 'linux'] as const) {
        expect((await openProblem(gone(), os, 'classic', port)).explanation, `${port.label} ${os}`).not.toContain('Treiber');
      }
      expect((await openProblem(gone(), 'macos', 'classic', port)).explanation).toBe('Der USB-Anschluss der Box ist nicht da. Vielleicht wurde das Kabel abgezogen.');
    }
    // On Linux the step is about brltty: so is the explanation.
    const linux = await openProblem(gone(), 'linux', 'classic', cp2102);
    expect(linux.steps.join(' ')).toContain('brltty');
    expect(linux.explanation).toBe('Der USB-Anschluss der Box ist nicht da. Vielleicht wurde das Kabel abgezogen, oder ein anderes Programm hat ihn belegt.');
    // The AiO's own chip needs no driver either.
    expect((await openProblem(gone(), 'windows', 'aio', AIO_PORT)).explanation).toBe('Der USB-Anschluss der Box ist nicht da. Vielleicht wurde das Kabel abgezogen.');
    // A CH340 on a Mac: the driver step, and the driver in the explanation.
    const macClone = await openProblem(gone(), 'macos', 'classic', SIM_PORT);
    expect(macClone.steps.join(' ')).toContain('älteren Macs');
    expect(macClone.explanation).toContain('oder es fehlt ein Treiber');
    // A Nano clone with a CH340 still gets them.
    const clone = await openProblem(failed(), 'windows', 'classic', SIM_PORT);
    expect(clone.steps.join(' ')).toContain('SerEnum');
    expect(clone.action).toMatchObject({ kind: 'link', label: 'CH340-Treiber herunterladen' });
    // Without the port's ids the board decides; the Box-Logbuch has no board.
    expect((await openProblem(gone(), 'windows', 'classic', { id: 'COM3', label: 'COM3' })).steps.join(' ')).toContain('CH340');
    expect(describePortError(failed(), { os: 'windows', port: ftdi }).steps.join(' ')).not.toContain('CH340');
    expect(describePortError(failed(), { os: 'windows', port: SIM_PORT }).steps.join(' ')).toContain('CH340');
  });

  it('uses the codes and hints of the desktop platform', async () => {
    const permission = await openProblem(
      desktopError('permission', 'Ich darf noch nicht auf die Box zugreifen.', 'Permission denied (os error 13)', [
        { id: 'linux-serial-permission', text: 'Füge dich mit diesem Befehl der passenden Gruppe hinzu und melde dich neu an:', command: 'sudo usermod -aG dialout $USER' },
      ]),
      'linux',
    );
    expect(permission.code).toBe('port-permission');
    expect(permission.steps[0]).toBe('Füge dich mit diesem Befehl der passenden Gruppe hinzu und melde dich neu an: sudo usermod -aG dialout $USER');
    expect(permission.steps.filter((s) => s.includes('usermod'))).toHaveLength(1);
    expect(permission.technical).toContain('Permission denied (os error 13)');

    const brltty = await openProblem(
      desktopError('not-found', 'Die Box wurde nicht gefunden.', '/dev/ttyUSB0 vanished', [
        { id: 'linux-brltty', text: 'Das Programm „brltty“ belegt den USB-Anschluss der Box.', command: 'sudo apt remove brltty' },
      ]),
      'linux',
    );
    expect(brltty.code).toBe('port-missing');
    expect(brltty.steps[0]).toBe('Das Programm „brltty“ belegt den USB-Anschluss der Box. sudo apt remove brltty');
    expect(brltty.steps.join(' ')).not.toContain('Braillezeilen');
    expect(brltty.explanation).toBe('Der USB-Anschluss der Box ist nicht da. Vielleicht wurde das Kabel abgezogen, oder ein anderes Programm hat ihn belegt.');
    // The desktop app found nothing like that: then only the cable is left.
    const unplugged = await openProblem(
      desktopError('not-found', 'Die Box wurde nicht gefunden.', '/dev/ttyUSB0 vanished', [
        { id: 'linux-serial-permission', text: 'Füge dich mit diesem Befehl der passenden Gruppe hinzu und melde dich neu an:', command: 'sudo usermod -aG dialout $USER' },
      ]),
      'linux',
    );
    expect(unplugged.explanation).toBe('Der USB-Anschluss der Box ist nicht da. Vielleicht wurde das Kabel abgezogen.');

    const busy = await openProblem(desktopError('busy', 'Die Box wird gerade von einem anderen Programm benutzt.', 'Device or resource busy'), 'linux');
    expect(busy.code).toBe('port-busy');
  });

  it('refuses a firmware that is too large without opening the port', async () => {
    const { serial, result } = await run(nanoBoard('optiboot'), 'classic', firmwareBytes(32300));
    const problem = problemOf(result);
    expect(problem.code).toBe('too-large');
    expect(problem.explanation).toBe('Die Firmware braucht 32300 Bytes, auf „Classic“ ist aber nur Platz für 32256 Bytes.');
    expect(problem.steps.join(' ')).toContain('5 Tasten mit allen Extras');
    expect(serial.connections).toHaveLength(0);
  });

  it('puts a firmware bigger than 30720 bytes only behind the new bootloader (Firmware-Baukasten with ring)', async () => {
    const data = firmwareBytes(31000);
    const ok = await run(nanoBoard('optiboot'), 'classic', data);
    expect(ok.result.ok).toBe(true);
    if (ok.result.ok) expect(ok.result.baud).toBe(115200);

    const old = nanoBoard('old');
    const refused = await run(old, 'classic', data);
    const problem = problemOf(refused.result);
    expect(problem.code).toBe('too-large');
    expect(problem.title).toBe('Diese Firmware braucht einen Nano mit neuem Bootloader');
    expect(problem.explanation).toContain('nur Platz für 30720 Bytes, diese Firmware braucht 31000 Bytes');
    expect(problem.explanation).toContain('Auf der Box hat sich nichts geändert.');
    expect(refused.serial.allClosed).toBe(true);
    // Nothing was written: the old bootloader was not even asked to load a page.
    expect(old.flash.slice(0, 16).every((b) => b === 0xff)).toBe(true);
  });

  it('does not touch boards it cannot flash', async () => {
    const every = problemOf((await run(nanoBoard('optiboot'), 'every', firmwareBytes(100))).result);
    expect(every.code).toBe('unsupported');
    expect(every.steps[0]).toContain('Arduino IDE');
    const esp = problemOf((await run(nanoBoard('optiboot'), 'esp32nano', firmwareBytes(100))).result);
    expect(esp.title).toBe('Die ESP32-Box bekommt ihre Firmware über WLAN');
    expect(esp.steps.join(' ')).toContain('/upgrade');
  });

  it('reports a failed check', async () => {
    const data = firmwareBytes(2000);
    const { serial, result } = await run(nanoBoard('old', { stuck: { 1500: data[1500] ^ 0x01 } }), 'classic', data);
    const problem = problemOf(result);
    expect(problem.code).toBe('verify-failed');
    expect(problem.explanation).toContain('0x5dc');
    expect(serial.allClosed).toBe(true);
  });

  it('can skip the check', async () => {
    const board = nanoBoard('old');
    const { statuses, result } = await run(board, 'classic', firmwareBytes(1000), { verify: false });
    expect(result).toMatchObject({ ok: true, verified: false });
    expect(board.commands.some((c) => c.startsWith('READ_PAGE'))).toBe(false);
    expect(statuses.filter((s) => s.step === 'write').at(-1)?.progress).toBe(1);
  });

  it('keeps the platform error of a port that breaks away while writing', async () => {
    const board = nanoBoard('old', { unplugAfterWrites: 10 });
    const serial = new SimulatedSerialAccess(board);
    // The desktop platform reports a pulled cable with code "disconnected" and a German message.
    const sim = board.write.bind(board);
    board.write = (data, baud) => {
      try {
        sim(data, baud);
      } catch {
        throw desktopError('disconnected', 'Die Verbindung zur Box ist abgebrochen.', 'device reports readiness to read but returned no data');
      }
    };
    const result = await flashFirmware({ serial, port: SIM_PORT, board: 'classic', image: firmwareBytes(1000), timing: FAST_TIMING });
    const problem = problemOf(result);
    expect(problem).toMatchObject({ code: 'port-missing', title: 'Die Box ist nicht mehr verbunden' });
    expect(problem.technical).toBe('write failed: Die Verbindung zur Box ist abgebrochen.');
    expect(serial.allClosed).toBe(true);
  });

  it('reports a connection that breaks off', async () => {
    const lost = problemOf((await run(nanoBoard('old', { dieAfterPages: 2 }), 'aio', firmwareBytes(1000), { port: AIO_PORT })).result);
    expect(lost.code).toBe('connection-lost');
    expect(lost.explanation).toContain('Play/Pause-Taste zu früh losgelassen');

    const unplugged = problemOf((await run(nanoBoard('old', { unplugAfterWrites: 10 }), 'classic', firmwareBytes(1000))).result);
    expect(unplugged).toMatchObject({ code: 'port-missing', title: 'Die Box ist nicht mehr verbunden' });
  });

  it('can be cancelled and closes the port', async () => {
    const abort = new AbortController();
    const board = nanoBoard('old');
    const { serial, result } = await run(board, 'classic', firmwareBytes(3000), {
      signal: abort.signal,
      onStatus: (s) => {
        if (s.step === 'write' && s.progress > 0.1) abort.abort();
      },
    });
    expect(problemOf(result).code).toBe('aborted');
    // Half a firmware: the text says so and how to get the box going again.
    expect(problemOf(result).explanation).toContain('nur zum Teil auf der Box');
    expect(problemOf(result).explanation).toContain('Spiele die Firmware noch einmal auf');
    expect(serial.allClosed).toBe(true);
    expect(board.pagesWritten).toBeLessThan(24);
  });

  it('says that nothing changed when cancelled before writing', async () => {
    for (const at of ['connect', 'sync'] as const) {
      const abort = new AbortController();
      const board = nanoBoard('old');
      const { result } = await run(board, 'classic', firmwareBytes(1000), {
        signal: abort.signal,
        onStatus: (s) => {
          if (s.step === at) abort.abort();
        },
      });
      expect(problemOf(result).explanation, at).toBe('Du hast abgebrochen, bevor etwas auf die Box geschrieben wurde. Sie startet wie vorher.');
      expect(board.pagesWritten).toBe(0);
    }
  });

  it('keeps going when the status callback throws', async () => {
    const { result } = await run(nanoBoard('old'), 'classic', firmwareBytes(500), {
      onStatus: () => {
        throw new Error('UI broke');
      },
    });
    expect(result.ok).toBe(true);
  });
});

/** Firmware that is on a box before an upload; its last byte is not 0xFF, so nothing of it counts as erased. */
function oldFirmware(length: number, seed = 7): Uint8Array {
  const data = firmwareBytes(length, seed);
  data[length - 1] = 0x42;
  return data;
}

describe('flashFirmware with a backup', () => {
  it('reads the firmware on the box before it writes the new one', async () => {
    const board = nanoBoard('optiboot');
    const old = oldFirmware(3000);
    board.flash.set(old, 0);
    const image = hexOf(firmwareBytes(5000));
    const { serial, statuses, result } = await run(board, 'classic', image, { backup: true });

    expect(result).toMatchObject({ ok: true, baud: 115200, bytesWritten: 5120 });
    // The erased flash behind the old firmware is not part of it.
    expect(result.ok && result.backup).toEqual({ data: old, startAddress: 0 });
    expect(board.read(0, 5000)).toEqual(image.data);
    expect(serial.allClosed).toBe(true);

    // The whole firmware area is read before the first page is written: with Optiboot that is 32256 bytes, so a
    // build for the new bootloader (up to 31.5 KiB) comes back whole.
    const firstWrite = board.commands.findIndex((c) => c.startsWith('PROG_PAGE'));
    expect(board.commands.slice(0, firstWrite).filter((c) => c === 'READ_PAGE 128')).toHaveLength(32256 / 128);

    const steps = statuses.map((s) => s.step);
    expect(steps.indexOf('backup')).toBeGreaterThan(steps.lastIndexOf('sync'));
    expect(steps.lastIndexOf('backup')).toBeLessThan(steps.indexOf('write'));
    expect(statuses.find((s) => s.step === 'backup')?.message).toBe('Alte Firmware wird gesichert …');
    const progress = statuses.map((s) => s.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(statuses.at(-1)?.progress).toBe(1);
  });

  it('keeps the AiO+ bootloader out of the backup', async () => {
    const board = aioPlusBoard();
    const old = oldFirmware(2000, 9);
    board.flash.set(old, 0x200);
    const { statuses, result } = await run(board, 'aioplus', hexOf(firmwareBytes(4000, 2), 0x200), { backup: true });
    expect(result.ok && result.backup).toEqual({ data: old, startAddress: 0x200 });
    expect(board.violations).toEqual([]);
    expect(board.commands).not.toContain('LOAD_ADDRESS 0x0000');
    expect(statuses.find((s) => s.step === 'backup')?.message).toBe('Alte Firmware wird gesichert … Play/Pause weiter gedrückt halten.');
  });

  it('brings back an empty backup from a box without firmware', async () => {
    const { result } = await run(nanoBoard('old'), 'classic', firmwareBytes(500), { backup: true });
    expect(result.ok && result.backup).toEqual({ data: new Uint8Array(0), startAddress: 0 });
  });

  it('writes nothing when the old firmware cannot be read', async () => {
    const board = nanoBoard('old', { dieAfterReads: 5 });
    const old = oldFirmware(3000);
    board.flash.set(old, 0);
    const { serial, result } = await run(board, 'classic', firmwareBytes(1000), { backup: true });
    const problem = problemOf(result);
    expect(problem.code).toBe('backup-failed');
    expect(problem.title).toBe('Die alte Firmware ließ sich nicht sichern');
    expect(problem.explanation).toContain('Es wurde nichts verändert');
    expect(problem.steps.at(-1)).toContain('„Alte Firmware vorher sichern“');
    expect(result.ok || result.backup).toBeFalsy();
    expect(board.pagesWritten).toBe(0);
    expect(board.read(0, 3000)).toEqual(old);
    expect(serial.allClosed).toBe(true);
  });

  it('asks to hold Play/Pause when an AiO stops answering while it is read', async () => {
    const board = nanoBoard('old', { dieAfterReads: 3 });
    const problem = problemOf((await run(board, 'aio', firmwareBytes(1000), { backup: true, port: AIO_PORT })).result);
    expect(problem.code).toBe('backup-failed');
    expect(problem.explanation).toContain('Play/Pause-Taste zu früh losgelassen');
    expect(problem.steps[0]).toContain('Play/Pause');
    expect(board.pagesWritten).toBe(0);
  });

  it('lets a check of the old firmware stop the upload before anything is written', async () => {
    const board = nanoBoard('optiboot');
    const old = oldFirmware(3000);
    board.flash.set(old, 0);
    const seen: Uint8Array[] = [];
    const stop: FlashProblem = { code: 'extras-lost', title: 'x', explanation: 'y', steps: [] };
    const { serial, result } = await run(board, 'classic', firmwareBytes(1000), {
      backup: true,
      checkBackup: async (b) => {
        seen.push(b.data);
        return stop;
      },
    });
    expect(seen).toEqual([old]);
    expect(problemOf(result)).toBe(stop);
    expect(!result.ok && result.backup).toEqual({ data: old, startAddress: 0 });
    expect(board.pagesWritten).toBe(0);
    expect(board.read(0, 3000)).toEqual(old);
    expect(serial.allClosed).toBe(true);
  });

  it('goes on when the check finds nothing, or breaks', async () => {
    for (const checkBackup of [async () => undefined, async () => Promise.reject(new Error('kaputt'))]) {
      const board = nanoBoard('optiboot');
      board.flash.set(oldFirmware(3000), 0);
      const { result } = await run(board, 'classic', firmwareBytes(1000), { backup: true, checkBackup });
      expect(result.ok).toBe(true);
    }
  });

  it('hands out the backup when writing fails afterwards', async () => {
    const board = nanoBoard('old', { dieAfterPages: 2 });
    const old = oldFirmware(3000);
    board.flash.set(old, 0);
    const { result } = await run(board, 'classic', firmwareBytes(1000), { backup: true });
    expect(problemOf(result).code).toBe('connection-lost');
    expect(!result.ok && result.backup).toEqual({ data: old, startAddress: 0 });
  });

  it('can be cancelled while it reads, before anything is written', async () => {
    const abort = new AbortController();
    const board = nanoBoard('old');
    board.flash.set(oldFirmware(3000), 0);
    const { serial, result } = await run(board, 'classic', firmwareBytes(1000), {
      backup: true,
      signal: abort.signal,
      onStatus: (s) => {
        if (s.step === 'backup' && s.progress > 0.1) abort.abort();
      },
    });
    expect(problemOf(result)).toMatchObject({
      code: 'aborted',
      explanation: 'Du hast das Sichern der alten Firmware abgebrochen. Auf die Box wurde nichts geschrieben. Sie startet wie vorher.',
    });
    expect(board.pagesWritten).toBe(0);
    expect(serial.allClosed).toBe(true);
  });

  it('puts a backup back as it was', async () => {
    const board = nanoBoard('old');
    const old = oldFirmware(3000);
    board.flash.set(old, 0);
    const first = await run(board, 'classic', firmwareBytes(2000, 3), { backup: true });
    if (!first.result.ok || !first.result.backup) throw new Error('expected a backup');
    const backup = first.result.backup;
    const { result } = await run(board, 'classic', { data: backup.data, startAddress: backup.startAddress, byteCount: backup.data.length });
    expect(result).toMatchObject({ ok: true, verified: true });
    expect(board.read(0, 3000)).toEqual(old);
  });
});

describe('describeFlashError', () => {
  it('maps any error to a problem', () => {
    expect(describeFlashError(new HexError('checksum', 4, 'Die Prüfsumme stimmt nicht.')).code).toBe('bad-image');
    expect(describeFlashError(new FlashError('protocol', 'READ_SIGN: expected INSYNC')).code).toBe('protocol');
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(describeFlashError(abort).code).toBe('aborted');
    expect(describeFlashError(new FlashError('too-large', 'image too large', { address: 0x7900 }), { board: 'classic' }).explanation).toContain(
      '30976 Bytes',
    );
    const unknown = describeFlashError(new TypeError('x is undefined'));
    expect(unknown.code).toBe('unknown');
    expect(unknown.technical).toBe('TypeError: x is undefined');
  });

  it('asks AiO owners whether Play/Pause hangs on PBP and PBN, not on GND', () => {
    const noSync = new FlashError('no-sync', 'no answer to GET_SYNC');
    const lost = new FlashError('timeout', 'no answer after PROG_PAGE');
    for (const board of ['aio', 'aioplus'] as const) {
      for (const error of [noSync, lost]) {
        const problem = describeFlashError(error, { board, baudRates: [57600] });
        const hold = problem.steps.findIndex((s) => s.startsWith('Halte die Play/Pause-Taste'));
        // Right after the hint to hold the key: holding only helps when the key is wired to PBP/PBN.
        expect(problem.steps[hold + 1], `${board} ${problem.code}`).toContain('PBP');
        expect(problem.steps[hold + 1]).toContain('GND');
      }
    }
    for (const error of [noSync, lost]) {
      expect(describeFlashError(error, { board: 'classic' }).steps.join(' ')).not.toContain('PBP');
    }
  });

  it('sends a broken AiO bootloader to the TonUINO forum', () => {
    const problem = describeFlashError(new FlashError('no-sync', 'no answer to GET_SYNC'), { board: 'aioplus', baudRates: [115200] });
    const text = problem.steps.join(' ');
    expect(text).toContain('Bootloader');
    expect(text).toContain('TonUINO-Forum');
    expect(text).not.toContain('Leiterkartenpiraten');
  });
});

describe('downloadFirmware', () => {
  const fetchReturning =
    (body: string, status = 200, calls: string[] = []): FetchFn =>
    async (url) => {
      calls.push(url);
      return new Response(body, { status });
    };

  async function downloadError(promise: Promise<unknown>): Promise<FlashProblem> {
    try {
      await promise;
    } catch (e) {
      expect(e).toBeInstanceOf(FirmwareDownloadError);
      return (e as FirmwareDownloadError).problem;
    }
    throw new Error('expected FirmwareDownloadError');
  }

  it('loads and parses a ready-made build', async () => {
    const calls: string[] = [];
    const image = await downloadFirmware(fetchReturning(toIntelHex(firmwareBytes(300)), 200, calls), 'classic', '5');
    expect(calls).toEqual(['https://tonuino.github.io/TonUINO-TNG/TonUINO_Classic_5/firmware.hex']);
    expect(image.data).toEqual(firmwareBytes(300));
  });

  it('names the file and keeps .bin for ESP32 builds', async () => {
    const file = await downloadFirmwareFile(fetchReturning('bin'), 'esp32wroom', '3x3');
    expect(file.url).toBe(firmwareUrl('esp32wroom', '3x3'));
    expect(file.fileName).toBe('TonUINO_Esp32_W_3x3.bin');
    expect(await downloadError(downloadFirmware(fetchReturning('bin'), 'esp32nano', '3'))).toMatchObject({ code: 'unsupported' });
  });

  it('explains a missing build, a network failure and a broken file', async () => {
    const missing = await downloadError(downloadFirmware(fetchReturning('Not Found', 404), 'aioplus', '5f'));
    expect(missing).toMatchObject({ code: 'download-failed', explanation: 'Diese Firmware liegt nicht (mehr) auf dem Server.' });

    const offline = await downloadError(
      downloadFirmware(async () => {
        throw new TypeError('Failed to fetch');
      }, 'aio', '3'),
    );
    expect(offline.code).toBe('download-failed');
    expect(offline.explanation).toContain('Internet');
    // The way out is the file itself, as a link, not the start page of the project.
    expect(offline.link).toEqual({ label: 'firmware.hex für AiO, 3 Tasten herunterladen', url: firmwareUrl('aio', '3') });
    expect(offline.steps[1]).toContain('„Eigene Datei“');
    const esp = await downloadError(downloadFirmwareFile(fetchReturning('Not Found', 404), 'esp32nano', '3'));
    expect(esp.link?.url).toBe(firmwareUrl('esp32nano', '3'));
    expect(esp.steps[1]).toContain('Webseite der Box');

    const html = await downloadError(downloadFirmware(fetchReturning('<!DOCTYPE html><title>Seite</title>'), 'classic', '3'));
    expect(html.code).toBe('bad-image');
    expect(html.explanation).toContain('Webseite');
  });

  it('refuses variants that do not exist without downloading', async () => {
    const calls: string[] = [];
    const problem = await downloadError(downloadFirmwareFile(fetchReturning('', 200, calls), 'classic', '5f'));
    expect(problem.title).toBe('Diese Variante gibt es nicht');
    expect(calls).toEqual([]);
  });
});
