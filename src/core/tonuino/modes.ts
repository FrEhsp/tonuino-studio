import { ADMIN_MODE, type CardData, type FirmwareProfile } from './card';
import type { TngRelease } from './boxguide';

/**
 * Playback modes and modifier cards in plain language. Codes and the meaning
 * of special/special2 follow TonUINO-TNG 3.3.3 (src/chip_card.hpp,
 * src/tonuino.cpp, src/state_machine.cpp). TonUINO 2.1 knows modes 1-9 and
 * uses modifier codes 3 and 7 differently.
 */

/**
 * The TNG release of 17.09.2026; the box logs it as "V3.3.3 17.09.26". The
 * release of 25.02.2026 has the same number 3.3.3, so the date tells them
 * apart. New in it: the random folder of Hörbuch cards (issue 319) and the
 * Endlos card (issue 328).
 */
export const TNG_SEPTEMBER_2026 = '3.3.3 vom 17.09.2026';

export type ModeParams =
  | 'none'
  /** special = track number */
  | 'track'
  /** special = first track, special2 = last track */
  | 'range'
  /**
   * special2 = last folder - folder (0 = only this folder). With more than one
   * folder TNG picks one of them at random on every placement, preferring one
   * that was started (tonuino.cpp, FOLDER_QUEUE_HOERBUCH is off). Only since
   * TNG_SEPTEMBER_2026; older boxes play the first folder only.
   */
  | 'folderRange'
  /** like folderRange, plus special = tracks per placement - 1 */
  | 'folderRangeTracks'
  /** special/special2 encode answers and solution */
  | 'quiz';

export interface ModeInfo {
  code: number;
  /** Short name, as the box announces it. */
  name: string;
  /** One line in family language. */
  tagline: string;
  /** When to pick it. */
  goodFor: string;
  params: ModeParams;
  /** Remembers where you stopped. */
  remembers: boolean;
  /** Needs a firmware option that ready-made builds might not have. */
  requires?: 'quiz' | 'memory' | 'bluetooth' | 'teapot';
  /** Hidden in the simple chooser. */
  advanced?: boolean;
  profiles: FirmwareProfile[];
  /** Earliest TNG version (informational). */
  since?: string;
}

const BOTH: FirmwareProfile[] = ['tng', 'classic21'];
const TNG: FirmwareProfile[] = ['tng'];

