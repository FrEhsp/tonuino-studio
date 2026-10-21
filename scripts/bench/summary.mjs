/**
 * The German summary of a speed comparison (scripts/bench/run.mjs): one
 * line per measured thing, old against new, in plain words. The first
 * version named in --refs is the one compared against.
 */

/** What is compared: where in a run, how it reads, whether less is better, the unit, and how much difference is only noise. */
export const METRICS = [
  { key: 'start.firstFrameMs', name: 'Start: erstes Bild (Hintergrund)', lower: true, unit: 'ms', noise: 30 },
  { key: 'start.firstContentMs', name: 'Start: erstes Bild', lower: true, unit: 'ms', noise: 30 },
  { key: 'start.headingShownMs', name: 'Start: erste Seite gezeichnet (Überschrift)', lower: true, unit: 'ms', noise: 30 },
  { key: 'start.shelfShownMs', name: 'Start: Regal sichtbar', lower: true, unit: 'ms', noise: 40 },
  { key: 'start.stableMs', name: 'Start: alles steht still', lower: true, unit: 'ms', noise: 80 },
  { key: 'start.movesAfterFirstFrame', name: 'Start: Sprünge nach dem ersten Bild', lower: true, unit: '', noise: 2 },
  { key: 'start.elementsMoved', name: 'Start: Elemente, die sich bewegen', lower: true, unit: '', noise: 1 },
  { key: 'start.layoutShiftScore', name: 'Start: Layout-Verschiebung (CLS)', lower: true, unit: '', noise: 0.005 },
  { key: 'start.longTasksMs', name: 'Start: blockierte Zeit (lange Aufgaben)', lower: true, unit: 'ms', noise: 40 },
  { key: 'start.cpuMs', name: 'Start: Rechenzeit bis alles steht (CPU)', lower: true, unit: 'ms', noise: 80 },
  { key: 'pages.totalMs', name: 'Seitenwechsel: alle Seiten des Menüs nacheinander', lower: true, unit: 'ms', noise: 40 },
  { key: 'shelf.fps', name: 'Regal scrollen: Bilder pro Sekunde', lower: false, unit: '', noise: 2 },
  { key: 'shelf.p95FrameMs', name: 'Regal scrollen: langsamstes Zwanzigstel der Bilder', lower: true, unit: 'ms', noise: 3 },
  { key: 'shelf.worstFrameMs', name: 'Regal scrollen: längster Hänger', lower: true, unit: 'ms', noise: 15 },
  // Per second of scrolling: a longer shelf (other cards, more folders) takes longer at the same speed.
  { key: 'shelf.jankMs', per: 'shelf.durationMs', name: 'Regal scrollen: verlorene Zeit je Sekunde', lower: true, unit: 'ms', noise: 15 },
  { key: 'shelf.cpuMs', per: 'shelf.durationMs', name: 'Regal scrollen: Rechenzeit (CPU) je Sekunde', lower: true, unit: 'ms', noise: 40 },
  { key: 'folder.openMs', name: 'Ordner mit langer Titelliste öffnen', lower: true, unit: 'ms', noise: 40 },
  { key: 'folder.fps', name: 'Titelliste scrollen (Abspieler läuft): Bilder pro Sekunde', lower: false, unit: '', noise: 2 },
  { key: 'folder.p95FrameMs', name: 'Titelliste scrollen: langsamstes Zwanzigstel', lower: true, unit: 'ms', noise: 3 },
  { key: 'folder.worstFrameMs', name: 'Titelliste scrollen: längster Hänger', lower: true, unit: 'ms', noise: 15 },
  { key: 'folder.jankMs', name: 'Titelliste scrollen: verlorene Zeit', lower: true, unit: 'ms', noise: 60 },
  { key: 'folder.cpuMs', name: 'Ordner öffnen, abspielen, Titelliste scrollen: Rechenzeit (CPU)', lower: true, unit: 'ms', noise: 150 },
  { key: 'player.startMs', name: 'Abspieler: vom Klick bis zum Ton', lower: true, unit: 'ms', noise: 30 },
  { key: 'player.seekBarMedianMs', name: 'Abspieler: Springen, bis der Balken folgt', lower: true, unit: 'ms', noise: 10 },
  { key: 'player.seekLandMedianMs', name: 'Abspieler: Springen, bis die Stelle erreicht ist', lower: true, unit: 'ms', noise: 15 },
  { key: 'import.mbPerSecond', name: 'Hinzufügen: MB pro Sekunde auf die Karte', lower: false, unit: 'MB/s', noise: 0.5 },
  { key: 'import.totalMs', name: 'Hinzufügen: Album (24 Titel) ganz auf der Karte', lower: true, unit: 'ms', noise: 300 },
];

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** The value of a metric for one version: median of the later starts, or the import of the last run. `per`: per second of that duration. */
export function valueOf(runs, key, per) {
  const later = runs.filter((r) => !r.first);
  const pool = later.length ? later : runs;
  return median(pool.map((r) => (per ? (get(r, per) > 0 ? (get(r, key) / get(r, per)) * 1000 : null) : get(r, key))));
}

