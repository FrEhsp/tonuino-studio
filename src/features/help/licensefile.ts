/**
 * The full licence texts the build puts next to the app as lizenzen.json
 * (written by scripts/licenses.ts): every npm package in the bundles, every
 * Rust crate the desktop app is compiled from. Most of these licences
 * ask that their text goes along with every copy of the program, which the
 * short list in ./notices.ts cannot do. Texts several packages share are
 * stored once.
 */

export interface NoticeEntry {
  name: string;
  version: string;
  /** SPDX expression as the package states it. */
  license?: string;
  /** Authors from the package's manifest, the only names there are when a package brings no licence file. */
  authors?: string;
  /** Repository or home page. */
  url?: string;
  /** Indexes into LicenseFile.texts, one per licence file of the package. */
  texts: number[];
}

export interface LicenseFile {
  npm: NoticeEntry[];
  rust: NoticeEntry[];
  texts: string[];
}

/** Next to index.html, so the web app and the desktop app find it the same way. */
export const LICENSE_FILE_NAME = 'lizenzen.json';

function isEntry(x: unknown, textCount: number): x is NoticeEntry {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  const optional = (v: unknown) => v === undefined || typeof v === 'string';
  return (
    typeof e.name === 'string' &&
    typeof e.version === 'string' &&
    optional(e.license) &&
    optional(e.authors) &&
    optional(e.url) &&
    Array.isArray(e.texts) &&
    e.texts.every((i) => Number.isInteger(i) && i >= 0 && i < textCount)
  );
}

/** True when the data has the shape the build writes, so a broken file shows an error instead of a blank list. */
export function isLicenseFile(x: unknown): x is LicenseFile {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  if (!Array.isArray(f.texts) || !f.texts.every((t) => typeof t === 'string')) return false;
  const count = f.texts.length;
  return Array.isArray(f.npm) && Array.isArray(f.rust) && [...f.npm, ...f.rust].every((e) => isEntry(e, count));
}

/** Entries whose name contains the query, ignoring case. */
export function filterNotices(entries: readonly NoticeEntry[], query: string): NoticeEntry[] {
  const q = query.trim().toLowerCase();
  return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : [...entries];
}

export type LicenseFileResult = { kind: 'ok'; file: LicenseFile } | { kind: 'missing' } | { kind: 'error'; message: string };

/**
 * Loads the file. "missing" means there is none, as in the dev server where
 * no build has run; asking for JSON keeps the dev server from answering with
 * the app's own page instead.
 */
export async function loadLicenseFile(fetchFn: typeof fetch, url: string): Promise<LicenseFileResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  } catch {
    return { kind: 'error', message: 'Die Lizenztexte ließen sich nicht laden. Prüfe die Internetverbindung und versuche es noch einmal.' };
  }
  if (res.status === 404) return { kind: 'missing' };
  if (!res.ok) return { kind: 'error', message: `Die Lizenztexte ließen sich nicht laden (Fehler ${res.status}). Versuche es später noch einmal.` };
  try {
    const data: unknown = await res.json();
    if (isLicenseFile(data)) return { kind: 'ok', file: data };
  } catch {
    // Falls through to the message below.
  }
  return { kind: 'error', message: 'Die Datei mit den Lizenztexten ist beschädigt. Lade die App neu und versuche es noch einmal.' };
}