export const MODES: ModeInfo[] = [
  {
    code: 5,
    name: 'Hörbuch',
    tagline: 'Spielt der Reihe nach und merkt sich, wo ihr aufgehört habt.',
    goodFor: 'Hörbücher und lange Geschichten in mehreren Teilen.',
    params: 'folderRange',
    remembers: true,
    profiles: BOTH,
  },
  {
    code: 2,
    name: 'Album',
    tagline: 'Spielt alle Titel der Reihe nach, jedes Mal von vorn.',
    goodFor: 'Musik-CDs und Hörspiele, die man am Stück hört.',
    params: 'none',
    remembers: false,
    profiles: BOTH,
  },
  {
    code: 1,
    // The box calls it "Hörspielmodus"; on screen "Hörspiel" is what is in a folder, not how a card plays it.
    name: 'Zufällige Folge',
    tagline: 'Spielt bei jedem Auflegen eine zufällige Folge.',
    goodFor: 'Ordner mit vielen einzelnen, abgeschlossenen Folgen.',
    params: 'none',
    remembers: false,
    profiles: BOTH,
  },
  {
    code: 3,
    name: 'Party',
    tagline: 'Spielt alle Titel gemischt, ohne Ende.',
    goodFor: 'Musik zum Tanzen und Mitsingen.',
    params: 'none',
    remembers: false,
    profiles: BOTH,
  },
  {
    code: 4,
    name: 'Einzeltitel',
    tagline: 'Spielt genau einen Titel aus dem Ordner.',
    goodFor: 'Ein Lieblingslied oder eine einzelne Geschichte.',
    params: 'track',
    remembers: false,
    profiles: BOTH,
  },
  {
    code: 10,
    name: 'Hörbuch Stück für Stück',
    tagline: 'Spielt bei jedem Auflegen nur das nächste Kapitel und merkt es sich.',
    goodFor: 'Gute-Nacht-Geschichten: jeden Abend ein Kapitel.',
    params: 'folderRangeTracks',
    remembers: true,
    profiles: TNG,
  },
  {
    code: 16,
    name: 'Hörbuch, Teil eines Ordners',
    tagline: 'Wie Hörbuch, aber nur für die Titel von … bis … im Ordner.',
    // The box saves one place per folder, so books in one folder share it.
    goodFor: 'Mehrere Hörbücher in einem Ordner, die nacheinander gehört werden. Die Box merkt sich pro Ordner nur eine Stelle.',
    params: 'range',
    remembers: true,
    profiles: TNG,
    since: '3.3.3',
  },
  {
    code: 8,
    name: 'Album, Teil eines Ordners',
    tagline: 'Spielt nur die Titel von … bis … der Reihe nach.',
    goodFor: 'Mehrere Alben oder Hörspiele in einem Ordner.',
    params: 'range',
    remembers: false,
    profiles: BOTH,
  },
  {
    code: 7,
    name: 'Zufällige Folge, Teil eines Ordners',
    tagline: 'Spielt eine zufällige Folge aus den Titeln von … bis ….',
    goodFor: 'Eine Folgen-Sammlung in einem gemeinsamen Ordner.',
    params: 'range',
    remembers: false,
    profiles: BOTH,
  },
  {
    code: 9,
    name: 'Party, Teil eines Ordners',
    tagline: 'Spielt die Titel von … bis … gemischt.',
    goodFor: 'Eine Playlist innerhalb eines großen Musikordners.',
    params: 'range',
    remembers: false,
    profiles: BOTH,
  },
  {
    code: 11,
    // The box says "Wiederhole Karte Modus"; the app calls the card by what it is for.
    name: 'Nochmal-Karte',
    tagline: 'Startet noch einmal, was zuletzt lief.',
    goodFor: 'Eine „Nochmal!“-Karte für die Kleinen.',
    params: 'none',
    remembers: false,
    advanced: true,
    profiles: TNG,
  },
  {
    code: 12,
    name: 'Quiz',
    tagline: 'Fragen und Antworten aus einem vorbereiteten Ordner.',
    goodFor: 'Ratespiele mit Freunden. Der Ordner braucht eine feste Struktur.',
    params: 'quiz',
    remembers: false,
    requires: 'quiz',
    advanced: true,
    profiles: TNG,
  },
  {
    code: 13,
    name: 'Memory',
    tagline: 'Karten-Paare finden, die Box sagt, ob sie zusammenpassen.',
    goodFor: 'Memory mit Geräuschen oder Stimmen.',
    params: 'track',
    remembers: false,
    requires: 'memory',
    advanced: true,
    profiles: TNG,
  },
  {
    code: 15,
    name: 'Teekesselchen',
    tagline: 'Begriffe erraten, die zwei Bedeutungen haben.',
    goodFor: 'Ratespiel mit vorbereitetem Ordner.',
    params: 'none',
    remembers: false,
    requires: 'teapot',
    advanced: true,
    profiles: TNG,
    since: '3.3.3',
  },
  {
    code: 14,
    name: 'Bluetooth an/aus',
    tagline: 'Schaltet ein eingebautes Bluetooth-Modul um.',
    goodFor: 'Nur für Boxen mit Bluetooth-Modul.',
    params: 'none',
    remembers: false,
    requires: 'bluetooth',
    advanced: true,
    profiles: TNG,
  },
];

