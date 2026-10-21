/** Texts of the "Entdecken" pages that depend on numbers and the kind of source. */
import { formatBytes, plural } from '../../app/format';
import { messageFor, type DownloadError, type DownloadProgress, type PartWord } from '../../core/sources/download';
import type { PickedFile } from '../../core/sources/handoff';
import { agesLabel, itemSeconds, type Hit, type Recommendation } from '../../core/sources/filter';
import { isNonCommercial, linkUrl, rightsBadge, rightsSentence, rightsUrl } from '../../core/sources/licence';
import { appLoadsFile } from '../../core/sources/providers';
import type { TrackOrigin } from '../../core/sources/origin';
import type { AgeRange, EntryType, IndexEntry, IndexItem, Person, PersonRole, Rights } from '../../core/sources/types';

/** "53 Min.", "2 Std. 47 Min.", "49 Sek.": rounded to minutes from one minute on. */
export function lengthLabel(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.round(sec)} Sek.`;
  const min = Math.round(sec / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} Min.`;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

const DAY = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** "04.10.2026" for a date, "2017" for a bare year. */
export function dayLabel(value: string | number | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string' && /^\d{4}$/.test(value)) return value;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? DAY.format(new Date(t)) : '';
}

const sumOf = (xs: (number | undefined)[]) => (xs.every((x): x is number => x !== undefined) ? xs.reduce((a, b) => a + b, 0) : undefined);

/** What a source holds, for its card: "12 Folgen", "14 Lieder · 47 Min.". ARD pages kept as links count episodes too. */
export function countLabel(entry: Pick<IndexEntry, 'type'> & Partial<Pick<IndexEntry, 'editPolicy'>>, items: readonly IndexItem[]): string {
  const n = items.length;
  if (episodic(entry)) return plural(n, 'Folge', 'Folgen');
  switch (entry.type) {
    case 'podcast':
      return plural(n, 'Folge', 'Folgen');
    case 'archive-album': {
      if (n !== 1) return plural(n, 'Album', 'Alben');
      const album = items[0];
      const length = lengthLabel(album.durationSec ?? sumOf(album.files.map((f) => f.durationSec)));
      return [plural(album.files.length, 'Lied', 'Lieder'), length].filter(Boolean).join(' · ');
    }
    case 'gitlab-gsb':
      return plural(n, 'Geschichte', 'Geschichten');
    default:
      return plural(n, 'Titel', 'Titel');
  }
}

/** One line under an item: "04.10.2026 · 53 Min. · 51 MB". The date only for podcasts. */
export function itemMeta(entry: Pick<IndexEntry, 'type'>, item: IndexItem): string {
  const parts = [entry.type === 'podcast' ? dayLabel(item.published) : '', lengthLabel(item.durationSec), item.size ? formatBytes(item.size) : ''];
  return parts.filter(Boolean).join(' · ');
}

/** "24 Titel in 5 Quellen", "1 Titel in 1 Quelle". */
export function hitsSummary(hits: readonly Hit[]): string {
  const titles = hits.reduce((n, h) => n + h.items.length, 0);
  return `${plural(titles, 'Titel', 'Titel')} in ${plural(hits.length, 'Quelle', 'Quellen')}`;
}

/** Heading of the list on a source page. ARD pages kept as links list episodes too. */
export function listHeading(entry: Pick<IndexEntry, 'type' | 'categories'> & Partial<Pick<IndexEntry, 'editPolicy'>>): string {
  if (episodic(entry)) return 'Folgen';
  switch (entry.type) {
    case 'podcast':
      return 'Folgen';
    case 'gitlab-gsb':
      return 'Geschichten';
    case 'archive-album':
      return 'Lieder';
    default:
      return entry.categories.length === 1 && entry.categories[0] === 'lied' ? 'Lieder' : 'Titel';
  }
}

