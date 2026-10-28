/**
 * Covers by themselves (TODO #125): when a card is open and a folder has no
 * cover, the app looks for one in the background and puts a sure one on the
 * card, without a click. First the folder's own picture (an image file in
 * it, or one embedded in its tracks), then iTunes and Deezer, MusicBrainz
 * only for the rest (src/core/covers/autofind.ts). Hits it is not sure of
 * are offered to choose from (`proposals`), never saved by themselves.
 *
 * Rules:
 * - Only with "Fehlende Cover selbst suchen" on (settings.findCovers).
 * - Never over a cover that is there (setCovers with onlyMissing), and
 *   never again for a folder whose cover it saved and someone took off
 *   (remembered per catalog, see foldersToTry).
 * - Only on a card whose catalog is on it, not while something else writes
 *   to it (writeGuard) or Hinzufügen writes, and only in quiet moments.
 * - A run stops when the card changes or closes; nothing is written to
 *   another card.
 *
 * The interface for the UI (Meine Box, the folder page, a status line):
 *
 *   autoCovers                 signal with the state of the run (AutoCoverState)
 *   installAutoCovers()        starts watching the card; returns the stop function
 *   runAutoCovers(folders?)    a run now (also with the setting off: someone asked)
 *   stopAutoCovers()           stops the running one (what is saved stays)
 *   acceptProposal(folder, id) takes a hit to choose from; true when saved
 *   declineProposal(folder)    "Keins davon": not offered again for this name
 */
import { effect, untracked } from '@preact/signals';
import { card, settings, setCovers, type CoverChange } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { packageInHand } from '../../app/packageHold';
import { findCovers, foldersToTry, outcomeOf, type FolderFiles, type FolderFind, type TriedFolders, type TriedOutcome } from '../../core/covers/autofind';
import { unreachableServices, webFilterHint } from '../../core/covers/net';
import { readTrackInfo } from '../../core/library/tags';
import { coverlessFolders, type BulkTarget } from '../../core/stickers/bulkcover';
import { searchCovers, type CoverCandidate } from '../../core/stickers/coversearch';
import { isAbortError } from '../../core/stickers/image';
import { folderName } from '../../core/tonuino/sd';
import { kv } from '../../platform/web/idb';
import { quietMoment } from '../../ui/quiet';
import { prepareCover } from '../box/CoverDialog';
import { coverFetch, loadSearchCover, SOURCE_LABEL } from '../box/CoverSearch';
import { autoCovers, IDLE, type AutoCoverState } from './autoCoverState';

export { autoCovers, type AutoCoverProposal, type AutoCoverState } from './autoCoverState';


/** Covers are written in batches of this many (one write of the covers file each). */
const BATCH = 6;
/** After a card opens or the catalog changes, this long before a run starts. */
const START_DELAY_MS = 2500;

const triedKey = (catalogId: string) => `auto-covers:${catalogId}`;

/** The card a run belongs to; a run ends when it is not open any more. */
function cardKey(): string | undefined {
  const s = card.value;
  return s?.catalog ? `${s.volume.id}\n${s.catalog.id}` : undefined;
}

let running: { ctrl: AbortController; key: string } | null = null;

function patch(p: Partial<AutoCoverState>) {
  autoCovers.value = { ...autoCovers.value, ...p };
}

