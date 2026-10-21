/**
 * A whole album in one file (TODO 0.4 #52): a CD ripped to one FLAC with a
 * cue sheet beside it, or one long MP3 of a song album. When the track list
 * is known (the cue sheet, or the same album at iTunes or MusicBrainz whose
 * lengths add up to the file's), the file is cut where the tracks begin,
 * each cut moved into the pause between two tracks (snapCutsToPauses), and
 * the tracks keep their names. Everything here is pure; the add page asks
 * the internet and measures the file.
 */
import { findPauses, snapCutsToPauses, type TrackCut } from '../audio/silence';
import type { ContentKind } from '../tonuino/catalog';
import type { AlbumCuts, DraftTrack } from './grouping';
import { tracksTotal, type LookupAlbum, type LookupTrack } from './tracklookup';
import { cleanDownloadName, parseReleaseName } from './releasename';
import { tidyName } from './tidy';

/** A file this long may be a whole album; shorter ones are a song or a story. */
export const WHOLE_ALBUM_MIN_SEC = 8 * 60;

/** True when the album is one file long enough to be a whole album. */
export function wholeAlbumCandidate(tracks: readonly DraftTrack[]): boolean {
  return tracks.length === 1 && (tracks[0].info?.durationSec ?? 0) >= WHOLE_ALBUM_MIN_SEC;
}

/**
 * What to search for: the album's name, and its artist. A file named
 * "Rolf Zuckowski - Rolfs Vogelhochzeit" without an artist tag says both.
 */