/** The second choice of the card switch: "Eine Karte je Folge". */
export function eachLabel(entry: Pick<IndexEntry, 'type' | 'categories'>): string {
  if (entry.type === 'gitlab-gsb') return 'Eine Karte je Geschichte';
  if (entry.categories.length === 1 && entry.categories[0] === 'lied') return 'Eine Karte je Lied';
  return 'Eine Karte je Folge';
}

/** "3 ausgewählt · 1 Std. 12 Min. · 64 MB" */
export function selectionLine(count: number, sec: number | undefined, bytes: number): string {
  return [`${count.toLocaleString('de-DE')} ausgewählt`, lengthLabel(sec), bytes ? formatBytes(bytes) : ''].filter(Boolean).join(' · ');
}

/** "Lädt 2 von 14 · 12,4 MB von 80,1 MB" */
export function progressLine(p: DownloadProgress): string {
  const files = p.files > 1 ? `Lädt ${p.fileIndex + 1} von ${p.files}` : 'Lädt';
  return `${files} · ${p.totalBytes ? `${formatBytes(p.bytes)} von ${formatBytes(p.totalBytes)}` : formatBytes(p.bytes)}`;
}

const UNIT: Partial<Record<EntryType, [one: string, many: string]>> = {
  podcast: ['Folge', 'Folgen'],
  'gitlab-gsb': ['Geschichte', 'Geschichten'],
  'archive-album': ['Lied', 'Liedern'],
};

/** "2 von 14 Liedern ließen sich nicht laden." */
export function missingLine(missing: number, of: number, entry: Pick<IndexEntry, 'type'>): string {
  const [one, many] = UNIT[entry.type] ?? ['Datei', 'Dateien'];
  return `${missing.toLocaleString('de-DE')} von ${of.toLocaleString('de-DE')} ${of === 1 ? one : many} ${missing === 1 ? 'ließ' : 'ließen'} sich nicht laden.`;
}

/**
 * The name of a file that could not be loaded, for the list of files that
 * are not transferred. Songs of an album go by their own name: the album's
 * stands above them already.
 */
export function missingName(entry: Pick<IndexEntry, 'type'>, item: IndexItem, file: { title?: string; track?: number }): string {
  if (entry.type === 'archive-album' && file.title) return `${file.track ? `${file.track}. ` : ''}${file.title}`;
  return file.title && file.title !== item.title ? `${item.title} – ${file.title}` : item.title;
}

/** How many missing files the message names, the rest as "und 3 weitere". */
const NAMED_MISSING = 3;

/**
 * Why files are missing, under missingLine: each kind of problem once, the
 * ones that stopped the run last ("nicht mehr online" for one file,
 * "Internetverbindung" for the next). Which ones are missing is said only
 * when not all are (then the line above says enough) and the reason does
 * not name the file already. Without any reason left (the file that failed
 * was added by hand meanwhile), the missing ones are named.
 */
