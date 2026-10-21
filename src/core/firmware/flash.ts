/**
 * Puts a firmware onto a TonUINO box over USB and explains failures in plain
 * German. Tries the board's baud rates in order (Classic: old bootloader at
 * 57600, then Optiboot at 115200); each attempt opens the port, resets the
 * board, syncs, checks the signature, programs, verifies, leaves the
 * bootloader and always closes the port again.
 */
import type { SerialAccess, SerialConnection, SerialPortInfo } from '../../platform/types';
import { HexError, parseIntelHex, type HexImage } from './intelhex';
import {
  FlashError,
  STK_PARAM,
  flashImage,
  formatBytes,
  getParameter,
  readFlash,
  readSignature,
  resetBoard,
  sync,
  type Stk500Options,
  type Stk500Timing,
} from './stk500';
import {
  CH340_DRIVER_URLS,
  boardsForUsb,
  firmwareFileName,
  firmwareUrl,
  getBoard,
  largestFirmware,
  maxBytesAt,
  signatureToChip,
  usesCh340,
  VARIANTS,
  type BoardId,
  type BoardInfo,
  type ButtonVariant,
  type Stk500Board,
  type Stk500Params,
} from './variants';

export type FlashStep = 'connect' | 'sync' | 'backup' | 'write' | 'verify' | 'done';

export interface FlashStatus {
  step: FlashStep;
  /** Baud rate of the current attempt. */
  baud: number;
  /** Overall progress 0..1; saving the old firmware, writing and checking share the bar. */
  progress: number;
  /** German status line. */
  message: string;
}

export type FlashProblemCode =
  | 'no-answer'
  | 'wrong-board'
  | 'port-permission'
  | 'port-busy'
  | 'port-missing'
  | 'connection-lost'
  | 'verify-failed'
  | 'backup-failed'
  | 'extras-lost'
  | 'too-large'
  | 'bad-image'
  | 'protocol'
  | 'aborted'
  | 'unsupported'
  | 'download-failed'
  | 'unknown';

/** Something the UI can offer as a button next to the steps. */
export type FlashProblemAction =
  /** Desktop app on Linux: set up USB access once (SerialAccess.setupAccess of the desktop platform). */
  | { kind: 'usb-access-setup'; label: string }
  /** Open a web page, e.g. the CH340 driver download. */
  | { kind: 'link'; label: string; url: string }
  /** Run flashFirmware again with ignoreUsbMismatch: true. */
  | { kind: 'flash-anyway'; label: string };

export interface FlashProblem {
  code: FlashProblemCode;
  /** Short German headline. */
  title: string;
  /** What happened and why, in plain German. */
  explanation: string;
  /** What to try, most likely fix first. */
  steps: string[];
  /** Optional button for the most likely fix. */
  action?: FlashProblemAction;
  /** A web address the steps point to, shown as a link under them. */
  link?: { label: string; url: string };
  /** Technical details (English) for the forum or support. */
  technical?: string;
}

export type HostOs = 'linux' | 'windows' | 'macos' | 'other';

export interface FlashFirmwareOptions {
  serial: SerialAccess;
  port: SerialPortInfo;
  board: BoardId | BoardInfo;
  /** A parsed HEX file (keeps its start address) or plain bytes starting at address 0. */
  image: Uint8Array | HexImage;
  /** Read everything back and compare (default true). */
  verify?: boolean;
  signal?: AbortSignal;
  onStatus?: (status: FlashStatus) => void;
  /** Platform.os, so problem texts can name the right steps. */
  os?: HostOs;
  /** Protocol timing overrides (tests, slow adapters). */
  timing?: Partial<Stk500Timing>;
  /**
   * Flash even when the chip fits but the port's USB ids belong to another
   * board with the same chip (Classic Nano and AiO both report the ATmega328P
   * signature). Default false: stop before writing and explain.
   */
  ignoreUsbMismatch?: boolean;
  /**
   * Read the firmware on the box before writing (default false), so it can
   * be put back: a ready-made build lacks what a tinkerer changed in theirs.
   * It comes back with the result, also when writing fails later.
   */
  backup?: boolean;
  /**
   * With `backup`: looks at the old firmware before anything is written and
   * may stop the upload (e.g. extras the new firmware drops). Runs while the
   * bootloader waits, which gives up after about a second, so it must be
   * quick. A check that throws lets the upload go on.
   */
  checkBackup?: (backup: FirmwareBackup) => Promise<FlashProblem | undefined>;
}

/** The firmware that was on the box, read before writing. Erased bytes at its end are left out. */
export interface FirmwareBackup {
  data: Uint8Array;
  startAddress: number;
}

export interface FlashSuccess {
  ok: true;
  baud: number;
  signature: number[];
  /** Bootloader version from GET_PARAMETER, e.g. "8.0" (Optiboot) or "1.16" (old Nano bootloader). */
  bootloaderVersion?: string;
  bytesWritten: number;
  verified: boolean;
  durationMs: number;
  /** With `backup`: the firmware that was on the box before. */
  backup?: FirmwareBackup;
}

export type FlashResult = FlashSuccess | { ok: false; problem: FlashProblem; backup?: FirmwareBackup };

/** Flashes `image` onto the box. Never throws; failures come back as a FlashProblem. */
export async function flashFirmware(opts: FlashFirmwareOptions): Promise<FlashResult> {
  const kept: { backup?: FirmwareBackup } = {};
  const result = await flashAttempts(opts, kept);
  return !result.ok && kept.backup ? { ...result, backup: kept.backup } : result;
}

