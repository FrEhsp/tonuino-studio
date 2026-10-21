/**
 * "Entdecken": free audio plays, audiobooks and songs for children and
 * teenagers from open sources.
 *
 * Two data sets live here: the curated source catalogue (edited by people
 * through pull requests, sources/catalog.json) and the published index that a
 * daily job builds from it (/quellen/index-v1.json). The app only ever sees
 * the index; nothing in it comes from a source that a person has not admitted.
 */

/** The choices families pick from. Maps to ContentKind: hoerspiel, hoerbuch, lieder, wissen (knowledge shows for children). */
export type Category = 'hoerspiel' | 'hoerbuch' | 'lied' | 'wissen';

/** How a file reaches the app: fetched by the app, or saved by the user in the browser and dragged in. */
export type Delivery = 'direct' | 'browser';

/** 'unchanged': the file goes to the card byte for byte (no loudness change, no tag rewrite, no cutting, no conversion). */
export type EditPolicy = 'normal' | 'unchanged';

/**
 * active: published. review: legally and technically fine, a person still has to listen.
 * check: a technical or terms check is open. waiting-permission: the publisher has to agree first. off: excluded.
 */
export type EntryStatus = 'active' | 'review' | 'check' | 'waiting-permission' | 'off';

export const ENTRY_STATUSES: readonly EntryStatus[] = ['active', 'review', 'check', 'waiting-permission', 'off'];

export interface AgeRange {
  min: number;
  /** Missing: no upper limit. */
  max?: number;
}

export interface AgeInfo extends AgeRange {
  /** Who set it: the publisher's own words, or our editors. */
  source: 'publisher' | 'editor';
  /** The publisher's wording, quoted, e.g. "Unsere Geschichten eignen sich meist für Hörer ab 7 Jahren." */
  text?: string;
}

export type PersonRole = 'author' | 'translator' | 'reader' | 'performer' | 'composer';

export interface Person {
  name: string;
  role: PersonRole;
  born?: number;
  died?: number;
}

export type CcId = 'by' | 'by-sa' | 'by-nc' | 'by-nc-sa' | 'by-nd' | 'by-nc-nd' | 'cc0' | 'pdm';

export type Rights =
  | { kind: 'podcast'; holder: string; termsUrl?: string }
  | { kind: 'private-use'; holder: string; termsUrl: string }
  | { kind: 'public-domain'; basis: 'commons'; latestDeath?: number }
  | { kind: 'cc'; id: CcId; version: string; port?: string; url: string };

export interface MediaFile {
  /** Exactly as published (query strings such as ?refId=... stay). */
  url: string;
  /** File name for the import, e.g. "peterchens_mondfahrt_01_bassewitz_64kb.mp3". */
  name: string;
  size?: number;
  durationSec?: number;
  title?: string;
  track?: number;
}

/**
 * An editors' pick ("Empfehlungen"): where it stands among the picks (1 first)
 * and one short sentence why it is worth it. Optional in the index; an app
 * that does not know the field ignores it.
 */
export interface EditorPick {
  rank: number;
  why: string;
}

export interface IndexItem {
  /** Stable key: entry id + "/" + guid, identifier or path. */
  key: string;
  title: string;
  /** As published, when the display title differs (prefix removed). */
  originalTitle?: string;
  category: Category;
  /** Only when it differs from the entry, e.g. "(Ab 8 Jahren)" in the episode text. */
  ages?: AgeRange;
  /** ISO date ("2026-10-04T06:05:39.000Z") or a year ("2017"). */
  published?: string;
  durationSec?: number;
  size?: number;
  pageUrl?: string;
  creators?: Person[];
  /** A traditional tale with no known author, in German: "Volksmärchen aus Ghana". */
  tradition?: string;
  /** Only when it differs from the entry (per-story licences). */
  rights?: Rights;
  /**
   * The files the family may save. Empty for link entries whose publisher
   * allows saving only on its own page (ARD Sounds); those may still carry
   * `embed` to listen in the app.
   */
  files: MediaFile[];
  /**
   * The publisher's own player for this title, to listen in the app without
   * saving anything (ARD Sounds offers one per episode: twitter:player of the
   * episode page). Only addresses providers.ts allows; the app loads it on a
   * click, never before. Optional; an older app ignores it.
   */
  embed?: string;
  /** Link entries: the name of the file on the publisher's page, to recognise it when it is dragged in. */
  fileName?: string;
  /** Only when it differs from the entry. */
  delivery?: Delivery;
  /** A single title the editors recommend (sources/released.json). */
  featured?: EditorPick;
  /** The publisher wrote nothing about it besides the title. Titles keep their order; a source with many of them ranks lower (qualityTier in filter.ts). */
  sparse?: true;
  /** The title's own picture (https, src/core/sources/cover.ts), only when it differs from the entry's. Optional; an older app ignores it. */
  cover?: string;
  /**
   * The day the publisher takes the title down ("2027-01-07", ARD Sounds:
   * unavailable_after). From that day on the build leaves it out and the app
   * hides it, without asking the network. Optional; an older app ignores it.
   */
  until?: string;
  /**
   * One or two sentences about the title, from the source's own text (the
   * feed's description, the meta description of its page), never
   * reworded by us (about.ts). A link title may carry one from the
   * catalogue instead (LinkItem.about). Optional; an older app ignores it.
   */
  about?: string;
}

