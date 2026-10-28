/**
 * The Firmware-Baukasten as tiles (0.6, design/06-umbau/loetplan,
 * entwurf-baukasten-*.png): a knob and a light to pick by picture, the parts
 * to tick, and folded away what cannot go right now and why. The rules stay
 * in core/firmware/baukasten.ts; this file only sorts them for the page:
 *
 * - an option this board can never have (with no other extra chosen) is not
 *   shown as a tile, only in „Geht gerade nicht“ with its reason;
 * - an option that clashes with what is chosen, or does not fit into the
 *   flash with it, is a grey tile that says why when clicked;
 * - a group without any option left is not shown.
 *
 * Also: the pins of what is chosen (tngPins.ts, TNG d527ca5), the short
 * name of the build, and the Lötplan with the same extras.
 */
import {
  ALARM_TEXT,
  HEADPHONES_TEXT,
  SPEAKER_OFF_TEXT,
  WRITE_CARD_TEXT,
  alarmBlocker,
  chipBlocker,
  choiceStatus,
  headphonesBlocker,
  knobBlocker,
  lightBlocker,
  normalizeChoice,
  offerWriteCardPreview,
  speakerOffBlocker,
  writeCardBlocker,
  type BaukastenBoard,
  type BaukastenButtons,
  type BaukastenManifest,
  type ExtrasChoice,
  type KnobKind,
  type LightKind,
} from '../../core/firmware/baukasten';
import { CHIP_TEXTS, OTHER_CHIPS, type Mp3Chip } from '../../core/firmware/mp3chip';
import { VARIANTS, type ShutdownKind } from '../../core/firmware/variants';
import { toWahl, type ExtraId, type LoetplanWahl } from './loetplan';
import { TNG_PINS, tngPin, type TngFunktion } from './tngPins';

export const TOO_BIG = 'Passt zusammen mit deinen anderen Extras nicht mehr in den Speicher.';

/** The small pictures of the tiles (BaukastenBilder.tsx). */
export type BildArt = 'knopfKein' | 'drehgeber' | 'drehgeberSkip' | 'poti' | 'lichtKein' | 'ring' | 'ringVolume' | 'ledButtons';

export interface Kachel<T> {
  /** undefined: „Kein Knopf“, „Kein Licht“. */
  id: T | undefined;
  name: string;
  /** Shorter, for the narrow tiles of a phone. */
  kurz: string;
  bild: BildArt;
  /** The sentence under the tiles when it is chosen. */
  text: string;
  /** Why it cannot be chosen with what is chosen now. */
  sperre?: string;
}

export interface Teil {
  id: 'speakerOff' | 'headphones' | 'alarm' | 'writeCard';
  name: string;
  /** One short line under the name. */
  klein: string;
  pin?: string;
  sperre?: string;
}

export interface Chip {
  id: Exclude<Mp3Chip, 'standard'>;
  name: string;
  sperre?: string;
}

export interface Baukasten {
  /** Undefined when this board and these buttons can have no knob at all. */
  knopf?: Kachel<KnobKind>[];
  licht?: Kachel<LightKind>[];
  /** Parts to tick (Zusatzteile). */
  teile: Teil[];
  /** Folded under „Mehr“: another MP3 chip, the alarm start, the preview of writing cards; only what can be chosen now. */
  chips?: Chip[];
  mehr: Teil[];
  /** What cannot go right now, with the reason. */
  gehtNicht: { name: string; warum: string }[];
}

