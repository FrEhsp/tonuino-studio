import { describe, expect, it, vi } from 'vitest';
import { findCovers, findFolderCover, foldersToTry, localCover, outcomeOf, searchOptionsFor, type FolderFiles, type FolderFind, type FolderSearch, type TriedFolders } from '../../src/core/covers/autofind';
import type { BulkTarget } from '../../src/core/stickers/bulkcover';
import type { CoverCandidate, CoverSearchResult } from '../../src/core/stickers/coversearch';
import { tinyJpeg, tinyPng } from '../stickers/fixtures';

const hit = (title: string, artist: string, more: Partial<CoverCandidate> = {}): CoverCandidate => ({
  id: `itunes:${title}`,
  source: 'itunes',
  title,
  artist,
  thumbUrl: 'https://is1-ssl.mzstatic.com/t.jpg',
  fullUrl: 'https://is1-ssl.mzstatic.com/f.jpg',
  score: 1,
  ...more,
});
const found = (...candidates: CoverCandidate[]): CoverSearchResult => ({ candidates, warnings: [], asked: ['itunes', 'deezer'], failed: [] });
const nobody: CoverSearchResult = { candidates: [], warnings: ['…', '…'], asked: ['itunes', 'deezer', 'musicbrainz'], failed: ['itunes', 'deezer', 'musicbrainz'] };

const target = (folder: number, query: string, more: Partial<BulkTarget> = {}): BulkTarget => ({ folder, title: query, query, specific: !!query, ...more });

function files(opts: { others?: string[]; tracks?: string[]; read?: Record<string, Uint8Array>; embedded?: Record<string, Uint8Array | null> } = {}): FolderFiles & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    tracks: opts.tracks ?? ['001.mp3', '002.mp3', '003.mp3', '004.mp3'],
    others: opts.others ?? [],
    read: async (name) => {
      reads.push(name);
      const data = opts.read?.[name];
      if (!data) throw new Error('not there');
      return data;
    },
    embedded: async (name) => {
      reads.push(name);
      const data = opts.embedded?.[name];
      return data ? { data, mimeType: 'image/jpeg' } : null;
    },
  };
}

describe('the folder\'s own picture', () => {
  it('takes an image file with a telling name first', async () => {
    const f = files({ others: ['booklet.pdf', 'Folder.jpg'], read: { 'Folder.jpg': tinyJpeg() }, embedded: { '001.mp3': tinyPng() } });
    expect(await localCover(f)).toEqual({ data: tinyJpeg(), mimeType: 'image/jpeg', from: 'ordner' });
    expect(f.reads).toEqual(['Folder.jpg']);
  });

  it('else the picture embedded in the first tracks', async () => {
    const f = files({ embedded: { '002.mp3': tinyPng() } });
    expect(await localCover(f)).toEqual({ data: tinyPng(), mimeType: 'image/png', from: 'datei' });
    // Not every track: three are enough.
    const none = files();
    expect(await localCover(none)).toBeNull();
    expect(none.reads).toEqual(['001.mp3', '002.mp3', '003.mp3']);
  });

  it('skips a picture file that is no picture or cannot be read', async () => {
    const broken = files({ others: ['cover.jpg'], read: { 'cover.jpg': new TextEncoder().encode('<html>') }, embedded: { '001.mp3': tinyJpeg() } });
    expect((await localCover(broken))?.from).toBe('datei');
    const unreadable = files({ others: ['cover.jpg'] });
    expect(await localCover(unreadable)).toBeNull();
  });
});

describe('one folder', () => {
  const search = (r: CoverSearchResult): FolderSearch => vi.fn(async () => r);

  it('needs no service when the folder has its picture', async () => {
    const s = search(found());
    const find = await findFolderCover(target(1, 'Abbey Road'), { search: s, files: files({ others: ['cover.jpg'], read: { 'cover.jpg': tinyJpeg() } }) });
    expect(find.kind).toBe('local');
    expect(s).not.toHaveBeenCalled();
  });

  it('takes a sure hit, offers an unsure one', async () => {
    const t = target(1, 'Die drei ??? Folge 125 Feuermond', { search: { artist: 'Die drei ???', album: 'Folge 125 Feuermond' } });
    const sure = await findFolderCover(t, { search: search(found(hit('Folge 125: Feuermond', 'Die drei ???'))) });
    expect(sure).toMatchObject({ kind: 'sure', candidate: { title: 'Folge 125: Feuermond' } });
    const unsure = await findFolderCover(t, { search: search(found(hit('Folge 126: Feuermond', 'Die drei ???'))) });
    expect(unsure.kind).toBe('unsure');
    expect((await findFolderCover(t, { search: search(found()) })).kind).toBe('nothing');
    expect((await findFolderCover(t, { search: search(nobody) })).kind).toBe('unreachable');
    expect((await findFolderCover(target(2, ''), { search: search(found()) })).kind).toBe('noName');
  });

  it('asks MusicBrainz only for the rest, and stops searching once a hit is sure', () => {
    const t = target(1, 'Rolf Zuckowski Die Weihnachtsbäckerei', { search: { artist: 'Rolf Zuckowski', album: 'Die Weihnachtsbäckerei' } });
    const opts = searchOptionsFor(t);
    expect(opts.musicBrainz).toBe('rest');
    expect(opts.enough!(found(hit('Die Weihnachtsbäckerei', 'Rolf Zuckowski')))).toBe(true);
    expect(opts.enough!(found(hit('Rolfs Vogelhochzeit', 'Rolf Zuckowski')))).toBe(false);
  });
});

