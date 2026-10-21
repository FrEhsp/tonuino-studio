/**
 * Bildschirmfotos in WebKitGTK für die Klickrunde (scripts/bench/shots.py):
 *
 *   node scripts/bench/shots.mjs DIST AUSGABE [GRÖSSEN] [SEITEN] [mit|ohne|beide]
 *
 * DIST: eine gebaute Web-App (npx vite build --outDir …). Standardgrößen:
 * kleiner Laptop, ein HiDPI-Bildschirm (2880×1800 mit Faktor 2), Full HD, groß, Handy.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureCard } from './card.mjs';
import { serve } from './server.mjs';

const [dist, out, sizes = '1280x720,1440x900,1920x1080,2560x1440,390x844', routes = '/,/hinzufuegen,/sticker,/karten,/werkstatt,/hilfe,/einstellungen,/entdecken', cards = 'beide'] = process.argv.slice(2);
if (!dist || !out) {
  console.error('Aufruf: node scripts/bench/shots.mjs DIST AUSGABE [GRÖSSEN] [SEITEN] [mit|ohne|beide]');
  process.exit(2);
}
const card = await ensureCard();
const server = await serve(dist, card);
try {
  const { stdout } = await promisify(execFile)('python3.12', [new URL('./shots.py', import.meta.url).pathname, server.url, out, sizes, routes, cards], { encoding: 'utf8', timeout: 3600000, maxBuffer: 1 << 26 });
  process.stdout.write(stdout);
} finally {
  await server.close();
}
