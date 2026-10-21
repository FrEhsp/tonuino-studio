/**
 * Where the time goes in one measurement (Chromium): runs it once with the
 * DevTools trace on and prints what the main thread did (script, style,
 * layout, paint, …) and the slowest script functions. For finding causes,
 * not for comparing versions (run.mjs does that).
 *
 *   node scripts/bench/profile.mjs [--ref WORKTREE|COMMIT|dir:PATH] [--what shelf|folder|start|player] [--throttle 4] [--trace out.json] [--callers toBlob]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_TMP, ensureCard, LONG_FOLDER } from './card.mjs';
import { PROBE, serve } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ref = arg('ref', 'WORKTREE');
const what = arg('what', 'shelf');
const throttle = Number(arg('throttle', '4'));
// "dir:PATH": a web app already built into PATH (as in run.mjs).
const prebuilt = ref.startsWith('dir:') ? ref.slice(4) : null;
const label = prebuilt ? 'dir' : ref === 'WORKTREE' ? 'worktree' : execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=10', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const dist = prebuilt ?? join(BENCH_TMP, `dist-${label}`);
if (!prebuilt && (ref === 'WORKTREE' || !existsSync(join(dist, 'index.html')))) execFileSync(join(HERE, 'build-ref.sh'), [ref, dist], { stdio: 'inherit' });

/** Positions in the built scripts back to the source (the build writes source maps), with a small VLQ decoder. */
const maps = new Map();
function sourceMap(file) {
  if (maps.has(file)) return maps.get(file);
  let m = null;
  try {
    const raw = JSON.parse(readFileSync(join(dist, 'assets', `${file}.map`), 'utf8'));
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lines = raw.mappings.split(';').map(() => []);
    let src = 0;
    let sl = 0;
    raw.mappings.split(';').forEach((line, li) => {
      let col = 0;
      for (const seg of line.split(',')) {
        if (!seg) continue;
        const v = [];
        let shift = 0;
        let val = 0;
        for (const ch of seg) {
          const d = B64.indexOf(ch);
          val += (d & 31) << shift;
          if (d & 32) shift += 5;
          else {
            v.push(val & 1 ? -(val >> 1) : val >> 1);
            val = 0;
            shift = 0;
          }
        }
        col += v[0];
        if (v.length >= 4) {
          src += v[1];
          sl += v[2];
          lines[li].push([col, src, sl]);
        }
      }
    });
    m = { lines, sources: raw.sources };
  } catch {
    m = null;
  }
  maps.set(file, m);
  return m;
}
function original(url, line, col) {
  const file = String(url || '').split('/').pop();
  const m = file && sourceMap(file);
  if (!m) return null;
  const segs = m.lines[line] ?? [];
  let best = null;
  for (const s of segs) if (s[0] <= col) best = s;
  return best ? `${m.sources[best[1]].replace(/^(\.\.\/)+/, '')}:${best[2] + 1}` : null;
}