export function wholeAlbumQuery(title: string, artist?: string): { album: string; artist?: string } {
  // Without what video sites add: "… | HÖRSPIEL DES MONATS OKTOBER [Xq7Lm2Pz9Rt]" (TODO 0.5 #81).
  const name = cleanDownloadName(tidyName(title)?.trim() ?? '');
  if (artist?.trim()) return { album: name, artist: artist.trim() };
  const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(name);
  if (!m) return { album: name };
  // "Folge 50 - Bibi & Tina - Das Kürbisfest": the number is no artist.
  const marker = /^(?:folge|episode|nr\.?|#)?\s*0*(\d{1,4})$/i.exec(m[1].trim());
  if (marker) {
    const rest = wholeAlbumQuery(m[2]);
    return { ...rest, album: `${rest.album} (Folge ${marker[1]})` };
  }
  return { album: m[2].trim(), artist: m[1].trim() };
}

/**
 * The names to search for, best first: the album's (its tag, else its
 * folder) and the file's own (its title tag, else its name). A whole album
 * in a folder "Apfelbaum" is often called right only in its file name.
 */
export function wholeAlbumQueries(albumTitle: string, fileTitle: string, artist?: string): { album: string; artist?: string }[] {
  const out: { album: string; artist?: string }[] = [];
  for (const q of [wholeAlbumQuery(albumTitle, artist), wholeAlbumQuery(fileTitle, artist)]) {
    if (q.album && !out.some((o) => o.album.toLowerCase() === q.album.toLowerCase() && o.artist?.toLowerCase() === q.artist?.toLowerCase())) out.push(q);
  }
  return out;
}

/* ------------------------------------------------------------ cue sheets */

export interface CueTrack {
  number: number;
  title?: string;
  performer?: string;
  /** INDEX 01: where the track's own sound begins. */
  startSec: number;
}

export interface CueFile {
  name: string;
  tracks: CueTrack[];
}

export interface CueSheet {
  title?: string;
  performer?: string;
  files: CueFile[];
}

/** Cue sheets come as UTF-8 (with or without BOM) or in the old Windows code page. */
export function decodeCueText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** A value after a command: quoted ("Die Vogelhochzeit") or a bare word. */
function valueOf(rest: string): string {
  const t = rest.trim();
  const q = /^"(.*)"/.exec(t);
  return (q ? q[1] : t).trim();
}

/** "03:14:05" (minutes, seconds, frames of 1/75 s) in seconds. */
function cueTime(s: string): number | undefined {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(s.trim());
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 75;
}

/** Reads a cue sheet. Null when it names no file with tracks. */
export function parseCue(text: string): CueSheet | null {
  const sheet: CueSheet = { files: [] };
  let file: CueFile | undefined;
  let track: (CueTrack & { start?: number }) | undefined;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const m = /^([A-Z]+)\s*(.*)$/i.exec(line);
    if (!m) continue;
    const cmd = m[1].toUpperCase();
    const rest = m[2];
    if (cmd === 'FILE') {
      // FILE "name.flac" WAVE: the type after the name is not part of it.
      const q = /^"(.*)"/.exec(rest.trim());
      const name = q ? q[1] : rest.trim().replace(/\s+\S+$/, '');
      file = { name: name.trim(), tracks: [] };
      sheet.files.push(file);
      track = undefined;
    } else if (cmd === 'TRACK') {
      if (!file) continue;
      const n = Number(/^(\d+)/.exec(rest.trim())?.[1]);
      track = { number: Number.isFinite(n) ? n : file.tracks.length + 1, startSec: NaN };
      file.tracks.push(track);
    } else if (cmd === 'TITLE') {
      if (track) track.title = valueOf(rest) || undefined;
      else if (!file) sheet.title = valueOf(rest) || undefined;
    } else if (cmd === 'PERFORMER') {
      if (track) track.performer = valueOf(rest) || undefined;
      else if (!file) sheet.performer = valueOf(rest) || undefined;
    } else if (cmd === 'INDEX' && track) {
      const [, no, time] = /^(\d+)\s+(\S+)/.exec(rest.trim()) ?? [];
      const t = time === undefined ? undefined : cueTime(time);
      if (t === undefined) continue;
      // INDEX 01 is where the track begins; INDEX 00 (the pregap) only when there is no 01.
      if (Number(no) === 1) track.startSec = t;
      else if (Number(no) === 0 && Number.isNaN(track.startSec)) track.start = t;
    }
  }
  for (const f of sheet.files) {
    f.tracks = f.tracks
      .map((t) => {
        const { start, ...rest } = t as CueTrack & { start?: number };
        return Number.isNaN(rest.startSec) && start !== undefined ? { ...rest, startSec: start } : rest;
      })
      .filter((t) => Number.isFinite(t.startSec));
  }
  sheet.files = sheet.files.filter((f) => f.tracks.length);
  return sheet.files.length ? sheet : null;
}

function baseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase().trim();
}

/**
 * The tracks a cue sheet gives the audio file `audioName`: those of the
 * FILE line with the same name (the extension may differ, a WAV rip turned
 * into FLAC keeps its cue sheet), or of its only FILE line when the sheet
 * and the file are alone in their folder (`alone`). Null when it does not
 * describe this file, or describes fewer than two tracks, or tracks that
 * would not fit into `durationSec`.
 */
export function cueTracksFor(sheet: CueSheet, audioName: string, opts: { alone?: boolean; durationSec?: number } = {}): CueTrack[] | null {
  const own = sheet.files.filter((f) => baseName(f.name) === baseName(audioName));
  const file = own.length === 1 ? own[0] : !own.length && opts.alone && sheet.files.length === 1 ? sheet.files[0] : undefined;
  if (!file || file.tracks.length < 2) return null;
  const tracks = [...file.tracks].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < tracks.length; i++) if (tracks[i].startSec <= tracks[i - 1].startSec) return null;
  if (opts.durationSec !== undefined && tracks[tracks.length - 1].startSec >= opts.durationSec) return null;
  return tracks;
}

/* ------------------------------------------------------------ cut positions */