export function failedMessage(entry: Pick<IndexEntry, 'type'> & Partial<Pick<IndexEntry, 'editPolicy'>>, missing: readonly { pick: PickedFile; error?: DownloadError }[], total: number): string {
  const o = { podcast: entry.type === 'podcast', part: partWord(entry) };
  const messages = [...new Set(missing.flatMap((m) => (m.error ? [messageFor(m.error, m.pick.file.title ?? m.pick.item.title, o)] : [])))];
  const names = missing.slice(0, NAMED_MISSING).map((m) => missingName(entry, m.pick.item, m.pick.file));
  const more = missing.length - names.length;
  const quoted = names.map((n) => `„${n}“`);
  const list = more > 0 ? `${quoted.join(', ')} und ${more.toLocaleString('de-DE')} weitere` : quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} und ${quoted[quoted.length - 1]}` : (quoted[0] ?? '');
  if (!messages.length) {
    return `${missing.length === 1 ? `${list} fehlt noch.` : `Es fehlen noch ${list}.`} Tippe auf „Fehlende erneut laden“ oder füge ${missing.length === 1 ? 'die Datei' : 'die Dateien'} selbst hinzu.`;
  }
  const text = messages.slice(-2).join(' ');
  if (!missing.length || missing.length >= total) return text;
  if (missing.length === 1 && text.includes(`„${missing[0].pick.file.title ?? missing[0].pick.item.title}“`)) return text;
  return `${text} Es ${missing.length === 1 ? 'fehlt' : 'fehlen'} noch ${list}.`;
}

export { clockLabel } from '../../ui/seek';

/** A stable number from a source's id, for the colours of its cover. */
export function seedOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) | 0;
  return Math.abs(h);
}

const BY_ROLE: Record<PersonRole, string> = { author: 'von', translator: 'übersetzt von', reader: 'gelesen von', performer: 'gesungen von', composer: 'Musik von' };
const ROLE_ORDER: readonly PersonRole[] = ['author', 'translator', 'reader', 'performer', 'composer'];

function joinNames(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

/**
 * A title without the reader it names at its end, when the line below names
 * them anyway: "Alice im Wunderland, gelesen von Katharina Thalbach" ->
 * "Alice im Wunderland". Other titles stay as they are.
 */
export function titleWithoutReader(title: string, people: readonly Person[] | undefined): string {
  const m = /^(.+?)[,:]?\s+(?:[-–]\s+)?gelesen von\s+(.+)$/iu.exec(title.trim());
  if (!m) return title;
  const named = m[2].trim().toLowerCase();
  return (people ?? []).some((p) => p.role === 'reader' && named.includes(p.name.trim().toLowerCase())) ? m[1].trim() : title;
}

/**
 * "Von Gerdt von Bassewitz · gelesen von Franziska Nelson". A traditional
 * tale names its origin first: "Volksmärchen aus Ghana · übersetzt von …".
 */
export function creatorsLine(people: readonly Person[] | undefined, tradition?: string): string {
  const byRole = new Map<PersonRole, string[]>();
  for (const p of people ?? []) {
    const name = p.name.trim();
    if (name) byRole.set(p.role, [...(byRole.get(p.role) ?? []), name]);
  }
  const line = [
    ...(tradition ? [tradition] : []),
    ...ROLE_ORDER.filter((r) => byRole.has(r)).map((r) => `${BY_ROLE[r]} ${joinNames(byRole.get(r)!)}`),
  ].join(' · ');
  return line ? line[0].toUpperCase() + line.slice(1) : '';
}

/** Who sets the rules for a source: the rights holder of a podcast, else the publisher. */
export function holderOf(rights: Rights, publisher: string): string {
  return rights.kind === 'podcast' || rights.kind === 'private-use' ? rights.holder : publisher;
}

function rightsKey(r: Rights): string {
  return [r.kind, rightsBadge(r), rightsUrl(r) ?? '', 'holder' in r ? r.holder : '', 'latestDeath' in r ? (r.latestDeath ?? '') : ''].join('|');
}

/** The different rights of a source's items (an item without its own has the source's). */
export function itemRights(entry: Pick<IndexEntry, 'rights' | 'items'>): Rights[] {
  const seen = new Map<string, Rights>();
  for (const it of entry.items) {
    const r = it.rights ?? entry.rights;
    const k = rightsKey(r);
    if (!seen.has(k)) seen.set(k, r);
  }
  return seen.size ? [...seen.values()] : [entry.rights];
}

export interface RightsBox {
  sentence: string;
  /** The rights differ between items: every row shows its own badge. */
  perItem: boolean;
  links: { label: string; href: string }[];
}

const PER_ITEM_PLACE: Partial<Record<EntryType, string>> = { 'gitlab-gsb': 'bei jeder Geschichte', podcast: 'bei jeder Folge', 'archive-album': 'bei jedem Lied' };

/** The box "Herkunft und Lizenz" on a source page. */
export function rightsBox(entry: Pick<IndexEntry, 'type' | 'publisher' | 'rights' | 'items'>): RightsBox {
  const all = itemRights(entry);
  const links: RightsBox['links'] = [];
  for (const r of all) {
    const url = rightsUrl(r);
    if (!url) continue;
    const href = linkUrl(url);
    if (links.some((l) => l.href === href)) continue;
    links.push({ label: r.kind === 'cc' ? `Lizenztext ${rightsBadge(r)}` : `Nutzungsbedingungen von ${holderOf(r, entry.publisher)}`, href });
  }
  if (all.length === 1) return { sentence: rightsSentence(all[0], entry.publisher), perItem: false, links };
  const place = PER_ITEM_PLACE[entry.type] ?? 'bei jedem Titel';
  const sentence = all.every((r) => r.kind === 'cc')
    ? `Freie Lizenzen von ${entry.publisher}. Die Lizenz steht ${place}.${all.some(isNonCommercial) ? ' Mit „NC“ in der Lizenz: nicht für kommerzielle Zwecke.' : ''} Wir speichern die Angaben zu Urheber und Lizenz mit auf der SD-Karte. Wenn du die Dateien weitergibst, gib die Angaben mit.`
    : `Die Rechte unterscheiden sich. Die Lizenz steht ${place}.`;
  return { sentence, perItem: true, links };
}

/**
 * Why the files cannot go to the box right now. 'result': the result of the
 * last transfer is still unseen. 'rest': the last transfer stopped and its
 * rest waits to be transferred or discarded. Both only hold back loaded and
 * saved files, a download may start. 'folder' also stands for titles from a
 * web page that load for a folder in the desktop app.
 */
export type Blocker =
  | { kind: 'card' }
  | { kind: 'folder'; folder: number }
  | { kind: 'writing' }
  | { kind: 'reading' }
  | { kind: 'result'; folder?: number }
  | { kind: 'rest'; folder?: number };

/** `packaged`: Paket mode, where the card is read in, not plugged in (state.ts packageMode). */
export function blockerText(b: Blocker, packaged = false): string {
  switch (b.kind) {
    case 'card':
      return packaged ? 'Lies zuerst die SD-Karte ein.' : 'Stecke zuerst die SD-Karte ein.';
    case 'folder':
      return `Du fügst gerade Titel zu Ordner ${String(b.folder).padStart(2, '0')} hinzu. Schließe das zuerst ab oder verwirf die Auswahl.`;
    case 'writing':
      return 'Gerade wird auf die SD-Karte geschrieben. Warte, bis das fertig ist.';
    case 'reading':
      return 'Gerade werden Dateien gelesen. Einen Moment.';
    case 'result':
      return 'Schaue dir zuerst das Ergebnis der Übertragung an.';
    case 'rest':
      return 'Die letzte Übertragung ist nicht fertig. Übertrage zuerst den Rest oder verwirf ihn.';
  }
}

/** Loaded files that wait for the card or for the transfer that runs. */
export function waitingText(b: Blocker | null, packaged = false): string {
  switch (b?.kind) {
    case 'card':
      return packaged ? 'Die SD-Karte ist nicht mehr eingelesen. Lies sie wieder ein und klicke auf „Weiter“.' : 'Die SD-Karte ist nicht mehr da. Stecke sie wieder ein und klicke auf „Weiter“.';
    case 'folder':
      return blockerText(b);
    case 'writing':
      return 'Geladen. Gerade wird noch auf die SD-Karte geschrieben. Danach geht es von selbst weiter.';
    case 'reading':
      return 'Geladen. Gerade werden noch Dateien gelesen. Danach geht es von selbst weiter.';
    case 'result':
      return 'Geladen. Schaue dir zuerst das Ergebnis der Übertragung an. Danach geht es von selbst weiter.';
    case 'rest':
      return 'Geladen. Die letzte Übertragung ist nicht fertig. Übertrage den Rest oder verwirf ihn, danach geht es von selbst weiter.';
    default:
      return 'Geladen. Klicke auf „Weiter“, dann kannst du die Auswahl prüfen.';
  }
}

/** Whether the app loads the files of providers marked appLoads itself (the desktop app); state.ts sets how it finds out. */
let ownLoading: () => boolean = () => false;
export function setOwnLoading(check: () => boolean): void {
  ownLoading = check;
}

/** Whether the publisher's server lets the page itself load the item's files (the list says so after its CORS check). */
export function loadsInPage(entry: Pick<IndexEntry, 'delivery'>, item: Pick<IndexItem, 'delivery' | 'files'>): boolean {
  return (item.delivery ?? entry.delivery) === 'direct' && item.files.length > 0;
}

/**
 * How an item gets to the box: loaded in the app, or saved by the family on
 * the publisher's page. The desktop app also loads the files of providers
 * that allow saving but send no CORS header (Provider.appLoads, OHRKA).
 */
export function deliveryOf(entry: Pick<IndexEntry, 'delivery'> & Partial<Pick<IndexEntry, 'rights'>>, item: Pick<IndexItem, 'delivery' | 'files'>): 'direct' | 'browser' {
  if (loadsInPage(entry, item)) return 'direct';
  const rights = entry.rights;
  return rights && item.files.length > 0 && item.files.every((f) => appLoadsFile(rights, f.url)) && ownLoading() ? 'direct' : 'browser';
}

/** The licence badge of a source card: one licence, or the kinds of CC licences of its items. */
export function entryRightsBadge(entry: Pick<IndexEntry, 'rights' | 'items'>): string {
  const all = itemRights(entry);
  if (all.length === 1) return rightsBadge(all[0]);
  const ids = all.flatMap((r) => (r.kind === 'cc' ? [r.id.toUpperCase()] : []));
  return ids.length === all.length ? `CC ${[...new Set(ids)].join(' / ')}` : rightsBadge(entry.rights);
}

/**
 * Whether a saved file may be added without saying which title it is. Not
 * for a publisher that allows no changes: without its origin the file would
 * be evened out and tagged like any other.
 */
export function canAddUnmatched(entry: Pick<IndexEntry, 'editPolicy'>): boolean {
  return entry.editPolicy !== 'unchanged';
}

/** The ARD's own pages hold episodes, also where our list keeps them as links. */
function episodic(entry: Pick<IndexEntry, 'type'> & Partial<Pick<IndexEntry, 'editPolicy'>>): boolean {
  return entry.type === 'podcast' || (entry.type === 'link' && entry.editPolicy === 'unchanged');
}

/** What one item of a source is called in messages: "Folge", "Geschichte", "Lied" or "Titel". */
export function partWord(entry: Pick<IndexEntry, 'type'> & Partial<Pick<IndexEntry, 'editPolicy'>>): PartWord {
  if (episodic(entry)) return 'Folge';
  switch (entry.type) {
    case 'gitlab-gsb':
      return 'Geschichte';
    case 'archive-album':
      return 'Lied';
    default:
      return 'Titel';
  }
}

const NOMINATIVE: Record<PartWord, string> = { Folge: 'die Folge', Geschichte: 'die Geschichte', Lied: 'das Lied', Titel: 'der Titel' };

/** Above the drop zone: "So kommt die Folge auf die Box". Albums, where it is the way out after a failed download: "Lieder von Hand hinzufügen". */
export function saveHeading(entry: Pick<IndexEntry, 'type' | 'editPolicy'>): string {
  if (entry.type === 'archive-album') return 'Lieder von Hand hinzufügen';
  return `So kommt ${NOMINATIVE[partWord(entry)]} auf die Box`;
}

/** The heading of the question when a saved file is not known by its name: "Welche Folge ist das?". */
export function whichQuestion(entry: Pick<IndexEntry, 'type' | 'editPolicy'>, files = 1): string {
  const many = files > 1;
  if (episodic(entry)) return many ? 'Welche Folgen sind das?' : 'Welche Folge ist das?';
  switch (entry.type) {
    case 'gitlab-gsb':
      return many ? 'Welche Geschichten sind das?' : 'Welche Geschichte ist das?';
    case 'archive-album':
      return many ? 'Welche Lieder sind das?' : 'Welches Lied ist das?';
    default:
      return many ? 'Welche Titel sind das?' : 'Welcher Titel ist das?';
  }
}

/** The text under that question. `guessed`: how many files the app chose a title for by length or name. `known`: files it knew by name. */
export function whichText(entry: Pick<IndexEntry, 'type' | 'editPolicy' | 'rights' | 'publisher'>, o: { files: number; known: number; guessed: number }): string {
  const what = o.files > 1 ? 'Diese Dateien erkennen wir nicht am Namen.' : 'Diese Datei erkennen wir nicht am Namen.';
  const choose = !o.guessed
    ? 'Wähle aus, was es ist.'
    : o.guessed >= o.files
      ? 'Wir haben nach Länge und Name vorausgewählt. Prüfe kurz, ob es stimmt.'
      : `${o.guessed === 1 ? 'Eine' : o.guessed.toLocaleString('de-DE')} davon haben wir nach Länge und Name erkannt, bei ${o.files - o.guessed === 1 ? 'der anderen' : 'den anderen'} wähle bitte aus.`;
  const known = o.known ? (o.known === 1 ? ' Die andere Datei haben wir erkannt.' : ' Die anderen Dateien haben wir erkannt.') : '';
  const unchanged = canAddUnmatched(entry) ? '' : ` ${holderOf(entry.rights, entry.publisher)} erlaubt keine Änderungen. Darum ${o.files > 1 ? 'kommen die Dateien' : 'kommt die Datei'} genau so auf die Karte, wie du sie gespeichert hast.`;
  return `${what} ${choose}${known}${unchanged}`;
}

/** Every file is "Keine davon" for a publisher that allows no changes: why nothing is added. */
export function nothingToAddText(entry: Pick<IndexEntry, 'rights' | 'publisher'>): string {
  return `Ohne Zuordnung fügen wir nichts hinzu, weil ${holderOf(entry.rights, entry.publisher)} keine Änderungen erlaubt.`;
}

/** Files dropped beside the episodes that are no audio: "foto.jpg und notiz.txt sind keine Hördateien, die lassen wir weg." */
export function notAudioText(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((n) => `„${n}“`);
  const more = names.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} und ${plural(more, 'weitere Datei', 'weitere Dateien')}` : joinNames(shown);
  return `${list} ${names.length === 1 ? 'ist keine Hördatei' : 'sind keine Hördateien'}, die lassen wir weg.`;
}

