/**
 * Pictograms of ARASAAC (arasaac.org) for the sticker style "Bildkarte"
 * (TODO #91): a card without a cover can show one in place of our own motif.
 * Searched in German through the official API (api.arasaac.org), only when
 * someone searches; the chosen picture is loaded once and kept on this device
 * (features/stickers/pictograms.ts).
 *
 * Licence (arasaac.org/terms-of-use): CC BY-NC-SA 4.0. Author Sergio Palao,
 * origin ARASAAC, owner the Government of Aragón. So every card that shows
 * one names the source (PICTOGRAM_CREDIT, on its back or small on its front),
 * the app names it under "Danke" and in the help, and the picture is printed
 * as ARASAAC gives it: only its size changes and the colour of the plate
 * behind it. No tinting, cropping or redrawing, which would be an adaptation.
 */
import { isAbortError, sniffImageType, type FetchLike } from './image';

export const ARASAAC_API = 'https://api.arasaac.org/v1';
export const ARASAAC_STATIC = 'https://static.arasaac.org/pictograms';

/** The line on a card that shows a pictogram. */
/** A search that got no answer at all: no internet, or a filter that blocks ARASAAC (Hilfe „Internetfilter und Firewall“). */
export const PICTOGRAM_NET_ERROR = `Die Suche hat nicht geklappt. Prüfe die Internetverbindung. Blockiert vielleicht ein Filter? Dann gib dort ${new URL(ARASAAC_API).host} und ${new URL(ARASAAC_STATIC).host} frei.`;
export const PICTOGRAM_CREDIT = 'Piktogramm: Sergio Palao, ARASAAC (arasaac.org), CC BY-NC-SA';

/** The full credit as ARASAAC asks for it, for the app's thanks and help. */
export const ARASAAC_NOTICE =
  'Die Piktogramme sind Eigentum der Regierung von Aragón. Sergio Palao hat sie für ARASAAC (arasaac.org) gezeichnet, das sie unter der Lizenz Creative Commons BY-NC-SA 4.0 verteilt.';

export const ARASAAC_LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.de';

/** One hit of a search. */
export interface PictogramHit {
  id: number;
  /** The German word it stands for, e.g. "Katze". */
  label: string;
  /** About 300 px, for the result list (loaded by an <img>, nothing stored). */
  thumbUrl: string;
}

export interface PictogramSearchOptions {
  fetchFn: FetchLike;
  signal?: AbortSignal;
  /** Default 12 s. */
  timeoutMs?: number;
  /** Default 40. */
  limit?: number;
}

/** A valid ARASAAC id (they count up from 2000 or so; below a million for years to come). */
export function isPictogramId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 10_000_000;
}

export function searchUrl(query: string): string {
  return `${ARASAAC_API}/pictograms/de/search/${encodeURIComponent(query.trim())}`;
}

export function thumbUrl(id: number): string {
  return `${ARASAAC_STATIC}/${id}/${id}_300.png`;
}

/**
 * The picture for printing: 500 px, as ARASAAC draws it (in colour, no plural
 * or action marks). About 340 px are needed for the motif of a card at 300 dpi.
 */
export function imageUrls(id: number): string[] {
  return [`${ARASAAC_API}/pictograms/${id}?download=false&plural=false&color=true&resolution=500`, `${ARASAAC_STATIC}/${id}/${id}_500.png`];
}

/**
 * The hits of an answer of the search, in its order. Pictograms ARASAAC marks
 * as showing violence or sex are left out: these are cards for children.
 */
export function parseSearch(raw: unknown, limit = 40): PictogramHit[] {
  if (!Array.isArray(raw)) return [];
  const out: PictogramHit[] = [];
  const seen = new Set<number>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const id = o._id;
    if (!isPictogramId(id) || seen.has(id)) continue;
    if (o.violence === true || o.sex === true) continue;
    seen.add(id);
    out.push({ id, label: labelOf(o.keywords), thumbUrl: thumbUrl(id) });
    if (out.length >= limit) break;
  }
  return out;
}

function labelOf(keywords: unknown): string {
  if (!Array.isArray(keywords)) return '';
  for (const k of keywords) {
    const word = k && typeof k === 'object' ? (k as Record<string, unknown>).keyword : undefined;
    if (typeof word === 'string' && word.trim()) return word.trim();
  }
  return '';
}

export class PictogramError extends Error {
  constructor(
    message: string,
    readonly offline = false,
  ) {
    super(message);
    this.name = 'PictogramError';
  }
}

/**
 * Searches ARASAAC in German. No hits is an empty list (the API answers 404
 * then); a network failure throws a PictogramError with a German message.
 */
export async function searchPictograms(query: string, o: PictogramSearchOptions): Promise<PictogramHit[]> {
  const q = query.trim();
  if (!q) return [];
  return get(o, searchUrl(q), async (res) => {
    if (res.status === 404) return [];
    if (!res.ok) throw new PictogramError(`ARASAAC antwortet gerade nicht (Fehler ${res.status}). Versuche es später noch einmal.`);
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new PictogramError('ARASAAC hat etwas geschickt, das ich nicht lesen kann.');
    }
    return parseSearch(raw, o.limit ?? 40);
  });
}

/** Loads the picture of a pictogram for printing, as a PNG Blob. */
export async function downloadPictogram(id: number, o: PictogramSearchOptions): Promise<Blob> {
  let last: unknown;
  for (const url of imageUrls(id)) {
    try {
      return await get(o, url, async (res) => {
        if (!res.ok) throw new PictogramError(`Das Piktogramm ließ sich nicht laden (Fehler ${res.status}).`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = sniffImageType(bytes);
        if (!type) throw new PictogramError('ARASAAC hat kein Bild geschickt.');
        return new Blob([bytes], { type });
      });
    } catch (e) {
      if (isAbortError(e) && o.signal?.aborted) throw e;
      last = e;
    }
  }
  throw last instanceof PictogramError ? last : new PictogramError('Das Piktogramm ließ sich nicht laden. Bist du online?', true);
}

/**
 * One request and the reading of its answer (`use`), within one time limit:
 * an answer that stops halfway must not keep the page waiting (Testlabor #69).
 */
async function get<T>(o: PictogramSearchOptions, url: string, use: (res: Response) => Promise<T>): Promise<T> {
  // By hand, not AbortSignal.any/timeout: older WebKitGTK of the desktop app lacks them.
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, o.timeoutMs ?? 12_000);
  const stop = () => ctl.abort();
  if (o.signal?.aborted) ctl.abort();
  o.signal?.addEventListener('abort', stop, { once: true });
  const slow = () => new PictogramError('ARASAAC hat zu lange nicht geantwortet. Versuche es noch einmal.', true);
  try {
    let res: Response;
    try {
      res = await o.fetchFn(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (timedOut) throw slow();
      throw new PictogramError('ARASAAC ist gerade nicht zu erreichen. Bist du online?', true);
    }
    try {
      return await use(res);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (timedOut) throw slow();
      throw e;
    }
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', stop);
  }
}