const fmt = (v, unit) => {
  if (v === null || v === undefined) return '–';
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${String(n).replace('.', ',')}${unit && unit !== '' ? ` ${unit}` : ''}`;
};

/** "besser", "schlechter" or "gleich", by the noise of the metric. */
export function verdict(m, base, now) {
  if (base === null || now === null || base === undefined || now === undefined) return 'nicht gemessen';
  const diff = now - base;
  const noise = Math.max(m.noise, Math.abs(base) * 0.05);
  if (Math.abs(diff) <= noise) return 'gleich';
  return (m.lower ? diff < 0 : diff > 0) ? 'besser' : 'schlechter';
}

export function summarize(report) {
  const lines = [];
  const versions = report.versionen;
  const base = versions[0];
  lines.push(`# Tempo-Vergleich ${new Date(report.zeit).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);
  lines.push('');
  lines.push(`Messkarte: ${report.karte.ordner} Ordner, ${report.karte.dateien} Dateien (${report.karte.megabyte} MB), langer Ordner ${report.karte.langerOrdner}.`);
  lines.push(`Fenster ${report.einstellungen.fenster}, Bildschirmfaktor ${report.einstellungen.bildschirmFaktor}, ${report.einstellungen.laeufe} Läufe je Version (Werte: Mittel der späteren Starts), Chromium mit ${report.einstellungen.cpuDrossel}-fach gedrosselter CPU.`);
  lines.push('Verglichen mit: ' + versions.map((v, i) => `${i === 0 ? 'vorher' : 'nachher'} = ${v.subject || v.ref}`).join('; ') + '.');
  for (const [engine, results] of Object.entries(report.engines)) {
    lines.push('');
    lines.push(`## ${engine === 'webkit' ? 'WebKitGTK (wie die Linux-App)' : 'Chromium'}`);
    lines.push('');
    for (const other of versions.slice(1)) {
      const a = results[base.label] ?? [];
      const b = results[other.label] ?? [];
      const worse = [];
      lines.push(`| Was | vorher | nachher | Urteil |`);
      lines.push(`|---|---|---|---|`);
      for (const m of METRICS) {
        const va = valueOf(a, m.key, m.per);
        const vb = valueOf(b, m.key, m.per);
        if (va === null && vb === null) continue;
        const v = verdict(m, va, vb);
        if (v === 'schlechter') worse.push(m.name);
        lines.push(`| ${m.name} | ${fmt(va, m.unit)} | ${fmt(vb, m.unit)} | ${v} |`);
      }
      const firstA = a.find((r) => r.first);
      const firstB = b.find((r) => r.first);
      if (firstA?.shelf && firstB?.shelf) {
        lines.push('');
        lines.push(`Allererster Start (Sticker werden noch gemalt): Regal ${fmt(firstA.shelf.fps, '')} → ${fmt(firstB.shelf.fps, '')} Bilder pro Sekunde, leere Sticker gesehen ${firstA.shelf.emptyStickersSeen ?? '–'} → ${firstB.shelf.emptyStickersSeen ?? '–'}.`);
      }
      const movers = (b.find((r) => !r.first) ?? b[0])?.start?.topMovers ?? [];
      if (movers.length) {
        lines.push('');
        lines.push(`Was sich nachher beim Start noch bewegt: ${movers.slice(0, 5).map((x) => `${x.what} (${x.times}×)`).join(', ')}.`);
      }
      lines.push('');
      lines.push(worse.length ? `**Langsamer als vorher:** ${worse.join(', ')}.` : '**Nirgends langsamer als vorher.**');
    }
  }
  lines.push('');
  return lines.join('\n');
}
