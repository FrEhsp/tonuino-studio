import type { LucideIcon } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Bluetooth,
  BookMarked,
  BookOpen,
  BookOpenText,
  Brain,
  ChevronDown,
  CircleHelp,
  Coffee,
  Disc3,
  Dices,
  ListMusic,
  ListOrdered,
  Music,
  PartyPopper,
  Repeat,
  Shuffle,
} from 'lucide-preact';
import type { FirmwareProfile } from '../../core/tonuino/card';
import type { FolderCard } from '../../core/tonuino/catalog';
import { foldersInRowAfter, modeByCode, modesFor, QUIZ_VARIANTS, TNG_SEPTEMBER_2026 } from '../../core/tonuino/modes';
import { routeToHash } from '../../app/router';
import { Field } from '../../ui/components/controls';
import { ChoiceList, type Choice } from '../../ui/components/Schlank';
import { FRONT_MODES, modeName } from './single';

export const MODE_ICONS: Record<number, LucideIcon> = {
  1: Shuffle,
  2: Disc3,
  3: PartyPopper,
  4: Music,
  5: BookOpen,
  7: Dices,
  8: ListOrdered,
  9: ListMusic,
  10: BookMarked,
  11: Repeat,
  12: CircleHelp,
  13: Brain,
  14: Bluetooth,
  15: Coffee,
  16: BookOpenText,
};

const REQUIRES: Record<string, string> = {
  quiz: 'Braucht die Firmware „5 Tasten mit allen Extras“.',
  memory: 'Braucht die Firmware „5 Tasten mit allen Extras“.',
  teapot: 'Braucht eine selbst gebaute Firmware mit Teekesselchen.',
  bluetooth: 'Nur für Boxen mit Bluetooth-Modul und selbst gebauter Firmware.',
};

/** The switch in TonUINO TNG's constants.hpp that turns the mode on; off in every official build and in the Baukasten. */
const SWITCH: Record<string, string> = {
  quiz: 'QUIZ_GAME',
  memory: 'MEMORY_GAME',
  teapot: 'TEAPOT_GAME',
  bluetooth: 'BT_MODULE',
};

/** The modes most families need. The others hide behind "Weitere Möglichkeiten". */
const PRIMARY = [5, 2, 1, 3, 4];

/** Sensible parameters when switching to a mode. */
export function defaultsFor(mode: number, trackCount: number): FolderCard {
  const info = modeByCode(mode);
  switch (info?.params) {
    case 'track':
      return { mode, special: 1, special2: 0 };
    case 'range':
      return { mode, special: 1, special2: Math.max(1, trackCount) };
    case 'quiz':
      return { mode, special: 4, special2: 1 };
    default:
      return { mode, special: 0, special2: 0 };
  }
}

