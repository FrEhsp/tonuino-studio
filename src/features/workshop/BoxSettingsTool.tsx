/**
 * Box einstellen: volume limits, Ausschalt-Timer, buttons, lock and more,
 * chosen in a form and done step by step in the box's own admin menu. The
 * steps come from settingsguide.ts; what the box has now comes from the
 * Steckbrief of the Box-Logbuch, when it ran in this session.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { CircleAlert, CircleCheck, CreditCard, Info, NotebookText } from 'lucide-preact';
import type { BoxInfo } from '../../core/firmware/bootlog';
import type { BoardId } from '../../core/firmware/variants';
import { ADMIN_KEYS, ADMIN_KEYS_FIVE, adminKeys, keyCount, type KeyCount } from '../../core/tonuino/adminkeys';
import { adminAccessFor, effectiveAccess, type AdminAccess } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { adminCard } from '../../core/tonuino/modes';
import {
  FACTORY_SETTINGS,
  MAX_VOLUME,
  SHORTCUT_MODES,
  STANDBY_OPTIONS,
  settingsGuide,
  shortcutSlots,
  volumeProblem,
  type BoxSettingValues,
  type PinKey,
  type SettingsWish,
  type Volumes,
} from '../../core/tonuino/settingsguide';
import { Button, Callout, Field, Segmented } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { plat, profile, setProfile, settings, updateSettings } from '../../app/state';
import { GuideStep, KeyLegend } from '../cards/BoxPanel';
import { ADMIN_ACCESS } from '../settings/options';
import { addExtraCard } from '../cards/items';
import { SettingCheck, ToolHeader } from './common';
import { logSession } from './logsession';
import { knownBuild } from './boxbuild';
import { HeadphoneLimits } from './HeadphoneLimits';

type Part = 'volume' | 'standby' | 'buttons' | 'cardRemoved' | 'lock' | 'shortcut' | 'eq' | 'reset';
type Preset = 'kinderzimmer' | 'werk' | 'eigene';

const PRESETS: { id: Exclude<Preset, 'eigene'>; title: string; volume: Volumes }[] = [
  { id: 'kinderzimmer', title: 'Fürs Kinderzimmer', volume: { max: 20, min: 1, init: 8 } },
  { id: 'werk', title: 'Wie ab Werk', volume: { ...FACTORY_SETTINGS.volume } },
];

/** What the form holds; numbers of "Eigene Werte" stay text until they are checked. */
interface Draft {
  on: Record<Part, boolean>;
  preset: Preset;
  volume: { max: string; min: string; init: string };
  standby: number;
  shortPressVolume: boolean;
  pauseWhenCardRemoved: boolean;
  lock: AdminAccess;
  pin: (PinKey | '')[];
  eq: number;
  shortcut: { slot: number; folder: string; mode: number };
}

const NOTHING_ON: Record<Part, boolean> = { volume: false, standby: false, buttons: false, cardRemoved: false, lock: false, shortcut: false, eq: false, reset: false };

/** The form survives a trip to the cards page (for the admin card) and back. */
const draft = signal<Draft | undefined>(undefined);
/** What was set at the box with this page in this session, on top of the Steckbrief it was based on. */
const applied = signal<Applied | undefined>(undefined);
const doneNote = signal<string | undefined>(undefined);

/* ------------------------------------------------------------------ what is known */

/**
 * The Steckbrief a guide was based on: the log, the start of the box in it
 * and what that start reported. Any newer reading replaces it.
 */
export interface Basis {
  book: object | undefined;
  /** Connections and starts the log had seen (Logbook.readings). */
  readings: number;
  seen: string;
}

/** Values set with "Erledigt", and the Steckbrief they were set on top of. */
export interface Applied {
  values: BoxSettingValues;
  basis: Basis;
}

export function basisOf(book: object | undefined, readings: number, fromLog: BoxSettingValues): Basis {
  return { book, readings, seen: JSON.stringify(fromLog) };
}

/**
 * What the box has now: the Steckbrief, with what was set at the box on top,
 * but only while the Steckbrief is still the one the guide started from. A
 * new start of the box, a new connection or another box wins.
 */
export function currentValues(fromLog: BoxSettingValues, basis: Basis, done?: Applied): BoxSettingValues {
  const same = done && done.basis.book === basis.book && done.basis.readings === basis.readings && done.basis.seen === basis.seen;
  return same ? { ...fromLog, ...done.values } : fromLog;
}

/** The Steckbrief says the menu is locked with a PIN, but the stored PIN cannot be typed in. */
export function pinUnusable(info: BoxInfo): boolean {
  const s = info.settings;
  return s.adminLock?.kind === 'pin' && s.adminPin !== undefined && !valuesFromInfo(info).pin;
}

