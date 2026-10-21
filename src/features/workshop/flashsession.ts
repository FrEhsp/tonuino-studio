/**
 * The firmware wizard's state between page visits: what is chosen, and the
 * upload that may be running. An upload keeps going when the user opens
 * another page; coming back shows its progress or result. The firmware that
 * was on the box before stays here too, so it can be saved or put back.
 */
import { signal } from '@preact/signals';
import { describeFlashError, flashFirmware, type FirmwareBackup, type FlashFirmwareOptions, type FlashProblem, type FlashResult, type FlashStatus, type FlashSuccess, type HostOs } from '../../core/firmware/flash';
import type { BoardId, BoardInfo } from '../../core/firmware/variants';
import type { SerialAccess, SerialPortInfo } from '../../platform/types';
import { writeGuard, type WriteGuard } from '../../app/writeguard';
import { portForRetry } from './ports';
import { prepareBackupCheck } from './extrasguard';
import { rememberFlashed } from './boxbuild';
import { applyGuess, backupChoice, backupFileName, goTo, initialWizard, type BoxGuess, type FirmwareChoice, type WizardState } from './wizard';

export interface StartFlash {
  serial: SerialAccess;
  port: SerialPortInfo;
  board: BoardInfo;
  firmware: FirmwareChoice;
  os: HostOs;
  ignoreUsbMismatch?: boolean;
  /** Save the firmware that is on the box first. */
  backup?: boolean;
  /** "Trotzdem aufspielen": no stop for extras the new firmware drops. */
  skipExtrasCheck?: boolean;
}

export type FlashRun =
  | { phase: 'idle' }
  | { phase: 'running'; status: FlashStatus; request: StartFlash }
  | { phase: 'done'; result: FlashSuccess; request: StartFlash }
  /** `request` lets the page try again, or flash anyway after a board warning. */
  | { phase: 'failed'; problem: FlashProblem; request: StartFlash };

/** The firmware that was on a box before the last upload. */
export interface SavedFirmware {
  board: BoardId;
  backup: FirmwareBackup;
  /** When it was read. */
  at: number;
  /** For "Sicherung speichern". */
  fileName: string;
}

export interface FlashSessionDeps {
  flash?: (opts: FlashFirmwareOptions) => Promise<FlashResult>;
  /** Asks before the app closes while the box is written: that can leave it without firmware. */
  guard?: Pick<WriteGuard, 'hold'>;
  now?: () => number;
  /** Passed to flashFirmware (tests use short timeouts). */
  timing?: FlashFirmwareOptions['timing'];
  /** After a successful upload. The app passes nothing: the "Pling" is for a finished SD card only (src/ui/sound.ts). */
  done?: () => void;
  /** Loads the check of the old firmware before writing (extrasguard.ts); none in tests unless given. */
  prepareCheck?: (request: StartFlash) => Promise<((backup: FirmwareBackup) => Promise<FlashProblem | undefined>) | undefined>;
  /** After a successful upload, with what went on the box (to remember a Baukasten build). */
  flashed?: (request: StartFlash) => void;
}

export class FlashSession {
  readonly wizard = signal<WizardState>(initialWizard());
  readonly run = signal<FlashRun>({ phase: 'idle' });
  /** The port chosen last; kept for the next visit. */
  readonly port = signal<SerialPortInfo | undefined>(undefined);
  /** True when "Noch einmal versuchen" did not find the box again: the flash step asks to choose it. */
  readonly portGone = signal(false);
  /** The firmware that was on the box before the last upload with a backup. */
  readonly saved = signal<SavedFirmware | null>(null);
  /** "Alte Firmware vorher sichern" (on by default). */
  readonly backupWanted = signal(true);
  /** What the box told about itself (Box-Logbuch or "Box erkennen"), for the hints of the later steps. */
  readonly guess = signal<{ from: 'logbook' | 'probe'; guess: BoxGuess } | null>(null);

  private abort: AbortController | null = null;
  private readonly flash: (opts: FlashFirmwareOptions) => Promise<FlashResult>;
  private readonly guard: Pick<WriteGuard, 'hold'>;
  private readonly now: () => number;
  private readonly timing: FlashFirmwareOptions['timing'];
  private readonly done: () => void;
  private readonly prepareCheck: FlashSessionDeps['prepareCheck'];
  private readonly flashed: FlashSessionDeps['flashed'];

  constructor(deps: FlashSessionDeps = {}) {
    this.flash = deps.flash ?? flashFirmware;
    this.guard = deps.guard ?? writeGuard;
    this.now = deps.now ?? Date.now;
    this.timing = deps.timing;
    // No "Pling" here: it is for a finished SD card only (Frank, 11.10.2026).
    this.done = deps.done ?? (() => {});
    this.prepareCheck = deps.prepareCheck;
    this.flashed = deps.flashed;
  }

