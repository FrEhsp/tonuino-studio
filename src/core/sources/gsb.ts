/**
 * Global Storybooks audio (GitLab project global-asp/gsn-audio): which
 * repository paths are whole stories, and what the first bytes of a story
 * file say about it (ID3 title, reader, year, credit with licence; the
 * playing time from the Xing/Info frame). The builder reads only the first
 * 16 KB of each changed file with a Range request.
 */
import { parseId3v2, parseId3v2Header } from '../audio/id3';
import { parseFrameHeader, parseXingFrame } from '../audio/mp3frames';

/** Bytes the builder asks for per story file. */
export const GSB_HEAD_BYTES = 16384;

export interface GsbCredit {
  textBy?: string;
  translatedBy?: string;
  language?: string;
  level?: string;
  /** Licence family as written in the file, e.g. "CC-BY", "CC-BY-NC". */
  license?: string;
}

export interface GsbHead {
  title?: string;
  reader?: string;
  /** "2017" */
  year?: string;
  comment?: GsbCredit;
  /** Whole seconds, from the Xing/Info frame count; missing when the file has none. */
  durationSec?: number;
}

/** The story id and file name of a whole-story path ("de/0001/de-0001_tall.mp3"); undefined for page files and folders. */
export function gsbStoryPath(path: string, folder: string): { id: string; name: string } | undefined {
  const prefix = folder.replace(/\/+$/, '') + '/';
  if (!path.startsWith(prefix)) return undefined;
  const m = /^(\d{4})\/([^/]+\.mp3)$/i.exec(path.slice(prefix.length));
  return m ? { id: m[1], name: m[2] } : undefined;
}

/** "Text by: …\nTranslated by: …\nLanguage: …\nLevel: …\nLicense: CC-BY" */
export function parseGsbCredit(text: string): GsbCredit {
  const out: GsbCredit = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(text by|translated by|language|level|license)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!m || !m[2]) continue;
    const key = m[1].toLowerCase();
    if (key === 'text by') out.textBy = m[2];
    else if (key === 'translated by') out.translatedBy = m[2];
    else if (key === 'language') out.language = m[2];
    else if (key === 'level') out.level = m[2];
    else out.license = m[2];
  }
  return out;
}

/** Where a traditional tale comes from, as the African Storybook writes it ("Ghanaian folktale"), in German. */
const TRADITIONS: Record<string, string> = {
  african: 'aus Afrika',
  'west african': 'aus Westafrika',
  'east african': 'aus Ostafrika',
  'southern african': 'aus dem südlichen Afrika',
  'south african': 'aus Südafrika',
  angolan: 'aus Angola',
  botswanan: 'aus Botswana',
  burundian: 'aus Burundi',
  cameroonian: 'aus Kamerun',
  congolese: 'aus dem Kongo',
  ethiopian: 'aus Äthiopien',
  ghanaian: 'aus Ghana',
  kenyan: 'aus Kenia',
  liberian: 'aus Liberia',
  malawian: 'aus Malawi',
  mozambican: 'aus Mosambik',
  namibian: 'aus Namibia',
  nigerian: 'aus Nigeria',
  rwandan: 'aus Ruanda',
  senegalese: 'aus dem Senegal',
  somali: 'aus Somalia',
  sudanese: 'aus dem Sudan',
  tanzanian: 'aus Tansania',
  ugandan: 'aus Uganda',
  zambian: 'aus Sambia',
  zimbabwean: 'aus Simbabwe',
  akan: 'der Akan',
  ashanti: 'der Ashanti',
  asante: 'der Ashanti',
  baganda: 'der Baganda',
  ganda: 'der Baganda',
  basotho: 'der Basotho',
  sotho: 'der Sotho',
  hausa: 'der Hausa',
  igbo: 'der Igbo',
  kikuyu: 'der Kikuyu',
  luhya: 'der Luhya',
  luo: 'der Luo',
  maasai: 'der Massai',
  masai: 'der Massai',
  swahili: 'der Swahili',
  tswana: 'der Tswana',
  xhosa: 'der Xhosa',
  yoruba: 'der Yoruba',
  zulu: 'der Zulu',
};

/**
 * A traditional tale named where a person's name would be ("Ghanaian
 * folktale", "Zulu folktale", "Traditional"): its origin in German, so it is
 * not credited as an author. Undefined for people.
 */
export function traditionOf(textBy: string | undefined): string | undefined {
  const t = (textBy ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return undefined;
  if (/^(?:traditional|folk ?tale|folklore|folk story)$/i.test(t)) return 'Überliefert';
  const m = /^(.+?) (?:folk ?tale|folklore|folk story|traditional(?: tale| story)?)$/i.exec(t) ?? /^traditional (.+?) (?:tale|story)$/i.exec(t);
  if (!m) return undefined;
  const where = TRADITIONS[m[1].toLowerCase()];
  return where ? `Volksmärchen ${where}` : `Überliefert („${t}“)`;
}

/** Playing time from the first audio frame after the tag, when it is a Xing/Info frame with a frame count. */
function xingDuration(head: Uint8Array, start: number): number | undefined {
  const limit = Math.min(head.length - 4, start + 4096);
  for (let p = start; p < limit; p++) {
    if (head[p] !== 0xff || (head[p + 1] & 0xe0) !== 0xe0) continue;
    const hdr = parseFrameHeader(head, p);
    if (!hdr) continue;
    if (p + hdr.frameLength > head.length) return undefined;
    const info = parseXingFrame(head.subarray(p, p + hdr.frameLength), hdr, p);
    const frames = info?.xing.frames;
    if (!frames) return undefined;
    const sec = Math.round((frames * hdr.samplesPerFrame) / hdr.sampleRate);
    return sec > 0 ? sec : undefined;
  }
  return undefined;
}

/** Reads what the builder needs from the first bytes of a story file. */
export function parseGsbHead(head: Uint8Array): GsbHead {
  const out: GsbHead = {};
  const h = parseId3v2Header(head, 0);
  let audioStart = 0;
  if (h) {
    audioStart = h.size;
    const tag = parseId3v2(head.subarray(0, Math.min(head.length, h.size)));
    if (tag) {
      out.title = tag.tags.title;
      out.reader = tag.tags.artist;
      out.year = tag.tags.year;
      if (tag.tags.comment) out.comment = parseGsbCredit(tag.tags.comment);
    }
  }
  const sec = xingDuration(head, audioStart);
  if (sec !== undefined) out.durationSec = sec;
  return out;
}