/** The last choice of that question. */
export function noneLabel(entry: Pick<IndexEntry, 'editPolicy'>): string {
  return canAddUnmatched(entry) ? 'Keine davon (ohne Angaben zur Herkunft hinzufügen)' : 'Keine davon (nicht hinzufügen)';
}

/** Items saved from the publisher's page one file at a time get "Datei öffnen"; albums keep the page. */
export function opensFile(entry: Pick<IndexEntry, 'type' | 'delivery'>, item: Pick<IndexItem, 'delivery' | 'files'>): boolean {
  return entry.type !== 'archive-album' && deliveryOf(entry, item) === 'browser' && !!item.files[0]?.url;
}

const AT_ITEM: Record<PartWord, string> = { Folge: 'bei der Folge', Geschichte: 'bei der Geschichte', Lied: 'beim Lied', Titel: 'beim Titel' };

/** The steps beside the drop zone: open the file itself where the list has it, else the publisher's page. */
export function saveSteps(entry: Pick<IndexEntry, 'type' | 'delivery' | 'items'> & Partial<Pick<IndexEntry, 'editPolicy'>>, o: { watch?: boolean } = {}): string[] {
  const browser = entry.items.filter((it) => deliveryOf(entry, it) === 'browser');
  const withFile = browser.filter((it) => opensFile(entry, it)).length;
  const at = AT_ITEM[partWord(entry)];
  // The desktop app finds the saved file in the download folder by itself (downloadsWatch.ts).
  const drop = o.watch ? 'Ich finde die Datei dann in deinem Download-Ordner. Du kannst sie auch hierher ziehen.' : 'Ziehe die Datei hierher oder wähle sie aus.';
  // An album has one page: its link sits at the top, by the whole work, not by each song.
  if (entry.type === 'archive-album') {
    const first = browser.length ? 'Klicke oben beim Album auf „Auf der Webseite öffnen“.' : 'Klicke oben beim Album auf „…“ und dann auf „Auf der Webseite öffnen“.';
    return [first, 'Lade die Datei dort herunter.', drop];
  }
  if (browser.length && withFile === browser.length) return [`Klicke ${at} auf „Datei öffnen“. Sie öffnet sich in einem neuen Tab.`, 'Speichere die Datei dort auf deinem Computer.', drop];
  if (withFile) return [`Klicke ${at} auf „Datei öffnen“ oder „Auf der Webseite öffnen“.`, 'Speichere die Datei auf deinem Computer.', drop];
  return [`Klicke ${at} auf „Auf der Webseite öffnen“.`, 'Lade die Datei dort herunter.', drop];
}