export interface ModifierInfo {
  code: number;
  name: string;
  tagline: string;
  /** Lucide-style symbol id used for the sticker. */
  symbol: ModifierSymbol;
  params: 'none' | 'sleep' | 'dancePause';
  /**
   * A firmware option the card needs. TNG compiles the Jukebox only into the
   * "5f" builds (MODIFICATION_CARD_JUKEBOX in platformio.ini) and pause after
   * each track into none (MODIFICATION_CARD_PAUSE_AFTER_TRACK); without it
   * the box still writes the card from its menu, but ignores it when placed.
   */
  requires?: 'bluetooth' | 'jukebox' | 'pauseAfterTrack';
  /** Earliest TNG release that knows the card. */
  since?: string;
  profiles: FirmwareProfile[];
}

export type ModifierSymbol =
  | 'moon'
  | 'music-pause'
  | 'flame-water-wind'
  | 'baby'
  | 'school'
  | 'repeat-1'
  | 'bluetooth'
  | 'list-music'
  | 'pause'
  | 'power'
  | 'infinity'
  | 'lock'
  | 'shield';

const TNG_MODIFIERS: ModifierInfo[] = [
  // TNG switches off when the time is up, 2.1 only pauses (and its Ausschalt-Timer may switch off later): the tagline holds for both.
  // The box says "Schlummermodus"; the app names the card, as on its sticker.
  { code: 1, name: 'Schlummerkarte', tagline: 'Hört nach einer gewählten Zeit auf zu spielen.', symbol: 'moon', params: 'sleep', profiles: BOTH },
  { code: 2, name: 'Stopptanz', tagline: 'Hält die Musik zufällig an. Wer sich bewegt, hat verloren.', symbol: 'music-pause', params: 'dancePause', profiles: BOTH },
  { code: 3, name: 'Feuer, Wasser, Luft', tagline: 'Bewegungsspiel: Die Box ruft, alle rennen.', symbol: 'flame-water-wind', params: 'dancePause', profiles: TNG },
  { code: 4, name: 'Krabbelmodus', tagline: 'Sperrt alle Tasten, Karten funktionieren weiter.', symbol: 'baby', params: 'none', profiles: BOTH },
  { code: 5, name: 'Kita-Modus', tagline: 'Neue Karten warten, bis der Titel zu Ende ist. Kein Streit mehr.', symbol: 'school', params: 'none', profiles: BOTH },
  { code: 6, name: 'Titel wiederholen', tagline: 'Wiederholt den aktuellen Titel immer wieder.', symbol: 'repeat-1', params: 'none', profiles: BOTH },
  { code: 7, name: 'Bluetooth', tagline: 'Schaltet das Bluetooth-Modul ein oder aus.', symbol: 'bluetooth', params: 'none', requires: 'bluetooth', profiles: TNG },
  { code: 8, name: 'Jukebox', tagline: 'Aufgelegte Karten kommen in eine Warteschlange.', symbol: 'list-music', params: 'none', requires: 'jukebox', profiles: TNG },
  { code: 9, name: 'Pause nach jedem Titel', tagline: 'Die Box hält nach jedem Titel an.', symbol: 'pause', params: 'none', requires: 'pauseAfterTrack', profiles: TNG },
  { code: 10, name: 'Ausschalt-Timer aus', tagline: 'Die Box schaltet sich vorübergehend nicht selbst ab.', symbol: 'power', params: 'none', profiles: TNG, since: '3.3.2' },
  { code: 11, name: 'Endlos', tagline: 'Spielt die aktuelle Karte ohne Ende.', symbol: 'infinity', params: 'none', since: TNG_SEPTEMBER_2026, profiles: TNG },
];

/**
 * Why a TNG box of this release cannot use the modifier card; undefined when
 * it may. "Older" only means before TNG_SEPTEMBER_2026: such a box may still
 * have 3.3.2 or the 3.3.3 of 25.02.2026, so only cards new on 17.09.2026 are
 * out for sure.
 */
