/**
 * A small web server for the speed comparison: serves one built web app
 * (a dist folder) and, under /__bench/, the probe page and the files of the
 * made-up card and the import album (scripts/bench/card.mjs).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { indexOf } from './card.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
  '.map': 'application/json',
};

function inside(root, rel) {
  const p = normalize(join(root, rel));
  return p === root || p.startsWith(root + sep) ? p : null;
}

function send(res, path) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-length': statSync(path).size });
  createReadStream(path).pipe(res);
}

/** Starts the server on a free port; resolves to { url, close }. */
export function serve(dist, { card, imp }) {
  const index = { card: JSON.stringify(indexOf(card)), import: JSON.stringify(indexOf(imp)) };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p === '/__bench/blank.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>bench</title><body>bench</body>');
      return;
    }
    if (p === '/__bench/card-index.json' || p === '/__bench/import-index.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(p.includes('card') ? index.card : index.import);
      return;
    }
    if (p.startsWith('/__bench/card/')) return send(res, inside(card, p.slice('/__bench/card/'.length)));
    if (p.startsWith('/__bench/import/')) return send(res, inside(imp, p.slice('/__bench/import/'.length)));
    const rel = p === '/' ? 'index.html' : p.slice(1);
    send(res, inside(dist, rel));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

export const PROBE = readFileSync(new URL('./probe.js', import.meta.url), 'utf8');
