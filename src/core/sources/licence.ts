/**
 * Licences and credits: Creative Commons URLs, the short badge and the
 * sentences parents read, and the credit that travels with every file (ID3
 * and catalogue).
 */
import type { CcId, IndexEntry, IndexItem, Person, Rights } from './types';

const CC_IDS: CcId[] = ['by', 'by-sa', 'by-nc', 'by-nc-sa', 'by-nd', 'by-nc-nd'];

/** Creative Commons licence from its URL; undefined for anything else. */
export function ccFromUrl(raw: string | undefined): { id: CcId; version: string; port?: string; url: string } | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.hostname !== 'creativecommons.org' || (u.protocol !== 'https:' && u.protocol !== 'http:')) return undefined;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'licenses' && CC_IDS.includes(parts[1] as CcId) && /^\d\.\d$/.test(parts[2] ?? '')) {
    return { id: parts[1] as CcId, version: parts[2], port: parts[3] || undefined, url: raw.trim() };
  }
  if (parts[0] === 'publicdomain' && parts[1] === 'zero') return { id: 'cc0', version: parts[2] ?? '1.0', url: raw.trim() };
  if (parts[0] === 'publicdomain' && parts[1] === 'mark') return { id: 'pdm', version: parts[2] ?? '1.0', url: raw.trim() };
  return undefined;
}

/** True for licences that forbid commercial use. */
export function isNonCommercial(r: Rights): boolean {
  return r.kind === 'cc' && r.id.includes('nc');
}

/** Short badge text: "Podcast · nur privat", "Gemeinfrei", "CC BY-SA 2.0 DE". */
export function rightsBadge(r: Rights): string {
  switch (r.kind) {
    case 'podcast':
      return 'Podcast · nur privat';
    case 'private-use':
      return 'Nur privat';
    case 'public-domain':
      return 'Gemeinfrei';
    case 'cc':
      if (r.id === 'cc0') return 'CC0 · frei';
      if (r.id === 'pdm') return 'Gemeinfrei';
      return `CC ${r.id.toUpperCase()} ${r.version}${r.port ? ' ' + r.port.toUpperCase() : ''}`;
  }
}

/** What parents read before adding something. */
export function rightsSentence(r: Rights, publisher: string): string {
  switch (r.kind) {
    case 'podcast':
      return `Podcast von ${r.holder}. Du darfst die Folgen für eure Familie speichern. Gib die Dateien nicht weiter und spiele sie nicht öffentlich ab, zum Beispiel in der Kita.`;
    case 'private-use':
      return `${r.holder} erlaubt das Herunterladen für den privaten Gebrauch. Gib die Dateien nicht weiter.`;
    case 'public-domain':
      return r.latestDeath
        ? `Gemeinfrei: Wer den Text geschrieben oder übersetzt hat, ist vor mehr als 70 Jahren gestorben (zuletzt ${r.latestDeath}). Die Aufnahme ist frei von Rechten. Du darfst sie frei nutzen.`
        : 'Gemeinfrei: Du darfst die Aufnahme frei nutzen.';
    case 'cc': {
      if (r.id === 'cc0' || r.id === 'pdm') return 'Frei von Rechten. Du darfst die Aufnahme frei nutzen.';
      const nc = isNonCommercial(r) ? ' Nicht für kommerzielle Zwecke.' : '';
      return `Freie Lizenz ${rightsBadge(r)} von ${publisher}.${nc} Wir speichern die Angaben zu Urheber und Lizenz mit auf der SD-Karte. Wenn du die Dateien weitergibst, gib die Angaben mit.`;
    }
  }
}

export type Change = 'converted' | 'loudness' | 'split' | 'tags';

export const CHANGE_TEXT: Record<Change, string> = {
  converted: 'in MP3 umgewandelt',
  loudness: 'Lautstärke angeglichen',
  split: 'in Teile geteilt',
  tags: 'Titelangaben ersetzt',
};

