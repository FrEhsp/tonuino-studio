/**
 * What the extras of the Firmware-Baukasten show in the serial log, for a live
 * view in "Box testen". Pure logic: feed lines (as the Box-Logbuch gets them)
 * and get events.
 *
 * What TonUINO TNG (V3.3.3 17.09.26) logs at the default level (info), checked
 * in its source:
 * - mp3.cpp logVolume(): "Volume: n" whenever the volume is set: once at the
 *   start, on every volume command (also at the limit, then unchanged), after
 *   a headphone change, and for the potentiometer.
 * - poti.cpp: the potentiometer sets the volume directly (mp3.setVolume);
 *   its own line "poti volume: n" is debug level and not printed. So a
 *   "Volume" line without a volume command before it comes from the poti.
 * - rotary_encoder.cpp: a turn becomes a button press of its own: with 3
 *   buttons "up"/"down" with the factory setting IB:1 (settings.cpp: short
 *   press = volume), "upLong"/"downLong" with IB:0.
 *   commands.cpp logs it as "btn/cmd: upLong/volume_up" only while the box
 *   plays (in pause or idle those presses are shortcuts, not volume). Its
 *   lines "dt: … pos: …" and "Rot Env raw: …" are debug level. A held button
 *   logs the same first line, then "…LongRepeat" every 200 ms; so the first
 *   step of a held Vor/Zurück looks like a turn, a repeat never does.
 * - The AiO logs "btn/cmd" only at debug level (commands.cpp, as numbers):
 *   there no command line arrives, so an encoder turn shows as a volume of
 *   unknown cause.
 * - mp3.cpp hpjackdetect(): "hpJackDetect: 0|1", followed by "Volume: n" (the
 *   volume of the speaker or the headphones).
 * - led_manager.cpp begin(): with the LED buttons the start shows
 *   "LEDs(D/P/U): 5 19 6" and "NUM LEDS: 3" (info level).
 * - The ring logs nothing; the knob shows only through the volume. A
 *   firmware read from the box tells all extras: identifyBuild() in
 *   baukasten.ts.
 */
import { parseLogLine } from './logline';
import type { KnobKind } from './baukasten';

export type VolumeCause =
  /** The first volume after the box started. */
  | 'start'
  /** Turned at the knob (encoder or poti). */
  | 'knob'
  /** A volume button (or the first step of holding one, see above). */
  | 'button'
  /** A headphone was plugged in or out. */
  | 'headphones'
  /** Not clear from the log. */
  | 'unknown';

export type ExtrasEvent =
  | { kind: 'volume'; volume: number; previous?: number; cause: VolumeCause }
  | { kind: 'headphones'; plugged: boolean }
  /** The box started again; the live view starts over. */
  | { kind: 'restart' }
  /** The log proves an extra is in the firmware (the first time only). */
  | { kind: 'extra'; extra: 'ledButtons' | 'headphones' };

export interface ExtrasLogOptions {
  /** The knob of the flashed build, when there is one. */
  knob?: KnobKind;
}

/** A volume line this soon after its cause belongs to it (the box logs both in the same loop). */
const CAUSE_MS = 500;
/** A raw press within this time after the same press with "Repeat" is a held button. */
const HELD_MS = 400;

const ENCODER_RAWS = new Set(['upLong', 'downLong', 'up', 'down']);

export class ExtrasLogWatcher {
  /** The volume the box reported last. */
  volume?: number;
  /** Headphones plugged in, when the box said so. */
  headphones?: boolean;
  /** Extras the log has shown since the last start. */
  readonly seen = new Set<'ledButtons' | 'headphones'>();

  private readonly knob?: KnobKind;
  private started = false;
  private lastCommand?: { raw: string; at: number };
  private lastRepeatAt?: number;
  private lastHeadphonesAt?: number;

  constructor(opts: ExtrasLogOptions = {}) {
    this.knob = opts.knob;
  }

  /** Feeds one line; returns what it means for the extras, or undefined. */
  push(line: string, at: number): ExtrasEvent | undefined {
    if (/(^|\s|\])LEDs\(D\/P\/U\): \d+ \d+ \d+\s*$/.test(line)) return this.see('ledButtons');
    const rec = parseLogLine(line);
    if (!rec) return undefined;
    switch (rec.kind) {
      case 'banner':
        this.volume = undefined;
        this.headphones = undefined;
        this.seen.clear();
        this.started = true;
        this.lastCommand = undefined;
        this.lastRepeatAt = undefined;
        this.lastHeadphonesAt = undefined;
        return { kind: 'restart' };
      case 'button':
        if (rec.raw.endsWith('LongRepeat')) this.lastRepeatAt = at;
        if (rec.command === 'volume_up' || rec.command === 'volume_down') this.lastCommand = { raw: rec.raw, at };
        return undefined;
      case 'headphones': {
        this.headphones = rec.plugged;
        this.lastHeadphonesAt = at;
        // Only a firmware with headphone detection logs this; say so once, after the plug event.
        this.seen.add('headphones');
        return { kind: 'headphones', plugged: rec.plugged };
      }
      case 'volume': {
        const previous = this.volume;
        this.volume = rec.volume;
        const ev: ExtrasEvent = { kind: 'volume', volume: rec.volume, cause: this.cause(at) };
        if (previous !== undefined) ev.previous = previous;
        this.started = false;
        this.lastCommand = undefined;
        return ev;
      }
      default:
        return undefined;
    }
  }

  private see(extra: 'ledButtons' | 'headphones'): ExtrasEvent | undefined {
    if (this.seen.has(extra)) return undefined;
    this.seen.add(extra);
    return { kind: 'extra', extra };
  }

  private cause(at: number): VolumeCause {
    if (this.lastHeadphonesAt !== undefined && at - this.lastHeadphonesAt <= CAUSE_MS) {
      this.lastHeadphonesAt = undefined;
      return 'headphones';
    }
    const cmd = this.lastCommand && at - this.lastCommand.at <= CAUSE_MS ? this.lastCommand : undefined;
    if (!cmd) {
      if (this.started) return 'start';
      // Only the poti sets the volume without a command.
      return this.knob === 'poti' ? 'knob' : 'unknown';
    }
    const held = this.lastRepeatAt !== undefined && cmd.at - this.lastRepeatAt <= HELD_MS;
    if ((this.knob === 'encoder' || this.knob === 'encoderSkip') && ENCODER_RAWS.has(cmd.raw) && !cmd.raw.endsWith('Repeat') && !held) return 'knob';
    return 'button';
  }
}