/** The sentence under the tiles is short, as in the design; the long texts of baukasten.ts stay for the help. */
const KNOPF: { id: KnobKind | undefined; name: string; kurz: string; bild: BildArt; text: string }[] = [
  { id: undefined, name: 'Kein Knopf', kurz: 'Kein Knopf', bild: 'knopfKein', text: 'Lauter und leiser geht mit den Tasten.' },
  { id: 'encoder', name: 'Drehregler', kurz: 'Drehregler', bild: 'drehgeber', text: 'Drehen macht lauter oder leiser, Stück für Stück.' },
  { id: 'encoderSkip', name: 'Drehregler mit Vor/Zurück', kurz: 'Mit Vor/Zurück', bild: 'drehgeberSkip', text: 'Schnell drehen ändert die Lautstärke, ein einzelner Klick wechselt den Titel.' },
  { id: 'poti', name: 'Knopf ohne Raster', kurz: 'Ohne Raster', bild: 'poti', text: 'Wie am alten Radio: Die Stellung des Knopfs ist die Lautstärke.' },
];

const LICHT: { id: LightKind | undefined; name: string; kurz: string; bild: BildArt; text: string }[] = [
  { id: undefined, name: 'Kein Licht', kurz: 'Kein Licht', bild: 'lichtKein', text: 'Die Box leuchtet nicht.' },
  { id: 'ring', name: 'Leuchtring', kurz: 'Leuchtring', bild: 'ring', text: 'Grün beim Warten, Regenbogen beim Spielen.' },
  { id: 'ringVolume', name: 'Ring zeigt Lautstärke', kurz: 'Mit Lautstärke', bild: 'ringVolume', text: 'Wie der Leuchtring. Dazu zeigt er beim Lauter- und Leiserstellen kurz die Lautstärke.' },
  { id: 'ledButtons', name: 'Leuchtende Tasten', kurz: 'Leuchtende Tasten', bild: 'ledButtons', text: 'Blinken beim Warten, leuchten beim Spielen, in der Pause blinkt nur Play/Pause.' },
];

/** The name a tile has, for the lines of „Deine Auswahl“. */
export function knopfName(k: KnobKind): string {
  return KNOPF.find((x) => x.id === k)!.name;
}

export function lichtName(l: LightKind): string {
  return LICHT.find((x) => x.id === l)!.name;
}

