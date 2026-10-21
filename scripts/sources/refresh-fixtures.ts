/// <reference types="node" />
/**
 * Refreshes the reconstructed test fixtures from a normal network
 * (npm run sources:fixtures). Writes to .sources-cache/fixtures/ only; a
 * person compares the files with tests/fixtures/sources/ and copies what is
 * needed (the tests keep their minimal cases on purpose). Personal fields
 * (archive.org uploader) are replaced by a placeholder before saving.
 * Same polite rules as the builder: one request at a time, User-Agent with contact.
 */
import { ARCHIVE_METADATA, GITLAB_TREE } from '../../src/core/sources/collect';
import type { CatalogEntry, SourceCatalog } from '../../src/core/sources/types';
import { CACHE_DIR, readCatalog, writeJson, writeText } from './fsutil';
import { Net } from '../../src/core/sources/net';

const OUT = `${CACHE_DIR}/fixtures`;

/** Fixture file -> catalogue entry whose feedUrl it comes from. */
const FEEDS: Record<string, string> = {
  'kakadu-kinderhoerspiel-118.xml': 'kakadu-kinderhoerspiel',
  'srf-kids-hoerspiele.xml': 'srf-kids-hoerspiele',
  'radioklops.xml': 'radio-klops',
};
const ARCHIVE = ['jamendo-139374'];

function scrubArchive(raw: unknown): unknown {
  const r = raw as { metadata?: Record<string, unknown> };
  if (r?.metadata && 'uploader' in r.metadata) r.metadata.uploader = 'uploader@example.invalid';
  return r;
}

async function main(): Promise<number> {
  const contact = process.env.SOURCES_CONTACT_URL?.trim();
  const net = new Net({ fetch, userAgent: `TonUINO-Studio-Quellen/1.0${contact ? ` (+${contact})` : ''}`, log: (m) => console.log(m) });
  let failed = 0;
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      console.log(`ok     ${name}`);
    } catch (e) {
      failed++;
      console.error(`Fehler ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const catalog = readCatalog() as SourceCatalog;
  for (const [file, id] of Object.entries(FEEDS)) {
    const entry = catalog.entries.find((e): e is Extract<CatalogEntry, { type: 'podcast' }> => e.id === id && e.type === 'podcast');
    if (!entry) continue;
    await step(`feeds/${file}`, async () => writeText(`${OUT}/feeds/${file}`, await net.text(entry.feedUrl, { conditional: false })));
  }
  for (const id of ARCHIVE) await step(`archive/${id}.metadata.json`, async () => writeJson(`${OUT}/archive/${id}.metadata.json`, scrubArchive(await net.json<unknown>(ARCHIVE_METADATA(id)))));
  await step('gitlab/gsb_tree_de.json', async () => writeText(`${OUT}/gitlab/gsb_tree_de.json`, await net.text(GITLAB_TREE(6909116, 'de', 'master', 1), { conditional: false })));
  console.log(`Fertig: ${OUT} (${failed} Fehler, ${net.requests} Anfragen). Vergleiche die Dateien mit tests/fixtures/sources/.`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
