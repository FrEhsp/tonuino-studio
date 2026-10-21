/**
 * Compares the results of the app's measuring mode (TONUINO_MESSEN=1,
 * src/app/measure.ts): the JSON files of an older and a newer version, as
 * scripts/bench/test-pc.sh collects them. Prints a German table, old against new.
 *
 *   node scripts/bench/messung-vergleich.mjs --vorher a1.json,a2.json --nachher b1.json,b2.json [--extra c.json,…]
 *
 * Several files per version: the median counts. A version whose measuring
 * mode does not know a value yet (0.2.x has no long folder) shows "–".
 * --extra adds a column, e.g. the new version with WEBKIT_DISABLE_DMABUF_RENDERER=1.
 */
import { readFileSync } from 'node:fs';
import { median, verdict } from './summary.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',').filter(Boolean) : [];
};
const load = (files) =>
  files.map((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      console.error(`${f}: ${e.message}`);
      return {};
    }
  });

/** Lower is better unless `lower: false`; noise as in summary.mjs. */
const ROWS = [
  { key: 'boxFertigMs', name: 'Messbox: fertig nach dem Start', lower: true, unit: 'ms', noise: 40 },
  { key: 'regalSofort.bilderProSekunde', name: 'Regal gleich nach dem Start: Bilder pro Sekunde', lower: false, noise: 2 },
  { key: 'regalSofort.p95Ms', name: 'Regal gleich nach dem Start: langsamstes Zwanzigstel', lower: true, unit: 'ms', noise: 3 },
  { key: 'regalSofort.laengsterHaengerMs', name: 'Regal gleich nach dem Start: längster Hänger', lower: true, unit: 'ms', noise: 15 },
  { key: 'regalSofort.leereStickerGesehen', name: 'Regal gleich nach dem Start: leere Sticker gesehen', lower: true, noise: 2 },
  { key: 'regalSpaeter.bilderProSekunde', name: 'Regal später: Bilder pro Sekunde', lower: false, noise: 2 },
  { key: 'regalSpaeter.p95Ms', name: 'Regal später: langsamstes Zwanzigstel', lower: true, unit: 'ms', noise: 3 },
  { key: 'regalSpaeter.laengsterHaengerMs', name: 'Regal später: längster Hänger', lower: true, unit: 'ms', noise: 15 },
  { key: 'seitenErst.sichtbarMs', name: 'Seiten, erster Besuch: sichtbar (Summe)', lower: true, unit: 'ms', noise: 60 },
  { key: 'seitenErst.fertigMs', name: 'Seiten, erster Besuch: fertig (Summe)', lower: true, unit: 'ms', noise: 150 },
  { key: 'seitenZweit.sichtbarMs', name: 'Seiten, zweiter Besuch: sichtbar (Summe)', lower: true, unit: 'ms', noise: 60 },
  { key: 'langerOrdner.oeffnenMs', name: 'Langer Ordner: öffnen', lower: true, unit: 'ms', noise: 40 },
  { key: 'langerOrdner.tonNachKlickMs', name: 'Abspieler: vom Klick bis zum Ton', lower: true, unit: 'ms', noise: 30 },
  { key: 'langerOrdner.titellisteScrollen.bilderProSekunde', name: 'Titelliste scrollen (spielt): Bilder pro Sekunde', lower: false, noise: 2 },
  { key: 'langerOrdner.titellisteScrollen.p95Ms', name: 'Titelliste scrollen: langsamstes Zwanzigstel', lower: true, unit: 'ms', noise: 3 },
  { key: 'langerOrdner.titellisteScrollen.laengsterHaengerMs', name: 'Titelliste scrollen: längster Hänger', lower: true, unit: 'ms', noise: 15 },
  { key: 'langerOrdner.springenBalkenMs', name: 'Springen: bis der Balken folgt', lower: true, unit: 'ms', noise: 10 },
  { key: 'langerOrdner.springenStelleMs', name: 'Springen: bis die Stelle erreicht ist', lower: true, unit: 'ms', noise: 15 },
  { key: 'echteKarte.boxFertigMs', name: 'Echte Karte: gelesen und Regal da', lower: true, unit: 'ms', noise: 100 },
  { key: 'echteKarte.regalSofort.bilderProSekunde', name: 'Echte Karte, Regal gleich: Bilder pro Sekunde', lower: false, noise: 2 },
  { key: 'echteKarte.regalSofort.leereStickerGesehen', name: 'Echte Karte, Regal gleich: leere Sticker gesehen', lower: true, noise: 2 },
  { key: 'echteKarte.regalSpaeter.bilderProSekunde', name: 'Echte Karte, Regal später: Bilder pro Sekunde', lower: false, noise: 2 },
  { key: 'echteKarte.regalSpaeter.p95Ms', name: 'Echte Karte, Regal später: langsamstes Zwanzigstel', lower: true, unit: 'ms', noise: 3 },
  { key: 'echteKarte.langerOrdner.oeffnenMs', name: 'Echte Karte, langer Ordner: öffnen', lower: true, unit: 'ms', noise: 40 },
  { key: 'echteKarte.langerOrdner.tonNachKlickMs', name: 'Echte Karte: vom Klick bis zum Ton', lower: true, unit: 'ms', noise: 30 },
  { key: 'echteKarte.langerOrdner.titellisteScrollen.bilderProSekunde', name: 'Echte Karte, Titelliste scrollen: Bilder pro Sekunde', lower: false, noise: 2 },
  { key: 'echteKarte.langerOrdner.titellisteScrollen.p95Ms', name: 'Echte Karte, Titelliste scrollen: langsamstes Zwanzigstel', lower: true, unit: 'ms', noise: 3 },
  { key: 'echteKarte.langerOrdner.springenStelleMs', name: 'Echte Karte, Springen: bis die Stelle erreicht ist', lower: true, unit: 'ms', noise: 15 },
];

