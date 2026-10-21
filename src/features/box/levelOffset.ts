/**
 * A folder made quieter or louder on purpose (Frank 20.10.: "Leiser für die
 * Nacht"): the words for it, light enough for the shelf and the folder page.
 * The work itself is in folderSound.ts (planLevel) and process.ts (adding).
 */
import { cleanLevelOffset, LEVEL_OFFSET_MAX_DB, LEVEL_OFFSET_MIN_DB, type CatalogFolder } from '../../core/tonuino/catalog';

export { LEVEL_OFFSET_MAX_DB, LEVEL_OFFSET_MIN_DB };

export type LevelChoice = 'nacht' | 'leiser' | 'gleich' | 'lauter';

/** The four choices of the sound dialog, in plain words; the slider beside them is for the exact value. */
export const LEVEL_CHOICES: readonly { id: LevelChoice; label: string; db: number }[] = [
  { id: 'nacht', label: 'Leiser für die Nacht', db: -8 },
  { id: 'leiser', label: 'Etwas leiser', db: -4 },
  { id: 'gleich', label: 'Wie die anderen', db: 0 },
  { id: 'lauter', label: 'Etwas lauter', db: 3 },
];

/** The folder's offset in dB; 0 when it is as loud as the others. */
export function levelOffsetOf(entry: Pick<CatalogFolder, 'levelOffsetDb'> | undefined): number {
  return cleanLevelOffset(entry?.levelOffsetDb) ?? 0;
}

/** The choice an offset is, or undefined for a value set with the slider. */
export function levelChoiceOf(db: number): LevelChoice | undefined {
  return LEVEL_CHOICES.find((c) => c.db === db)?.id;
}

/** The small note on the folder page and the shelf: "leiser gestellt", "lauter gestellt", nothing when as loud as the others. */
export function levelNote(db: number): string | undefined {
  return db < 0 ? 'leiser gestellt' : db > 0 ? 'lauter gestellt' : undefined;
}

/** "−8 dB", "+3 dB", "0 dB": only beside the slider and in notes for those who want the number. */
export function formatOffset(db: number): string {
  const n = Math.abs(db).toLocaleString('de-DE', { maximumFractionDigits: 1 });
  return `${db < 0 ? '−' : db > 0 ? '+' : ''}${n} dB`;
}
