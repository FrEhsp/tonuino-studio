/**
 * Guided calibration of the battery measurement (TNG from 26.10.2026, TNG
 * PR #343): a box built with BAT_VOLTAGE_MEASUREMENT_CALIBRATION logs its
 * voltage every 2 s in millivolts ("BatVoltage: 3712", batVoltage.cpp) and
 * takes "BAT <mV>" on the serial line (serial_input.cpp): the voltage a meter
 * shows at the battery. In Idle or Pause (state_machine.cpp) it scales its
 * correction factor by meter/box, saves it in the EEPROM and logs
 * "Bat Volt Corr set: <n>". While playing, the line is ignored. A build with
 * the old method (…_CALIBRATION_NANO) logs the same lines but never answers.
 *
 * Two things of TNG of 26.10.2026 the box simulator showed with the real
 * firmware (scripts/firmware/boxsim.c):
 * - serial_input.cpp reads the word with readBytesUntil(' ', cmdWord, 4),
 *   which does not end the string: cmdWord[3] is whatever the stack held, and
 *   "BAT 3700" was ignored. The app sends "BAT", a NUL and then " 3700": the
 *   four bytes fill cmdWord to "BAT", and parseInt skips the space. A fixed
 *   firmware reads the same.
 * - On Arduino boards (16-bit int) the measurement overflows
 *   (tngstands.ts batteryMathBrokenOnAvr): the box reads some 30 mV. Then the
 *   app does not send anything (readingProblem).
 *
 * The factor stays in the EEPROM when the normal build (without calibration)
 * goes on the box afterwards; the calibration build does not switch off on an
 * empty battery, so it should not stay.
 */
import type { BoxInfo } from './bootlog';
import type { LogRecord } from './logline';
import { TNG_STANDS, compareStand, knownStand } from './tngstands';

/** Whether the Box-Logbuch offers the calibration: only for a box that logs millivolts on a firmware that can take "BAT". */
export function calibrationOffered(info: BoxInfo): boolean {
  if (!info.batteryCalibration || info.firmware === 'classic21') return false;
  if (!info.version) return true;
  const first = TNG_STANDS.find((s) => s.batCalibration);
  const order = first ? compareStand({ version: info.version, date: info.versionDate }, first) : undefined;
  // An older state never logs millivolts; the same number without a date is let through.
  return order === undefined || order >= 0;
}

export type MeterReading = { ok: true; millivolts: number } | { ok: false; problem: string };

/**
 * Reads what the meter shows: volts ("3,71", "3.71 V") or millivolts
 * ("3710", "3710 mV"). The firmware takes 1..9999 mV.
 */
export function readMeter(input: string): MeterReading {
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t) return { ok: false, problem: 'Trage ein, was dein Messgerät anzeigt, zum Beispiel 3,71.' };
  const m = /^(\d+(?:[.,]\d+)?) ?(m?v)?$/i.exec(t);
  if (!m) return { ok: false, problem: 'Das ist keine Zahl. Schreibe den Wert so: 3,71' };
  const n = Number(m[1].replace(',', '.'));
  const unit = m[2]?.toLowerCase();
  const millivolts = Math.round(unit === 'mv' || (!unit && n >= 100) ? n : n * 1000);
  if (millivolts < 1000 || millivolts > 9999) return { ok: false, problem: 'Der Wert passt nicht zu einem Akku. Gib die Spannung in Volt an, zum Beispiel 3,71.' };
  return { ok: true, millivolts };
}

/** The line for the serial port: "BAT", NUL, " 3700" (see above: the NUL ends the word the firmware reads). */
export function batLine(millivolts: number): string {
  return `BAT\u0000 ${millivolts}`;
}

/** How the line shows in the Box-Logbuch. */
export function batNote(millivolts: number): string {
  return `Schicke der Box den Messwert: BAT ${millivolts}`;
}

/** Below this the box could not run: the reading is wrong, not the battery. */
const IMPLAUSIBLE_MV = 1500;

/**
 * Why the box's own reading cannot be calibrated, or undefined. A factor
 * from a reading far off is no use (and above 10000 the firmware drops it).
 */
export function readingProblem(boxMillivolts: number | undefined, info: Pick<BoxInfo, 'board' | 'version' | 'versionDate'>): string | undefined {
  if (boxMillivolts === undefined || boxMillivolts >= IMPLAUSIBLE_MV) return undefined;
  const esp32 = info.board === 'esp32nano' || info.board === 'esp32wroom';
  if (!esp32 && knownStand({ version: info.version, date: info.versionDate })?.batteryMathBrokenOnAvr) {
    return `Die Box misst ${voltsText(boxMillivolts)}. Das liegt an der Firmware: TonUINO TNG vom 26.10.2026 rechnet die Akku-Messung auf dieser Platine falsch. Ein Abgleich hilft da nicht. Lasse die Akku-Messung aus, bis eine neue Firmware das behebt.`;
  }
  return `Die Box misst nur ${voltsText(boxMillivolts)}. So niedrig kann die Spannung nicht sein, sonst liefe die Box nicht. Prüfe die zwei Widerstände der Messung und ihre Kabel zum Akku und zum Messpin.`;
}