/** All tiles, parts and reasons for a board, its buttons and what is chosen. `traeger`: the shutdown answer „Trägerplatine“, part of every build. */
export function baukasten(manifest: BaukastenManifest, board: BaukastenBoard, buttons: BaukastenButtons, value: ExtrasChoice, traeger: boolean): Baukasten {
  const choice = normalizeChoice(board, buttons, value);
  const size = (next: ExtrasChoice) => (choiceStatus(manifest, board, buttons, { ...next, traeger }).kind === 'ok' ? undefined : TOO_BIG);
  const gehtNicht: Baukasten['gehtNicht'] = [];
  const nicht = (name: string, warum: string | undefined) => {
    if (warum) gehtNicht.push({ name, warum });
  };

  // Knob: the buttons decide, then the flash.
  let knopf: Kachel<KnobKind>[] | undefined;
  const knobAll = knobBlocker(board, buttons);
  if (knobAll) {
    for (const k of KNOPF) if (k.id) nicht(k.name, knobAll);
  } else {
    knopf = KNOPF.map((k) => {
      const sperre = k.id && choice.knob !== k.id ? size({ ...choice, knob: k.id }) : undefined;
      nicht(k.name, sperre);
      return { ...k, sperre };
    });
  }

  // Light: what the board can never have is not a tile.
  const lichtKacheln: Kachel<LightKind>[] = [];
  for (const l of LICHT) {
    if (!l.id) {
      lichtKacheln.push({ ...l });
      continue;
    }
    const nie = lightBlocker(board, l.id, {});
    if (nie) {
      nicht(l.name, nie);
      continue;
    }
    const sperre = choice.light === l.id ? undefined : (lightBlocker(board, l.id, choice) ?? size({ ...choice, light: l.id }));
    nicht(l.name, sperre);
    lichtKacheln.push({ ...l, sperre });
  }
  const licht = lichtKacheln.length > 1 ? lichtKacheln : undefined;

  const teile: Teil[] = [];
  const teil = (t: Teil, nie: string | undefined, jetzt: string | undefined, an: boolean) => {
    if (nie) return nicht(t.name, nie);
    const sperre = an ? undefined : jetzt;
    nicht(t.name, sperre);
    teile.push({ ...t, sperre });
  };
  teil(
    { id: 'speakerOff', name: 'Lautsprecher stumm', klein: 'kein Knacken beim Ein- und Ausschalten', pin: pinOrNone(board, 'spkOnOff') },
    speakerOffBlocker(board, {}),
    speakerOffBlocker(board, choice) ?? size({ ...choice, speakerOff: true }),
    !!choice.speakerOff,
  );
  teil(
    { id: 'headphones', name: HEADPHONES_TEXT.label, klein: 'Buchse mit Schaltkontakt', pin: pinOrNone(board, 'hpDetect') },
    headphonesBlocker(board),
    headphonesBlocker(board, choice) ?? size({ ...choice, headphones: true }),
    !!choice.headphones,
  );

  // Another MP3 chip: one of three, or the one of the factory.
  const chipJetzt = chipBlocker({ ...choice, chip: undefined });
  let chips: Chip[] | undefined;
  if (chipJetzt) nicht('Anderer MP3-Player-Chip', chipJetzt);
  else {
    chips = OTHER_CHIPS.map((c) => {
      const sperre = choice.chip === c ? undefined : size({ ...choice, chip: c });
      return { id: c, name: CHIP_TEXTS[c].label, sperre };
    });
  }

  const mehr: Teil[] = [];
  // Under „Mehr“ only what can be chosen now; the rest is said in „Geht gerade nicht“.
  const mehrTeil = (t: Teil, nie: string | undefined, jetzt: string | undefined, an: boolean) => {
    const warum = nie ?? (an ? undefined : jetzt);
    if (warum) return nicht(t.name, warum);
    mehr.push(t);
  };
  mehrTeil(
    { id: 'alarm', name: ALARM_TEXT.label, klein: 'ein Wecker schaltet die Box ein', pin: pinOrNone(board, 'specialStart') },
    alarmBlocker(board, {}),
    alarmBlocker(board, choice) ?? size({ ...choice, alarm: true }),
    !!choice.alarm,
  );
  if (offerWriteCardPreview(manifest)) {
    const fits = manifest.builds.some((b) => b.writeCard && b.board === board && b.buttons === buttons);
    mehrTeil(
      { id: 'writeCard', name: 'Karten über die Box beschreiben', klein: 'Vorschau, braucht nur das USB-Kabel' },
      fits ? undefined : 'Passt bei dieser Platine nicht in den Speicher.',
      writeCardBlocker(choice) ?? size({ ...choice, writeCard: true }),
      !!choice.writeCard,
    );
  }
  return { knopf, licht, teile, chips, mehr, gehtNicht };
}

/* ------------------------------------------------------------------ pins */

const KNOB_PINS: Record<KnobKind, TngFunktion[]> = { encoder: ['encClk', 'encDt'], encoderSkip: ['encClk', 'encDt'], poti: ['poti'] };
const LIGHT_PINS: Record<LightKind, TngFunktion[]> = { ring: ['ring'], ringVolume: ['ring'], ledButtons: ['ledPlay', 'ledUp', 'ledDown'] };

/** "A3, A4": the pins of the firmware for these functions on this board. */
export function pinsOf(board: BaukastenBoard, funktionen: TngFunktion[]): string {
  return funktionen.map((f) => tngPin(board, f).pin).join(', ');
}

/** The pin, or undefined where the firmware has none on this board (the headphone jack of the AiO). */
function pinOrNone(board: BaukastenBoard, f: TngFunktion): string | undefined {
  return TNG_PINS[board][f]?.pin;
}

export function knopfPins(board: BaukastenBoard, k: KnobKind): string {
  return pinsOf(board, KNOB_PINS[k]);
}

