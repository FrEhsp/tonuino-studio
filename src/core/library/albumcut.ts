/**
 * A whole album in one file (TODO 0.4 #52): a CD ripped to one FLAC with a
 * cue sheet beside it, or one long MP3 of a song album. When the track list
 * is known (the cue sheet, or the same album at iTunes or MusicBrainz whose
 * lengths add up to the file's), the file is cut where the tracks begin,
 * each cut moved into the pause between two tracks (snapCutsToPauses), and
 * the tracks keep their names. Everything here is pure; the add page asks
 * the internet and measures the file.
 */
import { findPauses, snapCutsToPauses, type Pause, type TrackCut } from '../audio/silence';
import type { ContentKind } from '../tonuino/catalog';
import type { AlbumCuts, DraftTrack } from './grouping';
import { tracksTotal, wholeAlbumParts, wholeTolerance, type LookupAlbum, type LookupTrack, type WholeAlbumPart } from './tracklookup';
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

/* ------------------------------------------------------------ which tracks the file holds (#129) */

/**
 * A pause this good (silence.ts scores 0..1; half a second of silence
 * scores about 0.4, a second 0.6, a short breath in speech less) counts as
 * a place where a track may begin.
 */
const HIT_SCORE = 0.35;

/**
 * How far from where the list puts a boundary a pause may lie to count as
 * a hit: the first boundary is looked for widely (a few seconds more in
 * front of a copy from a video site), each next one close to where the one
 * before was found plus the track's length.
 */
const FIRST_SEARCH_SEC = SEARCH_SEC.shop;
const HIT_SEARCH_SEC = 1.5;

/** A part counts as sure with this share of hits, and this much more than at places nearby (the file's pauses at random). */
const SURE_HITS = 0.75;
const SURE_ABOVE_CHANCE = 0.4;

/** Places nearby for the chance of a hit: every boundary moved by these many seconds. */
const CHANCE_SHIFTS = [-29, -17, -7, 7, 17, 29];

/** How the tracks of a part of the list line up with the file's pauses. */
interface Alignment {
  /** Where each track but the first begins: in the pause found, else where the list says (with the shift of the boundary before). */
  placed: number[];
  /** Boundaries with a pause close by. */
  hits: number;
  /** Whether the first and the last boundary have one. */
  firstHit: boolean;
  lastHit: boolean;
}

/**
 * Lines up the boundaries of `lengths` from the start of the file (or from
 * its end): each boundary is looked for where the one before was found plus
 * the track's length, so a few seconds more in front do not move every
 * cut. The lengths are taken as they are, or times `scale` (a copy played a
 * little faster). With
 * `shiftSec` every boundary is looked for that far off, each on its own:
 * how often a pause lies there by chance. No hits when the first or last
 * track would come out less than half as long as the list says (the list
 * holds a piece the file lacks).
 */
function align(lengths: readonly number[], totalSec: number, pauses: readonly Pause[], fromEnd: boolean, scale: number, shiftSec?: number): Alignment {
  const n = lengths.length;
  const placed = new Array<number>(n - 1);
  let hits = 0;
  const hit = new Array<boolean>(n - 1).fill(false);
  let carry = 0;
  let anchored = false;
  const look = (at: number, i: number): number => {
    const chance = shiftSec !== undefined;
    const found = pauseNear(pauses, at + (chance ? shiftSec : carry), chance || anchored ? HIT_SEARCH_SEC : FIRST_SEARCH_SEC);
    if (!found) return at + carry;
    hits++;
    hit[i] = true;
    if (!chance) {
      carry = found.cutSec - at;
      anchored = true;
    }
    return found.cutSec;
  };
  let at = fromEnd ? totalSec : 0;
  for (let k = 1; k < n; k++) {
    const i = fromEnd ? n - k : k;
    at += fromEnd ? -lengths[i] * scale : lengths[i - 1] * scale;
    placed[i - 1] = look(at, i - 1);
  }
  const firstOk = placed[0] >= lengths[0] / 2;
  const lastOk = totalSec - placed[n - 2] >= lengths[n - 1] / 2;
  const ok = firstOk && lastOk;
  return { placed, hits: ok ? hits : 0, firstHit: ok && hit[0], lastHit: ok && hit[n - 2] };
}

/** The best pause of HIT_SCORE or more within `searchSec` of `t` (closer counts more), if any. `pauses` sorted by cutSec. */
function pauseNear(pauses: readonly Pause[], t: number, searchSec: number): Pause | undefined {
  let lo = 0;
  let hi = pauses.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pauses[mid].cutSec < t - searchSec) lo = mid + 1;
    else hi = mid;
  }
  let best: Pause | undefined;
  let bestValue = -Infinity;
  for (let k = lo; k < pauses.length && pauses[k].cutSec <= t + searchSec; k++) {
    const p = pauses[k];
    if (p.score < HIT_SCORE) continue;
    const value = p.score - (0.6 * Math.abs(p.cutSec - t)) / searchSec;
    if (value > bestValue) {
      bestValue = value;
      best = p;
    }
  }
  return best;
}