/** The baud rate attempts; a backup read on the way lands in `kept`. */
async function flashAttempts(opts: FlashFirmwareOptions, kept: { backup?: FirmwareBackup }): Promise<FlashResult> {
  const started = Date.now();
  let board: BoardInfo;
  try {
    board = resolveBoard(opts.board);
  } catch (e) {
    return fail(describeFlashError(e, { os: opts.os }));
  }
  if (board.method !== 'stk500') return fail(unsupported(board));

  const fit = fitImage(opts.image, board);
  if ('problem' in fit) return fail(fit.problem);

  const verify = opts.verify ?? true;
  const hold = board.holdPlayPause;
  /** How far the upload got: a cancel before writing leaves the box as it was. */
  let step: FlashStep = 'connect';
  const report = (status: FlashStatus) => {
    step = status.step;
    try {
      opts.onStatus?.(status);
    } catch {
      // A broken progress callback must not break the upload.
    }
  };
  const stk: Stk500Options = { timing: opts.timing, signal: opts.signal };
  const tried: number[] = [];
  const ctx = (): ProblemContext => ({ board, os: opts.os, port: opts.port, baudRates: [...tried], step });
  let lastError: unknown = new FlashError('no-sync', 'no baud rate tried');
  let strangeSignature: FlashError | undefined;

  for (const [attempt, baud] of board.flash.baudRates.entries()) {
    // Another attempt only follows when nothing was written yet.
    if (opts.signal?.aborted) return fail(aborted('connect'));
    tried.push(baud);
    report({ step: 'connect', baud, progress: 0, message: attempt === 0 ? 'Verbindung zur Box wird aufgebaut …' : 'Neuer Versuch mit anderer Geschwindigkeit …' });

    let conn: SerialConnection;
    try {
      conn = await opts.serial.open(opts.port, baud);
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) return fail(aborted('connect'));
      return fail(portProblem(e, 'open', ctx()));
    }

    try {
      await resetBoard(conn, stk);
      report({ step: 'sync', baud, progress: 0, message: hold ? 'Warte auf die Box … Halte Play/Pause gedrückt.' : 'Warte auf die Box …' });
      await sync(conn, stk);

      const signature = await readSignature(conn, stk);
      if (signature.some((b, i) => b !== board.flash.signature[i])) {
        if (signatureToChip(signature)) {
          return fail(describeFlashError(new FlashError('signature', `device signature ${formatBytes(signature)}`, { signature }), ctx()));
        }
        // Unknown bytes: maybe noise at the wrong speed. Try the next baud rate.
        strangeSignature = new FlashError('signature', `unknown device signature ${formatBytes(signature)} at ${baud} baud`, { signature });
        continue;
      }

      // The signature cannot tell a Classic Nano from an AiO; the USB chip can.
      const twins = usbSuggests(board, opts.port).filter((b) => b.method === 'stk500' && sameChip(b, board));
      if (twins.length && !opts.ignoreUsbMismatch) return fail(usbMismatch(board, twins, opts.port));

      const bootloaderVersion = await readBootloaderVersion(conn, stk);
      const p = board.flash;
      // A firmware for the new bootloader does not fit behind the old one (Classic Nano).
      const room = maxBytesAt(p, baud);
      const needs = fit.image.startAddress + fit.image.data.length - p.appStart;
      if (needs > room) return fail(tooLargeForBootloader(board, needs, room, bootloaderVersion));
      const keepHolding = hold ? ' Play/Pause weiter gedrückt halten.' : '';
      // The bar follows the bytes that go over the cable: the old firmware read, the new one written and read back.
      const pages = alignedLength(fit.image, p.pageSize);
      const share = { backup: opts.backup ? room : 0, write: pages, verify: verify ? pages : 0 };
      const sum = share.backup + share.write + share.verify;
      const at = (before: number, part: number, weight: number) => (before + part * weight) / sum;

      if (opts.backup && !kept.backup) {
        try {
          const old = await readFlash(conn, p.appStart, room, {
            ...stk,
            pageSize: p.pageSize,
            byteAddressing: p.byteAddressing,
            onProgress: (done, total) =>
              report({ step: 'backup', baud, progress: at(0, total > 0 ? done / total : 1, share.backup), message: `Alte Firmware wird gesichert …${keepHolding}` }),
          });
          kept.backup = { data: withoutErasedEnd(old), startAddress: p.appStart };
        } catch (e) {
          if (e instanceof FlashError && (e.code === 'aborted' || e.code === 'port')) throw e;
          return fail(backupFailed(board, e));
        }
      }
      if (kept.backup && opts.checkBackup) {
        let stop: FlashProblem | undefined;
        try {
          stop = await opts.checkBackup(kept.backup);
        } catch {
          // A broken check does not stop the upload.
        }
        if (stop) return fail(stop);
      }

      const result = await flashImage(conn, fit.image, {
        ...stk,
        pageSize: p.pageSize,
        byteAddressing: p.byteAddressing,
        maxAddress: p.appStart + room,
        verify,
        onProgress: (phase, done, total) => {
          const part = total > 0 ? done / total : 1;
          if (phase === 'write') {
            report({ step: 'write', baud, progress: at(share.backup, part, share.write), message: `Firmware wird aufgespielt …${keepHolding}` });
          } else {
            report({ step: 'verify', baud, progress: at(share.backup + share.write, part, share.verify), message: `Firmware wird geprüft …${keepHolding}` });
          }
        },
      });

      report({ step: 'done', baud, progress: 1, message: hold ? 'Fertig! Du kannst Play/Pause jetzt loslassen.' : 'Fertig! Die Box startet mit der neuen Firmware.' });
      const success: FlashSuccess = {
        ok: true,
        baud,
        signature,
        bytesWritten: result.bytesWritten,
        verified: result.verified,
        durationMs: Date.now() - started,
      };
      if (bootloaderVersion) success.bootloaderVersion = bootloaderVersion;
      if (kept.backup) success.backup = kept.backup;
      return success;
    } catch (e) {
      if (e instanceof FlashError && e.code === 'no-sync') {
        lastError = e;
        continue;
      }
      return fail(describeFlashError(e, ctx()));
    } finally {
      await closeQuietly(conn);
    }
  }

  // Something that answered with a strange signature tells more than silence.
  return fail(describeFlashError(strangeSignature ?? lastError, ctx()));
}

function fail(problem: FlashProblem): FlashResult {
  return { ok: false, problem };
}

