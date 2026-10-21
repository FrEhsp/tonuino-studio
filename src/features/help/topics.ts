/**
 * The help centre as data: five topics (the categories of the start page),
 * each with its pages, and the words that lead to them. Every statement
 * describes what the code really does, so a change in behaviour needs a
 * change here as well; the places are named in tests/help/topics.test.ts
 * and in the comments below.
 *
 * One section is one short page. A problem page follows one pattern: a
 * sentence how you notice it (the summary), a checklist with the most
 * common cause first, what the app checks for you, then parts folded away
 * under "Mehr" (block `mehr`) for tinkerers, and at the very end at most
 * one thread of the forum (`forum`, see forumLinks.json).
 *
 * Texts use a tiny inline markup: **bold**, [label](href) and [[Wort]] or
 * [[Text|id]] for a word of the Wörterbuch (glossary.ts). Links starting
 * with "#/" stay in the app, "https://" links open in the browser. Every
 * topic, section and part id can be opened as #/hilfe/<id>, so ids are
 * unique across the whole help and never change once something links to
 * them; old ids live on in HELP_ALIASES.
 */

import { RELEASES_URL, releasesHost, updateCheckOffered } from '../../app/updatecheck';
import { MODIFIER_HOWTO } from '../../core/tonuino/modes';
import { CLASSIC21_SOUNDS_URL } from '../../core/tonuino/systemsounds';
import { isContactAddress } from '../sources/release';
import { DESKTOP_DOWNLOAD_URL } from './desktopapp';
import { forumLink } from './forum';
import { glossaryEntry, type GlossaryEntry } from './glossary';
import type { HelpArtId } from './HelpArt';

export interface HelpLink {
  label: string;
  href: string;
}

export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'steps'; items: string[] }
  | { kind: 'list'; items: string[] }
  /** A checklist to go through from the top: the most common cause first. At most six points. */
  | { kind: 'checks'; items: string[] }
  | { kind: 'note'; tone: 'info' | 'warning' | 'neutral'; text: string }
  /** A drawn picture (HelpArt.tsx); the caption says in words what it shows. */
  | { kind: 'bild'; art: HelpArtId; caption: string }
  /**
   * A screenshot of the app, cropped to what the step is about: a small
   * WebP in public/hilfe (HELP_PHOTOS), loaded only when its page is open.
   * The caption says in words what it shows.
   */
  | { kind: 'foto'; photo: HelpPhotoId; caption: string }
  /**
   * Folds away what follows, up to the next `mehr`, behind its title ("Für
   * Bastler", "Mit dem Handy" …). With an id, #/hilfe/<id> opens the page
   * with this part open, and the search lists it as a place of its own.
   */
  | { kind: 'mehr'; title: string; id?: string; keywords?: string[] }
  /** A sentence and a terminal command with a copy button. */
  | { kind: 'command'; text: string; command: string }
  /** Buttons to places in the app or on the web. */
  | { kind: 'links'; links: HelpLink[] }
  /** Generated from src/core/tonuino/modes.ts, so the list matches the app. */
  | { kind: 'modes' }
  | { kind: 'modifiers' }
  /** Generated from src/core/stickers/templates.ts. */
  | { kind: 'papers' }
  /** Generated from ./notices.ts. */
  | { kind: 'notices' }
  /** Generated from ./glossary.ts. */
  | { kind: 'glossary' }
  /** The version of the app and whether it runs in the browser or as desktop app. */
  | { kind: 'version' };

/**
 * The screenshots of the help, in public/hilfe: taken with
 * scripts/bench/shots.mjs in WebKitGTK on the made-up card of the bench and
 * cropped by scripts/bench/help-photos.sh. Width and height are those of the
 * file, so the page keeps its place while it loads.
 */
export const HELP_PHOTOS = {
  'karten-wege': { file: 'hilfe/karten-wege.webp', width: 730, height: 212 },
  'an-der-box': { file: 'hilfe/an-der-box.webp', width: 776, height: 588 },
  ablage: { file: 'hilfe/ablage.webp', width: 832, height: 312 },
  gesundheitscheck: { file: 'hilfe/gesundheitscheck.webp', width: 840, height: 242 },
} as const;

export type HelpPhotoId = keyof typeof HELP_PHOTOS;

export interface HelpSection {
  id: string;
  title: string;
  /**
   * One sentence under the title and in the list of the topic: how you
   * notice the problem, or what the page is about. Every page has one; only
   * SOURCES_HELP gets its own where the topic takes it in.
   */
  summary?: string;
  /** Search words that do not appear in the text, e.g. "leise" for the loudness section. */
  keywords?: string[];
  /**
   * Only for browsers that bring changes to the card in a Paket (Firefox,
   * Safari). Elsewhere the search lists it after every other page.
   */
  packageOnly?: boolean;
  /** The one thread of the forum to read on, as its number in forumLinks.json. */
  forum?: number;
  blocks: HelpBlock[];
}

export interface HelpTopic {
  id: string;
  title: string;
  /** The drawing on its tile on the start page. */
  art: HelpArtId;
  /** One sentence on the tile. */
  summary: string;
  keywords?: string[];
  sections: HelpSection[];
  /** One sentence under the list of pages, e.g. where to read on outside the app. Inline markup as in the texts. */
  footnote?: string;
}

/**
 * A thread of the forum as a button (block `links`), for threads to read on
 * in a part of a page; the one thread at the end of a page is `forum`. Every
 * thread is listed in forumLinks.json, so the check script sees its title.
 */
function forumButton(id: number, label?: string): HelpLink {
  const f = forumLink(id);
  if (!f) throw new Error(`Forum thread ${id} is missing in forumLinks.json`);
  return { label: label ?? `Im Forum: „${f.title}“`, href: f.url };
}

/** A part of a page folded away under "Mehr" (see the block `mehr`). */
export interface HelpPart {
  id?: string;
  title: string;
  keywords?: string[];
  blocks: HelpBlock[];
}

/** The blocks shown open, and the parts folded away after them. */
export function sectionParts(section: HelpSection): { main: HelpBlock[]; parts: HelpPart[] } {
  const main: HelpBlock[] = [];
  const parts: HelpPart[] = [];
  for (const b of section.blocks) {
    if (b.kind === 'mehr') parts.push({ id: b.id, title: b.title, keywords: b.keywords, blocks: [] });
    else (parts.length ? parts[parts.length - 1].blocks : main).push(b);
  }
  return { main, parts };
}

/* ------------------------------------------------------------------ inline markup */

export type InlinePart =
  | { kind: 'text'; text: string }
  /** `inner`: the markup inside, when the bold text holds a link or a word of the Wörterbuch ("**Der [[Ausschalt-Timer]]**"). */
  | { kind: 'strong'; text: string; inner?: string }
  | { kind: 'link'; text: string; href: string }
  /** A word of the Wörterbuch, shown with its explanation on a tap. */
  | { kind: 'term'; text: string; entry: GlossaryEntry };

const INLINE = /\*\*(.+?)\*\*|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Splits "Öffne [Hinzufügen](#/hinzufuegen) **jetzt**" into text, link, bold and Wörterbuch parts. */
export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  const push = (p: InlinePart) => {
    const prev = parts[parts.length - 1];
    if (p.kind === 'text' && prev?.kind === 'text') prev.text += p.text;
    else parts.push(p);
  };
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) push({ kind: 'text', text: text.slice(last, at) });
    if (m[1] !== undefined) {
      const inner = parseInline(m[1]);
      push(inner.every((p) => p.kind === 'text') ? { kind: 'strong', text: m[1] } : { kind: 'strong', text: inner.map((p) => p.text).join(''), inner: m[1] });
    }
    else if (m[2] !== undefined) {
      const entry = glossaryEntry(m[3] ?? m[2]);
      push(entry ? { kind: 'term', text: m[2], entry } : { kind: 'text', text: m[2] });
    } else push({ kind: 'link', text: m[4], href: m[5] });
    last = at + m[0].length;
  }
  if (last < text.length) push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** The text without markup, as people read it. */
export function plainText(text: string): string {
  return parseInline(text)
    .map((p) => p.text)
    .join('');
}

/** True for links that leave the app. */
export function isExternal(href: string): boolean {
  return /^https?:\/\//.test(href);
}


/* ------------------------------------------------------------------ content */

const SETTINGS = '[Einstellungen](#/einstellungen)';

/**
 * The switch "Auf neue Versionen hinweisen" (src/app/updatecheck.ts): only in
 * the desktop app of a build that names a release list. Only then the privacy
 * text speaks of it.
 */
const UPDATE_CHECK = __DESKTOP_BUILD__ && updateCheckOffered('desktop', RELEASES_URL);

/* ------------------------------------------------------------------ parts that depend on the build */

/*
 * "Entdecken" (src/features/sources) is only in builds that offer it
 * (`__SOURCES_ENABLED__`, see src/features/sources/release.ts). The other
 * builds leave out its section, its lines in the privacy text and the link
 * to it.
 */

/** The section "entdecken" in the topic "musik"; the "Entdecken" page links here ("Woher kommen die Inhalte?"). */
export const SOURCES_HELP: HelpSection = {
  id: 'entdecken',
  title: 'Freie Inhalte entdecken',
  keywords: ['entdecken', 'kostenlos', 'gratis', 'podcast', 'ard sounds', 'ohrka', 'gemeinfrei', 'creative commons', 'lizenz', 'herunterladen', 'altersangabe', 'quellen', 'empfehlungen', 'tipps', 'gute hörspiele', 'hörspielserie', 'serie', 'drei fragezeichen', 'tkkg', 'benjamin blümchen', 'paw patrol', 'tonie', 'toniebox'],
  blocks: [
    {
      kind: 'p',
      text: 'Unter [Entdecken](#/entdecken) findest du Hörspiele, Hörbücher und Lieder für Kinder und Jugendliche, die du legal und kostenlos herunterladen darfst. Ich hab die Liste von Hand zusammengestellt. Gesucht wird nur darin, nicht im ganzen Internet.',
    },
    { kind: 'p', text: 'Eigene CDs und gekaufte Hörbücher bringst du über [Hinzufügen](#/hinzufuegen) auf die Box. Was dabei geht, steht unter [CDs, Streaming und gekaufte Hörbücher](#/hilfe/cd-und-streaming).' },
    { kind: 'h3', text: 'Was in der Liste steht' },
    {
      kind: 'list',
      items: [
        '**Podcasts von Radiosendern** mit Hörspielen für Kinder. Ich nehme nur Podcasts auf, deren Folgen du für eure Familie speichern darfst. In der App steht bei ihnen „nur privat“.',
        '**Geschichten und Lieder mit freier Lizenz** (Creative Commons), zum Beispiel von Global Storybooks. Die Lizenz steht bei jedem Titel.',
        '**Hörspiele, Hörbücher und Wissen von Sendern und Vereinen**, zum Beispiel aus ARD Sounds, von Deutschlandfunk Kultur oder von OHRKA. Anhören kannst du viele davon gleich in der App. Speichern geht meist nur auf der Webseite des Anbieters, dort lädst du sie selbst herunter. Am Computer lade ich die Hörbücher von OHRKA selbst.',
      ],
    },
    { kind: 'h3', text: 'Wie ich auswähle' },
    {
      kind: 'p',
      text: 'Ich nehme eine Quelle erst auf, wenn die Rechte geklärt sind, und schau regelmäßig wieder rein. Neue Folgen einer Quelle kommen von selbst dazu, aber nur nach festen Regeln: auf Deutsch, lang genug, mit einer passenden Altersangabe und ohne Warnwörter, zum Beispiel zu Grusel oder Gewalt. Folgen, bei denen das nicht klar ist, bleiben draußen. Verschwindet eine Folge beim Anbieter, verschwindet sie auch aus der Liste.',
    },
    {
      kind: 'p',
      text: 'In der Liste stehen nur geprüfte Quellen, die du kostenlos herunterladen darfst. Wenn ich etwas besonders gut finde, steht es oben unter „Empfehlungen“. Dort steht jedes Hörspiel einzeln, nicht die ganze Sendung. Bekannte Serien wie „Die drei ???“, „TKKG“ oder „Bibi Blocksberg“ darf man nicht frei herunterladen, deshalb stehen sie nicht in der Liste. Auch die Hörspiele auf Tonie-Figuren kann ich nicht holen.',
    },
    {
      kind: 'note',
      tone: 'neutral',
      text: 'Die Altersangaben sind Empfehlungen: entweder die Angabe des Anbieters oder meine Schätzung. Jedes Kind ist anders. Höre am besten selbst kurz rein, bevor du etwas auf die Box lädst.',
    },
    { kind: 'h3', text: 'So kommt eine Folge auf die Box' },
    {
      kind: 'steps',
      items: [
        'Stecke die SD-Karte ein und öffne [Entdecken](#/entdecken).',
        'Wähle eine Quelle, höre mit „Reinhören“ kurz rein und wähle Folgen aus.',
        'Tippe auf „Zur Box hinzufügen“. Ich lade die Dateien direkt beim Anbieter und öffne danach die gewohnte Auswahl zum Prüfen und Übertragen.',
      ],
    },
    {
      kind: 'p',
      text: 'Manche Anbieter erlauben das Laden nur über ihre Webseite. Dann tippst du auf „Datei öffnen“ oder „Auf der Webseite öffnen“, speicherst die Datei auf deinem Computer und ziehst sie auf die Seite der Quelle in der App. Ich erkenne die Folge und schreibe Herkunft und Lizenz dazu. Das Bild der Quelle kommt als Cover mit.',
    },
    ...(__DESKTOP_BUILD__
      ? [
          {
            kind: 'p' as const,
            text: 'In der Desktop-App geht es noch leichter. Nach „Auf der Webseite öffnen“ schau ich 15\u00a0Minuten lang in deinem Download-Ordner nach. Speicherst du dort eine Hördatei, übernehme ich sie von selbst. Andere Dateien in dem Ordner öffne ich nicht.',
          },
        ]
      : []),
    { kind: 'p', text: 'Was der Anbieter beim Reinhören und Laden sieht, steht unter [Datenschutz](#/hilfe/datenschutz).' },
    { kind: 'h3', text: 'Herkunft und Lizenz bleiben dabei' },
    {
      kind: 'p',
      text: 'Ich schreibe zu jeder Datei, woher sie kommt, wer sie gemacht hat und unter welcher Lizenz sie steht, in die Datei und in die Liste auf der SD-Karte. Erlaubt ein Anbieter keine Änderungen, kommt die Datei genau so auf die Karte, wie sie geladen wurde. Dann stehen die Angaben nur in der Liste. Auf der Seite des Ordners steht alles unter „Herkunft und Lizenz“. Dort kannst du auch eine Quellenliste der ganzen Box speichern.',
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Titel mit „nur privat“ sind nur für eure Familie. Gib sie nicht weiter. Spiele sie nicht öffentlich ab, zum Beispiel nicht in der Kita oder in der Schule.',
    },
    { kind: 'h3', text: 'Etwas stimmt nicht?' },
    {
      kind: 'p',
      text: 'Passt eine Folge nicht zur Altersangabe, ist ein Link kaputt oder fehlt eine Angabe, schreibe uns über „Melden“ unten auf der Seite oder bei einer Folge. Wir sehen es uns an und nehmen Folgen, die nicht passen, aus der Liste.',
    },
  ],
};

/** "Melden" needs the contact address of the build; every release with "Entdecken" has one (release.ts). */
const CAN_REPORT = isContactAddress(import.meta.env.VITE_SOURCES_CONTACT);

const REPORT_HEADING = 'Etwas stimmt nicht?';

/** The blocks of SOURCES_HELP to show: without a contact address for „Melden“ the part about it is left out. */
export function sourcesHelpBlocks(canReport: boolean): HelpBlock[] {
  const blocks = SOURCES_HELP.blocks;
  if (canReport) return blocks;
  const at = blocks.findIndex((b) => b.kind === 'h3' && b.text === REPORT_HEADING);
  return at < 0 ? blocks : [...blocks.slice(0, at), ...blocks.slice(at + 2)];
}

/** "Entdecken" in "Wann die App ins Internet geht" (privacy section). */
export const PRIVACY_ONLINE =
  '**Entdecken:** Öffnest du [Entdecken](#/entdecken), lädt die App die Liste von ihrer eigenen Webseite. Auf Entdecken lädt sie außerdem die Coverbilder von den Servern der Quellen, die der Quellen-Übersicht gleich alle auf einmal im Hintergrund, und behält sie auf deinem Computer, damit sie beim nächsten Mal sofort da sind. Und sie fragt bei archive.org und den anderen Anbietern, deren Dateien sie selbst lädt, kurz nach, ob die Titel noch da sind (je Titel höchstens einmal in der Woche). Titel, die es dort nicht mehr gibt, blendet sie aus. Auch diese Server sehen deine IP-Adresse. Erst wenn du „Reinhören“ oder „Zur Box hinzufügen“ antippst, holt sie die Datei direkt beim Anbieter, zum Beispiel bei archive.org oder gitlab.com in den USA oder bei dem Radiosender, von dem die Folge ist. Der Anbieter sieht dabei deine IP-Adresse. Bei Folgen, die du nur über die Webseite des Anbieters laden kannst, schickt der Browser beim Reinhören auch die Cookies dieses Anbieters mit: Bist du dort angemeldet, kann er dich erkennen. Tippst du bei einer Folge von ARD Sounds auf „Anhören“, lädt die App den Player von ARD Sounds. Erst dann sieht ARD Sounds deine IP-Adresse und kann Cookies setzen.';

/**
 * The same line for the desktop app, which builds the list itself
 * (src/core/sources/local.ts) instead of loading it from the web app.
 */
export const PRIVACY_ONLINE_LOCAL = PRIVACY_ONLINE.replace(
  'lädt die App die Liste von ihrer eigenen Webseite.',
  'stellt die App die Liste höchstens einmal am Tag selbst zusammen. Sie fragt dafür die Seiten und Feeds der Radiosender (ARD Sounds, Deutschlandfunk Kultur) und die Seiten von OHRKA ab; diese Server sehen dabei deine IP-Adresse.',
);

/**
 * The same line for a desktop app built with a list but without an address
 * for a newer one (no VITE_WEB_ORIGIN): it uses the list it came with.
 */
export const PRIVACY_ONLINE_BUNDLED = PRIVACY_ONLINE.replace(
  'lädt die App die Liste von ihrer eigenen Webseite.',
  'zeigt die App die Liste, die mit ihr gekommen ist; eine neuere Liste lädt sie nicht.',
);

/** Desktop app with a list of its own and no address for a newer one. */
const BUNDLED_ONLY = __DESKTOP_BUILD__ && __SOURCES_BUNDLED__ && !import.meta.env.VITE_WEB_ORIGIN?.trim() && !import.meta.env.VITE_SOURCES_INDEX_URL?.trim();

/** "Melden" in the same line, when the build has it. */
const PRIVACY_REPORT = ' „Melden“ öffnet dein E-Mail-Programm mit einer fertigen Nachricht. Abschicken musst du sie selbst.';

/** "Entdecken" in "Was auf deinem Computer bleibt" (privacy section); the list goes on after it. */
export const PRIVACY_LOCAL = 'die zuletzt geladene Liste von „Entdecken“ und deine Auswahl von Art und Alter dort,';


/** The heading in SOURCES_HELP of the steps that bring an episode onto the box: they stay open. */
const SOURCES_HOWTO = 'So kommt eine Folge auf die Box';

/**
 * "Entdecken" with only the way onto the box open and the rest (what is in
 * the list, how it is chosen, origin and licence, reporting) folded away
 * under "Mehr". The blocks are regrouped by their headings, so SOURCES_HELP
 * keeps its own order and any block a build adds inside a group.
 */
