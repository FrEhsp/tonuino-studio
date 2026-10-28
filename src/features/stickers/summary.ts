/**
 * Short words for "Sticker drucken" (design B of 0.4.1): the chosen folders
 * in one line, and the paper as the packet of labels names it.
 */
import type { LabelTemplate } from '../../core/stickers/templates';

/** "01 bis 05, 07, 09 bis 12": the chosen folders in short; more than a few runs end in "…". */
export function folderRuns(folders: readonly number[]): string {
  const sorted = [...new Set(folders)].sort((a, b) => a - b);
  const runs: string[] = [];
  const two = (n: number) => String(n).padStart(2, '0');
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(j === i ? two(sorted[i]) : j === i + 1 ? `${two(sorted[i])}, ${two(sorted[j])}` : `${two(sorted[i])} bis ${two(sorted[j])}`);
    i = j + 1;
  }
  return runs.length > 4 ? `${runs.slice(0, 4).join(', ')} …` : runs.join(', ');
}

/** The paper's name without the size in brackets, which the line gives on its own. */
export function paperName(t: LabelTemplate): string {
  return t.name.replace(/\s*\(.*\)$/, '');
}

const mm = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });

/** ", 10 Sticker je 83,8 × 50,8 mm": what a sheet holds, as the packet of labels says it. */
export function paperSize(t: LabelTemplate, perSheet: number, images: boolean): string {
  const name = paperName(t);
  const size = t.label.shape === 'round' ? `Ø ${mm(t.label.widthMm)} mm` : `${mm(t.label.widthMm)} × ${mm(t.label.heightMm)} mm`;
  // A name that gives the size already ("Fotosticker 82 × 57 mm") keeps it once.
  const sized = /\d\s*(mm|cm)\b/.test(name);
  if (images) return sized ? ', jeder Sticker ein eigenes Bild' : `, jeder Sticker ein eigenes Bild in ${size}`;
  if (perSheet <= 1) return sized ? '' : `, ${size}`;
  return sized ? `, ${perSheet} Sticker je Bogen` : `, ${perSheet} Sticker je ${size}`;
}

/** What „Welche Sticker?“ says in one line (0.6): „7 Ordner ohne Sticker“, „Alle 52 Ordner“, „3 Ordner und 1 Spezialkarte“. */
export function chosenLine(c: { folders: number; allFolders: number; fresh: boolean; specials: number; pictures: number; words?: number }): string {
  const parts: string[] = [];
  if (c.folders) parts.push(c.fresh ? `${c.folders} Ordner ohne Sticker` : c.folders === c.allFolders && c.allFolders > 1 ? `Alle ${c.allFolders} Ordner` : `${c.folders} Ordner`);
  if (c.specials) parts.push(c.specials === 1 ? '1 Spezialkarte' : `${c.specials} Spezialkarten`);
  if (c.pictures) parts.push(c.pictures === 1 ? '1 eigenes Bild' : `${c.pictures} eigene Bilder`);
  if (c.words) parts.push(c.words === 1 ? '1 Wortkarte' : `${c.words} Wortkarten`);
  if (!parts.length) return 'Noch keine ausgewählt';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
}

/** The field the first sticker goes on, counted from 1: the first one not used up yet. */
export function firstField(used: readonly number[], perSheet: number): number {
  const gone = new Set(used);
  for (let i = 0; i < perSheet; i++) if (!gone.has(i)) return i + 1;
  return 1;
}

/** „10 Stück · 83,8 × 50,8 mm“: what one sheet holds, under the paper's name (0.6). */
export function sheetLine(t: LabelTemplate, perSheet: number, images: boolean): string {
  const size = t.label.shape === 'round' ? `Ø ${mm(t.label.widthMm)} mm` : `${mm(t.label.widthMm)} × ${mm(t.label.heightMm)} mm`;
  if (images) return `Jeder Sticker ein eigenes Bild · ${size}`;
  return perSheet > 1 ? `${perSheet} Stück · ${size}` : size;
}