/** Bytes the pages of the image span (the flasher writes whole pages). */
function alignedLength(image: { data: Uint8Array; startAddress: number }, pageSize: number): number {
  const first = Math.floor(image.startAddress / pageSize) * pageSize;
  const end = Math.ceil((image.startAddress + image.data.length) / pageSize) * pageSize;
  return end - first;
}

/** The firmware without the erased (0xFF) flash behind it. */
function withoutErasedEnd(data: Uint8Array): Uint8Array {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0xff) end--;
  return data.slice(0, end);
}

async function closeQuietly(conn: SerialConnection): Promise<void> {
  try {
    await conn.close();
  } catch {
    // Already gone (unplugged): nothing left to close.
  }
}

async function readBootloaderVersion(conn: SerialConnection, stk: Stk500Options): Promise<string | undefined> {
  try {
    const major = await getParameter(conn, STK_PARAM.SW_MAJOR, stk);
    const minor = await getParameter(conn, STK_PARAM.SW_MINOR, stk);
    return `${major}.${minor}`;
  } catch (e) {
    if (e instanceof FlashError && (e.code === 'aborted' || e.code === 'port')) throw e;
    // Not essential: get back in step and carry on without the version.
    await sync(conn, stk);
    return undefined;
  }
}

type FittedImage = { image: { data: Uint8Array; startAddress: number } } | { problem: FlashProblem };

/** Checks that the image fits the board and drops an erased gap below the firmware start (AiO+). */
function fitImage(input: Uint8Array | HexImage, board: Stk500Board): FittedImage {
  const p: Stk500Params = board.flash;
  let data = input instanceof Uint8Array ? input : input.data;
  let start = input instanceof Uint8Array ? 0 : input.startAddress;
  if (data.length === 0) return { problem: badImage('Die Firmware-Datei ist leer.') };
  if (start < p.appStart) {
    const skip = Math.min(p.appStart - start, data.length);
    if (data.subarray(0, skip).some((b) => b !== 0xff)) {
      return {
        problem: badImage(
          `Diese Firmware ist für eine andere Platine gebaut: Sie beginnt an einer Stelle im Speicher, an der bei „${board.shortName}“ das Startprogramm (Bootloader) liegt.`,
          `image starts at 0x${start.toString(16)}, firmware area starts at 0x${p.appStart.toString(16)}`,
        ),
      };
    }
    data = data.subarray(skip);
    start += skip;
  }
  const size = start + data.length - p.appStart;
  if (size > largestFirmware(p)) {
    return { problem: tooLarge(board, size) };
  }
  if (data.length === 0) return { problem: badImage('Die Firmware-Datei enthält keine Daten.') };
  return { image: { data, startAddress: start } };
}

/* -------------------------------------------------------------- problems */

export interface ProblemContext {
  board?: BoardId | BoardInfo;
  os?: HostOs;
  /** The port that was used; its USB ids can reveal a wrongly selected board. */
  port?: SerialPortInfo;
  /** Baud rates that were tried without an answer. */
  baudRates?: number[];
  /** Where the upload was when it failed; a cancel explains what that left on the box. */
  step?: FlashStep;
}

const CABLE = 'Probiere ein anderes USB-Kabel. Viele Kabel laden nur und übertragen keine Daten.';
const HOLD_PLAY = 'Halte die Play/Pause-Taste gedrückt, bevor du das Aufspielen startest, und lasse sie erst los, wenn „Fertig“ erscheint.';
/** Third-party key boards wire Play/Pause to GND; only the PBP/PBN pads keep AiO boards powered (7946#8, 7946#12). */
const HOLD_PBP =
  'Prüfe, ob die Play/Pause-Taste an den Anschlüssen PBP und PBN der Platine hängt. Nur dann hält sie die Platine beim Aufspielen eingeschaltet. Liegt die Taste an GND, wie bei manchen Tastenplatinen, hilft das Halten nicht.';
const CLOSE_OTHERS =
  'Schließe die Arduino IDE, andere Programme mit seriellem Monitor (auch 3D-Drucker-Programme wie Cura) und Browser-Tabs mit anderen TonUINO-Seiten.';
const NO_HUB = 'Stecke die Box direkt am Computer ein, nicht über einen USB-Hub.';
const REPLUG = 'Ziehe das USB-Kabel ab, stecke es wieder ein und versuche es noch einmal.';
const RETRY = 'Versuche es noch einmal.';
const CH340_DRIVER =
  'Unter Windows braucht der USB-Chip vieler Nano-Nachbauten und der AiO+ (CH340) einmalig einen Treiber des Herstellers WCH. Klicke auf seiner englischen Seite auf „Download“, starte die Datei „CH341SER.EXE“ und klicke auf „INSTALL“. Stecke die Box danach neu ein.';
/**
 * The fix the TonUINO forum gives for "Failed to open serial port" on Windows
 * (thread 13551, in its FAQ): the newest CH340 driver needs SerEnum switched
 * on before a browser can open the port. The checkbox label is English.
 */
const CH340_SERENUM =
  'Mit dem neuesten CH340-Treiber braucht Windows eine Einstellung: Öffne im Geräte-Manager unter „Anschlüsse (COM & LPT)“ den Eintrag „USB-SERIAL CH340“. Wähle „Anschlusseinstellungen“ und „Erweitert …“, setze den Haken bei „Enabling the Serial Port Enumerator (SerEnum)“ und bestätige mit „OK“.';
const CH340_DRIVER_MAC =
  'Auf älteren Macs braucht der USB-Chip CH340 einmalig einen Treiber des Herstellers WCH. Klicke auf seiner englischen Seite auf „Download“, installiere den Treiber aus der ZIP-Datei und stecke die Box danach neu ein.';
const LINUX_BRLTTY =
  'Unter Ubuntu und Linux Mint belegt manchmal das Programm „brltty“ (für Braillezeilen) den Anschluss. Brauchst du keine Braillezeile, entferne es im Terminal mit: sudo apt remove brltty';
