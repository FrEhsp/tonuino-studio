import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_GAP_MS,
  BUSY_FALLBACK_SEC,
  DownloadError,
  downloadFiles,
  messageFor,
  parseRetryAfter,
  parseContentRange,
  rangedFetch,
  RETRY_DELAY_MS,
  sniffAudio,
  type DownloadOptions,
  type DownloadProgress,
  type DownloadSpec,
} from '../../src/core/sources/download';
import { fxBytes } from './sample';

const MP3 = fxBytes('gitlab/gsb_de-0001_tall.mp3');
const GSB_URL = 'https://gitlab.com/api/v4/projects/123/repository/files/de%2F0001%2Fde-0001_tall.mp3/raw?ref=master';

/** A response whose body arrives in chunks, like a real download. */
function stream(bytes: Uint8Array, opts: { type?: string | null; length?: number | null; status?: number; headers?: Record<string, string>; failAfter?: number } = {}): Response {
  const chunk = 64 * 1024;
  let pos = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && pos >= opts.failAfter) {
        controller.error(new TypeError('network error'));
        return;
      }
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + chunk));
      pos += chunk;
    },
  });
  const headers = new Headers(opts.headers);
  if (opts.type !== null) headers.set('content-type', opts.type ?? 'audio/mpeg');
  if (opts.length !== null) headers.set('content-length', String(opts.length ?? bytes.length));
  return new Response(body, { status: opts.status ?? 200, headers });
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

interface Harness {
  options: DownloadOptions;
  calls: { url: string; init: RequestInit }[];
  waits: number[];
  progress: DownloadProgress[];
  clock: { t: number };
}

/** Fetch answers per call; a fake clock that only moves when the download waits. */
function harness(answers: (() => Response | Promise<Response>)[], over: Partial<DownloadOptions> = {}): Harness {
  const calls: Harness['calls'] = [];
  const waits: number[] = [];
  const progress: DownloadProgress[] = [];
  const clock = { t: 1_000_000 };
  let n = 0;
  const options: DownloadOptions = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const answer = answers[Math.min(n++, answers.length - 1)];
      return answer();
    },
    wait: async (ms) => {
      waits.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    isOnline: () => true,
    onProgress: (p) => progress.push(p),
    ...over,
  };
  return { options, calls, waits, progress, clock };
}

const spec = (name: string, url = GSB_URL, size?: number): DownloadSpec => ({ url, name, size });

