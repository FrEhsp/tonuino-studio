/// <reference types="node" />
/**
 * Weekly check (npm run sources:check): are the admitted sources still what
 * a person admitted?
 * - every entry page and link page answers
 * - one media file per entry (from the last published list) answers
 * - terms pages: the visible text against the stored SHA-256 (sources/terms-hashes.json);
 *   a change means a person reads the terms again ("Nutzungsbedingungen geändert: …")
 * - reviews due within 30 days
 * Writes dist-sources/check-report.json and dist-sources/check-issue.md; exit code 1 when something needs a person.
 *   --include active,review (default)   --update-hashes  stores the current hashes after a person read the terms
 */
import type { EntryStatus, SourceCatalog, SourceIndex } from '../../src/core/sources/types';
import { ENTRY_STATUSES } from '../../src/core/sources/types';
import { validateCatalog, validateIndex } from '../../src/core/sources/validate';
import { CACHE_DIR, parseArgs, readCatalog, readJsonIfExists, sha256, writeJson, writeText } from './fsutil';
import { Net, NetError } from '../../src/core/sources/net';
import { visibleText } from './pages';

const DUE_DAYS = 30;
const DAY_MS = 86_400_000;

interface TermsHashes {
  format: 1;
  hashes: Record<string, { sha256: string; checkedAt: string }>;
}

async function answers(net: Net, url: string): Promise<string | undefined> {
  try {
    await net.text(url, { conditional: false });
    return undefined;
  } catch (e) {
    return e instanceof NetError ? e.message : String(e);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const include = (typeof args.include === 'string' ? args.include.split(',') : ['active', 'review']) as EntryStatus[];
  for (const s of include) if (!ENTRY_STATUSES.includes(s)) throw new Error(`Unbekannter Status: ${s}`);
  const now = new Date();
  // Storing new hashes is how terms get read in the first place, so that run does not ask for them.
  const termsHashes = args['update-hashes'] === true ? undefined : (readJsonIfExists<unknown>('sources/terms-hashes.json') ?? {});
  const checked = validateCatalog(readCatalog(), now, { termsHashes });
  if (!checked.catalog) {
    for (const e of checked.errors) console.error(`Fehler im Katalog: ${e}`);
    return 1;
  }
  const catalog: SourceCatalog = checked.catalog;
  const contact = process.env.SOURCES_CONTACT_URL?.trim();
  // Pages are read in full (HTML), so the cap is generous but still bounded; media files only by their first bytes.
  const net = new Net({ fetch, userAgent: `TonUINO-Studio-Quellen/1.0${contact ? ` (+${contact})` : ''}` });
  const lastGood = readJsonIfExists<unknown>(`${CACHE_DIR}/last-good.json`) ?? readJsonIfExists<unknown>('sources/snapshot/index-v1.json');
  const published = lastGood ? validateIndex(lastGood) : null;
  const index: SourceIndex | undefined = published && published !== 'needs-update' ? published : undefined;
  const termsFile = readJsonIfExists<TermsHashes>('sources/terms-hashes.json') ?? { format: 1, hashes: {} };

  const problems: string[] = [];
  const notes: string[] = [];
  const blocked = new Set(catalog.blocked);
  const termsSeen = new Set<string>();
  for (const entry of catalog.entries) {
    if (!include.includes(entry.status) || blocked.has(entry.id)) continue;
    const pageError = await answers(net, entry.pageUrl);
    if (pageError) problems.push(`${entry.id}: Webseite antwortet nicht (${pageError})`);
    if (entry.type === 'link') {
      for (const it of entry.items) {
        const err = await answers(net, it.pageUrl);
        if (err) problems.push(`${entry.id}: „${it.title}“ nicht mehr erreichbar (${err})`);
      }
    }
    const file = index?.entries.find((e) => e.id === entry.id)?.items[0]?.files[0];
    if (file) {
      try {
        const head = await net.head(file.url, 4096);
        if (head.data.length === 0) problems.push(`${entry.id}: Datei leer (${file.url})`);
      } catch (e) {
        problems.push(`${entry.id}: Datei nicht erreichbar (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    const terms = entry.rights.kind === 'podcast' || entry.rights.kind === 'private-use' ? entry.rights.termsUrl : undefined;
    if (terms && !termsSeen.has(terms)) {
      termsSeen.add(terms);
      try {
        const hash = sha256(visibleText(await net.text(terms, { conditional: false })));
        const stored = termsFile.hashes[terms];
        if (!stored) notes.push(`Noch kein Stand gespeichert: ${terms}`);
        else if (stored.sha256 !== hash) problems.push(`Nutzungsbedingungen geändert: ${terms} (zuletzt gelesen ${stored.checkedAt})`);
        if (args['update-hashes'] === true) termsFile.hashes[terms] = { sha256: hash, checkedAt: now.toISOString().slice(0, 10) };
      } catch (e) {
        problems.push(`${entry.id}: Nutzungsbedingungen nicht lesbar (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    const next = entry.review?.next ? Date.parse(entry.review.next) : NaN;
    if (Number.isFinite(next)) {
      const days = Math.ceil((next - now.getTime()) / DAY_MS);
      if (days < 0) problems.push(`${entry.id}: Prüfung überfällig seit ${entry.review!.next}`);
      else if (days <= DUE_DAYS) notes.push(`${entry.id}: Prüfung fällig am ${entry.review!.next} (in ${days} Tagen)`);
    }
  }
  if (args['update-hashes'] === true) writeJson('sources/terms-hashes.json', termsFile);
  writeJson('dist-sources/check-report.json', { checkedAt: now.toISOString(), include, problems, notes, requests: net.requests });
  writeText(
    'dist-sources/check-issue.md',
    [`Quellen: Wochenprüfung, ${problems.length} Punkte`, '', ...problems.map((p) => `- ${p}`), '', ...notes.map((n) => `- ${n}`), ''].join('\n'),
  );
  for (const n of notes) console.log(n);
  for (const p of problems) console.error(p);
  console.log(`${problems.length} Punkte, ${notes.length} Hinweise, ${net.requests} Anfragen.`);
  return problems.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
