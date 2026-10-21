/**
 * Downloaded files in the import session (from "Entdecken"): the facts from the list shape
 * the album, and the files are removed as soon as no album uses them.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { card, platform, type CardState } from '../../src/app/state';
import type { TrackInfo } from '../../src/core/library/tags';
import type { SdScan } from '../../src/core/tonuino/sd';
import { addSources, cancelReading, onImportReset, removeAlbum, resetImport, session, updateAlbum, updateTracks } from '../../src/features/add/session';
import type { ByteSource, Platform } from '../../src/platform/types';
import { writeGuard } from '../../src/app/writeguard';

const MP3 = new Uint8Array(readFileSync(new URL('../fixtures/library/short.mp3', import.meta.url)));
const M4A = new Uint8Array(readFileSync(new URL('../fixtures/library/dash.m4a', import.meta.url)));

function file(name: string, bytes: Uint8Array): ByteSource {
  return { name, size: bytes.length, read: async (start, length) => bytes.subarray(start, start + length) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A file that takes a moment to read, like a big one. */
function slowFile(name: string): ByteSource {
  return { name, size: MP3.length, read: (start, length) => new Promise((r) => setTimeout(() => r(MP3.subarray(start, start + length)), 30)) };
}

function playlistHints(sources: ByteSource[]): Map<ByteSource, Partial<TrackInfo>> {
  return new Map(sources.map((s, i) => [s, { title: `Folge ${i + 1}`, artist: 'Kanal', album: 'Hörspiele für unterwegs', albumArtist: 'Kanal', trackNo: i + 1, trackOf: sources.length, discNo: 1 }]));
}

beforeEach(() => {
  // The desktop decoder's check: damaged files fail it.
  const check = async (s: ByteSource) => {
    if (s.name.startsWith('kaputt')) throw new Error('Die Audiodatei ist beschädigt oder unvollständig.');
    return { durationSec: 1.5, channels: 2 };
  };
  platform.value = { audio: { check } } as unknown as Platform;
  card.value = { status: 'ready', scan: { folders: [] } as unknown as SdScan, info: {}, covers: new Map(), coverUrls: new Map(), catalogOnCard: false } as unknown as CardState;
  resetImport();
});