/** "3,71 V" */
export function voltsText(millivolts: number): string {
  return `${(millivolts / 1000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} V`;
}

/**
 * A big gap between meter and box is more often a typo or a probe at the
 * wrong place than a divider that far off. Undefined when they are close.
 */
export function gapWarning(meter: number, box: number | undefined): string | undefined {
  if (!box) return undefined;
  if (Math.abs(meter - box) / box <= 0.25) return undefined;
  return `Die Box misst ${voltsText(box)}, dein Messgerät ${voltsText(meter)}. Das ist ein großer Unterschied. Miss direkt an den Polen des Akkus und prüfe den Wert noch einmal.`;
}

export type CalibrationStatus =
  | { kind: 'idle' }
  | { kind: 'waiting'; sentAt: number; millivolts: number }
  | { kind: 'done'; correction: number; millivolts: number }
  /** No answer: the box was playing, or it is a build of the old method that only shows the voltage. */
  | { kind: 'no-answer' };

/** How long to wait for "Bat Volt Corr set" (the box answers within a loop, well under a second). */
export const ANSWER_MS = 4000;

/** Follows the lines of one calibration: the box's voltage and its answer to "BAT". */
export class BatCalibration {
  /** The last voltage the box logged, in millivolts. */
  boxMillivolts: number | undefined;
  status: CalibrationStatus = { kind: 'idle' };

  /** Feeds one log record; true when something the page shows changed. */
  feed(record: LogRecord | null): boolean {
    if (!record) return false;
    if (record.kind === 'battery-voltage' && record.millivolts !== undefined) {
      const changed = record.millivolts !== this.boxMillivolts;
      this.boxMillivolts = record.millivolts;
      return changed;
    }
    if (record.kind === 'battery-correction' && this.status.kind === 'waiting') {
      this.status = { kind: 'done', correction: record.value, millivolts: this.status.millivolts };
      return true;
    }
    if (record.kind === 'banner') {
      // The box started again: a question still open is lost.
      if (this.status.kind === 'waiting') this.status = { kind: 'no-answer' };
      return true;
    }
    return false;
  }

  /** Marks the line as sent; returns it. */
  send(millivolts: number, now: number): string {
    this.status = { kind: 'waiting', sentAt: now, millivolts };
    return batLine(millivolts);
  }

  /** Call now and then; true when the wait ran out. */
  tick(now: number): boolean {
    if (this.status.kind !== 'waiting' || now - this.status.sentAt < ANSWER_MS) return false;
    this.status = { kind: 'no-answer' };
    return true;
  }

  /** How close the box comes to the meter now (after a calibration it takes some seconds to settle: it averages over five readings). */
  settled(): boolean {
    if (this.status.kind !== 'done' || this.boxMillivolts === undefined) return false;
    return Math.abs(this.boxMillivolts - this.status.millivolts) <= 30;
  }
}

/** What to say about the box's answer. */
export function statusText(status: CalibrationStatus): { tone: 'info' | 'ok' | 'warning'; text: string } | undefined {
  switch (status.kind) {
    case 'idle':
      return undefined;
    case 'waiting':
      return { tone: 'info', text: `Ich schicke ${voltsText(status.millivolts)} an die Box …` };
    case 'done':
      return {
        tone: 'ok',
        text: `Fertig. Die Box hat den neuen Korrekturwert ${status.correction} gespeichert. In etwa zehn Sekunden zeigt sie ungefähr ${voltsText(status.millivolts)}.`,
      };
    case 'no-answer':
      return {
        tone: 'warning',
        text: 'Die Box hat nicht geantwortet. Halte die Musik an und versuche es noch einmal: Während sie spielt, nimmt die Box den Wert nicht an. Antwortet sie dann auch nicht, zeigt diese Firmware die Spannung nur an. Den Wert trägst du dann selbst in die Firmware ein.',
      };
  }
}

/** After the calibration: the calibration build stays only for calibrating. */
export const AFTER_CALIBRATION =
  'Spiele danach wieder deine normale Firmware auf (mit Akku-Messung, ohne Abgleich). Der Korrekturwert bleibt in der Box. Die Firmware zum Abgleichen schaltet die Box bei leerem Akku nämlich nicht ab.';
