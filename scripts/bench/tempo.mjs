/**
 * The speed check of 0.6 (TODO #121): is 0.6 anywhere slower than 0.5.1?
 * Four things, in Chromium with the CPU slowed down like a slow laptop:
 *
 *   start      from loading the page until the first screen is usable: its
 *              heading is drawn and the card is read (0.6: the card's name
 *              in the bar on top; 0.5.1: the shelf of Meine Box).
 *   wechsel    switching between the three tasks (0.6: Musik, Karte, Sticker;
 *              0.5.1: Hinzufügen, Karten, Sticker): from the click until the
 *              new page's heading is drawn. Each task's first visit from the
 *              start page half a second after the card was read („erstmals“,
 *              a fresh page each), and back and forth later („wieder“).
 *   sticker    the sticker sheet of all 52 folders: from opening „Sticker“
 *              (0.5.1: the click on „Alle 52 Ordner nehmen“) until the page
 *              stands still (nothing drawn or changed for QUIET_MS).
 *   liste      200 MP3 files picked under „Musik“ (0.5.1: „Hinzufügen“):
 *              until all 200 rows are there, and until the list stands still.
 *
 * The card is the made-up card of the speed comparison grown to 52 folders,
 * the files are 200 short MP3s (tempo-data.mjs). Each version gets its own
 * browser profile; before the runs it is started once (caches filled, as
 * for someone who used the app before). Versions take turns, the median of
 * the runs counts.
 *
 *   node scripts/bench/tempo.mjs --dist 0.5.1=PATH,0.6=PATH [--runs 3] [--throttle 4] [--out FILE.json]
 *                                [--only start,sticker,liste,erstmals]
 *
 * PATH is a built web app (vite build). Environment: CHROMIUM_PATH,
 * PLAYWRIGHT_MODULE as for run.mjs.
 */
import { writeFileSync } from 'node:fs';
import { PROBE, serve } from './server.mjs';
import { ensureTempoData, FOLDERS, TITLES } from './tempo-data.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const versions = arg('dist', '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [label, dist] = s.split('=');
    return { label, dist };
  });
if (!versions.length) throw new Error('--dist 0.5.1=PATH,0.6=PATH');
const runs = Number(arg('runs', '3'));
const throttle = Number(arg('throttle', '4'));
const out = arg('out', '');
const only = arg('only', 'start,sticker,liste,erstmals').split(',');
const VIEW = { width: 1440, height: 900 };
const QUIET_MS = 1500;
/** Set once the browser runs: the CPU time of its page processes so far, in ms. */
let cpuNow = async () => 0;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

/** In the page, before the app: when something was last drawn or changed in the page shown. */
const WATCH = `(() => {
  const t = (window.__tempo = { last: 0, draws: 0 });
  const mark = () => { t.last = performance.now(); };
  for (const proto of [CanvasRenderingContext2D.prototype, typeof OffscreenCanvasRenderingContext2D !== 'undefined' ? OffscreenCanvasRenderingContext2D.prototype : null]) {
    if (!proto) continue;
    for (const name of ['drawImage', 'putImageData', 'fillText']) {
      const orig = proto[name];
      proto[name] = function () { t.draws++; mark(); return orig.apply(this, arguments); };
    }
  }
  addEventListener('load', mark, true);
  const mo = new MutationObserver(mark);
  const begin = () => mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) begin(); else addEventListener('DOMContentLoaded', begin);
})();`;

/** Per version: the first screen, the three tasks and how „card read“ shows. */
const KIND = {
  0.5: {
    tasks: ['#/hinzufuegen', '#/karten', '#/sticker'],
    cardRead: () => !!document.querySelector('.main > .page-slot:not(.page-slot-hidden) .shelf .tile'),
  },
  0.6: {
    tasks: ['#/karte', '#/sticker', '#/musik'],
    cardRead: () => {
      const z = document.querySelector('.kopf .sd-zeile');
      const name = z && z.querySelector('.sd-name');
      return !!(z && name && z.getAttribute('aria-hidden') !== 'true' && name.textContent.trim() && !/gelesen/.test(z.textContent));
    },
  },
};
const kindOf = (label) => (label.startsWith('0.5') ? '0.5' : '0.6');

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

