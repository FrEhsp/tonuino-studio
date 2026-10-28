/**
 * „So soll sich meine Box verhalten“ (0.6, entwurf-verhalten-*.png): the
 * sentences, shared by the step „Verhalten“ of the firmware wizard and the
 * page „Box einstellen“. Each sentence says where its answer goes: into the
 * firmware or into the admin menu at the box (verhalten.ts ortVon).
 *
 * Nothing is set until a sentence is answered: an open sentence shows what
 * the box has now, an answered one can be taken back with „nicht ändern“.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { CircleAlert, CreditCard } from 'lucide-preact';
import type { BoardId } from '../../core/firmware/variants';
import { factoryInvert, type InvertKind } from '../../core/firmware/tngstands';
import { ADMIN_KEYS, ADMIN_KEYS_FIVE, type KeyCount } from '../../core/tonuino/adminkeys';
import { adminAccessFor, type AdminAccess } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { adminCard } from '../../core/tonuino/modes';
import { FACTORY_SETTINGS, MAX_VOLUME, SHORTCUT_MODES, STANDBY_OPTIONS, shortcutSlots, volumeProblem, type BoxSettingValues, type PinKey } from '../../core/tonuino/settingsguide';
import { Button, Callout, Field } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { addExtraCard } from '../cards/items';
import { Marke } from './BaukastenBilder';
import { PRESETS, WEITER_FOLGE, draftFrom, ortVon, volumeOf, type Draft, type Kontext, type Ort, type Part, type Preset } from './verhalten';


/* ------------------------------------------------------------------ texts */

/**
 * "Tasten" is for three keys, and for five only on TNG from 26.10.2026 (commands.cpp: play_invert with
 * FIVEBUTTONS since PR #343, tngstands.ts invertKind); said when the keys are not known.
 */
export const BUTTONS_PART_HINT = 'Bei Boxen mit 3 Tasten. Mit 5 Tasten nur bei TonUINO TNG ab 26.10.2026: Dort tauscht es Vor/Zurück mit Lauter/Leiser.';

/** The choices of "Tasten": short and long press with 3 keys, swapped keys with 5 (TNG from 26.10.2026). */
export function buttonsOptions(invert: InvertKind | undefined): { label: string; now: (on: boolean) => string; options: { value: boolean; title: string; text: string }[] } {
  if (invert === 'five') {
    return {
      label: 'Tasten bei 5 Tasten',
      now: (on) => (on ? 'Vor/Zurück und Lauter/Leiser getauscht' : 'jede Taste tut, was draufsteht'),
      options: [
        { value: false, title: 'Wie beschriftet', text: 'Vor und Zurück wechseln den Titel, Lauter und Leiser ändern die Lautstärke. So ist es ab Werk.' },
        { value: true, title: 'Getauscht', text: 'Während die Box spielt, ändern Vor und Zurück die Lautstärke, Lauter und Leiser wechseln den Titel. Für Boxen, bei denen die Tasten andersherum eingebaut sind.' },
      ],
    };
  }
  return {
    label: 'Kurz drücken',
    now: (on) => (on ? 'kurz drücken ändert die Lautstärke' : 'kurz drücken wechselt den Titel'),
    options: [
      { value: true, title: 'Kurz drücken ändert die Lautstärke', text: 'Vor macht lauter, Zurück leiser. Lang drücken springt zum nächsten oder vorigen Titel. So ist es ab Werk.' },
      { value: false, title: 'Kurz drücken wechselt den Titel', text: 'Lang drücken ändert die Lautstärke: Vor macht lauter, Zurück leiser.' },
    ],
  };
}

/** "Nicht schützen" in words that fit the keys of the box (adminkeys.ts). */
export function noLockText(prof: FirmwareProfile, keys?: KeyCount): string {
  const five = prof === 'tng' && keys === 5 ? `, mit 5 Tasten auch ${ADMIN_KEYS_FIVE}` : '';
  return `${ADMIN_KEYS} zusammen lang gedrückt öffnen das Menü${five}. So ist es ab Werk.`;
}

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

