import type { IAudioMetadata, IPicture } from 'music-metadata';
import type { ByteSource } from '../../platform/types';
import type { Mp3Check } from '../audio/mp3frames';
import { readMp4Chapters } from './mp4chapters';

/** What the app needs to know about an audio file before it goes on the card. */
export interface TrackInfo {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNo?: number;
  trackOf?: number;
  discNo?: number;
  discOf?: number;
  year?: number;
  genre?: string;
  durationSec?: number;
  /** International Standard Recording Code (ID3 TSRC, Vorbis ISRC): the same recording in every shop. */
  isrc?: string;
  /** "mp3", "aac", "flac", "vorbis", "opus", "pcm", … */
  codec?: string;
  container?: string;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  /** Variable bitrate: duration from tags is an estimate. */
  vbr?: boolean;
  picture?: { data: Uint8Array; mimeType: string };
  chapters?: { startSec: number; title?: string }[];
  /** What a look at every frame of an MP3 found while reading it: damaged or joined files are converted anew. */
  mp3Check?: Mp3Check;
  /**
   * The name of the box folder given in Tonuino-Manager (from 1.5.0): an ID3
   * frame TXXX "TONUINO_FOLDER_NAME" in every track of the folder; it reads
   * the one of the first track, before the album.
   */
  folderName?: string;
}

/** Description of the TXXX frame Tonuino-Manager keeps a folder's name in. */
export const MANAGER_FOLDER_NAME_TXXX = 'TONUINO_FOLDER_NAME';

export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'm4b', 'aac', 'mp4', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'aif', 'aiff', 'webm', 'weba', 'mka', 'mkv', 'mov'];

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.includes(extensionOf(name)) && !name.startsWith('._');
}

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  webm: 'audio/webm',
  weba: 'audio/webm',
  mka: 'audio/x-matroska',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
};

export function mimeTypeOf(name: string): string | undefined {
  return MIME[extensionOf(name)];
}

/** Reads tags, duration and cover. Only the parts of the file that hold them are read. */
export async function readTrackInfo(source: ByteSource, opts: { cover?: boolean; signal?: AbortSignal } = {}): Promise<TrackInfo> {
  // music-metadata and its tokenizer come as their own file of the build, on the first file read.
  const [{ parseFromTokenizer, selectCover }, { ByteSourceTokenizer }] = await Promise.all([import('music-metadata'), import('./tokenizer')]);
  const tokenizer = new ByteSourceTokenizer(source, mimeTypeOf(source.name));
  const meta = await parseFromTokenizer(tokenizer, {
    duration: false,
    skipCovers: opts.cover === false,
    includeChapters: true,
  });
  opts.signal?.throwIfAborted();
  const info = toTrackInfo(meta, selectCover(meta.common.picture));
  // music-metadata misses MP4 chapters when the index comes after the audio, and Nero chapters.
  if (!info.chapters?.length && /mp4|m4a|m4b|isom|m4v/i.test(`${meta.format.container ?? ''} ${source.name}`)) {
    info.chapters = (await readMp4Chapters(source).catch(() => null)) ?? undefined;
  }
  return info;
}

function clean(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
}

/** `cover`: the picture music-metadata's selectCover chose. */
export function toTrackInfo(meta: IAudioMetadata, cover: IPicture | null): TrackInfo {
  const c = meta.common;
  const f = meta.format;
  // MP4 chapter tracks count in units of their timescale; ID3 CHAP frames arrive in seconds.
  const chapters = f.chapters?.length
    ? f.chapters.map((ch) => ({
        startSec: ch.timeScale ? ch.start / ch.timeScale : ch.start,
        title: clean(ch.title),
      }))
    : undefined;
  return {
    title: clean(c.title),
    artist: clean(c.artist),
    album: clean(c.album),
    albumArtist: clean(c.albumartist),
    trackNo: c.track?.no ?? undefined,
    trackOf: c.track?.of ?? undefined,
    discNo: c.disk?.no ?? undefined,
    discOf: c.disk?.of ?? undefined,
    year: c.year,
    genre: clean(c.genre?.[0]),
    durationSec: f.duration,
    isrc: clean(c.isrc?.[0]),
    codec: codecName(f.codec, f.container),
    container: f.container,
    bitrateKbps: f.bitrate ? Math.round(f.bitrate / 1000) : undefined,
    sampleRate: f.sampleRate,
    channels: f.numberOfChannels,
    vbr: f.codecProfile ? /^V\d|VBR/i.test(f.codecProfile) : undefined,
    picture: cover ? { data: cover.data, mimeType: cover.format.includes('/') ? cover.format : `image/${cover.format}` } : undefined,
    chapters,
    ...(managerFolderName(meta) ? { folderName: managerFolderName(meta) } : {}),
  };
}

/** TXXX:TONUINO_FOLDER_NAME from the ID3v2 tag (music-metadata names a TXXX tag "TXXX:<description>"). */
function managerFolderName(meta: IAudioMetadata): string | undefined {
  const wanted = `TXXX:${MANAGER_FOLDER_NAME_TXXX}`.toLowerCase();
  for (const [format, tags] of Object.entries(meta.native ?? {})) {
    if (!format.startsWith('ID3v2')) continue;
    for (const t of tags) {
      if (t.id.toLowerCase() !== wanted) continue;
      const value = clean(typeof t.value === 'string' ? t.value : Array.isArray(t.value) ? t.value.join(' / ') : undefined);
      if (value) return value;
    }
  }
  return undefined;
}

function codecName(codec?: string, container?: string): string | undefined {
  const s = `${codec ?? ''} ${container ?? ''}`.toLowerCase();
  if (/mpeg 1 layer 3|mpeg 2 layer 3|mpeg 2\.5 layer 3|mp3/.test(s)) return 'mp3';
  if (/aac|mp4a/.test(s)) return 'aac';
  if (/alac/.test(s)) return 'alac';
  if (/flac/.test(s)) return 'flac';
  if (/opus/.test(s)) return 'opus';
  if (/vorbis/.test(s)) return 'vorbis';
  if (/pcm|wave|aiff/.test(s)) return 'pcm';
  if (/wma|asf/.test(s)) return 'wma';
  return codec?.toLowerCase();
}
