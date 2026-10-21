/**
 * Speed comparison of two (or more) versions of TonUINO Studio, in the
 * browser, on the same made-up SD card (scripts/bench/README.md).
 *
 *   node scripts/bench/run.mjs [--refs 2a29ed0,WORKTREE] [--runs 3] [--engines chromium,webkit]
 *                              [--throttle 4] [--out DIR] [--only start,shelf,folder,player,import]
 *                              [--imports 1]
 *
 * A ref "dir:PATH" measures a web app already built into PATH.
 * Each version is built into BENCH_TMP (scripts/bench/build-ref.sh, a commit
 * once, WORKTREE every time), served from its own address and measured in
 * turns (A, B, A, B …) so a busy moment of the computer hits both alike.
 * Results: DIR/ergebnis.json and DIR/zusammenfassung.md (German, plain words).
 *
 * Environment: BENCH_TMP (default /tmp/tonuino-bench), CHROMIUM_PATH,
 * PLAYWRIGHT_MODULE (default "playwright"), WEBKIT_PYTHON (default python3.12),
 * BENCH_NOCARD=1 (start without a card).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_TMP, ensureCard, LONG_FOLDER } from './card.mjs';
import { PROBE, serve } from './server.mjs';
import { summarize } from './summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const refs = arg('refs', '2a29ed0,WORKTREE').split(',');
const runs = Number(arg('runs', '3'));
const engines = arg('engines', 'chromium').split(',');
const throttle = Number(arg('throttle', '4'));
const only = arg('only', 'start,shelf,folder,player,import').split(','); // also: pages (switching between the pages of the menu)
/** The import runs in the last N runs only (each page writes to its own copy of the card, in memory). */
const imports = Math.max(1, Math.min(runs, Number(arg('imports', '1'))));
const out = arg('out', join(BENCH_TMP, `ergebnis-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`));
const VIEW = { width: 1280, height: 820 };
const SCALE = 2;

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

/** Builds each version once (a commit is kept by its hash; the working tree is built anew). */
function build(ref) {
  // "dir:/path/to/dist": a version built elsewhere, measured as it is.
  if (ref.startsWith('dir:')) {
    const dist = ref.slice(4);
    const label = basename(dist).replace(/^dist-/, '');
    return { ref, label, dist, version: '', subject: `gebaut in ${dist}` };
  }
  const label = ref === 'WORKTREE' ? 'worktree' : execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=10', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const dist = join(BENCH_TMP, `dist-${label}`);
  if (ref === 'WORKTREE' || !existsSync(join(dist, 'index.html'))) {
    log(`baue ${ref} …`);
    execFileSync(join(HERE, 'build-ref.sh'), [ref, dist], { stdio: 'inherit' });
  }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  let subject = '';
  try {
    subject = ref === 'WORKTREE' ? 'Arbeitsstand (mit nicht eingecheckten Änderungen)' : execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%h %s', ref], { encoding: 'utf8' }).trim();
  } catch {
    /* only for the summary */
  }
  return { ref, label, dist, version, subject };
}

/* ------------------------------------------------------------------ Chromium */