function foldSources(blocks: HelpBlock[]): HelpBlock[] {
  const groups: HelpBlock[][] = [[]];
  for (const b of blocks) {
    if (b.kind === 'h3') groups.push([]);
    groups[groups.length - 1].push(b);
  }
  const howTo = groups.findIndex((g) => g[0]?.kind === 'h3' && g[0].text === SOURCES_HOWTO);
  if (howTo < 0) return blocks;
  const rest = groups.filter((_, i) => i > 0 && i !== howTo).flat();
  return [...groups[0], ...groups[howTo], { kind: 'mehr', title: 'Was in der Liste steht, Herkunft und Lizenz' }, ...rest];
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'probleme',
    title: 'Die Box macht Probleme',
    art: 'kat-probleme',
    summary: 'Stumm, Aussetzer, Geräusche, Tasten oder Karten: kurze Checklisten, das Häufigste zuerst.',
    keywords: ['fehler', 'geht nicht', 'hilfe', 'faq', 'problem', 'funktioniert nicht'],
    footnote: 'Noch mehr zur Fehlersuche, auch für Bastler: das [TonUINO-Kompendium](https://bluetchen.de/FSU/TonUINO_FSU.html) auf bluetchen.de, aus dem TonUINO-Forum.',
    sections: [
      {
        id: 'geschenkt',
        title: 'Ich habe die Box geschenkt bekommen',
        summary: 'Du weißt nicht, was in der Box steckt? Das meiste finde ich selbst heraus.',
        keywords: ['geschenkt', 'gebraucht', 'übernommen', 'was steckt drin', 'welche firmware', 'welche platine', 'wer hat die box gebaut', 'nichts aufgeschrieben', 'bedienkarte', 'anleitung', 'bedienungsanleitung'],
        blocks: [
          { kind: 'p', text: 'Oft hat niemand aufgeschrieben, was in einer selbst gebauten Box steckt. Das macht nichts, ich frage die Box selbst.' },
          {
            kind: 'steps',
            items: [
              'Verbinde die Box mit einem USB-Kabel, das Daten überträgt, mit dem Computer.',
              'Öffne das [Box-Logbuch](#/werkstatt/logbuch) und schalte die Box ein.',
              'Der [[Steckbrief]] zeigt jetzt [[Firmware]], [[Platine]], Tasten, ob [[Kartenleser]] und [[MP3-Player]] antworten und wie die Box eingestellt ist.',
            ],
          },
          {
            kind: 'p',
            text: 'Danach kennt [Box einstellen](#/werkstatt/einstellen) die Werte deiner Box. Was auf der SD-Karte ist, zeigt [Meine Box](#/), sobald die Karte im Computer steckt ([so kommst du an sie](#/hilfe/sd-karte-herausnehmen)).',
          },
          { kind: 'bild', art: 'box-innen', caption: 'Ein Blick in eine typische Box: Strom, Kartenleser, MP3-Player mit der SD-Karte, ein kleiner Rechner, Lautsprecher und Tasten.' },
          {
            kind: 'p',
            text: 'Für alle, die mit der Box spielen: Die [Bedienkarte](#/werkstatt/bedienkarte) in der Werkstatt ist eine Karte zum Ausdrucken. Sie zeigt, was die Tasten deiner Box kurz und lang machen.',
          },
          { kind: 'p', text: 'Fremde Wörter wie TNG oder AiO erklärt das [Wörterbuch](#/hilfe/woerterbuch).' },
        ],
      },
      {
        // Causes and checks from the TonUINO forum: power and power banks, a box asleep after its standby
        // timer, volume 0, headphone jack, boards without firmware, FAT32 and file names, files copied one
        // by one, missing announcements, loose cables to the MP3 player, swapped speaker wires, clicking
        // from too little power, broken boards.
        id: 'box-bleibt-stumm',
        title: 'Die Box bleibt stumm',
        summary: 'Kein Ton, keine Ansagen, auch nicht beim Auflegen einer Karte.',
        forum: 14094,
        keywords: [
          'kein ton',
          'macht keinen ton',
          'ton fehlt',
          'still',
          'nichts zu hören',
          'hört nichts',
          'keine musik',
          'ohne ton',
          'ton ist weg',
          'kein sound',
          'box spielt nicht',
          'spielt nichts',
          'sagt nichts',
          'spricht nicht',
          'box geht nicht an',
          'box geht nicht mehr an',
          'box startet nicht',
          'lautsprecher',
          'kopfhörer',
          'powerbank',
          'netzteil',
          'akku',
        ],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Strom:** Schalte die Box aus und wieder ein. Lade den Akku oder nimm ein Netzteil mit 5\u00a0V und mindestens 2\u00a0A. Mit Powerbank: [Die Powerbank schaltet ab](#/hilfe/powerbank).',
              '**Lautstärke und Kopfhörer:** Drehe ein paar Stufen lauter. Steckt ein Stecker in der Kopfhörerbuchse, ist der Lautsprecher aus.',
              '**Schläft die Box?** Nach dem [[Ausschalt-Timer]] wacht manche Box erst auf, wenn du kurz den Strom trennst: [Die Box geht aus – oder nicht aus](#/hilfe/box-geht-aus).',
              '**SD-Karte:** Stecke sie in den Computer und öffne [Meine Box](#/). Zeigt der Gesundheitscheck einen Hinweis, klicke auf „Ansehen und reparieren“.',
              '**Wackelkontakt:** Klackt die Box nur, oder geht es mal und mal nicht: [Wackelkontakt und schlechte Lötstellen](#/hilfe/wackelkontakt).',
              '**Frage die Box:** Im [Box-Logbuch](#/werkstatt/logbuch) zeigt der Steckbrief, ob der MP3-Player antwortet und wie viele Dateien er findet.',
            ],
          },
          {
            kind: 'note',
            tone: 'info',
            text: 'Spielt die Box Musik, schweigt aber beim Anlernen oder im Menü? Dann fehlen nur die [[Systemansagen]]. Du spielst sie in der Werkstatt unter [Systemansagen](#/werkstatt/ansagen) auf.',
          },
          { kind: 'mehr', title: 'Die SD-Karte: was der Gesundheitscheck repariert' },
          {
            kind: 'list',
            items: [
              '**Format:** Der MP3-Player liest nur [[FAT32]], am besten mit höchstens 32\u00a0GB: [Die SD-Karte wird nicht erkannt](#/hilfe/sd-karte-geht-nicht).',
              '**Einzeln nachkopiert:** Liegen Dateien in der falschen Reihenfolge auf der Karte, findet der MP3-Player manchmal keine Titel. In Chrome, Edge und der Desktop-App zeigt das der Gesundheitscheck: Klicke auf „Ordner neu ordnen“. Versteckte Dateien entfernt „Aufräumen“. In Firefox und Safari sehe ich die Reihenfolge auf der Karte nicht.',
              '**Hilft das nicht,** [baue die Karte neu auf](#/hilfe/karte-neu-aufbauen): Ich sichere alles, was die Box abspielt, dann formatierst du die Karte, und ich spiele alles zurück. Alle Ordner behalten ihre Nummer.',
            ],
          },
          { kind: 'foto', photo: 'gesundheitscheck', caption: 'Findet der Gesundheitscheck etwas, steht es in Meine Box über dem Regal. Mit „Ansehen und reparieren“ siehst du jeden Punkt und reparierst ihn.' },
          { kind: 'mehr', title: 'Für Bastler: Platine, Lautsprecher, Kabel' },
          {
            kind: 'list',
            items: [
              '**Neue Platine:** Meldet sich die Box auch im Logbuch nicht, ist vielleicht noch keine Firmware darauf: [Firmware aufspielen](#/werkstatt/firmware).',
              '**Lautsprecher:** Ein loses Kabel macht die Box stumm. Klingt sie sehr leise, sind die beiden Kabel vielleicht vertauscht. Eine falsch angeschlossene Kopfhörerbuchse schaltet den Lautsprecher immer aus.',
              '**Klacken statt Musik:** Der MP3-Player bekommt zu wenig Strom. Probiere ein anderes Netzteil und prüfe Stecker und Lötstellen.',
              '**Ein Licht auf der Platine wird beim Einschalten dunkler** und die Box meldet sich nicht: Die Platine ist vielleicht kaputt. Frage beim Händler nach.',
            ],
          },
        ],
      },
      {
        id: 'box-spielt-nicht-richtig',
        title: 'Spielt nur den ersten Titel, hängt oder springt',
        summary: 'Die Box spielt, aber nur einen Titel, bleibt hängen, springt, leiert oder startet neu.',
        forum: 13455,
        keywords: [
          'spielt nur den ersten titel',
          'erster titel',
          'ersten titel',
          'hängt',
          'hängt sich auf',
          'hängen',
          'bleibt hängen',
          'neustart',
          'startet neu',
          'leiert',
          'zu schnell',
          'überspringt',
          'springt',
          'spielt nicht richtig',
        ],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**So gewollt?** Bei „Zufällige Folge“ und „Einzeltitel“ spielt eine Karte nur einen Titel, ebenso mit der Spezialkarte „Pause nach jedem Titel“: [Wie eine Karte spielt](#/hilfe/wiedergabearten).',
              '**Strom:** Ein schwacher Akku löst fast jeden dieser Fehler aus. Startet die Box beim Auflegen einer Karte oder laut neu, liegt es fast immer am Strom.',
              '**SD-Karte:** Der Gesundheitscheck in [Meine Box](#/) findet versteckte, falsch benannte und leere Dateien. Die Desktop-App meldet auch exFAT und Karten über 32\u00a0GB, dann spielt die Box oft nur den ersten Titel.',
              '**Immer am selben Titel:** Lösche ihn auf der Seite des Ordners und füge die Originaldatei neu hinzu. Ich prüfe sie dabei, mehr unter [Welche Dateien gehen?](#/hilfe/dateiformate)',
              '**Früher Dateien einzeln kopiert?** Dann hilft oft, [die Karte neu aufzubauen](#/hilfe/karte-neu-aufbauen).',
              '**An immer anderen Stellen:** Die SD-Karte ist vielleicht abgenutzt. „Gründlich prüfen“ im Gesundheitscheck (unter „Mehr“) liest jede MP3 einmal ganz und findet kaputte Dateien und eine Karte, die schwächelt. Oder eine Lötstelle am Kartenhalter wackelt: [Wackelkontakt](#/hilfe/wackelkontakt).',
            ],
          },
          { kind: 'mehr', title: 'Spielt bei jedem Einschalten denselben Titel' },
          {
            kind: 'list',
            items: [
              '**Das ist so eingestellt:** Hat die Box eine Kurzwahl „Beim Einschalten“, spielt sie bei jedem Start etwas, etwa einen Startton. Du änderst das unter [Box einstellen](#/werkstatt/einstellen).',
              '**Das liegt an der Technik:** Spielt sie ohne Kurzwahl bei jedem Start Titel 001 aus Ordner 01, hat sie vielleicht eine selbst gebaute Firmware mit SPECIAL_START_SHORTCUT, und am Anschluss A6 liegt Spannung. Ein Widerstand mit 100\u00a0kΩ von A6 nach GND verhindert das.',
            ],
          },
          { kind: 'mehr', title: 'Für Bastler: Kabel und nachgebaute Chips' },
          {
            kind: 'list',
            items: [
              '**Überspringt Titel:** Bei Boxen mit Arduino Nano sitzt oft ein Kabel zum MP3-Player locker. Das [Box-Logbuch](#/werkstatt/logbuch) meldet dann „Titelende nicht gemeldet“.',
              '**Springt nach einer Ansage weiter, spielt nur die Ansagen oder nur die Hörspiele:** Das machen manche [[nachgebauten MP3-Player-Chips|nachbau-chip]]: [Nachgebauter MP3-Player](#/hilfe/nachbau-chip).',
            ],
          },
        ],
      },
      {
        id: 'aussetzer',
        title: 'Die Box hört mittendrin auf',
        summary: 'Die Box hält mitten im Titel an, stottert oder fängt nach dem Auflegen gar nicht erst an.',
        forum: 14703,
        keywords: [
          'aussetzer',
          'stockt',
          'stottert',
          'stottern',
          'ruckelt',
          'ruckeln',
          'hakt',
          'unterbricht',
          'hält an',
          'pausiert',
          'musik fängt nicht an',
          'ton aber keine musik',
          'akku',
          'karte weg',
        ],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Akku laden:** Ein schwacher Akku ist der häufigste Grund.',
              '**Beim Anstoßen oder Hochheben:** ein Wackelkontakt: [Wackelkontakt und schlechte Lötstellen](#/hilfe/wackelkontakt).',
              '**Pausiert immer wieder:** Manche Boxen halten an, sobald die Karte weg ist. Liegt sie am Rand des Lesers, verliert die Box sie kurz. Lege sie mittig auf.',
              '**Mit Powerbank, in der Pause:** [Die Powerbank schaltet ab](#/hilfe/powerbank).',
              '**Immer an derselben Stelle:** Datei oder SD-Karte: [Spielt nur den ersten Titel, hängt oder springt](#/hilfe/box-spielt-nicht-richtig).',
            ],
          },
          {
            kind: 'p',
            text: 'Ob die Box bei weggenommener Karte anhält, steht im Steckbrief des [Box-Logbuchs](#/werkstatt/logbuch). Wechseln sich dort „Karte weggenommen“ und „Karte aufgelegt“ ab, obwohl niemand die Karte anfasst, liegt es am Akku oder an der Lage der Karte.',
          },
          { kind: 'mehr', title: 'Du hörst etwas, aber keine Musik' },
          { kind: 'p', text: 'Die Ursache ist nicht sicher bekannt. Lade den Akku, stecke einen LED-Ring zum Test ab, drücke Pause und lege die Karte noch einmal auf.' },
        ],
      },
      {
        id: 'box-geht-aus',
        title: 'Die Box geht aus – oder nicht aus',
        summary: 'Die Box geht von selbst aus oder reagiert auf nichts mehr. Oder sie bleibt an, und der Akku wird leer.',
        forum: 13464,
        keywords: [
          'geht aus',
          'geht einfach aus',
          'schaltet sich aus',
          'nach kurzer zeit aus',
          'geht von selbst an',
          'von alleine',
          'schaltet ab',
          'tot',
          'eingefroren',
          'schläft',
          'sleep',
          'ausschalt-timer',
          'pololu',
          'ladekabel',
          'reagiert nicht',
          'geht nicht aus',
          'box geht nicht aus',
          'geht nie aus',
          'schaltet sich nicht aus',
          'schaltet nicht ab',
          'akku leer',
          'batterie',
          'läuft weiter',
          'schlafen',
        ],
        blocks: [
          {
            kind: 'p',
            text: '**Erst ein Blick auf das Licht am Kartenleser:** Ist es aus, hat die Box keinen Strom: Meist hat die Powerbank abgeschaltet, oder die Box hat sich mit dem Ausschalt-Timer ganz ausgeschaltet. Leuchtet es, schläft ein Classic ohne Abschalt-Technik nach dem Timer nur. Ohne Timer, oder bei einer AiO, hängt sie vielleicht nach einem Fehler beim Abspielen: Aus- und einschalten, SD-Karte in [Meine Box](#/) prüfen.',
          },
          { kind: 'h3', text: 'Sie geht von selbst aus' },
          {
            kind: 'checks',
            items: [
              '**In der Pause, mit Powerbank:** [Die Powerbank schaltet ab](#/hilfe/powerbank).',
              '**Nach 5, 15, 30 oder 60\u00a0Minuten ohne Musik:** Das ist der [[Ausschalt-Timer]]: [Box einstellen](#/hilfe/box-einstellen).',
              '**Laut, mitten im Lied:** Bricht die Spannung ein, startet die Box neu: [Laut klingt es kratzig](#/hilfe/kratzig).',
              '**Gleich nach dem Einschalten, oft nach einem Update:** Die Firmware passt nicht zur Abschalt-Technik: [Firmware aufspielen](#/hilfe/firmware).',
              '**Lang auf Play/Pause gedrückt:** Mit TonUINO TNG schaltet das die Box aus, solange nichts läuft. TonUINO 2.1 kann das nicht.',
              '**Schlummerkarte:** Bei TNG schaltet sie die Box nach ihrer Zeit aus, bei 2.1 hält sie die Box nur an: [Spezialkarten](#/hilfe/spezialkarten).',
            ],
          },
          { kind: 'h3', text: 'Sie geht nicht von selbst aus' },
          {
            kind: 'checks',
            items: [
              '**Der Timer ist aus:** Ab Werk ist er aus, auch nach dem Zurücksetzen. Schalte ihn unter [Box einstellen](#/werkstatt/einstellen) ein.',
              '**Ohne Abschalt-Technik:** AiO und AiO+ schalten sich ganz ab. Ein Classic schläft nur und braucht weiter etwa 30\u00a0mA, außer er hat einen [[Pololu-Schalter oder eine Abschalt-Platine|abschalt-technik]].',
              '**Spezialkarte:** Bei TonUINO TNG ab 3.3.2 schaltet die Spezialkarte „Ausschalt-Timer aus“ den Timer ab, bis du sie noch einmal auflegst.',
              '**Eine LED:** Hast du eine LED eingebaut, damit die Powerbank in der Pause anbleibt, hält sie die Powerbank auch nach dem Timer wach.',
            ],
          },
          { kind: 'mehr', title: 'Alte Firmware, Party-Karte, Ladekabel, geht von selbst an' },
          {
            kind: 'list',
            items: [
              'TonUINO 2.x startet den Timer nach einem Fehler beim Abspielen manchmal nicht wieder. Prüfe die SD-Karte und spiele die aktuelle [Firmware](#/werkstatt/firmware) auf.',
              'Bei TonUINO 2.x bleibt eine Party-Karte für einen Ordner mit nur einem Titel stehen, und der Timer startet nicht. [Karten beschreiben](#/karten) warnt dich bei solchen Karten.',
              'Ein lockerer Stecker am Kartenleser kann die Box wach halten. Die Reset-Taste schaltet eine AiO sofort aus.',
              'Beim Ein- und Ausstecken des Ladekabels schalten manche Powerbanks kurz um, und die Box startet neu. Das ist harmlos.',
              'Geht die Box von selbst an, vermutet man einen Wackler an der Powerbank, lange Tastenkabel bei Pololu-Schalter oder ein Handy daneben.',
            ],
          },
        ],
      },
      {
        // TODO 0.3 #31. Forum: 6179#1 (30-60 s, no reliable list), 14675#1/#5 (wake with the button or by
        // plugging in again), 14305#2/#11 (about 28 mA in standby, a switch LED about 15 mA), 14761#4
        // (a lit switch kept it on), 14321#4-#8 (red LED: 100 Ω kept it on, 220 Ω not, about 20 mA),
        // 6179#23 (capacitor). TNG has no keep-alive function, only the standby timer and the shutdown pin.
        id: 'powerbank',
        title: 'Die Powerbank schaltet ab',
        summary: 'Die Box geht in der Pause aus, oder sie startet mit der Powerbank gar nicht erst.',
        forum: 14761,
        keywords: ['powerbank schaltet ab', 'geht in der pause aus', 'pause', 'mindeststrom', 'zu wenig strom', 'dauerlast', 'dauer-led', 'led', 'keep alive', 'wach halten', 'ruhemodus', 'durchladen', 'akkupack'],
        blocks: [
          {
            kind: 'p',
            text: 'Viele Powerbanks schalten nach 20 bis 60\u00a0Sekunden ab, wenn kaum Strom fließt, und eine pausierte Box braucht sehr wenig. Die [[Firmware]] kann dagegen nichts tun. Eine Funktion, die die Powerbank wach hält, hat sie nicht.',
          },
          {
            kind: 'checks',
            items: [
              '**Wecken:** Drücke den Knopf an der Powerbank, oder stecke das Kabel neu ein. Manche lassen sich nur so wecken.',
              '**Eine LED, die immer leuchtet:** Ein beleuchteter Schalter oder eine Dauer-LED braucht etwa 15 bis 20\u00a0mA und hält viele Powerbanks wach. Wie du sie anschließt, zeigt der [Lötplan](#/werkstatt/loetplan).',
              '**Eine andere Powerbank:** Eine verlässliche Liste gibt es nicht. Probiere ein paar aus. Sie muss laden und dabei die Box versorgen können.',
              '**Dauerhaft:** Ein [[Pololu-Schalter]] trennt den Strom ganz, und eine AiO mit eigenem Akku braucht keine Powerbank.',
            ],
          },
          {
            kind: 'note',
            tone: 'neutral',
            text: 'Mit Dauer-LED geht die Box nach dem [[Ausschalt-Timer]] nicht mehr ganz aus: [Die Box geht aus – oder nicht aus](#/hilfe/box-geht-aus).',
          },
          { kind: 'mehr', title: 'Für Bastler: wie viel Strom?' },
          {
            kind: 'p',
            text: 'Ein schlafender Classic braucht etwa 28\u00a0mA. Im Forum blieb eine Powerbank mit einer roten LED und 100\u00a0Ω an 5\u00a0V an, mit 220\u00a0Ω nicht (etwa 20\u00a0mA). Hängt die LED am Ausgang des Pololu-Schalters, geht sie mit dem Timer aus. Liefert die Powerbank nach dem Aufwachen zu wenig, hilft ein Elko mit 100 bis 1000\u00a0µF.',
          },
        ],
      },
      {
        // TODO 0.3 #28. Forum: 13047 (dropouts from a loose button), 12704 (thin jumper wires), 13425#3
        // (breadboard only for testing), 10057#9 (flux left over: phantom presses, numbers read out),
        // 14806#3 (MP3 player pins touching the SD holder look like an SD fault), 14745 ("Com to DFPlayer broken").
        id: 'wackelkontakt',
        title: 'Wackelkontakt und schlechte Lötstellen',
        summary: 'Aussetzer beim Anstoßen, Knacken, eine Taste geht mal und mal nicht, die Box startet neu.',
        forum: 13047,
        keywords: [
          'wackelkontakt',
          'wackler',
          'lötstelle',
          'lötstellen',
          'kalte lötstelle',
          'nachlöten',
          'löten',
          'gelötet',
          'kabel locker',
          'lose',
          'anstoßen',
          'umwerfen',
          'wackeltest',
          'holzstäbchen',
          'steckbrett',
          'dupont',
          'lötwasser',
          'flussmittel',
          'kurzschluss',
        ],
        blocks: [
          { kind: 'p', text: 'Bei selbst gebauten Boxen ist das einer der häufigsten Fehler. Meist findest du die Stelle in ein paar Minuten.' },
          {
            kind: 'checks',
            items: [
              '**Wackeltest:** Lasse die Box spielen und tippe mit einem Holzstäbchen Kabel, Stecker und Platinen an. Setzt der Ton aus, knackt es oder startet die Box neu, sitzt der Fehler dort. [Box testen](#/werkstatt/testen) führt dich hindurch.',
              '**Steckkabel:** Gesteckte und dünne Kabel vom Steckbrett machen oft Ärger. Drücke die Stecker fest oder löte die Kabel an.',
              '**Lötstellen ansehen:** Eine gute glänzt wie ein kleiner Vulkan um den Draht. Eine [[kalte Lötstelle]] ist matt und kugelig. Löte sie nach.',
              '**Reste von Lötwasser** leiten ein wenig Strom. Dann drückt die Box Tasten von selbst oder sagt Zahlen an. Wische sie ab, zum Beispiel mit Isopropanol.',
              '**Der MP3-Player darf den Halter der SD-Karte nicht berühren.** Ein Kurzschluss dort sieht aus wie ein Fehler der Karte.',
            ],
          },
          { kind: 'bild', art: 'loetstelle', caption: 'Links eine gute Lötstelle: glänzend, wie ein kleiner Vulkan um den Draht. Rechts eine kalte: matt und kugelig, der Kupferring schaut noch heraus.' },
          { kind: 'mehr', title: 'So geht der Wackeltest' },
          { kind: 'bild', art: 'wackeltest', caption: 'Die Box spielt, du tippst mit einem Holzstäbchen die Kabel an. Wo es aussetzt oder knackt, sitzt der Fehler.' },
          {
            kind: 'p',
            text: 'Lege eine Karte auf und lasse Musik laufen. Klopfe mit einem Holzstab, etwa dem Stiel eines Kochlöffels, sanft auf Platinen, Kabel und Lötstellen, zuerst beim Strom. Ist die Box per USB verbunden, macht [Box testen](#/werkstatt/testen) das als letzten Schritt und schreibt sofort auf, was ausfällt. Vor dem Löten schaltest du sie aus.',
          },
          {
            kind: 'list',
            items: [
              '**Die Box startet neu:** Der Strom war kurz weg. Prüfe 5V und GND, USB-Kabel und Powerbank.',
              '**Die Musik hört auf, als wäre die Karte weg:** Kabel oder Lötstelle am Kartenleser.',
              '**„Com to DFPlayer broken“ oder der MP3-Player hakt:** die Leitungen D2 und D3 zum MP3-Player.',
            ],
          },
        ],
      },
      {
        // Forum: 5476 (noise from the lines to the MP3 player and the chip), 11116 (rattling when knocked over).
        id: 'stoergeraeusche',
        title: 'Es knackt, rauscht oder brummt',
        summary: 'Aus dem Lautsprecher kommt Knacken, Knattern, Rauschen, Brummen oder ein Pling, das nicht zur Musik gehört.',
        forum: 5476,
        keywords: ['knackt', 'knacken', 'knattert', 'knattern', 'rauscht', 'rauschen', 'brummt', 'brummen', 'zirpt', 'fiept', 'pfeift', 'tackern', 'knistert', 'knistern', 'knackgeräusche', 'summt', 'störgeräusche', 'geräusch', 'pling', 'ping', 'piept immer wieder', 'piepton'],
        blocks: [
          { kind: 'p', text: 'Das kommt fast immer vom Strom oder von Kabeln, kaum von der SD-Karte. Formatieren oder eine neue Firmware hilft dann nicht.' },
          {
            kind: 'checks',
            items: [
              '**Bei schwachem Akku oder beim Laden:** Lade den Akku. Rauscht es nur beim Laden, probiere ein anderes Ladegerät.',
              '**Nur laut:** [Laut klingt es kratzig](#/hilfe/kratzig).',
              '**Beim Anstoßen, oder immer:** Kabel zum Lautsprecher und Lötstellen: [Wackelkontakt](#/hilfe/wackelkontakt).',
              '**Nur bei bestimmten Titeln:** Dann steckt es in der Datei. Rauscht die Box statt zu spielen: [Falscher Titel](#/hilfe/falsche-titel).',
              '**Ein kurzer Pling, immer wieder:** So warnt eine Firmware mit Akku-Messung, dass der Akku fast leer ist. Das [Box-Logbuch](#/werkstatt/logbuch) zeigt dann „Akku fast leer“. Beim Einschalten und Auflegen ist der Ton nur die Bestätigung.',
              '**Tackern, nachdem die Box aus ist:** Die Akkus sind leer. Lade sie gleich.',
            ],
          },
          { kind: 'mehr', title: 'Was harmlos ist' },
          {
            kind: 'p',
            text: 'Leises Zirpen in leisen Stellen macht der MP3-Player selbst. Eine Platine, an der noch nichts hängt, pfeift oft leise. Klacken statt Musik gehört zu [Die Box bleibt stumm](#/hilfe/box-bleibt-stumm).',
          },
        ],
      },
      {
        // TODO 0.3 #26/#27. Forum: 9928#1 (a 4-Ω speaker stable up to 20, others to 26), 9928#2 (PC USB:
        // crashes and rattling; 5 V/2 A fine), 7829 (4-8 Ω, 8 Ω spares the amplifier), 12670 (2 Ω distorts),
        // 11116 (rattling at the top volume). That the bass setting adds to it is a guess.
        id: 'kratzig',
        title: 'Laut klingt es kratzig',
        summary: 'Auf den obersten Stufen knattert, kratzt oder scheppert die Box, leiser klingt sie gut.',
        forum: 11116,
        keywords: ['kratzig', 'kratzt', 'verzerrt', 'übersteuert', 'übersteuern', 'scheppert', 'klirrt', 'knattert laut', 'höchste lautstärke', 'maximale lautstärke', 'volle lautstärke', '4 ohm', '8 ohm', 'verstärker'],
        blocks: [
          { kind: 'p', text: 'Der kleine Verstärker im [[MP3-Player]] schafft die obersten Stufen oft nicht sauber, und ganz oben bricht leicht die Spannung ein.' },
          {
            kind: 'checks',
            items: [
              '**Höchste Lautstärke begrenzen:** etwa 20 bis 24 statt 30. [Box einstellen](#/werkstatt/einstellen) schlägt dir einen Wert vor.',
              '**Strom:** ein Netzteil mit 5\u00a0V und 2\u00a0A statt des USB-Anschlusses am Computer, und ein geladener Akku.',
              '**Klang „Normal“** statt „Bass“. Vermutlich macht Bass das Kratzen schlimmer.',
              '**Laut aufgenommene Dateien:** [Gleiche Lautstärke für alle Alben](#/hilfe/lautstaerke) macht nichts so laut, dass es übersteuert. Kratzt ein Titel auch am PC, liegt es an der Datei: [Dateien, die schon kratzen](#/hilfe/uebersteuert).',
              '**Lautsprecher:** 4 bis 8\u00a0Ω passen, 8\u00a0Ω schont den Verstärker. Mit 2\u00a0Ω verzerrt es.',
              '**Knattert es auch beim Anstoßen,** ist es eher ein [Wackelkontakt](#/hilfe/wackelkontakt).',
            ],
          },
        ],
      },
      {
        // Forum: 11466 (too loud at start, fine after reset), 10750#4 (newer MH2024K-24SS ignore setVolume).
        id: 'zu-laut-beim-start',
        title: 'Zu laut beim Einschalten',
        summary: 'Die Box startet jedes Mal viel zu laut, oder sie wird mitten im Spielen plötzlich laut.',
        forum: 11466,
        keywords: ['zu laut', 'zu laut beim einschalten', 'fängt laut an', 'laut los', 'plötzlich sehr laut', 'beim einschalten laut', 'erschreckt'],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Wie ist sie eingestellt?** Der Steckbrief im [Box-Logbuch](#/werkstatt/logbuch) zeigt, wie laut die Box startet und höchstens wird. Ändern kannst du beides unter [Box einstellen](#/hilfe/box-einstellen).',
              '**Richtig eingestellt und trotzdem zu laut:** Dann kommt die Lautstärke beim MP3-Player nicht an. Das machen manche [nachgebauten MP3-Player](#/hilfe/nachbau-chip).',
              '**Plötzlich mitten im Betrieb laut:** Vermutlich hat eine kurze Unterbrechung im Strom den MP3-Player zurückgesetzt. Prüfe Akku, Stecker und [Lötstellen](#/hilfe/wackelkontakt).',
            ],
          },
        ],
      },
      {
        // Forum 14533: quiet headphones on an AiO were high-impedance earphones (#2, #12, #13).
        id: 'kopfhoerer',
        title: 'Kopfhörer zu laut oder zu leise',
        summary: 'Mit Kopfhörern ist die Box viel zu laut, oder kaum zu hören.',
        forum: 14533,
        keywords: ['kopfhörer zu laut', 'kopfhörer leiser', 'kopfhörer leise', 'kopfhörer lautstärke', 'ohren', 'buchse', 'gehörschutz', 'kopfhörerbuchse'],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Box mit Kopfhörer-Erkennung,** etwa die AiO+ mit TonUINO TNG: Schalte unter [Box einstellen](#/werkstatt/einstellen) „Lautstärke für Kopfhörer“ ein. „Leiser für Kopfhörer“ heißt höchstens 15 und beim Einschalten 5. Stecke den Kopfhörer ein, bevor du die Tasten drückst. Die Werte gelten nur, solange er steckt.',
              '**Buchse ohne Erkennung:** Der Kopfhörer bekommt das verstärkte Signal und kann sehr laut werden. Stelle eine niedrige höchste Lautstärke für die ganze Box ein.',
              '**Zu leise:** Manche Kopfhörer sind an der Box viel leiser. Im Forum waren In-Ear-Kopfhörer deutlich lauter.',
            ],
          },
          { kind: 'note', tone: 'warning', text: 'Probiere jede Einstellung erst selbst auf höchster Stufe aus, bevor dein Kind den Kopfhörer aufsetzt.' },
        ],
      },
      {
        id: 'tasten',
        title: 'Die Tasten spinnen',
        summary: 'Tasten tun nichts oder das Falsche, sind vertauscht, oder die Box drückt von selbst.',
        forum: 10057,
        keywords: [
          'tasten vertauscht',
          'tasten umdrehen',
          'tasten falsch herum',
          'vor zurück vertauscht',
          'taste klemmt',
          'tasten reagieren nicht',
          'tasten funktionieren nicht',
          'tasten gehen nicht',
          'knopf',
          'knöpfe',
          '3 tasten',
          '5 tasten',
          'drückt von selbst',
          'sagt zahlen',
          'ruft zahlen aus',
        ],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**So gewollt?** Der Krabbelmodus sperrt alle Tasten, der Kita-Modus bei TNG alle außer Play/Pause. Lege die Spezialkarte noch einmal auf. Bei „Zufällige Folge“ und „Einzeltitel“ tut Vor nichts.',
              '**Vor und Zurück vertauscht:** Die Tastenplatine ist vermutlich falsch herum eingebaut. Drehe sie um.',
              '**Die Box drückt von selbst oder sagt Zahlen an:** Eine Taste klemmt, oder Lötwasser verbindet zwei Lötstellen: [Wackelkontakt und schlechte Lötstellen](#/hilfe/wackelkontakt).',
              '**Nach einem Update geht nichts mehr:** Die Firmware passt nicht zu deinen Tasten. Spiele sie mit den richtigen Tasten neu auf: [Firmware aufspielen](#/hilfe/firmware).',
            ],
          },
          { kind: 'p', text: 'Welche Taste die Box erkennt, zeigt [Box testen](#/werkstatt/tasten).' },
          {
            kind: 'note',
            tone: 'neutral',
            text: 'Hältst du beim Einschalten Play/Pause, Vor und Zurück gedrückt, löscht die Box ihre Einstellungen. Lauter und Leiser zählen dabei nicht. Mehr: [Anlernen klappt nicht oder PIN vergessen](#/hilfe/anlernen-klappt-nicht).',
          },
        ],
      },
      {
        id: 'falsche-titel',
        title: 'Falscher Titel oder falsche Reihenfolge',
        summary: 'Die Box spielt andere Titel als gedacht, rauscht statt zu spielen oder bringt die Reihenfolge durcheinander.',
        forum: 13633,
        keywords: ['falsch', 'falsche titel', 'durcheinander', 'rauschen', 'fehler 6', 'versteckte dateien', 'mac', 'reihenfolge', 'falscher ordner', 'box spielt falsche titel'],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Gesundheitscheck:** Öffne [Meine Box](#/) und klicke auf „Ansehen und reparieren“. Er findet versteckte Dateien (etwa ._001.mp3 vom Mac), Lücken, doppelte Nummern und falsche Namen. Er löscht dabei keine Hörspiele.',
              '**Reihenfolge auf der Karte:** Manche MP3-Player spielen in der Reihenfolge, in der die Dateien auf die Karte kamen. In Chrome, Edge und der Desktop-App prüfe ich das nach dem Übertragen und bringe es in Ordnung. In Firefox und Safari sehe ich die Reihenfolge auf der Karte nicht. Dann [baue die Karte neu auf](#/hilfe/karte-neu-aufbauen).',
              '**Schon in der App falsch sortiert:** Ziehe die Titel auf der Seite des Ordners an die richtige Stelle: [Reihenfolge](#/hilfe/reihenfolge).',
              '**Ein ganz anderer Ordner:** Die Karte zeigt auf eine andere Nummer, etwa weil ein neues Album die Nummer eines gelöschten bekam. Beschreibe die Karte neu.',
            ],
          },
        ],
      },
      {
        id: 'keine-ansagen',
        title: 'Die Box spricht nicht oder Falsches',
        summary: '„Oh, eine neue Karte!“ fehlt, die Zahlen im Menü sind falsch, oder die Box reagiert nach der ersten Karte nicht mehr.',
        forum: 14941,
        keywords: [
          'stumm',
          'sagt nichts',
          'sagt falsches',
          'schweigt',
          'ansage fehlt',
          'ansagen',
          'systemansagen',
          'menü',
          'box spricht nicht',
          'falsche ansage',
          'mp3 ordner',
          'advert',
          'stimme',
          'sprache',
          'oh eine neue karte',
          '0262',
          'piepton',
          'fehler 6',
          'error 6',
          'reagiert nach der ersten karte nicht',
          'leere ansage',
        ],
        blocks: [
          {
            kind: 'p',
            text: 'Die Sätze der Box liegen als [[Systemansagen]] in den Ordnern mp3 und advert auf der SD-Karte und müssen zur [[Firmware]] passen. Spielt die Box auch keine Musik, lies [Die Box bleibt stumm](#/hilfe/box-bleibt-stumm).',
          },
          {
            kind: 'steps',
            items: [
              'Stecke die SD-Karte ein und öffne [Systemansagen](#/werkstatt/ansagen). Ich zeige dir, ob alle Ansagen da sind.',
              'Klicke auf „Ansagen installieren“ oder „Ansagen erneuern“, für TonUINO TNG dann auf „Herunterladen und installieren“. In Firefox und Safari heißt der Knopf „Herunterladen und ins Paket legen“, die Ansagen kommen [ins Paket](#/hilfe/paket).',
              `Für TonUINO 2.1 lädst du die [ZIP-Datei mit den Ansagen für 2.1](${CLASSIC21_SOUNDS_URL}) selbst herunter und wählst sie mit „ZIP-Datei auswählen …“.`,
            ],
          },
          { kind: 'note', tone: 'warning', text: 'Die Ordner mp3 und advert werden dabei ersetzt. Eigene Ansagen darin gehen verloren.' },
          { kind: 'mehr', title: 'Reagiert nach der ersten Karte nicht mehr, Piepton, leere Ansagen' },
          {
            kind: 'p',
            text: 'Fehlt bei TonUINO TNG der Piepton beim Auflegen (mp3/0262.mp3), spielt nur die erste Karte. Danach meldet das [Box-Logbuch](#/werkstatt/logbuch) „Datei fehlt auf der SD-Karte“ (Fehler 6). Das passiert mit alten Ansagen, die bei 0255 aufhören: Installiere sie neu. Stört der Piepton, ersetze die Datei durch eine stille, statt sie zu löschen.',
          },
          {
            kind: 'p',
            text: 'Ansagen mit 0 Byte oder ohne vierstellige Nummer (0001.mp3) zeigt der Gesundheitscheck in [Meine Box](#/). Er korrigiert die Namen, Neuinstallieren ersetzt leere Dateien.',
          },
          { kind: 'mehr', title: 'Eigene Ansagen, zum Beispiel mit deiner Stimme' },
          {
            kind: 'p',
            text: 'Wähle sie als ZIP-Datei aus. Jede Datei braucht ihre Nummer am Anfang, etwa 0300.mp3 oder 300_neue_karte.mp3. Ich gebe jeder die vierstellige Nummer, die die Box braucht.',
          },
        ],
      },
      {
        id: 'karte-geht-nicht',
        title: 'Eine Karte wird nicht erkannt',
        summary: 'Du legst eine Karte auf, und nichts passiert, oder manche Karten gehen und andere nicht.',
        forum: 14810,
        keywords: ['karte reagiert nicht', 'nichts passiert', 'keine reaktion', 'karte kaputt', 'leer', 'formatiert', 'lampe', 'led', 'auflegen', 'neustart', 'schnell wechseln', 'hängt', 'wackler', 'geht erst nach neustart', 'nur manchmal', 'manchmal erkannt', 'empfindlich', 'lage', 'falsches hörspiel', 'alte karte', 'karte gewechselt'],
        blocks: [
          {
            kind: 'checks',
            items: [
              // Forum 15017#1: replacement cards that worked, but only in one spot on the reader.
              '**Richtig auflegen:** flach und mittig über dem Kartenleser in der Box. Metall, ein LED-Ring oder eine dicke Wand dazwischen stören. Wird eine Karte nur manchmal erkannt, prüfe zuerst die Lage: Verschiebe sie testweise ein Stück, manche Karten sind da sehr empfindlich. Erst wenn das nichts ändert, ist sie vielleicht kaputt.',
              '**Falsche Kartensorte:** Karten mit 125\u00a0kHz bemerkt die Box gar nicht, Chips aus Spielzeug lassen sich oft nicht beschreiben: [Welche Karten kaufen?](#/hilfe/kartentypen)',
              '**Schon benutzt:** Eine beschriebene Karte startet „Oh, eine neue Karte“ nicht. Lerne sie über das [[Admin-Menü]] neu an.',
              '**Leerer oder gelöschter Ordner:** Dann spielt die Box nichts. Beim Beschreiben warne ich dich.',
              '**Von einer Handy-App „formatiert“:** Dabei ändert sich oft der Schlüssel der Karte. Nimm eine neue.',
              '**Manche gehen, andere nicht:** [Box testen: Kartenleser](#/werkstatt/kartenleser) zeigt, ob Karte, Sorte oder Leser schuld ist ([was die Ergebnisse heißen](#/hilfe/kartenleser-testen)).',
            ],
          },
          { kind: 'bild', art: 'karte-auflegen', caption: 'Lege die Karte flach und mittig über den Kartenleser in der Box, nicht an den Rand und ohne Metall dazwischen.' },
          { kind: 'h3', text: 'Geht erst nach einem Neustart wieder' },
          {
            kind: 'p',
            text: 'Oft nach schnellem Wechseln der Karten: Die Box richtet den Kartenleser nur beim Einschalten ein. Hängt er danach, ist meist ein [Wackelkontakt](#/hilfe/wackelkontakt) oder der Leser selbst schuld. Bewege bei laufender Box vorsichtig die Kabel zum Leser. Hört er dabei auf, prüfe die Lötstellen und Stecker. Hilft das nicht, tausche den Leser gegen einen anderen RC522, etwa einen aus dem Fachhandel: Im Forum berichten mehrere, dass billige Leser so hängen.',
          },
          { kind: 'p', text: 'Das Licht am Kartenleser zeigt nur, dass er Strom hat. Ob die Box die Karte erkennt, siehst du im [Box-Logbuch](#/werkstatt/logbuch).' },
          // TNG issue 347, fix in PR 351 (not released in October 2026). Remove once a release has it.
          { kind: 'h3', text: 'Karte schnell gewechselt, das alte Hörspiel läuft weiter' },
          {
            kind: 'p',
            text: 'Ein bekannter Fehler in TonUINO TNG 3.3.3: Legst du eine neue Karte auf, während die Box die vorige noch startet, spielt sie die vorige. Nimm die neue Karte kurz ab und lege sie wieder auf. Behoben ist das erst in einer neueren Version (im Forum als TNG Issue 347).',
          },
        ],
      },
      {
        id: 'anlernen-klappt-nicht',
        title: 'Anlernen klappt nicht oder PIN vergessen',
        summary: 'Die Box bricht beim Anlernen ab, schweigt oder hängt, oder das Admin-Menü ist gesperrt.',
        forum: 13537,
        keywords: [
          'karte anlernen geht nicht',
          'anlernen geht nicht',
          'karte lernen geht nicht',
          'lässt sich nicht anlernen',
          'abgebrochen',
          'vorgang abgebrochen',
          'bricht ab',
          'box bricht ab',
          'hängt',
          'reagiert nicht',
          'sagt nichts',
          'auth failed',
          'nur erster modus',
          'admin gesperrt',
          'pin vergessen',
          'anlernen',
          'reset',
          'zurücksetzen',
          'werkseinstellungen',
          'einstellungen löschen',
        ],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Strom:** Lade zuerst den Akku.',
              '**Die Box sagt nichts beim Auflegen:** Ist die Karte schon beschrieben, wähle in [Karten beschreiben](#/karten) bei „Die Karte ist“ den Punkt „schon benutzt“. Sonst fehlen vielleicht die [Ansagen](#/hilfe/keine-ansagen), oder die Box [erkennt die Karte nicht](#/hilfe/karte-geht-nicht).',
              '**Sofort „Abgebrochen“:** Die Box bemerkt einen Tastendruck, den du nicht gemacht hast. Meist klemmt eine Taste: [Die Tasten spinnen](#/hilfe/tasten).',
              '**Die Box reagiert lange nicht:** Liegt im Ordner mp3 ein langes Hörspiel statt einer Ansage, wartet sie, bis es zu Ende ist. Installiere die [Systemansagen](#/werkstatt/ansagen) neu.',
              '**„Auth failed“ im Box-Logbuch:** Die Box konnte die Karte nicht entsperren. Lerne sie über das Admin-Menü an und stelle dafür „schon benutzt“ ein. Steht das bei jeder Karte, prüfe den Kartenleser mit [Box testen](#/werkstatt/kartenleser). TonUINO 2.1 schreibt „PCD_Authenticate() failed“.',
            ],
          },
          { kind: 'h3', text: 'Admin-Menü gesperrt und PIN vergessen' },
          {
            kind: 'list',
            items: [
              '**Admin-Karte:** Sie öffnet das [[Admin-Menü]] immer. Beschreibe in [Karten beschreiben](#/karten) eine neue Karte „An der Box“ als Spezialkarte „Admin-Karte“, dafür brauchst du das Menü nicht.',
              '**Alles zurücksetzen:** Halte beim Einschalten Play/Pause, Vor und Zurück gedrückt. Die Box löscht alle Einstellungen, auch PIN, Sperre und die gemerkten Stellen in Hörbüchern. Karten und SD-Karte bleiben, wie sie sind. Stelle die Box danach neu ein: [Box einstellen](#/hilfe/box-einstellen).',
            ],
          },
          { kind: 'mehr', title: 'Für Bastler: Die Box nennt nur die erste Wiedergabeart' },
          {
            kind: 'p',
            text: `Das macht der [[Nachbau-Chip]] MH2024K-24SS. Er spielt Ansagen nur, wenn ihr Name nur aus der Nummer besteht. Spiele die [Systemansagen](#/werkstatt/ansagen) mit der App neu auf, mit „Nur Nummern als Dateinamen“ unter ${SETTINGS}, wie voreingestellt. Die Firmware muss außerdem für diesen Chip gebaut sein, die fertige ist es nicht.`,
          },
        ],
      },
      {
        // Forum: 11382 (skips a title after an announcement), 12563 (only folder 01), 14059 (5 instead of 1.6 s
        // to start), 13537 (first announcement missing), 10750#4 (ignores the volume), 13408 (fewer than about
        // 120 files per folder), 926 (recommended modules). TNG knows the chips only in builds of one's own.
        id: 'nachbau-chip',
        title: 'In der Box steckt ein nachgebauter MP3-Player',
        summary: 'Für Bastler: Die Box springt nach Ansagen, spielt nur Ordner 01, startet langsam oder zu laut.',
        forum: 13352,
        keywords: ['nachbau', 'nachgebaut', 'klon', 'clone', 'fake', 'mh2024k', 'mh2024k-24ss', 'gd3200b', 'dfplayer', 'dfplayer mini', 'chip', 'yx5200', 'langsamer start', 'gd3200d', 'tasten reagieren nicht', 'nur manche dateien'],
        blocks: [
          {
            kind: 'p',
            text: 'Auf vielen [[MP3-Playern|mp3-player]] sitzt ein nachgebauter Chip, etwa MH2024K-24SS oder GD3200B (mit der Lupe auf dem großen schwarzen Chip). Manche springen nach einer Ansage einen Titel weiter, spielen nur Ordner 01, starten viel langsamer, lassen die erste Ansage weg oder starten zu laut.',
          },
          {
            kind: 'checks',
            items: [
              `**Nur Nummern als Namen:** So lege ich Dateien an, solange unter ${SETTINGS} „Nur Nummern als Dateinamen“ an ist. Spiel auch die [Systemansagen](#/werkstatt/ansagen) mit der App neu auf.`,
              '**Weniger Dateien pro Ordner:** Im Forum half, unter etwa 120 zu bleiben.',
              '**Firmware für den Chip:** Unter [Firmware aufspielen](#/werkstatt/firmware) → „Extras“ → „Mehr: anderer MP3-Player-Chip“ wählst du den Chip, der auf deinem Player steht, etwa MH2024K-24SS auf dem „MP3-TF-16P V3.0“. Machen nur manche Dateien Ärger oder reagieren die Tasten nach einem bestimmten Titel nicht mehr, liegt es meist daran, nicht an der Datei.',
              '**Modul tauschen:** Am sichersten ist ein MP3-Player mit einem Chip, den das Forum empfiehlt.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'musik',
    title: 'SD-Karte und Musik',
    art: 'kat-musik',
    summary: 'Hörspiele und Musik auf die Karte bringen, Formate, Lautstärke, Cover und alles rund um die SD-Karte.',
    keywords: ['hinzufügen', 'übertragen', 'kopieren', 'hörbuch', 'hörspiel', 'album', 'microsd'],
    sections: [
      {
        id: 'album-hinzufuegen',
        title: 'So kommt Musik auf die Box',
        summary: 'Hörspiele und Musik vom Computer auf die SD-Karte der Box, Schritt für Schritt.',
        forum: 13280,
        keywords: [
          'ordner auswählen',
          'dateien auswählen',
          'ziehen',
          'drag',
          'anhängen',
          'laufwerk',
          'microsd',
          'öffnen',
          'zugriff erlauben',
          'karte einlesen',
          'einlesen',
          'hochladen',
          'neu einlesen',
          'sd-karte auswählen',
          'befüllen',
        ],
        blocks: [
          {
            kind: 'steps',
            items: [
              'Nimm die SD-Karte aus der Box ([so geht es](#/hilfe/sd-karte-herausnehmen)) und stecke sie in den Computer.',
              'Klicke unter [Meine Box](#/) auf „SD-Karte auswählen“ und wähle das Laufwerk der Karte selbst. Erlaube, dass ich Dateien ändern darf. Die Desktop-App findet die Karte von selbst.',
              'Ziehe unter [Hinzufügen](#/hinzufuegen) Dateien oder ganze Ordner hinein. Ich mache daraus Alben. Prüfe Titel und Reihenfolge.',
              'Klicke auf „Auf die SD-Karte übertragen“. In Firefox und Safari heißt der Knopf „Ins Paket für die Karte“: [Ein Paket auf die Karte bringen](#/hilfe/paket).',
            ],
          },
          {
            kind: 'bild',
            art: 'weg-der-karte',
            caption: 'Die SD-Karte steckt innen am MP3-Player. Box aufschrauben und die Karte gerade herausziehen, dann kommt sie in den Computer.',
          },
          { kind: 'foto', photo: 'ablage', caption: 'Unter „Hinzufügen“ ziehst du Dateien oder ganze Ordner auf dieses Feld, oder du klickst auf „Dateien auswählen“ und suchst sie aus.' },
          {
            kind: 'p',
            text: 'Neue Alben kommen in den ersten freien Ordner, auch in die Nummer eines Ordners, den du gelöscht hast. Vorhandene Ordner behalten ihre Nummer, denn deine Karten zeigen auf sie. Danach beschreibst du eine Karte: [Karten beschreiben: welcher Weg?](#/hilfe/vier-wege)',
          },
          { kind: 'mehr', title: 'In Firefox und Safari, Titel anhängen' },
          {
            kind: 'list',
            items: [
              'Klicke auf „SD-Karte einlesen“ und wähle die Karte. Fragt der Browser, ob du alles „hochladen“ willst, klicke auf „Hochladen“. Ich darf die Dateien dann nur lesen, nichts verlässt deinen Computer.',
              'Hast du die Karte außerhalb der App geändert, klicke auf „Neu einlesen“.',
              'Titel für einen vorhandenen Ordner fügst du auf seiner Seite mit „Titel hinzufügen“ hinzu. Sie kommen hinten an.',
            ],
          },
          {
            kind: 'mehr',
            title: 'Nummer eines Ordners ändern oder zwei Ordner tauschen',
            id: 'nummer-tauschen',
            keywords: ['nummer ändern', 'andere nummer', 'umnummerieren', 'tauschen', 'vertauschen', 'ordner tauschen', 'reihenfolge der ordner', 'ordner sortieren', 'ordner verschieben', 'ordnernummer', 'nummer', 'reihenfolge'],
          },
          {
            kind: 'p',
            text: 'Auf der Seite eines Ordners wählst du im Menü „…“ „Nummer ändern oder tauschen …“. Nimmst du eine freie Nummer, zieht der Ordner dorthin um. Nimmst du die Nummer eines anderen Ordners, tauschen die beiden ihre Nummern, etwa 05 und 12. Das geht auch, wenn alle 99 Nummern belegt sind. Alle anderen Ordner behalten ihre Nummer.',
          },
          {
            kind: 'p',
            text: 'Titel, Cover, Sticker, Folgen und weitere Karten ziehen mit. Deine schon beschriebenen Karten kennen aber noch die alte Nummer. Nach einem Tausch spielt die alte Karte von 05 also den Ordner, der jetzt 05 heißt. Beschreibe deshalb die Karten beider Ordner neu, ich wähl sie dir danach unter „Karten beschreiben“ schon aus.',
          },
          {
            kind: 'p',
            text: 'Ein Ordner rückt dabei nie zwischen andere, sonst bräuchten viele Karten eine neue Nummer. Wird der Tausch unterbrochen, etwa weil die Karte herausgezogen wurde, geht nichts verloren. Ich leg die Ordner gleich wieder an ihren Platz, sonst tippst du unter „Meine Box“ auf „Ansehen und reparieren“ und dann auf „Dateien zurücklegen“.',
          },
        ],
      },
      {
        id: 'cd-und-streaming',
        title: 'CDs, Streaming und gekaufte Hörbücher',
        summary: 'Was auf die Box kann: CDs und Downloads ja, Spotify und Audible nicht.',
        keywords: [
          'woher',
          'cd',
          'cd-laufwerk',
          'rippen',
          'spotify',
          'streaming',
          'apple music',
          'amazon music',
          'deezer',
          'audible',
          'hörbuch kaufen',
          'kaufen',
          'gekauft',
          'download',
          'mp3-download',
          'kopierschutz',
          'drm',
          'abo',
          'playlist',
          'titelliste',
        ],
        blocks: [
          {
            kind: 'list',
            items: [
              '**CDs:** Kopiere die CD mit dem Windows Media Player, der Musik-App am Mac oder unter Linux zum Beispiel mit Asunder als MP3 auf den Computer und ziehe den Ordner auf [Hinzufügen](#/hinzufuegen). Eine eigene CD ohne Kopierschutz darfst du für euch privat kopieren.',
              '**Gekaufte Downloads:** Was als „MP3-Download“ oder „DRM-frei“ verkauft wird, fügst du einfach hinzu.',
              '**Streaming:** Spotify, Apple Music, Amazon Music und Deezer sind kopiergeschützt, auch was du für unterwegs speicherst. Hast du die Titel einer Playlist als Dateien, übernimmst du ihre Reihenfolge unter [Hinzufügen](#/hinzufuegen).',
              '**Audible und andere Hörbuch-Abos:** kopiergeschützt, ich kann sie nicht öffnen. Kaufe lieber als Download ohne Kopierschutz oder auf CD.',
            ],
          },
          ...(__SOURCES_ENABLED__
            ? [{ kind: 'p' as const, text: 'Kostenlose Hörspiele, Hörbücher und Lieder, die du legal herunterladen darfst, findest du unter [Entdecken](#/entdecken).' }]
            : []),
        ],
      },
      ...(__SOURCES_ENABLED__
        ? [
            {
              ...SOURCES_HELP,
              summary: 'Kostenlose Hörspiele, Hörbücher und Lieder, die du legal laden darfst, und wie sie auf die Box kommen.',
              blocks: foldSources(sourcesHelpBlocks(CAN_REPORT)),
            },
          ]
        : []),
      {
        id: 'dateiformate',
        title: 'Welche Dateien gehen?',
        summary: 'Fast alle. Ich wandle um, nummeriere und prüfe. Was die Box sonst verlangt, erledigt sie für dich.',
        keywords: ['mp3', 'm4a', 'm4b', 'aac', 'flac', 'ogg', 'opus', 'wav', 'umwandeln', 'konvertieren', 'bitrate', 'kbit', 'qualität', 'audible', 'kopierschutz', 'drm', 'beschädigt', 'kaputt', 'zusammengesetzt', 'zusammengefügt'],
        blocks: [
          {
            kind: 'p',
            text: 'MP3 nehme ich, wie es ist. M4A, M4B, AAC, FLAC, OGG, WAV und andere wandle ich in MP3 um. Kopiergeschützte Dateien, etwa von Audible, kann ich nicht öffnen. Was nicht geht, zeige ich vor dem Übertragen.',
          },
          {
            kind: 'p',
            text: 'Beim Hinzufügen prüfe ich, ob eine MP3-Datei kaputte Stellen hat oder aus mehreren Dateien zusammengesetzt ist. Dann erstelle ich sie neu, sonst bleibt die Box dort hängen. Nicht jeden Schaden finde ich so. Hängt die Box weiter am selben Titel: [Spielt nur den ersten Titel, hängt oder springt](#/hilfe/box-spielt-nicht-richtig).',
          },
          {
            kind: 'bild',
            art: 'sd-ordner',
            caption: 'So lege ich die Karte an: Ordner 01 bis 99 mit 001.mp3, 002.mp3 …, dazu mp3 und advert für die Ansagen. Namen wie „02 Bibi“ findet die Box nicht.',
          },
          { kind: 'p', text: 'Um Nummern und Ordner kümmere ich mich. Ändere auf der Karte nichts von Hand.' },
          { kind: 'mehr', title: 'Die Reihenfolge der Titel', id: 'reihenfolge', keywords: ['sortieren', 'reihenfolge', 'tracknummer', 'umsortieren', 'nummer'] },
          {
            kind: 'p',
            text: 'Die Box spielt nach Nummer. Ich sortiere nach CD, dann nach der Titelnummer in der Datei, sonst nach dem Namen, so wie Menschen zählen: „Kapitel 2“ vor „Kapitel 10“. Später ziehst du Titel auf der Seite des Ordners an ihren Platz. Spielt die Box falsche Titel: [Falscher Titel oder falsche Reihenfolge](#/hilfe/falsche-titel).',
          },
          { kind: 'mehr', title: 'Grenzen der Box', id: 'grenzen', keywords: ['99', '255', 'maximal', 'höchstens', 'zu viele', 'voll', 'unterordner', 'limit'] },
          {
            kind: 'list',
            items: [
              '**99 Ordner**, dazu die Ordner „mp3“ und „advert“ mit den Ansagen der Box. Sind alle belegt, packe eine Reihe in einen Ordner (siehe unten), lösche einen oder hänge Titel an.',
              '**255 Titel pro Ordner.** Hat ein Album mehr, verteile ich es.',
              '**Keine Unterordner.**',
              '**Ein gelöschter Ordner** behält seine Nummer frei. Kommt dort ein neues Album hinein, spielen die alten Karten das neue Album. Lege sie weg oder beschreibe sie neu.',
              '**Mehr als 99 Hörbücher?** Ab TonUINO TNG 3.3.3 legst du mehrere in einen Ordner und schreibst Karten „Hörbuch, Teil eines Ordners“. Die Box merkt sich pro Ordner aber nur eine Stelle.',
            ],
          },
          {
            kind: 'mehr',
            title: 'Eine Reihe in einen Ordner packen',
            id: 'reihe-packen',
            keywords: ['99', 'reihe', 'ordner voll', 'alle ordner belegt', 'mehr als 99', 'packen', 'zusammenpacken', 'serie', 'folgen', 'die drei fragezeichen', 'nummern frei', 'platz auf der karte'],
          },
          {
            kind: 'p',
            text: 'Liegt eine Reihe wie „Die drei ???“ in vielen Ordnern, braucht jede Folge eine der 99 Nummern. Unter [Meine Box](#/) bei „Platz auf der Karte“ steht dann zum Beispiel „‚Die drei ???‘ liegt in 12 Ordnern.“ mit dem Knopf „In einen Ordner packen“. Erkenne ich keine Reihe, kreuzt du die Ordner unter „Reihe in einen Ordner packen …“ selbst an.',
          },
          {
            kind: 'p',
            text: 'Alle Folgen kommen in den Ordner mit der kleinsten Nummer, in der Reihenfolge der Nummern. Die anderen Nummern werden frei, kein anderer Ordner bekommt eine neue Nummer. Passen mehr als 255 Titel nicht in einen Ordner, verteile ich die Reihe auf so wenige Ordner wie nötig. Ich kopiere erst und prüfe jede Kopie, einen alten Ordner lösche ich erst danach. Titel, Cover und Sticker der Folgen bleiben.',
          },
          {
            kind: 'p',
            text: 'Danach spielen die alten Karten der Reihe nicht mehr das Richtige, denn die Box findet einen Ordner nur über seine Nummer. Jede Folge bekommt eine eigene Karte „von Titel … bis …“, ein Knopf führt dich zu „Karten beschreiben“ mit genau diesen Karten. Auf dem Sticker einer Folge stehen Ordner und Titel, zum Beispiel „02 · 19–36“. Kommen beim Hinzufügen mehrere Alben einer Reihe, biete ich dir dort an, sie gleich als Folgen in einen Ordner zu legen.',
          },
          {
            kind: 'mehr',
            title: 'Dateinamen, Ordnernamen und Infos in den Dateien',
            id: 'dateinamen',
            keywords: ['001.mp3', 'nummern', 'umlaute', 'tags', 'id3', 'titel-infos', 'titelinfos', 'interpret', 'titelnummer', 'genre', 'tags bearbeiten', 'titel im namen', 'titel 1', 'titelnamen', 'automatisch erkannt', 'spotidownloader', 'großschreibung', 'player-chip', 'ordnername', 'ordner heißt', 'ordner umbenennen', 'advent', 'bilder im ordner', 'andere dateien', 'fremde dateien'],
          },
          {
            kind: 'p',
            text: 'Die Box findet nur Titel mit Nummer und nur Ordner, die genau 01 bis 99 heißen, dazu die Ordner „mp3“ und „advert“ mit ihren Ansagen. Bilder und Texte gehören nicht hinein. Der Gesundheitscheck in [Meine Box](#/) benennt falsche Ordner um und räumt fremde Dateien weg.',
          },
          {
            kind: 'p',
            text: `Schaltest du unter ${SETTINGS} „Nur Nummern als Dateinamen“ aus, heißt ein Titel zum Beispiel 001_Der_Hund.mp3. Manche [[nachgebauten MP3-Player|nachbau-chip]] spielen aber nur reine Nummern. Im Forum lief eine Box erst wieder, als aus „0007_Intro.mp3“ „0007.mp3“ wurde. Darum meldet der Gesundheitscheck solche Namen. „Sicher umbenennen“ behält die Reihenfolge und schreibt die Wörter aus dem alten Namen in den Titel der Datei. Große Bilder und Zusatzinfos (Tags) in MP3s können den Player stolpern lassen: „Bilder und Zusatzinfos aus MP3s entfernen“ kürzt sie beim Kopieren, am Ton ändert sich nichts.`,
          },
          {
            kind: 'p',
            text: 'Steht nur „Titel 1, Titel 2 …“ da, fehlen die Namen in den Dateien. „Im Internet suchen“ über der Liste holt sie bei iTunes und MusicBrainz. Solche und erratene Namen stehen als „automatisch erkannt“ da, ein Klick ändert sie. Den Namen von Download-Programmen wie „SpotiDownloader.com“ nehme ich von selbst weg.',
          },
          {
            kind: 'p',
            text: 'Titel, Interpret, Album und Nummer in den MP3-Dateien änderst du auf der Seite des Ordners mit „Titel-Infos bearbeiten“: für einen Titel oder für alle auf einmal, Seltenes wie Jahr und Genre unter „Mehr“. Was ich vorschlage, steht als „automatisch erkannt“ da. Dateinamen und Nummern auf der Karte bleiben, wie sie sind.',
          },
          { kind: 'mehr', title: 'Qualität beim Umwandeln' },
          {
            kind: 'p',
            text: `Wie viele Daten pro Sekunde umgewandelte Dateien bekommen, stellst du unter ${SETTINGS} ein. Für Hörspiele reichen 96\u00a0kbit/s, für Musik nimm 128\u00a0kbit/s oder mehr. Eine Stunde braucht mit 128\u00a0kbit/s etwa 58\u00a0MB.`,
          },
        ],
      },
      {
        // Forum 14920: why long tracks are a problem on the box and how families split them.
        id: 'lange-dateien',
        title: 'Lange Hörbücher teilen',
        summary: 'Die Box merkt sich nur den Titel, nicht die Minute. Darum teile ich lange Dateien.',
        forum: 14920,
        keywords: ['teilen', 'schneiden', 'kapitel', 'sprechpausen', 'weiterhören', 'fortsetzen', 'm4b', 'aufteilen', 'spulen'],
        blocks: [
          {
            kind: 'p',
            text: 'Bei einer Datei mit drei Stunden fängt die Box sonst immer wieder vorn an. Darum teile ich Dateien über 20\u00a0Minuten: **an den Kapiteln**, wenn die Datei welche hat, oder **an Sprechpausen**, damit kein Wort zerschnitten wird. Oder du wählst „Nicht teilen“.',
          },
          {
            kind: 'p',
            text: `Die Länge der Teile, 3 bis 30\u00a0Minuten, wählst du für jedes Album, den Startwert unter ${SETTINGS}. Für Hörbücher in Teilen passt die Wiedergabeart „Hörbuch“.`,
          },
        ],
      },
      {
        id: 'lautstaerke',
        title: 'Gleiche Lautstärke für alle Alben',
        summary: 'Damit nach einem leisen Hörspiel das nächste Lied nicht alle erschreckt.',
        keywords: ['leise', 'laut', 'normalisieren', 'mp3gain', 'pegel', 'lautheit', 'übersteuern', 'leiser geblieben', 'alles gleich laut', 'lautstärke angleichen', 'schon auf der karte', 'kleiner machen', 'platz sparen', 'mono', 'einschlafen', 'schlafmusik', 'abends', 'ordner leiser', 'ordner lauter', 'zu laut zum einschlafen'],
        blocks: [
          {
            kind: 'p',
            text: 'Mit „Gleiche Lautstärke“ messe ich beim Hinzufügen, wie laut ein Album ist, und bringe alle Alben auf einen Wert. Leise Stellen im Album bleiben leise. Nichts wird so laut, dass es übersteuert.',
          },
          {
            kind: 'p',
            text: 'Titel, die schon auf der Karte sind, gleichst du in [Meine Box](#/) an: Öffne den Ordner, klicke auf „…“ und dann auf „Lautstärke anpassen“. MP3-Dateien ändere ich dabei ohne Qualitätsverlust, wie das Programm MP3Gain. Dort findest du auch „Kleiner machen“: Ich wandle die Titel in Mono oder mit weniger Qualität neu um, damit mehr auf die Karte passt.',
          },
          {
            kind: 'p',
            text: '**Ein Ordner mit Absicht leiser oder lauter,** etwa Musik zum Einschlafen: Wähle unter „Lautstärke anpassen“ „Leiser für die Nacht“, „Etwas leiser“, „Wie die anderen“ oder „Etwas lauter“. Mit dem Regler darunter geht es genauer. Ich merke mir das für den Ordner: Titel, die du später hinzufügst, bekommen dieselbe Lautstärke, und beim nächsten Angleichen bleibt er so. In „Meine Box“ steht dann „leiser gestellt“ oder „lauter gestellt“ dabei. Lauter mache ich nur so weit, dass nichts übersteuert. Ändern geht nur, wenn die SD-Karte steckt.',
          },
          { kind: 'p', text: `„Gleiche Lautstärke“ schaltest du unter ${SETTINGS} ein oder aus. Wie laut die Box höchstens wird, stellst du an der Box ein: [Box einstellen](#/hilfe/box-einstellen).` },
          { kind: 'mehr', title: 'Leise Alben mit lauten Stellen' },
          {
            kind: 'p',
            text: `Ein leises Album mit einzelnen lauten Stellen hebe ich nur so weit an, dass diese nicht übersteuern. „Leise MP3s lauter machen“ unter ${SETTINGS} wandelt so ein Album neu um und dämpft die lauten Stellen etwas. Ist der Schalter aus, sag ich dir, welches Album leiser geblieben ist.`,
          },
          { kind: 'mehr', title: 'Dateien, die schon kratzen', id: 'uebersteuert', keywords: ['schon übersteuert', 'übersteuerte datei', 'kratzt am pc', 'clipping', 'abgeschnittene spitzen'] },
          {
            kind: 'p',
            text: 'Manche Dateien wurden schon zu laut gespeichert, bevor du sie bekommen hast, oft bei Downloads. Die lautesten Stellen sind dann abgeschnitten. Das kratzt auf jedem Gerät, auch am PC, und leiser machen hilft dagegen nicht. Besser wird es nur mit einer besseren Quelle, zum Beispiel der CD. Bei WAV- und FLAC-Dateien merke ich das beim Hinzufügen und sage es dir nach dem Übertragen. Bei MP3 und anderen Download-Formaten erkenne ich es nicht sicher: Kratzt die Datei schon am PC, liegt es an ihr.',
          },
          {
            kind: 'p',
            text: 'Was ich selbst umwandle, übersteuert nicht: Ich halte die Spitzen so weit unter der Grenze, dass auch die Box beim Abspielen nichts abschneidet.',
          },
        ],
      },
      {
        id: 'cover',
        title: 'Cover: die Bilder zu deinen Hörspielen',
        summary: 'Woher die Bilder für Meine Box und die Sticker kommen, auch für viele Ordner auf einmal.',
        keywords: ['bild', 'bilder', 'albumcover', 'itunes', 'musicbrainz', 'suchen', 'foto', 'kassette', 'kassettencover', 'mc', 'hochformat'],
        blocks: [
          {
            kind: 'list',
            items: [
              '**Aus den Dateien:** Viele MP3s enthalten ihr Cover, auch cover.jpg im selben Ordner nehme ich.',
              '**Im Internet suchen:** „Cover auswählen“ auf der Seite eines Ordners sucht nach dem Namen. „Kassetten-Cover“ findet alte Kassetten, der Sticker wird dafür hochkant.',
              '**Eigenes Bild:** ein Foto oder ein gemaltes Bild, am besten quadratisch.',
            ],
          },
          { kind: 'note', tone: 'neutral', text: 'Cover sind geschützt. Nutze sie nur für deine eigenen Karten und gib sie nicht weiter.' },
          {
            kind: 'mehr',
            title: 'Cover für viele Ordner auf einmal finden',
            id: 'cover-finden',
            keywords: [
              'Cover automatisch',
              'automatisch',
              'Original-Cover',
              'Hörspiel-Cover',
              'fehlende Cover',
              'alle Cover',
              'Cover suchen',
              'Cover laden',
              'Cover herunterladen',
              'herunterladen',
              'Coverbild',
              'Titelbild',
              'Albumcover',
              'Plattencover',
              'Apple',
              'Cover Art Archive',
            ],
          },
          {
            kind: 'steps',
            items: [
              'Klicke in [Sticker drucken](#/sticker) auf „Cover suchen“ und dann auf „Suche starten“.',
              'Gute Treffer sind schon angehakt. Bei „Unsicher – bitte prüfen“ entscheidest du selbst, oder nimm „Eigenes Bild …“.',
              'Klicke auf „Ausgewählte übernehmen“. Erst dann kommen die Bilder auf die Karte.',
            ],
          },
          {
            kind: 'p',
            text: 'Die Bilder kommen von iTunes (Apple) und von MusicBrainz mit dem Cover Art Archive. Für Namen wie „Ordner 05“ suche ich nicht. Gib dem Ordner einen genauen Namen.',
          },
          {
            kind: 'p',
            text: 'Fürs Regal suche ich das Cover auch von selbst, wenn der Name eines Ordners ein Hörspiel genau nennt. Auf der Seite des Ordners steht es dann als „Cover automatisch gefunden“. Erst „Übernehmen“ bringt es auf die Karte.',
          },
          // Forum 2109, 5972 (pictoselector): ARASAAC pictograms are CC BY-NC-SA 4.0, author Sergio Palao, owner the Government of Aragón.
          { kind: 'mehr', title: 'Freie Piktogramme für Bildkarten', id: 'piktogramme', keywords: ['piktogramme', 'arasaac', 'pictoselector', 'symbole', 'wortkarten', 'bildkarten', 'kita', 'ohne cover', 'lizenz'] },
          {
            kind: 'p',
            text: 'Für Wortkarten, eigene Aufnahmen oder Karten ohne Cover passen einfache Bilder. Der Sticker-Stil „Bildkarte“ malt selbst ein Bild, das zum Namen passt: einen Mond zu „Gute Nacht“, ein Stoppschild zu „Stopptanz“, eine Torte zu „Geburtstag“. Passt dir das Bild nicht, oder male ich zu einem Namen keins, klicke den Sticker an und suche unter „Bild der Bildkarte“ mit „Piktogramm suchen“ ein Piktogramm von [ARASAAC](https://arasaac.org), einer freien Sammlung mit vielen Tausend Bildern. Gesucht wird auf Deutsch, am besten mit einem einfachen Wort wie „Katze“ oder „schlafen“. Das gewählte Bild bleibt auf diesem Gerät. Das geht auch mit einer gemerkten Box ohne SD-Karte.',
          },
          {
            kind: 'p',
            text: 'Auf die Karte kommt das Piktogramm so, wie ARASAAC es zeichnet, auf einer weißen Fläche. Darunter steht klein die Quelle: „Piktogramm: Sergio Palao, ARASAAC (arasaac.org), CC BY-NC-SA“. Druckst du Rückseiten mit, steht sie dort. Auf einem anderen Computer siehst du wieder das gemalte Bild, bis du das Piktogramm dort noch einmal wählst.',
          },
          {
            kind: 'note',
            tone: 'neutral',
            text: 'Die Piktogramme von ARASAAC gehören der Regierung von Aragón, gezeichnet hat sie Sergio Palao. Sie stehen unter der Lizenz CC BY-NC-SA 4.0: Du darfst sie für deine Karten nutzen, aber nicht verkaufen, und die Quelle bleibt auf der Karte stehen. Veränderte Bilder gibst du nur unter derselben Lizenz weiter, deshalb färbe ich sie nicht um. Bilder aus anderen Sammlungen, etwa aus dem Programm [Pictoselector](https://www.pictoselector.eu/de), nimmst du auf der Seite eines Ordners unter „Cover auswählen“ mit „Eigenes Bild …“. Sie haben eigene Regeln.',
          },
        ],
      },
      {
        // Forum 6249: the SD Card Formatter and its "Overwrite format".
        id: 'sd-karte-geht-nicht',
        title: 'Die SD-Karte wird nicht erkannt',
        summary: 'Der Computer oder die Box findet die Karte nicht, oder du richtest eine neue Karte ein.',
        forum: 6249,
        keywords: ['fat32', 'formatieren', '32 gb', '64 gb', 'exfat', 'ntfs', 'sd card formatter', 'schreibgeschützt', 'größe'],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Am Computer:** Wähle das Laufwerk der Karte selbst, nicht einen Ordner darauf. Zeige ich „Zugriff erlauben“, klicke darauf.',
              '**Schreibgeschützt:** [Schreiben auf die SD-Karte klappt nicht](#/hilfe/sd-karte-schreibrechte).',
              '**In der Box: das Format.** Der MP3-Player liest nur [[FAT32]], sicher bis 32\u00a0GB. Die Desktop-App zeigt Format und Größe.',
              '**Falsches Format:** [Baue die Karte neu auf](#/hilfe/karte-neu-aufbauen): sichern, formatieren, zurückspielen. Alle Ordner behalten ihre Nummer.',
              '**Liest die Box die Karte?** Das zeigt das [Box-Logbuch](#/werkstatt/logbuch). Sonst ist vielleicht der Kartenhalter locker: [Wackelkontakt und schlechte Lötstellen](#/hilfe/wackelkontakt).',
            ],
          },
          {
            kind: 'note',
            tone: 'warning',
            text: 'Formatiere mit dem kostenlosen „SD Card Formatter“, bei Ärger mit „Overwrite format“. Karten über 32\u00a0GB macht er aber immer exFAT, und das liest die Box nicht. Nimm also höchstens 32\u00a0GB, das reicht für Hunderte Stunden.',
          },
          { kind: 'mehr', title: 'So siehst du, wie die Karte formatiert ist', id: 'format-nachschauen', keywords: ['dateisystem', 'format nachschauen', 'exfat', 'ntfs', 'eigenschaften'] },
          {
            kind: 'checks',
            items: [
              '**Windows:** Im Explorer mit Rechtsklick auf die Karte und „Eigenschaften“. Dort steht es bei „Dateisystem“.',
              '**Mac:** Im Finder mit Rechtsklick auf die Karte und „Informationen“. Dort steht es bei „Format“.',
              '**Linux:** Im Programm „Laufwerke“ die Karte anklicken.',
              '**Chromebook und Handy:** Dort sieht man es nicht. Schaue an einem Windows-PC oder Mac nach.',
            ],
          },
          { kind: 'mehr', title: 'Eine neue SD-Karte einrichten', id: 'neue-sd-karte', keywords: ['leere karte', 'einrichten', 'erste mal', 'name der box', 'neue sd-karte', 'welche karte'] },
          {
            kind: 'steps',
            items: [
              'Nimm eine leere microSD-Karte einer bekannten Marke, 8 bis 32\u00a0GB. Ersetzt sie eine alte, wähle bei der alten Karte in [Meine Box](#/) „Auf eine neue Karte umziehen …“, oder spiele mit „Sicherung zurückspielen …“ eine Sicherung zurück: [Die Karte komplett neu aufbauen](#/hilfe/karte-neu-aufbauen).',
              'Sonst stecke sie ein, gib der Box einen Namen und klicke auf „Karte einrichten“. Danach installierst du die [[Systemansagen]].',
              'Jetzt kannst du [Hörspiele und Musik hinzufügen](#/hilfe/album-hinzufuegen).',
            ],
          },
          { kind: 'mehr', title: 'Eine größere Karte trotzdem probieren' },
          {
            kind: 'p',
            text: 'Am Mac im Festplattendienstprogramm „MS-DOS (FAT)“ wählen, unter Linux in „Laufwerke“ den Typ „FAT“. Windows bietet bei großen Karten kein FAT32 an. Die Web-App sieht das Format nicht und rät nur. Zeigt dein Computer FAT32, blend die Warnung mit „Ist FAT32“ aus.',
          },
        ],
      },
      {
        // Forum 13633: new folders were not played until the card was set up again.
        id: 'karte-neu-aufbauen',
        title: 'Die Karte komplett neu aufbauen',
        summary: 'Findet die Box Titel nicht, obwohl alles richtig aussieht? Sichern, formatieren, zurückspielen. Das meiste mache ich.',
        forum: 13633,
        keywords: ['komplett', 'neu aufbauen', 'umziehen', 'zurückspielen', 'backup', 'sicherung', 'sichern', 'sd-karte sichern', 'wiederherstellen', 'sd-karte tauschen'],
        blocks: [
          {
            kind: 'p',
            text: 'Manche MP3-Player spielen Dateien in der Reihenfolge, in der sie auf die Karte kamen. Wurde früher einzeln kopiert, findet die Box dann Titel nicht oder springt. Hilfe: sichern, formatieren, in der richtigen Reihenfolge zurückspielen. Alle Ordner behalten ihre Nummer.',
          },
          {
            kind: 'steps',
            items: [
              'Wähle in [Meine Box](#/) unter dem Gesundheitscheck „Karte neu aufbauen …“ (auch im [Box-Logbuch](#/werkstatt/logbuch)). Das geht in Chrome, Edge und der Desktop-App.',
              '**Sichern:** Wähle einen Ordner auf dem Computer. Ich kopiere alles, was die Box abspielt, und prüfe jede Datei.',
              '**Formatieren:** Das machst du, ich zeig dir wie. Am gründlichsten mit dem „SD Card Formatter“ und „Overwrite format“.',
              '**Zurückspielen:** Stecke die Karte wieder ein. Ich prüfe, ob die Karte leer ist. In der Desktop-App prüfe ich auch, ob die Karte mit FAT32 formatiert ist. Dann spiele ich alles der Reihe nach zurück.',
            ],
          },
          {
            kind: 'note',
            tone: 'warning',
            text: 'Lasse die Sicherung auf dem Computer, bis die Box wieder spielt. Dialog zu früh geschlossen? Leere Karte einstecken, „Sicherung zurückspielen …“ wählen. Für eine neue Karte: „Auf eine neue Karte umziehen …“.',
          },
          { kind: 'mehr', title: 'In Firefox und Safari' },
          {
            kind: 'p',
            text: 'Im Paket-Dialog wählst du „Karte komplett neu aufbauen“. Lade das Paket herunter und lasse es mit „Paket prüfen“ prüfen. Erst dann formatierst du mit FAT32 und entpackst es auf die Karte. Das Paket ist danach eine gute Sicherung.',
          },
          // Forum 5972 (#32, #33): FAT Sorter and fatsort sort the entries in place; fatsort refuses a mounted card unless forced (man page, -f).
          { kind: 'mehr', title: 'Nur die Reihenfolge ordnen', id: 'ohne-formatieren', keywords: ['fat sorter', 'fatsort', 'fat sortieren', 'drivesort', 'yafs'] },
          {
            kind: 'p',
            text: 'Es gibt Programme, die die Reihenfolge auf der Karte ordnen, ohne sie zu formatieren: FAT Sorter für Windows und [fatsort](https://fatsort.sourceforge.io/) für Linux und Mac. fatsort tippst du als Befehl ein, die Karte darf dabei nicht geöffnet sein. Sie ändern direkt das Inhaltsverzeichnis der Karte. Geht dabei etwas schief, sind Dateien weg. Sichere die Karte deshalb vorher. Der Weg oben mit Sichern und Formatieren ist sicherer.',
          },
        ],
      },
      {
        // The Paket dialog, the guide and Werkstatt > Paket auf die Karte bringen (src/features/box/PackageDialog.tsx, PackageGuide.tsx, src/features/workshop/PackageTool.tsx).
        id: 'paket',
        title: 'Ein Paket auf die Karte bringen',
        summary: 'Nur für Firefox und Safari: So kommt alles Neue als ZIP-Datei auf die Karte.',
        packageOnly: true,
        keywords: ['zip', 'entpacken', 'herunterladen', 'download', 'firefox', 'safari', 'karte prüfen', 'terminal', 'paket prüfen'],
        blocks: [
          { kind: 'p', text: 'Firefox und Safari dürfen nicht auf die SD-Karte schreiben. Darum packe ich alles Neue in ein Paket, eine ZIP-Datei, und du entpackst es.' },
          {
            kind: 'steps',
            items: [
              'Klicke in [Meine Box](#/) auf „Paket herunterladen“. Meist reicht „Nur die Änderungen“.',
              'Folge der Anleitung für deinen Computer. Sie sagt dir auch, welchen alten Ordner du vorher löschst.',
              'Klicke auf „Karte prüfen“ und wähle die Karte noch einmal. Bis dahin wartet das Paket. Prüfen geht auch später unter [Werkstatt > Paket auf die Karte bringen](#/werkstatt/paket).',
            ],
          },
          {
            kind: 'note',
            tone: 'warning',
            text: 'Safari packt ZIP-Dateien von selbst aus. Nimm vorher unter Safari > Einstellungen > Allgemein den Haken bei „Sichere Dateien nach dem Laden öffnen“ weg.',
          },
          { kind: 'mehr', title: 'Warum das Terminal auf dem Mac?' },
          {
            kind: 'p',
            text: 'Der Finder legt zu jeder Datei eine versteckte „._“-Datei an. Die Box zählt sie als Titel mit und spielt die falschen. Der Befehl aus der Anleitung entpackt ohne sie.',
          },
        ],
      },
      {
        id: 'sd-karte-herausnehmen',
        title: 'So kommst du an die SD-Karte',
        summary: 'Die Karte steckt im MP3-Player in der Box. Über das USB-Kabel der Box kommt der Computer nicht an sie heran.',
        keywords: [
          'usb',
          'herausnehmen',
          'rausnehmen',
          'rausholen',
          'schrauben',
          'aufschrauben',
          'kartenschlitz',
          'abgebrochen',
          'box öffnen',
          'an die sd-karte kommen',
          'sd-karte wechseln',
        ],
        blocks: [
          { kind: 'bild', art: 'sd-herausnehmen', caption: 'Box aufschrauben und die Karte gerade aus dem Schlitz am MP3-Player ziehen, nicht hebeln.' },
          {
            kind: 'steps',
            items: [
              'Halte die Box an, schalte sie aus und schraube sie auf.',
              'Ziehe die Karte gerade heraus. Nicht hebeln: Der Schlitz bricht leicht ab.',
              'Fertig am Computer? Wirf die Karte aus und stecke sie genauso gerade zurück.',
            ],
          },
          { kind: 'p', text: 'Der USB-Anschluss der Box ist für Firmware und das [Box-Logbuch](#/werkstatt/logbuch), nicht für die Karte.' },
          {
            kind: 'bild',
            art: 'weg-der-karte',
            caption: 'Die Karte steckt innen am MP3-Player, nicht in einem Schlitz außen an der Box. Je nach Box schraubst du den Deckel oder die Rückwand ab.',
          },
          { kind: 'mehr', title: 'Die Karte sicher herausnehmen', id: 'sicher-entfernen', keywords: ['auswerfen', 'herausziehen', 'entfernen', 'sicher entfernen', 'fseventsd', 'spotlight', 'trashes', 'mac', 'versteckte ordner'] },
          {
            kind: 'p',
            text: 'Nie herausziehen, solange ich schreibe. In der Desktop-App klickst du auf „Auswerfen“. In der Web-App nimmst du das Auswerfen-Symbol deines Computers, unter Windows „Hardware sicher entfernen“.',
          },
          {
            kind: 'p',
            text: 'Ein Mac legt versteckte Ordner auf die Karte (.fseventsd, .Spotlight-V100, .Trashes) und neben jede kopierte Datei eine „._“-Datei. Die Box zählt die „._“-Dateien in ihren Ordnern als Titel mit. Die Desktop-App räumt das alles direkt vor dem Auswerfen weg und schaut danach nach, ob es wirklich weg ist. Beim nächsten Einstecken legt der Mac die Ordner wieder an, das stört die Box nicht.',
          },
          {
            kind: 'command',
            text: 'In der Web-App gibst du am Mac diesen Befehl ein, bevor du die Karte auswirfst. Statt TONUINO schreibst du den Namen deiner Karte:',
            command: "cd /Volumes/TONUINO && rm -rf .fseventsd .Spotlight-V100 .Trashes ._.fseventsd ._.Spotlight-V100 ._.Trashes; find /Volumes/TONUINO -name '._*' -delete; cd ~",
          },
        ],
      },
      {
        // The notice and the button: src/features/box/writeAccess.ts; the remount: src-tauri/src/volumes.rs (volume_fix_access).
        id: 'sd-karte-schreibrechte',
        title: 'Schreiben auf die SD-Karte klappt nicht',
        summary: 'Ich zeige die Karte, aber Löschen, Hinzufügen oder ein neuer Ordner klappen nicht.',
        keywords: ['schreiben', 'Rechte', 'Berechtigung', 'Schreibschutz', 'Ordner anlegen', 'Schreibrechte', 'nur lesen', 'löschen geht nicht', 'root', 'Linux'],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Schreibschutz-Schalter:** Steht der kleine Schalter an der Seite der Karte oder des Adapters unten, schiebe ihn nach oben.',
              '**Neu einstecken:** Karte auswerfen, herausziehen, wieder einstecken.',
              '**Unter Linux:** Gehört die Karte einem anderen Konto, oft „root“, hilft in der Desktop-App der Knopf **Schreibrechte holen** in [Meine Box](#/). Der Computer fragt vielleicht nach deinem Passwort.',
            ],
          },
          { kind: 'bild', art: 'schreibschutz', caption: 'Der kleine Schalter an der Seite: oben darf ich schreiben, unten ist die Karte geschützt.' },
          { kind: 'mehr', title: 'Unter Linux kommt es immer wieder' },
          {
            kind: 'p',
            text: 'Dann hat die Karte einen festen Eintrag im System. Öffne in „Laufwerke“ bei der Karte „Einhängeoptionen bearbeiten“ und schalte „Vorgaben der Benutzersitzung“ wieder ein.',
          },
        ],
      },
    ],
  },
  {
    id: 'karten',
    title: 'Karten und Sticker',
    art: 'kat-karten',
    summary: 'Karten beschreiben, wie sie spielen, Spezialkarten, welche Karten du kaufst und wie Sticker draufkommen.',
    keywords: ['rfid', 'nfc', 'karte', 'anlernen', 'programmieren', 'schreiben', 'karten beschreiben'],
    sections: [
      {
        id: 'vier-wege',
        title: 'Karten beschreiben: welcher Weg?',
        summary: 'Vier Wege zur fertigen Karte: was du für jeden brauchst und wie es geht.',
        keywords: ['wege', 'methode', 'womit', 'aufgedruckte nummer', 'karte beschreiben', 'vier wege'],
        blocks: [
          {
            kind: 'p',
            text: 'Eine Karte sagt der Box, welchen Ordner sie spielt und wie. In [Karten beschreiben](#/karten) wählst du die Karten aus und dann den Weg:',
          },
          {
            kind: 'list',
            items: [
              '**An der Box:** Ich zeige dir, welche Tasten du drückst. Kein Zubehör nötig, gut für ein paar Karten.',
              '**Mit dem Handy:** Ein Android-Handy mit NFC schreibt die Karten, mit TonUINO Studio für Android oder über einen QR-Code.',
              '**Mit dem NFC-Leser:** Ein NFC-Leser am USB, z. B. der ACR122U, ist am schnellsten. Nur in der Desktop-App.',
              '**Über WLAN:** für Boxen mit ESP32 und TNG. Nur in der Desktop-App.',
            ],
          },
          { kind: 'foto', photo: 'karten-wege', caption: 'Unter „Womit beschreibst du sie?“ wählst du den Weg. Der eingekringelte Knopf ist der, den du gerade nimmst.' },
          {
            kind: 'p',
            text: 'Die Karte merkt sich die Nummer des Ordners, nicht die Titel: Neue Titel spielt sie mit. Eine aufgedruckte Nummer spielt keine Rolle.',
          },
          { kind: 'bild', art: 'karte-ordner', caption: 'Auf der Karte stehen nur die Nummer des Ordners und wie sie spielt. Kommt ein Titel in den Ordner dazu, spielt die Karte ihn mit.' },
          { kind: 'mehr', title: 'An der Box anlernen', id: 'an-der-box', keywords: ['tasten', 'admin-menü', 'admin', 'pin', 'rechenaufgabe', 'oh eine neue karte', 'sprachmenü', 'neu anlernen'] },
          {
            kind: 'steps',
            items: [
              'Wähle „An der Box“ und lege eine leere Karte auf. Die Box sagt „Oh, eine neue Karte!“.',
              'Drücke die Tasten, wie ich es zeige: **Vor** und **Zurück** blättern, lang gedrückt um zehn. **Play/Pause** kurz bestätigt, lang bricht ab.',
              'Lasse die Karte liegen, bis die Box „OK“ sagt.',
            ],
          },
          { kind: 'foto', photo: 'an-der-box', caption: 'So zeigt dir „An der Box“ jeden Schritt: welche Taste du drückst, wie oft, und was die Box dann sagt.' },
          {
            kind: 'p',
            text: `Eine schon beschriebene Karte startet das Menü nicht. Dann halte Play/Pause, Vor und Zurück gedrückt, bis die Box spricht: das [[Admin-Menü]]. Bei TNG mit 5 Tasten geht auch Play/Pause, Lauter und Leiser. Hast du es geschützt, stelle unter ${SETTINGS} ein, womit. Die Anleitung stimmt, wenn die Firmware deiner Box richtig eingestellt ist.`,
          },
          { kind: 'bild', art: 'admin-tasten', caption: 'Ins Admin-Menü kommst du mit Zurück, Play/Pause und Vor auf einmal: drücken und halten, bis die Box spricht. Bei TNG mit 5 Tasten gehen auch Play/Pause, Lauter und Leiser.' },
          { kind: 'links', links: [forumButton(13923, 'Das Admin-Menü von TNG im Forum')] },
          { kind: 'mehr', title: 'Mit dem Handy (QR-Code)', id: 'handy', keywords: ['qr', 'qr-code', 'nfc tools', 'handy-app', 'f-droid'] },
          {
            kind: 'steps',
            items: [
              'Installiere „TonUINO NFC Tools“ auf einem Android-Handy mit NFC. Die neueste Version gibt es bei F-Droid, bei Google Play nur eine ältere. iPhones können es nicht.',
              'Wähle „Mit dem Handy“. Tippe in der Handy-App auf „Liste eingeben“ und „QRCode einlesen“ und scanne den Code.',
              'Tippe auf „Abarbeiten starten“ und halte die Karten nacheinander ans Handy.',
            ],
          },
          {
            kind: 'bild',
            art: 'handy-karte',
            caption: 'Halte die Karte flach an die Rückseite des Handys. Wo es die Karte am besten findet, ist bei jedem Handy anders: Schiebe sie langsam hin und her.',
          },
          {
            kind: 'list',
            items: [
              'Manche Karten kann die Handy-App schreiben, aber nicht auslesen, etwa „Hörbuch, Teil eines Ordners“ oder die Admin-Karte. Liest sie so eine, stürzt sie ab. TonUINO Studio nennt dir diese Karten über den Codes.',
              'Spezialkarten zeigt die Handy-App unter anderen Namen, „Feuer, Wasser, Luft“ etwa beim Bearbeiten als „Sperre“.',
              'Meldet sie „Die App kann auf diese Art NFC Tag nicht schreiben“ mit „SAK: 08“, kann dein Handy keine MIFARE-Classic-Karten. Nimm NTAG-Karten oder die Box.',
            ],
          },
          {
            kind: 'links',
            links: [
              { label: 'TonUINO NFC Tools bei F-Droid (neueste Version)', href: 'https://f-droid.org/packages/de.mw136.tonuino/' },
              { label: 'TonUINO NFC Tools bei Google Play', href: 'https://play.google.com/store/apps/details?id=de.mw136.tonuino' },
            ],
          },
          { kind: 'mehr', title: 'Mit dem NFC-Leser (z. B. ACR122U)', id: 'kartenleser', keywords: ['acr122u', 'leser', 'nfc-leser', 'kartenleser', 'usb', 'pcscd', 'viele karten', 'karte prüfen', 'auslesen', 'karte löschen', 'löschen', 'nachmachen', 'kopieren', 'karte ändern', 'klack'] },
          {
            kind: 'p',
            text: 'Stecke den Leser ein, wähle „Mit dem NFC-Leser“ und dann „Karten beschreiben“. Lege eine Karte nach der anderen auf. Ist eine fertig, mach ich leise „Klack“ und lese sie zur Kontrolle wieder aus.',
          },
          {
            kind: 'list',
            items: [
              '**Schon beschrieben:** Steht auf einer Karte schon etwas, frag ich, bevor ich sie überschreibe, und zeige dir, was darauf steht. So überschreibst du nicht aus Versehen eine Karte, die du noch brauchst. Das gilt auch für das NFC des Handys.',
              '**Karte prüfen** zeigt, was auf der aufgelegten Karte steht. Darunter machst du sie mit „Nachmachen“ noch einmal oder schreibst sie mit „Ändern\u00a0…“ anders.',
              '**Karte löschen:** unter „Mehr zum NFC-Leser“ (die drei Punkte). Danach ist die Karte leer, und die Box sagt wieder „Oh, eine neue Karte!“.',
            ],
          },
          { kind: 'command', text: 'Unter Linux braucht der Leser den Dienst „pcscd“. Unter Debian, Ubuntu und Linux Mint:', command: 'sudo apt install pcscd libacsccid1' },
          {
            kind: 'mehr',
            title: 'Freie Ordnernummer, Zahlen und Bytes, TonUINO 2.0',
            id: 'mehr-karten',
            keywords: ['freie ordnernummer', 'ordnernummer', 'andere box', 'zahlen und bytes', 'bytes', 'hex', 'tonuino 2.0', '2.0', 'altes format', 'kartenformat'],
          },
          { kind: 'p', text: 'Das steht in [Karten beschreiben](#/karten) unter „Mehr Karten“, den drei Punkten bei „Welche Karten?“:' },
          {
            kind: 'list',
            items: [
              '**Karte mit freier Ordnernummer:** für einen Ordner von 1 bis 99, auch wenn er nicht auf dieser SD-Karte ist, etwa für eine zweite Box.',
              '**Zahlen und Bytes:** für Bastler. Du siehst und änderst jeden Wert, den die Karte speichert. Falsche Werte versteht die Box nicht.',
              '**Kartenformat für TonUINO 2.0:** nur für Boxen, die noch TonUINO 2.0 haben. Dann bekommen alle Karten das alte Format, und es gehen nur Karten für Ordner.',
            ],
          },
          { kind: 'mehr', title: 'Boxen mit WLAN (ESP32)', id: 'wlan', keywords: ['esp32', 'wifi', 'wlan', 'webseite der box', 'ip-adresse', 'adresse', '192.168.4.1', 'router'] },
          {
            kind: 'p',
            text: `Box und Computer müssen im selben WLAN sein. Gib bei „Über WLAN“ die Adresse der Box ein (im Router meist „tonuino“, im eigenen Netz der Box 192.168.4.1), klicke „An die Box senden“ und lege die Karte auf. Die Adresse findest du später unter ${SETTINGS}.`,
          },
        ],
      },
      {
        id: 'wiedergabearten',
        title: 'Wie eine Karte spielt',
        summary: 'Hörbuch, Album, Party und mehr, und was sich die Karte merkt und was die Box.',
        keywords: ['wiedergabearten', 'wiedergabeart', 'modus', 'modi', 'hörbuch', 'album', 'party', 'zufall', 'einzeltitel', 'von bis', 'quiz', 'memory'],
        blocks: [
          {
            kind: 'p',
            text: 'Auf der Seite eines Ordners legst du unter „So spielt die Karte“ fest, wie seine Karte spielt. Ich schlage etwas vor, für Hörspiele „Hörbuch“, Musik „Album“, Kinderlieder „Party“.',
          },
          { kind: 'modes' },
          {
            kind: 'note',
            tone: 'info',
            text: `Quiz, Memory, Teekesselchen und andere Spiele zeige ich erst, wenn du unter ${SETTINGS} „Spiele und Spezialmodi zeigen“ einschaltest. Sie brauchen eine passende Firmware.`,
          },
          { kind: 'mehr', title: 'Was die Karte speichert und was die Box', id: 'was-die-karte-speichert', keywords: ['zweite box', 'andere box', 'oma', 'fortschritt', 'gemerkt', 'merkt sich'] },
          {
            kind: 'p',
            text: 'Auf der Karte stehen nur Ordner, Wiedergabeart und manchmal Titelnummern. Wo ein Hörbuch steht, Lautstärke und Kurzwahl merkt sich die Box. Eine zweite Box merkt sich alles für sich: [Mehrere Boxen](#/hilfe/mehrere-boxen). Setzt du die Box zurück, vergisst sie, wo die Hörbücher standen.',
          },
          { kind: 'bild', art: 'karte-ordner', caption: 'Die Karte merkt sich die Nummer des Ordners und die Wiedergabeart, etwa Ordner 07 als Hörbuch. Die Titel selbst liegen auf der SD-Karte.' },
        ],
      },
      {
        id: 'spezialkarten',
        title: 'Spezialkarten',
        summary: 'Karten, die keinen Ordner spielen, sondern etwas umschalten: Schlummerkarte, Krabbelmodus, Admin-Karte und mehr.',
        keywords: [
          'modifikationskarte',
          'schlummer',
          'schlaf',
          'einschlafen',
          'stopptanz',
          'kita',
          'krabbel',
          'krabbelmodus',
          'admin-karte',
          'nochmal',
          'jukebox',
        ],
        blocks: [
          {
            kind: 'p',
            text: 'Spezialkarten schalten etwas an der Box um. Im Forum heißen sie [[Modifikationskarten|spezialkarte]]. In [Karten beschreiben](#/karten) fügst du sie mit „Spezialkarte hinzufügen“ hinzu.',
          },
          { kind: 'p', text: MODIFIER_HOWTO },
          { kind: 'modifiers' },
          {
            kind: 'list',
            items: [
              '**Admin-Karte:** öffnet das Admin-Menü, auch wenn es gesperrt ist. Hebe sie gut auf.',
              '**Krabbelmodus:** sperrt die Tasten, Karten gehen weiter.',
            ],
          },
          { kind: 'mehr', title: 'Schlummerkarte oder Ausschalt-Timer?' },
          {
            kind: 'list',
            items: [
              '**Die Schlummerkarte** legst du auf, wenn es losgehen soll. Nach ihrer Zeit schaltet TonUINO TNG die Box aus, TonUINO 2.1 hält sie nur an.',
              '**Der [[Ausschalt-Timer]]** schaltet aus, wenn eine Weile nichts läuft: [Box einstellen](#/hilfe/box-einstellen). Beide gehen zusammen.',
              '**Folge zu Ende hören:** Mit TNG wählst du „Erst am Ende des Titels ausschalten“.',
              '**Andere Zeit:** Tipp bei der Schlummerkarte auf „Andere“ und gib die Minuten selbst ein, mit TNG 1 bis 127, mit TonUINO 2.1 bis 255.',
              'Schläft die Box nur, statt auszugehen: [Die Box geht aus – oder nicht aus](#/hilfe/box-geht-aus).',
            ],
          },
        ],
      },
      {
        id: 'kartentypen',
        title: 'Welche Karten kaufen?',
        summary: 'Karten und Sticker mit 13,56\u00a0MHz, am besten MIFARE Classic 1K oder NTAG213/216. Kaufe nach der Sorte, nicht nach der Marke, und teste erst eine.',
        keywords: [
          'mifare',
          'classic',
          'ntag',
          'ultralight',
          'sticker',
          'chip',
          'desfire',
          '13,56 mhz',
          'kaufen',
          '125 khz',
          '125khz',
          'em4100',
          't5577',
          'lego',
          'metall',
          'on-metal',
          'glaskapsel',
          'nageltag',
          'schlüsselanhänger',
          'aufkleber',
          'ultralight c',
          'packung',
          'welche karten passen',
        ],
        blocks: [
          {
            kind: 'p',
            text: 'Die Box liest Karten mit 13,56\u00a0MHz ([[MIFARE und NTAG|kartensorten]]): MIFARE Classic 1K und 4K, Ultralight, NTAG213 und NTAG216. NTAG215 erst ab TonUINO TNG 3.2.1.',
          },
          {
            kind: 'checks',
            items: [
              // Forum 15017: the AZ-Delivery cards many used are gone; "MIFARE 1k" from others work.
              '**Nach der Sorte suchen:** zum Beispiel „MIFARE Classic 1K, 13,56\u00a0MHz“. Marken und Angebote wechseln oft, bestimmte Karten gibt es nach einer Weile nicht mehr.',
              '**Nicht 125\u00a0kHz:** EM4100 oder T5577 sind Türkarten. Die Box merkt nicht einmal, dass eine Karte daliegt.',
              '**Erst eine testen:** Kauf wenige und prüfe eine mit [Box testen: Kartenleser](#/werkstatt/kartenleser).',
              '**Groß ist sicherer:** Kleine Sticker und Glaskapseln liest die Box oft nur ganz nah. Sticker unter Figuren: [Figuren statt Karten](#/hilfe/figuren).',
              '**Kein Metall** dahinter, außer bei On-Metal-Tags.',
              '**Nur manchmal erkannt:** Meist liegt es an der Lage auf dem Leser, nicht an der Karte: [Eine Karte wird nicht erkannt](#/hilfe/karte-geht-nicht).',
            ],
          },
          { kind: 'mehr', title: 'Spielzeug-Chips, Ultralight C und Handy-Apps' },
          {
            kind: 'list',
            items: [
              'Chips aus Spielzeug, etwa von LEGO, lassen sich oft nicht beschreiben.',
              '„Ultralight C“ ist nicht Ultralight und wird manchmal als NTAG verkauft. Die Box liest es schlecht.',
              'Lasse Karten nicht von Handy-Apps „formatieren“: Danach kann die Box sie oft nicht mehr lesen.',
            ],
          },
        ],
      },
      {
        // Forum: wooden figures with 25 mm stickers (8827), sticker reach through wood (1623#11/#13/#16), tiny stickers
        // and glass capsules (11681, 12747), magnets (2128, 828, 3416, 6752), bases (1655, 13590, 11010).
        // Tonies use ISO 15693 (ICODE SLIX-L), which the MFRC522 cannot read. Research note: recherche/figuren.md.
        id: 'figuren',
        title: 'Figuren statt Karten',
        summary: 'Klebe einen NFC-Sticker unter eine Figur, dann startet sie die Box wie eine Karte.',
        keywords: [
          'figur',
          'figuren',
          'holzfigur',
          'spielfigur',
          'eigene figuren',
          'tonie',
          'tonies',
          'kreativ-tonie',
          'sticker unter figur',
          'nfc-sticker',
          'nfc sticker',
          'rfid-sticker',
          'sockel',
          'schleich',
          'playmobil',
          '3d-druck',
          'magnet',
          'magnete',
          'feder',
          'metallfeder',
        ],
        forum: 8827,
        blocks: [
          {
            kind: 'p',
            text: 'Für die Box ist eine Figur eine Karte mit anderer Form. Unter ihren Fuß kommt ein NFC-Sticker, ein runder Aufkleber mit Chip. Den beschreibst du wie eine Karte: [Karten beschreiben: welcher Weg?](#/hilfe/vier-wege)',
          },
          {
            kind: 'checks',
            items: [
              '**Groß genug:** rund, 25 bis 30 mm, auf der Packung steht NTAG213. Kleinere als 20 mm liest die Box oft nicht. Ist der Fuß zu klein, klebe die Figur auf eine Scheibe aus Holz.',
              '**Ganz unten:** Der Sticker liegt flach unter dem Fuß, direkt auf dem Deckel. Oben in der Figur ist er zu weit weg.',
              '**Kein Metall am Sticker:** Eine Feder, Schraube oder ein Fuß aus Metall braucht 5 bis 10 mm Abstand zum Sticker.',
              '**Erst testen, dann kleben:** Halte den Sticker mit Klebeband unter die Figur und stelle sie ein paar Mal auf die Box. Klappt es jedes Mal, klebe ihn fest.',
              '**An die richtige Stelle:** Die Figur muss mittig über dem Kartenleser stehen. Markiere die Stelle auf dem Deckel.',
            ],
          },
          {
            kind: 'p',
            text: 'Soll die Box anhalten, wenn du die Figur herunternimmst? Das stellst du mit TNG unter [Box einstellen](#/hilfe/box-einstellen) ein: „Karte wegnehmen“.',
          },
          { kind: 'mehr', title: 'Welcher Sticker?', id: 'figur-sticker', keywords: ['ntag213', 'durchmesser', 'größe', 'on-metal', 'glaskapsel', 'mini-sticker', 'ü-ei'] },
          {
            kind: 'list',
            items: [
              '**NTAG213** liest die Box, und jedes Handy mit NFC kann ihn beschreiben. MIFARE Classic 1K geht auch, aber nicht mit jedem Handy. Alle Sorten: [Welche Karten kaufen?](#/hilfe/kartentypen)',
              '**Größe:** Einen Sticker liest die Box nur etwa halb so weit weg wie eine Karte, einen kleinen noch näher. 25 mm ist das Mindeste, 30 mm ist besser, wenn der Fuß Platz hat.',
              '**Winzige Sticker und Glaskapseln** (8 bis 12 mm, für kleine Figuren) liest der Kartenleser im TonUINO oft gar nicht. Im Forum gingen sie nur mit manchen Lesern.',
              '**On-Metal-Sticker** haben eine dünne Schicht, die Metall abschirmt. Ihre Klebeseite kommt ans Metall. Sie sind dicker, teurer und lesen sich etwas schlechter: Nimm sie nur, wenn das Metall nicht weg kann.',
            ],
          },
          { kind: 'mehr', title: 'Figuren mit Feder oder Magnet', id: 'figur-metall', keywords: ['spirale', 'wackelfigur', 'neodym', 'magnet im fuß'] },
          {
            kind: 'p',
            text: 'Metall direkt am Sticker schluckt das Funksignal. Steht die Figur auf einer Metallfeder oder einem Metallfuß, schaff Abstand:',
          },
          {
            kind: 'steps',
            items: [
              'Klebe unter die Feder eine Scheibe aus Holz, 5 bis 10 mm dick und etwas breiter als der Sticker.',
              'Klebe den Sticker unter die Scheibe. Dann liegt er unten auf dem Deckel, und das Metall ist weit genug weg.',
              'Geht es trotzdem nicht, nimm einen On-Metal-Sticker.',
            ],
          },
          {
            kind: 'p',
            text: '**Magnete** halten eine Figur an ihrem Platz, können das Lesen aber stören. Im Forum gingen kleine Magnete bis etwa 10 mm mit etwas Abstand zum Sticker, große nicht. Probiere es aus, bevor du etwas festklebst.',
          },
          { kind: 'mehr', title: 'Holzfiguren, Schleich, Playmobil, 3D-Druck, Tonies', id: 'figur-arten', keywords: ['tiere', 'duplo', 'schlüsselanhänger', 'kreativ-tonies', 'iso 15693'] },
          {
            kind: 'list',
            items: [
              '**Holzfiguren:** Der Sticker kommt direkt unter den Fuß. Ist der Fuß schmaler als der Sticker, klebe die Figur auf eine runde Holzscheibe.',
              '**Schleich und andere Tiere** stehen auf vier Beinen: Klebe sie auf eine runde oder ovale Scheibe, der Sticker kommt darunter.',
              '**Playmobil, Duplo, Ü-Ei-Figuren:** Ihr Fuß ist zu klein. Klebe sie auf eine Scheibe oder auf einen Schlüsselanhänger mit Chip.',
              '**3D-Druck:** Drucke einen Sockel mit einer flachen Tasche für den Sticker, der Boden darunter so dünn wie möglich.',
              '**Tonies** liest die Box nicht: Ihr Chip ist eine andere Sorte (ISO 15693), die der Kartenleser im TonUINO nicht kennt. Einen eigenen Sticker unter einem Tonie kannst du probieren, der Magnet im Fuß stört manchmal.',
            ],
          },
          { kind: 'mehr', title: 'Die Stelle auf dem Deckel', id: 'figur-deckel', keywords: ['deckel', 'mulde', 'markierung', 'leseposition', 'deckelstärke', 'abstand', 'reichweite'] },
          {
            kind: 'p',
            text: 'Der Kartenleser sitzt innen unter dem Deckel. Suche die Stelle mit einer Karte: Schiebe sie über den Deckel, bis die Box reagiert. Dort klebst du einen Punkt hin, oder du fräst eine flache Mulde, in die die Figur passt. Die Mulde hält die Figur fest und bringt den Sticker näher an den Leser.',
          },
          { kind: 'bild', art: 'karte-auflegen', caption: 'So liest die Box eine Karte: flach und mittig über dem Kartenleser, nicht am Rand und ohne Metall dazwischen. Für den Sticker unter einer Figur gilt dasselbe.' },
          {
            kind: 'p',
            text: 'Liest die Box Karten nur knapp, reicht es für Sticker oft nicht. Im Forum gingen Sticker durch 6 bis 7 mm Holz. Bei einem dickeren Deckel half es, ihn innen über dem Leser dünner zu machen. Ob die Box die Figur jedes Mal erkennt, zählt [Box testen: Kartenleser](#/werkstatt/kartenleser) für dich mit.',
          },
          {
            kind: 'p',
            text: 'Am einfachsten beschreibst du den Sticker, bevor du ihn festklebst. [An der Box](#/hilfe/an-der-box) geht es auch mit der fertigen Figur: Stelle sie auf, die Box sagt „Oh, eine neue Karte!“.',
          },
        ],
      },
      {
        // Forum: families with a box at the grandparents' and siblings with a box each (G9).
        id: 'mehrere-boxen',
        title: 'Mehrere Boxen',
        summary: 'Eine Box bei Oma, eine fürs Geschwisterkind: welche Karten wo spielen und wie du Ordner kopierst.',
        keywords: ['großeltern', 'oma', 'opa', 'geschwister', 'andere sd-karte', 'zweite sd-karte', 'kopieren', 'mehrere boxen', 'gleiche karten'],
        blocks: [
          {
            kind: 'p',
            text: 'Karten laufen auf jeder Box, deren SD-Karte den Ordner mit derselben Nummer hat. Wo ein Hörbuch steht, merkt sich jede Box selbst.',
          },
          {
            kind: 'steps',
            items: [
              'Wähle in [Meine Box](#/) im Menü mit den drei Punkten „Auf eine andere SD-Karte kopieren …“ (Chrome, Edge, Desktop-App).',
              'Wähle die Ordner und die Karte der anderen Box. Jeder Ordner behält seine Nummer.',
              'Nur ein SD-Kartenleser? Wähle „Ordner auf dem Computer“. Kopiere danach den Inhalt dieses Ordners, nicht den Ordner selbst, auf die leere FAT32-Karte: zuerst die Ordner mp3 und advert, dann 01, 02 und so weiter.',
            ],
          },
          {
            kind: 'note',
            tone: 'warning',
            text: 'Die Ansagen kopiere ich nur, wenn die andere Box dieselbe Firmware hat. Sonst spiele sie dort unter [Systemansagen](#/werkstatt/ansagen) auf.',
          },
          { kind: 'p', text: '**Großeltern ohne Computer:** Bereite die Karte bei dir vor und schicke sie. Handy oder iPad reichen dafür nicht.' },
        ],
      },
      {
        id: 'tng-oder-2-1',
        title: 'TonUINO TNG oder 2.1?',
        summary: 'Welche Firmware auf deiner Box läuft und was sich dadurch in der App ändert.',
        keywords: ['firmware', 'version', 'tng', '2.1', 'classic', 'welche firmware'],
        blocks: [
          {
            kind: 'p',
            text: 'Die [[Firmware]] ist das Programm auf der Box: **TonUINO TNG** (3.x) oder das ältere **TonUINO 2.1**. Lege eine leere Karte auf: Fragt die Box zuerst nach dem Ordner, ist es 2.1. Das [Box-Logbuch](#/werkstatt/logbuch) zeigt es genau.',
          },
          {
            kind: 'p',
            text: `Davon hängen Wiedergabearten, Spezialkarten und Ansagen ab. Du stellst sie in [Karten beschreiben](#/karten) oder unter ${SETTINGS} ein.`,
          },
          { kind: 'mehr', title: 'Von 2.1 auf TNG wechseln' },
          {
            kind: 'p',
            text: 'Karten für Ordner spielen weiter. Spezialkarten können sich ändern: „Alles gesperrt“ startet in TNG „Feuer, Wasser, Luft“. Beschreibe sie neu und spiele neue [Systemansagen](#/werkstatt/ansagen) auf.',
          },
        ],
      },
      {
        id: 'sticker',
        title: 'Sticker drucken',
        summary: 'Sticker gestalten, das passende Papier wählen und genau drucken.',
        keywords: ['etiketten', 'aufkleber', 'drucken', 'bilder', 'pdf', 'stil', 'bildkarte', 'schrift', 'logo', 'titel', 'ordnernummer', 'hochformat', 'querformat', 'sticker gestalten', 'verschieben', 'tauschen', 'reihenfolge', 'drag and drop'],
        blocks: [
          {
            kind: 'steps',
            items: [
              'Öffne [Sticker drucken](#/sticker) und wähle die Karten. Ohne SD-Karte ziehst du Bilder hinein.',
              'Wähle den Stil und ob Titel und Nummer draufstehen. Für Karten ohne Cover passt „Bildkarte“: ein gemaltes Bild und ein Wort. Format, Schrift, Logo und Papier stehen unter „Mehr …“. Klicke auf einen Sticker, um ihn einzeln zu ändern. Fehlt ein Bild: [Cover](#/hilfe/cover).',
              'Ziehe einen Sticker auf ein anderes Etikett: Auf ein freies wandert er, auf einen anderen Sticker tauschen die beiden. Mit der Tastatur: Sticker anwählen, Pfeiltasten, Eingabe. Druck, PDF und Rückseiten richten sich danach; „Reihenfolge zurücksetzen“ ordnet sie wieder der Reihe nach.',
              'Klicke auf „Drucken“ und stelle im Druckdialog „Tatsächliche Größe“ oder 100\u00a0% ein. Bei Etikettenbögen druckst du mit „Erst auf Normalpapier probieren“ zuerst auf normales Papier und hältst das Blatt gegen den Bogen. „PDF speichern“ gibt es auch, etwa für einen anderen Computer.',
            ],
          },
          { kind: 'mehr', title: 'Welches Papier?', id: 'papier', keywords: ['herma', '5028', 'labelident', 'selphy', 'fotoabzug', 'folie', 'rund', 'etikettenbogen', 'vorlage', 'etiketten'] },
          { kind: 'papers' },
          {
            kind: 'p',
            text: 'Der Klassiker ist HERMA 5028 mit 10 Stickern pro Bogen. Fehlen schon Etiketten, tippe sie in der Übersicht an; die Sticker lassen sie frei, auch wenn du sie verschiebst. Für einen Fotoabzug bestellst du 13\u00a0×\u00a018\u00a0cm ohne Rand.',
          },
          { kind: 'bild', art: 'stickerbogen', caption: 'Ein Bogen HERMA 5028: zwei Reihen mit je fünf Stickern. Ein Sticker ist etwas kleiner als die Karte, rundherum bleibt ein schmaler Rand frei.' },
          {
            kind: 'mehr',
            title: 'Genau drucken',
            id: 'drucken',
            keywords: ['pdf', 'tatsächliche größe', '100\u00a0%', 'versatz', 'kalibrieren', 'drucker ausrichten', 'testseite', 'daneben', 'größe'],
          },
          {
            kind: 'p',
            text: 'Im Druckdialog zählen vier Dinge: Papierformat A4, Größe 100\u00a0% oder „Tatsächliche Größe“, Papierart „Etiketten“ oder „dickes Papier“ und kein randloser Druck. Lege den Bogen einzeln ein und schiebe die Papierführung an. Die Liste klappt auch beim Knopf „Drucken“ auf, wenn du auf „Druckgröße 100\u00a0%“ klickst.',
          },
          {
            kind: 'p',
            text: 'Druckt dein Drucker ein, zwei Millimeter daneben? Unter „Drucker ausrichten“ druckst du eine Testseite, misst die 10-cm-Linie nach und liest zwei Zahlen ab. Ich gleiche das danach aus.',
          },
          // margin.ts and PaperMore in StickerPage.tsx: "Weißer Rand", 0 to 3 mm by paper, 1 mm from the start on sheets without a gap.
          {
            kind: 'mehr',
            title: 'Sticker liegen daneben',
            id: 'verrutscht',
            keywords: ['verrutscht', 'daneben', 'rand', 'weißer rand', 'abstand', 'nachbar', 'überlappen', 'ungleichmäßig', 'papiereinzug', 'schief', 'zu klein', 'skalierung', 'an seite anpassen', 'probedruck', 'normalpapier'],
          },
          {
            kind: 'p',
            text: 'Drucke erst mit „Erst auf Normalpapier probieren“ (beim Knopf „Drucken“) auf normales Papier. Dort steht um jedes Etikett ein dünner Umriss. Lege das Blatt auf einen Etikettenbogen und halte beides gegen ein Fenster. Woran es liegt, siehst du daran, welche Sticker daneben liegen.',
          },
          { kind: 'bild', art: 'daneben', caption: 'Links liegen alle Sticker gleich verschoben. In der Mitte passt die Mitte, nach außen liegen sie immer weiter daneben. Rechts werden sie nach unten immer schiefer.' },
          {
            kind: 'list',
            items: [
              '**Alle gleich verschoben:** Dein Drucker setzt den ganzen Bogen ein Stück daneben. Das gleichst du unter „Mehr …“ mit „Drucker ausrichten“ aus.',
              '**Mitte gut, außen daneben:** Die Größe stimmt nicht. Fast immer verkleinert der Druckdialog die Seite, mit „An Seite anpassen“, dem Papierformat Letter oder randlosem Druck. Stelle 100\u00a0% und A4 ein. Die 10-cm-Linie auf der Testseite zeigt dir, ob es stimmt.',
              '**Nach unten immer schiefer:** Der Drucker zieht das Papier ungleichmäßig ein, das gleicht Ausrichten nicht aus. Stelle die Papierart „Etiketten“ oder „dickes Papier“ ein, lege den Bogen einzeln ein und schiebe die Führung an. Dazu hilft der weiße Rand.',
            ],
          },
          {
            kind: 'p',
            text: 'Den **weißen Rand** stellst du unter „Mehr …“ beim Papier ein, 1 bis 3\u00a0mm. Jedes Bild wird rundherum so viel kleiner gedruckt, und das Etikett bleibt dort weiß. Verrutscht ein Sticker um bis zu diese Breite, landet trotzdem nichts auf dem Nachbarn. Bei Bögen ohne Lücke zwischen den Etiketten, etwa HERMA 5028, ist 1\u00a0mm schon eingestellt. Ich merke mir den Rand für jedes Papier einzeln.',
          },
          // Forum 13564: laser print on plain paper, packing tape on the printed side, soak, rub off, tape side down onto the card.
          // Not mirrored: you look at the toner through the tape from the side it was taped on, before and after.
          {
            kind: 'mehr',
            title: 'Karten direkt bedrucken, ohne Sticker',
            id: 'karten-bedrucken',
            keywords: ['tonertransfer', 'transfer', 'paketband', 'klebeband', 'direkt bedrucken', 'ohne sticker', 'laserdrucker', 'gespiegelt', 'spiegeln', 'spiegelverkehrt'],
          },
          {
            kind: 'steps',
            items: [
              'Wähle unter „Mehr …“ das Papier „Ganze Karten zum Ausschneiden (A4)“ und drucke auf normales Papier, mit einem **Laserdrucker**. Mit Tinte geht es nicht.',
              'Schneide die Karten grob aus. Klebe durchsichtiges Paketband ohne Blasen auf die bedruckte Seite und streiche es mit einer Karte fest.',
              'Lege das Stück ein paar Minuten in Wasser und rubble das nasse Papier ab. Die Farbe bleibt am Kleber. Spüle die Klebeseite kurz ab.',
              'Lege das Band nass mit der Klebeseite auf die Karte und drücke das Wasser von der Mitte nach außen heraus. Schneide den Rand an der Kartenkante ab.',
            ],
          },
          {
            kind: 'p',
            text: '**Nicht gespiegelt drucken:** Du schaust am Ende durch das Band auf die Farbe, genau wie beim Aufkleben auf das Papier. Die Schrift steht also richtig herum. Für eine ganze Karte muss das Band breiter sein als 54\u00a0mm, normales Paketband ist meist 48 oder 50\u00a0mm breit.',
          },
          { kind: 'links', links: [forumButton(13564, 'Anleitung im Forum')] },
          { kind: 'mehr', title: 'Sticker für die Tasten', id: 'tasten-sticker', keywords: ['tasten', 'knöpfe', 'arcade', 'symbole', 'tastensymbole', 'play', 'pause', 'lauter', 'leiser', 'tasten-sticker'] },
          {
            kind: 'p',
            text: 'Runde Sticker mit Zeichen für die Tasten der Box, also Play/Pause, vor, zurück, lauter und leiser, druckst du in der Werkstatt unter [Tasten-Sticker](#/werkstatt/tastensticker). Für 3 oder 5 Tasten, auf runden Stickern mit 25 oder 30\u00a0mm.',
          },
        ],
      },
    ],
  },
  {
    id: 'werkstatt',
    title: 'Box bauen und einstellen',
    art: 'kat-werkstatt',
    summary: 'Firmware aufspielen, die Box einstellen, löten und testen, und was hilft, wenn der Computer die Box nicht findet.',
    keywords: ['werkstatt', 'reparieren', 'technik', 'usb', 'kabel', 'bauen', 'basteln', 'selbst bauen'],
    sections: [
      {
        // Forum 14745: getting the firmware onto the box again after years; "Com to DFPlayer broken" was a soldering fault.
        id: 'firmware',
        title: 'Firmware aufspielen',
        summary: 'Ein neues Programm auf die Box spielen: was du brauchst, welche fertige Firmware passt und was Fehlermeldungen heißen.',
        forum: 14745,
        keywords: [
          'update',
          'updates',
          'aktualisieren',
          'aktualisierung',
          'flashen',
          'hex',
          'nano',
          'aio',
          'aio+',
          'every',
          'esp32',
          'platine',
          'tasten',
          'stk500_getsync',
          'not in sync',
          'resp=0x0a',
          '3020',
          'receivedata timeout',
          'ser_open',
          'zugriff verweigert',
          'programmer is not responding',
          'verification error',
          'avrdude',
          // How the box switches off decides whether the ready-made build fits.
          'ausschalten',
          'abschalten',
          'abschaltung',
          'geht aus',
          'geht sofort wieder aus',
          'geht gleich wieder aus',
          'schaltet sich aus',
          'schaltet sich nicht aus',
          'pololu',
          'trägerplatine',
          'cubiekid',
        ],
        blocks: [
          {
            kind: 'p',
            text: 'Die [[Firmware]] ist das Programm auf der Box. Läuft sie gut, musst du nichts tun. Ein Update bringt neue Wiedergabearten und behebt Fehler. Karten für Ordner spielen danach weiter.',
          },
          {
            kind: 'steps',
            items: [
              'Nimm ein USB-Kabel, das Daten überträgt, und Chrome, Edge, Firefox ab Version 151 oder die Desktop-App.',
              'Öffne [Firmware aufspielen](#/werkstatt/firmware) und wähle deine [[Platine]] und die Tasten, etwa 3, 5 oder das 3×3-Tastenfeld.',
              'Verbinde die Box und starte. Bei AiO und AiO+ hältst du dabei Play/Pause gedrückt, bis „Fertig“ erscheint.',
            ],
          },
          {
            kind: 'p',
            text: 'Meist bleiben die Einstellungen der Box. Nach dem Aufspielen lese ich ihren Start und sage dir, ob sie noch stimmen. Hat die Box wieder die Werte ab Werk, stellst du deine Grenzen unter [Box einstellen](#/werkstatt/einstellen) neu ein. Oft braucht sie danach neue [Systemansagen](#/werkstatt/ansagen).',
          },
          { kind: 'mehr', title: 'Wie geht deine Box aus? Die Abschalt-Platine' },
          {
            kind: 'p',
            text: 'Beim Classic und beim ESP32 frage ich, wie deine Box ausgeht. Mit Schalter, Powerbank, AiO oder AiO+ passt die fertige Firmware immer.',
          },
          {
            kind: 'list',
            items: [
              '**TonUINO Classic (Arduino Nano):** Mit Pololu-Schalter passt sie. Für die CubieKid- oder Trägerplatine nehme ich eine eigene Fassung, bei der die Abschaltung andersherum arbeitet. Sie ist in der App dabei.',
              '**ESP32 Nano:** Mit Pololu-Schalter passt sie. Mit CubieKid- oder Trägerplatine passt sie nicht.',
              '**ESP32 WROOM:** Mit CubieKid- oder Trägerplatine passt sie. Mit Pololu-Schalter passt sie nicht.',
            ],
          },
          {
            kind: 'p',
            text: 'Passt sie nicht, geht die Box gleich nach dem Einschalten wieder aus. Frage dann, wer die Box gebaut hat, nach der passenden Datei, beim ESP32 spielst du sie über seine Webseite auf. Andere Gründe: [Die Box geht aus – oder nicht aus](#/hilfe/box-geht-aus).',
          },
          {
            kind: 'mehr',
            title: 'Extras: Drehregler, Leuchtring und mehr',
            id: 'firmware-extras',
            keywords: [
              'extras',
              'drehregler',
              'drehgeber',
              'poti',
              'leuchtring',
              'led-ring',
              'leuchtende tasten',
              'kopfhörer-erkennung',
              'baukasten',
              'lautsprecher stumm',
              'knacken',
              'spkonoff',
              'wecker',
              'wecker-start',
              'special_start_shortcut',
              'mp3-chip',
              'mp3-player-chip',
              'mh2024k',
              'gd3200b',
              'lisp3',
            ],
          },
          {
            kind: 'p',
            text: 'Hat deine Classic- oder AiO-Box einen Drehregler, ein Poti, einen Leuchtring, leuchtende Tasten oder eine Kopfhörerbuchse mit Schaltkontakt? Klappe unter „Fertige Firmware“ die **Extras** auf und hake an, was eingebaut ist. Ich nehme dann eine Firmware, in der genau das eingeschaltet ist, ohne Internet. Was nicht zusammen geht, ist ausgegraut. Wohin die Teile kommen, zeigt der [Lötplan](#/werkstatt/loetplan).',
          },
          {
            kind: 'p',
            text: 'Der Drehregler ändert beim Spielen die Lautstärke, in der Pause die Helligkeit des Leuchtrings. Der Leuchtring braucht beim Nano das neue Startprogramm (Bootloader). Hat deiner das alte, sag ich das vorher.',
          },
          {
            kind: 'p',
            text: '**Lautsprecher stumm beim Ein- und Ausschalten** (SPKONOFF) schaltet den Verstärker über D6 erst nach dem Start an: Das Knacken beim Ein- und Ausschalten ist weg. Dafür braucht die Box eine Schaltung an D6, darum geht es nicht zusammen mit leuchtenden Tasten.',
          },
          {
            kind: 'p',
            text: 'Unter „Mehr“ stehen zwei seltene Extras. **Anderer MP3-Player-Chip:** Reagieren die Tasten nach manchen Titeln nicht mehr, findet die Box in jedem Ordner so viele Titel wie in Ordner 01 oder überspringt sie nach einer Ansage einen Titel, wähle den Chip, der auf deinem MP3-Player steht (MH2024K-24SS, GD3200B oder GD3200D, LISP3). **Wecker-Start** (nur Classic): Schaltet ein Wecker die Box ein und liegt dabei an A6 Spannung an, spielt sie gleich Titel 1 aus Ordner 01. Beide gibt es nur ohne Licht, „Lautsprecher stumm“ und Kopfhörer-Erkennung, und nicht miteinander.',
          },
          {
            kind: 'p',
            text: 'Bei einem Update mit „Alte Firmware vorher sichern“ schau ich in die alte Firmware. Fehlen der neuen Extras deiner Box, etwa der Drehregler, sag ich es dir vor dem Aufspielen. Dann nimmst du die Extras mit oder spielst bewusst ohne sie auf.',
          },
          { kind: 'mehr', title: 'Fehlermeldungen aus anderen Programmen' },
          {
            kind: 'list',
            items: [
              '**stk500_getsync oder „not in sync“:** Die Box antwortet nicht. Falsche Platine gewählt, Play/Pause bei der AiO nicht gedrückt, oder das Kabel lädt nur.',
              '**ser_open oder „Zugriff verweigert“:** Ein anderes Programm wie die Arduino IDE belegt den Anschluss: [Die Box wird per USB nicht gefunden](#/hilfe/box-nicht-gefunden).',
              '**„verification error“ mittendrin:** Die Verbindung ist abgerissen. Nimm ein anderes Kabel.',
              '**„no matching function“ mit Mp3Notify oder OnPlayFinished** beim Kompilieren: eine alte Anleitung für TonUINO 2.x. Spiele lieber hier die fertige TNG-Firmware auf.',
              '**Nano Every** kann ich nicht bespielen, **ESP32** aktualisierst du über seine Webseite.',
            ],
          },
        ],
      },
      {
        // Forum 8112: the lowest volume too loud; the limits of the admin menu.
        id: 'box-einstellen',
        title: 'Box einstellen: Lautstärke, Ausschalt-Timer, Sperre',
        summary: 'Wie laut die Box wird, wann sie ausgeht und wer das Admin-Menü öffnen darf. Ich zeig dir jeden Tastendruck.',
        forum: 8112,
        keywords: [
          'lautstärke begrenzen',
          'maximale lautstärke',
          'kindersicherung',
          'sperren',
          'pin',
          'ausschalt-timer',
          'standby',
          'karte weg',
          'kurzwahl',
          'shortcut',
          'startton',
          'admin-menü',
          'einstellungen',
          'einstellungen ändern',
          'tastenbelegung',
          'startlautstärke',
          'einschaltlautstärke',
          'equalizer',
          'eq',
          'schlaftimer',
        ],
        blocks: [
          {
            kind: 'p',
            text: 'Das stellst du im [[Admin-Menü]] der Box ein, mit ihren Tasten. Öffne [Box einstellen](#/werkstatt/einstellen), wähle, was du ändern willst, und drücke die Tasten, wie die Schritte es zeigen. Hast du die Box vorher im [Box-Logbuch](#/werkstatt/logbuch) ausgelesen, weiß ich ihre Werte.',
          },
          { kind: 'bild', art: 'admin-tasten', caption: 'Ins Admin-Menü kommst du mit Zurück, Play/Pause und Vor auf einmal: drücken und halten, bis die Box spricht. Bei TNG mit 5 Tasten gehen auch Play/Pause, Lauter und Leiser. Mit PIN gibst du danach die PIN ein, bei 2.1 mit Rechenaufgabe die Lösung. Ist es mit der Admin-Karte geschützt, öffnen die Tasten es nicht: Lege dann die Admin-Karte auf.' },
          {
            kind: 'list',
            items: [
              '**Lautstärke:** höchstens, mindestens und beim Start. Fürs Kinderzimmer etwa 20, 1 und 8. Ab Werk sind es 25, 5 und 15. Klingt sie oben kratzig: [Laut klingt es kratzig](#/hilfe/kratzig).',
              '**Ausschalt-Timer:** aus nach 5 bis 60\u00a0Minuten ohne Musik. Ab Werk ist er aus. Mehr: [Die Box geht aus – oder nicht aus](#/hilfe/box-geht-aus).',
              '**Admin-Menü schützen:** mit Admin-Karte, PIN aus vier Tastendrücken oder bei 2.1 mit einer Rechenaufgabe.',
              '**Karte wegnehmen** (nur TNG): Die Box hält an, wenn die Karte weg ist.',
            ],
          },
          {
            kind: 'note',
            tone: 'warning',
            text: 'Schreibe eine [Admin-Karte](#/hilfe/spezialkarten), bevor du sperrst. Ohne sie hilft bei vergessener PIN nur, [alles zurückzusetzen](#/hilfe/anlernen-klappt-nicht).',
          },
          { kind: 'mehr', title: 'Tasten, Kurzwahl, Kopfhörer und Zurücksetzen' },
          {
            kind: 'list',
            items: [
              '**Kurzwahl:** Ein langer Tastendruck startet einen Ordner, wenn nichts läuft. Bei TonUINO TNG sind das Vor, Zurück oder beide zusammen, denn Play/Pause lang schaltet dort aus. Bei TonUINO 2.1 sind es Play/Pause, Vor und Zurück. Eine weitere Kurzwahl spielt beim Einschalten.',
              '**Lautstärke für Kopfhörer** (TNG mit Kopfhörer-Erkennung): eigene Grenzen, die nur gelten, solange ein Kopfhörer steckt. Ab Werk höchstens 25 und beim Einschalten 15: [Kopfhörer zu laut oder zu leise](#/hilfe/kopfhoerer).',
              '**Bedienkarte:** Was die Tasten deiner Box tun, druckst du dir in der Werkstatt als [Bedienkarte](#/werkstatt/bedienkarte) aus.',
              '**Alles zurücksetzen:** Werte ab Werk. Sperre, Kurzwahl und Hörbuch-Stellen sind weg.',
              '**Klang:** Normal, Pop, Rock, Jazz, Klassik oder Bass.',
            ],
          },
          { kind: 'mehr', title: 'TNG ausführlich im Forum', id: 'tng-nachlesen', keywords: ['admin-menü', 'funktionen', 'konfiguration', 'constants.hpp', 'tng anleitung', 'alle einstellungen'] },
          {
            kind: 'p',
            text: 'Jeden Punkt des Admin-Menüs von TonUINO TNG und alle Schalter der Firmware erklären zwei Beiträge im TonUINO-Forum ausführlich.',
          },
          { kind: 'links', links: [forumButton(13923, 'TNG: Admin-Menü und Funktionen'), forumButton(13947, 'TNG: Einstellungen der Firmware')] },
        ],
      },
      {
        id: 'loetplan',
        title: 'Lötplan: welches Kabel wohin',
        summary: 'Baust du die Box selbst, zeigt dir ein großes Bild, welches Kabel wohin gehört.',
        keywords: ['lötplan', 'löten', 'verkabeln', 'kabel', 'schaltplan', 'anschließen', 'verdrahten', 'selbst bauen', 'zusammenbauen'],
        blocks: [
          {
            kind: 'p',
            text: 'Wähle im [Lötplan](#/werkstatt/loetplan) deine Platine und 3 oder 5 Tasten. Lege das Bild neben dich oder drucke es aus. Verbinde nach dem Aufdruck auf den Teilen. Danach prüfst du mit [Box testen](#/werkstatt/testen).',
          },
          {
            kind: 'p',
            text: 'Die ganze Bauanleitung mit Teileliste, Gehäuse und Fragen steht auf der Seite von Thorsten Voß, der TonUINO ins Leben gerufen hat.',
          },
          { kind: 'links', links: [{ label: 'Bauanleitung auf voss.earth', href: 'https://www.voss.earth/tonuino/' }] },
          { kind: 'bild', art: 'box-innen', caption: 'Was in einer Box steckt: Strom, Kartenleser, MP3-Player mit der SD-Karte, ein kleiner Rechner, Lautsprecher und Tasten.' },
          { kind: 'p', text: 'Wie eine gute Lötstelle aussieht: [Wackelkontakt und schlechte Lötstellen](#/hilfe/wackelkontakt).' },
          { kind: 'mehr', title: 'Extras und der Kartenleser' },
          {
            kind: 'list',
            items: [
              '**Extras** wie Drehregler, Leuchtring oder ein Dauerlicht für die Powerbank stehen unter dem Plan. Die passende Firmware für Drehregler, Poti, Leuchtring, leuchtende Tasten und Kopfhörer-Erkennung wählst du unter [Firmware aufspielen](#/werkstatt/firmware) bei den Extras. Für Nano Every und AiO+ gibt es sie dort nicht.',
              '**SO und SI vor dem Löten nachsehen:** Mit dem Durchgangsprüfer muss SO zum Beinchen D12 des Nano piepen und SI zu D11. Vertauscht, findet die Box den Kartenleser nicht.',
            ],
          },
        ],
      },
      {
        id: 'logbuch',
        title: 'Box-Logbuch und Box testen',
        summary: 'Frage die Box per USB, was sie tut: Firmware, Fehler, jede Taste und jede Karte.',
        keywords: ['log', 'konsole', 'serieller monitor', 'fehlermeldung', 'debug', 'forum', 'startet nicht', 'dfplayer', 'steckbrief', 'box testen'],
        blocks: [
          {
            kind: 'p',
            text: 'Verbinde die Box per USB, öffne das [Box-Logbuch](#/werkstatt/logbuch) und schalte die Box ein. Sie schreibt auf, welche Firmware läuft, ob Kartenleser und MP3-Player antworten und wie viele Dateien sie findet. Jede wichtige Zeile erkläre ich dir. Fürs Forum kopierst du das Logbuch in deinen Beitrag.',
          },
          { kind: 'mehr', title: 'Box testen: Schritt für Schritt', id: 'tasten-testen', keywords: ['gelötet', 'taste testen', 'tastentest', 'teile testen', 'tasten und teile', 'box testen'] },
          {
            kind: 'p',
            text: '[Box testen](#/werkstatt/testen) führt dich Schritt für Schritt durch deine Box: Verbinden, Tasten, Kartenleser, Ton, Kopfhörer, Extras wie LED-Ring, Lautstärke-Knopf oder Akku, und zum Schluss der Wackeltest. Die gezeichnete Box zeigt jedes Teil grün, wenn es geht, und rot bei einem Problem.',
          },
          {
            kind: 'list',
            items: [
              'Tut eine Taste nichts, tippe auf „Passiert nichts“. Sie wird rot, und du machst weiter.',
              'Ob Ton kommt und ob der LED-Ring leuchtet, meldet die Box nicht. Das frage ich dich. Die AiO meldet auch keine Tastendrücke, dort frage ich für jede Taste.',
              'Im Ergebnis steht bei jedem Problem, welche Lötstelle du prüfen sollst. Bei der Classic-Platine v1.7 ist sie im Lötplan rot umkreist. Wie du nachlötest: [Wackelkontakt und schlechte Lötstellen](#/hilfe/wackelkontakt).',
              'Ist alles angekommen, klopfe ich zweimal leise.',
              'Nur Tasten oder nur den Kartenleser testest du über die Reiter oben.',
            ],
          },
          { kind: 'mehr', title: 'Was die Meldungen der Box heißen' },
          {
            kind: 'list',
            items: [
              '**„Com to DFPlayer broken“:** Der MP3-Player antwortet nicht. Prüfe D2 und D3 am Nano und RX und TX am MP3-Player, und ob er richtig herum steckt.',
              '**„DfPl Err: 3“ oder „4“:** Übertragungsfehler. **„1“ oder „8“:** die SD-Karte.',
              '**„com to mfrc broken“:** Der Kartenleser antwortet nicht. Prüfe 3V3 und GND, dann SDA, SCK, SI, SO und RST.',
              '**„hpJackDetect: 1“ ohne Kopfhörer:** An D8 ist nichts angeschlossen, die Box schaltet den Lautsprecher stumm.',
            ],
          },
          {
            kind: 'bild',
            art: 'nano-pins',
            caption: 'Wo die Anschlüsse sitzen, die Box testen nennt: am Nano D9 bis D13 für den Kartenleser, A0 bis A2 für die Tasten, D2 und D3 für den MP3-Player. D2 geht an TX, D3 über den Widerstand mit 1\u00a0kΩ an RX.',
          },
        ],
      },
      {
        id: 'kartenleser-testen',
        title: 'Box testen: Kartenleser',
        summary: 'Erkennt die Box manche Karten nicht oder nur manchmal? Der Test zeigt, ob die Karte, die Kartensorte oder der Kartenleser schuld ist.',
        keywords: [
          'karten werden nicht gelesen',
          'karte wird nicht gelesen',
          'liest karten nicht',
          'liest keine karten',
          'kartenleser defekt',
          'kartenleser kaputt',
          'leser defekt',
          'leser tauschen',
          'rc522',
          'mfrc522',
          'nfc leser',
          'nfc-leser',
          'rfid leser',
          'rfid-leser',
          'manche karten gehen nicht',
          'manche karten',
          'einige karten',
          'nur manchmal',
          'karte nur manchmal erkannt',
          'karte wird nicht immer erkannt',
          'karte nicht immer erkannt',
          'karten werden nicht erkannt',
          'box erkennt karte nicht',
          'box erkennt keine karten',
          'karten funktionieren nicht',
          'karten gehen nicht',
          'lesegerät',
          'kartenlesegerät',
          'rfid',
          'antenne',
          'com to mfrc broken',
        ],
        blocks: [
          {
            kind: 'p',
            text: 'Verbinde die Box per USB und öffne [Box testen](#/werkstatt/kartenleser), Reiter „Kartenleser“. Lege jede Karte 5-mal auf und nimm sie wieder weg. Ich zähle mit und schreibe nichts auf die Karten.',
          },
          {
            kind: 'list',
            items: [
              '**Eine Karte klappt nicht:** Diese Karte ist kaputt oder passt nicht.',
              '**Nur eine Kartensorte klappt nicht:** [Welche Karten kaufen?](#/hilfe/kartentypen)',
              '**Mehrere klappen nur manchmal:** eher der [[Kartenleser]]. Lege die Karten mittig auf, nimm Metall weg, prüfe Kabel und 3,3\u00a0V. Hilft das nicht, tausche ihn aus.',
              '**„com to mfrc broken“:** Der Kartenleser antwortet gar nicht. Prüfe Kabel und 3,3\u00a0V.',
            ],
          },
          { kind: 'note', tone: 'info', text: 'Mit der AiO-Platine geht der Test nicht, mit der AiO+ schon.' },
          { kind: 'mehr', title: 'Im Test klappt es, im Alltag nur manchmal' },
          {
            kind: 'p',
            text: 'Teste mit kalter und mit warmer Box. Im Forum wurde bei solchen Aussetzern die Wärme vermutet, sicher ist das nicht. Geholfen hat dort, die Verstärkung des Kartenlesers zu senken, nicht zu erhöhen. Das geht nur mit einer selbst gebauten Firmware.',
          },
        ],
      },
      {
        id: 'box-nicht-gefunden',
        title: 'Die Box wird per USB nicht gefunden',
        summary: 'Firmware oder Box-Logbuch finden die Box nicht: meist das Kabel, ein anderes Programm oder ein Treiber.',
        keywords: ['usb', 'kabel', 'treiber', 'ch340', 'linux', 'dialout', 'brltty', 'port', 'anschluss', 'arduino ide', 'seriell', 'box wird nicht erkannt'],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Kabel:** Viele USB-Kabel laden nur. Probiere ein anderes, direkt am Computer, ohne Hub.',
              '**Andere Programme:** Die Arduino IDE, Cura oder ein zweiter Tab belegen den Anschluss. Schließe sie.',
              '**Browser:** USB geht nur in Chrome, Edge oder Firefox ab Version 151.',
              '**Treiber:** Viele Nano-Nachbauten und die AiO+ brauchen unter Windows einmal den Treiber für den Chip CH340.',
            ],
          },
          { kind: 'p', text: 'Schritt für Schritt für deinen Computer: [Box wird nicht erkannt?](#/werkstatt/usb)' },
          { kind: 'mehr', title: 'Unter Linux' },
          { kind: 'command', text: 'In der Desktop-App hilft „USB-Zugriff einrichten“. Sonst gibst du diesen Befehl im Terminal ein und meldest dich danach ab und wieder an:', command: 'sudo usermod -aG dialout $USER' },
          { kind: 'command', text: 'Unter Ubuntu belegt manchmal „brltty“ (für Braillezeilen) den Anschluss:', command: 'sudo apt remove brltty' },
        ],
      },
    ],
  },
  {
    id: 'app',
    title: 'App und Datenschutz',
    art: 'kat-app',
    summary: 'Was die App kann, Browser oder Desktop-App, was bei dir bleibt, wer dahintersteht und ein kleines Wörterbuch.',
    keywords: ['app', 'tonuino studio', 'anfangen', 'loslegen', 'impressum', 'about', 'wer'],
    sections: [
      {
        id: 'was-die-app-kann',
        title: 'Was TonUINO Studio kann',
        summary: 'Ein Überblick: Meine Box, Hinzufügen, Sticker, Karten und Werkstatt.',
        keywords: ['überblick', 'funktionen', 'erste schritte', 'start', 'einstieg'],
        blocks: [
          {
            kind: 'list',
            items: [
              '**Meine Box** zeigt die SD-Karte mit Namen und Bildern und repariert Fehler.',
              '**Hinzufügen** bringt Hörspiele und Musik auf die Karte, nummeriert, wandelt um und teilt lange Dateien.',
              ...(__SOURCES_ENABLED__
                ? ['**Entdecken** zeigt freie Hörspiele und Lieder: [Freie Inhalte entdecken](#/hilfe/entdecken).']
                : []),
              '**Sticker drucken** passt zu vielen Etikettenbögen.',
              '**Karten beschreiben** an der Box, mit dem Handy, dem NFC-Leser oder über WLAN.',
              '**Werkstatt**: Firmware, Einstellungen, Tests, Ansagen und die Bedienkarte zum Ausdrucken.',
            ],
          },
          {
            kind: 'p',
            text: 'TonUINO Studio ist ein unabhängiges Projekt und nicht das offizielle TonUINO-Projekt: [Über TonUINO Studio](#/hilfe/ueber).',
          },
          // The texts of the settings page itself (src/features/settings/options.ts) are not searched.
          {
            kind: 'mehr',
            title: 'Die App einstellen',
            id: 'app-einstellen',
            keywords: ['dunkel', 'dunkelmodus', 'dark mode', 'nachtmodus', 'hell', 'darstellung', 'farben', 'pling', 'töne', 'ton', 'klack', 'klopfen', 'geräusch', 'qualität', 'kbit'],
          },
          {
            kind: 'p',
            text: 'Unter [Einstellungen](#/einstellungen) wählst du Hell, Dunkel oder Automatisch, schaltest die Töne aus und stellst unter „Für Bastler“ die Qualität beim Umwandeln ein. Diese Töne mache ich:',
          },
          {
            kind: 'list',
            items: [
              '**Pling:** nur, wenn die SD-Karte wirklich fertig ist. In Firefox und Safari erst, wenn du das Paket auf der Karte geprüft hast. Hat deine SD-Karte den kurzen Ton der Box, klingt es wie deine Box. Ich spiele ihn direkt von deiner Karte und bringe ihn nicht mit.',
              '**Klack:** wenn der NFC-Leser eine Karte fertig beschrieben hat.',
              '**Zweimal Klopfen:** wenn in „Box testen“ alles angekommen ist.',
            ],
          },
        ],
      },
      {
        // The extras of the settings page (SETTINGS_SECTIONS "zusatzfunktionen"); each part is a place of its own in the search.
        id: 'zusatzfunktionen',
        title: 'Zusatzfunktionen',
        summary: 'Seltene Werkzeuge anderer TonUINO-Programme: Titel zusammenfügen, Anfang und Ende abschneiden, Hörspiele in Mono, mehr als 99 Hörspiele, Sticker-Rückseiten, Titelansagen, selbst aufnehmen.',
        keywords: ['extras', 'zusatz', 'werkzeuge', 'toolbox', 'einschalten', 'freischalten', 'experte'],
        blocks: [
          {
            kind: 'p',
            text: `Unter ${SETTINGS} schaltest du ganz unten bei „Zusatzfunktionen“ ein, was du brauchst. Ausgeschaltet zeige ich davon nichts, so bleiben die Seiten aufgeräumt.`,
          },
          { kind: 'mehr', title: 'Titel zusammenfügen', id: 'titel-zusammenfuegen', keywords: ['zusammenfügen', 'verbinden', 'mergen', 'kapitel', 'folge', 'eine karte pro folge', '99 ordner', 'aneinanderhängen', 'join'] },
          {
            kind: 'p',
            text: 'Auf der Seite eines Ordners tippst du auf „Zusammenfügen …“, wählst die Titel und bestätigst. Der neue Titel steht an der Stelle des ersten, die Titel danach rücken nach vorn. So wird aus vielen Kapiteln eine Folge, und eine Karte „Einzeltitel“ spielt genau diese Folge.',
          },
          {
            kind: 'p',
            text: 'MP3-Dateien im gleichen Format füge ich ohne Umwandeln aneinander, ohne hörbare Naht. Sonst wandle ich die Titel zusammen neu um. Die alten Titel lösche ich erst, wenn der neue fertig auf der Karte ist.',
          },
          { kind: 'mehr', title: 'Anfang und Ende abschneiden', id: 'anfang-abschneiden', keywords: ['abschneiden', 'kürzen', 'trimmen', 'intro', 'vorspann', 'abspann', 'titelmusik', 'titellied', 'ansage', 'schneiden'] },
          {
            kind: 'p',
            text: 'Im Menü „…“ eines Titels wählst du „Anfang/Ende abschneiden …“. Du gibst die Sekunden ein, hörst den neuen Anfang zur Probe an und schneidest auf Wunsch alle Titel des Ordners gleich, etwa die Titelmusik vor jeder Folge.',
          },
          {
            kind: 'p',
            text: 'MP3-Dateien schneide ich ohne Umwandeln, am Ton ändert sich nichts. Was abgeschnitten ist, ist von der Karte weg.',
          },
          { kind: 'mehr', title: 'Hörspiele in Mono speichern', id: 'mono-speichern', keywords: ['mono', 'stereo', 'platz sparen', 'kleiner', 'halb so groß', 'speicherplatz', 'dateigröße'] },
          {
            kind: 'p',
            text: 'Hörspiele und Hörbücher, die ich beim Hinzufügen umwandle, speichere ich dann in Mono mit halb so vielen Daten. Bei Sprache hörst du an der Box keinen Unterschied. MP3-Dateien kopiere ich wie bisher, Musik bleibt in Stereo.',
          },
          {
            kind: 'mehr',
            title: 'Mehr als 99 Hörspiele',
            id: 'mehr-als-99',
            keywords: ['mehr als 99', '99 hörspiele', 'ordner voll', 'alle ordner belegt', 'folgen in einem ordner', 'mehrere hörspiele in einem ordner', 'von bis', 'von-bis', 'teil eines ordners', 'sammlung', 'anhängen', '255 titel'],
          },
          {
            kind: 'p',
            text: 'Die Box spielt nur 99 Ordner. Für mehr Hörspiele kommen mehrere Folgen hintereinander in einen Ordner, und jede Folge bekommt eine Karte „von Titel … bis …“. Beim Hinzufügen wählst du „In einen vorhandenen Ordner hinten anhängen“ und den Ordner. Die Titel, die schon drin sind, behalten ihre Nummern, fertige Karten bleiben also richtig.',
          },
          {
            kind: 'p',
            text: 'Auf der Seite des Ordners zeigt „Folgen in diesem Ordner“, von welchem bis zu welchem Titel jede Folge geht. Ich erkenne das an den Alben, aus denen die Titel kamen; du kannst Namen und Grenzen ändern. „Karten für alle Folgen“ setzt eine Karte pro Folge auf die Liste zum Beschreiben, mit einem eigenen Sticker für jede Folge.',
          },
          {
            kind: 'p',
            text: 'Ein Ordner fasst höchstens 255 Titel. Mehr spielt die Box nicht ab, und auf einer Karte ist keine höhere Nummer möglich. Ich warne dich, sobald weniger als 25 Plätze frei sind. Hat eine Folge viele kurze Kapitel, füge sie vorher mit „Titel zusammenfügen“ zusammen.',
          },
          { kind: 'mehr', title: 'Sticker mit Rückseite', id: 'sticker-rueckseite', keywords: ['rückseite', 'beidseitig', 'duplex', 'titelliste', 'tracklist', 'inhalt', 'qr-code', 'rückseite drucken', 'zweiseitig'] },
          {
            kind: 'p',
            text: 'Unter „Sticker drucken“ wählst du bei „Mehr …“ eine Rückseite: die Titelliste mit Nummern und Namen oder einen QR-Code, der die Liste auf dem Handy zeigt. Zu lange Namen kürze ich, bei sehr vielen Titeln stehen die ersten da und wie viele noch folgen.',
          },
          {
            kind: 'p',
            text: 'Im PDF folgt auf jeden Bogen der Bogen mit den Rückseiten, spiegelverkehrt angeordnet. Stelle im Druckdialog „Beidseitig“ mit Wenden an der langen Kante ein (oft „Lange Kante“ oder „Bindung lange Seite“). Druckt dein Drucker nicht beidseitig, drucke erst die ungeraden Seiten, lege das Papier gewendet wieder ein und drucke die geraden. Probiere es erst mit einem Bogen Normalpapier gegen das Licht.',
          },
          {
            kind: 'mehr',
            // Not "Titelansagen" as the title: a search for "Ansagen" means the box's own sentences first.
            title: 'Ansage vor jedem Titel',
            id: 'titelansagen',
            keywords: ['titelansagen', 'ansage vor jedem titel', 'vorlesen lassen', 'sprachausgabe', 'text to speech', 'tts', 'stimme', 'kann nicht lesen', 'espeak', 'sapi', 'ansage-skript'],
          },
          {
            kind: 'p',
            text: 'Vor jedem Titel sagt eine Stimme seinen Namen, so finden Kinder, die noch nicht lesen können, ihr Lied oder Kapitel. Auf der Seite eines Ordners wählst du im Menü „…“ „Titelansagen hinzufügen …“ und hörst eine Ansage zur Probe. Beim Hinzufügen setzt du bei einem Album den Haken „Titel ansagen“.',
          },
          {
            kind: 'p',
            text: 'Die Ansage steckt am Anfang jeder MP3-Datei. Die Box hat dafür keine eigene Funktion: Sie sagt nur Nummern an. So geht es mit jeder Box und ohne andere Firmware, und Karten wie „Einzeltitel“ spielen weiter den richtigen Titel. Die Titel selbst wandle ich dabei nicht um.',
          },
          {
            kind: 'p',
            text: 'Es spricht die Stimme, die dein Computer schon hat, ohne Internet und ohne Anmeldung: unter Windows die Sprachausgabe von Windows, unter Linux espeak-ng, espeak oder pico2wave. Fehlt sie, installierst du unter Linux zum Beispiel das Paket „espeak-ng“, unter Windows unter Einstellungen › Zeit und Sprache › Sprache eine deutsche Sprachausgabe. Das geht nur in der Desktop-App: Der Browser kann eine Stimme nicht in eine Datei sprechen lassen.',
          },
          {
            kind: 'p',
            text: '„Titelansagen entfernen …“ im selben Menü schneidet die Ansagen wieder ab, genau dort, wo der Titel anfängt. Hast du einen Titel danach gekürzt oder zusammengefügt, lass ich ihn, wie er ist. Bilder in den Dateien fallen beim Ansagen weg, das Cover für die Sticker bleibt.',
          },
          {
            kind: 'mehr',
            title: 'Selbst aufnehmen',
            id: 'selbst-aufnehmen',
            keywords: ['aufnehmen', 'aufnahme', 'mikrofon', 'vorlesen', 'oma liest vor', 'eigene stimme', 'eigene ansagen', 'sprachnachricht', 'record'],
          },
          {
            kind: 'p',
            text: 'Auf der Seite eines Ordners wählst du im Menü „…“ „Aufnehmen …“. Unter „Hinzufügen“ steht immer „Selbst aufnehmen“, in der Android-App hat „Aufnehmen“ einen eigenen Reiter. Das Menü im Ordner schaltest du in den Einstellungen unter „Zusatzfunktionen“ ein. Die Anzeige zeigt, wie laut es ankommt. Danach hörst du dir die Aufnahme an, nimmst sie bei Bedarf noch einmal auf und gibst ihr einen Namen.',
          },
          {
            kind: 'p',
            text: 'Die Aufnahme kommt wie eine Datei von deinem Computer auf die SD-Karte. Ich wandle sie in MP3 um und gleiche die Lautstärke an. Aufnehmen geht in der Desktop-App, in der Android-App und in Chrome und Edge. In der Android-App ist es immer eingeschaltet. Fragt der Browser oder das Handy, ob ich das Mikrofon benutzen darf, erlaube es.',
          },
        ],
      },
      {
        // BoxPage links here ("Welche Möglichkeiten habe ich?") when the browser cannot open drives.
        id: 'browser',
        title: 'Web-App oder Desktop-App?',
        summary: 'Beide können fast alles. Was nur in Chrome und Edge geht und was nur in der Desktop-App.',
        keywords: ['chrome', 'edge', 'firefox', 'safari', 'mac', 'windows', 'linux', 'installieren', 'programm', 'welcher browser', 'handy', 'tablet', 'ipad', 'iphone', 'smartphone', 'android'],
        blocks: [
          {
            kind: 'list',
            items: [
              '**Chrome und Edge:** ohne Installation. Ich schreibe direkt auf die SD-Karte und spreche über USB mit der Box.',
              '**Firefox und Safari:** Ich darf nicht auf die Karte schreiben und packe alles Neue in ein Paket, mehr unter [Ein Paket auf die Karte bringen](#/hilfe/paket). USB geht in Firefox ab Version 151, in Safari nicht.',
              '**Desktop-App für Windows und Linux:** findet die Karte selbst, wirft sie aus und prüft das Format. Nur mit ihr gehen NFC-Leser und Boxen mit WLAN. Warnt Windows beim Installieren: [Die App installieren und starten](#/hilfe/installieren).',
              '**Android-Handy und -Tablet:** mit der Android-App. Sie beschreibt Karten über NFC, nimmt mit dem Mikrofon auf und liest die SD-Karte über einen SD-Kartenleser am USB-Anschluss. Im Browser am Handy geht es nicht, am iPhone und iPad auch nicht.',
            ],
          },
          // Only in a web build given a download address (desktopapp.ts).
          ...(DESKTOP_DOWNLOAD_URL ? [{ kind: 'links' as const, links: [{ label: 'Desktop-App herunterladen', href: DESKTOP_DOWNLOAD_URL }] }] : []),
          { kind: 'note', tone: 'info', text: 'Am Mac nimmst du die Web-App, am besten in Chrome oder Edge.' },
          { kind: 'mehr', title: 'Firefox und Safari: Was ist anders?', id: 'browser-kann-das-nicht', keywords: ['firefox', 'safari', 'nicht unterstützt', 'geht nicht im browser', 'web-app', 'paket', 'ffmpeg', 'm4a'] },
          {
            kind: 'list',
            items: [
              '**Firefox fragt nach einem Add-on**, wenn er zum ersten Mal USB nutzt. Das erzeugt Firefox selbst: [Box wird nicht erkannt?](#/werkstatt/usb)',
              '**M4A und AAC unter Linux:** Firefox braucht „ffmpeg“ vom System.',
              '**Sehr lange Dateien** in seltenen Formaten öffnen ältere Browser nur bis 45\u00a0Minuten.',
              '**Auswerfen** geht im Browser nicht. Die Anleitung zum Paket sagt dir, wie.',
            ],
          },
        ],
      },
      {
        // TODO 0.3 #59/#60, research in recherche/plattform-probleme-0.5.md: what stops other TonUINO programs on
        // Windows, Linux and Android before they even run. The installer's WebView2 check: src-tauri/windows/installer-hooks.nsh.
        id: 'installieren',
        title: 'Die App installieren und starten',
        summary: 'Windows warnt, der Virenscanner schlägt an, die App startet nicht oder bleibt weiß: was unter Windows, Linux und Android hilft.',
        keywords: [
          'installieren',
          'installation',
          'setup',
          'smartscreen',
          'windows hat den pc geschützt',
          'trotzdem ausführen',
          'virenscanner',
          'virus',
          'fehlalarm',
          'webview2',
          'appimage',
          'fuse',
          'libfuse2',
          'deb',
          'glibc',
          'startet nicht',
          'weißes fenster',
          'nvidia',
          'apk',
          'energiesparen',
        ],
        blocks: [
          {
            kind: 'checks',
            items: [
              '**Windows: „Der Computer wurde durch Windows geschützt“:** Klicke auf „Weitere Informationen“ und dann auf „Trotzdem ausführen“. Die App hat keine bezahlte Unterschrift von Microsoft, darum kennt Windows sie noch nicht.',
              '**Der Virenscanner schlägt Alarm:** Neue Programme ohne Unterschrift halten manche Virenscanner für verdächtig. Lade die App nur von der Seite, die du kennst, und melde den Fehlalarm deinem Virenscanner. Abschalten musst du ihn nicht.',
              '**Windows 10 fragt nach WebView2:** Das Setup öffnet dann die Seite von Microsoft. Installiere WebView2 dort und starte das Setup noch einmal.',
              '**Linux: Die App startet nicht oder bleibt weiß:** Lies unten bei „Unter Linux“ weiter.',
              '**Das Android-Handy blockiert die Installation:** Lies unten bei „Die APK-Datei installieren“ weiter.',
            ],
          },
          { kind: 'mehr', title: 'Unter Linux', id: 'linux-installieren', keywords: ['ubuntu', 'linux mint', 'fedora', 'arch', 'tuxedo', 'debian', 'libfuse2t64', 'fuse-libs', 'dmabuf', 'grafikkarte'] },
          {
            kind: 'p',
            text: 'Das .deb-Paket ist für Ubuntu, Linux Mint, Tuxedo OS und Debian. Es richtet den USB-Zugriff für die Box gleich mit ein. Die AppImage-Datei läuft auch auf Fedora und Arch: Mache sie vorher in ihren Eigenschaften ausführbar.',
          },
          {
            kind: 'p',
            text: 'Beide brauchen ein aktuelles System: Ubuntu 24.04, Linux Mint 22, Debian 13, Fedora 40 oder neuer. Auf Ubuntu 22.04 und Linux Mint 21 startet die App nicht. Nimm dort die Web-App in Chrome.',
          },
          { kind: 'command', text: 'Startet die AppImage-Datei gar nicht, fehlt meist „FUSE“. Unter Ubuntu 24.04 und Linux Mint 22:', command: 'sudo apt install libfuse2t64' },
          { kind: 'p', text: 'Unter Fedora heißt das Paket „fuse-libs“, unter Arch „fuse2“.' },
          {
            kind: 'command',
            // Tauri's Linux graphics page: WebKitGTK's DMA-BUF renderer and Nvidia drivers.
            text: 'Bleibt das Fenster weiß oder leer, oft mit einer Grafikkarte von Nvidia, starte die App einmal so im Terminal. Beim AppImage schreibst du statt „tonuino-studio“ den Pfad zur Datei:',
            command: 'WEBKIT_DISABLE_DMABUF_RENDERER=1 tonuino-studio',
          },
          { kind: 'mehr', title: 'Die APK-Datei installieren', id: 'android-installieren', keywords: ['unbekannte apps', 'play protect', 'nfc einschalten', 'hülle', 'akku', 'otg'] },
          {
            kind: 'steps',
            items: [
              'Lade die APK-Datei auf dem Handy herunter und tippe sie an. Im Play Store gibt es die App nicht.',
              'Fragt das Handy, ob diese Quelle Apps installieren darf, erlaube es in den Einstellungen und gehe zurück.',
              'Warnt Google Play Protect vor einer unbekannten App, tippe auf „Weitere Details“ und „Trotzdem installieren“.',
              'Eine neue Version installierst du genauso über die alte. Deine Einstellungen bleiben.',
            ],
          },
          {
            kind: 'list',
            items: [
              '**NFC:** Schalte NFC in den Schnelleinstellungen ein. Halte die Karte flach an die Rückseite, meist in die Mitte oder oben bei der Kamera. Dicke Hüllen, Metallplatten für Magnethalter und Bankkarten in der Hülle stören.',
              '**Karten:** Manche Handys können MIFARE-Classic-Karten nicht beschreiben. NTAG213 und NTAG215 gehen mit jedem Handy: [Welche Karten kaufen?](#/hilfe/kartentypen)',
              '**SD-Karte:** Stecke sie in einen SD-Kartenleser mit USB-C-Stecker oder mit OTG-Adapter. Manche Handys brauchen dafür den Schalter „OTG“ in den Einstellungen.',
              '**Lange Kopieren:** Lasse die App vorne, solange ich schreibe. Wenn das Handy es erlaubt, lasse ich den Bildschirm so lange an. Ein strenger Energiesparmodus kann die App sonst beenden.',
            ],
          },
        ],
      },
      {
        // Every network use of the app, checked against the code: cover search (src/core/stickers/coversearch.ts),
        // ready-made firmware (src/core/firmware/flash.ts), sounds (src/core/tonuino/soundsinstall.ts), "Entdecken"
        // (src/core/sources/load.ts, download.ts, src/features/sources/Preview.tsx), boxes over Wi-Fi (src-tauri/src/http.rs, home network only) and the
        // licence texts (src/features/help/licensefile.ts). A new one needs a line here.
        id: 'datenschutz',
        title: 'Datenschutz: Was bleibt bei dir?',
        summary: 'Kein Konto, keine Anmeldung: was auf deinem Computer bleibt und wann die App ins Internet geht.',
        keywords: ['daten', 'privatsphäre', 'internet', 'online', 'offline', 'tracking', 'cookies', 'speichern', 'ip-adresse', 'verbindung', 'hochladen', 'senden'],
        blocks: [
          {
            kind: 'p',
            text: 'TonUINO Studio arbeitet auf deinem Computer. Es gibt kein Konto und keine Anmeldung. Deine Hörspiele, Bilder und Karten lädt die App nirgendwo hoch.',
          },
          { kind: 'h3', text: 'Was auf deinem Computer bleibt' },
          {
            kind: 'list',
            items: [
              'deine Einstellungen, wie deine Sticker aussehen sollen, ein eigenes Sticker-Logo und die Korrektur für deinen Drucker,',
              'eine Kopie der Namen und Titel jeder SD-Karte. Damit stellt die App sie wieder her, falls die Datei auf der Karte verloren geht,',
              ...(__SOURCES_ENABLED__ ? [PRIVACY_LOCAL] : []),
              'in der Web-App der Zugriff auf die letzten fünf SD-Karten, damit du sie nicht jedes Mal neu auswählen musst,',
              'in Firefox und Safari die Dateien, die auf ein Paket warten, im Speicher des Browsers. Ich lösche sie, wenn du die Karte neu einliest oder geprüft hast. Sonst lösche ich sie nach zwei Tagen, aber erst, wenn der Tab mit der App zu ist.',
            ],
          },
          { kind: 'p', text: 'Beim Einlesen und Packen bleibt alles auf deinem Computer.' },
          { kind: 'h3', text: 'Wann die App ins Internet geht' },
          { kind: 'p', text: 'Nur in diesen Fällen, und bis auf die Cover fürs Regal immer erst, wenn du selbst etwas öffnest oder startest:' },
          {
            kind: 'list',
            items: [
              '**Cover-Suche:** Öffnest du „Cover auswählen“, sucht die App gleich bei iTunes (Apple) und MusicBrainz, mit dem Namen des Hörspiels und, wenn bekannt, dem Interpreten. Die Bilder kommen von dort und vom Cover Art Archive. Diese Dienste sehen dabei den Suchbegriff und deine IP-Adresse.',
              '**Titelnamen:** Erst wenn du in einem Ordner auf „Im Internet suchen“ klickst, schickt die App den Namen des Ordners und, wenn bekannt, den Interpreten an iTunes (Apple) und MusicBrainz und lädt von dort die Titelliste des Albums. Diese Dienste sehen dabei den Namen und deine IP-Adresse.',
              `**Cover fürs Regal:** Fehlt einem Ordner das Cover und nennt sein Name ein Hörspiel oder Album genau, sucht die App nach dem Einlesen von selbst danach, bei iTunes (Apple) und MusicBrainz, einen Ordner nach dem anderen. Das Bild lädt sie von dort oder vom Cover Art Archive, es bleibt auf diesem Computer, bis du es übernimmst. Diese Dienste sehen dabei den Namen und deine IP-Adresse. Ganz aus schaltest du das unter ${SETTINGS} mit „Fehlende Cover selbst suchen“; für einen einzelnen Ordner stellst du auf seiner Seite „Im Regal“ auf „Sticker“.`,
              '**Cover für viele Ordner:** Erst wenn du unter „Cover suchen“ auf „Suche starten“ klickst, schickt die App die Namen der Ordner in der Liste an iTunes (Apple) und MusicBrainz, einen nach dem anderen. Die Vorschaubilder und die gewählten Bilder lädt sie von dort und vom Cover Art Archive. Diese Dienste sehen dabei die Namen und deine IP-Adresse.',
              '**Piktogramme:** Erst wenn du beim Sticker-Stil „Bildkarte“ unter „Piktogramm suchen“ auf „Suchen“ klickst, schickt die App dein Suchwort an ARASAAC (api.arasaac.org, Regierung von Aragón, Spanien) und zeigt die Vorschaubilder von dort. Wählst du eins, lädt sie dieses Bild einmal und behält es auf diesem Gerät; zum Drucken geht sie nicht wieder ins Internet. ARASAAC sieht dabei das Suchwort und deine IP-Adresse.',
              '**Firmware:** Wählst du in der Werkstatt die fertige Firmware, lädt die App sie von der Seite des Projekts TonUINO TNG (tonuino.github.io). Die Seite liegt bei GitHub, das dabei deine IP-Adresse sieht.',
              '**Systemansagen:** Lädst du die Ansagen herunter, holt die App sie ebenfalls von tonuino.github.io.',
              ...(__SOURCES_ENABLED__ ? [(__DESKTOP_BUILD__ && __LOCAL_SOURCES__ ? PRIVACY_ONLINE_LOCAL : BUNDLED_ONLY ? PRIVACY_ONLINE_BUNDLED : PRIVACY_ONLINE) + (CAN_REPORT ? PRIVACY_REPORT : '')] : []),
              ...(UPDATE_CHECK
                ? [
                    `**Neue Versionen:** Nur wenn du unter ${SETTINGS} „Auf neue Versionen hinweisen“ einschaltest, fragt die Desktop-App höchstens einmal am Tag bei ${releasesHost(RELEASES_URL)} nach, ob es eine neue Version gibt. Der Server sieht dabei deine IP-Adresse. Ab Werk ist das aus.`,
                  ]
                : []),
              '**Links** zu Apps, Downloads, zum Forum oder zu Lizenzen öffnen sich in deinem Browser.',
            ],
          },
          {
            kind: 'p',
            text: 'Die Web-App selbst lädt dein Browser beim Öffnen von ihrer Webseite, die Lizenztexte erst, wenn du sie ansiehst. Schriften und Symbole sind in der App enthalten, dafür lädt sie nichts nach. Mit Boxen über WLAN spricht die Desktop-App nur in deinem Heimnetz.',
          },
          { kind: 'h3', text: 'Was die App nicht verschickt' },
          {
            kind: 'p',
            text: 'Was auf deiner SD-Karte ist, schickt die App nirgendwohin: keine Hörspiele und keine Musik, keine Liste deiner Ordner und Titel, keine Cover, Fotos oder Sticker und nichts über deine Karten. Nur bei der Suche nach Covern, Titelnamen und Piktogrammen geht ein Suchbegriff hinaus, meist der Name des Hörspiels oder ein Wort.',
          },
          {
            kind: 'p',
            text: `Sonst schickt die App nichts ins Internet. Es gibt keine Werbung und keine Statistik über dich. Die Desktop-App sucht ${UPDATE_CHECK ? 'nur dann nach neuen Versionen, wenn du es einschaltest' : 'auch nicht von selbst nach neuen Versionen'}.`,
          },
          {
            kind: 'p',
            text: `**Gemerkte Boxen:** Schaltest du unter ${SETTINGS} „Boxen auf diesem Gerät merken“ ein, behält die App von jeder Box, die du öffnest, Ordnernummern, Namen, Titel, wie die Karten spielen, und kleine Cover. So zeigt „Meine Box“ sie auch ohne SD-Karte. Das bleibt auf diesem Gerät, Hörspiele und Musik merkt sie sich nicht. Mit „Gemerkte Box vergessen“ löschst du es dort wieder.`,
          },
        ],
      },
      {
        id: 'ueber',
        title: 'Über TonUINO Studio',
        summary: 'Ein unabhängiges Projekt: wer dahintersteht, Dank, Lizenz und die Bausteine anderer Projekte.',
        keywords: ['offiziell', 'tonuino-team', 'kontakt', 'support', 'version', 'unabhängig'],
        blocks: [
          {
            kind: 'p',
            text: 'TonUINO Studio ist ein unabhängiges Projekt für Familien mit einer TonUINO-Box. Es ist nicht das offizielle TonUINO-Projekt, und das TonUINO-Team betreut es nicht. Fragen zur Box, zum Bauen und zur Firmware beantworten die Leute im TonUINO-Forum.',
          },
          { kind: 'version' },
          { kind: 'links', links: [{ label: 'TonUINO-Forum', href: 'https://discourse.voss.earth' }] },
          { kind: 'mehr', title: 'Danke', id: 'dank', keywords: ['credits', 'thorsten voß', 'boerge1', 'tng', 'community', 'arasaac', 'sergio palao', 'piktogramme'] },
          {
            kind: 'list',
            items: [
              '**TonUINO** hat Thorsten Voß ins Leben gerufen. Im TonUINO-Forum helfen sich viele Menschen gegenseitig, und viele Hinweise hier stammen von dort. Das TonUINO-Logo auf den Stickern ist mit seiner Erlaubnis dabei.',
              '**TonUINO TNG** entwickelt Boerge1 weiter, mit Jana/Gute_Laune, NoBl, kobayashi_maru, Thomas Lehnert und Thorsten von den Leiterkartenpiraten (LKP).',
              '**TonUINO NFC Tools** von marc schreibt Karten über einen QR-Code.',
              '**Piktogramme** für Bildkarten kommen von ARASAAC. Die Piktogramme sind Eigentum der Regierung von Aragón. Sergio Palao hat sie für ARASAAC (arasaac.org) gezeichnet, das sie unter der Lizenz Creative Commons BY-NC-SA 4.0 verteilt.',
            ],
          },
          {
            kind: 'links',
            links: [
              { label: 'TonUINO', href: 'https://www.tonuino.de' },
              { label: 'TonUINO TNG', href: 'https://github.com/tonuino/TonUINO-TNG' },
              forumButton(5972, 'Werkzeuge der Community'),
              { label: 'ARASAAC', href: 'https://arasaac.org' },
            ],
          },
          { kind: 'mehr', title: 'Lizenz', id: 'lizenz', keywords: ['gpl', 'open source', 'freie software', 'quelltext'] },
          {
            kind: 'p',
            text: 'TonUINO Studio ist freie Software unter der GNU General Public License, Version 3 oder später (GPL-3.0-or-later). Du darfst sie nutzen, weitergeben und verändern, Veränderungen unter derselben Lizenz. Sie kommt ohne Gewähr: Sichere wichtige Dateien, bevor du eine Karte reparierst.',
          },
          { kind: 'links', links: [{ label: 'Text der GPL 3.0', href: 'https://www.gnu.org/licenses/gpl-3.0.html' }] },
          { kind: 'mehr', title: 'Bausteine anderer Projekte', id: 'bausteine', keywords: ['lizenzen', 'drittanbieter', 'open source', 'schriften', 'bibliotheken', 'pakete', 'mit', 'ofl'] },
          { kind: 'p', text: 'Freie Bausteine anderer Projekte, mit Lizenz und Rechteinhabern:' },
          { kind: 'notices' },
        ],
      },
      {
        id: 'woerterbuch',
        title: 'Wörterbuch',
        summary: 'Fremde Wörter rund um die Box, kurz erklärt: TNG, DFPlayer, AiO, Admin-Menü und mehr.',
        keywords: ['glossar', 'begriffe', 'wörter', 'fachwörter', 'abkürzungen', 'was ist', 'was heißt', 'bedeutung'],
        blocks: [
          {
            kind: 'p',
            text: 'Die Wörter aus der App und dem TonUINO-Forum. Auf den Hilfeseiten sind sie gepunktet unterstrichen: Tippe darauf, dann steht die Erklärung da.',
          },
          { kind: 'glossary' },
        ],
      },
    ],
  },
];

