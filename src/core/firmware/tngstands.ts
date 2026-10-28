/**
 * The states ("Stände") of TonUINO TNG the app knows, told apart by the
 * version line a box logs at its start ("V3.3.4 26.10.26", src/version.hpp),
 * and the one the app puts on boxes.
 *
 * TNG has few releases: the tag V3.3.3_2026.02.25 is the last one, while
 * main moved on with the same number ("V3.3.3 17.09.26") and then to
 * "V3.3.4 26.10.26", whose README already says 3.4.0. tonuino.github.io (the
 * official web uploader) always has the newest main. So the app neither
 * trusts version numbers nor the server: it ships its own builds of one
 * checked state (the Firmware-Baukasten, scripts/firmware/build_baukasten.py
 * PINNED_STAND), which passed the box simulator (`npm run test:boxsim`).
 * How a new state is taken over: docs/FIRMWARE-BAUKASTEN.md, "Geprüfter Stand".
 */

export interface TngStand {
  /** As the box logs it, e.g. "V3.3.4 26.10.26". */
  versionString: string;
  /** "3.3.4" */
  version: string;
  /** ISO date of the version line, "2026-10-26". */
  date: string;
  /** Commit of TonUINO-TNG, where known. */
  commit?: string;
  /** release: a tagged release; main: a state of the main branch (what tonuino.github.io serves); preview: a test build of a work branch. */
  kind: 'release' | 'main' | 'preview';
  /** E.g. "Stand vom 17.09.2026". */
  label: string;
  /** What to know about it, in a sentence or two. */
  note?: string;
  /**
   * Layout version of the settings in the EEPROM ("Ver:" in the start log).
   * A box keeps the number when older firmware comes back, so the log line
   * alone does not say which firmware runs.
   */
  settingsLayout: number;
  /** The switches can be set in a config.hpp next to src (TNG PR #343); before, constants.hpp or -D. */
  configHpp: boolean;
  /**
   * invertVolumeButtons ("IB:", admin menu „Tasten umdrehen“) works on boxes
   * with 5 buttons too and swaps Vor/Zurück with Lauter/Leiser while music
   * plays (commands.cpp since PR #343). Before, it did nothing there, and
   * swapped keys needed the build switch FIVEBUTTONS_SWITCHED of a work branch.
   */
  invertFiveButtons: boolean;
  /** Built with BAT_VOLTAGE_MEASUREMENT_CALIBRATION the box takes "BAT <mV>" on the serial line (serial_input.cpp). */
  batCalibration: boolean;
  /**
   * The battery measurement computes wrong on the Arduino boards (Classic,
   * Every, AiO+): batVoltage.cpp multiplies two 16-bit numbers
   * (`value*settings.voltMeasCorrection`, `voltMeasCorrection * voltageMeasurement`),
   * and an int has 16 bits there. A battery of 3.7 V reads as some 30 mV,
   * the box reports it empty and switches off; a calibration saves a wrong
   * factor. ESP32 (32-bit int) is fine. Seen in the box simulator with the
   * real firmware (docs/FIRMWARE-BAUKASTEN.md, „Akku-Messung ab 26.10.2026“).
   */
  batteryMathBrokenOnAvr?: boolean;
}

const NOV = { configHpp: false, invertFiveButtons: false, batCalibration: false, settingsLayout: 2 } as const;

/** Every state with a name, oldest first. */
export const TNG_STANDS: readonly TngStand[] = [
  {
    ...NOV,
    versionString: 'V3.3.3 25.02.26',
    version: '3.3.3',
    date: '2026-02-25',
    kind: 'release',
    label: 'Release vom 25.02.2026',
    note: 'Es gibt einen neueren Stand vom 17.09.2026. Erst damit fragt die Box bei Hörbuch-Karten nach dem letzten Ordner und kennt die Endlos-Karte.',
  },
  {
    ...NOV,
    versionString: 'V3.3.3 17.09.26',
    version: '3.3.3',
    date: '2026-09-17',
    commit: 'd527ca5f3c5090a74ccdf5505202db352d7531c8',
    kind: 'main',
    label: 'Stand vom 17.09.2026',
  },
  {
    ...NOV,
    versionString: 'V3.3.3 16.10.26',
    version: '3.3.3',
    date: '2026-10-16',
    kind: 'preview',
    label: 'Testversion vom 16.10.2026',
    note: 'Noch nicht offiziell (TNG PR 352): Der MP3-Player startet damit schneller. In Tests blieb die Box manchmal nach einer Ansage hängen.',
  },
  {
    versionString: 'V3.3.4 26.10.26',
    version: '3.3.4',
    date: '2026-10-26',
    commit: 'bd65503cda80e4e6944c3d23592667ed6466dda8',
    kind: 'main',
    label: 'Stand vom 26.10.2026',
    note: 'Ein Entwicklungsstand von TonUINO TNG, noch ohne Release. Er speichert die Einstellungen in neuer Form (Version 3).',
    settingsLayout: 3,
    configHpp: true,
    invertFiveButtons: true,
    batCalibration: true,
    batteryMathBrokenOnAvr: true,
  },
];

