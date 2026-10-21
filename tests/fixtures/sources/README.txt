Test fixtures for "Entdecken" (free audio plays, audiobooks and songs from open sources).
Collected in the design session of 2026-10-05. Each folder has its own README saying what is real, reconstructed or synthetic.
Paths like "../../webfetch/..." or "../../cors/..." in those READMEs point to the design session's evidence files; they are not
part of the repository.

  feeds/    RSS feeds (Kakadu, SRF Kids, Radio Klops; synthetic tracking redirect and truncated feed)   -> tests/sources/rss.test.ts, build.test.ts
  archive/  archive.org item metadata (Jamendo mirror album)                                          -> build.test.ts
  gitlab/   Global Storybooks: tree listings, all 40 German story tags, two real MP3 files             -> build.test.ts, gsb.test.ts, download.test.ts, add/origin.test.ts
  cors/     redirect chains with response headers (observed and synthetic)                             -> cors.test.ts
  index/    the sample index the builder makes from these fixtures                                      -> filter.test.ts, load.test.ts, screenshots

No test touches the network. Refresh the reconstructed fixtures from a normal network with "npm run sources:fixtures"
(writes to .sources-cache/fixtures/ for a person to compare and copy; it never overwrites these files on its own).
The sample index is checked by tests/sources/build.test.ts; after a deliberate change to the builder, write it again with
  UPDATE_SOURCES_SAMPLE=1 npx vitest run tests/sources/build.test.ts
