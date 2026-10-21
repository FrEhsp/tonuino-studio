/**
 * Which Baukasten build the box runs, as far as the app knows: from the
 * firmware read back off the box before an update (identifyBuild), or from
 * the build the app put on it. Knob, light and headphone detection do not
 * show in the box's log, so this is the only place that knows them. The
 * Bedienkarte and the check before a firmware update use it. Remembered in
 * this browser, for the last box only.
 */
import { signal } from '@preact/signals';
import { rememberBoxWritesCards } from './writeability';
import type { BaukastenBuild, BaukastenButtons, BaukastenBoard, ExtrasChoice, KnobKind, LightKind, PresetId } from '../../core/firmware/baukasten';
import { keyCount, type KeyCount } from '../../core/tonuino/adminkeys';

export interface KnownBuild {
  id: string;
  board: BaukastenBoard;
  buttons: BaukastenButtons;
  knob?: KnobKind;
  light?: LightKind;
  speakerOff?: boolean;
  headphones?: boolean;
  traeger?: boolean;
  preset?: PresetId;
  alarm?: boolean;
  /** The write-card preview (Karten über die Box beschreiben). */
  writeCard?: boolean;
  /** Read off the box ("erkannt"), or put on it by the app. */
  from: 'read' | 'flashed';
  at: number;
}

const KEY = 'tonuino-studio:box-build';

function load(): KnownBuild | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<KnownBuild>;
    return typeof v.id === 'string' && typeof v.board === 'string' && typeof v.buttons === 'string' ? (v as KnownBuild) : null;
  } catch {
    return null;
  }
}

export const knownBuild = signal<KnownBuild | null>(load());

/** How many keys the box has: from its start in the live Box-Logbuch, else from the build the app knows. */
export function knownKeys(info?: { buttons?: string }, build: KnownBuild | null = knownBuild.value): KeyCount | undefined {
  return keyCount(info?.buttons ?? build?.buttons);
}

/** The build as the app remembers it. */
export function knownFrom(build: BaukastenBuild, from: KnownBuild['from'], at = Date.now()): KnownBuild {
  const k: KnownBuild = { id: build.id, board: build.board, buttons: build.buttons, from, at };
  if (build.knob) k.knob = build.knob;
  if (build.light) k.light = build.light;
  if (build.speakerOff) k.speakerOff = true;
  if (build.headphones) k.headphones = true;
  if (build.traeger) k.traeger = true;
  if (build.preset !== 'standard') k.preset = build.preset;
  if (build.alarm) k.alarm = true;
  if (build.writeCard) k.writeCard = true;
  return k;
}

export function rememberBuild(build: BaukastenBuild | null, from: KnownBuild['from'] = 'read'): void {
  const k = build ? knownFrom(build, from) : null;
  knownBuild.value = k;
  try {
    if (k) localStorage.setItem(KEY, JSON.stringify(k));
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; it still counts until the app closes.
  }
}

/** The extras of a known build as the wizard's choice. */
export function knownChoice(k: KnownBuild): ExtrasChoice {
  const c: ExtrasChoice = {};
  if (k.knob) c.knob = k.knob;
  if (k.light) c.light = k.light;
  if (k.speakerOff) c.speakerOff = true;
  if (k.headphones) c.headphones = true;
  if (k.traeger) c.traeger = true;
  if (k.preset) c.preset = k.preset;
  if (k.alarm) c.alarm = true;
  if (k.writeCard) c.writeCard = true;
  return c;
}

/**
 * After an upload: a Baukasten build is what the box has now; the firmware
 * put back from the backup is the one read before (kept); anything else has
 * extras the app does not know, so the memory is cleared.
 */
export function rememberFlashed(request: { firmware: { kind: string; baukasten?: { id: string } } }, findBuild?: (id: string) => BaukastenBuild | undefined): void {
  const f = request.firmware;
  if (f.kind === 'backup') return;
  if (f.kind === 'download' && f.baukasten) {
    const id = f.baukasten.id;
    const build = findBuild?.(id) ?? loadedBuilds.get(id);
    if (build) {
      rememberBuild(build, 'flashed');
      rememberBoxWritesCards(!!build.writeCard);
      return;
    }
  }
  // A ready-made official build has no WRITECARD (TNG builds it without); a file of unknown content is asked at the next connection.
  if (f.kind === 'download') rememberBoxWritesCards(false);
  rememberBuild(null);
}

/** Builds seen in the manifest, by id, so an upload can be remembered without loading it again. */
const loadedBuilds = new Map<string, BaukastenBuild>();

export function noteManifestBuilds(builds: readonly BaukastenBuild[]): void {
  for (const b of builds) loadedBuilds.set(b.id, b);
}
