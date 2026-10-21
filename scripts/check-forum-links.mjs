/**
 * Prüft die Links der Hilfe nach außen, einmal pro Runde:
 *
 *   node scripts/check-forum-links.mjs [--offline]
 *
 * 1. Jedes Forum-Thema in src/features/help/forumLinks.json: Gibt es das Thema
 *    noch, und heißt es noch so? (Titel aus https://discourse.voss.earth/t/<id>.json)
 * 2. Jede andere https-Adresse, die in src/features/help/topics.ts steht
 *    (Bauanleitung, Kompendium, ARASAAC …): Antwortet die Seite?
 *
 * --offline listet nur, was geprüft würde. Exit-Code 1, wenn etwas nicht stimmt.
 * Stimmt ein Titel nicht mehr, in forumLinks.json den neuen Titel und `checked`
 * eintragen, nachdem du das Thema angesehen hast (passt es noch zur Hilfeseite?).
 */
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const forum = JSON.parse(readFileSync(new URL('src/features/help/forumLinks.json', root), 'utf8'));
const topics = readFileSync(new URL('src/features/help/topics.ts', root), 'utf8');
const ORIGIN = 'https://discourse.voss.earth';
const offline = process.argv.includes('--offline');

// Literal addresses only; addresses put together in code (`${…}`) are checked where they are made.
const pages = [...new Set([...topics.matchAll(/https:\/\/[^\s'"`)\]<>]+/g)].map((m) => m[0].replace(/[.,;:]+$/, '')))]
  .filter((u) => !u.startsWith(`${ORIGIN}/t/`))
  .filter((u) => !u.includes('${'))
  .sort();

if (offline) {
  console.log(`Forum-Themen (${forum.links.length}):`);
  for (const l of forum.links) console.log(`  ${ORIGIN}/t/${l.id}  „${l.title}“  (geprüft ${l.checked})`);
  console.log(`Andere Seiten (${pages.length}):`);
  for (const u of pages) console.log(`  ${u}`);
  process.exit(0);
}

const problems = [];

async function get(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    return await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'TonUINO-Studio-Linkpruefung' }, ...init });
  } finally {
    clearTimeout(timer);
  }
}

for (const l of forum.links) {
  try {
    const res = await get(`${ORIGIN}/t/${l.id}.json`);
    if (!res.ok) {
      problems.push(`Forum ${l.id}: HTTP ${res.status} („${l.title}“)`);
      continue;
    }
    const title = (await res.json()).title;
    if (title !== l.title) problems.push(`Forum ${l.id}: Titel ist jetzt „${title}“, in forumLinks.json steht „${l.title}“`);
    else console.log(`ok  Forum ${l.id}  „${title}“`);
  } catch (e) {
    problems.push(`Forum ${l.id}: nicht erreichbar (${e.message})`);
  }
  // Discourse limits requests; one a second is plenty.
  await new Promise((r) => setTimeout(r, 1000));
}

for (const url of pages) {
  try {
    let res = await get(url, { method: 'HEAD' });
    // Some servers do not answer HEAD.
    if (res.status === 405 || res.status === 403 || res.status === 501) res = await get(url);
    if (res.ok) console.log(`ok  ${url}`);
    else problems.push(`${url}: HTTP ${res.status}`);
  } catch (e) {
    problems.push(`${url}: nicht erreichbar (${e.message})`);
  }
}

if (problems.length) {
  console.log(`\n${problems.length} Problem(e):`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log('\nAlle Links in Ordnung.');