const LINUX_ACCESS = [
  'Richte den USB-Zugriff einmalig ein. In der Desktop-App von TonUINO Studio geht das mit dem Knopf „USB-Zugriff einrichten“.',
  'Ohne Desktop-App gib im Terminal diesen Befehl ein und melde dich danach einmal ab und wieder an (bei manchen Systemen heißt die Gruppe „uucp“ statt „dialout“): sudo usermod -aG dialout $USER',
];
const USB_SETUP: FlashProblemAction = { kind: 'usb-access-setup', label: 'USB-Zugriff einrichten' };
const FORUM = 'Hilft das nicht, frage im TonUINO-Forum (discourse.voss.earth) und kopiere die technischen Details dazu.';

/** Turns any error from flashing or downloading into a FlashProblem. */
export function describeFlashError(error: unknown, ctx: ProblemContext = {}): FlashProblem {
  const board = ctx.board ? safeBoard(ctx.board) : undefined;
  if (error instanceof HexError) return badImage(error.message, `HexError ${error.reason} at line ${error.line}`);
  if (isAbortError(error)) return aborted(ctx.step);
  if (error instanceof FlashError) {
    switch (error.code) {
      case 'no-sync':
        return noAnswer(board, ctx, error);
      case 'signature':
        return wrongBoard(board, error.data.signature ?? [], error);
      case 'timeout':
        return connectionLost(board, error);
      case 'verify':
        return verifyFailed(error);
      case 'protocol':
        return {
          code: 'protocol',
          title: 'Die Box hat unerwartet geantwortet',
          explanation: 'Die Verbindung ist gestört, oder an diesem Anschluss hängt keine TonUINO-Platine.',
          steps: [CABLE, 'Prüfe, ob die richtige Platine und der richtige Anschluss ausgewählt sind.', NO_HUB, RETRY],
          technical: error.detail,
        };
      case 'too-large':
        return board?.method === 'stk500' && error.data.address !== undefined
          ? tooLarge(board, error.data.address - board.flash.appStart)
          : {
              code: 'too-large',
              title: 'Die Firmware ist zu groß für diese Platine',
              explanation: 'Die Firmware passt nicht in den Speicher der Platine.',
              steps: ['Prüfe, ob die richtige Platine ausgewählt ist.', 'Nimm eine fertige Firmware für diese Platine.'],
              technical: error.detail,
            };
      case 'aborted':
        return aborted(ctx.step);
      case 'port': {
        const problem = portProblem(error.cause ?? error.detail, 'transfer', ctx);
        return { ...problem, technical: error.detail };
      }
    }
  }
  return {
    code: 'unknown',
    title: 'Etwas ist schiefgelaufen',
    explanation: 'Beim Aufspielen ist ein unerwarteter Fehler aufgetreten.',
    steps: [RETRY, FORUM],
    technical: errorText(error),
  };
}

function noAnswer(board: BoardInfo | undefined, ctx: ProblemContext, error: FlashError): FlashProblem {
  const bauds = ctx.baudRates ?? [];
  const hold = board?.method === 'stk500' && board.holdPlayPause;
  const others = usbSuggests(board, ctx.port);
  const parts = ['TonUINO Studio hat die Box über USB gerufen, aber keine Antwort bekommen.'];
  if (others.length) parts.push(`Der USB-Anschluss gehört eher zu ${orList(others.map((b) => `„${b.shortName}“`))} als zu „${board?.shortName}“.`);
  if (hold) parts.push(`Bei der ${board?.shortName}-Platine ist der häufigste Grund, dass die Play/Pause-Taste nicht die ganze Zeit gedrückt war. Dann geht die Platine aus.`);
  if (board?.id === 'classic' && bauds.length > 1) parts.push('Probiert wurden beide üblichen Geschwindigkeiten, für alte und neue Nanos.');

  const steps: string[] = [];
  if (others.length) steps.push(`Wähle ${orList(others.map((b) => `„${b.shortName}“`))} aus und starte noch einmal.`);
  if (hold) steps.push(HOLD_PLAY, HOLD_PBP);
  steps.push(CABLE);
  if (!others.length) {
    steps.push(
      board
        ? `Ausgewählt ist „${board.shortName}“. Prüfe, ob das wirklich deine Platine ist (Classic, AiO oder AiO+).`
        : 'Prüfe, ob die richtige Platine ausgewählt ist (Classic, AiO oder AiO+).',
    );
    if (board?.id === 'aio' || board?.id === 'aioplus') {
      steps.push('AiO (Version 1) und AiO+ (Version 2) sehen sich ähnlich, brauchen aber verschiedene Firmware.');
    }
  }
  steps.push(CLOSE_OTHERS);
  if (!hold) steps.push(REPLUG);
  steps.push(NO_HUB);
  if (hold) {
    steps.push(
      'Klappt es auch mit gedrückter Taste nie, ist vielleicht das Startprogramm (Bootloader) der Platine beschädigt. Dann frage im TonUINO-Forum (discourse.voss.earth) und kopiere die technischen Details dazu.',
    );
  }
  return {
    code: 'no-answer',
    title: 'Die Box antwortet nicht',
    explanation: parts.join(' '),
    steps,
    technical: `${error.detail}; tried ${bauds.length ? bauds.join(', ') : 'no'} baud${usbText(ctx.port)}`,
  };
}

/** Boards the port's USB ids point to when they do not fit the selected board. */
function usbSuggests(board: BoardInfo | undefined, port: SerialPortInfo | undefined): BoardInfo[] {
  if (!board || port?.usbVendorId === undefined) return [];
  const matches = boardsForUsb(port.usbVendorId, port.usbProductId);
  if (matches.length === 0 || matches.some((b) => b.id === board.id)) return [];
  // CH340 also sits on some ESP32 boards; those are updated over Wi-Fi anyway.
  const relevant = matches.filter((b) => b.method !== 'esp32');
  return relevant.length ? relevant : matches;
}

function sameChip(a: BoardInfo, b: Stk500Board): boolean {
  return a.method === 'stk500' && a.flash.signature.every((x, i) => x === b.flash.signature[i]);
}