interface BoxKnowledge {
  values: BoxSettingValues;
  basis: Basis;
  /** The Box-Logbuch saw the settings of this box. */
  fromLog: boolean;
  /** The Box-Logbuch shows a saved file with settings; they may be old, so they are not used. */
  fileName?: string;
  /** That file says the admin menu was locked: the steps may not open it the way the app thinks. */
  fileLock?: AdminAccess;
  /** Only the admin card opens the menu: the PIN lock has a PIN that cannot be typed. */
  cardOnly: boolean;
  firmware?: FirmwareProfile;
  board?: BoardId;
  buttons?: string;
  headphones?: boolean;
}

const PIN_KEYS: Record<number, PinKey> = { 1: 'pause', 2: 'up', 3: 'down' };

/** The admin-menu settings the Steckbrief knows. */
export function valuesFromInfo(info: BoxInfo): BoxSettingValues {
  const s = info.settings;
  const values: BoxSettingValues = {};
  if (s.speakerVolume) values.volume = { ...s.speakerVolume };
  if (s.standbyTimerMinutes !== undefined) values.standby = s.standbyTimerMinutes;
  if (s.invertVolumeButtons !== undefined) values.shortPressVolume = s.invertVolumeButtons;
  if (s.pauseWhenCardRemoved !== undefined) values.pauseWhenCardRemoved = s.pauseWhenCardRemoved;
  if (s.eq !== undefined) values.eq = s.eq;
  const lock = s.adminLock?.kind;
  if (lock === 'none') values.lock = 'buttons';
  else if (lock === 'card' || lock === 'pin' || lock === 'calc') values.lock = lock;
  if (s.adminPin && s.adminPin.length === 4 && s.adminPin.every((k) => PIN_KEYS[k])) values.pin = s.adminPin.map((k) => PIN_KEYS[k]);
  return values;
}

/** The lock a Steckbrief reports, when there is one: card, PIN or sum. */
export function lockOf(info: BoxInfo): AdminAccess | undefined {
  const lock = valuesFromInfo(info).lock;
  return lock === 'buttons' ? undefined : lock;
}

function knowledge(): BoxKnowledge {
  // Read for the signal: a new Steckbrief shows up at once.
  void logSession.revision.value;
  const book = logSession.book;
  const source = logSession.source;
  const info = source.kind === 'live' ? book.info : undefined;
  const fromLog = info ? valuesFromInfo(info) : {};
  const basis = basisOf(book, book.readings, fromLog);
  const fileHasSettings = source.kind === 'file' && Object.keys(valuesFromInfo(book.info)).length > 0;
  return {
    values: currentValues(fromLog, basis, applied.value),
    basis,
    fromLog: Object.keys(fromLog).length > 0,
    fileName: fileHasSettings && source.kind === 'file' ? source.name : undefined,
    fileLock: fileHasSettings ? lockOf(book.info) : undefined,
    cardOnly: !!info && pinUnusable(info),
    firmware: info?.firmware,
    board: info?.board,
    // The build the app knows tells the keys when the log does not (as on the Bedienkarte).
    buttons: info?.buttons ?? knownBuild.value?.buttons,
    headphones: info?.headphones,
  };
}

function presetOf(v: Volumes): Preset {
  return PRESETS.find((p) => p.volume.max === v.max && p.volume.min === v.min && p.volume.init === v.init)?.id ?? 'eigene';
}

/** The form as the box is now, or as it comes from the factory. */
function draftFrom(values: BoxSettingValues): Draft {
  const v = values.volume ?? FACTORY_SETTINGS.volume;
  return {
    on: { ...NOTHING_ON },
    preset: presetOf(v),
    volume: { max: String(v.max), min: String(v.min), init: String(v.init) },
    standby: values.standby ?? FACTORY_SETTINGS.standby,
    shortPressVolume: values.shortPressVolume ?? FACTORY_SETTINGS.shortPressVolume,
    pauseWhenCardRemoved: values.pauseWhenCardRemoved ?? FACTORY_SETTINGS.pauseWhenCardRemoved,
    lock: values.lock ?? 'buttons',
    pin: values.pin ? [...values.pin] : ['', '', '', ''],
    eq: values.eq ?? FACTORY_SETTINGS.eq,
    shortcut: { slot: 2, folder: '1', mode: 2 },
  };
}

function volumeOf(d: Draft): Volumes {
  if (d.preset !== 'eigene') return { ...PRESETS.find((p) => p.id === d.preset)!.volume };
  const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
  return { max: num(d.volume.max), min: num(d.volume.min), init: num(d.volume.init) };
}

/* ------------------------------------------------------------------ texts */

function levelsText(v: Volumes): string {
  return `${v.min} bis ${v.max}, beim Einschalten ${v.init}`;
}

function standbyText(minutes: number): string {
  return minutes === 0 ? 'aus' : `nach ${minutes} Minuten ohne Musik`;
}