export function modifierUnsupportedFor(mod: ModifierInfo, release: TngRelease = 'unknown'): string | undefined {
  if (release === 'older' && mod.since === TNG_SEPTEMBER_2026) return `Deine Box ist älter als TNG ${TNG_SEPTEMBER_2026} und kennt diese Karte nicht.`;
  return undefined;
}

/**
 * What a box needs for this modifier card, in plain German; undefined when
 * every box of its firmware can use it. A box of TNG_SEPTEMBER_2026 or later
 * knows every card, so the release note goes away.
 */
export function modifierNeeds(mod: ModifierInfo, release: TngRelease = 'unknown'): string | undefined {
  switch (mod.requires) {
    case 'bluetooth':
      return 'Nur für Boxen mit Bluetooth-Modul und passender Firmware.';
    case 'jukebox':
      return 'Geht nur mit der Firmware „5 Tasten mit allen Extras“ (AiO+, Nano Every, ESP32). Auf anderen Boxen passiert beim Auflegen nichts.';
    case 'pauseAfterTrack':
      return 'Geht mit keiner fertigen Firmware, nur mit einer selbst gebauten, in der diese Funktion eingeschaltet ist. Auf anderen Boxen passiert beim Auflegen nichts.';
  }
  if (mod.since && release !== 'newer') return `Gibt es erst ab TNG ${mod.since}. Ältere Boxen kennen diese Karte nicht.`;
  return undefined;
}

/**
 * TonUINO 2.1 differs in code 3 (Gesperrt), has no codes above 6, and its
 * Stopptanz has no choice of pause length.
 */
const CLASSIC_MODIFIERS: ModifierInfo[] = [
  TNG_MODIFIERS[0],
  { ...TNG_MODIFIERS[1], params: 'none' },
  { code: 3, name: 'Alles gesperrt', tagline: 'Sperrt Tasten und Karten.', symbol: 'lock', params: 'none', profiles: ['classic21'] },
  TNG_MODIFIERS[3],
  TNG_MODIFIERS[4],
  TNG_MODIFIERS[5],
];

export function modifiersFor(profile: FirmwareProfile): ModifierInfo[] {
  return profile === 'tng' ? TNG_MODIFIERS : CLASSIC_MODIFIERS;
}

/** A special card only TNG knows, looked up for a TonUINO 2.1 box: to name it instead of a bare code. */
function tngOnly(code: number, profile: FirmwareProfile): ModifierInfo | undefined {
  return profile === 'tng' ? undefined : TNG_MODIFIERS.find((m) => m.code === code);
}

export function modesFor(profile: FirmwareProfile, opts: { advanced?: boolean } = {}): ModeInfo[] {
  return MODES.filter((m) => m.profiles.includes(profile) && (opts.advanced || !m.advanced));
}

/**
 * How many folders right after `folder` a Hörbuch card can take into its
 * random choice (special2): only folders with titles on the card, without a
 * gap, at most `max` and never past folder 99.
 */
export function foldersInRowAfter(folder: number, withTracks: ReadonlySet<number>, max = 20): number {
  let n = 0;
  while (n < max && folder + n + 1 <= 99 && withTracks.has(folder + n + 1)) n++;
  return n;
}

export function modeByCode(code: number): ModeInfo | undefined {
  return MODES.find((m) => m.code === code);
}

export const SLEEP_MINUTES = [5, 15, 30, 60] as const;

/**
 * Most minutes a Schlummerkarte can hold. TNG keeps "erst am Titelende" in
 * the top bit of special (special & 0x80), so 127 is its longest time;
 * TonUINO 2.1 takes the whole byte.
 */
export function sleepMaxMinutes(profile: FirmwareProfile): number {
  return profile === 'tng' ? 127 : 255;
}

/** The minutes on a Schlummerkarte: TNG uses the low seven bits, TonUINO 2.1 the whole byte. */
export function sleepMinutesOf(card: Pick<CardData, 'special'>, profile: FirmwareProfile): number {
  return profile === 'tng' ? card.special & 0x7f : card.special;
}

