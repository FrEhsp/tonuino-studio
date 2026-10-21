/**
 * "Nach einer Playlist zusammenstellen", wired to the platform and the import
 * session: the files go through the same review, conversion and loudness as
 * picked files.
 */
import { readTrackInfo } from '../../core/library/tags';
import { plat } from '../../app/state';
import { addSources } from '../add/session';
import { createPlaylistImport } from './state';

export const playlist = createPlaylistImport({
  pickFiles: (opts) => plat().pickFiles(opts),
  readTrackInfo,
  addSources,
});
