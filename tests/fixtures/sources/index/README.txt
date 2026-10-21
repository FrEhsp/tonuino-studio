index-v1.sample.json: a published source index as the app would load it from /quellen/index-v1.json.
GENERATED (not hand-written) by the builder (src/core/sources/build.ts) from the fixtures in ../ and the catalogue
sources/catalog.json, offline, with generatedAt 2026-10-05T04:00:00Z (see tests/sources/sample.ts; tests/sources/build.test.ts
checks that this file is up to date).
For the demonstration the builder included entries with status review and check, and treats the seven Radio Klops episodes
as released by a person; production includes only status "active". Test-only entries (test-tracking, test-broken) are removed
before writing.
Contents: 6 entries, 62 items, about 60 KB:
  kakadu-kinderhoerspiel   3 episodes, delivery "browser" (podcast-mp3.dradio.de files not yet verified for CORS), mm:ss durations, ?refId kept
  srf-kids-hoerspiele      3 episodes, delivery "browser" (no CORS on download-media.srf.ch), editPolicy "unchanged", language "gsw"
  radio-klops              7 episodes, delivery "direct" (feed and media with CORS *)
  global-storybooks-de     37 of 40 stories (3 held for listening), licence per story (CC BY 3.0/4.0, CC BY-NC 3.0), year 2017,
                           playing time for the two stories whose files are in ../gitlab/
  ohrka                    link entry with 11 titles, "Auf der Webseite öffnen", file name for recognising the dragged-in file;
                           a file to save for Alice and Oz (the addresses their pages link, catalogue fileUrl, 0.4)
  jamendo-139374-eckhardt  4 songs, CC BY-SA 2.0 DE, delivery "direct"
Covers ("cover", added 2026-10-06): kakadu (channel itunes:image on bilder.deutschlandfunk.de), srf-kids-hoerspiele
(channel itunes:image on download-media.srf.ch); ohrka (set in the
catalogue, 2026-10-09: the picture each title page on ohrka.de shows, per title, the entry's own not repeated); the others publish none.
Use it for app-side tests (loading, filtering, entry view, download planning) and screenshots with a stubbed platform.