/** The modes TonUINO 2.0 knows (card format 1): no special cards, no admin card (mode 6), nothing after 9. */
export const FORMAT20_MODES: readonly number[] = [1, 2, 3, 4, 5, 7, 8, 9];
export const DANCE_PAUSES = ['15 bis 30 Sekunden', '25 bis 40 Sekunden', '35 bis 50 Sekunden'] as const;

export const QUIZ_VARIANTS = [
  { label: '2 Antworten', special: 2, special2: 0 },
  { label: '4 Antworten', special: 4, special2: 0 },
  { label: '2 Antworten mit Lösung', special: 2, special2: 1 },
  { label: '4 Antworten mit Lösung', special: 4, special2: 1 },
  { label: 'Nur Lösung, mit Buzzer', special: 0, special2: 1 },
] as const;

export function adminCard(): CardData {
  return { folder: 0, mode: ADMIN_MODE, special: 0, special2: 0 };
}

export function modifierCard(code: number, special = 0): CardData {
  return { folder: 0, mode: code, special, special2: 0 };
}

/** How a modifier card is used, for the dialog that adds one and for the help. */
export const MODIFIER_HOWTO = 'So geht’s: Lege die Karte kurz auf, wenn die Box läuft. Nochmal auflegen beendet den Modus wieder.';

/**
 * What a special card does, without its name: for lists that show the name
 * above it, e.g. "Pausen alle 15 bis 30 Sekunden".
 */
export function specialSummary(card: CardData, profile: FirmwareProfile = 'tng'): string {
  if (card.folder === 0 && card.mode === ADMIN_MODE) return 'Öffnet das Admin-Menü der Box.';
  if (card.folder !== 0) return modeByCode(card.mode)?.tagline ?? `Unbekannter Modus ${card.mode}.`;
  const mod = modifiersFor(profile).find((m) => m.code === card.mode);
  if (!mod) return tngOnly(card.mode, profile) ? 'Gibt es nur bei TonUINO TNG.' : `Unbekannte Spezialkarte (Code ${card.mode}).`;
  if (mod.params === 'sleep') {
    const minutes = sleepMinutesOf(card, profile);
    if (profile !== 'tng') return `Hält nach ${minutes} Minuten an.`;
    return `Schaltet nach ${minutes} Minuten ab${(card.special & 0x80) !== 0 ? ', aber erst am Ende des Titels' : ''}.`;
  }
  if (mod.params === 'dancePause') return `Pausen alle ${DANCE_PAUSES[card.special] ?? '?'}.`;
  return mod.tagline;
}

/** Describes any decoded card in one sentence of plain German. */
export function describeCard(card: CardData, profile: FirmwareProfile = 'tng'): string {
  if (card.folder === 0) {
    if (card.mode === ADMIN_MODE) return 'Admin-Karte: öffnet das Admin-Menü der Box.';
    const mod = modifiersFor(profile).find((m) => m.code === card.mode);
    if (!mod) {
      const tng = tngOnly(card.mode, profile);
      return tng ? `${tng.name}: gibt es nur bei TonUINO TNG.` : `Unbekannte Spezialkarte (Code ${card.mode}).`;
    }
    if (mod.params === 'sleep') {
      const minutes = sleepMinutesOf(card, profile);
      const atEnd = (card.special & 0x80) !== 0;
      if (profile !== 'tng') return `${mod.name}: hält nach ${minutes} Minuten an.`;
      return `${mod.name}: schaltet nach ${minutes} Minuten ab${atEnd ? ', aber erst am Ende des Titels' : ''}.`;
    }
    if (mod.params === 'dancePause') return `${mod.name}: Pausen alle ${DANCE_PAUSES[card.special] ?? '?'}.`;
    return `${mod.name}: ${mod.tagline}`;
  }
  const mode = modeByCode(card.mode);
  const folder = `Ordner ${String(card.folder).padStart(2, '0')}`;
  if (!mode) return `${folder}, unbekannter Modus ${card.mode}.`;
  // These two do not play a folder; the box writes 255 as a placeholder.
  if (card.mode === 11 || card.mode === 14) return `${mode.name}: ${mode.tagline}`;
  switch (mode.params) {
    case 'track':
      return `${mode.name}: ${folder}, Titel ${card.special}.`;
    case 'range':
      return `${mode.name}: ${folder}, Titel ${card.special} bis ${card.special2}.`;
    case 'folderRange':
    case 'folderRangeTracks': {
      const tracks = mode.params === 'folderRangeTracks' ? `, ${card.special + 1} Titel pro Auflegen` : '';
      if (card.special2 > 0) {
        const last = String(card.folder + card.special2).padStart(2, '0');
        return `${mode.name}: zufällig einer der Ordner ${String(card.folder).padStart(2, '0')} bis ${last}${tracks}.`;
      }
      return `${mode.name}: ${folder}${tracks}.`;
    }
    case 'quiz': {
      const v = QUIZ_VARIANTS.find((q) => q.special === card.special && q.special2 === card.special2);
      return `${mode.name}: ${folder}${v ? `, ${v.label}` : ''}.`;
    }
    default:
      return `${mode.name}: ${folder}.`;
  }
}