export type EntryType = 'podcast' | 'archive-album' | 'gitlab-gsb' | 'commons' | 'link';

export interface IndexEntry {
  id: string;
  type: EntryType;
  title: string;
  publisher: string;
  /** Our own short description, never the publisher's text. */
  blurb?: string;
  categories: Category[];
  ages: AgeInfo;
  language: 'de' | 'gsw';
  rights: Rights;
  delivery: Delivery;
  editPolicy: EditPolicy;
  pageUrl: string;
  /** Editorial note shown to parents. */
  note?: string;
  items: IndexItem[];
  /** When the builder last read the source successfully (the list's date, not a person's check). */
  checkedAt: string;
  /** When a person last checked rights and content of the source (review.at in the catalogue). */
  reviewedAt?: string;
  /** The whole source is an editors' pick. */
  featured?: EditorPick;
  /** The picture the source publishes (feed image, album cover, the picture of a title page), https (src/core/sources/cover.ts). Optional; an older app ignores it. */
  cover?: string;
  /** Where the cover comes from, shown under it, e.g. "Bild aus dem Podcast von WDR". Only with `cover`. */
  coverFrom?: string;
  /** One or two sentences about the source from its own text (feed description); `blurb` is ours. Optional. */
  about?: string;
  /**
   * Its titles are shown one by one in the list and among the picks, each
   * story with its own card (parts like "(1/3)" share one). Optional.
   */
  single?: true;
}

export interface SourceIndex {
  format: 1;
  generatedAt: string;
  /** After this the app says the list is old. */
  staleAfter: string;
  entries: IndexEntry[];
  /** Entry ids and item keys that must disappear at once, also from copies the app kept. */
  blocked: string[];
}

/* ------------------------------------------------------------ catalogue */

export interface CatalogBase {
  id: string;
  status: EntryStatus;
  /** What is still open before 'active', or why 'off'; in the editors' notes (editorial.ts). */
  openChecks?: string[];
  title: string;
  publisher: string;
  blurb?: string;
  pageUrl: string;
  category: Category;
  /** First match wins; tested against the episode title as published. 'skip' leaves the episode out. */
  categoryRules?: { pattern: string; category: Category | 'skip' }[];
  /** Removed from the start of episode titles for display. */
  titlePrefixes?: string[];
  /**
   * Regular expression (case-insensitive, anchored with ^) removed from the start of
   * episode titles before titlePrefixes, for series that write their prefix in several ways.
   */
  titlePattern?: string;
  /** Display titles set by an editor, by item key, for titles no pattern cleans. */
  titleOverrides?: Record<string, string>;
  /**
   * The series counts its episodes at the end of their titles ("Verzockt (5/26)"):
   * the counter is left out of the titles, the list keeps their order. Not for
   * parts of one story ("Die Schatzinsel (1/3)"), which the app puts together.
   */
  dropCounter?: true;
  /** Standing sentences of a show (footer, newsletter note) left out of the warning-word scan. */
  ignorePhrases?: string[];
  /** Hosts episode links may point to besides the host of pageUrl. Links elsewhere are not published. */
  linkHosts?: string[];
  ages: AgeInfo;
  language: 'de' | 'gsw';
  rights: Rights;
  /** Upper bound; the builder downgrades to 'browser' when the CORS check of a media host fails. */
  delivery: Delivery;
  editPolicy: EditPolicy;
  note?: string;
  /**
   * When a person admitted the entry and when it is due again (required for
   * 'active'); who did it (`by`) is in the editors' notes only (editorial.ts).
   */
  review?: { by?: string; at: string; next: string };
  /**
   * A permission the publisher has to give before the entry may be 'active'
   * (needed: what, in the editors' words). 'granted' records who gave it, when,
   * and where the written answer is filed. Editors' notes (editorial.ts) until
   * it is granted.
   */
  permission?: { needed: string; granted?: { by: string; at: string; filed: string } };
  /** Every new item waits until a person released its key in sources/released.json. */
  holdNew?: boolean;
  /**
   * Shortest item the build lists, in seconds, when it is lower than the
   * default (MIN_SECONDS in quality.ts): bedtime stories may be short.
   */
  minSeconds?: number;
  /** An editors' pick; only on 'active' entries. */
  featured?: EditorPick;
  /** A cover picture set by hand (https); replaces the one the source publishes. Only the publisher's own picture. */
  cover?: string;
  /** Where the hand-set cover comes from and under which terms, shown under it. Required with `cover`. */
  coverFrom?: string;
  /** Show each story as its own card in the list and among the picks, not the source as one bundle. */
  single?: boolean;
  /** For editors only; in the editors' notes (editorial.ts), never published. */
  internal?: string;
}