async function chromiumRuns(targets, cardInfo) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
  const browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
  const results = {};
  // CPU time of the page processes and the GPU process: what a measurement cost, also on a busy computer
  // (the wall-clock values swing with other work on it; this much less).
  const sys = await browser.newBrowserCDPSession();
  const cpu = async () => {
    const { processInfo } = await sys.send('SystemInfo.getProcessInfo');
    const sum = (t) => processInfo.filter((p) => p.type === t).reduce((a, p) => a + p.cpuTime, 0) * 1000;
    return { page: sum('renderer'), gpu: sum('GPU') };
  };
  try {
    const contexts = new Map();
    for (const t of targets) {
      const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, locale: 'de-DE', timezoneId: 'Europe/Berlin', colorScheme: 'light' });
      await context.addInitScript(PROBE);
      // BENCH_NOCARD=1: the start without a card (nothing remembered, no shelf).
      if (!process.env.BENCH_NOCARD) {
        const page = await context.newPage();
        await page.goto(`${t.url}__bench/blank.html`);
        const s = await page.evaluate(() => window.__bench.setup());
        log(`chromium ${t.label}: Karte eingerichtet (${s.files} Dateien)`);
        await page.close();
      }
      contexts.set(t.label, context);
      results[t.label] = [];
    }
    // Run 0 is the first start (stickers are drawn for the first time); runs 1… are later starts.
    for (let r = 0; r <= runs; r++) {
      for (const t of targets) {
        const context = contexts.get(t.label);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        const cdp = await context.newCDPSession(page);
        if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        // The start counts from before the page loads.
        let before = await cpu();
        await page.goto(t.url);
        const one = { run: r, first: r === 0 };
        for (const name of only) {
          if (name === 'import' && r <= runs - imports) continue; // at the end: it changes the card for this page only
          try {
            const c0 = name === 'start' ? before : await cpu();
            one[name] = await page.evaluate(([n, o]) => window.__bench.run(n, o), [name, { folder: LONG_FOLDER }]);
            const c1 = await cpu();
            Object.assign(one[name], { cpuMs: Math.round(c1.page - c0.page), cpuGpuMs: Math.round(c1.gpu - c0.gpu) });
            before = c1;
          } catch (e) {
            one[name] = { error: String(e).split('\n')[0] };
          }
        }
        // Closed only when the app is done with its background work, as after a while of use.
        await page.evaluate(() => window.__bench.run('settle')).catch(() => undefined);
        if (errors.length) one.pageErrors = errors.slice(0, 5);
        results[t.label].push(one);
        log(`chromium ${t.label} Lauf ${r}: Start ruhig nach ${one.start?.stableMs} ms, Regal ${one.shelf?.fps} B/s, Ordner ${one.folder?.fps} B/s`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

/* ------------------------------------------------------------------ WebKitGTK */

function webkitRuns(targets) {
  const py = process.env.WEBKIT_PYTHON ?? 'python3.12';
  const script = join(HERE, 'webkit.py');
  const args = [script, '--runs', String(runs), '--imports', String(imports), '--only', only.join(','), '--folder', String(LONG_FOLDER), '--width', String(VIEW.width), '--height', String(VIEW.height)];
  for (const t of targets) args.push('--target', `${t.label}=${t.url}`);
  const cmd = process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? [py, ...args] : ['xvfb-run', '-a', '-s', `-screen 0 ${VIEW.width * SCALE}x${VIEW.height * SCALE + 200}x24`, py, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('nice', ['-n', '10', ...cmd], { env: { ...process.env, GDK_SCALE: String(SCALE), BENCH_PROBE: join(HERE, 'probe.js') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const results = {};
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith('RESULT ')) {
          const { label, run } = JSON.parse(line.slice(7));
          (results[label] ??= []).push(run);
          log(`webkit ${label} Lauf ${run.run}: Start ruhig nach ${run.start?.stableMs} ms, Regal ${run.shelf?.fps} B/s, Ordner ${run.folder?.fps} B/s`);
        } else if (line.trim()) log(`webkit: ${line}`);
      }
    });
    child.stderr.on('data', (d) => {
      const s = String(d);
      if (/Traceback|Error/.test(s)) process.stderr.write(s);
    });
    child.on('exit', (code) => (code === 0 ? resolve(results) : reject(new Error(`webkit.py endete mit ${code}`))));
  });
}

/* ------------------------------------------------------------------ main */

const cardInfo = await ensureCard();
log(`Messkarte: ${cardInfo.folders} Ordner, ${cardInfo.files} Dateien, ${(cardInfo.bytes / 1e6).toFixed(0)} MB`);
const targets = [];
for (const ref of refs) targets.push(build(ref));
const servers = [];
for (const t of targets) {
  const s = await serve(t.dist, cardInfo);
  servers.push(s);
  t.url = s.url;
}
const report = {
  zeit: new Date().toISOString(),
  rechner: { cpus: (await import('node:os')).cpus().length, load: (await import('node:os')).loadavg().map((x) => Math.round(x * 100) / 100) },
  karte: { ordner: cardInfo.folders, dateien: cardInfo.files, megabyte: Math.round(cardInfo.bytes / 1e6), langerOrdner: LONG_FOLDER },
  einstellungen: { laeufe: runs, cpuDrossel: throttle, fenster: `${VIEW.width}x${VIEW.height}`, bildschirmFaktor: SCALE, messungen: only },
  versionen: targets.map(({ ref, label, subject }) => ({ ref, label, subject })),
  engines: {},
};
try {
  for (const e of engines) {
    if (e === 'chromium') report.engines.chromium = await chromiumRuns(targets, cardInfo);
    else if (e === 'webkit') report.engines.webkit = await webkitRuns(targets);
    else throw new Error(`Unbekannte Engine ${e}`);
  }
} finally {
  for (const s of servers) await s.close();
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'ergebnis.json'), JSON.stringify(report, null, 1));
const text = summarize(report);
writeFileSync(join(out, 'zusammenfassung.md'), text);
console.log(`\n${text}\nGespeichert in ${out}`);
