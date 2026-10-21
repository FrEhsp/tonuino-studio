/**
 * Spoken titles in front of tracks ("Titelansagen", an extra of the
 * settings page): children who cannot read yet hear the name of each song or
 * chapter before it starts.
 *
 * The box plays the announcement as part of the track itself: TonUINO TNG
 * only knows announcements of numbers (mp3/advert), none per track, and a
 * spoken title as a track of its own would double the number of tracks,
 * break "Einzeltitel" cards and the place the box remembers in a Hörbuch.
 *
 * The computer's voice (platform `speech`, a WAV) is converted with the
 * app's encoder into an MP3 of the track's format (sample rate, channels,
 * MPEG version), at the app's loudness, with a short silence before and
 * after. Its frames then go in front of the track's frames without
 * converting the track (joinMp3). A TXXX frame of the tag notes how many
 * frames the announcement takes, with their size and CRC, so "Titelansagen
 * entfernen" cuts exactly those off again and gets the track's own frames
 * back unchanged. A file whose start has changed since (cut, joined,
 * converted) no longer matches the note and is left alone.
 */
import type { ByteSource } from '../../platform/types';
import { crc16Arc } from './bits';
import { AudioError, checkAborted } from './errors';
import { ANNOUNCEMENT_TXXX, buildSmallId3, readTags, type BasicTags, type SmallTags } from './id3';
import { playbackLufs, TARGET_LUFS } from './loudness';
import { cutMp3Parts, snapCuts } from './mp3cut';
import { effectiveBitrate, loadMp3Encoder, Mp3StreamEncoder } from './mp3encoder';
import { scanMp3, timeOfFrame, type Mp3Index } from './mp3frames';
import { joinMp3, joinProblem } from './mp3join';
import { analyzePcm, ArrayPcmReader, downmixToMono } from './pcm';
import { resampleBuffer } from './resample';
import { BlobCollector, bufferSource, fileSource, readRange } from './source';
import { probeWav, wavToFloat } from './wav';

export { ANNOUNCEMENT_TXXX };

/** Silence before the title: some MP3 players of the box swallow the first moment of a track (forum 1760). */
export const PAUSE_BEFORE_SEC = 0.3;
/** Silence between the title and the track. */
export const PAUSE_AFTER_SEC = 0.7;
/** Longest announcement: a title, not a chapter read aloud. */
export const MAX_ANNOUNCEMENT_SEC = 20;
/** Level below which the start and end of the voice count as silence. */
const SILENCE_DB = -50;

/* ------------------------------------------------------------ the text */

/**
 * What the voice says for a track: its title, with "Titel 3." in front when
 * `number` is given. File-name leftovers ("_", ".mp3") are read as spaces.
 */
export function announcementText(title: string, number?: number): string {
  const clean = title
    .trim()
    .replace(/\.(mp3|m4a|m4b|wav|flac|ogg|opus|aac)$/i, '')
    .replace(/[_\s]+/g, ' ')
    .trim();
  const n = number !== undefined && Number.isFinite(number) && number > 0 ? `Titel ${Math.round(number)}.` : '';
  return [n, clean].filter(Boolean).join(' ');
}

/* ------------------------------------------------------------ the sound */

/** The parts of a track's format the announcement must share to be joined in front of it. */
export interface AnnounceFormat {
  sampleRate: number;
  channels: 1 | 2;
  /** Bitrate for the announcement (raised where the encoder needs more, see effectiveBitrate). */
  bitrateKbps: number;
}

/** The announcement's format for a track: the track's own, at a bitrate fit for speech. */
export function announceFormatOf(index: Pick<Mp3Index, 'sampleRate' | 'channels' | 'cbr' | 'bitrateKbps' | 'avgBitrateKbps'>): AnnounceFormat {
  const kbps = Math.round((index.cbr ? index.bitrateKbps : undefined) ?? index.avgBitrateKbps ?? 128);
  return { sampleRate: index.sampleRate, channels: index.channels, bitrateKbps: Math.max(64, Math.min(160, kbps || 128)) };
}

/** First and last sample (exclusive) above SILENCE_DB, with a few milliseconds around. Null when all is silence. */
export function voicedRange(x: Float32Array, sampleRate: number): [number, number] | null {
  const limit = 10 ** (SILENCE_DB / 20);
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > limit) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const margin = Math.round(0.03 * sampleRate);
  return [Math.max(0, first - margin), Math.min(x.length, last + 1 + margin)];
}

/** Gain that brings speech to the app's loudness (TARGET_LUFS), within ±20 dB. */
export async function speechGainDb(mono: Float32Array, sampleRate: number): Promise<number> {
  const analysis = await analyzePcm(new ArrayPcmReader([mono], sampleRate));
  const lufs = playbackLufs(analysis);
  if (lufs === undefined || !Number.isFinite(lufs)) return 0;
  return Math.max(-20, Math.min(20, TARGET_LUFS - lufs));
}

