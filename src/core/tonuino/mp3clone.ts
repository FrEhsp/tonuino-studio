/**
 * A copied MP3 player in the box: the box counts the tracks of a folder
 * through its MP3 player, and some copies of the DFPlayer count wrong. Then
 * the box skips tracks, stops early or plays the wrong one, and the SD card
 * is fine. The app compares what the box logged per folder ("folder-tracks"
 * in the Box-Logbuch) with the open SD card.
 *
 * Patterns from the forum:
 * - TD5580A: says 2 tracks for every folder. No firmware helps; another
 *   player does.
 * - GD3200B/GD3200D: says the number of folder 01 for every folder. This
 *   file only counts; which chip that is and what helps is the rule of
 *   core/firmware/mp3chip.ts (suggestChip), fed with chipEvidence().
 * Any other difference can be a copy too, or another SD card than the one in
 * the box; the text says both.
 */
import { CHIP_TEXTS, suggestChip, type ChipEvidence, type ChipSuggestion, type Mp3Chip } from '../firmware/mp3chip';

export type ClonePattern = 'always-two' | 'folder-one' | 'mismatch';

export interface FolderCount {
  folder: number;
  /** What the box said. */
  box: number;
  /** Tracks on the SD card. */
  sd: number;
}

export interface CloneFinding {
  pattern: ClonePattern;
  /** The folders the counts differ in, by number. */
  differ: FolderCount[];
  /** How many folders were compared. */
  compared: number;
}

/** Compares the box's counts with the SD card's; undefined when they agree or nothing can be compared. */
export function detectClonePlayer(boxCounts: Readonly<Record<number, number>>, sdCounts: ReadonlyMap<number, number>): CloneFinding | undefined {
  const both: FolderCount[] = [];
  for (const [key, box] of Object.entries(boxCounts)) {
    const folder = Number(key);
    const sd = sdCounts.get(folder);
    if (sd === undefined || sd === 0) continue;
    both.push({ folder, box, sd });
  }
  both.sort((a, b) => a.folder - b.folder);
  const differ = both.filter((c) => c.box !== c.sd);
  if (!differ.length) return undefined;
  const compared = both.length;
  if (compared >= 2 && both.every((c) => c.box === 2)) return { pattern: 'always-two', differ, compared };
  const one = sdCounts.get(1);
  if (one !== undefined && differ.some((c) => c.folder !== 1) && both.every((c) => c.box === one)) return { pattern: 'folder-one', differ, compared };
  return { pattern: 'mismatch', differ, compared };
}

/** What the counts tell suggestChip. */
export function chipEvidence(f: CloneFinding): ChipEvidence {
  return f.pattern === 'folder-one' ? { sameCountEveryFolder: true } : {};
}

export interface CloneAdvice {
  title: string;
  text: string;
  example: string;
  /** What helps, when no chip firmware does. */
  remedy?: string;
  /** A firmware for the player's chip helps (Firmware-Baukasten). */
  chip?: ChipSuggestion & { look?: string };
}

/** What the finding means, in plain German. `current`: the chip the box's firmware is already made for, when known. */
export function cloneAdvice(f: CloneFinding, current?: Mp3Chip): CloneAdvice {
  const first = f.differ[0];
  const example = `Ordner ${String(first.folder).padStart(2, '0')}: Die Box zählt ${first.box} Titel, auf der SD-Karte sind ${first.sd}.`;
  const other = 'Abhilfe: ein anderer MP3-Player. Frage, wer die Box gebaut hat. Die SD-Karte musst du dafür nicht ändern.';
  if (f.pattern === 'always-two') {
    return {
      title: 'Vermutlich ein nachgebauter MP3-Player',
      text: 'Die Box meldet für jeden Ordner 2 Titel. So zählt ein nachgebauter Player (TD5580A). Die Box spielt dann nur die ersten Titel.',
      example,
      remedy: other,
    };
  }
  const suggestion = suggestChip({ ...chipEvidence(f), current });
  if (suggestion) {
    return {
      title: 'Vermutlich ein nachgebauter MP3-Player',
      text: `${suggestion.reason} Die Box springt dann oder hört zu früh auf.`,
      example,
      chip: { ...suggestion, look: CHIP_TEXTS[suggestion.chip].look },
    };
  }
  return {
    title: 'Die Box zählt anders als die SD-Karte',
    text: 'Steckt diese SD-Karte gerade in der Box? Dann zählt ihr MP3-Player falsch. Das machen manche nachgebauten Player. Die Box springt dann oder spielt Titel nicht.',
    example,
    remedy: other,
  };
}