/** "Öffne die Folge …", "Öffne den Titel …": the item in the accusative. */
const ACCUSATIVE: Record<PartWord, string> = { Folge: 'die Folge', Geschichte: 'die Geschichte', Lied: 'das Lied', Titel: 'den Titel' };

/** When "Reinhören" fails: where the family can listen instead. */
export function previewFailedText(part: PartWord, publisher: string): string {
  return `Reinhören klappt gerade nicht. Öffne ${ACCUSATIVE[part]} auf der Webseite von ${publisher}.`;
}

/** Under "Herkunft und Lizenz": when people checked rights and content, and when the list was last built. */
export function checkedLine(entry: Pick<IndexEntry, 'checkedAt' | 'reviewedAt'>): string {
  const list = `Liste aktualisiert am ${dayLabel(entry.checkedAt)}`;
  const reviewed = dayLabel(entry.reviewedAt);
  return reviewed ? `Rechte und Inhalte zuletzt geprüft am ${reviewed} · ${list}` : list;
}

/**
 * The line under "Herkunft und Lizenz" on a folder page. Files that came to
 * the card unchanged carry none of these details themselves.
 */
export function originsIntro(origins: readonly { changes: readonly string[] }[]): string {
  const inFile = origins.filter((o) => o.changes.includes('tags')).length;
  const from = fromWhere();
  if (inFile === origins.length) return `${from}, mit den Angaben, die auch in den Dateien stehen.`;
  if (!inFile) return `${from}. Die Dateien kamen unverändert auf die Karte, darum stehen diese Angaben nur hier und in der Liste auf der SD-Karte.`;
  return `${from}. Die Angaben stehen auch in den Dateien, außer bei Titeln, die unverändert auf die Karte kamen.`;
}

