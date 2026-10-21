/**
 * The MP3 player chip of a box, as a choice of the Firmware-Baukasten
 * (baukasten.ts), and when to suggest one.
 *
 * TNG constants.hpp (V3.3.3 17.09.26, lines 157–174) has one define per chip;
 * the official builds use none of them (only DFMiniMp3_T_CHIP_Mp3ChipIncongruousNoAck,
 * which constants.hpp always sets). The defines switch on TNG's workarounds:
 * - DFMiniMp3_T_CHIP_MH2024K24SS_MP3_TF_16P_V3_0 (MP3-TF-16P V3.0): waits
 *   2500 ms instead of 1200 ms for a track to start (constants.hpp:592–593),
 *   an extra busy wait around adverts (mp3.cpp:152–157), and ignores
 *   OnPlayFinished for advert tracks (mp3.hpp:35–37, mp3.cpp:33–36).
 * - DFMiniMp3_T_CHIP_GD3200B: 2500 ms, the folder count trick
 *   (mp3.cpp:332–348: plays track 1 of the folder before asking), OnPlayFinished.
 * - DFMiniMp3_T_CHIP_LISP3: OnPlayFinished for advert tracks only.
 * MH2024K16SS is not offered: its define picks a library variant that the
 * NoAck define of constants.hpp overrides (mp3.hpp:28–33).
 *
 * Forum (weekly round 13.10., 15006#1–#8): with an MH2024K-24SS player and
 * no define the busy pin goes on and off several times before a track
 * starts; the firmware takes the track for finished ("missing
 * OnPlayFinished", "isPlaying" flapping) and the buttons seem dead. Often
 * only with some files. 13154#5–7: GD3200B/GD3200D (e.g. Reichelt) counts
 * the tracks of folder 01 for every folder.
 */

export type Mp3Chip = 'standard' | 'mh2024k24ss' | 'gd3200b' | 'lisp3';

/** The chips besides the standard, in the order the app shows them. */
export const OTHER_CHIPS: readonly Exclude<Mp3Chip, 'standard'>[] = ['mh2024k24ss', 'gd3200b', 'lisp3'];

/** The TNG define of each chip (none for the standard). */
export const CHIP_DEFINES: Record<Mp3Chip, string | undefined> = {
  standard: undefined,
  mh2024k24ss: 'DFMiniMp3_T_CHIP_MH2024K24SS_MP3_TF_16P_V3_0',
  gd3200b: 'DFMiniMp3_T_CHIP_GD3200B',
  lisp3: 'DFMiniMp3_T_CHIP_LISP3',
};

export interface ChipText {
  label: string;
  /** One plain sentence: when to pick it. */
  text: string;
  /** What is printed on the player or its chip. */
  look?: string;
}

export const CHIP_TEXTS: Record<Mp3Chip, ChipText> = {
  standard: { label: 'Normaler MP3-Player', text: 'Wie die fertige Firmware. Richtig für die allermeisten Boxen.' },
  mh2024k24ss: {
    label: 'Anderer MP3-Player-Chip (MH2024K-24SS)',
    text: 'Für Player, bei denen nur manche Dateien Ärger machen: Nach einem bestimmten Titel reagieren die Tasten nicht mehr, oder die Box springt gleich zum nächsten Titel.',
    look: 'Auf dem Player steht „MP3-TF-16P V3.0“, auf dem Chip „MH2024K-24SS“.',
  },
  gd3200b: {
    label: 'Anderer MP3-Player-Chip (GD3200B oder GD3200D)',
    text: 'Für Player, die in jedem Ordner so viele Titel finden wie in Ordner 01.',
    look: 'Auf dem Chip steht „GD3200B“ oder „GD3200D“ (zum Beispiel beim DFPlayer von Reichelt).',
  },
  lisp3: {
    label: 'Anderer MP3-Player-Chip (LISP3)',
    text: 'Für Player, bei denen die Box nach einer Ansage einen Titel überspringt.',
    look: 'Auf dem Chip steht „LISP3“ (zum Beispiel beim DFPlayer von DFRobot).',
  },
};

/**
 * The fifth chip define of constants.hpp, not built: DFMiniMp3_T_CHIP_MH2024K16SS
 * should pick the library variant without checksums (mp3.hpp:28–30), but the
 * NoAck define that constants.hpp:174 always sets overrides it (mp3.hpp:31–33).
 * Shown greyed out, so someone with this chip finds it and knows why.
 * TNG's PR #343 (branch issue_342, not merged) sets NoAck only when no other
 * chip define is set; once that is released, it can be built.
 */
