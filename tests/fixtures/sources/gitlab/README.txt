Global Storybooks (German audio) via the GitLab API, project 6909116 (global-asp/gsn-audio), design session (key: entwurf).
REAL data, read with local curl (Origin header set):
- gsb_tree_de.json, gsb_tree_de_0002.json   tree listings (2026-10-05 ~17:03 and 22:13 UTC)
- gsb_de-0001_tall.mp3                      one complete story file (452051 bytes) for download and ID3 tests
- gsb_de-0002_animals.mp3                   a stand-in for story 0002 (see below), 251062 bytes like the real file
- gsb_id3_tags.txt                          their tags as read with music-metadata (title, reader, album, year, COMM credit with licence)
- gsn-audio_README.md                       the repository README with the story table (licence family and version per story)
- gsb_de_stories.json                       ALL 40 German stories, read 2026-10-05 22:50 UTC by ../../proto/gsb-live.mjs: recursive tree
                                            listing, then one Range request (bytes=0-16383) per file through the raw API: HTTP 206 with
                                            Access-Control-Allow-Origin "*" and the total size in Content-Range; the ID3v2.4 tag inside gives
                                            the German title (TIT2), reader (TPE1 "Jula Eberth" for all), and the COMM credit
                                            ("Text by / Translated by / Language / Level / License"). One answer (0002) came back as 200 with
                                            the whole file instead of 206: the builder must accept both.
Cross-check: the licence family in every file's COMM equals the README table (0 of 40 differ); the README adds the version
(CC BY 3.0 or 4.0, CC BY-NC 3.0). Total size of the 40 files: 40,948,408 bytes.
Headers of one Range request: ../../cors/04_gitlab_range_headers.txt.

Licences of the MP3 files kept here as test data (the audio licence follows the story, see the README table):
- gsb_de-0001_tall.mp3     „Ein sehr großer Mann“ (A very tall man, story 0001). Text Cornelius Gulere, Übersetzung Lisa Birkner,
                           gelesen von Jula Eberth. Global Storybooks / African Storybook, https://gitlab.com/global-asp/gsn-audio.
                           CC BY 3.0, https://creativecommons.org/licenses/by/3.0/. Unchanged.
- gsb_de-0002_animals.mp3  NOT the story's audio: story 0002 („Sieh Dir die Tiere an!“) is CC BY-NC 3.0, so its sound and
                           cover picture are replaced by a generated tone with noise (28.4 s, mono, VBR with Xing frame) and a
                           plain blue picture. Kept from the real file: the ID3v2.4 text frames (title, reader Jula Eberth,
                           album, year, track, the COMM credit „Text by: Jenny Katz / Translated by: Lisa Birkner / License:
                           CC-BY-NC“) and the ID3v1 tag, the layout (tag, Xing frame in the first 16 KB) and the file size.
                           Tests read only these. Made for TonUINO Studio, same licence as the app.
- gsn-audio_README.md      the repository README of global-asp/gsn-audio, unchanged, for its story table.
