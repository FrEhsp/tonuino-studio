Feed fixtures for the source-index builder tests (design session, key: entwurf, 2026-10-05).
RECONSTRUCTED: local curl cannot reach these hosts from this sandbox; the web fetcher returns a transcription, not bytes.
Element order, namespaces and whitespace are NOT byte-identical to the originals. Before relying on edge cases, refresh them from a
normal network with the builder's "npm run sources:fixtures" script (design, test plan) and keep these as the minimal cases.

What is real (read live on 2026-10-05, see ../../webfetch/05_kakadu_feed.txt and 06_srf_and_radioklops_feeds.txt):
- kakadu-kinderhoerspiel-118.xml  channel title/description/language/copyright/explicit/category/image; for 3 of 50 items: title, link,
                                  description (first ~300 characters as transcribed), guid, pubDate, enclosure url (with ?refId=...), length,
                                  type, itunes:duration "mm:ss".
- srf-kids-hoerspiele.xml         channel texts (channel link corrected on 2026-10-06 to the show page the live feed names,
                                  https://www.srf.ch/audio/srf-kids-hoerspiele-geschichten-fuer-kinder; no item has a link of its own); for 3 of 25 items: title, guid, pubDate, enclosure url, length, type, itunes:duration
                                  (plain seconds), itunes:explicit. NOT real: the item descriptions are marked placeholders (the transcription
                                  only paraphrased them in English); the "(Ab 8 Jahren)" marker in them comes from the podcasts research,
                                  which saw it on every episode, and is kept as the test target for per-episode age parsing.
- radioklops.xml                  channel texts; all 7 items: title, pubDate, enclosure path, length, itunes:duration (plain seconds).
                                  NOT real: the guids (placeholders; the transcription showed none). The "?source=feed" query on the
                                  enclosure URLs is taken from the podcasts research (seen on the Folge 7 URL); the transcription showed
                                  the URLs without query strings.
SYNTHETIC:
- tracking-redirect.xml           enclosure behind podtrac/pdst.fm redirects (pattern from the podcasts research, WAS IST WAS) -> rejected
                                  because the host is not in the entry's mediaHosts.
- broken.xml                      truncated XML -> builder reports the feed as broken and keeps the last good episodes.
