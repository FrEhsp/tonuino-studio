/**
 * A small, tolerant RSS 2.0 reader for the index builder. It runs in Node
 * (no DOMParser) and reads only what the index needs.
 */

export interface RssEnclosure {
  url: string;
  length?: number;
  type?: string;
}

export interface RssItem {
  title?: string;
  link?: string;
  /** <description>, or <itunes:summary> when there is none. */
  description?: string;
  /** <itunes:summary> */
  summary?: string;
  /** <itunes:subtitle> */
  subtitle?: string;
  /** <content:encoded>: the full show notes, usually HTML. */
  content?: string;
  guid?: string;
  pubDate?: string;
  enclosure?: RssEnclosure;
  duration?: string;
  explicit?: string;
  /** <itunes:episodeType>: "full", "trailer" or "bonus". */
  episodeType?: string;
  /** <itunes:image href="…">: the episode's own picture. */
  image?: string;
}

export interface RssFeed {
  title?: string;
  /** The channel's own <link>: usually the show page. */
  link?: string;
  description?: string;
  language?: string;
  copyright?: string;
  explicit?: string;
  author?: string;
  /** The show's picture: <itunes:image href="…">, else <image><url>. */
  image?: string;
  items: RssItem[];
}

export class FeedError extends Error {
  readonly code: 'not-rss' | 'truncated' | 'empty';

  constructor(code: 'not-rss' | 'truncated' | 'empty', message: string) {
    super(message);
    this.code = code;
    this.name = 'FeedError';
  }
}

/** HTML entities that show up in feed text (show notes are often HTML inside CDATA). */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', yacute: 'ý', yuml: 'ÿ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Yacute: 'Ý',
  scaron: 'š', Scaron: 'Š', zcaron: 'ž', Zcaron: 'Ž', oelig: 'œ', OElig: 'Œ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·', shy: '\u00ad', minus: '−',
  euro: '€', cent: '¢', pound: '£', yen: '¥', copy: '©', reg: '®', trade: '™', deg: '°', sect: '§', para: '¶',
  times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', permil: '‰',
  iexcl: '¡', iquest: '¿', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  lrm: '\u200e', rlm: '\u200f', prime: '′', Prime: '″', dagger: '†', Dagger: '‡', hearts: '♥', star: '☆',
};
/** The XML ones are also written in capitals (&AMP;). */
const NAMED_ANY_CASE: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[code] ?? NAMED_ANY_CASE[code.toLowerCase()] ?? all;
  });
}

/** Text of an element: CDATA as is, everything else with entities decoded. */
function textOf(raw: string): string {
  const parts: string[] = [];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    parts.push(decodeEntities(raw.slice(last, m.index)));
    parts.push(m[1]);
    last = re.lastIndex;
  }
  parts.push(decodeEntities(raw.slice(last)));
  return parts.join('').trim();
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First <name>…</name> in `xml`, as text. */
function element(xml: string, name: string): string | undefined {
  const n = escapeName(name);
  const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(xml);
  return m ? textOf(m[1]) : undefined;
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/** href of the first <itunes:image …/> in `xml`. */
function itunesImage(xml: string): string | undefined {
  const m = /<itunes:image\b([^>]*)>/i.exec(xml);
  const href = m ? attributes(m[1]).href?.trim() : undefined;
  return href || undefined;
}

export function parseRss(xml: string): RssFeed {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/<rss[\s>]/i.test(body) || !/<channel[\s>]/i.test(body)) throw new FeedError('not-rss', 'Das ist kein RSS-Feed.');
  if (!/<\/channel>/i.test(body) || !/<\/rss>/i.test(body)) throw new FeedError('truncated', 'Der Feed ist unvollständig.');
  const opens = body.match(/<item[\s>]/gi)?.length ?? 0;
  const closes = body.match(/<\/item>/gi)?.length ?? 0;
  if (opens !== closes) throw new FeedError('truncated', 'Der Feed ist unvollständig.');
  const firstItem = body.search(/<item[\s>]/i);
  const head = firstItem < 0 ? body : body.slice(0, firstItem);
  const items: RssItem[] = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const x = m[1];
    const enc = /<enclosure\b([^>]*)\/?>/i.exec(x);
    let enclosure: RssEnclosure | undefined;
    if (enc) {
      const a = attributes(enc[1]);
      if (a.url) {
        const length = a.length !== undefined && /^\d+$/.test(a.length.trim()) ? Number(a.length) : undefined;
        enclosure = { url: a.url.trim(), length: length && length > 0 ? length : undefined, type: a.type };
      }
    }
    const summary = element(x, 'itunes:summary');
    items.push({
      title: element(x, 'title'),
      link: element(x, 'link'),
      description: element(x, 'description') ?? summary,
      summary,
      subtitle: element(x, 'itunes:subtitle'),
      content: element(x, 'content:encoded'),
      guid: element(x, 'guid'),
      pubDate: element(x, 'pubDate'),
      enclosure,
      duration: element(x, 'itunes:duration'),
      explicit: element(x, 'itunes:explicit'),
      episodeType: element(x, 'itunes:episodeType'),
      image: itunesImage(x),
    });
  }
  // <image> has a <link> of its own; the channel's is the show page.
  const imageBlock = /<image(?:\s[^>]*)?>([\s\S]*?)<\/image>/i.exec(head);
  const channel = head.replace(/<image(?:\s[^>]*)?>[\s\S]*?<\/image>/gi, '');
  return {
    title: element(channel, 'title'),
    link: element(channel, 'link'),
    description: element(channel, 'description'),
    language: element(channel, 'language'),
    copyright: element(channel, 'copyright'),
    explicit: element(channel, 'itunes:explicit'),
    author: element(channel, 'itunes:author'),
    image: itunesImage(channel) ?? (imageBlock ? element(imageBlock[1], 'url') || undefined : undefined),
    items,
  };
}
