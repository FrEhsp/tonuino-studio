/**
 * „Extras“ under „Fertige Firmware“ (Firmware-Baukasten, #30/#32): the
 * compile-time extras of TonUINO TNG as plain choices, matched to board and
 * buttons. What cannot be combined is greyed out with the reason; the
 * builds come with the app (src/core/firmware/baukasten.ts).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronDown, SlidersHorizontal } from 'lucide-preact';
import {
  ALARM_TEXT,
  D6_WARNING,
  HEADPHONES_TEXT,
  KNOB_TEXTS,
  LIGHT_TEXTS,
  PRESET_TEXTS,
  SPEAKER_OFF_TEXT,
  WRITE_CARD_TEXT,
  alarmBlocker,
  chipBlocker,
  choiceStatus,
  choiceSummary,
  headphonesBlocker,
  knobBlocker,
  lightBlocker,
  loadManifest,
  normalizeChoice,
  offerWriteCardPreview,
  speakerOffBlocker,
  writeCardBlocker,
  type BaukastenBoard,
  type BaukastenButtons,
  type BaukastenManifest,
  type ExtraText,
  type ExtrasChoice,
  type KnobKind,
  type LightKind,
  type PresetId,
} from '../../core/firmware/baukasten';
import { CHIP_SYMPTOM_TEXT, CHIP_TEXTS, MH2024K16SS_TEXT, OTHER_CHIPS } from '../../core/firmware/mp3chip';
import { Callout } from '../../ui/components/controls';
import { noteManifestBuilds } from './boxbuild';

/** Where public/ ends up next to the app („./“ in the web app and the desktop app). */
export const APP_BASE: string = import.meta.env.BASE_URL;

/** The files lie next to the app; no internet is needed. */
export const localFetch = (url: string) => fetch(url);

let manifestLoad: Promise<BaukastenManifest> | null = null;

/** The manifest of the Baukasten, loaded once. */
export function baukastenManifest(): Promise<BaukastenManifest> {
  if (!manifestLoad) {
    manifestLoad = loadManifest(localFetch, APP_BASE);
    manifestLoad.then((m) => noteManifestBuilds(m.builds)).catch(() => (manifestLoad = null));
  }
  return manifestLoad;
}

export function useBaukastenManifest(): BaukastenManifest | null | 'failed' {
  const [m, setM] = useState<BaukastenManifest | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    baukastenManifest().then(
      (x) => live && setM(x),
      () => live && setM('failed'),
    );
    return () => {
      live = false;
    };
  }, []);
  return m;
}

const TOO_BIG = 'Passt zusammen mit deinen anderen Extras nicht mehr in den Speicher.';
const LOETPLAN = '#/werkstatt/loetplan';

interface Props {
  board: BaukastenBoard;
  buttons: BaukastenButtons;
  /** What is ticked (without the shutdown answer). */
  value: ExtrasChoice;
  /** The shutdown answer „Trägerplatine“: part of the build, not ticked here. */
  traeger: boolean;
  manifest: BaukastenManifest;
  onChange: (next: ExtrasChoice) => void;
  /** Open and in view from the start: the user came back from „Extras wählen“. */
  openFirst?: boolean;
}