export const MH2024K16SS_TEXT: ChipText & { why: string } = {
  label: 'Anderer MP3-Player-Chip (MH2024K-16SS)',
  text: 'Für Player mit dem Chip MH2024K-16SS.',
  look: 'Auf dem Chip steht „MH2024K-16SS“.',
  why: 'Gibt es nicht als fertige Firmware: Die Einstellung für diesen Chip wirkt in TNG 3.3.3 nur, wenn man den Quelltext ändert.',
};

/** For wizard and help: the symptom points to the chip, not to the file. */
export const CHIP_SYMPTOM_TEXT =
  'Machen nur manche Dateien Ärger, oder reagieren die Tasten nach einem bestimmten Titel nicht mehr, liegt es meist am Chip des MP3-Players, nicht an der Datei. Dann hilft eine Firmware für diesen Chip.';

/** What other code (log analysis, clone detection, a question to the user) knows. */
export interface ChipEvidence {
  /** The chip, when something already identified it (e.g. clone detection, a photo, the user). */
  chip?: Mp3Chip;
  /** "missing OnPlayFinished" lines in the log (TNG mp3.cpp:481). */
  missingOnPlayFinished?: number;
  /** Times "isPlaying" went 1 → 0 within about a second of a track start (busy pin flapping, mp3.cpp:469). */
  playingFlaps?: number;
  /** The trouble comes with some files only, or after a certain track. */
  onlySomeFiles?: boolean;
  /** Every folder reports the track count of folder 01. */
  sameCountEveryFolder?: boolean;
  /** After an announcement the box skips a track. */
  skipsAfterAnnouncement?: boolean;
  /** The firmware on the box already has a chip define (then nothing to suggest for that chip). */
  current?: Mp3Chip;
}

export interface ChipSuggestion {
  chip: Exclude<Mp3Chip, 'standard'>;
  /** Known for sure (the chip was identified), or a likely guess from symptoms. */
  sure: boolean;
  /** One plain German sentence why. */
  reason: string;
}

/**
 * Which chip choice of the Firmware-Baukasten to suggest, or undefined. Call
 * it with whatever is known; pass the result's chip into the extras
 * (`{ ...extras, chip }`, the wizard's chooseExtras).
 */
export function suggestChip(e: ChipEvidence): ChipSuggestion | undefined {
  const pick = (chip: ChipSuggestion['chip'], sure: boolean, reason: string): ChipSuggestion | undefined => (e.current === chip ? undefined : { chip, sure, reason });
  if (e.chip && e.chip !== 'standard') return pick(e.chip, true, `Dein MP3-Player hat den Chip ${chipName(e.chip)}. Dafür gibt es eine passende Firmware.`);
  if (e.chip === 'standard') return undefined;
  const flapping = (e.playingFlaps ?? 0) >= 2;
  const missing = (e.missingOnPlayFinished ?? 0) >= 2;
  if ((flapping && (missing || e.onlySomeFiles)) || (missing && e.onlySomeFiles)) {
    return pick('mh2024k24ss', false, 'Der MP3-Player meldet ein Titelende, bevor der Titel richtig läuft. Das macht meist der Chip MH2024K-24SS, nicht die Datei.');
  }
  if (e.sameCountEveryFolder) return pick('gd3200b', false, 'Der MP3-Player findet in jedem Ordner gleich viele Titel. Das macht meist der Chip GD3200B oder GD3200D.');
  if (e.skipsAfterAnnouncement) return pick('lisp3', false, 'Nach einer Ansage springt die Box einen Titel weiter. Das macht meist ein Chip, der auch nach Ansagen „Titel fertig“ meldet, zum Beispiel LISP3.');
  return undefined;
}

function chipName(chip: Exclude<Mp3Chip, 'standard'>): string {
  return chip === 'mh2024k24ss' ? 'MH2024K-24SS' : chip === 'gd3200b' ? 'GD3200B/GD3200D' : 'LISP3';
}

/** The chip a build was made for, from its defines (standard when none). */
export function chipFromDefines(defines: readonly string[]): Mp3Chip {
  for (const chip of OTHER_CHIPS) if (defines.includes(CHIP_DEFINES[chip]!)) return chip;
  return 'standard';
}