export interface GsbStory {
  id: string;
  shortcode: string;
  /** Licence URL from the repository's story table. */
  licence: string;
  /** Open content question for this story: held until released. */
  review?: string;
}

export interface LinkItem {
  title: string;
  pageUrl: string;
  category?: Category;
  ages?: AgeRange;
  durationSec?: number;
  /** For recognising the file when it is dragged in. */
  fileName?: string;
  /**
   * The file's address as the title page links it (OHRKA: fileadmin/…mp3).
   * Becomes a file to save only where the provider allows saving
   * (providers.ts); never written from a guess.
   */
  fileUrl?: string;
  /** The publisher's player for the title (ARD Sounds: twitter:player of the episode page); see IndexItem.embed. */
  embed?: string;
  size?: number;
  /** The title's own picture on the publisher's page (https, cover.ts), when it has one. */
  cover?: string;
  /** The day the publisher takes it down (YYYY-MM-DD, e.g. ARD's unavailable_after); see IndexItem.until. */
  until?: string;
  /**
   * One sentence about the title, see IndexItem.about: written in the
   * catalogue from what its page states (production, author, speakers, age),
   * nothing beyond. It stands in until the builder reads the page: then the
   * page's own meta description wins.
   */
  about?: string;
  /** Speakers and authors as the title's page names them. */
  creators?: Person[];
}

/**
 * The official page that lists the titles of a link entry (an ARD Sounds
 * show, OHRKA topic pages). The builder reads it for new titles and fresh
 * facts (pages.ts) and admits new ones by fixed rules (rules.ts).
 */
export interface SeriesSource {
  reader: 'ardsounds' | 'ohrka';
  /** Show or topic pages, https on the reader's host. */
  urls: string[];
  /** The series' age holds for each title whose page names none (decided once for the whole series). */
  agesFromSeries?: boolean;
  /**
   * The age a series page states for all its titles, by page address, in the
   * publisher's words (OHRKA "Tierisch spannend": "Für alle Kinder ab 8").
   * A new title found on that page gets it when its own page names none.
   */
  pageAges?: Record<string, { min: number; max?: number; text: string }>;
  /** Read only the titles in the catalogue (fresh facts, gone or not), take no new ones. */
  noNew?: boolean;
}

export type CatalogEntry = CatalogBase &
  (
    | { type: 'podcast'; feedUrl: string; mediaHosts: string[]; maxItems?: number }
    | {
        type: 'archive-album';
        archiveId: string;
        /** The files a person listened to, with archive.org's sha1. A changed or added file holds the album. Required for 'active'. */
        files?: { name: string; sha1: string }[];
      }
    | { type: 'gitlab-gsb'; project: number; ref: string; path: string; stories: GsbStory[] }
    | { type: 'commons'; files: string[] }
    | {
        type: 'link';
        items: LinkItem[];
        /** Where the builder finds new titles and fresh facts of this series. */
        series?: SeriesSource;
      }
  );

/** The curated catalogue (sources/catalog.json). */
export interface SourceCatalog {
  format: 1;
  updatedAt: string;
  entries: CatalogEntry[];
  /** Entry ids and item keys removed at once (kill switch). */
  blocked: string[];
  /** Sources looked at and not used, with the reason; in the editors' notes (editorial.ts). */
  notUsed?: { name: string; reason: string }[];
  /** Set in the commit that removes many items on purpose; lifts the shrink gate for that build. */
  allowShrink?: boolean;
}

/** An item a person listened to after a hold (sources/released.json), with an optional age override. */
export interface ReleasedItem {
  key: string;
  by: string;
  at: string;
  note?: string;
  ages?: AgeRange;
  /** This single title is an editors' pick; only for titles of 'active' entries. */
  featured?: EditorPick;
}

export interface ReleasedList {
  format: 1;
  released: ReleasedItem[];
}
