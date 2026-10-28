/**
 * Schreibt latest.json für den Tauri-Updater (TODO #123): Die Desktop-App
 * fragt diese Datei im neuesten Release ab (plugins.updater.endpoints in
 * src-tauri/tauri.conf.json) und lädt die Datei für ihr System, wenn die
 * Version neuer ist. Jede Datei braucht ihre Signatur (.sig daneben), die
 * `tauri build` mit TAURI_SIGNING_PRIVATE_KEY erzeugt (docs/BUILD.md,
 * „Automatische Updates“).
 *
 *   node scripts/updater-latest.mjs --version 0.6.0 \
 *     --base https://github.com/FrEhsp/tonuino-studio/releases/download/v0.6.0/ \
 *     [--notes "Was neu ist"] [--out latest.json] DATEI…
 *
 * DATEI: das AppImage, das Windows-Setup (…-setup.exe) und die gepackte
 * Mac-App (….app.tar.gz), jeweils mit .sig daneben. GitHub macht aus
 * Leerzeichen in Dateinamen Punkte („TonUINO Studio_…“ → „TonUINO.Studio_…“);
 * die Adressen in latest.json tun das auch. Lädt nichts hoch, veröffentlicht
 * nichts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Which systems a file updates, by its name: the general key and Tauri's key with the kind of installer. */
export function platformsOf(name) {
  if (/\.AppImage$/i.test(name)) return ['linux-x86_64', 'linux-x86_64-appimage'];
  if (/-setup\.exe$/i.test(name)) return ['windows-x86_64', 'windows-x86_64-nsis'];
  if (/\.app\.tar\.gz$/i.test(name)) {
    // The Mac app is built universal (mac.yml): one file for Intel and Apple silicon.
    return ['darwin-x86_64', 'darwin-aarch64', 'darwin-x86_64-app', 'darwin-aarch64-app'];
  }
  return [];
}

/** The name GitHub gives an uploaded file: spaces become dots. */
export function githubName(name) {
  return name.replace(/ /g, '.');
}

/**
 * latest.json for these files. `files`: { name, signature } with the
 * signature's text (the content of the .sig file).
 */
export function latestJson({ version, base, notes = '', date = new Date(), files }) {
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Keine Version: ${version}`);
  if (!/^https:\/\/.+\/$/.test(base)) throw new Error(`--base muss eine https-Adresse mit / am Ende sein: ${base}`);
  const platforms = {};
  for (const f of files) {
    const keys = platformsOf(f.name);
    if (!keys.length) throw new Error(`Für diese Datei gibt es keine Updates: ${f.name}`);
    const signature = f.signature.trim();
    if (!signature) throw new Error(`Die Signatur von ${f.name} ist leer.`);
    for (const k of keys) platforms[k] = { signature, url: base + encodeURIComponent(githubName(f.name)) };
  }
  if (!Object.keys(platforms).length) throw new Error('Keine Dateien angegeben.');
  return { version, notes, pub_date: date.toISOString().replace(/\.\d{3}Z$/, 'Z'), platforms };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const named = new Set(['--version', '--base', '--notes', '--out']);
  const paths = argv.filter((a, i) => !named.has(a) && !named.has(argv[i - 1]));
  try {
    const json = latestJson({
      version: arg(argv, '--version') ?? '',
      base: arg(argv, '--base') ?? '',
      notes: arg(argv, '--notes') ?? '',
      files: paths.map((p) => ({ name: basename(p), signature: readFileSync(`${p}.sig`, 'utf8') })),
    });
    const out = arg(argv, '--out') ?? 'latest.json';
    writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`${out}: Version ${json.version} für ${Object.keys(json.platforms).join(', ')}`);
  } catch (e) {
    console.error(`FEHLER: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
