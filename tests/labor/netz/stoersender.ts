/**
 * Bad internet for the test bench (TODO #69): a local web server that
 * stands in for every service the app asks (iTunes, MusicBrainz, Cover Art
 * Archive, ARASAAC, the list of "Entdecken" and its publishers) and answers
 * the way a bad connection does. The app's own fetch code talks to it over
 * real sockets, so timeouts, aborted bodies and refused connections are
 * the real ones of the network stack.
 *
 *   ok          a plausible answer
 *   offline     connection refused (no network; navigator.onLine is false)
 *   hang        the connection is accepted, no answer ever comes
 *   stall       headers and a first part of the body, then nothing more
 *   slow        the whole answer, 32 bytes per second
 *   429, 503    busy, with Retry-After
 *   500         an error page
 *   garbage     200 with an HTML page instead of JSON or a picture
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type Weather = 'ok' | 'offline' | 'hang' | 'stall' | 'slow' | '429' | '503' | '500' | 'garbage';

export interface Answer {
  status?: number;
  type: string;
  body: Uint8Array | string;
}

/** What the services answer when all is well, by host. */
export type Canned = (url: URL) => Answer;

export class Stoersender {
  private server!: Server;
  private port = 0;
  /** A port nothing listens on: "connection refused". */
  private deadPort = 0;
  private readonly sockets = new Set<Socket>();
  private rules: { test: (url: URL) => boolean; weather: Weather }[] = [];
  /** Every request the app made, by its real address. */
  readonly seen: { url: string; method: string; weather: Weather }[] = [];
  retryAfterSec = 2;

  constructor(private readonly canned: Canned) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.answer(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    // Bind and close at once: the port stays free, connecting to it is refused.
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    this.deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** The weather for all requests whose address matches; later rules win. Without a pattern: everything. */
  set(weather: Weather, pattern?: RegExp): void {
    this.rules.push({ test: (u) => !pattern || pattern.test(u.href), weather });
  }

  clear(): void {
    this.rules = [];
    this.seen.length = 0;
  }

  weatherFor(url: URL): Weather {
    for (let i = this.rules.length - 1; i >= 0; i--) if (this.rules[i].test(url)) return this.rules[i].weather;
    return 'ok';
  }

  /** navigator.onLine as the browser would say it: false only when everything is offline. */
  isOnline = (): boolean => this.weatherFor(new URL('https://example.org/')) !== 'offline';

  /** The app's fetch, sent through the bad connection. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const weather = this.weatherFor(url);
    const port = weather === 'offline' ? this.deadPort : this.port;
    const headers = new Headers(init?.headers);
    headers.set('x-labor-url', url.href);
    const { referrerPolicy: _r, credentials: _c, mode: _m, cache: _k, ...rest } = init ?? {};
    const res = await fetch(`http://127.0.0.1:${port}/`, { ...rest, headers });
    // The app looks at res.url for redirects: give it the address it asked for.
    Object.defineProperty(res, 'url', { value: url.href });
    return res;
  };

  private answer(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(String(req.headers['x-labor-url']));
    const weather = this.weatherFor(url);
    this.seen.push({ url: url.href, method: req.method ?? 'GET', weather });
    const good = this.canned(url);
    const body = typeof good.body === 'string' ? Buffer.from(good.body) : Buffer.from(good.body);
    switch (weather) {
      case 'hang':
        return; // the socket stays open, nothing comes
      case '429':
      case '503':
        res.writeHead(Number(weather), { 'content-type': 'text/plain', 'retry-after': String(this.retryAfterSec) }).end('Too busy');
        return;
      case '500':
        res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>Internal Server Error</h1>');
        return;
      case 'garbage':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Anmeldung</title><p>Bitte im WLAN anmelden</p>');
        return;
      case 'stall':
        res.writeHead(good.status ?? 200, { 'content-type': good.type, 'content-length': String(body.length) });
        res.write(body.subarray(0, Math.max(1, Math.floor(body.length / 3))));
        return; // the rest never comes
      case 'slow': {
        res.writeHead(good.status ?? 200, { 'content-type': good.type, 'content-length': String(body.length) });
        let at = 0;
        const step = () => {
          if (res.destroyed) return;
          if (at >= body.length) return void res.end();
          res.write(body.subarray(at, at + 8));
          at += 8;
          setTimeout(step, 250);
        };
        step();
        return;
      }
      default:
        if (req.method === 'HEAD') {
          res.writeHead(good.status ?? 200, { 'content-type': good.type, 'content-length': String(body.length) }).end();
          return;
        }
        res.writeHead(good.status ?? 200, { 'content-type': good.type, 'content-length': String(body.length) }).end(body);
    }
  }
}
