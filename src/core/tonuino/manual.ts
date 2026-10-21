/**
 * The Bedienkarte: a short manual to print and give away with the box. What
 * every key does short and long, the Kurzwahlen, the special cards and when
 * the box switches off, in words a child's parents understand. It follows
 * the box the app knows (firmware, number of keys, settings from the
 * Steckbrief, extras of the Baukasten build).
 *
 * The key table is TNG 3.3.3, src/commands.cpp (columns adm, idle/pause,
 * play, play with IB:1). TonUINO 2.1 is close to it, but Play/Pause long
 * without music starts Kurzwahl 1, there is no "zum ersten Titel", and it does
 * not switch off with a key.
 */
import type { AdminAccess } from './boxguide';
import type { CardData, FirmwareProfile } from './card';
import { ADMIN_MODE } from './card';
import type { KnobKind, LightKind, PresetId } from '../firmware/baukasten';
import { modifiersFor, specialSummary } from './modes';

export interface ManualBox {
  profile: FirmwareProfile;
  buttons: 3 | 5;
  /** 3 keys: short press changes the volume (IB:1, from the factory). */
  shortPressVolume: boolean;
  /** Minutes without music until the box goes off; 0: never; undefined: not known. */
  standby?: number;
  /** TNG: the music stops when the card is taken off. */
  pauseWhenCardRemoved?: boolean;
  lock?: AdminAccess;
  knob?: KnobKind;
  light?: LightKind;
  headphones?: boolean;
  preset?: PresetId;
  /** Folder titles of the Kurzwahlen, by slot (1 to 4); a slot left out is not set. */
  shortcuts?: Partial<Record<1 | 2 | 3 | 4, string>>;
  /** The special cards that go with the box. */
  specials?: CardData[];
}

export interface ManualRow {
  /** The key, the card or what happens, e.g. "Vor lang". */
  what: string;
  does: string;
}

export interface ManualSection {
  title: string;
  rows: ManualRow[];
}

/** The keys as the card names them. */
export const KEY_NAMES = { pause: 'Play/Pause', up: 'Vor', down: 'Zurück', four: 'Lauter', five: 'Leiser' } as const;

function keyRows(box: ManualBox): ManualRow[] {
  const tng = box.profile === 'tng';
  const rows: ManualRow[] = [{ what: 'Play/Pause kurz', does: 'Pause und weiter' }];
  rows.push({
    what: 'Play/Pause lang',
    does: tng ? 'Beim Hören: sagt die Nummer des Titels. In der Pause: ausschalten' : 'Beim Hören: sagt die Nummer des Titels',
  });
  if (box.buttons === 5) {
    rows.push({ what: 'Vor kurz', does: 'Nächster Titel' });
    rows.push({ what: 'Zurück kurz', does: 'Voriger Titel' });
    if (tng) {
      rows.push({ what: 'Vor lang', does: '10 Titel weiter' });
      rows.push({ what: 'Zurück lang', does: '10 Titel zurück' });
    }
    rows.push({ what: 'Lauter / Leiser', does: 'Lauter und leiser' });
  } else if (box.shortPressVolume) {
    rows.push({ what: 'Vor kurz', does: 'Lauter' });
    rows.push({ what: 'Zurück kurz', does: 'Leiser' });
    rows.push({ what: 'Vor lang', does: 'Nächster Titel' });
    rows.push({ what: 'Zurück lang', does: 'Voriger Titel' });
  } else {
    rows.push({ what: 'Vor kurz', does: 'Nächster Titel' });
    rows.push({ what: 'Zurück kurz', does: 'Voriger Titel' });
    rows.push({ what: 'Vor lang', does: 'Lauter, solange du drückst' });
    rows.push({ what: 'Zurück lang', does: 'Leiser, solange du drückst' });
  }
  // TNG commands.cpp, updownLong while playing: to_first with 3 and with 5 buttons.
  if (tng) rows.push({ what: 'Vor + Zurück lang', does: 'Beim Hören: zurück zum ersten Titel' });
  if (box.knob === 'encoder') rows.push({ what: 'Drehregler', does: 'Lauter und leiser' });
  if (box.knob === 'encoderSkip') rows.push({ what: 'Drehregler', does: 'Schnell drehen: lauter und leiser. Ein Klick: nächster oder voriger Titel' });
  if (box.knob === 'poti') rows.push({ what: 'Lautstärke-Knopf', does: 'Die Stellung ist die Lautstärke' });
  // TNG src/buttons.cpp: allLong is Play/Pause + Vor + Zurück held; with 5 keys also Play/Pause + Lauter + Leiser.
  rows.push({ what: 'Play/Pause + Vor + Zurück lang', does: adminText(box.lock) });
  if (tng && box.buttons === 5) rows.push({ what: 'Play/Pause + Lauter + Leiser lang', does: 'Auch das öffnet das Admin-Menü' });
  return rows;
}