/** What the file holds of a shop's track list, once its pauses are known (planShopCuts). */
export interface ShopCutPlan {
  /** The part of the list in the file: `tracks.slice(from, to)`. */
  from: number;
  to: number;
  /** Where these tracks begin (the first at 0). */
  starts: number[];
  /** How far a cut may still move to reach a pause. */
  searchSec: number;
  /** Boundaries with a good pause close by, of `to - from - 1`. */
  hits: number;
  /** True when the list fits by its lengths alone (the whole list, within about a percent, no pauses to go by). */
  byLength: boolean;
}

/**
 * Which tracks of a shop's list the file holds and where they begin
 * (TODO 0.3 #129). Tries the whole list and the list without its first or
 * last piece (wholeAlbumParts), each lined up from the start and from the
 * end of the file, and counts the boundaries that land in a real pause.
 * Takes the part whose length fits best among those that hit the pauses
 * clearly more often than places nearby do. When none does, the whole list
 * stretched to the file, as before 0.6, but only when it fits within about
 * a percent and no shorter part fits better. Otherwise null: better not
 * cut at the tracks than cut wrongly.
 */
export function planShopCuts(tracks: readonly LookupTrack[], audio: MeasuredAudio): ShopCutPlan | null {
  const total = audio.durationSec;
  const parts = wholeAlbumParts(total, tracks, true);
  if (!parts.length) return null;
  const pauses = findPauses(audio.power, audio.windowSec, { minPauseSec: 0.3 }).sort((a, b) => a.cutSec - b.cutSec);
  const good: { part: WholeAlbumPart; a: Alignment }[] = [];
  for (const part of parts) {
    let best: Alignment | null = null;
    const lengths = tracks.slice(part.from, part.to).map((t) => t.durationSec!);
    const boundaries = lengths.length - 1;
    // As listed, or stretched to the file within 3 % (a faster copy): never so far that a missing piece is spread over all tracks.
    const ratio = Math.min(1.03, Math.max(0.97, total / lengths.reduce((x, y) => x + y, 0)));
    for (const scale of ratio === 1 ? [1] : [1, ratio]) {
      for (const fromEnd of [false, true]) {
        const a = align(lengths, total, pauses, fromEnd, scale);
        if (a.hits < SURE_HITS * boundaries) continue;
        let chance = 0;
        for (const shift of CHANCE_SHIFTS) chance += align(lengths, total, pauses, fromEnd, scale, shift).hits;
        chance /= CHANCE_SHIFTS.length;
        if (a.hits - chance < SURE_ABOVE_CHANCE * boundaries) continue;
        if (!best || a.hits > best.hits) best = a;
      }
    }
    if (best) good.push({ part, a: best });
  }
  // The best fitting length first (parts come sorted so). A first or last piece the file may lack is kept only
  // when a pause marks its end (or its start): a jingle in front is no intro.
  const chosen = good.find(
    ({ part, a }) =>
      (part.from > 0 || a.firstHit || !good.some((o) => o.part.from > 0 && o.part.to === part.to)) &&
      (part.to < tracks.length || a.lastHit || !good.some((o) => o.part.to < tracks.length && o.part.from === part.from)),
  );
  if (chosen) {
    const { part, a } = chosen;
    // The cuts sit in the pauses found already; where none was, they look close by.
    return { from: part.from, to: part.to, starts: [0, ...a.placed], searchSec: SEARCH_SEC.cue, hits: a.hits, byLength: false };
  }
  const whole = parts[0];
  if (whole.from !== 0 || whole.to !== tracks.length || whole.misfit > wholeTolerance(total, false)) return null;
  return { from: 0, to: tracks.length, starts: startsFromLengths(tracks, total), searchSec: shopSearchSec(tracks, total), hits: 0, byLength: true };
}

/**
 * The sentence that says which pieces of the list the file lacks, or
 * undefined when it holds them all: "„Intro“ fehlt in deiner Datei,
 * deshalb beginnt Titel 1 mit „Der Zoo“."
 */
export function missingPiecesNote(tracks: readonly LookupTrack[], plan: Pick<ShopCutPlan, 'from' | 'to'>): string | undefined {
  const first = plan.from > 0 ? `„${tracks[0].title.trim() || 'Titel 1'}“` : '';
  const last = plan.to < tracks.length ? `„${tracks[tracks.length - 1].title.trim() || `Titel ${tracks.length}`}“` : '';
  if (first && last) return `${first} am Anfang und ${last} am Ende fehlen in deiner Datei. Deshalb habe ich beide weggelassen.`;
  if (first) return `${first} fehlt in deiner Datei. Deshalb beginnt Titel 1 mit „${tracks[plan.from].title.trim() || `Titel ${plan.from + 1}`}“.`;
  if (last) return `${last} am Ende fehlt in deiner Datei. Deshalb habe ich es weggelassen.`;
  return undefined;
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
