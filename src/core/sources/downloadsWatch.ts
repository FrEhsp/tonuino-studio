/**
 * "Fast ein Klick" for sources the family saves on the publisher's own page
 * (ARD Sounds and the other broadcasters, whose terms allow no download by
 * the app): after "Auf der Webseite öffnen" the desktop app looks into the
 * download folder every few seconds for a while. An audio file that arrived
 * since then and stopped growing is handed over as if it had been dropped
 * onto the page: matched to its episode, with the source's cover, into the
 * add flow. Nothing is fetched by the app, and nothing older than the click
 * and nothing but audio files is looked at.
 */

/** How often the app looks. */
export const WATCH_POLL_MS = 2500;
/** How long after the click: time to find the button, save and wait for a long episode. */
export const WATCH_FOR_MS = 15 * 60_000;
/** Files saved shortly before the click count too (clocks of file systems are coarse). */
export const WATCH_SLACK_MS = 5_000;

export interface WatchedFile {
  path: string;
  size: number;
}

/** What the app remembers between two looks: size per path, and the paths it handed over. */
export interface WatchMemory {
  sizes: Map<string, number>;
  taken: Set<string>;
}

export function newMemory(): WatchMemory {
  return { sizes: new Map(), taken: new Set() };
}

/**
 * The files of this look that are done: seen at the last look with the same
 * size (a browser that writes without a ".part" file grows it under its
 * final name) and not handed over yet. Updates `memory`.
 */
export function settledFiles<T extends WatchedFile>(listing: readonly T[], memory: WatchMemory): T[] {
  const done = listing.filter((f) => f.size > 0 && !memory.taken.has(f.path) && memory.sizes.get(f.path) === f.size);
  memory.sizes = new Map(listing.map((f) => [f.path, f.size]));
  return done;
}

/** Marks files as handed over: they are never offered twice, also when the family removes them from the add flow. */
export function markTaken(memory: WatchMemory, files: readonly WatchedFile[]): void {
  for (const f of files) memory.taken.add(f.path);
}