/** Where the tracks of a shop's list begin in the file, stretched evenly when the file is a little longer or shorter. */
export function startsFromLengths(tracks: readonly LookupTrack[], totalSec: number): number[] {
  const lengths = tracks.map((t) => t.durationSec ?? 0);
  const sum = lengths.reduce((a, b) => a + b, 0);
  const scale = sum > 0 && totalSec > 0 ? totalSec / sum : 1;
  const starts: number[] = [];
  let at = 0;
  for (const len of lengths) {
    starts.push(at * scale);
    at += len;
  }
  return starts;
}

/** What the add page measured of the file (AudioAnalysis). */
export interface MeasuredAudio {
  durationSec: number;
  power: Float32Array;
  windowSec: number;
}

/** How far a cut may move to reach a pause: a cue sheet is exact, a shop's lengths are a few seconds off. */
export const SEARCH_SEC = { cue: 2, shop: 6, shopMax: 20 } as const;

/**
 * How far the cuts of a shop's track list may move: further when the file
 * is longer or shorter than the tracks together (a version from a video
 * site with a few seconds more at the start), at most SEARCH_SEC.shopMax.
 */
export function shopSearchSec(tracks: readonly LookupTrack[], totalSec: number): number {
  const off = Math.abs(totalSec - (tracksTotal(tracks) ?? totalSec));
  return Math.min(SEARCH_SEC.shopMax, Math.max(SEARCH_SEC.shop, off / 2 + 4));
}

/**
 * The kind of a shop's album, from what the shop files it under ("Hörspiele",
 * "Audio drama", "Kindermusik"); an episode of a series ("Folge 50: …") is a
 * Hörspiel. Undefined when it does not tell.
 */
export function kindOfAlbum(found: Pick<LookupAlbum, 'album' | 'artist' | 'genre'>): ContentKind | undefined {
  const genre = (found.genre ?? '').toLowerCase();
  if (/hörspiel|hoerspiel|audio drama|radio play/.test(genre)) return 'hoerspiel';
  if (/h(?:ö|oe)rb(?:u|ü|ue)ch|audiobook|spoken ?word|lesung/.test(genre)) return 'hoerbuch';
  if (/kindermusik|kinderlied|children'?s music/.test(genre)) return 'lieder';
  return parseReleaseName(found.album, found.artist).episode !== undefined ? 'hoerspiel' : undefined;
}

/**
 * The cuts for tracks beginning at `starts` (the first at 0), each moved
 * into the pause nearby. Gaps between songs are often short, shorter than
 * the speech pauses the cutting of audiobooks looks for.
 */
export function cutsForStarts(starts: readonly number[], audio: MeasuredAudio, searchSec: number): TrackCut[] {
  const pauses = findPauses(audio.power, audio.windowSec, { minPauseSec: 0.3 });
  return snapCutsToPauses(starts.slice(1), pauses, { durationSec: audio.durationSec, searchSec, minGapSec: 2, power: audio.power, windowSec: audio.windowSec });
}

/** Steps of "früher" and "später" in the preview. */
export const NUDGE_SEC = 0.5;

/** Moves cut `i` by `deltaSec`, but never past its neighbours or the ends of the file (a second away at least). */
export function nudgeCut(times: readonly number[], i: number, deltaSec: number, durationSec: number): number[] {
  const out = [...times];
  const lo = (i > 0 ? out[i - 1] : 0) + 1;
  const hi = (i < out.length - 1 ? out[i + 1] : durationSec) - 1;
  if (lo > hi) return out;
  out[i] = Math.round(Math.min(hi, Math.max(lo, out[i] + deltaSec)) * 1000) / 1000;
  return out;
}

/** The cuts as the album keeps them: one track per title, starting at 0 and then at each cut. */
export function albumCutsOf(from: string, titles: readonly string[], cutTimes: readonly number[]): AlbumCuts {
  return { from, tracks: titles.map((title, i) => ({ title: title.trim() || `Titel ${i + 1}`, startSec: i === 0 ? 0 : cutTimes[i - 1] })) };
}