describe('downloaded files in the import', () => {
  it('become one album in playlist order, with the titles from the list', async () => {
    // Named after their titles on the page: the names sort the other way round.
    const one = file('Zuerst.m4a', M4A);
    const two = file('Das Ende.mp3', MP3);
    const release = vi.fn(async () => undefined);
    const result = await addSources([two, one], {
      hints: playlistHints([one, two]),
      rejected: [{ name: '3. Folge 3', reason: 'Privat oder nur mit Anmeldung abrufbar.', web: true }],
      release,
    });
    expect(result).toEqual({ accepted: 2, rejected: [{ name: '3. Folge 3', reason: 'Privat oder nur mit Anmeldung abrufbar.', web: true }] });
    const s = session.value;
    expect(s.phase).toBe('review');
    expect(s.albums).toHaveLength(1);
    expect(s.albums[0]).toMatchObject({ title: 'Hörspiele für unterwegs', artist: 'Kanal', target: 1 });
    expect(s.albums[0].tracks.map((t) => [t.title, t.source.name])).toEqual([
      ['Folge 1', 'Zuerst.m4a'],
      ['Folge 2', 'Das Ende.mp3'],
    ]);
    // The list's playing time fills in where the file has none.
    expect(s.albums[0].tracks.every((t) => (t.info?.durationSec ?? 0) > 0)).toBe(true);
    expect(s.rejected).toEqual([{ name: '3. Folge 3', reason: 'Privat oder nur mit Anmeldung abrufbar.', web: true }]);
    await flush();
    expect(release).not.toHaveBeenCalled();

    // One track taken out: the other still needs the files.
    updateTracks(s.albums[0].id, (tracks) => tracks.slice(1));
    await flush();
    expect(release).not.toHaveBeenCalled();
    // The album taken out: nothing uses the download any more.
    removeAlbum(s.albums[0].id);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    resetImport();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('are removed when the import is discarded, and a running download hears of it', async () => {
    const heard = vi.fn();
    const stop = onImportReset(heard);
    const release = vi.fn();
    const src = file('Lied.mp3', MP3);
    await addSources([src], { hints: new Map([[src, { title: 'Lied' }]]), release });
    expect(session.value.phase).toBe('review');
    resetImport();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    resetImport();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('keep each download until its own album goes', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = file('A.mp3', MP3);
    const b = file('B.mp3', MP3);
    await addSources([a], { hints: new Map([[a, { title: 'A', album: 'Erstes', albumArtist: 'X' }]]), release: first });
    await addSources([b], { hints: new Map([[b, { title: 'B', album: 'Zweites', albumArtist: 'Y' }]]), release: second });
    expect(session.value.albums.map((x) => x.title)).toEqual(['Erstes', 'Zweites']);
    removeAlbum(session.value.albums[0].id);
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('are removed right away when none of them can be used', async () => {
    const release = vi.fn();
    const result = await addSources([file('kaputt.m4a', new Uint8Array(64)), file('notiz.docx', new Uint8Array(4))], { release });
    expect(result.accepted).toBe(0);
    expect(result.rejected.map((r) => r.name)).toEqual(['notiz.docx', 'kaputt.m4a']);
    // The review shows why none of them can go to the card; no album holds on to the download.
    expect(session.value).toMatchObject({ phase: 'review', albums: [] });
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('are removed when there is no card to add them to', async () => {
    card.value = null;
    const release = vi.fn();
    expect(await addSources([file('Lied.mp3', MP3)], { release })).toMatchObject({ accepted: 0, cancelled: true });
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('are removed when reading them is cancelled', async () => {
    const release = vi.fn();
    const slow: ByteSource = { name: 'Lied.mp3', size: MP3.length, read: (start, length) => new Promise((r) => setTimeout(() => r(MP3.subarray(start, start + length)), 50)) };
    const running = addSources([slow], { release });
    expect(session.value.phase).toBe('reading');
    cancelReading();
    expect(await running).toMatchObject({ cancelled: true });
    await flush();
    expect(session.value.phase).toBe('pick');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('arrive in the review without undoing what the user changed meanwhile', async () => {
    const a = file('A.mp3', MP3);
    await addSources([a], { hints: new Map([[a, { title: 'A', album: 'Erstes', albumArtist: 'X' }]]) });
    const first = session.value.albums[0];
    // A download finishes while the user types a new album title.
    const b = slowFile('B.mp3');
    const running = addSources([b], { hints: new Map([[b, { title: 'B', album: 'Zweites', albumArtist: 'Y' }]]) });
    expect(session.value.phase).toBe('reading');
    updateAlbum(first.id, { title: 'Mein Hörspiel' });
    expect(session.value.phase).toBe('reading');
    expect(await running).toMatchObject({ accepted: 1 });
    expect(session.value.phase).toBe('review');
    expect(session.value.albums.map((x) => x.title)).toEqual(['Mein Hörspiel', 'Zweites']);
  });

  it('keep the reading going when an album is taken out meanwhile', async () => {
    const a = file('A.mp3', MP3);
    await addSources([a], { hints: new Map([[a, { title: 'A', album: 'Erstes', albumArtist: 'X' }]]) });
    const b = slowFile('B.mp3');
    const running = addSources([b], { hints: new Map([[b, { title: 'B', album: 'Zweites', albumArtist: 'Y' }]]) });
    removeAlbum(session.value.albums[0].id);
    expect(session.value.phase).toBe('reading');
    await running;
    expect(session.value.phase).toBe('review');
    expect(session.value.albums.map((x) => x.title)).toEqual(['Zweites']);
  });

  it('are read one after the other: a second hand-over does not cut off the first', async () => {
    const a = slowFile('A.mp3');
    const b = file('B.mp3', MP3);
    const first = addSources([a], { hints: new Map([[a, { title: 'A', album: 'Erstes', albumArtist: 'X' }]]) });
    const second = addSources([b], { hints: new Map([[b, { title: 'B', album: 'Zweites', albumArtist: 'Y' }]]) });
    expect(await first).toMatchObject({ accepted: 1 });
    expect(await second).toMatchObject({ accepted: 1 });
    expect(session.value.albums.map((x) => x.title)).toEqual(['Erstes', 'Zweites']);
  });

  it('waiting for an import that is discarded meanwhile are removed, not added to the next one', async () => {
    const a = slowFile('A.mp3');
    const release = vi.fn();
    const first = addSources([a]);
    const second = addSources([file('B.mp3', MP3)], { release });
    resetImport();
    expect(await first).toMatchObject({ cancelled: true });
    expect(await second).toMatchObject({ accepted: 0, cancelled: true });
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(session.value).toMatchObject({ phase: 'pick', albums: [] });
  });

  it('leave picked files alone', async () => {
    const picked = file('Lied.mp3', MP3);
    expect(await addSources([picked])).toMatchObject({ accepted: 1, rejected: [] });
    expect(session.value.albums[0].tracks[0].source).toBe(picked);
    resetImport();
  });
});

describe('a selection waiting in the review', () => {
  it('asks before the app closes, as long as it waits', async () => {
    expect(writeGuard.running.value).not.toContain('selection');
    await addSources([file('Lied.mp3', MP3)]);
    expect(writeGuard.running.value).toContain('selection');
    removeAlbum(session.value.albums[0].id);
    expect(writeGuard.running.value).not.toContain('selection');
    await addSources([file('Lied.mp3', MP3)]);
    resetImport();
    expect(writeGuard.running.value).not.toContain('selection');
  });

  it('notes changes by hand, so discarding asks first', async () => {
    await addSources([file('Lied.mp3', MP3)]);
    expect(session.value.edited).toBeFalsy();
    updateAlbum(session.value.albums[0].id, { title: 'Mein Lied' });
    expect(session.value.edited).toBe(true);
    // More files keep it so.
    await addSources([file('Noch eins.mp3', MP3)]);
    expect(session.value.edited).toBe(true);
    resetImport();
    expect(session.value.edited).toBeUndefined();
  });
});
