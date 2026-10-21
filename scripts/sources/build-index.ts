/// <reference types="node" />
/**
 * Daily job: builds /quellen/index-v1.json from the curated catalogue.
 *
 *   npm run sources:build                      production: status "active", writes dist-sources/
 *   npm run sources:build -- --include active,review --out public/quellen/index-preview.json
 *                                              local preview for editors (never published)
 *   npm run sources:snapshot                   the copy that ships with the app (sources/snapshot/)
 *
 * Environment: SOURCES_CONTACT_URL (contact page named in the User-Agent),
 * SOURCES_WEB_ORIGIN or VITE_WEB_ORIGIN (the app's web address, for the CORS check).
 *
 * Steps: check catalogue and released list, fetch sources (polite, cached),
 * build, check one real file per media host from every app origin, build
 * again with those results, run the publishing gates. On any gate error the
 * last good file stays in place and the job fails. The report (holds,
 * rejections, failures, downgrades, overdue reviews) always gets written.
 */
import { publishGates, type BuildReport } from '../../src/core/sources/build';
import { appOrigins } from '../../src/core/sources/cors';
import type { EntryStatus, SourceCatalog, SourceIndex } from '../../src/core/sources/types';
import { ENTRY_STATUSES } from '../../src/core/sources/types';
import { validateCatalog, validateIndex, validateReleased } from '../../src/core/sources/validate';
import { collectAndBuild, readState, type HostCheck } from '../../src/core/sources/collect';
import { CACHE_DIR, fileCache, parseArgs, readCatalog, readJson, readJsonIfExists, writeJson, writeText } from './fsutil';
import { Net } from '../../src/core/sources/net';

const DIST = 'dist-sources';
const PUBLISHED = `${DIST}/quellen/index-v1.json`;
const LAST_GOOD = `${CACHE_DIR}/last-good.json`;
const STATE = `${CACHE_DIR}/state.json`;

function userAgent(): string {
  const contact = process.env.SOURCES_CONTACT_URL?.trim();
  if (!contact) console.warn('Hinweis: SOURCES_CONTACT_URL ist nicht gesetzt. Der User-Agent nennt dann keine Kontaktadresse.');
  return `TonUINO-Studio-Quellen/1.0${contact ? ` (+${contact})` : ''}`;
}

function webOrigin(): string | undefined {
  const raw = (process.env.SOURCES_WEB_ORIGIN || process.env.VITE_WEB_ORIGIN || '').trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    console.warn(`Hinweis: ${raw} ist keine gültige Adresse; der CORS-Test wird übersprungen.`);
    return undefined;
  }
}

function includeList(raw: string | true | undefined): EntryStatus[] {
  if (raw === undefined || raw === true) return ['active'];
  const list = raw.split(',').map((s) => s.trim()) as EntryStatus[];
  for (const s of list) if (!ENTRY_STATUSES.includes(s)) throw new Error(`Unbekannter Status: ${s}`);
  return list;
}