const LOCK_TEXT: Record<AdminAccess, string> = { buttons: 'mit den Tasten', card: 'nur mit Admin-Karte', pin: 'mit PIN', calc: 'mit Rechenaufgabe' };
const LOCK_WAHL: Record<AdminAccess, string> = { buttons: 'mit den Tasten', card: 'mit Admin-Karte', pin: 'mit PIN', calc: 'mit Rechenaufgabe' };
const EQ_LABELS = ['Normal', 'Pop', 'Rock', 'Jazz', 'Klassik', 'Bass'];
const PRESET_TEXT: Record<Exclude<Preset, 'eigene'>, string> = {
  kinderzimmer: 'Fürs Kinderzimmer: höchstens 20, mindestens 1, beim Einschalten 8.',
  werk: 'Wie ab Werk: höchstens 25, mindestens 5, beim Einschalten 15.',
};
const AIO_BOARDS: readonly BoardId[] = ['aio', 'aioplus'];

/* ------------------------------------------------------------------ the sentences */

export interface SaetzeProps {
  d: Draft;
  /** Changes the draft; the page decides what else follows (the note after „Erledigt“). */
  set: (patch: Partial<Draft>) => void;
  /** Firmware of the box and where the answers go. */
  kontext: Kontext;
  /** Which sentences this box has (verhalten.ts visibleParts). */
  visible: Record<Part, boolean>;
  /** What the box has now (Steckbrief, else nothing: then the values of the factory are said). */
  values: BoxSettingValues;
  keys?: KeyCount;
  invert?: InvertKind;
  headphonesIn?: boolean;
  /** „Drücke ich Play ohne Karte …“: the firmware switch „Weitermachen“. `jetzt`: what the box has, when known. */
  weiter: { value: boolean | undefined; jetzt?: boolean; onChange: (v: boolean | undefined) => void; link?: ComponentChildren };
  /** On the page „Box einstellen“: „Alles zurücksetzen“ as the last sentence. */
  reset?: boolean;
}