const LOCK_TEXT: Record<AdminAccess, string> = {
  buttons: 'nicht geschützt',
  card: 'nur mit Admin-Karte',
  pin: 'mit PIN',
  calc: 'mit Rechenaufgabe',
};

const EQ_LABELS = ['Normal', 'Pop', 'Rock', 'Jazz', 'Klassik', 'Bass'];

/** "Jetzt: …" when the Steckbrief knows it, else the value from the factory. */
/** "der Admin-Karte", "einer PIN": to follow "mit". */
function accessLabel(a: AdminAccess): string {
  return ADMIN_ACCESS.find((c) => c.value === a)?.label ?? a;
}

function nowLine(known: boolean, text: string): string {
  return known ? `Jetzt: ${text}` : `Ab Werk: ${text}`;
}

/** "Tasten" applies to three keys only (TNG commands.cpp: no play_invert with FIVEBUTTONS); said when the keys are not known. */
export const BUTTONS_PART_HINT = 'Nur bei Boxen mit 3 Tasten. Mit 5 Tasten haben Lauter und Leiser eigene Tasten.';

/** "Nicht schützen" in words that fit the keys of the box (adminkeys.ts). */
export function noLockText(prof: FirmwareProfile, keys?: KeyCount): string {
  const five = prof === 'tng' && keys === 5 ? `, mit 5 Tasten auch ${ADMIN_KEYS_FIVE}` : '';
  return `${ADMIN_KEYS} zusammen lang gedrückt öffnen das Menü${five}. So ist es ab Werk.`;
}

/** After "Erledigt" with a new lock: how the card guides open the admin menu from now on. */
export function lockDoneNote(lock: AdminAccess, prof: FirmwareProfile, keys?: KeyCount): string {
  const how = lock === 'buttons' ? `mit ${adminKeys(prof, keys)}` : lock === 'card' ? 'mit der Admin-Karte' : lock === 'pin' ? 'mit der PIN' : 'mit der Rechenaufgabe';
  return `Gemerkt. Die Anleitungen für Karten öffnen das Admin-Menü jetzt ${how}.`;
}

/* ------------------------------------------------------------------ page */