/** Waits in the page, frame by frame, until fn() is true; returns performance.now() of that frame or null. */
async function frameUntil(page, fnSrc, maxMs = 60000) {
  return page.evaluate(
    ([src, max]) =>
      new Promise((resolve) => {
        const fn = new Function(`return (${src})()`);
        const t0 = performance.now();
        const step = (t) => {
          let ok = false;
          try {
            ok = fn();
          } catch {
            /* being built */
          }
          if (ok) resolve(t);
          else if (t - t0 > max) resolve(null);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [fnSrc, maxMs],
  );
}

/** Waits until nothing was drawn or changed for QUIET_MS; returns the time of the last change. */
async function quietSince(page, since, maxMs = 90000) {
  return page.evaluate(
    ([from, quiet, max]) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        const check = () => {
          const now = performance.now();
          const last = Math.max(window.__tempo.last, from);
          if (now - last >= quiet || now - t0 > max) resolve(last);
          else setTimeout(check, 100);
        };
        check();
      }),
    [since, QUIET_MS, maxMs],
  );
}

const HEADING = `() => { const h = document.querySelector('.main > .page-slot:not(.page-slot-hidden) h1'); const r = h && h.getBoundingClientRect(); return !!(r && r.width >= 1 && r.height >= 1); }`;

/** One switch: from setting the address until the new page's heading is painted. */
async function switchTo(page, hash) {
  const t0 = await page.evaluate((h) => {
    // The page before may stay while the new one's code loads (App.tsx Pages): its heading does not count.
    window.__tempoBefore = document.querySelector('.main > .page-slot:not(.page-slot-hidden) h1');
    const t = performance.now();
    location.hash = h;
    return t;
  }, hash);
  const t = await frameUntil(
    page,
    `() => { const h = document.querySelector('.main > .page-slot:not(.page-slot-hidden) h1'); const r = h && h.getBoundingClientRect(); return !!(r && r.width >= 1 && h !== window.__tempoBefore); }`,
  );
  // One frame more: the one in which the new page is painted.
  const painted = await page.evaluate(() => new Promise((res) => requestAnimationFrame((x) => res(x))));
  return t === null ? null : Math.round(Math.max(t, painted) - t0);
}

async function startAndSwitch(page, v) {
  const k = KIND[kindOf(v.label)];
  await page.goto(v.url);
  const heading = await frameUntil(page, HEADING);
  const card = await frameUntil(page, k.cardRead.toString());
  const r = { ersterBildschirmMs: Math.round(heading), karteGelesenMs: card === null ? null : Math.round(card), benutzbarMs: card === null ? null : Math.round(Math.max(heading, card)) };
  // Going back and forth between the tasks, once the app had its quiet moments.
  await page.waitForTimeout(5000);
  r.wechselWieder = {};
  for (let i = 0; i < 2; i++)
    for (const hash of k.tasks) {
      r.wechselWieder[hash.slice(2)] = await switchTo(page, hash);
      await page.waitForTimeout(400);
    }
  return r;
}

/** The first visit of each task, from the start page, half a second after the card was read (a fresh page each). */
async function firstVisits(v) {
  const k = KIND[kindOf(v.label)];
  const out = {};
  for (const hash of k.tasks) {
    const page = await v.context.newPage();
    const cdp = await v.context.newCDPSession(page);
    if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.goto(v.url);
    await frameUntil(page, k.cardRead.toString());
    const start = await page.evaluate(() => location.hash);
    await page.waitForTimeout(500);
    // The start page itself (0.6: Musik) has no first visit.
    if (!start.startsWith(hash)) out[hash.slice(2)] = await switchTo(page, hash);
    await page.close();
  }
  return out;
}

async function stickers(page, v) {
  const zero = kindOf(v.label) === '0.5';
  await page.goto(v.url);
  await frameUntil(page, KIND[kindOf(v.label)].cardRead.toString());
  await page.waitForTimeout(4000);
  let t0;
  if (zero) {
    await page.evaluate(() => (location.hash = '#/sticker'));
    await frameUntil(page, `() => !!document.querySelector('.main > .page-slot:not(.page-slot-hidden) .pick-all')`);
    await page.waitForTimeout(1500);
    t0 = await page.evaluate(() => {
      const t = performance.now();
      document.querySelector('.main > .page-slot:not(.page-slot-hidden) .pick-all').click();
      return t;
    });
  } else {
    t0 = await page.evaluate(() => {
      const t = performance.now();
      location.hash = '#/sticker';
      return t;
    });
  }
  const cpu0 = await cpuNow();
  const draws0 = await page.evaluate(() => window.__tempo.draws);
  await page.waitForTimeout(200);
  const last = await quietSince(page, t0);
  const draws = (await page.evaluate(() => window.__tempo.draws)) - draws0;
  const chosen = await page.evaluate(() => (document.querySelector('.main > .page-slot:not(.page-slot-hidden)')?.textContent.match(/(\d+)\s*(Ordner|Sticker)/) || [])[0] ?? null);
  return { fertigMs: Math.round(last - t0), cpuMs: Math.round((await cpuNow()) - cpu0), gemalt: draws, gewaehlt: chosen };
}

async function list(page, v) {
  const zero = kindOf(v.label) === '0.5';
  await page.goto(v.url + (zero ? '#/hinzufuegen' : '#/musik'));
  await frameUntil(page, KIND[kindOf(v.label)].cardRead.toString());
  await page.waitForTimeout(3000);
  const rows = zero ? '.import-tracks .list-row' : 'ol.titel li.tz';
  const cpu0 = await cpuNow();
  const t0 = await page.evaluate(() => {
    const page = document.querySelector('.main > .page-slot:not(.page-slot-hidden)');
    const b = [...page.querySelectorAll('button')].find((x) => /^Dateien auswählen/.test(x.textContent.trim()));
    const t = performance.now();
    b.click();
    return t;
  });
  const first = await frameUntil(page, `() => document.querySelectorAll(${JSON.stringify(rows)}).length > 0`, 120000);
  const all = await frameUntil(page, `() => document.querySelectorAll(${JSON.stringify(rows)}).length >= ${TITLES}`, 120000);
  const last = await quietSince(page, all ?? t0, 120000);
  const n = await page.evaluate((s) => document.querySelectorAll(s).length, rows);
  return { ersteZeilenMs: first && Math.round(first - t0), alleZeilenMs: all && Math.round(all - t0), ruhigMs: Math.round(last - t0), cpuMs: Math.round((await cpuNow()) - cpu0), zeilen: n };
}

const data = await ensureTempoData();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
// CPU time of the page processes: what a measurement cost, also while the computer is busy with other work
// (the times on the clock swung by a sixth between sessions; this much less).
const sys = await browser.newBrowserCDPSession();
cpuNow = async () => {
  const { processInfo } = await sys.send('SystemInfo.getProcessInfo');
  return processInfo.filter((p) => p.type === 'renderer').reduce((a, p) => a + p.cpuTime, 0) * 1000;
};
const servers = [];
const results = {};
try {
  for (const v of versions) {
    const s = await serve(v.dist, data);
    servers.push(s);
    v.url = s.url.endsWith('/') ? s.url : s.url + '/';
    v.context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, locale: 'de-DE', timezoneId: 'Europe/Berlin', colorScheme: 'light' });
    // The probe only for the card; what moves when is not watched here (it would slow the page down).
    await v.context.addInitScript('window.__benchNoWatch = true;');
    await v.context.addInitScript(PROBE);
    await v.context.addInitScript(WATCH);
    const p = await v.context.newPage();
    await p.goto(`${v.url}__bench/blank.html`);
    await p.evaluate(() => window.__bench.setup());
    await p.close();
    // Once started and left alone: what an app keeps between starts is there.
    const w = await v.context.newPage();
    await w.goto(v.url);
    await frameUntil(w, KIND[kindOf(v.label)].cardRead.toString());
    await w.waitForTimeout(8000);
    await w.close();
    results[v.label] = [];
  }
  for (let r = 0; r < runs; r++) {
    for (const v of versions) {
      const one = {};
      for (const [name, fn] of [
        ['start', startAndSwitch],
        ['sticker', stickers],
        ['liste', list],
      ]) {
        if (!only.includes(name)) continue;
        const page = await v.context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        const cdp = await v.context.newCDPSession(page);
        if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        try {
          one[name] = await fn(page, v);
        } catch (e) {
          one[name] = { error: String(e).split('\n')[0] };
        }
        if (errors.length) one[name].fehler = errors.slice(0, 3);
        await page.close();
      }
      if (only.includes('erstmals'))
        try {
          one.wechselErstmals = await firstVisits(v);
        } catch (e) {
          one.wechselErstmals = { error: String(e).split('\n')[0] };
        }
      results[v.label].push(one);
      console.log(v.label, `Lauf ${r + 1}:`, JSON.stringify(one));
    }
  }
} finally {
  await browser.close();
  for (const s of servers) s.close();
}