const card = await ensureCard();
const server = await serve(dist, card);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, locale: 'de-DE' });
  await context.addInitScript(PROBE);
  // Experiments only: a style sheet over the app's (BENCH_EXTRA_CSS=file.css), to see what a rule costs.
  if (process.env.BENCH_EXTRA_CSS) {
    const css = readFileSync(process.env.BENCH_EXTRA_CSS, 'utf8');
    await context.addInitScript((c) => document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: c }))), css);
  }
  const setupPage = await context.newPage();
  await setupPage.goto(`${server.url}__bench/blank.html`);
  await setupPage.evaluate(() => window.__bench.setup());
  await setupPage.close();
  // One start first, so stickers are drawn and kept like on any later start.
  const warm = await context.newPage();
  await warm.goto(server.url);
  await warm.evaluate(() => window.__bench.run('start'));
  await warm.evaluate(() => window.__bench.run('shelf'));
  await warm.evaluate(() => window.__bench.run('settle'));
  await warm.close();

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const traced = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  const begin = () => cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler' + (process.env.BENCH_TRACE_STACKS ? ',disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.timeline.invalidationTracking' : ''), options: 'sampling-frequency=1000' });
  if (what === 'start') await begin();
  await page.goto(server.url);
  if (what !== 'start') {
    await page.evaluate(() => window.__bench.run('start'));
    if (what === 'folder' || what === 'player') await page.evaluate((f) => (location.hash = `#/ordner/${String(f).padStart(2, '0')}`), LONG_FOLDER);
    await page.waitForTimeout(what === 'open' ? 6000 : Number(arg('wait', 2500)));
    await begin();
  }
  // "open": only opening the long folder (the shelf shows before).
  const result =
    what === 'open'
      ? await page.evaluate(async (f) => {
          const t0 = performance.now();
          location.hash = `#/ordner/${String(f).padStart(2, '0')}`;
          for (;;) {
            await new Promise((r) => requestAnimationFrame(r));
            const rows = document.querySelectorAll('.page-slot:not(.page-slot-hidden) .track-list .list-row').length;
            if (rows > 20) break;
          }
          await new Promise((r) => setTimeout(r, 1500));
          return { openedMs: performance.now() - t0 };
        }, LONG_FOLDER)
      : await page.evaluate(([n, f]) => window.__bench.run(n, { folder: f }), [what, LONG_FOLDER]);
  await cdp.send('Tracing.end');
  await traced;
  const out = arg('trace', null);
  if (out) writeFileSync(out, JSON.stringify({ traceEvents: events }));

  // Main thread of the page: the renderer thread named CrRendererMain.
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const mine = events.filter((e) => main && e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && e.dur);
  const byName = new Map();
  for (const e of mine) byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur / 1000);
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(JSON.stringify(result, null, 1).slice(0, 1500));
  console.log('\nHauptthread (ms, Ereignisse überlappen sich):');
  for (const [n, ms] of top) console.log(`  ${ms.toFixed(0).padStart(7)}  ${n}`);
  // Script functions by self time, from the sampling profile.
  const nodes = new Map();
  const self = new Map();
  const parents = new Map();
  // --callers NAME: whose calls the time of that function is (the call chain, five steps up).
  const callersOf = arg('callers', null);
  const callers = new Map();
  const name = (f) => `${f.functionName || '(anonym)'} ${original(f.url, f.lineNumber, f.columnNumber) ?? `${String(f.url || '').split('/').pop()}:${f.lineNumber}`}`;
  for (const e of events) {
    if (e.name !== 'ProfileChunk') continue;
    const cp = e.args?.data?.cpuProfile;
    for (const n of cp?.nodes ?? []) {
      nodes.set(`${e.id}:${n.id}`, n.callFrame);
      if (n.parent) parents.set(`${e.id}:${n.id}`, `${e.id}:${n.parent}`);
    }
    const deltas = e.args?.data?.timeDeltas ?? [];
    (cp?.samples ?? []).forEach((s, i) => {
      const f = nodes.get(`${e.id}:${s}`);
      if (!f) return;
      const k = name(f);
      self.set(k, (self.get(k) ?? 0) + (deltas[i] ?? 0) / 1000);
      if (callersOf && f.functionName === callersOf) {
        const chain = [];
        for (let p = parents.get(`${e.id}:${s}`); p && chain.length < 5; p = parents.get(p)) chain.push(name(nodes.get(p)));
        const c = chain.join(' ← ');
        callers.set(c, (callers.get(c) ?? 0) + (deltas[i] ?? 0) / 1000);
      }
    });
  }
  console.log('\nSkript, eigene Zeit (ms):');
  for (const [n, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${ms.toFixed(0).padStart(7)}  ${n}`);
  if (callersOf) {
    console.log(`\nAufgerufen von (${callersOf}, ms):`);
    for (const [n, ms] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${ms.toFixed(0).padStart(7)}  ${n}`);
  }
} finally {
  await browser.close();
  await server.close();
}