/** The maintainer issue: "Quellen: N Titel warten auf Prüfung". */
function issueText(report: BuildReport, hosts: HostCheck[], gateErrors: string[]): string {
  const lines = [`Quellen: ${report.holds.length} Titel warten auf Prüfung`, ''];
  if (gateErrors.length) lines.push('## Nicht veröffentlicht', ...gateErrors.map((e) => `- ${e}`), '');
  if (report.holds.length) {
    lines.push('## Warten auf Prüfung', 'Anhören, dann den Schlüssel mit Name und Datum in sources/released.json eintragen.', '');
    for (const h of report.holds) lines.push(`- \`${h.key}\` „${h.title}“: ${h.reasons.join('; ')}`);
    lines.push('');
  }
  if (report.failures.length) lines.push('## Quellen nicht erreichbar', ...report.failures.map((f) => `- ${f.entry}: ${f.error}${f.gone ? ' (nicht mehr beim Anbieter, aus der Liste genommen)' : f.keptPrevious ? ' (Titel von gestern bleiben)' : ''}`), '');
  if (report.overdue.length) lines.push('## Prüfung überfällig', ...report.overdue.map((o) => `- ${o.entry}: fällig seit ${o.next} (${o.days} Tage)${o.dropped ? ', aus der Liste genommen' : ''}`), '');
  if (report.rejected.length) lines.push('## Abgelehnt', ...report.rejected.map((r) => `- \`${r.key}\`: ${r.reason}`), '');
  const q = report.quality;
  if (q.promo || q.promoText || q.short || q.lowBitrate || q.sparse) {
    lines.push(
      '## Qualitätsfilter',
      `- Trailer, Vorschau oder Ankündigung abgelehnt: ${q.promo}`,
      `- Vielleicht Trailer (Beschreibung), wartet auf Prüfung: ${q.promoText}`,
      `- Zu kurz abgelehnt: ${q.short}`,
      `- Geringe Tonqualität, wartet auf Prüfung: ${q.lowBitrate}`,
      `- Ohne Beschreibung (aufgenommen, zählt für die Reihenfolge der Quelle): ${q.sparse}`,
      '',
    );
  }
  if (report.notes.length) lines.push('## Hinweise für die Redaktion', ...report.notes.map((n) => `- ${n.key ? `\`${n.key}\`` : n.entry}: ${n.note}`), '');
  const notDirect = hosts.filter((h) => h.verdict !== 'direct');
  if (notDirect.length) lines.push('## Laden nur über die Webseite', ...notDirect.map((h) => `- ${h.host}: ${h.verdict}${h.failures[0] ? ` (${h.failures[0]})` : ''}`), '');
  return lines.join('\n') + '\n';
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const include = includeList(args.include);
  const out = typeof args.out === 'string' ? args.out : PUBLISHED;
  const production = out === PUBLISHED;
  const now = new Date();

  const checked = validateCatalog(readCatalog(), now, { termsHashes: readJsonIfExists<unknown>('sources/terms-hashes.json') ?? {} });
  for (const w of checked.warnings) console.warn(`Warnung: ${w}`);
  if (!checked.catalog) {
    for (const e of checked.errors) console.error(`Fehler im Katalog: ${e}`);
    return 1;
  }
  const catalog: SourceCatalog = checked.catalog;
  const released = validateReleased(readJson<unknown>('sources/released.json'), catalog);
  if (released.errors.length) {
    for (const e of released.errors) console.error(`Fehler: ${e}`);
    return 1;
  }

  const state = readState(readJsonIfExists<unknown>(STATE));
  const net = new Net({ fetch, userAgent: userAgent(), cache: fileCache(), log: (m) => console.log(m) });
  const previousPath = typeof args.previous === 'string' ? args.previous : LAST_GOOD;
  const prevRaw = readJsonIfExists<unknown>(previousPath);
  const previous = prevRaw === undefined ? undefined : (validateIndex(prevRaw) ?? undefined);
  const previousIndex: SourceIndex | undefined = previous === 'needs-update' ? undefined : previous;

  console.log(`Lese Quellen (${include.join(', ')}) …`);
  const origin = webOrigin();
  const { index, report, hostChecks } = await collectAndBuild(catalog, {
    net,
    include,
    state,
    released: released.released,
    previous: previousIndex,
    now,
    origins: origin ? appOrigins(origin) : [],
    log: (m) => console.log(m),
  });

  const serialized = JSON.stringify(index);
  const gateErrors = publishGates(index, { catalog, previous: previousIndex, serialized, parsed: validateIndex(JSON.parse(serialized)) });
  writeJson(STATE, state);
  writeJson(`${DIST}/report.json`, { ...report, hostChecks, gateErrors, requests: net.requests, include, out });
  writeText(`${DIST}/issue.md`, issueText(report, hostChecks, gateErrors));

  console.log(`${report.counts.entries} Quellen, ${report.counts.items} Titel, ${report.holds.length} warten auf Prüfung, ${report.failures.length} Fehler, ${net.requests} Anfragen.`);
  const q = report.quality;
  console.log(`Qualitätsfilter: ${q.promo} Trailer abgelehnt, ${q.short} zu kurz, ${q.promoText + q.lowBitrate} gehalten, ${q.sparse} ohne Beschreibung.`);
  if (gateErrors.length) {
    for (const e of gateErrors) console.error(`Nicht veröffentlicht: ${e}`);
    console.error('Die zuletzt veröffentlichte Liste bleibt unverändert.');
    return 1;
  }
  writeText(out, serialized + '\n');
  if (production) {
    writeText(LAST_GOOD, serialized + '\n');
    // Headers for hosts that read a _headers file (Netlify, Cloudflare Pages); others: set them in the server.
    writeText(
      `${DIST}/_headers`,
      '/quellen/*\n  Content-Type: application/json; charset=utf-8\n  Cache-Control: public, max-age=3600\n  Access-Control-Allow-Origin: *\n',
    );
  }
  console.log(`Geschrieben: ${out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