/** Checks a card against the folders on the SD card. Returns problems in plain German. */
export function checkCardAgainstSd(card: CardData, trackCount: (folder: number) => number | undefined): string[] {
  const problems: string[] = [];
  if (card.folder === 0 || card.mode === 11 || card.mode === 14) return problems;
  const n = trackCount(card.folder);
  if (n === undefined) problems.push(`Ordner ${String(card.folder).padStart(2, '0')} gibt es auf der SD-Karte nicht.`);
  else if (n === 0) problems.push(`Ordner ${String(card.folder).padStart(2, '0')} ist leer.`);
  const mode = modeByCode(card.mode);
  if (!mode || n === undefined) return problems;
  if (mode.params === 'track' && (card.special < 1 || card.special > n)) {
    problems.push(`Titel ${card.special} gibt es im Ordner nicht (nur 1 bis ${n}).`);
  }
  if (mode.params === 'range') {
    if (card.special < 1 || card.special2 < card.special) problems.push('Der Bereich von … bis … ist ungültig.');
    else if (card.special2 > n) problems.push(`Der Bereich endet bei Titel ${card.special2}, der Ordner hat aber nur ${n} Titel.`);
  }
  // Party with a single track: some firmware plays it twice and then stops, and the box no longer
  // switches itself off (forum 10620#9, TonUINO 2.2). Mixing needs at least two tracks anyway.
  const partyOfOne = (card.mode === 3 && n === 1) || (card.mode === 9 && card.special >= 1 && card.special === card.special2 && card.special2 <= n);
  if (partyOfOne) {
    problems.push(
      card.mode === 3
        ? 'Im Ordner ist nur ein Titel. Zum Mischen braucht „Party“ mindestens zwei. Manche Boxen spielen ihn dann zweimal, halten an und schalten sich danach nicht mehr von selbst aus. Nimm „Album“ oder „Einzeltitel“, oder lege mehr Titel in den Ordner.'
        : 'Von … bis … umfasst nur einen Titel. Zum Mischen braucht „Party“ mindestens zwei. Manche Boxen spielen ihn dann zweimal, halten an und schalten sich danach nicht mehr von selbst aus. Nimm „Einzeltitel“, oder wähle einen größeren Bereich.',
    );
  }
  if ((mode.params === 'folderRange' || mode.params === 'folderRangeTracks') && card.special2 > 0) {
    for (let f = card.folder + 1; f <= card.folder + card.special2; f++) {
      const c = trackCount(f);
      if (!c) problems.push(`Ordner ${String(f).padStart(2, '0')} aus dem Bereich fehlt oder ist leer.`);
    }
  }
  return problems;
}