describe('many folders', () => {
  it('finds covers a few folders at a time and tells each find', async () => {
    let running = 0;
    let most = 0;
    const search: FolderSearch = async (q) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return found(hit(q.album ?? q.query ?? '', 'X'));
    };
    const finds: [number, FolderFind['kind']][] = [];
    const targets = [1, 2, 3, 4, 5, 6].map((n) => target(n, `Album ${n} Name`));
    const out = await findCovers(targets, { search, concurrency: 3, onFind: (t, f) => void finds.push([t.folder, f.kind]) });
    expect(out).toBe('done');
    expect(most).toBe(3);
    expect(finds.map(([n]) => n).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stops after two folders when no service answers', async () => {
    const search = vi.fn<FolderSearch>(async () => nobody);
    const targets = [1, 2, 3, 4, 5, 6].map((n) => target(n, `Album ${n} Name`));
    expect(await findCovers(targets, { search, concurrency: 1 })).toBe('unreachable');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('takes the pictures in the folders even when no service answers', async () => {
    const search = vi.fn<FolderSearch>(async () => nobody);
    const finds: FolderFind['kind'][] = [];
    const targets = [1, 2, 3].map((n) => target(n, `Album ${n} Name`));
    await findCovers(targets, {
      search,
      concurrency: 1,
      files: async (n) => (n === 1 ? files({ others: ['cover.jpg'], read: { 'cover.jpg': tinyJpeg() } }) : null),
      onFind: (_t, f) => void finds.push(f.kind),
    });
    expect(finds).toEqual(['local', 'unreachable', 'unreachable']);
  });

  it('counts a search that throws as unreachable for that folder and goes on', async () => {
    let n = 0;
    const search: FolderSearch = async () => {
      if (n++ === 0) throw new Error('kaputt');
      return found(hit('Treffer', 'X'));
    };
    const finds: FolderFind['kind'][] = [];
    await findCovers([1, 2, 3].map((k) => target(k, `Album ${k} Name`)), { search, concurrency: 1, onFind: (_t, f) => void finds.push(f.kind) });
    expect(finds[0]).toBe('unreachable');
    expect(finds).toHaveLength(3);
  });

  it('stops when told to', async () => {
    const stop = new AbortController();
    const search: FolderSearch = (_q, o) => new Promise((_r, reject) => o.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))));
    const run = findCovers([target(1, 'Album Eins Name')], { search, signal: stop.signal });
    stop.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await expect(findCovers([target(1, 'A B')], { search, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('what the automatic run remembers', () => {
  const name = (n: number) => String(n).padStart(2, '0');
  const day = 24 * 3600_000;

  it('tries a folder once per name, and again after a while only when the answer may change', () => {
    const targets = [target(1, 'Album Eins'), target(2, 'Album Zwei'), target(3, 'Album Drei'), target(4, 'Album Vier'), target(5, 'Neu'), target(6, '')];
    const now = 100 * day;
    const tried: TriedFolders = {
      '01': { q: 'Album Eins', at: now - 400 * day, outcome: 'saved' },
      '02': { q: 'Album Zwei', at: now - 2 * day, outcome: 'unsure' },
      '03': { q: 'Album Drei', at: now - 2 * day, outcome: 'nothing' },
      '04': { q: 'Album Vier', at: now - 400 * day, outcome: 'declined' },
      '05': { q: 'Alt', at: now, outcome: 'saved' },
      '06': { q: '', at: now - day, outcome: 'noName' },
    };
    // 01 was saved and its cover taken off since: never again. 02 unsure a day ago: again. 03 nothing two days ago: not yet.
    // 04 declined: never. 05 has a new name: a new try. 06 no name, no picture, a day ago: not yet.
    expect(foldersToTry(targets, tried, now, name).map((t) => t.folder)).toEqual([2, 5]);
    expect(foldersToTry(targets, tried, now + 8 * day, name).map((t) => t.folder)).toEqual([2, 3, 5, 6]);
    expect(foldersToTry(targets, {}, now, name)).toHaveLength(6);
  });

  it('remembers every outcome but "no service answered"', () => {
    expect(outcomeOf({ kind: 'unreachable' })).toBeNull();
    expect(outcomeOf({ kind: 'nothing' })).toBe('nothing');
    expect(outcomeOf({ kind: 'local', picture: { data: tinyJpeg(), mimeType: 'image/jpeg', from: 'ordner' } })).toBe('local');
    expect(outcomeOf({ kind: 'sure', candidate: hit('A', 'B'), candidates: [] })).toBe('saved');
    expect(outcomeOf({ kind: 'unsure', candidates: [] })).toBe('unsure');
    expect(outcomeOf({ kind: 'noName' })).toBe('noName');
  });
});