export function BoxSettingsTool() {
  const prof = profile.value;
  const box = knowledge();
  if (!draft.value) draft.value = draftFrom(box.values);
  const d = draft.value;
  const set = (patch: Partial<Draft>) => {
    draft.value = { ...d, ...patch };
    doneNote.value = undefined;
  };
  const toggle = (part: Part, on: boolean) => {
    // Turned on, a part starts from what the box has now.
    const fresh = draftFrom(box.values);
    const from: Partial<Draft> =
      part === 'volume'
        ? { preset: fresh.preset, volume: fresh.volume }
        : part === 'standby'
          ? { standby: fresh.standby }
          : part === 'buttons'
            ? { shortPressVolume: fresh.shortPressVolume }
            : part === 'cardRemoved'
              ? { pauseWhenCardRemoved: fresh.pauseWhenCardRemoved }
              : part === 'lock'
                ? { lock: fresh.lock, pin: fresh.pin }
                : part === 'eq'
                  ? { eq: fresh.eq }
                  : {};
    set({ ...(on ? from : {}), on: { ...d.on, [part]: on } });
  };

  const tng = prof === 'tng';
  const serial = plat().capabilities.serial;
  const keys = keyCount(box.buttons);
  const threeButtons = keys !== 5;
  const visible: Record<Part, boolean> = { volume: true, standby: true, buttons: threeButtons, cardRemoved: tng, lock: true, shortcut: true, eq: true, reset: true };
  const isOn = (p: Part) => visible[p] && d.on[p];

  const wish: SettingsWish = {};
  if (isOn('reset')) wish.reset = true;
  if (isOn('volume')) wish.volume = volumeOf(d);
  if (isOn('standby')) wish.standby = d.standby;
  if (isOn('buttons')) wish.shortPressVolume = d.shortPressVolume;
  if (isOn('cardRemoved')) wish.pauseWhenCardRemoved = d.pauseWhenCardRemoved;
  if (isOn('lock')) {
    wish.lock = d.lock;
    if (d.lock === 'pin') wish.pin = d.pin.filter((k): k is PinKey => k !== '');
  }
  if (isOn('eq')) wish.eq = d.eq;
  if (isOn('shortcut')) wish.shortcut = { slot: d.shortcut.slot, folder: d.shortcut.folder.trim() === '' ? Number.NaN : Number(d.shortcut.folder), mode: d.shortcut.mode };

  const access = effectiveAccess(settings.value.adminAccess, prof);
  const result = settingsGuide(prof, wish, box.values, { access, open: box.cardOnly ? 'card' : undefined, buttons: keys });
  const anyOn = (Object.keys(visible) as Part[]).some(isOn);

  const finish = () => {
    if (!result.ok) return;
    const after: BoxSettingValues = wish.reset ? { ...FACTORY_SETTINGS, volume: { ...FACTORY_SETTINGS.volume } } : {};
    if (wish.volume) after.volume = wish.volume;
    if (wish.standby !== undefined) after.standby = wish.standby;
    if (wish.shortPressVolume !== undefined) after.shortPressVolume = wish.shortPressVolume;
    if (wish.pauseWhenCardRemoved !== undefined) after.pauseWhenCardRemoved = wish.pauseWhenCardRemoved;
    if (wish.eq !== undefined) after.eq = wish.eq;
    if (wish.lock !== undefined) after.lock = wish.lock;
    if (wish.pin) after.pin = wish.pin;
    // Layered on what this guide started from; a newer Steckbrief later replaces both.
    applied.value = { values: { ...currentValues({}, box.basis, applied.value), ...after }, basis: box.basis };
    const lock = wish.lock ?? (wish.reset ? 'buttons' : undefined);
    if (lock !== undefined && lock !== settings.value.adminAccess) updateSettings({ adminAccess: lock });
    draft.value = { ...draftFrom({ ...box.values, ...after }), on: { ...NOTHING_ON } };
    doneNote.value =
      lock !== undefined
        ? lockDoneNote(lock, prof, keys)
        : 'Erledigt. Oben stehen jetzt die neuen Werte, bis du die App schließt. Willst du noch etwas ändern, schalte es oben wieder ein.';
  };

  return (
    <div class="page narrow ws-page">
      <ToolHeader title="Box einstellen" intro="Lautstärke begrenzen, Ausschalt-Timer, Sperren: Wähle hier aus, wie die Box sein soll. Danach zeigt die Seite Schritt für Schritt, welche Tasten du an der Box drückst." />

      <section class="card pad stack" aria-labelledby="ws-set-box">
        <h2 id="ws-set-box" class="ws-set-title">
          Deine Box
        </h2>
        <div class="row wrap ws-set-firmware">
          <span class="field-label">Firmware</span>
          <Segmented<FirmwareProfile>
            label="Firmware der Box"
            value={prof}
            options={[
              { value: 'tng', label: 'TonUINO TNG' },
              { value: 'classic21', label: 'TonUINO 2.1' },
            ]}
            onChange={(p) => setProfile(p).catch((e) => toastError('Speichern hat nicht geklappt', e))}
          />
        </div>
        {box.firmware && box.firmware !== prof ? (
          <Callout tone="warning">Das Box-Logbuch hat eben {box.firmware === 'tng' ? 'TonUINO TNG' : 'TonUINO 2.1'} gesehen. Stelle oben die Firmware der Box ein, sonst passen die Schritte nicht.</Callout>
        ) : null}
        {box.fromLog ? (
          <p class="small soft row tight ws-set-source">
            <NotebookText size={16} aria-hidden="true" /> Was jetzt eingestellt ist, stammt aus dem Box-Logbuch. Darum steht bei jedem Schritt genau, wie oft du drückst.
          </p>
        ) : box.fileName ? (
          // A saved file is not used for the values: they may be old.
          <div class="ws-set-unknown">
            <p class="small soft">
              Das Box-Logbuch zeigt die gespeicherte Datei „{box.fileName}“. Ihre Werte können veraltet sein, darum stehen hier die Werte ab Werk.{' '}
              {serial
                ? 'Lies die Box im Box-Logbuch neu aus, dann steht bei jedem Schritt genau, wie oft du drückst.'
                : 'Lies die Box in Chrome, Edge, Firefox ab Version 151 oder der Desktop-App neu aus, dann steht bei jedem Schritt genau, wie oft du drückst.'}
            </p>
            {serial ? (
              <a class="link-button" href="#/werkstatt/logbuch">
                <NotebookText size={16} aria-hidden="true" /> Box neu auslesen
              </a>
            ) : null}
          </div>
        ) : !serial ? (
          // Without USB the Box-Logbuch cannot read the box.
          <p class="small soft ws-set-source">
            Genau zählen kann ich nur, wenn ich die Box über USB auslese. Das geht in Chrome, Edge, Firefox ab Version 151 oder der Desktop-App. Hier stehen die Werte ab Werk.
          </p>
        ) : (
          <div class="ws-set-unknown">
            <p class="small soft">Ich kenne die Einstellungen deiner Box noch nicht. Darum stehen hier die Werte ab Werk. Liest du die Box vorher im Box-Logbuch aus, steht bei jedem Schritt genau, wie oft du drückst.</p>
            <a class="link-button" href="#/werkstatt/logbuch">
              <NotebookText size={16} aria-hidden="true" /> Box-Logbuch öffnen
            </a>
          </div>
        )}
        {box.fileLock && box.fileLock !== access ? (
          <Callout tone="warning">
            {adminAccessFor(prof).includes(box.fileLock) ? (
              // The choice right here: on the settings page it is far down, under another heading.
              <div class="stack tight">
                <span>
                  Laut der Datei ist das Admin-Menü mit {accessLabel(box.fileLock)} geschützt. Die Schritte unten öffnen es mit {accessLabel(access)}. Hast du die Sperre inzwischen geändert, lasse es so.
                </span>
                <div>
                  <Button size="sm" onClick={() => updateSettings({ adminAccess: box.fileLock })}>
                    Schritte mit {accessLabel(box.fileLock)} zeigen
                  </Button>
                </div>
              </div>
            ) : (
              <>
                Laut der Datei ist das Admin-Menü mit {accessLabel(box.fileLock)} geschützt. Die Schritte unten öffnen es mit {accessLabel(access)}. Ist die Box noch gesperrt, stelle in den <a href="#/einstellungen">Einstellungen</a> unter „Für Bastler“ bei „Das Admin-Menü öffnest du mit“ ein, wie du es öffnest.
              </>
            )}
          </Callout>
        ) : null}
        {box.cardOnly ? (
          <Callout tone="warning" icon={CreditCard}>
            <div class="stack tight">
              <span>Die Box ist mit einer PIN gesperrt, die sich nicht eingeben lässt. Ins Admin-Menü kommst du nur mit der Admin-Karte, darum öffnen die Schritte das Menü mit ihr.</span>
              <div>
                <AdminCardButton />
              </div>
            </div>
          </Callout>
        ) : null}
        {box.board === 'esp32nano' || box.board === 'esp32wroom' ? <p class="small soft">Bei deiner Box mit ESP32 geht das auch auf der Webseite der Box.</p> : null}
      </section>

      <section class="stack" aria-labelledby="ws-set-what">
        {/* Ticks, not switches: nothing here changes the box by itself, it only shows the buttons to press (audit 0.4 #17). */}
        <h2 id="ws-set-what" class="ws-set-title">
          Was willst du ändern? Ich zeig dir dann die Tasten.
        </h2>

        <Part title="Lautstärke" now={nowLine(!!box.values.volume, levelsText(box.values.volume ?? FACTORY_SETTINGS.volume))} on={d.on.volume} onToggle={(on) => toggle('volume', on)}>
          <VolumeChoice d={d} set={set} />
          {tng && box.headphones ? <Callout tone="warning">Laut Box-Logbuch steckt ein Kopfhörer. Ziehe ihn ab, bevor du die Lautstärke einstellst. Sonst gelten die Werte nur für den Kopfhörer.</Callout> : null}
        </Part>

        <HeadphoneLimits prof={prof} access={access} open={box.cardOnly ? 'card' : undefined} buttons={keys} />

        <Part title="Ausschalt-Timer" now={nowLine(box.values.standby !== undefined, standbyText(box.values.standby ?? 0))} on={d.on.standby} onToggle={(on) => toggle('standby', on)}>
          <StandbyChoice d={d} set={set} board={box.board} prof={prof} />
        </Part>

        {visible.buttons ? (
          <Part
            title="Tasten"
            now={nowLine(box.values.shortPressVolume !== undefined, (box.values.shortPressVolume ?? true) ? 'kurz drücken ändert die Lautstärke' : 'kurz drücken wechselt den Titel')}
            hint={keys === undefined ? BUTTONS_PART_HINT : undefined}
            on={d.on.buttons}
            onToggle={(on) => toggle('buttons', on)}
          >
            <Radios<boolean>
              label="Kurz drücken"
              value={d.shortPressVolume}
              onChange={(shortPressVolume) => set({ shortPressVolume })}
              options={[
                { value: true, title: 'Kurz drücken ändert die Lautstärke', text: 'Vor macht lauter, Zurück leiser. Lang drücken springt zum nächsten oder vorigen Titel. So ist es ab Werk.' },
                { value: false, title: 'Kurz drücken wechselt den Titel', text: 'Lang drücken ändert die Lautstärke: Vor macht lauter, Zurück leiser.' },
              ]}
            />
          </Part>
        ) : null}

        {visible.cardRemoved ? (
          <Part
            title="Karte wegnehmen"
            now={nowLine(box.values.pauseWhenCardRemoved !== undefined, (box.values.pauseWhenCardRemoved ?? false) ? 'Box hält an' : 'Box spielt weiter')}
            on={d.on.cardRemoved}
            onToggle={(on) => toggle('cardRemoved', on)}
          >
            <Radios<boolean>
              label="Karte wegnehmen"
              value={d.pauseWhenCardRemoved}
              onChange={(pauseWhenCardRemoved) => set({ pauseWhenCardRemoved })}
              options={[
                { value: false, title: 'Box spielt weiter', text: 'Die Karte startet die Musik, danach darf sie weg. So ist es ab Werk.' },
                { value: true, title: 'Box hält an, wenn die Karte weg ist', text: 'Die Karte bleibt liegen, solange die Musik spielen soll.' },
              ]}
            />
            {d.pauseWhenCardRemoved ? <p class="small soft">Geht nicht zusammen mit der Karte „Kita-Modus“. Das sagt die Box auch selbst.</p> : null}
          </Part>
        ) : null}

        <Part title="Admin-Menü schützen" now={nowLine(box.values.lock !== undefined, LOCK_TEXT[box.values.lock ?? 'buttons'])} on={d.on.lock} onToggle={(on) => toggle('lock', on)}>
          <LockChoice d={d} set={set} prof={prof} keys={keys} />
        </Part>

        <h3 class="section-title ws-set-more">Weitere Einstellungen</h3>

        <Part title="Kurzwahl" hint="Ein Ordner startet mit einem langen Tastendruck." on={d.on.shortcut} onToggle={(on) => toggle('shortcut', on)}>
          <ShortcutChoice d={d} set={set} prof={prof} />
        </Part>

        <Part title="Klang" now={nowLine(box.values.eq !== undefined, EQ_LABELS[(box.values.eq ?? 1) - 1] ?? 'Normal')} on={d.on.eq} onToggle={(on) => toggle('eq', on)}>
          <Segmented<number> label="Klang" value={d.eq} options={EQ_LABELS.map((label, i) => ({ value: i + 1, label }))} onChange={(eq) => set({ eq })} />
        </Part>

        <Part title="Alles zurücksetzen" hint="Zuerst alle Einstellungen der Box löschen." on={d.on.reset} onToggle={(on) => toggle('reset', on)}>
          <Callout tone="warning">
            Die Box vergisst alle Einstellungen: Lautstärke, Timer, Sperre und Kurzwahlen sind danach wie ab Werk. Hörbücher fangen wieder vorn an. Karten und SD-Karte bleiben, wie sie sind.
          </Callout>
        </Part>
      </section>

      <section class="card pad stack" aria-labelledby="ws-set-guide">
        <h2 id="ws-set-guide" class="ws-set-title">
          So geht’s an der Box
        </h2>
        {doneNote.value ? <Callout tone="success">{doneNote.value}</Callout> : null}
        {!anyOn ? (
          <p class="soft">Schalte oben ein, was du ändern willst. Dann stehen hier die Schritte.</p>
        ) : !result.ok ? (
          <Callout tone="danger" icon={CircleAlert}>
            {result.reason}
          </Callout>
        ) : !result.guide.steps.length ? (
          <Callout tone="success" icon={CircleCheck}>
            Die Box ist schon so eingestellt. Du musst nichts drücken.
          </Callout>
        ) : (
          <>
            <KeyLegend />
            <div class="guide">
              <div class="guide-head">
                <div class="guide-title">
                  <span class="guide-count">{result.guide.steps.length} Schritte</span>
                  <strong>{tng ? 'TonUINO TNG' : 'TonUINO 2.1'}</strong>
                  <span class="soft small">{tng ? 'Die Box bleibt im Admin-Menü, bis du es verlässt.' : 'Die Box verlässt das Admin-Menü nach jeder Einstellung. Darum öffnest du es jedes Mal neu.'}</span>
                </div>
              </div>
              <ol class="guide-steps">
                {result.guide.steps.map((s, i) => (
                  <GuideStep step={s} n={i + 1} key={i} />
                ))}
              </ol>
              {result.guide.notes.length || result.guide.unchanged.length ? (
                <div class="guide-notes">
                  {result.guide.unchanged.length ? (
                    <p>
                      <CircleCheck size={15} /> Stimmt schon und braucht keinen Schritt: {result.guide.unchanged.join(', ')}.
                    </p>
                  ) : null}
                  {result.guide.notes.map((n) => (
                    <p key={n}>
                      <Info size={15} /> {n}
                    </p>
                  ))}
                </div>
              ) : null}
              <p class="guide-help">Verdrückt? Mit der anderen Taste gehst du eine Zahl zurück. Ganz von vorn: die Play/Pause-Taste lang drücken, dann bricht die Box ab. Was schon gespeichert ist, bleibt.</p>
            </div>
            <div class="row wrap">
              <Button variant="primary" icon={CircleCheck} onClick={finish}>
                Erledigt: Die Box ist eingestellt
              </Button>
              <span class="small muted">Dann zeigt diese Seite die neuen Werte, bis du die App schließt{wish.lock !== undefined ? '. Die Sperre für die Karten-Anleitungen merk ich mir dauerhaft' : ''}.</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function Part({ title, now, hint, on, onToggle, children }: { title: string; now?: string; hint?: string; on: boolean; onToggle: (on: boolean) => void; children: ComponentChildren }) {
  return (
    <div class={`card ws-set ${on ? 'on' : ''}`}>
      <div class="ws-set-head">
        <SettingCheck checked={on} onChange={onToggle} title={title} note={now && hint ? `${now} · ${hint}` : (now ?? hint)} />
      </div>
      {on ? <div class="ws-set-body stack">{children}</div> : null}
    </div>
  );
}

/** Big options as native radio buttons: arrow keys and screen readers work as everywhere. */
function Radios<T extends string | number | boolean>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; title: string; text?: string }[]; onChange: (v: T) => void }) {
  const [name] = useState(() => `ws-radio-${Math.random().toString(36).slice(2)}`);
  return (
    <div class="choices ws-radios" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={String(o.value)} class={`choice ws-radio ${o.value === value ? 'on' : ''}`}>
          <input type="radio" name={name} class="visually-hidden" checked={o.value === value} onChange={() => onChange(o.value)} />
          <span class="choice-title">{o.title}</span>
          {o.text ? <span class="choice-text">{o.text}</span> : null}
        </label>
      ))}
    </div>
  );
}