function adminText(lock: AdminAccess | undefined): string {
  if (lock === 'card') return 'Admin-Menü für Erwachsene, nur mit der Admin-Karte';
  if (lock === 'pin') return 'Admin-Menü für Erwachsene, mit PIN';
  if (lock === 'calc') return 'Admin-Menü für Erwachsene, mit Rechenaufgabe';
  return 'Admin-Menü für Erwachsene';
}

/** Where each Kurzwahl starts, for this firmware and number of keys. */
export function shortcutKeys(profile: FirmwareProfile): Record<1 | 2 | 3 | 4, string> {
  return {
    1: profile === 'tng' ? 'Vor + Zurück lang' : 'Play/Pause lang',
    2: 'Vor lang',
    3: 'Zurück lang',
    4: 'Beim Einschalten',
  };
}

function shortcutRows(box: ManualBox): ManualRow[] {
  const set = box.shortcuts ?? {};
  const keys = shortcutKeys(box.profile);
  return ([1, 2, 3, 4] as const)
    .filter((slot) => set[slot]?.trim())
    .map((slot) => ({ what: slot === 4 ? keys[4] : `${keys[slot]}, wenn nichts läuft`, does: set[slot]!.trim() }));
}

function cardRows(box: ManualBox): ManualRow[] {
  const rows: ManualRow[] = [
    { what: 'Karte auflegen', does: 'Spielt, was auf der Karte steht' },
    { what: 'Neue, leere Karte', does: 'Die Box fragt, was darauf soll' },
  ];
  if (box.profile === 'tng' && box.pauseWhenCardRemoved !== undefined) {
    rows.push({ what: 'Karte abnehmen', does: box.pauseWhenCardRemoved ? 'Die Musik hält an' : 'Die Musik läuft weiter' });
  }
  if (box.preset === 'weiter') {
    rows.push({ what: 'Dieselbe Karte noch mal', does: 'Geht weiter, wo sie war' });
    rows.push({ what: 'Play/Pause ohne Karte', does: 'Spielt die letzte Karte' });
  }
  return rows;
}

function specialRows(box: ManualBox): ManualRow[] {
  const mods = modifiersFor(box.profile);
  const seen = new Set<string>();
  const rows: ManualRow[] = [];
  for (const c of box.specials ?? []) {
    if (c.folder !== 0) continue;
    const key = `${c.mode}:${c.special}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.mode === ADMIN_MODE) continue; // Not for children: it stays off the card.
    const mod = mods.find((m) => m.code === c.mode);
    if (!mod) continue;
    rows.push({ what: mod.name, does: specialSummary(c, box.profile).replace(/\.$/, '') });
  }
  return rows;
}

function otherRows(box: ManualBox): ManualRow[] {
  const rows: ManualRow[] = [];
  if (box.standby !== undefined) {
    rows.push({
      what: 'Ausschalten',
      does: box.standby > 0 ? `Nach ${box.standby} Minuten ohne Musik geht die Box von selbst aus` : 'Die Box bleibt an, bis du sie ausschaltest',
    });
  }
  if (box.headphones) rows.push({ what: 'Kopfhörer einstecken', does: 'Der Lautsprecher ist aus, die Lautstärke hat eigene Grenzen' });
  if (box.light === 'ring' || box.light === 'ringVolume') rows.push({ what: 'Leuchtring', does: 'Pulsiert grün: wartet auf eine Karte. Regenbogen: spielt' });
  if (box.light === 'ledButtons') rows.push({ what: 'Leuchtende Tasten', does: 'Blinken: wartet. Leuchten: spielt. Nur Play/Pause blinkt: Pause' });
  return rows;
}

/** The sections of the card, empty ones left out. */
export function manualSections(box: ManualBox): ManualSection[] {
  return [
    { title: 'Tasten', rows: keyRows(box) },
    { title: 'Kurzwahlen', rows: shortcutRows(box) },
    { title: 'Karten', rows: cardRows(box) },
    { title: 'Spezialkarten', rows: specialRows(box) },
    { title: 'Gut zu wissen', rows: otherRows(box) },
  ].filter((s) => s.rows.length > 0);
}
