archive.org item metadata fixtures (design session, key: entwurf, 2026-10-05). RECONSTRUCTED, not byte copies.
Local curl cannot reach archive.org from this sandbox; the web fetcher returned a transcription (../../webfetch/02_*, 04_*).
After HTTP 429 (../../webfetch/07_*) no further archive.org requests were made. Refresh with "npm run sources:fixtures" from a normal network.

jamendo-139374.metadata.json  shape of https://archive.org/metadata/jamendo-139374
  real values: title, creator, date, licenseurl, the four MP3 files (name, size, length in seconds), License.txt, Readme.txt.
  subject trimmed to two of its values; server/d1/dir not read (left out: the app always uses https://archive.org/download/<id>/<name>).
  uploader is a placeholder e-mail on purpose (see above).
Edge cases this file covers: "length" in seconds; file names with spaces (URL-encode each path segment); non-audio files to
skip; an e-mail field to drop. The LibriVox book that covered chapter tracks and "mm:ss" lengths left with LibriVox (2026-10-15).