/** Same chip, but the USB ids say it is another board: stop before writing the wrong build. */
function usbMismatch(board: Stk500Board, twins: BoardInfo[], port: SerialPortInfo): FlashProblem {
  const names = orList(twins.map((b) => `„${b.shortName}“`));
  return {
    code: 'wrong-board',
    title: 'Ist das wirklich die richtige Platine?',
    explanation: `Ausgewählt ist „${board.shortName}“, aber der USB-Anschluss gehört zu ${names}. Beide haben denselben Chip, brauchen aber verschiedene Firmware. Deshalb wurde noch nichts aufgespielt.`,
    steps: [`Wähle ${names} aus und starte noch einmal.`, `Bist du sicher, dass „${board.shortName}“ stimmt, kannst du trotzdem aufspielen.`],
    action: { kind: 'flash-anyway', label: 'Trotzdem aufspielen' },
    technical: `signature ${formatBytes(board.flash.signature)} fits ${board.id}${usbText(port)} points to ${twins.map((b) => b.id).join(', ')}`,
  };
}

function wrongBoard(board: BoardInfo | undefined, signature: number[], error: FlashError): FlashProblem {
  const guess = signatureToChip(signature);
  const selected = board ? ` Ausgewählt ist aber „${board.shortName}“.` : '';
  if (!guess) {
    return {
      code: 'wrong-board',
      title: 'Unbekannte Platine',
      explanation: `Die Box meldet eine unbekannte Kennung (${formatBytes(signature)}). Vielleicht ist die Verbindung gestört, oder es ist keine TonUINO-Platine.${selected}`,
      steps: ['Prüfe, ob die richtige Platine ausgewählt ist.', CABLE, RETRY],
      technical: error.detail,
    };
  }
  const candidates = guess.boards.map(safeBoardOrNull).filter((b): b is BoardInfo => b !== null && b.id !== board?.id);
  const flashable = candidates.filter((b) => b.method === 'stk500');
  const steps: string[] = [];
  if (flashable.length) steps.push(`Wähle ${orList(flashable.map((b) => `„${b.shortName}“`))} aus und starte noch einmal.`);
  else if (candidates.length) steps.push(`Wähle „${candidates[0].shortName}“ aus. Dort steht, wie du diese Platine bespielst.`);
  else steps.push('Für diesen Chip gibt es keine fertige TonUINO-Firmware. Prüfe, welche Platine in deiner Box steckt.');
  return {
    code: 'wrong-board',
    title: 'Das ist eine andere Platine',
    explanation: `Die Box meldet sich mit dem Chip ${guess.chip}. ${guess.hint}${selected}`,
    steps,
    technical: error.detail,
  };
}

function connectionLost(board: BoardInfo | undefined, error: FlashError): FlashProblem {
  const hold = board?.method === 'stk500' && board.holdPlayPause;
  const parts = ['Die Box hat mitten im Aufspielen aufgehört zu antworten.'];
  if (hold) parts.push('Meist wurde die Play/Pause-Taste zu früh losgelassen und die Platine ist ausgegangen.');
  parts.push('Keine Sorge: Das Startprogramm der Box bleibt dabei normalerweise erhalten. Du kannst es einfach noch einmal versuchen.');
  return {
    code: 'connection-lost',
    title: 'Die Verbindung ist abgebrochen',
    explanation: parts.join(' '),
    steps: [...(hold ? [HOLD_PLAY, HOLD_PBP] : []), CABLE, NO_HUB, RETRY],
    technical: error.detail,
  };
}

function backupFailed(board: BoardInfo, error: unknown): FlashProblem {
  const hold = board.method === 'stk500' && board.holdPlayPause;
  const parts = ['Beim Auslesen der alten Firmware hat die Box nicht mehr richtig geantwortet. Es wurde nichts verändert: Die alte Firmware ist noch auf der Box.'];
  if (hold) parts.push('Meist wurde die Play/Pause-Taste zu früh losgelassen.');
  return {
    code: 'backup-failed',
    title: 'Die alte Firmware ließ sich nicht sichern',
    explanation: parts.join(' '),
    steps: [
      ...(hold ? [HOLD_PLAY] : []),
      CABLE,
      NO_HUB,
      RETRY,
      'Klappt das Sichern nie, nimm den Haken bei „Alte Firmware vorher sichern“ heraus. Dann wird ohne Sicherung aufgespielt.',
    ],
    technical: errorText(error),
  };
}

function verifyFailed(error: FlashError): FlashProblem {
  const at = error.data.address !== undefined ? ` (an Stelle 0x${error.data.address.toString(16)})` : '';
  return {
    code: 'verify-failed',
    title: 'Die Prüfung hat Fehler gefunden',
    explanation: `Nach dem Aufspielen stimmt der Speicher der Box nicht mit der Firmware überein${at}. So läuft die Box vielleicht nicht richtig.`,
    steps: [
      'Spiele die Firmware noch einmal auf.',
      CABLE,
      NO_HUB,
      'Passiert es immer an derselben Stelle, ist der Speicher der Platine vielleicht beschädigt.',
    ],
    technical: error.detail,
  };
}

function tooLarge(board: BoardInfo, size: number): FlashProblem {
  const max = board.method === 'stk500' ? largestFirmware(board.flash) : 0;
  const steps = [
    `Prüfe, ob die richtige Platine ausgewählt ist (ausgewählt ist „${board.shortName}“).`,
    'Nimm eine fertige Firmware, die für diese Platine gebaut ist.',
  ];
  if (!board.variants.includes('5f')) steps.push(`Für „${board.shortName}“ gibt es keine Variante „${VARIANTS['5f'].label}“, dafür reicht der Speicher nicht.`);
  steps.push('Hast du die Firmware selbst gebaut, schalte Funktionen ab, die du nicht brauchst.');
  return {
    code: 'too-large',
    title: 'Die Firmware ist zu groß für diese Platine',
    explanation: `Die Firmware braucht ${size} Bytes, auf „${board.shortName}“ ist aber nur Platz für ${max} Bytes.`,
    steps,
    technical: `image ${size} bytes, limit ${max} bytes`,
  };
}