/**
 * Other words for pages, and the ids of pages that were merged into others,
 * so that guessed or older links (#/hilfe/faq, #/hilfe/acr122u,
 * #/hilfe/box-geht-nicht-aus) still land in the right place. They must not
 * collide with real ids; the test checks that.
 */
export const HELP_ALIASES: Readonly<Record<string, string>> = {
  // Pages of 0.2 that live on in other pages.
  'erste-schritte': 'was-die-app-kann',
  'sd-karte-waehlen': 'album-hinzufuegen',
  ansagen: 'keine-ansagen',
  usb: 'box-nicht-gefunden',
  'box-geht-nicht-aus': 'box-geht-aus',
  'sticker-gestalten': 'sticker',
  unabhaengig: 'ueber',
  // Other words.
  start: 'was-die-app-kann',
  einstieg: 'was-die-app-kann',
  'web-app': 'browser',
  webapp: 'browser',
  'desktop-app': 'browser',
  desktop: 'browser',
  chrome: 'browser',
  edge: 'browser',
  firefox: 'browser-kann-das-nicht',
  safari: 'browser-kann-das-nicht',
  zip: 'paket',
  entpacken: 'paket',
  'sd-karte': 'album-hinzufuegen',
  sd: 'album-hinzufuegen',
  einrichten: 'neue-sd-karte',
  auswerfen: 'sicher-entfernen',
  hinzufuegen: 'album-hinzufuegen',
  'musik-hinzufuegen': 'album-hinzufuegen',
  formate: 'dateiformate',
  format: 'dateiformate',
  umwandeln: 'dateiformate',
  bitrate: 'dateiformate',
  lautheit: 'lautstaerke',
  teilen: 'lange-dateien',
  kapitel: 'lange-dateien',
  'cover-suche': 'cover',
  covers: 'cover',
  'cover-automatisch': 'cover-finden',
  'fehlende-cover': 'cover-finden',
  sortieren: 'reihenfolge',
  limits: 'grenzen',
  tags: 'dateinamen',
  'karten-beschreiben': 'vier-wege',
  modi: 'wiedergabearten',
  modus: 'wiedergabearten',
  admin: 'an-der-box',
  'admin-menue': 'an-der-box',
  qr: 'handy',
  'qr-code': 'handy',
  android: 'handy',
  acr122u: 'kartenleser',
  leser: 'kartenleser',
  esp32: 'wlan',
  wifi: 'wlan',
  tng: 'tng-oder-2-1',
  'firmware-version': 'tng-oder-2-1',
  modifikationskarten: 'spezialkarten',
  rfid: 'kartentypen',
  nfc: 'kartentypen',
  stickers: 'sticker',
  etiketten: 'papier',
  herma: 'papier',
  'drucker-ausrichten': 'drucken',
  kalibrieren: 'drucken',
  'firmware-aufspielen': 'firmware',
  update: 'firmware',
  log: 'logbuch',
  'box-logbuch': 'logbuch',
  konsole: 'logbuch',
  'box-testen': 'logbuch',
  systemansagen: 'keine-ansagen',
  treiber: 'box-nicht-gefunden',
  ch340: 'box-nicht-gefunden',
  seriell: 'box-nicht-gefunden',
  faq: 'probleme',
  fehler: 'probleme',
  stumm: 'box-bleibt-stumm',
  'kein-ton': 'box-bleibt-stumm',
  knacken: 'stoergeraeusche',
  knattern: 'stoergeraeusche',
  tackern: 'stoergeraeusche',
  rauschen: 'stoergeraeusche',
  brummen: 'stoergeraeusche',
  loeten: 'wackelkontakt',
  wackler: 'wackelkontakt',
  loetstelle: 'wackelkontakt',
  'kalte-loetstelle': 'wackelkontakt',
  uebersteuern: 'kratzig',
  verzerrt: 'kratzig',
  dfplayer: 'nachbau-chip',
  klon: 'nachbau-chip',
  mh2024k: 'nachbau-chip',
  'ueber-tonuino-studio': 'ueber',
  credits: 'dank',
  privatsphaere: 'datenschutz',
  internet: 'datenschutz',
  spotify: 'cd-und-streaming',
  streaming: 'cd-und-streaming',
  cd: 'cd-und-streaming',
  audible: 'cd-und-streaming',
  glossar: 'woerterbuch',
  begriffe: 'woerterbuch',
  ...(__SOURCES_ENABLED__ ? { 'freie-hoerspiele': 'entdecken' } : {}),
  gpl: 'lizenz',
  lizenzen: 'bausteine',
  drittanbieter: 'bausteine',
  'open-source': 'bausteine',
};

