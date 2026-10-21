/**
 * The browser's way of printing for the test bench (TODO #69, #85): the
 * print area that printSheets (src/features/stickers/print.ts) puts into
 * the page, with the app's own printCss, printed by a real Chromium through
 * its DevTools protocol (Page.printToPDF is what "Als PDF speichern" in the
 * print dialog does). `scale` is the dialog's "Skalieren" (100 % or "An
 * Seite anpassen").
 *
 * Chromium comes from Playwright's browser folder (PLAYWRIGHT_BROWSERS_PATH,
 * /opt/pw-browsers, ~/.cache/ms-playwright) or the system; no npm package.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { printCss, type PrintPage } from '../../../src/features/stickers/print';

/** A Chromium (or its headless shell) on this computer, or null. */
export function findChromium(): string | null {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(homedir(), '.cache/ms-playwright')].filter((r): r is string => !!r);
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const e of entries) {
      for (const bin of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
        const p = join(root, e, bin);
        if (/^chromium/.test(e) && existsSync(p)) return p;
      }
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(p)) return p;
  return null;
}

/**
 * The page as printSheets leaves it when it calls window.print(): the app
 * (to be hidden), the style with printCss and the print root with one
 * picture per sheet.
 */
export function printPage(sheets: Uint8Array[], page: PrintPage): string {
  const imgs = sheets.map((png, i) => `<img alt="Bogen ${i + 1}" src="data:image/png;base64,${Buffer.from(png).toString('base64')}">`).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>TonUINO Studio</title>
<style>body { font: 16px sans-serif; margin: 24px; } .app { min-height: 1400px; border: 4px solid #333; padding: 40px; }</style>
<style id="sticker-print-style">${printCss(page)}</style></head>
<body><div id="app" class="app"><h1>Sticker</h1><p>Die App selbst darf nicht mitgedruckt werden.</p></div>
<div id="sticker-print-root" aria-hidden="true">${imgs}</div></body></html>`;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class Chromium {
  private ws!: WebSocket;
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly events: { method: string; sessionId?: string }[] = [];

  private constructor(
    private readonly proc: ChildProcess,
    private readonly profile: string,
  ) {}

  static async start(binary: string, tmp: string): Promise<Chromium> {
    const profile = mkdtempSync(join(tmp, 'chromium-'));
    const proc = spawn(binary, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const url = await new Promise<string>((resolve, reject) => {
      let err = '';
      const t = setTimeout(() => reject(new Error(`Chromium meldet sich nicht: ${err.slice(-500)}`)), 30_000);
      proc.stderr!.on('data', (d: Buffer) => {
        err += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
      proc.once('exit', (code) => reject(new Error(`Chromium endete (${code}): ${err.slice(-500)}`)));
    });
    const c = new Chromium(proc, profile);
    c.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = () => reject(new Error('DevTools-Verbindung scheitert'));
    });
    c.ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id)!;
        c.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) c.events.push({ method: msg.method, sessionId: msg.sessionId });
    };
    return c;
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  /** Opens `html` (written to a file) and prints it to PDF as the print dialog would, at `scale`. */
  async printToPdf(html: string, scale = 1): Promise<Uint8Array> {
    const file = join(this.profile, `page-${this.next}.html`);
    writeFileSync(file, html);
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    try {
      await this.send('Page.enable', {}, sessionId);
      const seen = this.events.length;
      await this.send('Page.navigate', { url: `file://${file}` }, sessionId);
      const end = Date.now() + 30_000;
      while (!this.events.slice(seen).some((e) => e.method === 'Page.loadEventFired' && e.sessionId === sessionId)) {
        if (Date.now() > end) throw new Error('Seite lädt nicht');
        await new Promise((r) => setTimeout(r, 50));
      }
      // As printSheets: every picture decoded before the dialog takes its picture of the page.
      await this.send('Runtime.evaluate', { expression: 'Promise.all([...document.images].map((i) => i.decode()))', awaitPromise: true }, sessionId);
      const { data } = await this.send<{ data: string }>('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, scale, displayHeaderFooter: false }, sessionId);
      return new Uint8Array(Buffer.from(data, 'base64'));
    } finally {
      await this.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    try {
      await Promise.race([this.send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      // already gone
    }
    this.ws.close();
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    rmSync(this.profile, { recursive: true, force: true });
  }
}