/**
 * The firmware fits the board, but not behind the bootloader that answered:
 * a Nano with the old bootloader keeps 2 KiB for it, the new one (Optiboot)
 * only 512 bytes. Nothing was written.
 */
function tooLargeForBootloader(board: BoardInfo, size: number, room: number, bootloaderVersion?: string): FlashProblem {
  return {
    code: 'too-large',
    title: 'Diese Firmware braucht einen Nano mit neuem Bootloader',
    explanation: `Dein Nano hat das alte Startprogramm (Bootloader). Es braucht mehr Speicher als das neue, darum ist nur Platz für ${room} Bytes, diese Firmware braucht ${size} Bytes. Auf der Box hat sich nichts geändert.`,
    steps: [
      'Nimm im Schritt „Firmware“ weniger Extras, zum Beispiel ohne Leuchtring. Dann passt die Firmware.',
      'Oder lasse dir den neuen Bootloader (Optiboot) auf den Nano spielen. Dafür brauchst du einen zweiten Arduino oder einen Programmer, frage im Forum nach Hilfe.',
    ],
    technical: `image ${size} bytes, ${board.shortName} bootloader${bootloaderVersion ? ` ${bootloaderVersion}` : ''} leaves ${room} bytes`,
  };
}

function badImage(explanation: string, technical?: string): FlashProblem {
  const problem: FlashProblem = {
    code: 'bad-image',
    title: 'Die Firmware-Datei passt nicht',
    explanation,
    steps: ['Lade die Firmware neu herunter.', 'Prüfe, ob die Datei zur ausgewählten Platine passt.'],
  };
  if (technical) problem.technical = technical;
  return problem;
}

const BEFORE_WRITING = 'Du hast abgebrochen, bevor etwas auf die Box geschrieben wurde. Sie startet wie vorher.';
const UNCHANGED = 'Auf die Box wurde nichts geschrieben. Sie startet wie vorher.';

/** What a cancel leaves on the box, by how far the upload got. */
const ABORTED: Record<FlashStep | 'download', string> = {
  download: `Du hast den Download abgebrochen. ${UNCHANGED}`,
  connect: BEFORE_WRITING,
  sync: BEFORE_WRITING,
  backup: `Du hast das Sichern der alten Firmware abgebrochen. ${UNCHANGED}`,
  write:
    'Du hast das Aufspielen mittendrin abgebrochen. Die Firmware ist nur zum Teil auf der Box, deshalb startet sie jetzt wahrscheinlich nicht richtig. Spiele die Firmware noch einmal auf, dann läuft die Box wieder.',
  verify: 'Du hast die Prüfung abgebrochen. Die Firmware ist schon ganz auf der Box, wurde aber nicht fertig geprüft. Startet die Box nicht richtig, spiele die Firmware noch einmal auf.',
  done: 'Das Aufspielen war schon fertig. Die Box startet mit der neuen Firmware.',
};

function aborted(step?: FlashStep | 'download'): FlashProblem {
  return {
    code: 'aborted',
    title: 'Abgebrochen',
    explanation: step ? ABORTED[step] : 'Du hast das Aufspielen abgebrochen. Startet die Box danach nicht mehr richtig, spiele die Firmware einfach noch einmal auf.',
    steps: [],
  };
}

function unsupported(board: BoardInfo): FlashProblem {
  if (board.method === 'unsupported') {
    return {
      code: 'unsupported',
      title: `„${board.shortName}“ kann ich nicht selbst bespielen`,
      explanation: board.reason,
      steps: [board.alternative],
    };
  }
  if (board.method === 'esp32') {
    return {
      code: 'unsupported',
      title: 'Die ESP32-Box bekommt ihre Firmware über WLAN',
      explanation: 'Boxen mit ESP32 haben eine eigene Webseite. Darüber spielst du die neue Firmware (firmware.bin) auf.',
      steps: [...board.update.steps],
    };
  }
  return { code: 'unsupported', title: 'Nicht unterstützt', explanation: 'Diese Platine wird nicht unterstützt.', steps: [] };
}

/* ----------------------------------------------------------- port errors */

type PortTrouble = 'permission' | 'busy' | 'missing' | 'other';

const PERMISSION_RE = /permission denied|EACCES|EPERM|operation not permitted|not permitted|SecurityError/i;
const MISSING_RE =
  /not found|no such file|no such device|ENOENT|ENXIO|ENODEV|device not configured|disconnected|has been lost|device lost|cannot find|nicht gefunden|nicht finden|nicht mehr da/i;
const BUSY_RE = /busy|in use|already open|locked|EBUSY|resource temporarily unavailable|access (?:is )?denied|zugriff verweigert|schon geöffnet|bereits geöffnet/i;

/**
 * Reads what the platform says about a port failure. The desktop platform
 * rejects with { code: 'permission' | 'busy' | 'not-found' | 'disconnected' |
 * 'closed', detail, hints }; the browser with an Error whose (German) message
 * names the cause; Node-style errors carry EACCES and friends.
 */
function inspectPortError(error: unknown): { trouble: PortTrouble; text: string; platformSteps: string[]; hintIds: string[] } {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; detail?: unknown; hints?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const text = [errorText(error), typeof e.detail === 'string' ? e.detail : ''].filter(Boolean).join(' | ');
  const haystack = `${code} ${text}`;
  let trouble: PortTrouble = 'other';
  if (code === 'permission') trouble = 'permission';
  else if (code === 'busy') trouble = 'busy';
  else if (code === 'not-found' || code === 'disconnected' || code === 'closed') trouble = 'missing';
  else if (PERMISSION_RE.test(haystack)) trouble = 'permission';
  else if (MISSING_RE.test(haystack)) trouble = 'missing';
  else if (BUSY_RE.test(haystack)) trouble = 'busy';
  return { trouble, text, platformSteps: hintSteps(e.hints), hintIds: hintIds(e.hints) };
}

/** Which advice the desktop platform attached (its ids, such as "linux-brltty"). */
function hintIds(hints: unknown): string[] {
  if (!Array.isArray(hints)) return [];
  return hints.flatMap((h) => (typeof h === 'object' && h !== null && typeof (h as { id?: unknown }).id === 'string' ? [(h as { id: string }).id] : []));
}