/**
 * The computer's voice (a WAV file) as MP3 frames in the format of the
 * track: [Info frame][frames]. Silence of the voice at the start and end is
 * replaced by PAUSE_BEFORE_SEC and PAUSE_AFTER_SEC.
 */
export async function encodeAnnouncement(wav: Uint8Array, format: AnnounceFormat, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const source = bufferSource(wav, 'ansage.wav');
  const info = await probeWav(source);
  if (info.durationSec > MAX_ANNOUNCEMENT_SEC + 5) throw new AudioError('no-audio', 'Die Ansage wäre zu lang. Kürze den Titel.');
  const pcm = wavToFloat(await readRange(source, info.dataOffset, info.dataSize), info);
  checkAborted(opts.signal);
  const mono = downmixToMono(pcm);
  const range = voicedRange(mono, info.sampleRate);
  if (!range) throw new AudioError('no-audio', 'Die Stimme des Computers hat nichts gesagt.');
  const [voice] = resampleBuffer([mono.subarray(range[0], range[1])], info.sampleRate, format.sampleRate);
  const gain = 10 ** ((await speechGainDb(voice, format.sampleRate)) / 20);
  const before = Math.round(PAUSE_BEFORE_SEC * format.sampleRate);
  const after = Math.round(PAUSE_AFTER_SEC * format.sampleRate);
  const out = new Float32Array(before + voice.length + after);
  for (let i = 0; i < voice.length; i++) out[before + i] = voice[i] * gain;
  checkAborted(opts.signal);
  const channels = format.channels === 2 ? [out, out] : [out];
  await loadMp3Encoder();
  const enc = new Mp3StreamEncoder({ inputChannels: format.channels, sampleRate: format.sampleRate, bitrateKbps: effectiveBitrate(format.bitrateKbps, format.channels, format.sampleRate) });
  enc.push({ channels, sampleRate: format.sampleRate });
  const frames = [...enc.takeOutput(), ...enc.finish()];
  const collected = new BlobCollector();
  collected.push(frames);
  return new Uint8Array(await collected.toBlob([enc.infoFrame()]).arrayBuffer());
}

/* ------------------------------------------------------------ the note in the tag */

/** What the TXXX frame notes: the first `frames` audio frames are the announcement, `bytes` long with CRC-16 `crc`. */
export interface AnnouncementMark {
  frames: number;
  bytes: number;
  crc: number;
}

export function formatMark(m: AnnouncementMark): string {
  return `v1 frames=${m.frames} bytes=${m.bytes} crc=${m.crc.toString(16).padStart(4, '0')}`;
}

export function parseMark(text: string | undefined): AnnouncementMark | null {
  const m = /^v1 frames=(\d+) bytes=(\d+) crc=([0-9a-f]{4})$/i.exec(text?.trim() ?? '');
  if (!m) return null;
  const mark = { frames: Number(m[1]), bytes: Number(m[2]), crc: parseInt(m[3], 16) };
  return mark.frames > 0 && mark.bytes > 0 ? mark : null;
}

/** Size and CRC-16 of the first `frames` audio frames. */
async function leadOf(source: ByteSource, index: Mp3Index, frames: number): Promise<{ bytes: number; crc: number }> {
  const start = index.frameOffsets[0];
  const end = frames < index.frameCount ? index.frameOffsets[frames] : index.audioEnd;
  const bytes = await readRange(source, start, end - start);
  return { bytes: bytes.length, crc: crc16Arc(bytes) };
}

/** Whether the start of the file still is the announcement the note describes. */
export async function markMatches(source: ByteSource, index: Mp3Index, mark: AnnouncementMark): Promise<boolean> {
  if (index.layer !== 3 || mark.frames >= index.frameCount) return false;
  const lead = await leadOf(source, index, mark.frames);
  return lead.bytes === mark.bytes && lead.crc === mark.crc;
}

/** The tags without the note, as tags to write again. */
export function tagsWithout(tags: BasicTags): SmallTags {
  const rest: SmallTags & { announcement?: string } = { ...tags };
  delete rest.announcement;
  return rest;
}

/** What a file on the card says about its announcement. */
export interface AnnouncementState {
  index: Mp3Index;
  tags: BasicTags;
  /** The note, when it still matches the start of the file. */
  mark: AnnouncementMark | null;
}

export async function readAnnouncement(source: ByteSource, opts: { signal?: AbortSignal } = {}): Promise<AnnouncementState> {
  const index = await scanMp3(source, { signal: opts.signal });
  const { tags } = await readTags(source);
  const noted = parseMark(tags.announcement);
  const mark = noted && (await markMatches(source, index, noted)) ? noted : null;
  return { index, tags, mark };
}