/* ------------------------------------------------------------------ lookup */

/** What #/hilfe/<id> shows: the start page, a topic, a page (opened at one of its parts) or "not found". */
export type HelpTarget =
  | { kind: 'index' }
  | { kind: 'topic'; topic: HelpTopic; section?: HelpSection; part?: HelpPart }
  | { kind: 'missing'; id: string };

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** "Lautstärke" or "lautstaerke " → "lautstaerke", the form ids have. */
export function normalizeHelpId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUTS[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export function helpHref(id: string): string {
  return `#/hilfe/${id}`;
}

export function findTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((t) => t.id === id);
}

/** The page with this id and its topic, or the page that holds the part with this id. */
export function findSection(id: string): { topic: HelpTopic; section: HelpSection; part?: HelpPart } | undefined {
  for (const topic of HELP_TOPICS) {
    for (const section of topic.sections) {
      if (section.id === id) return { topic, section };
      const part = sectionParts(section).parts.find((p) => p.id === id);
      if (part) return { topic, section, part };
    }
  }
  return undefined;
}

/** What #/hilfe/<id> shows. */
export function resolveHelp(raw?: string): HelpTarget {
  if (!raw?.trim()) return { kind: 'index' };
  const id = normalizeHelpId(raw);
  const target = HELP_ALIASES[id] ?? id;
  const topic = findTopic(target);
  if (topic) return { kind: 'topic', topic };
  const found = findSection(target);
  if (found) return { kind: 'topic', ...found };
  return { kind: 'missing', id: raw };
}