function numbers(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export function ModePicker({
  profile,
  value,
  onChange,
  trackCount,
  folder,
  advanced,
  withTracks,
  trackTitle,
  list,
  onLeave,
}: {
  profile: FirmwareProfile;
  value: FolderCard;
  onChange: (v: FolderCard) => void;
  trackCount: number;
  folder: number;
  advanced?: boolean;
  /** The folders with titles on the card: the random folder offers only those. */
  withTracks?: ReadonlySet<number>;
  /** The title of a track, so the choices name the songs and not only their numbers. */
  trackTitle?: (track: number) => string | undefined;
  /** As the calm list of „So spielt die Karte“, with its names: the four in front, then the rarer ones (Prüfrunde 1, aussehen 17). */
  list?: boolean;
  /** Called before the link to the firmware leaves the page, so a dialog around can close. */
  onLeave?: () => void;
}) {
  const modes = modesFor(profile, { advanced: advanced || !!modeByCode(value.mode)?.advanced });
  const current = modeByCode(value.mode);
  const max = Math.max(1, trackCount);
  const [more, setMore] = useState(!PRIMARY.includes(value.mode));
  // Most Hörbuch cards play one folder: the random choice of several waits behind a link.
  const [surprise, setSurprise] = useState((value.special2 ?? 0) > 0);
  // The fields of a mode come below all the choices, in a dialog often below its edge: bring them into view on a switch.
  const root = useRef<HTMLDivElement>(null);
  const shownMode = useRef(value.mode);
  // Only a choice made here scrolls: a mode that follows the folder's kind or another firmware stays put.
  const picked = useRef(false);
  useEffect(() => {
    if (shownMode.current === value.mode) return;
    shownMode.current = value.mode;
    if (!picked.current) return;
    picked.current = false;
    const fields = root.current?.lastElementChild;
    if (current?.params === 'none' || !fields?.childElementCount || fields.classList.contains('choices') || fields.classList.contains('liste') || fields.classList.contains('link-button')) return;
    fields.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [value.mode]);
  const trackOption = (n: number) => {
    const title = trackTitle?.(n);
    return (
      <option value={n} key={n}>
        {title && title !== `Titel ${n}` ? `${n} · ${title}` : `Titel ${n}`}
      </option>
    );
  };
  const lastFolders = withTracks ? foldersInRowAfter(folder, withTracks) : Math.min(20, 99 - folder);
  // A choice saved before folders went missing stays visible, so the select does not lie about it.
  const saved = value.special2 ?? 0;
  const folderChoices = saved > lastFolders ? [...numbers(1, lastFolders), saved] : numbers(1, lastFolders);
  const primary = modes.filter((m) => PRIMARY.includes(m.code));
  const others = modes.filter((m) => !PRIMARY.includes(m.code));
  const choice = (m: (typeof modes)[number]) => {
    const Icon = MODE_ICONS[m.code] ?? Music;
    const checked = m.code === value.mode;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        class="choice"
        key={m.code}
        onClick={() => {
          picked.current = !checked;
          onChange(checked ? value : defaultsFor(m.code, trackCount));
        }}
      >
        <span class="choice-icon">
          <Icon size={19} strokeWidth={2.2} />
        </span>
        <span class="choice-title">{m.name}</span>
        <span class="choice-text">{m.tagline}</span>
        {m.requires ? <span class="choice-text" style={{ color: 'var(--warning-text)' }}>{REQUIRES[m.requires]}</span> : null}
      </button>
    );
  };
  const front = (code: number) => FRONT_MODES.find((f) => f.mode === code);
  const listed = [...modes.filter((m) => front(m.code)).sort((a, b) => FRONT_MODES.indexOf(front(a.code)!) - FRONT_MODES.indexOf(front(b.code)!)), ...modes.filter((m) => !front(m.code))];
  const rows: Choice<number>[] = listed.map((m) => ({
    value: m.code,
    name: modeName(m.code),
    text: front(m.code)?.text ?? (m.requires ? `${m.tagline} ${REQUIRES[m.requires]}` : m.tagline),
  }));
  // Said plainly, and the same as the settings (options.ts): Quiz and Memory come in the ready
  // „5 Tasten mit allen Extras“ (AiO+, Nano Every, ESP32); Teekesselchen and Bluetooth only in a
  // firmware built by hand (Prüfrunde 1, bastler 18; Prüfrunde 2, bastler 6; Prüfrunde 3, M2).
  const fertig = current?.requires === 'quiz' || current?.requires === 'memory';
  const toFirmware = (
    <a href={routeToHash({ page: 'workshop', tool: 'firmware' })} onClick={() => onLeave?.()}>
      Werkstatt › Firmware aufspielen
    </a>
  );
  const needs = current?.requires ? (
    fertig ? (
      <p class="soft small">
        Das geht mit der fertigen Firmware „5 Tasten mit allen Extras“. Die gibt es für die AiO+, den Nano Every und den ESP32, nicht für Boxen mit Arduino Nano oder AiO. Aufspielen kannst du sie unter {toFirmware}.
      </p>
    ) : (
      <p class="soft small">
        Das kann keine fertige Firmware. Dafür baust du TonUINO TNG selbst, mit eingeschaltetem {SWITCH[current.requires]} in constants.hpp. Die fertige Datei spielst du unter {toFirmware} mit „Eigene Datei aufspielen“ auf.
      </p>
    )
  ) : null;
  return (
    <div class="stack" ref={root}>
      {list ? (
        <ChoiceList
          class="liste-arten"
          label="Wiedergabe"
          value={value.mode}
          choices={rows}
          onChange={(code) => {
            if (code === value.mode) return;
            picked.current = true;
            onChange(defaultsFor(code, trackCount));
          }}
        />
      ) : (
        <div class="choices" role="radiogroup" aria-label="Wiedergabe">
          {primary.map(choice)}
          {more ? others.map(choice) : null}
        </div>
      )}
      {needs}
      {!list && others.length && !more ? (
        <button type="button" class="link-button" onClick={() => setMore(true)}>
          <ChevronDown size={16} /> Weitere Möglichkeiten, z. B. nur einen Teil des Ordners spielen
        </button>
      ) : null}

      {current?.params === 'track' ? (
        <Field label="Welcher Titel?" id="mp-track">
          <select id="mp-track" class="select" style={{ width: 420, maxWidth: '100%' }} value={value.special} onChange={(e) => onChange({ ...value, special: Number(e.currentTarget.value) })}>
            {numbers(1, max).map(trackOption)}
          </select>
        </Field>
      ) : null}

      {current?.params === 'range' ? (
        <div class="row wrap" style={{ gap: 16 }}>
          <Field label="Von Titel" id="mp-from">
            <select
              id="mp-from"
              class="select"
              style={{ width: trackTitle ? 280 : 160, maxWidth: '100%' }}
              value={value.special}
              onChange={(e) => {
                const from = Number(e.currentTarget.value);
                onChange({ ...value, special: from, special2: Math.max(from, value.special2 ?? from) });
              }}
            >
              {numbers(1, max).map(trackOption)}
            </select>
          </Field>
          <Field label="Bis Titel" id="mp-to">
            <select id="mp-to" class="select" style={{ width: trackTitle ? 280 : 160, maxWidth: '100%' }} value={value.special2} onChange={(e) => onChange({ ...value, special2: Number(e.currentTarget.value) })}>
              {numbers(value.special ?? 1, max).map(trackOption)}
            </select>
          </Field>
        </div>
      ) : null}

      {current?.params === 'folderRange' || current?.params === 'folderRangeTracks' ? (
        <div class="row wrap" style={{ gap: 16 }}>
          {current.params === 'folderRangeTracks' ? (
            <Field label="Titel pro Auflegen" id="mp-per">
              <select id="mp-per" class="select" style={{ width: 160 }} value={(value.special ?? 0) + 1} onChange={(e) => onChange({ ...value, special: Number(e.currentTarget.value) - 1 })}>
                {numbers(1, 30).map((n) => (
                  <option value={n}>{n}</option>
                ))}
              </select>
            </Field>
          ) : null}
          {profile === 'tng' && folderChoices.length && !surprise ? (
            <button type="button" class="link-button" style={{ alignSelf: 'flex-end' }} onClick={() => setSurprise(true)}>
              <Dices size={16} /> Eine Karte für mehrere Ordner …
            </button>
          ) : null}
          {profile === 'tng' && folderChoices.length && surprise ? (
            <Field
              label="Überraschungsordner"
              id="mp-last"
              hint={`Die Box nimmt bei jedem Auflegen zufällig einen der Ordner, einen angefangenen spielt sie erst zu Ende. Ab TNG ${TNG_SEPTEMBER_2026}. Mehrteiliges Hörbuch? Lege alle Teile in einen Ordner.`}
            >
              <select id="mp-last" class="select" style={{ width: 320, maxWidth: '100%' }} value={value.special2 ?? 0} onChange={(e) => onChange({ ...value, special2: Number(e.currentTarget.value) })}>
                <option value={0}>Nein, nur dieser Ordner</option>
                {folderChoices.map((n) => (
                  <option value={n}>
                    Zufällig einer der Ordner {String(folder).padStart(2, '0')} bis {String(folder + n).padStart(2, '0')}
                    {n > lastFolders ? ' (Ordner fehlen)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      ) : null}

      {current?.params === 'quiz' ? (
        <Field label="Art des Quiz" id="mp-quiz">
          <select
            id="mp-quiz"
            class="select"
            style={{ maxWidth: 320 }}
            value={QUIZ_VARIANTS.findIndex((q) => q.special === value.special && q.special2 === value.special2)}
            onChange={(e) => {
              const q = QUIZ_VARIANTS[Number(e.currentTarget.value)];
              onChange({ ...value, special: q.special, special2: q.special2 });
            }}
          >
            {QUIZ_VARIANTS.map((q, i) => (
              <option value={i}>{q.label}</option>
            ))}
          </select>
        </Field>
      ) : null}
    </div>
  );
}
