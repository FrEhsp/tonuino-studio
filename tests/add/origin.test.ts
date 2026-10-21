/**
 * Files from "Entdecken" on their way through the normal import: grouping by
 * the hints, the kind from the list, credits in the tags, and publishers that
 * allow no changes.
 */
import { describe, expect, it } from 'vitest';
import { fileSource, measureTags, parseId3v2 } from '../../src/core/audio';
import { groupIntoAlbums, type AlbumDraft, type DraftTrack, type InputFile } from '../../src/core/library/grouping';
import { applyHints } from '../../src/core/library/hints';
import { readTrackInfo } from '../../src/core/library/tags';
import { planFiles, picksOf, type CardMode } from '../../src/core/sources/handoff';
import { creditLine } from '../../src/core/sources/licence';
import { albumFromSources, creditTagsFor, trackOrigin, UNCHANGED_NOT_MP3 } from '../../src/core/sources/origin';
import type { IndexEntry, IndexItem } from '../../src/core/sources/types';
import { prepareAlbum, type ProcessOptions, type TrackJob } from '../../src/features/add/process';
import type { AudioBackend } from '../../src/platform/types';
import { blobBytes } from '../audio/helpers';
import { fxBytes, loadSample } from '../sources/sample';

const MP3S = [fxBytes('gitlab/gsb_de-0001_tall.mp3'), fxBytes('gitlab/gsb_de-0002_animals.mp3')];
const RETRIEVED = Date.parse('2026-10-05T12:00:00Z');
const entry = (id: string): IndexEntry => loadSample().entries.find((e) => e.id === id)!;

/** Fails the test when the import touches the decoder: copying must not need it. */
const noAudio = new Proxy({} as AudioBackend, {
  get: (_t, key) => () => {
    throw new Error(`audio.${String(key)} should not be called`);
  },
});

function options(patch: Partial<ProcessOptions> = {}): ProcessOptions {
  return { audio: noAudio, normalizeLoudness: true, stripTags: true, bitrateKbps: 128, signal: new AbortController().signal, tagsFor: creditTagsFor, ...patch };
}

async function run(a: AlbumDraft, opts: ProcessOptions): Promise<{ jobs: TrackJob[]; files: Uint8Array[] }> {
  const prepared = await prepareAlbum(a, opts);
  try {
    const files: Uint8Array[] = [];
    for (const job of prepared.jobs) files.push(await blobBytes(await job.produce(() => undefined, opts.signal)));
    return { jobs: prepared.jobs, files };
  } finally {
    prepared.close();
  }
}

/** What the session does with downloaded files: tags read, hints applied, origin attached. */
async function inputsFor(e: IndexEntry, items: IndexItem[], mode: CardMode): Promise<InputFile[]> {
  const plan = planFiles(e, picksOf(e, items), mode);
  return Promise.all(
    plan.map(async (p, i) => {
      const source = fileSource(new Blob([MP3S[i % 2] as BlobPart]), p.file.name, p.relativePath);
      return { source, info: applyHints(await readTrackInfo(source, { cover: false }), p.hint), origin: trackOrigin(e, p.item, RETRIEVED) };
    }),
  );
}

const draft = (tracks: DraftTrack[], patch: Partial<AlbumDraft> = {}): AlbumDraft => ({ id: 'a', title: 'Album', kind: 'hoerspiel', tracks, split: 'none', splitMinutes: 5, ...patch });