/** Reads a real MP3 in chunks: quick alone, several seconds while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('downloadFiles', SLOW, () => {
  it('loads a real MP3 in chunks and reports the bytes', async () => {
    const h = harness([() => stream(MP3)]);
    const r = await downloadFiles([spec('de-0001_tall.mp3', GSB_URL, MP3.length)], h.options);
    expect(r.failed).toEqual([]);
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].blob.size).toBe(452_051);
    expect(new Uint8Array(await r.ok[0].blob.arrayBuffer())).toEqual(MP3);
    const last = h.progress[h.progress.length - 1];
    expect(last).toEqual({ fileIndex: 0, files: 1, bytes: 452_051, totalBytes: 452_051 });
    expect(h.progress[0]).toEqual({ fileIndex: 0, files: 1, bytes: 0, totalBytes: 452_051 });
  });

  it('asks like a plain browser request: no cookies, no referrer, no extra headers', async () => {
    const h = harness([() => stream(MP3)]);
    await downloadFiles([spec('a.mp3')], h.options);
    expect(h.calls[0].url).toBe(GSB_URL);
    expect(h.calls[0].init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' });
    expect(h.calls[0].init.headers).toBeUndefined();
  });

  it('accepts audio/mp3, octet-stream and a missing content type', async () => {
    for (const type of ['audio/mp3', 'application/octet-stream', 'binary/octet-stream', null]) {
      const h = harness([() => stream(MP3, { type })]);
      const r = await downloadFiles([spec('a.mp3')], h.options);
      expect(r.ok, String(type)).toHaveLength(1);
    }
  });

  it('recognises a web page instead of the file, by type or by content', async () => {
    const page = harness([() => text('<!doctype html><title>Bitte zustimmen</title>', 200)]);
    const r1 = await downloadFiles([spec('a.mp3'), spec('b.mp3')], page.options);
    expect(r1.failed[0].error.code).toBe('not-audio');
    expect(r1.skipped.map((f) => f.name)).toEqual(['b.mp3']);

    const disguised = harness([() => stream(new TextEncoder().encode('\n  <html><body>Fehler</body></html>'), { type: 'application/octet-stream' })]);
    const r2 = await downloadFiles([spec('a.mp3')], disguised.options);
    expect(r2.failed[0].error.code).toBe('not-audio');
  });

  it('skips an episode that is gone and goes on with the next', async () => {
    const h = harness([() => text('Not found', 404), () => stream(MP3)]);
    const r = await downloadFiles([spec('alt.mp3'), spec('neu.mp3')], h.options);
    expect(r.failed.map((f) => [f.file.name, f.error.code, f.error.status])).toEqual([['alt.mp3', 'gone', 404]]);
    expect(r.ok.map((f) => f.file.name)).toEqual(['neu.mp3']);
    expect(r.skipped).toEqual([]);
  });

  it('stops when the publisher is busy for longer than a minute', async () => {
    const h = harness([() => text('Too many', 429, { 'retry-after': '120' }), () => stream(MP3)]);
    const r = await downloadFiles([spec('a.mp3'), spec('b.mp3')], h.options);
    expect(h.calls).toHaveLength(1);
    expect(h.waits).toEqual([]);
    const e = r.failed[0].error;
    expect([e.code, e.status, e.retryAfterSec]).toEqual(['busy', 429, 120]);
    expect(r.skipped.map((f) => f.name)).toEqual(['b.mp3']);
    expect(messageFor(e, 'a')).toBe('Der Anbieter bekommt gerade zu viele Anfragen. Versuche es in 2 Minuten noch einmal.');
  });

  it('waits once as asked when the publisher is busy for a short time', async () => {
    const h = harness([() => text('Busy', 503, { 'retry-after': '5' }), () => stream(MP3)]);
    const r = await downloadFiles([spec('a.mp3')], h.options);
    expect(h.waits).toEqual([5000]);
    expect(r.ok).toHaveLength(1);
  });

  it('waits 15 seconds once when the browser does not let us read Retry-After', async () => {
    // Retry-After is not a CORS-safelisted header: across origins the browser hides it unless the server exposes it.
    const h = harness([() => text('Busy', 503), () => stream(MP3)]);
    const r = await downloadFiles([spec('a.mp3')], h.options);
    expect(h.waits).toEqual([BUSY_FALLBACK_SEC * 1000]);
    expect(r.ok).toHaveLength(1);

    const still = harness([() => text('Busy', 429)]);
    const r2 = await downloadFiles([spec('a.mp3'), spec('b.mp3')], still.options);
    expect(still.waits).toEqual([15_000]);
    expect(still.calls).toHaveLength(2);
    expect(r2.failed[0].error.code).toBe('busy');
    expect(r2.skipped).toHaveLength(1);
  });

  it('gives up on a file that stops sending, tries it once more and keeps the files already loaded', async () => {
    /** Sends one chunk, then nothing, until the request is cut. */
    const stalled = (signal?: AbortSignal | null) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(MP3.slice(0, 64 * 1024));
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
        pull: () => new Promise<void>(() => undefined),
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(MP3.length) } });
    };
    let n = 0;
    const h = harness([], {
      idleMs: 20,
      fetch: async (url, init) => {
        n++;
        return url.endsWith('a') ? stream(MP3) : stalled(init.signal);
      },
    });
    const r = await downloadFiles([spec('a.mp3', GSB_URL + '&a'), spec('b.mp3'), spec('c.mp3')], h.options);
    expect(r.ok.map((x) => x.file.name)).toEqual(['a.mp3']);
    expect(r.failed.map((x) => [x.file.name, x.error.code])).toEqual([['b.mp3', 'incomplete']]);
    expect(r.skipped.map((f) => f.name)).toEqual(['c.mp3']);
    expect(h.waits).toEqual([RETRY_DELAY_MS]);
    expect(n).toBe(3);
  });

  it('gives up when no answer comes at all', async () => {
    const h = harness([], {
      idleMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    const r = await downloadFiles([spec('a.mp3')], h.options);
    expect(r.failed[0].error.code).toBe('network');
    expect(h.waits).toEqual([RETRY_DELAY_MS]);
  });

  it('cancelling still means cancelling, not a stalled file', async () => {
    const ctrl = new AbortController();
    const h = harness([], {
      idleMs: 10_000,
      signal: ctrl.signal,
      fetch: (_url, init) => {
        setTimeout(() => ctrl.abort(), 5);
        return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      },
    });
    await expect(downloadFiles([spec('a.mp3')], h.options)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('refuses a file that was passed through a measurement service', async () => {
    const h = harness([
      () => {
        const res = stream(MP3);
        Object.defineProperty(res, 'url', { value: 'https://dts.podtrac.com/redirect.mp3/media.example/a.mp3' });
        return res;
      },
    ]);
    const r = await downloadFiles([spec('a.mp3'), spec('b.mp3')], h.options);
    expect(r.failed[0].error.code).toBe('blocked');
    expect(r.skipped).toHaveLength(1);
    expect(messageFor(r.failed[0].error, 'Folge 1')).toBe('Der Anbieter gibt „Folge 1“ gerade über einen Dienst heraus, der Downloads zählt. Darum laden wir die Datei nicht. Wir schauen uns das an.');
  });

  it('tries a broken connection once more after 3 seconds', async () => {
    const failing = () => Promise.reject(new TypeError('Failed to fetch'));
    const h = harness([failing, () => stream(MP3)]);
    const r = await downloadFiles([spec('a.mp3')], h.options);
    expect(h.waits).toEqual([RETRY_DELAY_MS]);
    expect(r.ok).toHaveLength(1);

    const twice = harness([failing]);
    const r2 = await downloadFiles([spec('a.mp3'), spec('b.mp3')], twice.options);
    expect(twice.calls).toHaveLength(2);
    expect(r2.failed[0].error.code).toBe('network');
    expect(r2.skipped).toHaveLength(1);
  });

  it('says offline when the browser is offline, without trying again', async () => {
    const h = harness([() => Promise.reject(new TypeError('Failed to fetch'))], { isOnline: () => false });
    const r = await downloadFiles([spec('a.mp3')], h.options);
    expect(h.calls).toHaveLength(1);
    expect(r.failed[0].error.code).toBe('offline');
  });

  it('finds files that came incomplete and tries them once more', async () => {
    const short = () => stream(MP3.slice(0, 200_000), { length: MP3.length });
    const h = harness([short, () => stream(MP3)]);
    const r = await downloadFiles([spec('a.mp3')], h.options);
    expect(h.waits).toEqual([RETRY_DELAY_MS]);
    expect(r.ok).toHaveLength(1);

    const broken = harness([() => stream(MP3, { failAfter: 128 * 1024 })]);
    const r2 = await downloadFiles([spec('a.mp3')], broken.options);
    expect(r2.failed[0].error.code).toBe('incomplete');
    expect(broken.calls).toHaveLength(2);

    const tooSmall = harness([() => stream(MP3, { length: null })]);
    const r3 = await downloadFiles([spec('a.mp3', GSB_URL, 2_000_000)], tooSmall.options);
    expect(r3.failed[0].error.code).toBe('incomplete');
  });

  it('reports other HTTP errors with their status', async () => {
    const h = harness([() => text('Forbidden', 403)]);
    const r = await downloadFiles([spec('a.mp3')], h.options);
    const e = r.failed[0].error;
    expect([e.code, e.status]).toEqual(['http', 403]);
    expect(messageFor(e, 'a')).toBe('Der Anbieter hat die Datei nicht herausgegeben (Fehler 403). Versuche es später noch einmal.');
  });

  it('keeps a second between requests to archive.org', async () => {
    const archive = (n: number) => spec(`${n}.mp3`, `https://archive.org/download/jamendo-139374/0${n}-song.mp3`);
    const h = harness([() => stream(MP3)]);
    const r = await downloadFiles([archive(1), archive(2), spec('gitlab.mp3'), archive(3)], h.options);
    expect(r.ok).toHaveLength(4);
    // The fake clock does not move while loading: the second and the last archive.org request wait the full gap.
    expect(h.waits).toEqual([ARCHIVE_GAP_MS, ARCHIVE_GAP_MS]);
  });

  it('stops at once when cancelled', async () => {
    const ctrl = new AbortController();
    const h = harness(
      [
        () => {
          ctrl.abort();
          return Promise.reject(new DOMException('Abgebrochen', 'AbortError'));
        },
      ],
      { signal: ctrl.signal },
    );
    const p = downloadFiles([spec('a.mp3'), spec('b.mp3')], h.options);
    await expect(p).rejects.toBeInstanceOf(DownloadError);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(messageFor(new DownloadError('aborted', 'a.mp3'), 'a')).toBe('Abgebrochen. Es wurde nichts auf die SD-Karte geschrieben.');
  });
});

describe('sniffAudio', () => {
  const bytes = (...parts: (string | number[])[]) => {
    const out: number[] = [];
    for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
    return new Uint8Array(out);
  };

  it('knows the usual audio formats by their first bytes', () => {
    expect(sniffAudio(MP3.slice(0, 4096), 'a.mp3')).toBe(true);
    expect(sniffAudio(bytes([0, 0, 0xff, 0xfb, 0x90, 0x64]), 'a.mp3')).toBe(true);
    expect(sniffAudio(bytes('OggS', [0, 2]), 'a.ogg')).toBe(true);
    expect(sniffAudio(bytes('OggS', [0, 2]), 'a.opus')).toBe(true);
    expect(sniffAudio(bytes([0, 0, 0, 0x20], 'ftypM4A '), 'a.m4a')).toBe(true);
    expect(sniffAudio(bytes([0xff, 0xf1, 0x50, 0x80]), 'a.aac')).toBe(true);
    expect(sniffAudio(bytes('fLaC'), 'a.flac')).toBe(true);
    expect(sniffAudio(bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'a.wav')).toBe(true);
  });

  it('refuses web pages and files that do not match their extension', () => {
    expect(sniffAudio(bytes('<!DOCTYPE html>'), 'a.mp3')).toBe(false);
    expect(sniffAudio(bytes([0xef, 0xbb, 0xbf], '  <?xml version="1.0"?>'), 'a.unknown')).toBe(false);
    expect(sniffAudio(bytes('OggS'), 'a.mp3')).toBe(false);
    expect(sniffAudio(bytes('ID3'), 'a.ogg')).toBe(false);
    expect(sniffAudio(bytes('xyz'), 'a.unknown')).toBe(true);
    expect(sniffAudio(new Uint8Array(0), 'a.unknown')).toBe(false);
  });
});

describe('messages', () => {
  it('reads Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-10-05T10:00:00Z');
    expect(parseRetryAfter('90', now)).toBe(90);
    expect(parseRetryAfter('Mon, 05 Oct 2026 10:05:00 GMT', now)).toBe(300);
    expect(parseRetryAfter('bald', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('explains every failure in plain words', () => {
    const e = (code: DownloadError['code'], o: { status?: number; retryAfterSec?: number } = {}) => new DownloadError(code, 'x.mp3', o);
    expect(messageFor(e('network'), 'Kapitel 7')).toBe(
      '„Kapitel 7“ ließ sich nicht laden. Prüfe deine Internetverbindung und versuche es noch einmal. Klappt es weiter nicht, öffne die Folge auf der Webseite und lade sie dort herunter.',
    );
    // An album's song is no "Folge".
    expect(messageFor(e('network'), 'Hänsel und Gretel', { part: 'Lied' })).toMatch(/öffne das Lied auf der Webseite und lade es dort herunter\.$/);
    expect(messageFor(e('not-audio'), 'x', { part: 'Titel' })).toBe('Statt der Hördatei kam eine Webseite zurück. Öffne den Titel auf der Webseite des Anbieters.');
    expect(messageFor(e('offline'), 'x')).toBe('Du bist offline. Verbinde dich mit dem Internet und versuche es noch einmal.');
    expect(messageFor(e('gone'), 'Das Mammut')).toBe('„Das Mammut“ ist beim Anbieter nicht mehr online. Podcasts bleiben oft nur eine Zeit lang verfügbar.');
    expect(messageFor(e('gone'), 'Schulkleidung', { podcast: false })).toBe('„Schulkleidung“ ist beim Anbieter nicht mehr online.');
    expect(messageFor(e('busy'), 'x')).toBe('Der Anbieter bekommt gerade zu viele Anfragen. Versuche es in ein paar Minuten noch einmal.');
    expect(messageFor(e('busy', { retryAfterSec: 30 }), 'x')).toBe('Der Anbieter bekommt gerade zu viele Anfragen. Versuche es in einer Minute noch einmal.');
    expect(messageFor(e('not-audio'), 'x')).toBe('Statt der Hördatei kam eine Webseite zurück. Öffne die Folge auf der Webseite des Anbieters.');
    expect(messageFor(e('incomplete'), 'x')).toBe('Die Datei kam nicht vollständig an. Versuche es noch einmal.');
  });
});

/** A server of one file that answers byte ranges (206 with Content-Range), as OHRKA's does. */
function rangeServer(bytes: Uint8Array, o: { ignoreRange?: boolean; star?: boolean; throwOn?: number[]; redirect?: string; wrongStart?: number } = {}) {
  const calls: { url: string; range: string | null }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const range = new Headers(init.headers).get('range');
    calls.push({ url, range });
    if (init.signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    if (o.throwOn?.includes(calls.length)) throw new TypeError('network error');
    if (o.redirect && calls.length === 1) return new Response(null, { status: 302, headers: { location: o.redirect } });
    if (o.ignoreRange || !range) return new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) } });
    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const first = Number(m[1]);
    if (first >= bytes.length) return new Response(null, { status: 416 });
    const last = Math.min(Number(m[2]), bytes.length - 1);
    const shownFirst = o.wrongStart !== undefined && calls.length > 1 ? o.wrongStart : first;
    return new Response(bytes.slice(first, last + 1), {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes ${shownFirst}-${last}/${o.star ? '*' : bytes.length}`, 'content-length': String(last - first + 1) },
    });
  };
  return { fetch, calls };
}

/** Byte for byte the test MP3 (cheaper than a deep comparison of half a million numbers). */
async function sameAsMp3(data: Blob | Response): Promise<boolean> {
  return Buffer.from(await data.arrayBuffer()).equals(Buffer.from(MP3));
}

const OHRKA_FILE = 'https://www.ohrka.de/fileadmin/audio/Alice/Alice.mp3';
const onOhrka = (url: string) => new URL(url).hostname === 'www.ohrka.de';

describe('rangedFetch', SLOW, () => {
  const PIECE = 100_000;
  const quiet = (waits: number[] = []) => ({ allowed: onOhrka, pieceBytes: PIECE, wait: async (ms: number) => void waits.push(ms), now: () => 0 });

  it('reads Content-Range', () => {
    expect(parseContentRange('bytes 0-4194303/242157414')).toEqual({ first: 0, last: 4194303, total: 242157414 });
    expect(parseContentRange('bytes 5-9/*')).toEqual({ first: 5, last: 9, total: undefined });
    expect(parseContentRange('bytes 9-5/20')).toBeUndefined();
    expect(parseContentRange('bytes 0-20/20')).toBeUndefined();
    expect(parseContentRange(null)).toBeUndefined();
  });

  it('loads a file in pieces, one after the other with a second between their starts, and downloadFiles gets it whole', async () => {
    const server = rangeServer(MP3);
    const waits: number[] = [];
    let t = 0;
    const fetch = rangedFetch(server.fetch, { allowed: onOhrka, pieceBytes: PIECE, wait: async (ms) => void (waits.push(ms), (t += ms)), now: () => t });
    const h = harness([], { fetch });
    const r = await downloadFiles([spec('Alice.mp3', OHRKA_FILE)], h.options);
    expect(r.failed).toEqual([]);
    expect(await sameAsMp3(r.ok[0].blob)).toBe(true);
    const pieces = Math.ceil(MP3.length / PIECE);
    expect(server.calls.map((c) => c.range)).toEqual(Array.from({ length: pieces }, (_, i) => `bytes=${i * PIECE}-${i * PIECE + PIECE - 1}`));
    expect(waits).toEqual(Array(pieces - 1).fill(1000));
    // The list knows no size: the length the server named is the whole.
    expect(h.progress[h.progress.length - 1]).toEqual({ fileIndex: 0, files: 1, bytes: MP3.length, totalBytes: MP3.length });
  });

  it('asks for a piece once more after a broken connection', async () => {
    const server = rangeServer(MP3, { throwOn: [3] });
    const waits: number[] = [];
    const res = await rangedFetch(server.fetch, quiet(waits))(OHRKA_FILE, {});
    expect(await sameAsMp3(res)).toBe(true);
    expect(server.calls[2].range).toBe(server.calls[3].range);
    expect(waits).toContain(2000);
  });

  it('follows a redirect only to the publisher’s own files and asks there for every piece', async () => {
    const moved = 'https://www.ohrka.de/fileadmin/audio/neu/Alice.mp3';
    const server = rangeServer(MP3, { redirect: moved });
    const res = await rangedFetch(server.fetch, quiet())(OHRKA_FILE, {});
    expect(await sameAsMp3(res)).toBe(true);
    expect(res.url).toBe(moved);
    expect(server.calls.slice(1).every((c) => c.url === moved)).toBe(true);
    const away = rangeServer(MP3, { redirect: 'https://cdn.example/Alice.mp3' });
    const refused = await rangedFetch(away.fetch, quiet())(OHRKA_FILE, {});
    expect(refused.status).toBe(302);
    expect(away.calls).toHaveLength(1);
  });

  it('hands on the whole file of a server without ranges, and a file of unknown length to its end', async () => {
    const whole = await rangedFetch(rangeServer(MP3, { ignoreRange: true }).fetch, quiet())(OHRKA_FILE, {});
    expect(whole.status).toBe(200);
    expect(await sameAsMp3(whole)).toBe(true);
    const star = await rangedFetch(rangeServer(MP3, { star: true }).fetch, quiet())(OHRKA_FILE, {});
    expect(star.headers.get('content-length')).toBeNull();
    expect(await sameAsMp3(star)).toBe(true);
  });

  it('breaks off when a piece does not fit, and downloadFiles reports the file as incomplete', async () => {
    const fetch = rangedFetch(rangeServer(MP3, { wrongStart: 0 }).fetch, quiet());
    const h = harness([], { fetch });
    const r = await downloadFiles([spec('Alice.mp3', OHRKA_FILE)], h.options);
    expect(r.ok).toEqual([]);
    expect(r.failed[0].error.code).toBe('incomplete');
  });

  it('stops asking when the download is cancelled', async () => {
    const server = rangeServer(MP3);
    const ctrl = new AbortController();
    const res = await rangedFetch(server.fetch, quiet())(OHRKA_FILE, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(server.calls).toHaveLength(2);
  });
});