function get(o, path) {
  // Page visits: the sum over all pages of one round.
  const pages = { seitenErst: 'seitenErsterBesuch', seitenZweit: 'seitenZweiterBesuch' };
  const [head, ...rest] = path.split('.');
  if (pages[head]) {
    const list = o?.[pages[head]];
    if (!Array.isArray(list) || !list.length) return undefined;
    return list.reduce((a, p) => a + (Number(p[rest[0]]) || 0), 0);
  }
  return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
}

const fmt = (v, unit) => {
  if (v === null || v === undefined) return '–';
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${String(n).replace('.', ',')}${unit ? ` ${unit}` : ''}`;
};

const before = load(arg('vorher'));
const after = load(arg('nachher'));
const extra = load(arg('extra'));
if (!before.length || !after.length) {
  console.error('Aufruf: node scripts/bench/messung-vergleich.mjs --vorher a.json[,…] --nachher b.json[,…] [--extra c.json,…]');
  process.exit(2);
}
const value = (runs, key) => median(runs.map((r) => get(r, key)).filter((x) => typeof x === 'number'));
const head = ['Was', 'vorher', 'nachher', 'Urteil', ...(extra.length ? ['nachher, Variante'] : [])];
const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
const worse = [];
for (const m of ROWS) {
  const a = value(before, m.key);
  const b = value(after, m.key);
  const c = extra.length ? value(extra, m.key) : null;
  if (a === null && b === null && c === null) continue;
  const v = a === null ? 'neu gemessen' : verdict(m, a, b);
  if (v === 'schlechter') worse.push(m.name);
  lines.push(`| ${[m.name, fmt(a, m.unit), fmt(b, m.unit), v, ...(extra.length ? [fmt(c, m.unit)] : [])].join(' | ')} |`);
}
const real = after.map((r) => r.echteKarte).find((x) => x);
console.log(`# Messmodus: vorher (${before.length} Läufe) gegen nachher (${after.length} Läufe)\n`);
console.log(`Browser nachher: ${after[0]?.browser ?? '?'}, Fenster ${after[0]?.fenster ?? '?'}, Faktor ${after[0]?.bildschirmFaktor ?? '?'}.`);
if (real?.fehler) console.log(`Echte Karte: ${real.fehler}.`);
else if (real) console.log(`Echte Karte: „${real.laufwerk}“ mit ${real.ordner} Ordnern, langer Ordner ${real.langerOrdner?.ordner} (${real.langerOrdner?.titel} Titel).`);
console.log('');
console.log(lines.join('\n'));
console.log('');
console.log(worse.length ? `**Langsamer als vorher:** ${worse.join(', ')}.` : '**Nirgends langsamer als vorher.**');