/**
 * Where titles with an origin came from. A card filled in a build with
 * "Entdecken" may be opened in one without it: then the text does not name
 * a part of the app that is not there.
 */
function fromWhere(): string {
  return __SOURCES_ENABLED__ ? 'Titel aus „Entdecken“' : 'Kostenlose Titel aus dem Internet';
}

const HIDDEN: Record<PartWord | 'Album', [one: string, many: string]> = {
  Folge: ['weitere Folge passt', 'weitere Folgen passen'],
  Geschichte: ['weitere Geschichte passt', 'weitere Geschichten passen'],
  Lied: ['weiteres Lied passt', 'weitere Lieder passen'],
  Titel: ['weiterer Titel passt', 'weitere Titel passen'],
  Album: ['weiteres Album passt', 'weitere Alben passen'],
};

/** Items of a source that the chosen kind and age leave out, named like the list names them (albums for whole works). */
export function hiddenText(entry: Pick<IndexEntry, 'type' | 'categories'> & Partial<Pick<IndexEntry, 'editPolicy'>>, hidden: number, shown: number): string {
  if (!shown) return 'Nichts davon passt zu deiner Auswahl von Art und Alter.';
  const noun = entry.type === 'archive-album' ? 'Album' : listHeading(entry) === 'Lieder' ? 'Lied' : partWord(entry);
  const [one, many] = HIDDEN[noun];
  return `${plural(hidden, one, many)} nicht zu deiner Auswahl von Art und Alter.`;
}

