#!/usr/bin/env node
// Testlabor (TODO #69, docs/TESTLABOR.md): vor jedem Release alles, was die App
// mit der Welt draußen tut, gegen Nachbildungen: SD-Kartenleser, Drucker,
// USB-Box (Box-Simulator), Handy-NFC, schlechtes Internet. Jeder Bereich läuft
// für sich, mit nice und einer Testdatei nach der anderen; am Ende eine kurze
// Tabelle und die Hinweise (übersprungene Teile, gemessene Werte).
//
//   npm run test:labor                 alle Bereiche
//   npm run test:labor -- sd druck     nur diese (sd, druck, box, nfc, netz)
//   npm run test:labor -- --ohne-box   alles außer dem Box-Simulator (5 Minuten)
//
// Exit-Code 1, wenn ein Bereich Fehler hat. Ein übersprungener Bereich ist kein
// Fehler, steht aber in der Tabelle und in den Hinweisen.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const AREAS = [
  { id: 'sd', name: 'SD-Kartenleser', notes: 'SD-Karten', file: 'tests/labor/sd.test.ts' },
  { id: 'druck', name: 'Drucker', notes: 'Drucker', file: 'tests/labor/druck.test.ts' },
  { id: 'box', name: 'USB-Box (Simulator)', notes: 'USB-Box', box: true },
  { id: 'nfc', name: 'Handy-NFC', notes: 'Handy-NFC', file: 'tests/labor/nfc.test.ts' },
  { id: 'netz', name: 'Schlechtes Internet', notes: 'Internet', file: 'tests/labor/netz.test.ts' },
];

const args = process.argv.slice(2);
const withoutBox = args.includes('--ohne-box');
const wanted = args.filter((a) => !a.startsWith('--'));
const unknown = wanted.filter((w) => !AREAS.some((a) => a.id === w));
if (unknown.length) {
  console.error(`testlabor: unbekannter Bereich ${unknown.join(', ')} (sd, druck, box, nfc, netz)`);
  process.exit(2);
}
const areas = AREAS.filter((a) => (wanted.length ? wanted.includes(a.id) : !(withoutBox && a.box)));

const tmp = mkdtempSync(join(process.env.LABOR_TMP ?? tmpdir(), 'testlabor-'));
const notesFile = join(tmp, 'hinweise.jsonl');
const env = { ...process.env, LABOR: '1', LABOR_NOTES: notesFile, LABOR_TMP: tmp };

/** Runs a command, its output to the terminal, and collects it. */
function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const pass = (stream) => (d) => {
      text += d.toString();
      stream.write(d);
    };
    child.stdout.on('data', pass(process.stdout));
    child.stderr.on('data', pass(process.stderr));
    child.on('close', (code) => resolve({ code: code ?? 1, text }));
  });
}

/** Passed, failed and skipped from vitest's summary line ("Tests  3 failed | 40 passed | 2 skipped (45)"). */
function counts(text) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const line = plain.split('\n').reverse().find((l) => /^\s*Tests\s+\d/.test(l));
  const n = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(line ?? '')?.[1] ?? 0);
  return { found: !!line, passed: n('passed'), failed: n('failed'), skipped: n('skipped') + n('todo') };
}

const results = [];
const extraNotes = [];
try {
  for (const a of areas) {
    console.log(`\n━━━ Testlabor: ${a.name} ━━━\n`);
    const start = Date.now();
    let r;
    if (a.box) {
      const simavr = [process.env.SIMAVR_PREFIX, '/usr', '/usr/local', '/opt/homebrew'].some((p) => p && existsSync(join(p, 'include', 'simavr', 'sim_avr.h')));
      const missing = !simavr ? 'simavr fehlt (apt-get install simavr libsimavr-dev)' : null;
      if (missing) {
        extraNotes.push({ area: a.notes, text: missing });
        results.push({ ...a, passed: 0, failed: 0, skipped: 0, code: 0, ms: 0, skippedAll: true });
        continue;
      }
      r = await run('npm', ['run', '--silent', 'test:boxsim']);
    } else {
      r = await run('nice', ['-n', '10', 'npx', 'vitest', 'run', a.file, '--no-file-parallelism', '--testTimeout', '180000', '--hookTimeout', '120000']);
    }
    const c = counts(r.text);
    // A run that ended badly without a summary (crash, missing tool in the script) is a failure.
    const failed = c.failed || (r.code !== 0 ? 1 : 0);
    results.push({ ...a, ...c, failed, code: r.code, ms: Date.now() - start });
  }
} finally {
  const notes = [...extraNotes];
  try {
    for (const line of readFileSync(notesFile, 'utf8').split('\n')) if (line.trim()) notes.push(JSON.parse(line));
  } catch {
    // no notes
  }
  rmSync(tmp, { recursive: true, force: true });

  const verdict = (r) => (r.failed ? 'FEHLER' : r.skippedAll || (!r.passed && !r.failed) ? 'übersprungen' : notes.some((n) => n.area === r.notes && !n.info) ? 'bestanden*' : 'bestanden');
  const rows = [['Bereich', 'Ergebnis', 'bestanden', 'Fehler', 'übersprungen', 'Zeit'], ...results.map((r) => [r.name, verdict(r), String(r.passed), String(r.failed), String(r.skipped), r.ms ? `${Math.round(r.ms / 1000)} s` : '–'])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => (i >= 2 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ');
  console.log('\n━━━ Testlabor: Ergebnis ━━━\n');
  console.log(line(rows[0]));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows.slice(1)) console.log(line(row));
  if (results.some((r) => verdict(r) === 'bestanden*')) console.log('\n* bestanden, aber Teile übersprungen (siehe Hinweise)');
  if (notes.length) {
    console.log('\nHinweise:');
    const byArea = new Map();
    for (const n of notes) byArea.set(n.area, [...(byArea.get(n.area) ?? []), n]);
    for (const [area, list] of byArea) {
      for (const n of list) console.log(`  ${area}: ${n.info ? '' : 'übersprungen – '}${n.text}`);
    }
  }
  const bad = results.filter((r) => r.failed);
  console.log(bad.length ? `\nTestlabor: ${bad.length} Bereich(e) mit Fehlern.` : '\nTestlabor: alles bestanden.');
  process.exitCode = bad.length ? 1 : 0;
}
