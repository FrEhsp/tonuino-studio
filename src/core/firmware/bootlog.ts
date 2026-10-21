/**
 * Reads the serial log of a TonUINO box (115200 baud) while it arrives.
 *
 * BootLogParser takes chunks of any size (half lines, several lines, raw
 * bytes from the serial port) and turns complete lines into events:
 * the line itself with its parsed record and German explanation, a "boot"
 * event when the box (re)starts, and an "info" event whenever the collected
 * BoxInfo changes. Warnings and errors are collected as issues, grouped by
 * meaning and counted.
 */
import { explainReboot, explainRecord, rfidChip, type ExplainContext, type LineExplanation } from './logexplain';
import {
  parseLogLine,
  volumesValid,
  type BoxButtons,
  type BoxSettings,
  type FirmwareFamily,
  type LogRecord,
  type VolumeLevels,
} from './logline';
import type { BoardId } from './variants';

export { explainDfPlayerError, explainLine, explainRecord, explainReboot, rfidChip } from './logexplain';
export type { ExplainContext, ExplanationLevel, LineExplanation } from './logexplain';
export { EQ_NAMES, isGarbled, parseLogLine, splitPin, stripLogPrefix, volumesValid } from './logline';
export type { AdminLockKind, BoxButtons, BoxSettings, FirmwareFamily, LogRecord, SettingRecord, VolumeLevels } from './logline';

export interface RfidStatus {
  /** False when the reader does not answer. */
  ok: boolean;
  /** Value of the MFRC522 version register, when the firmware printed it (not on the AiO). */
  version?: number;
  chip: string;
}

export interface Mp3Status {
  /** False after "Com to DFPlayer broken". */
  connected: boolean;
  /** Number of files on the SD card as counted by the DFPlayer. */
  trackCount?: number;
}

export interface WifiStatus {
  /** station = connected to the home network, access-point = own network "TonUINO". */
  mode: 'station' | 'access-point';
  /** The configured home network, also when the box could not connect to it. */
  ssid?: string;
  ip?: string;
}

/** What the log tells about the box. Everything is optional because logs are often incomplete. */
export interface BoxInfo {
  firmware?: FirmwareFamily;
  /** "3.3.3" */
  version?: string;
  /** Build date as ISO date, "2026-09-17". */
  versionDate?: string;
  board?: BoardId;
  buttons?: BoxButtons;
  settings: BoxSettings;
  rfid?: RfidStatus;
  mp3?: Mp3Status;
  /** Track count per folder for the folders the box opened. */
  folderTracks: Record<number, number>;
  volume?: number;
  headphones?: boolean;
  wifi?: WifiStatus;
  batteryEmpty?: boolean;
}

export interface LogIssue {
  explanation: LineExplanation;
  /** How many lines reported it. */
  count: number;
  /** The first line that reported it. */
  line: string;
}

export type BootLogEvent =
  | { type: 'boot'; firmware: FirmwareFamily; /** A boot was already seen since the last reset(). */ unexpected: boolean }
  | { type: 'line'; line: string; record: LogRecord | null; explanation: LineExplanation | null }
  | { type: 'info'; info: BoxInfo };

export interface BootLogParserOptions {
  onEvent?: (event: BootLogEvent) => void;
  /** Lines longer than this are cut (default 4096 characters). */
  maxLineLength?: number;
  /** False skips the "info" events, and the copy of the info each one carries, when only lines and starts matter. */
  infoEvents?: boolean;
  /** Names of the folders on the card, for the cards the box reads (ExplainContext.folderTitle). */
  folderTitle?: (folder: number) => string | undefined;
}

const LEVEL_RANK = { error: 0, warn: 1, info: 2 } as const;

export class BootLogParser {
  private readonly onEvent?: (event: BootLogEvent) => void;
  private readonly maxLineLength: number;
  private readonly infoEvents: boolean;
  private readonly folderTitle?: (folder: number) => string | undefined;
  private decoder = new TextDecoder('utf-8');
  private pending = '';
  private state: BoxInfo = emptyInfo();
  private issueMap = new Map<string, LogIssue>();
  private lastFile: string | undefined;
  /** Last measured battery voltage; not in BoxInfo, since the box logs it every 2 s. */
  private batteryVolts: number | undefined;
  /** The last voltage line was a "BatVoltage low" one. */
  private batteryLow = false;
  private classicVolume: Partial<VolumeLevels> = {};
  private garbledStreak = 0;
  private boots = 0;
  private reboots = 0;
  /** Set by expectBoot(): the next start is one the app asked for. */
  private bootExpected = false;