/** Advice the desktop platform attached to its error ({ text, command }), as steps. */
function hintSteps(hints: unknown): string[] {
  if (!Array.isArray(hints)) return [];
  const steps: string[] = [];
  for (const h of hints) {
    if (typeof h !== 'object' || h === null) continue;
    const { text, command } = h as { text?: unknown; command?: unknown };
    const parts = [typeof text === 'string' ? text : '', typeof command === 'string' ? command : ''].filter(Boolean);
    if (parts.length) steps.push(parts.join(' '));
  }
  return steps;
}

/**
 * Explains why a serial port did not open, with the same advice as the
 * firmware wizard. The Box-Logbuch uses it for its connection; without a
 * board, the port's USB ids decide whether the CH340 driver is worth a step.
 */
export function describePortError(error: unknown, ctx: ProblemContext = {}): FlashProblem {
  return portProblem(error, 'open', ctx);
}

/** Classifies a failure of the serial port itself. */
function portProblem(error: unknown, phase: 'open' | 'transfer', ctx: ProblemContext): FlashProblem {
  const { trouble, text, platformSteps, hintIds } = inspectPortError(error);
  const board = ctx.board ? safeBoard(ctx.board) : undefined;
  const hold = board?.method === 'stk500' && board.holdPlayPause;
  const os = ctx.os;
  // Driver steps only for a CH340: the port tells when it is known. FTDI and
  // CP210x adapters, and the AiO's own chip (HT42B534), need no CH340 driver.
  const ch340 = usesCh340(ctx.port, board);

  if (phase === 'transfer') {
    if (trouble === 'missing') {
      return {
        code: 'port-missing',
        title: 'Die Box ist nicht mehr verbunden',
        explanation: 'Die Verbindung zur Box ist mitten im Aufspielen verschwunden. Wurde das Kabel abgezogen oder ist die Box ausgegangen?',
        steps: [...platformSteps, 'Stecke die Box wieder ein und versuche es noch einmal.', ...(hold ? [HOLD_PLAY] : []), CABLE, NO_HUB],
        technical: text,
      };
    }
    return {
      code: 'connection-lost',
      title: 'Die Verbindung ist abgebrochen',
      explanation: 'Die Verbindung zur Box ist mitten im Aufspielen gestört worden.',
      steps: [...platformSteps, ...(hold ? [HOLD_PLAY] : []), CABLE, NO_HUB, RETRY],
      technical: text,
    };
  }

  if (trouble === 'permission') {
    // Serial ports are locked down this way almost only on Linux.
    if (os === 'linux' || os === undefined) {
      return {
        code: 'port-permission',
        title: 'Kein Zugriff auf den USB-Anschluss',
        explanation: 'Unter Linux darf nicht jedes Programm auf USB-Geräte zugreifen. Das musst du einmalig einrichten.',
        steps: [...(platformSteps.length ? platformSteps : LINUX_ACCESS), 'Stecke die Box danach neu ein und versuche es noch einmal.'],
        action: USB_SETUP,
        technical: text,
      };
    }
    return {
      code: 'port-permission',
      title: 'Kein Zugriff auf den USB-Anschluss',
      explanation: 'Dein Computer hat den Zugriff auf den USB-Anschluss verweigert.',
      steps: [...platformSteps, 'Erlaube den Zugriff, wenn dein Browser oder Computer danach fragt.', 'Stecke die Box neu ein, starte TonUINO Studio neu und versuche es noch einmal.'],
      technical: text,
    };
  }

  if (trouble === 'missing') {
    const steps = [...platformSteps, 'Stecke die Box wieder ein und wähle den Anschluss neu aus.', CABLE];
    let action: FlashProblemAction | undefined;
    if (ch340 && (os === 'windows' || os === undefined)) {
      steps.push(CH340_DRIVER);
      if (os === 'windows') action = driverLink('windows');
    }
    if (ch340 && os === 'macos') {
      steps.push(CH340_DRIVER_MAC);
      action = driverLink('macos');
    }
    if (os === 'linux' && platformSteps.length === 0) steps.push(LINUX_BRLTTY);
    // Name only the causes the steps below deal with.
    const driver = steps.includes(CH340_DRIVER) || steps.includes(CH340_DRIVER_MAC);
    const grabbed = steps.includes(LINUX_BRLTTY) || hintIds.includes('linux-brltty');
    const cause = driver ? ', oder es fehlt ein Treiber' : grabbed ? ', oder ein anderes Programm hat ihn belegt' : '';
    return withAction(
      {
        code: 'port-missing',
        title: 'Der Anschluss wurde nicht gefunden',
        explanation: `Der USB-Anschluss der Box ist nicht da. Vielleicht wurde das Kabel abgezogen${cause}.`,
        steps,
        technical: text,
      },
      action,
    );
  }

  if (trouble === 'busy') {
    return {
      code: 'port-busy',
      title: 'Der Anschluss ist belegt',
      explanation: 'Ein anderes Programm benutzt den USB-Anschluss der Box gerade.',
      steps: [...platformSteps, CLOSE_OTHERS, REPLUG],
      technical: text,
    };
  }

  // The browser only says "Failed to open serial port": busy, driver, a driver setting or access rights.
  const steps = [...platformSteps, CLOSE_OTHERS, REPLUG];
  let action: FlashProblemAction | undefined;
  if (ch340 && os === 'windows') steps.push(CH340_SERENUM);
  if (ch340 && (os === 'windows' || os === undefined)) {
    steps.push(CH340_DRIVER);
    if (os === 'windows') action = driverLink('windows');
  }
  if (os === 'linux') {
    steps.push(...LINUX_ACCESS);
    action = USB_SETUP;
  }
  const cause = ch340 && os === 'windows' ? ' Meist benutzt ihn gerade ein anderes Programm, oder dem CH340-Treiber fehlt eine Einstellung.' : ' Meist benutzt ihn gerade ein anderes Programm.';
  return withAction(
    {
      code: 'port-busy',
      title: 'Der Anschluss lässt sich nicht öffnen',
      explanation: `Der USB-Anschluss der Box lässt sich nicht öffnen.${cause}`,
      steps,
      technical: text,
    },
    action,
  );
}