/**
 * What a word of the Wörterbuch says when it is tapped on the page `here`
 * (a section id): without the sentence that only sends you to this very
 * page ("Mehr unter [Wackelkontakt …]" on the Wackelkontakt page). A link
 * to a part of the page stays: it opens that part.
 */
export function termText(entry: GlossaryEntry, here?: string): string {
  if (!here) return entry.text;
  const toHere = (sentence: string) =>
    parseInline(sentence).some((p) => {
      if (p.kind !== 'link' || !p.href.startsWith('#/hilfe/')) return false;
      const to = resolveHelp(decodeURIComponent(p.href.slice('#/hilfe/'.length)));
      return to.kind === 'topic' && to.section?.id === here && !to.part;
    });
  return entry.text
    .split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„])/)
    .filter((sentence) => !toHere(sentence))
    .join(' ');
}

/** The blocks of a page or of one of its parts: what #/hilfe/<id> is about. */
export function pageBlocks(id: string): HelpBlock[] {
  const found = findSection(id);
  return found?.part?.blocks ?? found?.section.blocks ?? [];
}

export interface HelpLinkUse extends HelpLink {
  /** In running text, a button of a `links` block, or the thread at the end of a page. */
  from: 'text' | 'button' | 'forum';
  topic: string;
  /** The page the link stands on; empty for the topic summary. */
  section: string;
  /** The part of the page, when the link stands in one with an id. */
  part?: string;
}