  constructor(opts: BootLogParserOptions = {}) {
    this.onEvent = opts.onEvent;
    this.maxLineLength = Math.max(16, opts.maxLineLength ?? 4096);
    this.infoEvents = opts.infoEvents ?? true;
    this.folderTitle = opts.folderTitle;
  }

  /**
   * Feeds raw serial bytes (UTF-8) or text; use one kind per stream. Text may
   * also be messages of the ESP32 web console (/ws_serial), which wraps every
   * line in <pre>…</pre>. Returns the events of all lines this chunk completed.
   */
  push(chunk: string | Uint8Array): BootLogEvent[] {
    const text =
      typeof chunk === 'string' ? chunk.replaceAll('<pre>', '').replaceAll('</pre>', '\n') : this.decoder.decode(chunk, { stream: true });
    const events: BootLogEvent[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 0x0a && c !== 0x0d) continue;
      const line = this.pending + text.slice(start, i);
      this.pending = '';
      start = i + 1;
      this.handleLine(line, events);
    }
    this.pending += text.slice(start);
    while (this.pending.length > this.maxLineLength) {
      const line = this.pending.slice(0, this.maxLineLength);
      this.pending = this.pending.slice(this.maxLineLength);
      this.handleLine(line, events);
    }
    return events;
  }

  /** Treats whatever is left as a complete line (e.g. when the port closes). */
  flush(): BootLogEvent[] {
    const events: BootLogEvent[] = [];
    const line = this.pending + this.decoder.decode();
    this.pending = '';
    this.handleLine(line, events);
    return events;
  }

  /** Forgets everything, e.g. for a new connection that may lead to another box. The next boot is not "unexpected". */
  reset(): void {
    this.decoder = new TextDecoder('utf-8');
    this.pending = '';
    this.state = emptyInfo();
    this.issueMap.clear();
    this.lastFile = undefined;
    this.batteryVolts = undefined;
    this.batteryLow = false;
    this.classicVolume = {};
    this.garbledStreak = 0;
    this.boots = 0;
    this.reboots = 0;
    this.bootExpected = false;
  }

  /**
   * The app is about to restart the box (DTR reset): the next start is not
   * reported as unexpected and starts the count of restarts over. Unlike
   * reset(), what is known stays until that start arrives, so a box that does
   * not restart keeps its info and issues. Pass false when no start came.
   */
  expectBoot(expected = true): void {
    this.bootExpected = expected;
  }

  /** Snapshot of what is known about the box since the last boot. */
  get info(): BoxInfo {
    return structuredClone(this.state);
  }

  /** Warnings and errors since the last boot, errors first. */
  get issues(): LogIssue[] {
    return [...this.issueMap.values()]
      .map((i) => structuredClone(i))
      .sort((a, b) => LEVEL_RANK[a.explanation.level] - LEVEL_RANK[b.explanation.level]);
  }

  /** Number of boots seen since the parser was created or reset. */
  get bootCount(): number {
    return this.boots;
  }

  private emit(events: BootLogEvent[], event: BootLogEvent): void {
    events.push(event);
    try {
      this.onEvent?.(event);
    } catch {
      // A broken listener must not stop the parser in the middle of a chunk.
    }
  }

  private handleLine(raw: string, events: BootLogEvent[]): void {
    if (raw.trim() === '') return;
    const record = parseLogLine(raw);

    if (record?.kind === 'banner') this.startBoot(record.firmware, raw, events);

    let explanation: LineExplanation | null = null;
    if (record?.kind === 'garbled') {
      // A single line of noise is normal right after a reset; report a streak once.
      this.garbledStreak++;
      if (this.garbledStreak === 2) explanation = explainRecord(record, this.context());
    } else {
      this.garbledStreak = 0;
      if (record) explanation = explainRecord(record, this.context());
    }

    const changed = record !== null && this.apply(record);
    if (record) this.trackFile(record);
    if (explanation && explanation.level !== 'info') this.addIssue(explanation, raw);

    this.emit(events, { type: 'line', line: raw, record, explanation });
    if (changed && this.infoEvents) this.emit(events, { type: 'info', info: this.info });
  }

  private startBoot(firmware: FirmwareFamily, line: string, events: BootLogEvent[]): void {
    const unexpected = this.boots > 0 && !this.bootExpected;
    if (this.bootExpected) this.reboots = 0;
    this.bootExpected = false;
    this.boots++;
    this.state = emptyInfo();
    this.issueMap.clear();
    this.lastFile = undefined;
    this.batteryVolts = undefined;
    this.batteryLow = false;
    this.classicVolume = {};
    if (unexpected) {
      this.reboots++;
      this.issueMap.set('reboot', { explanation: explainReboot(this.reboots), count: this.reboots, line });
    }
    this.emit(events, { type: 'boot', firmware, unexpected });
  }

  private context(): ExplainContext {
    const ctx: ExplainContext = { settings: this.state.settings };
    if (this.folderTitle) ctx.folderTitle = this.folderTitle;
    if (this.state.board) ctx.board = this.state.board;
    if (this.state.firmware) ctx.firmware = this.state.firmware;
    if (this.state.buttons) ctx.buttons = this.state.buttons;
    if (this.lastFile) ctx.lastFile = this.lastFile;
    if (this.batteryVolts !== undefined) {
      ctx.batteryVolts = this.batteryVolts;
      ctx.batteryLow = this.batteryLow;
    }
    return ctx;
  }

  private addIssue(explanation: LineExplanation, line: string): void {
    const existing = this.issueMap.get(explanation.id);
    if (existing) {
      existing.count++;
      // Same meaning, newer facts: e.g. the battery warning names the last voltage the box measured.
      existing.explanation = explanation;
    } else this.issueMap.set(explanation.id, { explanation, count: 1, line });
  }

  private trackFile(record: LogRecord): void {
    if (record.kind === 'play') this.lastFile = `${pad(record.folder, 2)}/${pad(record.track, 3)}.mp3`;
    else if (record.kind === 'play-mp3') this.lastFile = `mp3/${pad(record.track, 4)}.mp3`;
    else if (record.kind === 'play-advert') this.lastFile = `advert/${pad(record.track, 4)}.mp3`;
    else if (record.kind === 'battery-voltage') {
      this.batteryVolts = record.volts;
      this.batteryLow = record.low;
    }
  }

  /** Applies a record to the box info. Returns true when something changed. */
  private apply(record: LogRecord): boolean {
    const s = this.state;
    switch (record.kind) {
      case 'banner':
        s.firmware = record.firmware;
        return true;
      case 'version':
        s.version = record.version;
        if (record.date) s.versionDate = record.date;
        return true;
      case 'hardware':
        s.board = record.board;
        s.buttons = record.buttons;
        return true;
      case 'setting':
        if (record.volumePart) {
          this.classicVolume[record.volumePart.field] = record.volumePart.value;
          const v = this.classicVolume;
          if (v.max === undefined || v.min === undefined || v.init === undefined) return false;
          const levels: VolumeLevels = { max: v.max, min: v.min, init: v.init };
          if (!volumesValid(levels)) return false;
          s.settings.speakerVolume = levels;
          return true;
        }
        if (Object.keys(record.patch).length === 0) return false;
        Object.assign(s.settings, record.patch);
        return true;
      case 'rfid-version':
        s.rfid = { version: record.version, ...rfidChip(record.version) };
        return true;
      case 'rfid-broken':
        s.rfid = { ...(s.rfid ?? { chip: 'keine Antwort' }), ok: false };
        return true;
      case 'mp3-broken':
        s.mp3 = { ...s.mp3, connected: false };
        return true;
      case 'track-count':
        s.mp3 = { connected: record.count > 0 ? true : (s.mp3?.connected ?? true), trackCount: record.count };
        return true;
      case 'folder-tracks':
        s.folderTracks[record.folder] = record.count;
        return true;
      case 'volume':
        s.volume = record.volume;
        return true;
      case 'headphones':
        s.headphones = record.plugged;
        return true;
      case 'wifi': {
        // A switch between home network and own access point starts over.
        const w: WifiStatus = s.wifi && s.wifi.mode === record.mode ? { ...s.wifi } : { mode: record.mode };
        if (record.ssid !== undefined) w.ssid = record.ssid;
        if (record.ip !== undefined) w.ip = record.ip;
        s.wifi = w;
        return true;
      }
      case 'battery-empty':
        s.batteryEmpty = true;
        return true;
      default:
        return false;
    }
  }
}

/** Reads a complete log and returns what it says about the box. */
export function parseBootLog(text: string): BoxInfo {
  return analyzeBootLog(text).info;
}

/** Reads a complete log: box info, issues (errors first) and the number of boots in it. */
export function analyzeBootLog(text: string): { info: BoxInfo; issues: LogIssue[]; bootCount: number } {
  const parser = new BootLogParser();
  parser.push(text);
  parser.flush();
  return { info: parser.info, issues: parser.issues, bootCount: parser.bootCount };
}

function emptyInfo(): BoxInfo {
  return { settings: {}, folderTracks: {} };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