function driverLink(os: 'windows' | 'macos'): FlashProblemAction {
  return { kind: 'link', label: 'CH340-Treiber herunterladen', url: CH340_DRIVER_URLS[os] };
}

function withAction(problem: FlashProblem, action: FlashProblemAction | undefined): FlashProblem {
  if (action) problem.action = action;
  return problem;
}

/* -------------------------------------------------------------- download */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** A failed download; `problem` is ready for the UI. */
export class FirmwareDownloadError extends Error {
  readonly problem: FlashProblem;

  constructor(problem: FlashProblem) {
    super(problem.explanation);
    this.name = 'FirmwareDownloadError';
    this.problem = problem;
  }
}

export interface FirmwareFile {
  url: string;
  /** e.g. "TonUINO_Classic_3.hex" */
  fileName: string;
  bytes: Uint8Array;
}

/**
 * Downloads a ready-made build as raw bytes (.hex, or .bin for ESP32).
 * `fetchFn` is injected so the desktop app can pass Platform.fetch.
 */
export async function downloadFirmwareFile(
  fetchFn: FetchFn,
  board: BoardId | BoardInfo,
  variant: ButtonVariant,
  signal?: AbortSignal,
): Promise<FirmwareFile> {
  const b = resolveBoard(board);
  if (!b.variants.includes(variant)) {
    throw new FirmwareDownloadError({
      code: 'download-failed',
      title: 'Diese Variante gibt es nicht',
      explanation: `Für „${b.shortName}“ gibt es keine fertige Firmware „${VARIANTS[variant].label}“.`,
      steps: [`Wähle eine dieser Varianten: ${b.variants.map((v) => VARIANTS[v].label).join(', ')}.`],
    });
  }
  const url = firmwareUrl(b, variant);
  let response: Response;
  try {
    response = await fetchFn(url, { cache: 'no-cache', signal });
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw new FirmwareDownloadError(aborted('download'));
    throw new FirmwareDownloadError(downloadProblem('Der Server mit der Firmware ist nicht erreichbar. Bist du mit dem Internet verbunden?', errorText(e), b, variant));
  }
  if (!response.ok) {
    throw new FirmwareDownloadError(
      downloadProblem(
        response.status === 404
          ? 'Diese Firmware liegt nicht (mehr) auf dem Server.'
          : `Der Server hat die Firmware nicht geliefert (Fehler ${response.status}).`,
        `GET ${url}: HTTP ${response.status}`,
        b,
        variant,
      ),
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw new FirmwareDownloadError(aborted('download'));
    throw new FirmwareDownloadError(downloadProblem('Der Download ist abgebrochen.', errorText(e), b, variant));
  }
  return { url, fileName: firmwareFileName(b, variant), bytes };
}

/** Downloads and parses a ready-made HEX build, ready for flashFirmware. */
export async function downloadFirmware(
  fetchFn: FetchFn,
  board: BoardId | BoardInfo,
  variant: ButtonVariant,
  signal?: AbortSignal,
): Promise<HexImage> {
  const b = resolveBoard(board);
  if (b.method === 'esp32') throw new FirmwareDownloadError(unsupported(b));
  const file = await downloadFirmwareFile(fetchFn, b, variant, signal);
  try {
    return parseIntelHex(file.bytes);
  } catch (e) {
    if (e instanceof HexError) {
      throw new FirmwareDownloadError({
        ...badImage(`Die heruntergeladene Datei ist beschädigt. ${e.message}`, `HexError ${e.reason} at line ${e.line} in ${file.url}`),
        steps: ['Versuche den Download noch einmal.', 'Alternativ: Lade die Datei unten direkt herunter und wähle sie dann als „Eigene Datei“ aus.'],
        link: directLink(b, variant),
      });
    }
    throw e;
  }
}

function downloadProblem(explanation: string, technical: string, b: BoardInfo, variant: ButtonVariant): FlashProblem {
  return {
    code: 'download-failed',
    title: 'Die Firmware konnte nicht geladen werden',
    explanation,
    steps: [
      'Prüfe deine Internetverbindung und versuche es noch einmal.',
      b.method === 'esp32'
        ? 'Alternativ: Lade die Datei unten direkt herunter und spiele sie dann wie beschrieben über die Webseite der Box auf.'
        : 'Alternativ: Lade die Datei unten direkt herunter und wähle sie dann als „Eigene Datei“ aus.',
    ],
    link: directLink(b, variant),
    technical,
  };
}

/** The ready-made file itself, for the browser to download when the app could not. */
function directLink(b: BoardInfo, variant: ButtonVariant): { label: string; url: string } {
  const url = firmwareUrl(b, variant);
  return { label: `${url.slice(url.lastIndexOf('/') + 1)} für ${b.shortName}, ${VARIANTS[variant].label} herunterladen`, url };
}

/* --------------------------------------------------------------- helpers */

function resolveBoard(board: BoardId | BoardInfo): BoardInfo {
  return typeof board === 'string' ? getBoard(board) : board;
}

function safeBoard(board: BoardId | BoardInfo): BoardInfo | undefined {
  return safeBoardOrNull(board) ?? undefined;
}

function safeBoardOrNull(board: BoardId | BoardInfo): BoardInfo | null {
  try {
    return resolveBoard(board);
  } catch {
    return null;
  }
}

/** "„A“", "„A“ oder „B“", "„A“, „B“ oder „C“" */
function orList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} oder ${items[items.length - 1]}`;
}

function usbText(port: SerialPortInfo | undefined): string {
  if (port?.usbVendorId === undefined) return '';
  const hex4 = (n: number) => n.toString(16).padStart(4, '0');
  return `; USB ${hex4(port.usbVendorId)}:${port.usbProductId === undefined ? '????' : hex4(port.usbProductId)}`;
}

function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