/** The line under an album in the review step: "Aus Entdecken: SRF · Podcast · nur privat". */
export function originLine(origins: readonly TrackOrigin[]): string | undefined {
  if (!origins.length) return undefined;
  const publishers = [...new Set(origins.map((o) => o.entry.publisher))];
  const badges = [...new Set(origins.map((o) => rightsBadge(o.item.rights ?? o.entry.rights)))];
  return `${__SOURCES_ENABLED__ ? 'Aus Entdecken' : 'Herkunft'}: ${publishers.join(', ')} · ${badges.join(', ')}`;
}

/** For albums whose publisher allows no changes. */
export function unchangedNote(origins: readonly TrackOrigin[]): string | undefined {
  const o = origins.find((x) => x.entry.editPolicy === 'unchanged');
  return o ? `Bleibt unverändert: ${holderOf(o.entry.rights, o.entry.publisher)} erlaubt keine Änderungen. Lautstärke und Länge bleiben, wie sie sind.` : undefined;
}

export const OFFLINE_HINT = 'Du bist offline. Reinhören und Laden gehen erst wieder mit Internet.';
export const BUSY_HINT = 'Gerade lädt schon etwas. Warte, bis das fertig ist.';

/* ------------------------------------------------------------------ recommendations */

/**
 * The age line of a recommendation, with the same range as the badge on the
 * source ("6 bis 10 Jahre" → "Für 6 bis 10 Jahre"). Not "Empfohlen …": the
 * section is already called "Empfehlungen".
 */
