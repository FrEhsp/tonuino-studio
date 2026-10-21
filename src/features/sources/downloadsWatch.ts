/** Which source page looks into the download folder, since when and until when (core/sources/downloadsWatch.ts). */
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { plat } from '../../app/state';
import { AUDIO_EXTENSIONS } from '../../core/library/tags';
import { markTaken, newMemory, settledFiles, WATCH_FOR_MS, WATCH_POLL_MS, WATCH_SLACK_MS, type WatchMemory } from '../../core/sources/downloadsWatch';
import type { ByteSource } from '../../platform/types';

export interface Watch {
  entry: string;
  since: number;
  until: number;
}

export const downloadWatch = signal<Watch | null>(null);

/** Per watch: what was seen and handed over, kept while the family is in the add flow and comes back. */
const memories = new Map<string, WatchMemory>();

function memoryOf(w: Watch): WatchMemory {
  const key = `${w.entry}|${w.since}`;
  let m = memories.get(key);
  if (!m) {
    memories.clear();
    m = newMemory();
    memories.set(key, m);
  }
  return m;
}

/** Whether this app can look into the download folder (desktop app only). */
export function canWatchDownloads(): boolean {
  try {
    return !!plat().downloads;
  } catch {
    return false;
  }
}

/** Starts (or extends) looking for files saved for this source from now on. */
export function startWatch(entry: string, now = Date.now()): void {
  if (!canWatchDownloads()) return;
  const w = downloadWatch.value;
  const since = w?.entry === entry ? w.since : now - WATCH_SLACK_MS;
  downloadWatch.value = { entry, since, until: now + WATCH_FOR_MS };
}

export function stopWatch(): void {
  downloadWatch.value = null;
}

/**
 * Looks into the download folder while this source is watched and hands
 * finished audio files to `take`, like a drop. `paused`: a question is open
 * or the card is busy; the files wait for the next look.
 */
export function useDownloadWatch(entry: string, take: (sources: ByteSource[]) => void, paused: boolean): void {
  const w = downloadWatch.value;
  const active = w?.entry === entry ? w : null;
  const takeRef = useRef(take);
  takeRef.current = take;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    const downloads = active ? plat().downloads : undefined;
    if (!active || !downloads) return;
    const memory = memoryOf(active);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      if (stopped) return;
      if (Date.now() > active.until) {
        if (downloadWatch.value === active) stopWatch();
        return;
      }
      try {
        const { files } = await downloads.recent(active.since, AUDIO_EXTENSIONS);
        const listing = files.map((f) => ({ path: f.source.path ?? f.source.name, size: f.source.size, source: f.source }));
        const done = settledFiles(listing, memory);
        if (done.length && !pausedRef.current && !stopped) {
          markTaken(memory, done);
          takeRef.current(done.map((f) => f.source));
        }
      } catch (e) {
        console.warn('Download-Ordner nicht lesbar', e);
      }
      if (!stopped) timer = setTimeout(() => void look(), WATCH_POLL_MS);
    };
    void look();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active?.entry, active?.since, active?.until]);
}