type SetDraft = (patch: Partial<Draft>) => void;

function VolumeChoice({ d, set }: { d: Draft; set: SetDraft }) {
  const own = d.preset === 'eigene';
  const problem = own ? volumeProblem(volumeOf(d)) : undefined;
  const field = (key: 'max' | 'min' | 'init', label: string) => (
    <Field label={label} id={`ws-vol-${key}`}>
      <input
        id={`ws-vol-${key}`}
        class="input"
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_VOLUME}
        value={d.volume[key]}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? 'ws-vol-problem' : 'ws-vol-hint'}
        onInput={(e) => set({ volume: { ...d.volume, [key]: (e.currentTarget as HTMLInputElement).value } })}
      />
    </Field>
  );
  return (
    <>
      <Radios<Preset>
        label="Lautstärke"
        value={d.preset}
        onChange={(preset) => {
          const p = PRESETS.find((x) => x.id === preset);
          set({ preset, volume: p ? { max: String(p.volume.max), min: String(p.volume.min), init: String(p.volume.init) } : d.volume });
        }}
        options={[
          { value: 'kinderzimmer', title: 'Fürs Kinderzimmer', text: 'Höchstens 20, mindestens 1, beim Einschalten 8.' },
          { value: 'werk', title: 'Wie ab Werk', text: 'Höchstens 25, mindestens 5, beim Einschalten 15.' },
          { value: 'eigene', title: 'Eigene Werte', text: 'Du wählst die Zahlen selbst.' },
        ]}
      />
      {own ? (
        <div class="stack tight">
          <div class="ws-vol-fields">
            {field('max', 'Am lautesten')}
            {field('min', 'Am leisesten')}
            {field('init', 'Beim Einschalten')}
          </div>
          <p class="small muted" id="ws-vol-hint">
            Von 1 bis {MAX_VOLUME}. Mehr als {MAX_VOLUME} kann der MP3-Player nicht.
          </p>
          {problem ? (
            <p class="ws-set-problem" id="ws-vol-problem" role="alert">
              <CircleAlert size={16} aria-hidden="true" /> {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

const AIO_BOARDS: readonly BoardId[] = ['aio', 'aioplus'];

/**
 * What happens without the timer. TNG switches off when Pause is held while
 * nothing plays (commands.cpp: pauseLong in idle/pause is shutdown); 2.1 has
 * no such key and starts a shortcut instead.
 */
export function standbyOffText(profile: FirmwareProfile): string {
  return profile === 'tng'
    ? 'Dann geht die Box nicht von selbst aus. Halte die Play/Pause-Taste lang gedrückt, während nichts läuft: Dann geht sie aus. Vergisst du das und hat die Box keinen Schalter, ist der Akku irgendwann leer.'
    : 'Dann geht die Box nur mit ihrem Schalter aus. Hat sie keinen, ist der Akku irgendwann leer.';
}

function StandbyChoice({ d, set, board, prof }: { d: Draft; set: SetDraft; board?: BoardId; prof: FirmwareProfile }) {
  const switchesOff = board !== undefined && AIO_BOARDS.includes(board);
  // The Pause key of TNG puts a box without power-off parts to sleep just like the timer does.
  const sleepNote = !switchesOff && (d.standby !== 0 || prof === 'tng');
  return (
    <>
      <span class="field-label">Ausschalten, wenn nichts läuft</span>
      <Segmented<number>
        label="Ausschalten, wenn nichts läuft"
        value={d.standby}
        options={STANDBY_OPTIONS.map((m) => ({ value: m, label: m === 0 ? 'nie' : `nach ${m} Min.` }))}
        onChange={(standby) => set({ standby })}
      />
      {d.standby === 0 ? <Callout tone="warning">{standbyOffText(prof)}</Callout> : null}
      {sleepNote ? (
        <Callout tone="info">Hat deine Box nichts, was sie ganz abschaltet (das haben AiO, AiO+ und Boxen mit Pololu-Schalter), schläft sie nur ein. Wach wird sie erst wieder, wenn du den Strom kurz trennst.</Callout>
      ) : null}
    </>
  );
}

const PIN_OPTIONS: { value: PinKey; label: string }[] = [
  { value: 'pause', label: 'Play/Pause' },
  { value: 'up', label: 'Vor' },
  { value: 'down', label: 'Zurück' },
];

/** Puts an admin card on the list of cards to write and opens the cards page. */
function AdminCardButton() {
  const [busy, setBusy] = useState(false);
  const writeAdminCard = async () => {
    setBusy(true);
    try {
      await addExtraCard(adminCard(), 'Admin-Karte');
      navigate({ page: 'cards' });
    } catch (e) {
      toastError('Die Admin-Karte ließ sich nicht hinzufügen', e);
      setBusy(false);
    }
  };
  return (
    <Button size="sm" icon={CreditCard} loading={busy} onClick={writeAdminCard}>
      Schreibe zuerst eine Admin-Karte
    </Button>
  );
}

function LockChoice({ d, set, prof, keys }: { d: Draft; set: SetDraft; prof: FirmwareProfile; keys?: KeyCount }) {
  const offered = adminAccessFor(prof);
  const options: { value: AdminAccess; title: string; text: string }[] = [
    { value: 'buttons', title: 'Nicht schützen', text: noLockText(prof, keys) },
    { value: 'card', title: 'Mit Admin-Karte', text: 'Nur die Admin-Karte öffnet das Menü.' },
    { value: 'pin', title: 'Mit PIN', text: 'Erst vier Tastendrücke, dann öffnet sich das Menü.' },
    { value: 'calc', title: 'Mit Rechenaufgabe', text: 'Die Box stellt eine Aufgabe. Nur bei TonUINO 2.1.' },
  ];
  return (
    <>
      <Radios<AdminAccess> label="Admin-Menü schützen" value={d.lock} onChange={(lock) => set({ lock })} options={options.filter((o) => offered.includes(o.value))} />
      {d.lock === 'pin' ? (
        <fieldset class="ws-pin">
          <legend class="field-label">Deine PIN: vier Tasten nacheinander</legend>
          <div class="ws-pin-keys">
            {d.pin.map((k, i) => (
              <select
                key={i}
                class="select"
                aria-label={`${i + 1}. Taste`}
                value={k}
                onChange={(e) => {
                  const pin = [...d.pin];
                  pin[i] = (e.currentTarget as HTMLSelectElement).value as PinKey | '';
                  set({ pin });
                }}
              >
                <option value="">{i + 1}. Taste</option>
                {PIN_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ))}
          </div>
        </fieldset>
      ) : null}
      {d.lock === 'card' || d.lock === 'pin' ? (
        <Callout tone="info" icon={CreditCard}>
          <div class="stack tight">
            <span>
              {d.lock === 'card'
                ? 'Danach öffnet nur noch die Admin-Karte das Menü. Schreibe sie, bevor du die Box sperrst.'
                : 'Vergisst du die PIN, öffnet eine Admin-Karte das Menü trotzdem. Schreibe am besten zuerst eine.'}
            </span>
            <div>
              <AdminCardButton />
            </div>
          </div>
        </Callout>
      ) : null}
    </>
  );
}

function ShortcutChoice({ d, set, prof }: { d: Draft; set: SetDraft; prof: FirmwareProfile }) {
  const slots = shortcutSlots(prof);
  const sc = d.shortcut;
  const played = SHORTCUT_MODES.find((m) => m.mode === sc.mode);
  return (
    <>
      <div class="ws-shortcut">
        <Field label="Wann" id="ws-sc-slot">
          <select id="ws-sc-slot" class="select" value={String(sc.slot)} onChange={(e) => set({ shortcut: { ...sc, slot: Number((e.currentTarget as HTMLSelectElement).value) } })}>
            {slots.map((s) => (
              <option key={s.slot} value={String(s.slot)}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ordner" id="ws-sc-folder">
          <input
            id="ws-sc-folder"
            class="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            value={sc.folder}
            onInput={(e) => set({ shortcut: { ...sc, folder: (e.currentTarget as HTMLInputElement).value } })}
          />
        </Field>
      </div>
      <span class="field-label">So spielt der Ordner</span>
      <Segmented<number> label="So spielt der Ordner" value={sc.mode} options={SHORTCUT_MODES.map((m) => ({ value: m.mode, label: m.name }))} onChange={(mode) => set({ shortcut: { ...sc, mode } })} />
      <p class="small soft">
        {played ? `${played.name}: ${played.text}. ` : ''}Die Kurzwahl startet nur, wenn gerade nichts läuft. Kleine Kinder drücken oft aus Versehen lang.
      </p>
    </>
  );
}