const ROLE_TEXT: Record<Person['role'], string> = { author: 'Text', translator: 'Übersetzung', reader: 'gelesen von', performer: 'gesungen von', composer: 'Musik' };

/** The licence or terms page of the rights, as published. */
export function rightsUrl(r: Rights): string | undefined {
  return r.kind === 'cc' ? r.url : r.kind === 'podcast' || r.kind === 'private-use' ? r.termsUrl : undefined;
}

/** A link for people to open: Creative Commons pages over https even when the source wrote http. */
export function linkUrl(url: string): string {
  return url.replace(/^http:\/\/creativecommons\.org\//i, 'https://creativecommons.org/');
}

/**
 * The credit that goes into the COMM frame and into the catalogue:
 * title, creators, source, licence with link, and what the app changed
 * (CC 4.0 section 3(a)(1)).
 */
export function creditLine(
  entry: Pick<IndexEntry, 'title' | 'publisher' | 'pageUrl' | 'rights'>,
  item: Pick<IndexItem, 'title' | 'creators' | 'tradition' | 'pageUrl' | 'rights'>,
  changes: readonly Change[],
): string {
  const r = item.rights ?? entry.rights;
  const parts = [`„${item.title}“`, entry.title !== item.title ? entry.title : undefined, peopleText(item.creators ?? [], r, item.tradition), `Quelle: ${entry.publisher}, ${item.pageUrl ?? entry.pageUrl}`];
  const url = rightsUrl(r);
  parts.push(
    `${r.kind === 'podcast' ? 'Podcast, nur privat' : r.kind === 'private-use' ? 'Nur privat' : r.kind === 'public-domain' ? 'Gemeinfrei' : 'Lizenz: ' + rightsBadge(r)}${url ? ` (${linkUrl(url)})` : ''}`,
  );
  if (changes.length) parts.push(`Geändert: ${changes.map((c) => CHANGE_TEXT[c]).join(', ')}`);
  return parts.filter(Boolean).join('. ') + '.';
}

/**
 * "Text A, B und C, Übersetzung D, gelesen von E": one role per group, in the order the roles first appear.
 * A traditional tale starts with its origin instead: "Volksmärchen aus Ghana, Übersetzung D, gelesen von E".
 */
function peopleText(creators: readonly Person[], r: Rights, tradition?: string): string | undefined {
  const byRole = new Map<Person['role'], string[]>();
  for (const p of creators) {
    if (!p.name) continue;
    const name = `${p.name}${p.role === 'author' && p.died && r.kind === 'public-domain' ? ` (gest. ${p.died})` : ''}`;
    const names = byRole.get(p.role) ?? [];
    if (!names.includes(name)) names.push(name);
    byRole.set(p.role, names);
  }
  const text = [
    ...(tradition ? [tradition] : []),
    ...[...byRole].map(([role, names]) => `${ROLE_TEXT[role]} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}` : names[0]}`),
  ].join(', ');
  return text ? text[0].toUpperCase() + text.slice(1) : undefined;
}

/** TCOP must start with a year and a space (ID3v2.3). CC: the usual "Licensed to the public under … verify at …" form. */
export function copyrightFrame(entry: Pick<IndexEntry, 'publisher' | 'pageUrl' | 'rights'>, item: Pick<IndexItem, 'published' | 'pageUrl' | 'rights'>, fallbackYear: number): string | undefined {
  const r = item.rights ?? entry.rights;
  const fromItem = item.published ? Number(item.published.slice(0, 4)) : NaN;
  const y = Number.isInteger(fromItem) && fromItem > 1000 ? fromItem : fallbackYear;
  if (r.kind === 'podcast') return `${y} ${r.holder}`;
  if (r.kind === 'cc' && r.id !== 'cc0' && r.id !== 'pdm') return `${y} ${entry.publisher}. Licensed to the public under ${linkUrl(r.url)} verify at ${item.pageUrl ?? entry.pageUrl}`;
  return undefined;
}