/** The sentences in one framed list; the rarer ones folded under „Mehr“. */
export function Saetze(p: SaetzeProps) {
  const { d, set, kontext, visible, values } = p;
  const prof = kontext.prof;
  const answer = (part: Part, patch: Partial<Draft>) => set({ ...patch, on: { ...d.on, [part]: true } });
  const lassen = (part: Part) => () => set({ on: { ...d.on, [part]: false } });
  const fresh = draftFrom(values, p.invert);
  const jetzt = (known: boolean, text: string) => (known ? `Jetzt: ${text}` : `Ab Werk: ${text}`);
  const mehrNamen = [
    'Ausschalten nach …',
    visible.buttons ? (p.invert === 'five' && p.keys === 5 ? 'Tasten tauschen' : 'Tasten kurz drücken') : '',
    'Admin-Menü schützen',
    'Kurzwahl',
    'Klang',
    p.reset ? 'Zurücksetzen' : '',
  ].filter(Boolean);
  const mehrAn = (['standby', 'buttons', 'lock', 'shortcut', 'eq', 'reset'] as Part[]).some((x) => visible[x] && d.on[x]);
  const [mehrOffen, setMehrOffen] = useState(mehrAn);
  const buttonChoices = buttonsOptions(p.keys === 5 ? p.invert : undefined);
  const weiterOrt = ortVon('weiter', kontext);

  return (
    <div class="card saetze">
      {visible.cardRemoved ? (
        <Satz
          id="vh-karte"
          wenn={
            <>
              Nehme ich die <b>Karte weg</b>, dann …
            </>
          }
          ort={ortVon('cardRemoved', kontext)}
          an={d.on.cardRemoved}
          jetzt={jetzt(values.pauseWhenCardRemoved !== undefined, (values.pauseWhenCardRemoved ?? false) ? 'hält sie an' : 'spielt sie weiter')}
          onLassen={lassen('cardRemoved')}
          folge={d.on.cardRemoved && d.pauseWhenCardRemoved ? 'Geht nicht zusammen mit der Karte „Kita-Modus“. Das sagt die Box auch selbst.' : undefined}
        >
          <Wahl<boolean>
            label="Karte wegnehmen"
            value={d.on.cardRemoved ? d.pauseWhenCardRemoved : undefined}
            options={[
              { value: false, label: 'spielt sie weiter' },
              { value: true, label: 'hält sie an' },
            ]}
            onChange={(pauseWhenCardRemoved) => answer('cardRemoved', { pauseWhenCardRemoved })}
          />
        </Satz>
      ) : null}

      <Satz
        id="vh-weiter"
        wenn={
          <>
            Drücke ich <b>Play ohne Karte</b>, dann …
          </>
        }
        ort={weiterOrt}
        an={p.weiter.value !== undefined && weiterOrt.wo !== 'nicht'}
        jetzt={p.weiter.jetzt === undefined ? undefined : `Jetzt: ${p.weiter.jetzt ? 'spielt sie die letzte Karte' : 'passiert nichts'}`}
        onLassen={() => p.weiter.onChange(undefined)}
        folge={p.weiter.value && weiterOrt.wo !== 'nicht' ? WEITER_FOLGE : undefined}
        link={p.weiter.link}
      >
        {weiterOrt.wo === 'nicht' ? null : (
          <Wahl<boolean>
            label="Play ohne Karte"
            value={p.weiter.value}
            options={[
              { value: false, label: 'passiert nichts' },
              { value: true, label: 'spielt die letzte Karte', kurz: 'letzte Karte' },
            ]}
            onChange={(v) => p.weiter.onChange(v)}
          />
        )}
      </Satz>

      <Satz
        id="vh-laut"
        wenn={
          <>
            Die <b>Lautstärke</b> ist …
          </>
        }
        ort={ortVon('volume', kontext)}
        an={d.on.volume}
        jetzt={jetzt(!!values.volume, levelsText(values.volume ?? FACTORY_SETTINGS.volume))}
        onLassen={lassen('volume')}
        folge={d.on.volume ? <VolumeFolge d={d} set={set} headphonesIn={prof === 'tng' && !!p.headphonesIn} /> : undefined}
      >
        <Wahl<Preset>
          label="Lautstärke"
          value={d.on.volume ? d.preset : undefined}
          options={[
            { value: 'werk', label: 'wie ab Werk', kurz: 'ab Werk' },
            { value: 'kinderzimmer', label: 'fürs Kinderzimmer', kurz: 'Kinderzimmer' },
            { value: 'eigene', label: 'eigene' },
          ]}
          onChange={(preset) => {
            const v = PRESETS.find((x) => x.id === preset)?.volume;
            answer('volume', { preset, volume: v ? { max: String(v.max), min: String(v.min), init: String(v.init) } : d.preset === 'eigene' ? d.volume : fresh.volume });
          }}
        />
      </Satz>

      <details class="vh-mehr" open={mehrOffen} onToggle={(e) => setMehrOffen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <b>Mehr ({mehrNamen.length}):</b> <span class="vh-mehr-namen">{mehrNamen.join(' · ')}</span>
        </summary>

        <Satz
          id="vh-aus"
          wenn={
            <>
              Läuft nichts, <b>geht sie aus</b> …
            </>
          }
          ort={ortVon('standby', kontext)}
          an={d.on.standby}
          jetzt={jetzt(values.standby !== undefined, standbyText(values.standby ?? FACTORY_SETTINGS.standby))}
          onLassen={lassen('standby')}
          folge={d.on.standby ? <StandbyFolge standby={d.standby} board={kontext.board} prof={prof} /> : undefined}
        >
          <Wahl<number>
            label="Ausschalten, wenn nichts läuft"
            value={d.on.standby ? d.standby : undefined}
            options={STANDBY_OPTIONS.map((m) => ({ value: m, label: m === 0 ? 'nie' : `nach ${m} Min.` }))}
            onChange={(standby) => answer('standby', { standby })}
          />
        </Satz>

        {visible.buttons ? (
          <Satz
            id="vh-tasten"
            wenn={
              p.keys === 5 && p.invert === 'five' ? (
                <>
                  Bei 5 Tasten sind <b>Vor/Zurück und Lauter/Leiser</b> …
                </>
              ) : (
                <>
                  Drücke ich <b>Vor oder Zurück kurz</b>, dann …
                </>
              )
            }
            ort={ortVon('buttons', kontext)}
            an={d.on.buttons}
            jetzt={jetzt(values.shortPressVolume !== undefined, buttonChoices.now(values.shortPressVolume ?? factoryInvert(p.keys === 5 ? p.invert : 'three')))}
            hinweis={p.keys === undefined ? BUTTONS_PART_HINT : undefined}
            onLassen={lassen('buttons')}
            folge={d.on.buttons ? buttonChoices.options.find((o) => o.value === d.shortPressVolume)?.text : undefined}
          >
            <Wahl<boolean>
              label={buttonChoices.label}
              value={d.on.buttons ? d.shortPressVolume : undefined}
              options={
                p.keys === 5 && p.invert === 'five'
                  ? [
                      { value: false, label: 'wie beschriftet' },
                      { value: true, label: 'getauscht' },
                    ]
                  : [
                      { value: true, label: 'lauter oder leiser' },
                      { value: false, label: 'nächster Titel' },
                    ]
              }
              onChange={(shortPressVolume) => answer('buttons', { shortPressVolume })}
            />
          </Satz>
        ) : null}

        <Satz
          id="vh-sperre"
          wenn={
            <>
              Das <b>Admin-Menü</b> öffnet sich …
            </>
          }
          ort={ortVon('lock', kontext)}
          an={d.on.lock}
          jetzt={jetzt(values.lock !== undefined, LOCK_TEXT[values.lock ?? 'buttons'])}
          onLassen={lassen('lock')}
          folge={d.on.lock ? <LockFolge d={d} set={set} prof={prof} keys={p.keys} /> : undefined}
        >
          <Wahl<AdminAccess>
            label="Admin-Menü schützen"
            value={d.on.lock ? d.lock : undefined}
            options={adminAccessFor(prof).map((a) => ({ value: a, label: LOCK_WAHL[a] }))}
            onChange={(lock) => answer('lock', { lock, pin: lock === 'pin' && d.lock !== 'pin' ? fresh.pin : d.pin })}
          />
        </Satz>

        <Satz
          id="vh-kurzwahl"
          wenn={
            <>
              Halte ich eine <b>Taste lang</b>, dann …
            </>
          }
          ort={ortVon('shortcut', kontext)}
          an={d.on.shortcut}
          onLassen={lassen('shortcut')}
          folge={d.on.shortcut ? <ShortcutFolge d={d} set={set} prof={prof} /> : undefined}
        >
          <Wahl<boolean>
            label="Kurzwahl"
            value={d.on.shortcut ? true : undefined}
            options={[{ value: true, label: 'startet ein Ordner' }]}
            onChange={() => answer('shortcut', {})}
          />
        </Satz>

        <Satz
          id="vh-klang"
          wenn={
            <>
              Der <b>Klang</b> ist …
            </>
          }
          ort={ortVon('eq', kontext)}
          an={d.on.eq}
          jetzt={jetzt(values.eq !== undefined, EQ_LABELS[(values.eq ?? 1) - 1] ?? 'Normal')}
          onLassen={lassen('eq')}
        >
          <Wahl<number> label="Klang" value={d.on.eq ? d.eq : undefined} options={EQ_LABELS.map((label, i) => ({ value: i + 1, label }))} onChange={(eq) => answer('eq', { eq })} />
        </Satz>

        {p.reset ? (
          <Satz
            id="vh-reset"
            wenn={
              <>
                Vorher <b>alles zurücksetzen</b>?
              </>
            }
            ort={ortVon('reset', kontext)}
            an={d.on.reset}
            onLassen={lassen('reset')}
            folge={
              d.on.reset ? (
                <Callout tone="warning">
                  Die Box vergisst alle Einstellungen: Lautstärke, Timer, Sperre und Kurzwahlen sind danach wie ab Werk. Hörbücher fangen wieder vorn an. Karten und SD-Karte bleiben, wie sie sind.
                </Callout>
              ) : undefined
            }
          >
            <Wahl<boolean> label="Alles zurücksetzen" value={d.on.reset ? true : undefined} options={[{ value: true, label: 'ja, zuerst alles löschen' }]} onChange={() => answer('reset', {})} />
          </Satz>
        ) : null}
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ one sentence */

function Satz({
  id,
  wenn,
  ort,
  an,
  jetzt,
  hinweis,
  onLassen,
  folge,
  link,
  children,
}: {
  id: string;
  wenn: ComponentChildren;
  ort: Ort;
  an: boolean;
  jetzt?: string;
  hinweis?: string;
  onLassen: () => void;
  folge?: ComponentChildren;
  link?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <div class={`satzzeile${an ? ' an' : ''}`} role="group" aria-labelledby={id}>
      <span class="wenn" id={id}>
        {wenn}
      </span>
      {children}
      {folge ? <div class="folge">{folge}</div> : null}
      <div class="wo-marke">
        {ort.wo === 'nicht' ? (
          <span class="vh-nicht">{ort.text}</span>
        ) : (
          <>
            <WoMarke wo={ort.wo} />
            {ort.text ? <span class="vh-wo-text">{ort.text}</span> : null}
          </>
        )}
        {!an && jetzt ? <span class="vh-jetzt">{jetzt}</span> : null}
        {hinweis && !an ? <span class="vh-jetzt">{hinweis}</span> : null}
        {link}
        {an ? (
          <button type="button" class="link-button vh-lassen" onClick={onLassen}>
            nicht ändern
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The mark of a sentence: long on a computer, short on a phone (entwurf-verhalten-handy). */
export function WoMarke({ wo }: { wo: 'firmware' | 'box' }) {
  return (
    <>
      <span class="vh-lang">
        <Marke wo={wo}>{wo === 'firmware' ? 'kommt in die Firmware' : 'stellst du an der Box ein'}</Marke>
      </span>
      <span class="vh-kurz">
        <Marke wo={wo}>{wo === 'firmware' ? 'in der Firmware' : 'an der Box'}</Marke>
      </span>
    </>
  );
}

/**
 * The answers of a sentence as one row of buttons (the segmented control of
 * 0.5). None is pressed while the sentence is open; `kurz`: the shorter
 * label for a phone.
 */
function Wahl<T extends string | number | boolean>({ label, value, options, onChange }: { label: string; value: T | undefined; options: { value: T; label: string; kurz?: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented vh-wahl" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={String(o.value)} aria-pressed={value !== undefined && o.value === value} onClick={() => onChange(o.value)}>
          {o.kurz ? (
            <>
              <span class="vh-lang">{o.label}</span>
              <span class="vh-kurz">{o.kurz}</span>
            </>
          ) : (
            o.label
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ what follows an answer */

function levelsText(v: { max: number; min: number; init: number }): string {
  return `${v.min} bis ${v.max}, beim Einschalten ${v.init}`;
}

function standbyText(minutes: number): string {
  return minutes === 0 ? 'geht nicht von selbst aus' : `nach ${minutes} Minuten`;
}

function VolumeFolge({ d, set, headphonesIn }: { d: Draft; set: (patch: Partial<Draft>) => void; headphonesIn: boolean }) {
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
    <div class="stack tight">
      {own ? (
        <>
          <div class="ws-vol-fields">
            {field('max', 'Am lautesten')}
            {field('min', 'Am leisesten')}
            {field('init', 'Beim Einschalten')}
          </div>
          <span id="ws-vol-hint">
            Von 1 bis {MAX_VOLUME}. Mehr als {MAX_VOLUME} kann der MP3-Player nicht.
          </span>
          {problem ? (
            <span class="ws-set-problem" id="ws-vol-problem" role="alert">
              <CircleAlert size={16} aria-hidden="true" /> {problem}
            </span>
          ) : null}
        </>
      ) : (
        <span>{PRESET_TEXT[d.preset as Exclude<Preset, 'eigene'>]}</span>
      )}
      {headphonesIn ? <Callout tone="warning">Laut Box-Logbuch steckt ein Kopfhörer. Ziehe ihn ab, bevor du die Lautstärke einstellst. Sonst gelten die Werte nur für den Kopfhörer.</Callout> : null}
    </div>
  );
}

function StandbyFolge({ standby, board, prof }: { standby: number; board?: BoardId; prof: FirmwareProfile }) {
  const switchesOff = board !== undefined && AIO_BOARDS.includes(board);
  // The Pause key of TNG puts a box without power-off parts to sleep just like the timer does.
  const sleepNote = !switchesOff && (standby !== 0 || prof === 'tng');
  return (
    <div class="stack tight">
      {standby === 0 ? <Callout tone="warning">{standbyOffText(prof)}</Callout> : null}
      {sleepNote ? <span>Hat deine Box nichts, was sie ganz abschaltet (das haben AiO, AiO+ und Boxen mit Pololu-Schalter), schläft sie nur ein. Wach wird sie erst wieder, wenn du den Strom kurz trennst.</span> : null}
    </div>
  );
}

const PIN_OPTIONS: { value: PinKey; label: string }[] = [
  { value: 'pause', label: 'Play/Pause' },
  { value: 'up', label: 'Vor' },
  { value: 'down', label: 'Zurück' },
];

/** Puts an admin card on the list of cards to write and opens the cards page. */
export function AdminCardButton() {
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

function LockFolge({ d, set, prof, keys }: { d: Draft; set: (patch: Partial<Draft>) => void; prof: FirmwareProfile; keys?: KeyCount }) {
  return (
    <div class="stack tight">
      {d.lock === 'buttons' ? <span>{noLockText(prof, keys)}</span> : null}
      {d.lock === 'calc' ? <span>Die Box stellt eine Aufgabe. Nur bei TonUINO 2.1.</span> : null}
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
    </div>
  );
}

function ShortcutFolge({ d, set, prof }: { d: Draft; set: (patch: Partial<Draft>) => void; prof: FirmwareProfile }) {
  const slots = shortcutSlots(prof);
  const sc = d.shortcut;
  const played = SHORTCUT_MODES.find((m) => m.mode === sc.mode);
  return (
    <div class="stack tight">
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
          <input id="ws-sc-folder" class="input" type="number" inputMode="numeric" min={1} max={99} value={sc.folder} onInput={(e) => set({ shortcut: { ...sc, folder: (e.currentTarget as HTMLInputElement).value } })} />
        </Field>
        <Field label="So spielt der Ordner" id="ws-sc-mode">
          <select id="ws-sc-mode" class="select" value={String(sc.mode)} onChange={(e) => set({ shortcut: { ...sc, mode: Number((e.currentTarget as HTMLSelectElement).value) } })}>
            {SHORTCUT_MODES.map((m) => (
              <option key={m.mode} value={String(m.mode)}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <span>{played ? `${played.name}: ${played.text}. ` : ''}Die Kurzwahl startet nur, wenn gerade nichts läuft. Kleine Kinder drücken oft aus Versehen lang.</span>
    </div>
  );
}