/**
 * THE state the app puts on boxes: its Baukasten builds come from this commit
 * (public/firmware/baukasten/manifest.json `tng`, checked by
 * tests/firmware/baukasten.test.ts), and the box simulator passed with it.
 * Change it only together with a new Baukasten (docs/FIRMWARE-BAUKASTEN.md).
 */
export const CHECKED_TNG: TngStand = TNG_STANDS.find((s) => s.versionString === 'V3.3.3 17.09.26')!;

function germanDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** The known state with this version and date, or undefined. */
export function knownStand(fw: { version?: string; date?: string } | undefined): TngStand | undefined {
  if (!fw?.version || !fw.date) return undefined;
  return TNG_STANDS.find((s) => s.version === fw.version && s.date === fw.date);
}

/** -1, 0 or 1 by version number, then by date; undefined when the version cannot be read. */
export function compareStand(a: { version?: string; date?: string }, b: { version: string; date: string }): number | undefined {
  const pa = a.version?.split('.').map(Number);
  if (!pa || pa.some((n) => !Number.isInteger(n))) return undefined;
  const pb = b.version.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!a.date) return undefined;
  return a.date === b.date ? 0 : a.date > b.date ? 1 : -1;
}

/** True for the very state the app puts on boxes. */
export function isChecked(fw: { version?: string; date?: string } | undefined): boolean {
  return fw?.version === CHECKED_TNG.version && fw.date === CHECKED_TNG.date;
}

/** "TonUINO TNG 3.3.3 vom 17.09.2026" */
export function standTitle(s: Pick<TngStand, 'version' | 'date'>): string {
  return `TonUINO TNG ${s.version} vom ${germanDate(s.date)}`;
}

/**
 * Whether the firmware of a box swaps the keys of a 5-button box with
 * invertVolumeButtons: known states say so; a state after the newest known
 * one is taken to keep it. Undefined when the version is not known.
 */
export function invertWorksOnFiveButtons(fw: { version?: string; date?: string } | undefined): boolean | undefined {
  const known = knownStand(fw);
  if (known) return known.invertFiveButtons;
  const first = TNG_STANDS.find((s) => s.invertFiveButtons);
  if (!first || !fw) return undefined;
  const order = compareStand(fw, first);
  return order === undefined ? undefined : order >= 0;
}

/** The label of a state that is not in the table: before, between or after the known ones. */
export function unknownStandLabel(date: string): string {
  return `Stand vom ${germanDate(date)}`;
}

/* ------------------------------------------------- the key setting ("IB") */

/**
 * What the setting invertVolumeButtons ("IB:", admin menu „Tasten umdrehen“)
 * does on a box:
 * - 'three': 3 buttons (and the 3×3 board): 1 = a short press on Vor/Zurück
 *   changes the volume, a long one skips (factory: 1).
 * - 'five': 5 buttons with TNG from 26.10.2026: 1 = while music plays Vor/Zurück
 *   change the volume and Lauter/Leiser skip (factory: 0).
 * - 'none': 5 buttons with older TNG: no effect.
 * Undefined when the buttons are not known, or 5 buttons with an unknown firmware.
 */
export type InvertKind = 'three' | 'five' | 'none';

export function invertKind(box: { buttons?: '3' | '5' | '3x3'; version?: string; date?: string }): InvertKind | undefined {
  if (!box.buttons) return undefined;
  if (box.buttons !== '5') return 'three';
  const works = invertWorksOnFiveButtons(box);
  return works === undefined ? undefined : works ? 'five' : 'none';
}

/** The value of invertVolumeButtons after a reset (TNG Settings::resetSettings). */
export function factoryInvert(kind: InvertKind | undefined): boolean {
  return kind !== 'five';
}

/** One plain line for what the setting does on this box; undefined where it does nothing. */
export function invertText(kind: InvertKind | undefined, on: boolean): string | undefined {
  if (kind === 'five') return on ? 'beim Abspielen getauscht: Vor/Zurück ändern die Lautstärke, Lauter/Leiser wechseln den Titel' : 'wie beschriftet: Vor/Zurück wechseln den Titel, Lauter/Leiser die Lautstärke';
  if (kind === 'none') return undefined;
  return on ? 'kurz drücken: Lautstärke, lang: Titel' : 'kurz drücken: Titel, lang: Lautstärke';
}
