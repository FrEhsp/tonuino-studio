Pages of series without a feed, for src/core/sources/pages.ts (tests/sources/pages.test.ts, series.test.ts).

ALL FILES HERE ARE SYNTHETIC. The container that wrote them (2026-10-13) could not load www.ardsounds.de or
www.ohrka.de directly; a text view of the real pages (WebFetch) showed what they say, not their markup. The files
rebuild that content in plain HTML with the usual meta tags:

  ard-show.html          ARD Sounds show "Hörspielklassiker für Kinder" (urn:ard:show:a98eaa600a311568): the 12 episode
                         links the real page listed on 2026-10-13, in that order, plus one trailer (urn:ard:extra) and
                         links to other shows that must not count.
  ard-episode.html       Episode "Die Schatzinsel (1/3)" (urn:ard:episode:02e2c3207e8a1ab4): title, "Ab 7 Jahre", "53 Min.",
                         robots unavailable_after 2031-04-30, og:image, cast line, as the real page showed them; twitter:player
                         https://www.ardsounds.de/embed/episode/16329591/ as the real page named it (WebFetch, 2026-10-15). The
                         description is SHORTENED and partly made up for the test (only its first sentence is real).
  ard-episode-new.html   A made-up new episode of the same show ("Die Gespensterjäger in großer Gefahr (1/2)").
  ard-extra.html         A made-up trailer page (urn:ard:extra).
  ohrka-topic.html       OHRKA topic page "Tierisch spannend" with two title links (one real address, one made up).
  ohrka-title.html       OHRKA title page "Alice im Wunderland": title, meta description opening, length 03:10:09,
                         file and picture addresses as the real page showed them; the rest of the description is made up.

Before relying on the readers for a release, compare them with the real pages from a normal network:
open the page, "Seitenquelltext anzeigen", and check og:title, og:description, og:image, robots and the labels.
