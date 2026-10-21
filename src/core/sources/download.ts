/**
 * Downloads the files a family picked in "Entdecken", one after the other,
 * the way the browser or the desktop WebView fetches anything: no cookies, no
 * referrer, no extra headers. Checks that what arrives is complete audio and
 * not a web page, and turns every failure into a code the page can explain.
 * A connection that stops sending is given up after a while (IDLE_MS), so a
 * stalled file fails like a broken one instead of hanging the whole run.
 */
import { isMeasurementHost } from './cors';

/** 'blocked': the file was handed out through a service that counts downloads. */
export type DownloadErrorCode = 'offline' | 'network' | 'gone' | 'busy' | 'http' | 'not-audio' | 'incomplete' | 'aborted' | 'blocked';

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  /** HTTP status, for 'gone', 'busy' and 'http'. */
  readonly status?: number;
  /** For 'busy': how long the publisher asked to wait, when it said so. */
  readonly retryAfterSec?: number;
  readonly fileName: string;

  constructor(code: DownloadErrorCode, fileName: string, opts: { status?: number; retryAfterSec?: number; cause?: unknown } = {}) {
    super(`${code}${opts.status ? ` ${opts.status}` : ''}: ${fileName}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'DownloadError';
    this.code = code;
    this.fileName = fileName;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
  }
}

/** What a download needs to know about a file. */
export interface DownloadSpec {
  url: string;
  /** File name for the import. */
  name: string;
  /** Expected size from the list, when known. */
  size?: number;
}

export interface DownloadProgress {
  /** The file being loaded, counted from 0. */
  fileIndex: number;
  files: number;
  /** Bytes received so far, over all files. */
  bytes: number;
  /** All files together, when the list knows every size. */
  totalBytes?: number;
}

export interface DownloadOptions {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Waits between requests; replaced in tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** navigator.onLine */
  isOnline?: () => boolean;
  now?: () => number;
  /** Give up on a file after this long without an answer or without new bytes (IDLE_MS). */
  idleMs?: number;
}

export interface DownloadResult<T extends DownloadSpec> {
  ok: { file: T; blob: Blob }[];
  failed: { file: T; error: DownloadError }[];
  /** Not tried, because the download stopped at an earlier file. */
  skipped: T[];
}

/** Pause before trying a file again after a broken connection. */
export const RETRY_DELAY_MS = 3000;
/** archive.org asks for some room between requests. */
export const ARCHIVE_GAP_MS = 1000;
/** Longest wait the app accepts when a publisher is busy. */
export const MAX_RETRY_AFTER_SEC = 60;
/**
 * Wait when a busy publisher's Retry-After cannot be read: browsers hide that
 * header from other origins unless the server exposes it, which few do.
 */
export const BUSY_FALLBACK_SEC = 15;
/** No answer or no new bytes for this long: the file counts as broken. */
export const IDLE_MS = 30_000;
/** Received bytes are collected in parts of this size, so a long book is not held twice while it is put together. */
const PART_BYTES = 8 * 1024 * 1024;
/** Bytes looked at to recognise the audio format. */
export const SNIFF_BYTES = 4096;

function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Abgebrochen', 'AbortError'));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(t);
      reject(new DOMException('Abgebrochen', 'AbortError'));
    }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function isAbortError(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isArchive(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'archive.org' || host.endsWith('.archive.org');
  } catch {
    return false;
  }
}

/** Retry-After as seconds or as an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : undefined;
}

const has = (b: Uint8Array, at: number, text: string) => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

function extension(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** A web page instead of a file: starts with "<" (after a BOM and white space). */
function looksLikeMarkup(head: Uint8Array): boolean {
  let i = has(head, 0, '\xEF\xBB\xBF') ? 3 : 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  return head[i] === 0x3c;
}

/** True when the first bytes fit the file's extension. Unknown extensions only must not be a web page. */
export function sniffAudio(head: Uint8Array, name: string): boolean {
  if (looksLikeMarkup(head)) return false;
  const limit = Math.min(head.length, SNIFF_BYTES) - 1;
  /** A frame sync somewhere in the first bytes: 11 bits set (MPEG audio), or 12 bits and layer 0 (AAC in ADTS). */
  const sync = (mask: number, value: number) => {
    for (let i = 0; i < limit; i++) if (head[i] === 0xff && (head[i + 1] & mask) === value) return true;
    return false;
  };
  switch (extension(name)) {
    case 'mp3':
    case 'mp2':
    case 'mpga':
      return has(head, 0, 'ID3') || sync(0xe0, 0xe0);
    case 'ogg':
    case 'oga':
    case 'opus':
      return has(head, 0, 'OggS');
    case 'm4a':
    case 'm4b':
    case 'mp4':
      return has(head, 4, 'ftyp');
    case 'aac':
      return has(head, 0, 'ID3') || sync(0xf6, 0xf0);
    case 'flac':
      return has(head, 0, 'fLaC') || has(head, 0, 'ID3');
    case 'wav':
      return has(head, 0, 'RIFF') && has(head, 8, 'WAVE');
    case 'webm':
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    default:
      return head.length > 0;
  }
}

/** Content types that cannot be audio. Audio types, octet-stream and a missing type pass. */
function isPageType(contentType: string | null): boolean {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return t === 'text/html' || t === 'application/xhtml+xml' || t.startsWith('text/');
}

interface FetchContext {
  fetch: DownloadOptions['fetch'];
  signal?: AbortSignal;
  isOnline: () => boolean;
  now: () => number;
  idleMs: number;
  /** `declared`: the length the server named for this file, when it did. */
  onBytes: (received: number, declared?: number) => void;
}

/** A timer that fires when nothing happened for `ms`; every kick() starts it again. */
function watchdog(ms: number, onIdle: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    get fired() {
      return fired;
    },
    kick() {
      stop();
      timer = setTimeout(() => {
        fired = true;
        onIdle();
      }, ms);
    },
    stop,
  };
}

/** One request for one file, with all checks. */
async function fetchOne(file: DownloadSpec, ctx: FetchContext): Promise<Blob> {
  // Our own signal, so a stalled connection can be cut without cancelling the run.
  const ctrl = new AbortController();
  const passOn = () => ctrl.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) passOn();
  ctx.signal?.addEventListener('abort', passOn, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const idle = watchdog(ctx.idleMs, () => {
    ctrl.abort(new DOMException('Keine Daten mehr', 'TimeoutError'));
    void reader?.cancel().catch(() => undefined);
  });
  try {
    return await fetchChecked(file, ctx, ctrl.signal, idle, (r) => (reader = r));
  } finally {
    idle.stop();
    ctx.signal?.removeEventListener('abort', passOn);
  }
}

async function fetchChecked(
  file: DownloadSpec,
  ctx: FetchContext,
  signal: AbortSignal,
  idle: ReturnType<typeof watchdog>,
  setReader: (r: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<Blob> {
  const name = file.name;
  let res: Response;
  idle.kick();
  try {
    res = await ctx.fetch(file.url, { method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal });
  } catch (e) {
    if (idle.fired) throw new DownloadError('network', name, { cause: e });
    if (ctx.signal?.aborted || isAbortError(e)) throw new DownloadError('aborted', name, { cause: e });
    throw new DownloadError(ctx.isOnline() ? 'network' : 'offline', name, { cause: e });
  }
  const drop = () => void res.body?.cancel().catch(() => undefined);
  // A redirect through a service that counts downloads: the list never points there, so the publisher changed something.
  const finalHost = res.url ? hostOf(res.url) : undefined;
  if (finalHost && isMeasurementHost(finalHost)) {
    drop();
    throw new DownloadError('blocked', name);
  }
  if (!res.ok) {
    drop();
    if (res.status === 404 || res.status === 410) throw new DownloadError('gone', name, { status: res.status });
    if (res.status === 429 || res.status === 503) {
      throw new DownloadError('busy', name, { status: res.status, retryAfterSec: parseRetryAfter(res.headers.get('retry-after'), ctx.now()) });
    }
    throw new DownloadError('http', name, { status: res.status });
  }
  if (isPageType(res.headers.get('content-type'))) {
    drop();
    throw new DownloadError('not-audio', name);
  }
  const lengthHeader = res.headers.get('content-length');
  const declared = lengthHeader !== null && /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader) : undefined;
  let blob: Blob;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      setReader(reader);
      const type = res.headers.get('content-type') ?? '';
      const done: Blob[] = [];
      let part: Uint8Array[] = [];
      let partBytes = 0;
      let received = 0;
      idle.kick();
      for (;;) {
        const r = await reader.read();
        if (idle.fired) throw new DOMException('Keine Daten mehr', 'TimeoutError');
        if (r.done) break;
        idle.kick();
        part.push(r.value);
        partBytes += r.value.byteLength;
        received += r.value.byteLength;
        ctx.onBytes(received, declared);
        if (partBytes >= PART_BYTES) {
          done.push(new Blob(part as BlobPart[]));
          part = [];
          partBytes = 0;
        }
      }
      if (part.length) done.push(new Blob(part as BlobPart[]));
      blob = new Blob(done, { type });
    } else {
      blob = await res.blob();
      ctx.onBytes(blob.size);
    }
  } catch (e) {
    if (idle.fired) throw new DownloadError('incomplete', name, { cause: e });
    if (ctx.signal?.aborted || isAbortError(e)) throw new DownloadError('aborted', name, { cause: e });
    throw new DownloadError(ctx.isOnline() ? 'incomplete' : 'offline', name, { cause: e });
  } finally {
    idle.stop();
  }
  // Fewer bytes than announced: the connection broke. (More can happen when a server compresses on the fly.)
  if (declared !== undefined && blob.size < declared) throw new DownloadError('incomplete', name);
  if (file.size && blob.size < file.size / 2) throw new DownloadError('incomplete', name);
  const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
  if (!sniffAudio(head, name)) throw new DownloadError('not-audio', name);
  return blob;
}

/** Errors after which the next file is not tried: the connection or the publisher is the problem, not this file. */
const STOPS: ReadonlySet<DownloadErrorCode> = new Set<DownloadErrorCode>(['offline', 'network', 'busy', 'http', 'not-audio', 'incomplete', 'blocked']);

/**
 * Loads the files one after the other. A broken, stalled or incomplete
 * file is tried once more after 3 seconds; a busy publisher once more after
 * the wait it asked for, if that is at most a minute (15 seconds when the
 * browser does not let us read it). A file that is gone is skipped; any
 * other failure stops the download, and the files loaded so far are kept.
 * Rejects with code 'aborted' when `signal` fires.
 */
export async function downloadFiles<T extends DownloadSpec>(files: readonly T[], o: DownloadOptions): Promise<DownloadResult<T>> {
  const wait = o.wait ?? defaultWait;
  const now = o.now ?? (() => Date.now());
  const isOnline = o.isOnline ?? (() => true);
  const idleMs = o.idleMs ?? IDLE_MS;
  const result: DownloadResult<T> = { ok: [], failed: [], skipped: [] };
  // A single file the list knows no size of: the length its server names, once it named one.
  let totalBytes = files.every((f) => f.size) ? files.reduce((sum, f) => sum + (f.size ?? 0), 0) : undefined;
  const known = totalBytes !== undefined || files.length !== 1;
  let doneBytes = 0;
  let lastReport = -Infinity;
  let lastArchiveStart = -Infinity;
  const report = (fileIndex: number, bytes: number, force = false) => {
    const t = now();
    if (!force && t - lastReport < 100) return;
    lastReport = t;
    o.onProgress?.({ fileIndex, files: files.length, bytes, totalBytes });
  };
  const pause = async (ms: number, name: string) => {
    try {
      await wait(ms, o.signal);
    } catch (e) {
      throw new DownloadError('aborted', name, { cause: e });
    }
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (o.signal?.aborted) throw new DownloadError('aborted', file.name);
    report(i, doneBytes, true);
    let retried = false;
    let waitedBusy = false;
    for (;;) {
      if (isArchive(file.url)) {
        const gap = lastArchiveStart + ARCHIVE_GAP_MS - now();
        if (gap > 0) await pause(gap, file.name);
        lastArchiveStart = now();
      }
      try {
        const onBytes = (n: number, declared?: number) => {
          if (!known) totalBytes = declared;
          report(i, doneBytes + n);
        };
        const blob = await fetchOne(file, { fetch: o.fetch, signal: o.signal, isOnline, now, idleMs, onBytes });
        result.ok.push({ file, blob });
        doneBytes += blob.size;
        report(i, doneBytes, true);
        break;
      } catch (e) {
        const error = e instanceof DownloadError ? e : new DownloadError('network', file.name, { cause: e });
        if (error.code === 'aborted') throw error;
        if ((error.code === 'network' || error.code === 'incomplete') && !retried) {
          retried = true;
          await pause(RETRY_DELAY_MS, file.name);
          continue;
        }
        const busyWait = error.retryAfterSec ?? BUSY_FALLBACK_SEC;
        if (error.code === 'busy' && !waitedBusy && busyWait <= MAX_RETRY_AFTER_SEC) {
          waitedBusy = true;
          await pause(busyWait * 1000, file.name);
          continue;
        }
        result.failed.push({ file, error });
        break;
      }
    }
    const last = result.failed[result.failed.length - 1];
    if (last?.file === file && STOPS.has(last.error.code)) {
      result.skipped.push(...files.slice(i + 1));
      break;
    }
  }
  return result;
}

/**
 * Bytes per request of rangedFetch: below what the desktop app's https helper
 * takes per answer (10 MB, sources_net.rs MAX_BODY), and small enough to
 * arrive within its 20 seconds per request on a slow line (about 1.7 Mbit/s).
 */
export const RANGE_BYTES = 4 * 1024 * 1024;
/** Time between the starts of two pieces, as the list builder keeps for these hosts (net.ts SLOW_HOSTS). */
export const RANGE_GAP_MS = 1000;
/** Pause before a piece is asked for once more after a broken connection. */
export const RANGE_RETRY_MS = 2000;
const RANGE_HOPS = 5;

export interface RangedOptions {
  /** Addresses a redirect may lead to (https only besides). */
  allowed: (url: string) => boolean;
  pieceBytes?: number;
  gapMs?: number;
  retryMs?: number;
  /** Waits; replaced in tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** "bytes 0-4194303/242157414": first byte, last byte and the whole length (undefined for "*"). */
export function parseContentRange(value: string | null): { first: number; last: number; total?: number } | undefined {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value ?? '');
  if (!m) return undefined;
  const first = Number(m[1]);
  const last = Number(m[2]);
  const total = m[3] === '*' ? undefined : Number(m[3]);
  if (last < first || (total !== undefined && last >= total)) return undefined;
  return { first, last, total };
}

/**
 * A fetch for files the desktop app loads through its own https helper
 * (Provider.appLoads), which takes answers up to 10 MB and 20 seconds: it
 * asks for the file in pieces (Range), one after the other, and hands them
 * on as one answer with one body, so downloadFiles reads it like any other
 * file. A piece whose connection broke is asked for once more. A server
 * that ignores the range answers with the whole file, which the helper
 * refuses when it is larger than a piece: the download fails, and the family
 * can still save the file on the publisher's page.
 */
export function rangedFetch(fetchFn: (url: string, init: RequestInit) => Promise<Response>, o: RangedOptions): (url: string, init: RequestInit) => Promise<Response> {
  const piece = o.pieceBytes ?? RANGE_BYTES;
  const gapMs = o.gapMs ?? RANGE_GAP_MS;
  const retryMs = o.retryMs ?? RANGE_RETRY_MS;
  const wait = o.wait ?? defaultWait;
  const now = o.now ?? (() => Date.now());
  return async (url, init) => {
    const signal = init.signal ?? undefined;
    let target = url;
    let lastStart = -Infinity;
    /** One piece from `at` on, following redirects by hand to allowed https addresses only. */
    const ask = async (at: number): Promise<Response> => {
      const gap = lastStart + gapMs - now();
      if (gap > 0) await wait(gap, signal);
      lastStart = now();
      for (let hop = 0; ; hop++) {
        const res = await fetchFn(target, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal, headers: { range: `bytes=${at}-${at + piece - 1}` } });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) return res;
        let next: string;
        try {
          next = new URL(location, target).href;
        } catch {
          return res;
        }
        // Elsewhere than the publisher's own files: downloadFiles reports the redirect as a refusal.
        if (hop >= RANGE_HOPS || !next.startsWith('https://') || !o.allowed(next)) return res;
        void res.body?.cancel().catch(() => undefined);
        target = next;
      }
    };
    const askAgain = async (at: number): Promise<Response> => {
      try {
        return await ask(at);
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) throw e;
        await wait(retryMs, signal);
        return ask(at);
      }
    };
    const first = await ask(0);
    // The whole file (small, or a server without ranges) and every refusal: downloadFiles judges them.
    if (first.status !== 206) return withUrl(first, target);
    const range = parseContentRange(first.headers.get('content-range'));
    if (!range || range.first !== 0) {
      void first.body?.cancel().catch(() => undefined);
      throw new TypeError('Unerwartete Antwort auf eine Teilanfrage');
    }
    const total = range.total;
    let pos = 0;
    let current: Response | null = first;
    let done = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (done || (total !== undefined && pos >= total)) return ctrl.close();
        if (!current) {
          const res = await askAgain(pos);
          // Past the end of a file whose length the server did not name.
          if (res.status === 416 && total === undefined) return ctrl.close();
          const r = res.status === 206 ? parseContentRange(res.headers.get('content-range')) : undefined;
          if (!r || r.first !== pos || (total !== undefined && r.total !== total)) {
            void res.body?.cancel().catch(() => undefined);
            throw new TypeError(`Teil ab Byte ${pos} kam nicht (HTTP ${res.status})`);
          }
          current = res;
        }
        const bytes = new Uint8Array(await current.arrayBuffer());
        current = null;
        if (!bytes.length) {
          if (total === undefined) return ctrl.close();
          throw new TypeError(`Teil ab Byte ${pos} war leer`);
        }
        pos += bytes.length;
        if (total === undefined && bytes.length < piece) done = true;
        ctrl.enqueue(bytes);
      },
      cancel() {
        done = true;
        void current?.body?.cancel().catch(() => undefined);
      },
    });
    const headers = new Headers();
    const type = first.headers.get('content-type');
    if (type) headers.set('content-type', type);
    if (total !== undefined) headers.set('content-length', String(total));
    return withUrl(new Response(body, { status: 200, headers }), target);
  };
}

/** The answer with the address it finally came from, as a browser's fetch gives it (downloadFiles looks at it). */
function withUrl(res: Response, url: string): Response {
  if (res.url) return res;
  try {
    Object.defineProperty(res, 'url', { value: url });
  } catch {
    // The address stays empty; nothing depends on it but the check for counting services.
  }
  return res;
}

/** What one item is called in a message ("die Folge", "das Lied"). */
export type PartWord = 'Folge' | 'Geschichte' | 'Lied' | 'Titel';

/** "die Folge … sie", "das Lied … es", "den Titel … ihn". */
const PART: Record<PartWord, [article: string, pronoun: string]> = {
  Folge: ['die', 'sie'],
  Geschichte: ['die', 'sie'],
  Lied: ['das', 'es'],
  Titel: ['den', 'ihn'],
};

/**
 * What went wrong, in words for parents. `title` is the item, e.g. an
 * episode or a chapter; `part` what it is called (default "Folge").
 */
export function messageFor(e: DownloadError, title: string, o: { podcast?: boolean; part?: PartWord } = {}): string {
  const part = o.part ?? 'Folge';
  const [article, pronoun] = PART[part];
  switch (e.code) {
    case 'offline':
      return 'Du bist offline. Verbinde dich mit dem Internet und versuche es noch einmal.';
    case 'network':
      return `„${title}“ ließ sich nicht laden. Prüfe deine Internetverbindung und versuche es noch einmal. Klappt es weiter nicht, öffne ${article} ${part} auf der Webseite und lade ${pronoun} dort herunter.`;
    case 'gone':
      return `„${title}“ ist beim Anbieter nicht mehr online.${o.podcast === false ? '' : ' Podcasts bleiben oft nur eine Zeit lang verfügbar.'}`;
    case 'busy': {
      const min = e.retryAfterSec !== undefined ? Math.max(1, Math.ceil(e.retryAfterSec / 60)) : undefined;
      const when = min === undefined || min > 120 ? 'in ein paar Minuten' : min === 1 ? 'in einer Minute' : `in ${min} Minuten`;
      return `Der Anbieter bekommt gerade zu viele Anfragen. Versuche es ${when} noch einmal.`;
    }
    case 'http':
      return `Der Anbieter hat die Datei nicht herausgegeben (Fehler ${e.status ?? '?'}). Versuche es später noch einmal.`;
    case 'not-audio':
      return `Statt der Hördatei kam eine Webseite zurück. Öffne ${article} ${part} auf der Webseite des Anbieters.`;
    case 'incomplete':
      return 'Die Datei kam nicht vollständig an. Versuche es noch einmal.';
    case 'aborted':
      return 'Abgebrochen. Es wurde nichts auf die SD-Karte geschrieben.';
    case 'blocked':
      return `Der Anbieter gibt „${title}“ gerade über einen Dienst heraus, der Downloads zählt. Darum laden wir die Datei nicht. Wir schauen uns das an.`;
  }
}
