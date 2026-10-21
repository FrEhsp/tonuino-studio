/**
 * Reading and writing the track infos (ID3 tags) of a folder on the card
 * ("Titel-Infos bearbeiten", TODO 0.3 #46). Each MP3 gets a small ID3v2.3
 * tag in front of its sound, as when adding (buildSmallId3/replaceTags, no
 * pictures); names and numbers of the files stay. Writes go through the
 * card's Dir, so they land in the Paket where the card is read as a
 * snapshot (Firefox, Safari), and a replaced file only takes the old one's
 * place once it is complete (see platform write()).
 */
import { buildSmallId3, measureTags, readTags, replaceTags, type BasicTags } from '../../core/audio/id3';
import type { TagChange, Retagged } from '../../core/library/tagedit';
import type { Dir } from '../../platform/types';
import { isAccessLost, isWriteDenied } from './writeDenied';

/** Tags larger than this (big pictures) are not read; the file then counts as unreadable here. */
const MAX_TAG_BYTES = 32 << 20;

/** The lock-switch question of the browser's message for a file that may not be changed (platform/web/fsa.ts). */
const LOCK_QUESTION = /\s*Ist der Schreibschutzschalter der SD-Karte auf „Lock“\?/;
/** The desktop's message for a write-protected card (platform/tauri/errors.ts, 'fs:read-only'). */
const CARD_LOCKED = 'Die SD-Karte ist schreibgeschützt.';
const ONE_FILE = 'Vielleicht hat ein anderes Programm sie gerade offen.';

/**
 * Why a file could not be written, as it reads once other files of the same
 * run were written: the card takes writes then, so its lock switch is not
 * the cause, the file itself is. `file`: named already, so the browser's
 * „<file> schreiben:“ in front goes.
 */
export function failedFileLine(message: string, othersWritten: boolean, file?: string): string {
  if (file && message.startsWith(`${file} schreiben: `)) message = message.slice(`${file} schreiben: `.length);
  if (!othersWritten) return message;
  if (LOCK_QUESTION.test(message)) return `${message.replace(LOCK_QUESTION, '')} ${ONE_FILE}`;
  if (message.includes(CARD_LOCKED)) return `Die Datei ist schreibgeschützt. ${ONE_FILE}`;
  return message;
}

export function isMp3(file: string): boolean {
  return /\.mp3$/i.test(file);
}

/**
 * What the MP3s of a folder say now, by file name; a file that cannot be
 * read is missing from the map. One file after the other.
 */
export async function readFolderTags(dir: Dir, files: readonly string[], opts: { signal?: AbortSignal; onProgress?: (done: number) => void } = {}): Promise<Map<string, BasicTags>> {
  const out = new Map<string, BasicTags>();
  let done = 0;
  for (const file of files) {
    opts.signal?.throwIfAborted();
    if (isMp3(file)) {
      try {
        const r = await readTags(await dir.source(file), { maxTagBytes: MAX_TAG_BYTES });
        // Too big a tag was skipped: writing would lose what it holds unseen.
        if (!(r.layout.id3v2[0] && !r.id3v2)) out.set(file, r.tags);
      } catch {
        // Unreadable: shown, not written.
      }
    }
    opts.onProgress?.(++done);
  }
  return out;
}

export interface TagWriteResult {
  written: (Retagged & { tags: TagChange['tags'] })[];
  failed: { file: string; error: unknown }[];
  /** Not tried: stopped by hand, or after the card said no to writing. */
  skipped: string[];
}

/**
 * Writes the new tags, one file after the other. A file that fails is
 * noted and the next one tried; once the card says the app may not write
 * (or the browser took back the access), the rest is not tried. `stop`
 * is asked before each file.
 */
export async function writeTagChanges(dir: Dir, changes: readonly TagChange[], opts: { stop?: () => boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<TagWriteResult> {
  const result: TagWriteResult = { written: [], failed: [], skipped: [] };
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (opts.stop?.()) {
      result.skipped.push(...changes.slice(i).map((x) => x.file));
      break;
    }
    try {
      const source = await dir.source(c.file);
      const layout = await measureTags(source);
      // A file with nothing between its tags has no sound to keep: left as it is.
      if (layout.audioEnd <= layout.audioStart) throw new Error(`In „${c.file}“ ist kein Ton zu finden. Die Datei bleibt, wie sie ist.`);
      const blob = await replaceTags(source, buildSmallId3(c.tags), layout);
      await dir.write(c.file, blob);
      result.written.push({ file: c.file, oldSize: source.size, size: blob.size, title: c.tags.title ?? '', tags: c.tags });
    } catch (e) {
      result.failed.push({ file: c.file, error: e });
      if (isWriteDenied(e) || isAccessLost(e)) {
        result.skipped.push(...changes.slice(i + 1).map((x) => x.file));
        break;
      }
    }
    opts.onProgress?.(i + 1, changes.length);
  }
  return result;
}