/* ------------------------------------------------------------ in front, and off again */

export interface Announced {
  blob: Blob;
  mark: AnnouncementMark;
  /** Playing time with the announcement. */
  durationSec: number;
  /** Playing time of the announcement in front. */
  announcementSec: number;
}

/**
 * The track with `announcement` (from encodeAnnouncement, in the track's
 * format) in front, losslessly: the track's frames stay as they are. The
 * new tag is `tags` plus the note. A silent frame that carries bytes the
 * track's first frame reaches back for (see joinMp3) counts to the
 * announcement, so cutting it off gives back exactly the track's frames.
 */
export async function prependAnnouncement(track: ByteSource, trackIndex: Mp3Index, announcement: Uint8Array, tags: SmallTags, opts: { signal?: AbortSignal } = {}): Promise<Announced> {
  if (trackIndex.layer !== 3) throw new AudioError('unsupported-layer');
  const annSource = bufferSource(announcement, 'ansage.mp3');
  const annIndex = await scanMp3(annSource);
  if (joinProblem([annIndex, trackIndex])) throw new AudioError('mixed-format');
  const joined = await joinMp3(
    [
      { source: annSource, index: annIndex },
      { source: track, index: trackIndex },
    ],
    { tag: null, signal: opts.signal },
  );
  const joinedSource = fileSource(joined.blob, track.name);
  const joinedIndex = await scanMp3(joinedSource);
  const frames = annIndex.frameCount + joined.bridges;
  const lead = await leadOf(joinedSource, joinedIndex, frames);
  const mark = { frames, ...lead };
  const tag = buildSmallId3({ ...tags, announcement: formatMark(mark) });
  return {
    blob: new Blob([tag as BlobPart, joined.blob], { type: 'audio/mpeg' }),
    mark,
    durationSec: joinedIndex.durationSec,
    announcementSec: timeOfFrame(joinedIndex, frames),
  };
}

/**
 * The file without the announcement its note describes: the frames after
 * it, as they were before it was put in front, with `tags` (no note).
 * Throws when the note does not match the file any more.
 */
export async function removeAnnouncement(source: ByteSource, index: Mp3Index, mark: AnnouncementMark, tags: SmallTags, opts: { signal?: AbortSignal } = {}): Promise<Blob> {
  if (!(await markMatches(source, index, mark))) throw new AudioError('read-failed', 'Der Anfang dieses Titels hat sich seit der Ansage verändert. Ich lass ihn, wie er ist.');
  const at = timeOfFrame(index, mark.frames);
  const { frames } = snapCuts(index, [at]);
  if (frames.length !== 1 || frames[0] !== mark.frames) throw new AudioError('read-failed');
  const tag = buildSmallId3(tags);
  let part = 0;
  for await (const blob of cutMp3Parts(source, index, [at], { tagFor: (i) => (i === 1 ? tag : null), signal: opts.signal })) {
    if (part++ === 1) return blob;
  }
  throw new AudioError('read-failed');
}

/* ------------------------------------------------------------ whole tracks */

/**
 * A track with its title spoken in front. An announcement noted in it is
 * replaced (the title may have changed since). `speak` gives the computer's
 * voice as a WAV file; it is asked only once the track is known to fit.
 */
export async function announceTrack(source: ByteSource, speak: () => Promise<Uint8Array>, opts: { signal?: AbortSignal } = {}): Promise<Announced & { replaced: boolean }> {
  const state = await readAnnouncement(source, opts);
  if (state.index.layer !== 3 || !state.index.frameCount) throw new AudioError('unsupported-layer');
  const tags = tagsWithout(state.tags);
  let base = source;
  let index = state.index;
  if (state.mark) {
    base = fileSource(await removeAnnouncement(source, state.index, state.mark, tags, opts), source.name);
    index = await scanMp3(base, { signal: opts.signal });
  }
  checkAborted(opts.signal);
  const mp3 = await encodeAnnouncement(await speak(), announceFormatOf(index), opts);
  return { ...(await prependAnnouncement(base, index, mp3, tags, opts)), replaced: !!state.mark };
}

/** The track without its announcement, or null when it has none (or its start changed since). */
export async function unannounceTrack(source: ByteSource, opts: { signal?: AbortSignal } = {}): Promise<{ blob: Blob; durationSec: number } | null> {
  const state = await readAnnouncement(source, opts);
  if (!state.mark) return null;
  const blob = await removeAnnouncement(source, state.index, state.mark, tagsWithout(state.tags), opts);
  return { blob, durationSec: (await scanMp3(fileSource(blob, source.name))).durationSec };
}