/** Writes real MP3s with their tags: a second alone, several while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('grouping downloads', () => {
  it('one card for all: one album named after the source, in the order of the list', async () => {
    const gsb = entry('global-storybooks-de');
    const albums = groupIntoAlbums(await inputsFor(gsb, gsb.items.slice(0, 2), 'all'));
    expect(albums).toHaveLength(1);
    expect(albums[0].title).toBe('Global Storybooks – Geschichten zum Vorlesen');
    expect(albums[0].artist).toBe('Global Storybooks / African Storybook');
    expect(albums[0].tracks.map((t) => t.title)).toEqual(['Ein sehr großer Mann', 'Sieh Dir die Tiere an!']);
    expect(albums[0].tracks.map((t) => t.origin?.item.key)).toEqual(['global-storybooks-de/0001', 'global-storybooks-de/0002']);
    expect(albumFromSources(albums[0].tracks)).toEqual({ kind: 'hoerbuch', unchanged: false });
  });

  it('one card each: an album per story, with the source as artist', async () => {
    const gsb = entry('global-storybooks-de');
    const albums = groupIntoAlbums(await inputsFor(gsb, gsb.items.slice(0, 2), 'each'));
    expect(albums.map((a) => [a.title, a.artist, a.tracks.length])).toEqual([
      ['Ein sehr großer Mann', 'Global Storybooks – Geschichten zum Vorlesen', 1],
      ['Sieh Dir die Tiere an!', 'Global Storybooks – Geschichten zum Vorlesen', 1],
    ]);
  });

  it('songs from the list become children’s songs', async () => {
    const album = entry('jamendo-139374-eckhardt');
    const inputs = await inputsFor(album, album.items, 'all');
    const [songs] = groupIntoAlbums(inputs.slice(0, 2));
    expect(songs.title).toBe(album.items[0].title);
    expect(albumFromSources(songs.tracks)?.kind).toBe('lieder');
  });
});

describe('credits in the files', SLOW, () => {
  it('writes title, album, the exact credit, copyright, licence and source', async () => {
    const gsb = entry('global-storybooks-de');
    const [a] = groupIntoAlbums(await inputsFor(gsb, gsb.items.slice(0, 1), 'each'));
    const { jobs, files } = await run(a, options({ normalizeLoudness: false }));
    expect(jobs[0].work).toBe('copy');
    expect(jobs[0].changes).toEqual(['tags']);
    expect(jobs[0].origin?.item.key).toBe('global-storybooks-de/0001');
    const tag = parseId3v2(files[0]);
    expect(tag?.tags.title).toBe('Ein sehr großer Mann');
    expect(tag?.tags.album).toBe('Ein sehr großer Mann');
    expect(tag?.tags.comment).toBe(creditLine(gsb, gsb.items[0], ['tags']));
    expect(tag?.frames.map((f) => f.id)).toEqual(['TIT2', 'TPE1', 'TALB', 'COMM', 'TCOP', 'WCOP', 'WOAS']);
    // The audio itself is untouched.
    const audio = async (b: Uint8Array) => {
      const l = await measureTags(fileSource(new Blob([b as BlobPart]), 'x.mp3'));
      return b.subarray(l.audioStart, l.audioEnd);
    };
    expect(await audio(files[0])).toEqual(await audio(MP3S[0]));
  });

  it('leaves the files of a publisher that allows no changes byte for byte, whatever the settings say', async () => {
    const srf = entry('srf-kids-hoerspiele');
    const tracks: DraftTrack[] = MP3S.map((bytes, i) => ({
      source: fileSource(new Blob([bytes as BlobPart]), srf.items[i].files[0].name),
      info: { codec: 'mp3', durationSec: 1500 },
      title: srf.items[i].title,
      origin: trackOrigin(srf, srf.items[i], RETRIEVED),
    }));
    const facts = albumFromSources(tracks);
    expect(facts).toEqual({ kind: 'hoerspiel', unchanged: true });
    const { jobs, files } = await run(draft(tracks, { unchanged: true, split: 'pauses' }), options());
    expect(jobs.map((j) => [j.work, j.changes])).toEqual([
      ['copy', []],
      ['copy', []],
    ]);
    expect(files[0]).toEqual(MP3S[0]);
    expect(files[1]).toEqual(MP3S[1]);
  });

  it('refuses to convert files of such a publisher', async () => {
    const srf = entry('srf-kids-hoerspiele');
    const track: DraftTrack = { source: fileSource(new Blob([new Uint8Array(100)]), 'folge.m4a'), info: { codec: 'aac' }, title: 'Folge', origin: trackOrigin(srf, srf.items[0], RETRIEVED) };
    await expect(prepareAlbum(draft([track], { unchanged: true }), options())).rejects.toThrow(UNCHANGED_NOT_MP3);
  });

  it('leaves files without origin alone', async () => {
    const plain: DraftTrack = { source: fileSource(new Blob([MP3S[1] as BlobPart]), 'eigene.mp3'), info: { codec: 'mp3' }, title: 'Eigene' };
    const { jobs, files } = await run(draft([plain]), options({ normalizeLoudness: false }));
    expect(jobs[0].origin).toBeUndefined();
    const tag = parseId3v2(files[0]);
    expect(tag?.tags.comment).toBeUndefined();
    expect(tag?.frames.map((f) => f.id)).toEqual(['TIT2', 'TALB']);
  });
});