  /** Runs the upload; progress and result land in `run`. Never throws; a second start while one runs is ignored. */
  async start(request: StartFlash): Promise<void> {
    if (this.run.value.phase === 'running') return;
    const abort = new AbortController();
    this.abort = abort;
    this.portGone.value = false;
    this.run.value = {
      phase: 'running',
      request,
      status: { step: 'connect', baud: 0, progress: 0, message: 'Verbindung zur Box wird aufgebaut …' },
    };
    // Closing the app asks first once the box is being written; before that it stays as it was.
    let release: (() => void) | undefined;
    try {
      let result: FlashResult;
      try {
        let checkBackup: FlashFirmwareOptions['checkBackup'];
        try {
          checkBackup = await this.prepareCheck?.(request);
        } catch {
          // Without the check the upload goes on as before.
        }
        result = await this.flash({
          serial: request.serial,
          port: request.port,
          board: request.board,
          image: request.firmware.image,
          os: request.os,
          signal: abort.signal,
          ignoreUsbMismatch: request.ignoreUsbMismatch,
          backup: request.backup,
          checkBackup,
          timing: this.timing,
          onStatus: (status) => {
            if (!release && (status.step === 'write' || status.step === 'verify')) release = this.guard.hold('firmware');
            this.run.value = { phase: 'running', request, status };
          },
        });
      } catch (e) {
        // flashFirmware does not throw; this is for an injected one that does.
        result = { ok: false, problem: describeFlashError(e, { board: request.board, os: request.os, port: request.port }) };
      }
      const backup = result.backup;
      if (backup) {
        const at = this.now();
        this.saved.value = { board: request.board.id, backup, at, fileName: backupFileName(request.board, at) };
      }
      this.run.value = result.ok ? { phase: 'done', result, request } : { phase: 'failed', problem: result.problem, request };
      if (result.ok) {
        this.done();
        try {
          this.flashed?.(request);
        } catch {
          // Only a memory for later; the upload worked.
        }
      }
    } finally {
      if (this.abort === abort) this.abort = null;
      release?.();
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  /**
   * Tries again after a failure. The box may be under another port by now
   * (a pulled cable gives it a new one), so the port is looked up again;
   * when that is not clear, the flash step asks for it.
   */
  async retry(patch: Partial<StartFlash> = {}): Promise<void> {
    const run = this.run.value;
    if (run.phase !== 'failed') return;
    await this.again(run, { ...run.request, ...patch });
  }

  /**
   * Puts the saved firmware back on the box, without saving again. From a
   * result the port is looked up again like for retry(); from the flash step
   * `request` brings the chosen port.
   */
  async restore(request?: Omit<StartFlash, 'firmware'>): Promise<void> {
    const run = this.run.value;
    const base = request ?? (run.phase === 'done' || run.phase === 'failed' ? run.request : undefined);
    const saved = this.saved.value;
    // An empty backup: there was no firmware on the box to put back.
    if (!base || !saved || saved.board !== base.board.id || !saved.backup.data.length) return;
    // The saved firmware came from this box, so its USB ids are no reason to stop.
    const restore: StartFlash = { ...base, firmware: backupChoice(saved.backup, saved.board, saved.fileName), backup: false, ignoreUsbMismatch: true };
    if (request) await this.start(restore);
    else await this.again(run, restore);
  }

  private async again(run: FlashRun, request: StartFlash): Promise<void> {
    let ports: SerialPortInfo[] = [];
    try {
      ports = await request.serial.list();
    } catch {
      // Not listable right now: then the user chooses.
    }
    if (this.run.value !== run) return;
    const port = portForRetry(ports, request.port, request.board);
    if (!port) {
      this.port.value = undefined;
      this.portGone.value = true;
      this.run.value = { phase: 'idle' };
      this.wizard.value = goTo(this.wizard.value, 'flash');
      return;
    }
    this.port.value = port;
    await this.start({ ...request, port });
  }

  /** Takes over what the box told about itself; with `fresh` the wizard starts over at the board step. */
  useGuess(guess: BoxGuess, from: 'logbook' | 'probe', fresh = false): void {
    if (this.run.value.phase === 'running') return;
    if (fresh) this.reset();
    this.guess.value = { from, guess };
    this.wizard.value = applyGuess(this.wizard.value, guess);
  }

  /** Back to the wizard after a result; keeps the choices. */
  dismiss(): void {
    if (this.run.value.phase !== 'running') this.run.value = { phase: 'idle' };
  }

  /** A fresh start, e.g. for a box with another board. */
  reset(): void {
    if (this.run.value.phase === 'running') return;
    this.wizard.value = initialWizard();
    this.run.value = { phase: 'idle' };
    this.portGone.value = false;
    this.guess.value = null;
  }
}

/** One session for the whole app, so an upload survives a visit to another page. */
export const flashSession = new FlashSession({ prepareCheck: prepareBackupCheck, flashed: rememberFlashed });