/** Writing is safe now: a card of ours, nothing else writing to it, Hinzufügen not busy with it, no Paket being made of it. */
async function writableMoment(key: string, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    if (signal.aborted || cardKey() !== key) return false;
    const s = card.value;
    if (!s || s.status !== 'ready' || !s.catalogOnCard || s.writeDenied) return false;
    const adding = await import('../add/session').then((m) => m.session.value.phase === 'writing').catch(() => false);
    if (!writeGuard.running.value.length && !adding && !packageInHand.value) {
      await quietMoment(800);
      if (!writeGuard.running.value.length && !packageInHand.value) return !signal.aborted && cardKey() === key;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** The files of a folder on the open card, for its own picture. */
function filesOf(folder: number): Promise<FolderFiles | null> {
  const s = card.value;
  const f = s?.scan?.folders.find((x) => x.number === folder);
  if (!s || !f) return Promise.resolve(null);
  const dir = s.volume.root.dir(f.name);
  return Promise.resolve({
    tracks: f.tracks.map((t) => t.name),
    others: f.others.map((o) => o.name),
    read: async (name) => (await dir).read(name),
    embedded: async (name, signal) => {
      const info = await readTrackInfo(await (await dir).source(name), { cover: true, signal });
      return info.picture ? { data: info.picture.data, mimeType: info.picture.mimeType } : null;
    },
  });
}

/** What was tried, per catalog: kept on this computer (IndexedDB), and in memory where that is missing. */
const triedInMemory = new Map<string, TriedFolders>();

async function loadTried(catalogId: string): Promise<TriedFolders> {
  const known = triedInMemory.get(catalogId);
  if (known) return known;
  const kept = ((await kv.get<TriedFolders>(triedKey(catalogId)).catch(() => undefined)) ?? {}) as TriedFolders;
  triedInMemory.set(catalogId, kept);
  return kept;
}

async function remember(catalogId: string, entries: Record<string, { q: string; outcome: TriedOutcome }>) {
  const tried = { ...(await loadTried(catalogId)) };
  const at = Date.now();
  for (const [name, e] of Object.entries(entries)) tried[name] = { ...e, at };
  triedInMemory.set(catalogId, tried);
  await kv.set(triedKey(catalogId), tried).catch(() => undefined);
}

/**
 * Looks for the covers of the open card's folders without one (or of
 * `folders`). `asked`: someone asked for it (a button), so the setting and
 * what was tried before do not hold it back; covers there are still never
 * replaced.
 */
export async function runAutoCovers(opts: { folders?: readonly number[]; asked?: boolean } = {}): Promise<void> {
  const s = card.value;
  const key = cardKey();
  if (!s?.scan || !s.catalog || !key || s.status !== 'ready' || !s.catalogOnCard || s.writeDenied) return;
  if (!opts.asked && !settings.value.findCovers) {
    patch({ phase: 'off' });
    return;
  }
  if (running?.key === key && !opts.asked) return;
  stopAutoCovers();
  const ctrl = new AbortController();
  const me = { ctrl, key };
  running = me;
  const catalogId = s.catalog.id;
  try {
    const all = coverlessFolders(s.scan, s.catalog, s.covers, opts.folders);
    const tried = await loadTried(catalogId);
    const targets = opts.asked ? all : foldersToTry(all, tried, Date.now(), folderName);
    if (!targets.length || ctrl.signal.aborted) return;
    // By itself only in a quiet moment, not while the app is starting or someone is busy in it:
    // its line in the bar on top kept the start in motion for seconds (Prüfrunde 2, webkit W3).
    if (!opts.asked) await quietMoment(1500);
    if (ctrl.signal.aborted) return;
    const proposals = new Map(autoCovers.value.proposals);
    for (const t of targets) proposals.delete(t.folder);
    patch({ phase: 'running', done: 0, total: targets.length, unreachable: false, webFilter: null, proposals });
    let batch: { change: CoverChange; target: BulkTarget; outcome: TriedOutcome }[] = [];
    const outcomes: Record<string, { q: string; outcome: TriedOutcome }> = {};
    const flush = async () => {
      if (!batch.length) return;
      const now = batch;
      batch = [];
      if (!(await writableMoment(key, ctrl.signal))) return;
      const written = await setCovers(
        now.map((b) => b.change),
        { onlyMissing: true },
      ).catch(() => [] as number[]);
      const ok = new Set(written);
      for (const b of now) if (ok.has(b.change.folder)) outcomes[folderName(b.change.folder)] = { q: b.target.query, outcome: b.outcome };
      const st = autoCovers.value;
      patch({ saved: [...st.saved, ...written], fromFiles: st.fromFiles + now.filter((b) => b.outcome === 'local' && ok.has(b.change.folder)).length });
    };
    const onFind = async (target: BulkTarget, find: FolderFind) => {
      if (ctrl.signal.aborted) return;
      patch({ done: autoCovers.value.done + 1 });
      const outcome = outcomeOf(find);
      if (find.kind === 'local' || find.kind === 'sure') {
        try {
          const cover =
            find.kind === 'local'
              ? await prepareCover(find.picture.data, find.picture.mimeType, 'Datei')
              : await loadSearchCover(find.candidate, ctrl.signal).then((blob) => prepareCover(blob, blob.type || 'image/jpeg', SOURCE_LABEL[find.candidate.source]));
          batch.push({ change: { folder: target.folder, data: cover.data, mimeType: cover.mimeType, source: cover.source }, target, outcome: outcome! });
        } catch (e) {
          if (ctrl.signal.aborted) return;
          void e;
          // The picture did not load: offered to choose from instead.
          if (find.kind === 'sure') offer(target, find.candidates);
          return;
        }
        if (batch.length >= BATCH) await flush();
        return;
      }
      if (find.kind === 'unsure') offer(target, find.candidates);
      if (outcome) outcomes[folderName(target.folder)] = { q: target.query, outcome };
    };
    const offer = (target: BulkTarget, candidates: readonly CoverCandidate[]) => {
      const m = new Map(autoCovers.value.proposals);
      m.set(target.folder, { folder: target.folder, title: target.title, candidates: candidates.slice(0, 5) });
      patch({ proposals: m });
    };
    await quietMoment(800);
    const result = await findCovers(targets, {
      signal: ctrl.signal,
      files: filesOf,
      search: (query, o) => searchCovers(query, { fetchFn: coverFetch, ...o }),
      onFind,
    });
    await flush();
    if (!ctrl.signal.aborted) await remember(catalogId, outcomes);
    patch({ unreachable: result === 'unreachable', webFilter: webFilterHint(unreachableServices().map((u) => u.service)) });
  } catch (e) {
    if (!isAbortError(e)) console.error('Automatic cover search failed', e);
  } finally {
    if (running === me) {
      running = null;
      patch({ phase: 'idle' });
    }
  }
}

/** Stops a running search; covers saved so far stay. */
export function stopAutoCovers(): void {
  running?.ctrl.abort();
  running = null;
  if (autoCovers.value.phase === 'running') patch({ phase: 'idle' });
}

/** Takes a hit offered to choose from; false when the card changed, the folder has a cover by now, or the picture did not load. */
export async function acceptProposal(folder: number, candidateId: string): Promise<boolean> {
  const p = autoCovers.value.proposals.get(folder);
  const hit = p?.candidates.find((c) => c.id === candidateId);
  const s = card.value;
  if (!p || !hit || !s?.catalog) return false;
  const key = cardKey();
  const blob = await loadSearchCover(hit);
  const cover = await prepareCover(blob, blob.type || 'image/jpeg', SOURCE_LABEL[hit.source]);
  if (cardKey() !== key) return false;
  const written = await setCovers([{ folder, data: cover.data, mimeType: cover.mimeType, source: cover.source }], { onlyMissing: true });
  dropProposal(folder);
  const target = coverlessFolders(s.scan ?? { folders: [] }, s.catalog, new Set(), [folder])[0];
  await remember(s.catalog.id, { [folderName(folder)]: { q: target?.query ?? '', outcome: 'saved' } });
  if (written.length) patch({ saved: [...autoCovers.value.saved, folder] });
  return written.length > 0;
}

/** "Keins davon": the folder's hits go away and are not offered again for this name. */
export function declineProposal(folder: number): void {
  const s = card.value;
  dropProposal(folder);
  if (!s?.catalog) return;
  const target = coverlessFolders(s.scan ?? { folders: [] }, s.catalog, new Set(), [folder])[0];
  void remember(s.catalog.id, { [folderName(folder)]: { q: target?.query ?? '', outcome: 'declined' } });
}

function dropProposal(folder: number) {
  const m = new Map(autoCovers.value.proposals);
  m.delete(folder);
  patch({ proposals: m });
}

/**
 * Watches the open card: a run after it opened, after something was added
 * (the catalog changed) and when the setting is switched on. Returns the
 * function that stops watching.
 */
export function installAutoCovers(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastKey: string | undefined;
  const stopWatching = effect(() => {
    const s = card.value;
    const on = settings.value.findCovers;
    // What a run depends on: the card, its catalog (something added or renamed) and its covers.
    void [s?.catalog, s?.covers, s?.status];
    untracked(() => {
      clearTimeout(timer);
      const key = cardKey();
      if (key !== lastKey) {
        // Another card, or none: nothing of the last one goes on.
        lastKey = key;
        stopAutoCovers();
        autoCovers.value = { ...IDLE, phase: on ? 'idle' : 'off' };
      }
      if (!on) {
        stopAutoCovers();
        if (autoCovers.value.phase !== 'off') patch({ phase: 'off' });
        return;
      }
      if (autoCovers.value.phase === 'off') patch({ phase: 'idle' });
      if (!key || s?.status !== 'ready') return;
      timer = setTimeout(() => void runAutoCovers(), START_DELAY_MS);
    });
  });
  return () => {
    clearTimeout(timer);
    stopWatching();
    stopAutoCovers();
  };
}