/** Every link in the help: from the texts, from link blocks and the forum thread of each page. */
export function helpLinks(): HelpLinkUse[] {
  const out: HelpLinkUse[] = [];
  const fromText = (text: string, at: Omit<HelpLinkUse, 'label' | 'href' | 'from'>) => {
    for (const p of parseInline(text)) {
      if (p.kind === 'link') out.push({ label: p.text, href: p.href, from: 'text', ...at });
      else if (p.kind === 'strong' && p.inner) fromText(p.inner, at);
    }
  };
  for (const topic of HELP_TOPICS) {
    fromText(topic.summary, { topic: topic.id, section: '' });
    if (topic.footnote) fromText(topic.footnote, { topic: topic.id, section: '' });
    for (const s of topic.sections) {
      let part: string | undefined;
      for (const b of s.blocks) {
        if (b.kind === 'mehr') part = b.id;
        const at = { topic: topic.id, section: s.id, ...(part ? { part } : {}) };
        if (b.kind === 'links') for (const l of b.links) out.push({ ...l, from: 'button', ...at });
        for (const text of blockTexts(b)) fromText(text, at);
      }
      const forum = s.forum !== undefined ? forumLink(s.forum) : undefined;
      if (forum) out.push({ label: forum.title, href: forum.url, from: 'forum', topic: topic.id, section: s.id });
    }
  }
  return out;
}

/** The written texts of a block (generated blocks have none here). */
export function blockTexts(b: HelpBlock): string[] {
  switch (b.kind) {
    case 'p':
    case 'h3':
    case 'note':
      return [b.text];
    case 'command':
      return [b.text, b.command];
    case 'steps':
    case 'list':
    case 'checks':
      return b.items;
    case 'links':
      return b.links.map((l) => l.label);
    case 'bild':
    case 'foto':
      return [b.caption];
    case 'mehr':
      return [b.title];
    default:
      return [];
  }
}