export function lichtPins(board: BaukastenBoard, l: LightKind): string {
  return pinsOf(board, LIGHT_PINS[l]);
}

/* ------------------------------------------------------------------ names */

const KURZ_KNOPF: Record<KnobKind, string> = { encoder: 'Drehregler', encoderSkip: 'Drehregler mit Vor/Zurück', poti: 'Poti' };
const KURZ_LICHT: Record<LightKind, string> = { ring: 'Leuchtring', ringVolume: 'Ring mit Lautstärke', ledButtons: 'Leuchtende Tasten' };

/** "TNG 3.3.3 · Classic · 3 Tasten · Drehregler · Leuchtring · Kopfhörer": the build in one line. */
export function firmwareName(version: string, board: BaukastenBoard, buttons: BaukastenButtons, choice: ExtrasChoice): string {
  const parts = [`TNG ${version}`, board === 'classic' ? 'Classic' : 'AiO', VARIANTS[buttons].label];
  if (choice.knob) parts.push(KURZ_KNOPF[choice.knob]);
  if (choice.light) parts.push(KURZ_LICHT[choice.light]);
  if (choice.speakerOff) parts.push('Lautsprecher stumm');
  if (choice.headphones) parts.push('Kopfhörer');
  if (choice.traeger) parts.push('Trägerplatine');
  if (choice.preset === 'weiter') parts.push('Weitermachen');
  if (choice.chip && choice.chip !== 'standard') parts.push(CHIP_TEXTS[choice.chip].label);
  if (choice.alarm) parts.push('Wecker');
  if (choice.writeCard) parts.push('Karten über USB');
  return parts.join(' · ');
}

/** The parts of a build for the sentence „Mit Drehregler, Leuchtring und Kopfhörer-Erkennung.“; „Weitermachen“ comes from „Verhalten“. */
export function firmwareTeile(choice: ExtrasChoice): string[] {
  const parts: string[] = [];
  if (choice.knob) parts.push(knopfName(choice.knob));
  if (choice.light) parts.push(lichtName(choice.light));
  if (choice.speakerOff) parts.push(SPEAKER_OFF_TEXT.label);
  if (choice.headphones) parts.push(HEADPHONES_TEXT.label);
  if (choice.traeger) parts.push('Abschaltung für die Trägerplatine');
  if (choice.chip && choice.chip !== 'standard') parts.push(CHIP_TEXTS[choice.chip].label);
  if (choice.alarm) parts.push(ALARM_TEXT.label);
  if (choice.writeCard) parts.push(WRITE_CARD_TEXT.label.replace(/^Vorschau: /, ''));
  return parts;
}

/* ------------------------------------------------------------------ the Lötplan with the same extras */

/**
 * The Lötplan for this build: board, buttons and the extras of the build
 * (loetplan.ts EXTRAS); the rest of the plan (headphone socket, Arduino,
 * view) stays as it was. The Pololu switch comes from the shutdown answer.
 */
export function loetplanFuer(now: LoetplanWahl, board: BaukastenBoard, buttons: BaukastenButtons, choice: ExtrasChoice, shutdown?: ShutdownKind): LoetplanWahl {
  const extras: ExtraId[] = [];
  if (choice.knob) extras.push(choice.knob === 'poti' ? 'poti' : 'drehgeber');
  if (choice.light === 'ring' || choice.light === 'ringVolume') extras.push('ring');
  if (choice.light === 'ledButtons') extras.push('ledtasten');
  if (choice.speakerOff) extras.push('lsaus');
  if (choice.headphones) extras.push('hperkennung');
  if (choice.alarm) extras.push('wecker');
  if (shutdown === 'pololu') extras.push('pololu');
  // The Classic with or without its board stays as the user had it.
  const platine = board === 'aio' ? 'aio' : now.platine === 'frei' ? 'frei' : 'classic';
  return toWahl({ ...now, platine, tasten: buttons === '5' ? 5 : 3, extras });
}