/** Medians, flat: { "start.benutzbarMs": n, "wechselGleich.karte": n, … }. */
function flat(o, prefix = '', acc = {}) {
  for (const [k, x] of Object.entries(o)) {
    if (x && typeof x === 'object' && !Array.isArray(x)) flat(x, `${prefix}${k}.`, acc);
    else if (typeof x === 'number') (acc[`${prefix}${k}`] ??= []).push(x);
  }
  return acc;
}
const summary = {};
for (const [label, rs] of Object.entries(results)) {
  const acc = {};
  for (const r of rs) {
    const f = flat(r);
    for (const [k, xs] of Object.entries(f)) (acc[k] ??= []).push(...xs);
  }
  summary[label] = Object.fromEntries(Object.entries(acc).map(([k, xs]) => [k, median(xs)]));
}
const keys = [...new Set(Object.values(summary).flatMap((s) => Object.keys(s)))];
console.log(['Wert', ...Object.keys(summary)].join('\t'));
for (const k of keys) console.log([k, ...Object.values(summary).map((s) => s[k] ?? '–')].join('\t'));
if (out) writeFileSync(out, JSON.stringify({ einstellungen: { runs, throttle, fenster: VIEW, ordner: FOLDERS, titel: TITLES }, ergebnisse: results, median: summary }, null, 1));