export function pickAgesLabel(ages: AgeRange): string {
  const label = agesLabel(ages);
  // "ab 7 Jahren" and "bis 5 Jahre" open the line by themselves; a range ("6 bis 10 Jahre") and "jedes Alter" get "Für".
  const opens = (ages.max === undefined && ages.min > 0) || (ages.min <= 0 && ages.max !== undefined);
  return opens ? label[0].toUpperCase() + label.slice(1) : `Für ${label}`;
}

/** The ages that apply to a recommendation: a title's own, else its source's. */
export function pickAges(r: Pick<Recommendation, 'entry' | 'item'>): AgeRange {
  return r.item?.ages ?? r.entry.ages;
}

/** "3 Std. 20 Min." for one album or title, "3 Teile · 2 Std. 39 Min." for a story in parts, "12 Folgen" for a whole show. */
export function pickLengthLabel(r: Pick<Recommendation, 'entry' | 'item' | 'items'> & Partial<Pick<Recommendation, 'story'>>): string {
  if (r.story) {
    const secs = r.items.map(itemSeconds);
    const total = secs.every((x) => x !== undefined) ? secs.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined;
    return [`${r.items.length} Teile`, lengthLabel(total)].filter(Boolean).join(' · ');
  }
  const single = r.item ?? (r.items.length === 1 ? r.items[0] : undefined);
  if (single) return lengthLabel(itemSeconds(single));
  return countLabel(r.entry, r.items);
}

/** The title a recommendation shows: the story's name, the title's own, else the source's. */
export function pickTitle(r: Pick<Recommendation, 'entry' | 'item'> & Partial<Pick<Recommendation, 'story'>>): string {
  return r.story ?? r.item?.title ?? r.entry.title;
}

/** The words on a pick card: a story of a recommended show speaks for itself (its source's own words), else the reason given for the pick. */
export function pickText(r: Pick<Recommendation, 'item' | 'pick'> & Partial<Pick<Recommendation, 'fromSource'>>): string {
  return (r.fromSource ? r.item?.about : undefined) ?? r.pick.why;
}
