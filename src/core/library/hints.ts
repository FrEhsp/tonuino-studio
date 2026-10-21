/**
 * Facts about a track that come from somewhere else than its own tags: the
 * web page a download came from (desktop app) or the list of "Entdecken",
 * which names title, album and position before the file is read.
 */
import type { TrackInfo } from './tags';

/**
 * Adds facts known from elsewhere to what the tags said: names and numbers
 * from the hint win, a playing time only fills a gap (the file itself knows
 * it better).
 */
export function applyHints(info: TrackInfo | undefined, hint: Partial<TrackInfo> | undefined): TrackInfo | undefined {
  if (!hint) return info;
  const out: TrackInfo = { ...(info ?? {}) };
  for (const key of ['title', 'artist', 'album', 'albumArtist', 'trackNo', 'trackOf', 'discNo', 'discOf'] as const) {
    const v = hint[key];
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  if (!out.durationSec && hint.durationSec) out.durationSec = hint.durationSec;
  return out;
}