export function ExtrasPanel({ board, buttons, value, traeger, manifest, onChange, openFirst }: Props) {
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (openFirst) box.current?.scrollIntoView({ block: 'start' });
  }, []);
  const choice = normalizeChoice(board, buttons, value);
  const summary = choiceSummary(choice);
  /** Why `next` cannot be built: the pins, or the flash. */
  const sizeBlocker = (next: ExtrasChoice) => (choiceStatus(manifest, board, buttons, { ...next, traeger }).kind === 'ok' ? undefined : TOO_BIG);
  const set = (patch: Partial<ExtrasChoice>) => onChange(normalizeChoice(board, buttons, { ...choice, ...patch }));

  const knobReason = knobBlocker(board, buttons);
  const writeCardOffered = offerWriteCardPreview(manifest);
  // The AiO has no room for it at all (measured, docs/FIRMWARE-BAUKASTEN.md): say so instead of "with your other extras".
  const writeCardFits = manifest.builds.some((b) => b.writeCard && b.board === board && b.buttons === buttons);
  const status = choiceStatus(manifest, board, buttons, { ...choice, traeger });

  return (
    <details class="trouble ws-extras" open={!!summary || openFirst} ref={box}>
      <summary>
        <SlidersHorizontal size={18} strokeWidth={2.2} aria-hidden="true" />
        <span class="stack tight">
          <b>Extras</b>
          <span class="small soft">{summary ? `Eingeschaltet: ${summary}` : 'Drehregler, Leuchtring und mehr. Nur, wenn du sie eingebaut hast.'}</span>
        </span>
        <ChevronDown class="trouble-chevron" size={18} strokeWidth={2.2} aria-hidden="true" />
      </summary>
      <div class="ws-extras-body stack loose">
        <p class="small soft">
          Hat deine Box beim Bauen zusätzliche Teile bekommen? Dann schalte sie hier ein. Ohne Häkchen bekommst du die normale fertige Firmware. Wie die Teile angelötet werden, zeigt der <a href={LOETPLAN}>Lötplan</a>.
        </p>

        <Group title="Lautstärke-Regler" hint={knobReason}>
          <Option name="knob" type="radio" checked={!choice.knob} label="Keiner" text="Lauter und leiser geht mit den Tasten." onChange={() => set({ knob: undefined })} />
          {(Object.keys(KNOB_TEXTS) as KnobKind[]).map((k) => (
            <Option
              key={k}
              name="knob"
              type="radio"
              checked={choice.knob === k}
              {...KNOB_TEXTS[k]}
              blocked={knobReason ?? sizeBlocker({ ...choice, knob: k })}
              hideReason={!!knobReason}
              onChange={() => set({ knob: k })}
            />
          ))}
        </Group>

        <Group title="Licht">
          <Option name="light" type="radio" checked={!choice.light} label="Keins" text="Die Box leuchtet nicht." onChange={() => set({ light: undefined })} />
          {(Object.keys(LIGHT_TEXTS) as LightKind[]).map((l) => (
            <Option
              key={l}
              name="light"
              type="radio"
              checked={choice.light === l}
              {...LIGHT_TEXTS[l]}
              blocked={lightBlocker(board, l, choice) ?? sizeBlocker({ ...choice, light: l })}
              onChange={() => set({ light: l })}
            />
          ))}
        </Group>

        <Group title="Mehr Teile">
          <Option
            type="checkbox"
            checked={!!choice.speakerOff}
            {...SPEAKER_OFF_TEXT}
            blocked={speakerOffBlocker(board, choice) ?? (choice.speakerOff ? undefined : sizeBlocker({ ...choice, speakerOff: true }))}
            onChange={(on) => set({ speakerOff: on })}
          />
          <Option
            type="checkbox"
            checked={!!choice.headphones}
            {...HEADPHONES_TEXT}
            blocked={headphonesBlocker(board, choice) ?? (choice.headphones ? undefined : sizeBlocker({ ...choice, headphones: true }))}
            onChange={(on) => set({ headphones: on })}
          />
        </Group>
        {board === 'classic' && (choice.speakerOff || choice.light === 'ledButtons') ? <Callout tone="warning">{D6_WARNING}</Callout> : null}

        <Group title="Verhalten">
          {(Object.keys(PRESET_TEXTS) as PresetId[]).map((p) => (
            <Option
              key={p}
              name="preset"
              type="radio"
              checked={(choice.preset ?? 'standard') === p}
              {...PRESET_TEXTS[p]}
              blocked={p === 'standard' ? undefined : sizeBlocker({ ...choice, preset: p })}
              onChange={() => set({ preset: p })}
            />
          ))}
        </Group>

        {writeCardOffered ? (
          <Group title="Karten schreiben">
            <Option
              type="checkbox"
              checked={!!choice.writeCard}
              {...WRITE_CARD_TEXT}
              blocked={writeCardFits ? (writeCardBlocker(choice) ?? (choice.writeCard ? undefined : sizeBlocker({ ...choice, writeCard: true }))) : 'Passt bei dieser Platine nicht in den Speicher.'}
              onChange={(on) => set({ writeCard: on })}
            />
          </Group>
        ) : null}

        <details class="ws-extras-more" open={!!choice.chip || !!choice.alarm}>
          <summary>Mehr: anderer MP3-Player-Chip{board === 'classic' ? ', Wecker-Start' : ''}</summary>
          <Group title="MP3-Player" hint={CHIP_SYMPTOM_TEXT}>
            <Option name="chip" type="radio" checked={!choice.chip} {...CHIP_TEXTS.standard} onChange={() => set({ chip: undefined })} />
            {OTHER_CHIPS.map((c) => (
              <Option
                key={c}
                name="chip"
                type="radio"
                checked={choice.chip === c}
                label={CHIP_TEXTS[c].label}
                text={CHIP_TEXTS[c].text}
                parts={CHIP_TEXTS[c].look}
                blocked={chipBlocker(choice) ?? sizeBlocker({ ...choice, chip: c })}
                onChange={() => set({ chip: c })}
              />
            ))}
            <Option name="chip" type="radio" checked={false} label={MH2024K16SS_TEXT.label} text={MH2024K16SS_TEXT.text} parts={MH2024K16SS_TEXT.look} blocked={MH2024K16SS_TEXT.why} onChange={() => undefined} />
          </Group>
          {board === 'classic' ? (
            <Group title="Wecker">
              <Option
                type="checkbox"
                checked={!!choice.alarm}
                {...ALARM_TEXT}
                blocked={alarmBlocker(board, choice) ?? (choice.alarm ? undefined : sizeBlocker({ ...choice, alarm: true }))}
                onChange={(on) => set({ alarm: on })}
              />
            </Group>
          ) : null}
        </details>

        {status.kind === 'ok' && status.build.needsNewBootloader ? (
          <Callout tone="neutral">
            Diese Firmware passt nur auf einen Nano mit neuem Startprogramm (Bootloader). Die meisten neueren Nanos haben es. Das prüfe ich beim Aufspielen; passt es nicht, bleibt deine Box, wie sie ist.
          </Callout>
        ) : status.kind !== 'ok' ? (
          <Callout tone="warning">Diese Zusammenstellung gibt es nicht. Nimm ein Extra weniger.</Callout>
        ) : null}
      </div>
    </details>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ComponentChildren }) {
  return (
    <fieldset class="ws-extras-group">
      <legend>{title}</legend>
      {hint ? <p class="small muted">{hint}</p> : null}
      <div class="stack">{children}</div>
    </fieldset>
  );
}

function Option(
  props: ExtraText & {
    name?: string;
    type: 'radio' | 'checkbox';
    checked: boolean;
    /** Why it cannot be chosen. */
    blocked?: string;
    /** The group says the reason already. */
    hideReason?: boolean;
    onChange: (checked: boolean) => void;
  },
) {
  const { label, text, parts, name, type, checked, blocked, hideReason, onChange } = props;
  const off = !!blocked && !checked;
  return (
    <label class={`ws-check${off ? ' is-off' : ''}`}>
      {type === 'radio' ? (
        <input type="radio" name={name} checked={checked} disabled={off} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      ) : (
        <input type="checkbox" checked={checked} disabled={off} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      )}
      <span class="stack tight">
        <b>{label}</b>
        <span class="small soft">{text}</span>
        {parts ? <span class="small ws-extras-parts">{parts}</span> : null}
        {off && blocked && !hideReason ? <span class="small muted">{blocked}</span> : null}
      </span>
    </label>
  );
}
