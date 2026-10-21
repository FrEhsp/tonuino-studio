import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { Baby, Bluetooth, Flame, Infinity as InfinityIcon, KeyRound, ListMusic, Lock, Moon, Pause, PersonStanding, PowerOff, Repeat1, RotateCcw, School, Shield } from 'lucide-preact';
import { adminCard, DANCE_PAUSES, MODIFIER_HOWTO, modeByCode, modifierCard, modifierNeeds, modifiersFor, modifierUnsupportedFor, SLEEP_MINUTES, sleepMaxMinutes, type ModifierSymbol } from '../../core/tonuino/modes';
import { sleepMinutesProblem } from '../../core/tonuino/cardedit';
import type { TngRelease } from '../../core/tonuino/boxguide';
import type { CardData } from '../../core/tonuino/card';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Field, Segmented, Switch } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { profile, settings } from '../../app/state';
import { addExtraCard, alreadyListedNote, extras, extraLabel, sameCard } from './items';

export const MODIFIER_ICONS: Record<ModifierSymbol, LucideIcon> = {
  moon: Moon,
  'music-pause': PersonStanding,
  'flame-water-wind': Flame,
  baby: Baby,
  school: School,
  'repeat-1': Repeat1,
  bluetooth: Bluetooth,
  'list-music': ListMusic,
  pause: Pause,
  power: PowerOff,
  infinity: InfinityIcon,
  lock: Lock,
  shield: Shield,
};

interface Option {
  id: string;
  name: string;
  tagline: string;
  icon: LucideIcon;
  params: 'none' | 'sleep' | 'dancePause';
  /** Only some boxes can use the card. */
  needs?: string;
  /** The box, as far as the family told, cannot use the card. */
  unsupported?: string;
  build: (special: number) => CardData;
}

function optionsFor(prof: 'tng' | 'classic21', release: TngRelease): Option[] {
  const mods: Option[] = modifiersFor(prof).map((m) => ({
    id: `m${m.code}`,
    name: m.name,
    tagline: m.tagline,
    icon: MODIFIER_ICONS[m.symbol],
    params: m.params,
    needs: modifierNeeds(m, release),
    unsupported: prof === 'tng' ? modifierUnsupportedFor(m, release) : undefined,
    build: (special) => modifierCard(m.code, special),
  }));
  const extra: Option[] = [
    { id: 'admin', name: 'Admin-Karte', tagline: 'Öffnet das Admin-Menü der Box, auch wenn es gesperrt ist.', icon: KeyRound, params: 'none', build: () => adminCard() },
  ];
  if (prof === 'tng') {
    const again = modeByCode(11)!;
    extra.push({
      id: 'again',
      name: again.name,
      tagline: again.tagline,
      icon: RotateCcw,
      params: 'none',
      // The box writes 255 as folder for this card; any folder but 0 works.
      build: () => ({ folder: 0xff, mode: 11, special: 0, special2: 0 }),
    });
  }
  return [...mods, ...extra];
}

/** Adds a modifier, admin or repeat card to the list of cards to write. */
export function SpecialCardDialog({ onClose }: { onClose: () => void }) {
  const prof = profile.value;
  const options = optionsFor(prof, settings.value.tngRelease);
  const [picked, setPicked] = useState<Option>(options[0]);
  const [minutes, setMinutes] = useState<number>(15);
  /** "Andere": any number of minutes, typed in. */
  const [ownMinutes, setOwnMinutes] = useState<string | null>(null);
  const typed = ownMinutes === null ? minutes : /^\d{1,3}$/.test(ownMinutes.trim()) ? Number(ownMinutes) : 0;
  const minutesProblem = picked.params === 'sleep' && ownMinutes !== null ? sleepMinutesProblem(typed, prof) : undefined;
  const [atEnd, setAtEnd] = useState(false);
  const [pause, setPause] = useState(0);
  const [busy, setBusy] = useState(false);

  const special = picked.params === 'sleep' ? (minutesProblem ? 15 : typed) + (atEnd && prof === 'tng' ? 0x80 : 0) : picked.params === 'dancePause' && prof === 'tng' ? pause : 0;
  const data = picked.build(special);
  const Icon = picked.icon;
  const isModifier = picked.id.startsWith('m');
  /** The same card, with the same settings, is in the list already. */
  const listed = extras.value.find((x) => sameCard(x, data));

  const add = async () => {
    setBusy(true);
    try {
      await addExtraCard(data, extraLabel(data, prof));
      onClose();
    } catch (e) {
      toastError('Die Karte ließ sich nicht hinzufügen', e);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Spezialkarte hinzufügen"
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={add} loading={busy} disabled={!!listed || !!minutesProblem}>
            Hinzufügen
          </Button>
        </>
      }
    >
      <div class="special-picker">
        <div class="special-list" role="radiogroup" aria-label="Spezialkarte">
          {options.map((o) => {
            const OptionIcon = o.icon;
            const checked = o.id === picked.id;
            return (
              <Fragment key={o.id}>
                {o.id === 'admin' ? (
                  <span class="special-group" role="presentation">
                    Weitere Karten
                  </span>
                ) : null}
                <button type="button" role="radio" aria-checked={checked} autoFocus={checked} class="special-option" onClick={() => setPicked(o)}>
                  <span class="special-option-icon">
                    <OptionIcon size={17} strokeWidth={2.2} />
                  </span>
                  {o.name}
                </button>
              </Fragment>
            );
          })}
        </div>
        <div class="special-detail stack">
          <span class="special-detail-icon">
            <Icon size={26} strokeWidth={2} />
          </span>
          <div class="stack tight">
            <h3>{picked.name}</h3>
            <p>{picked.tagline}</p>
          </div>
          {picked.unsupported ? (
            <Callout tone="danger">{picked.unsupported}</Callout>
          ) : picked.needs ? (
            <Callout tone="warning">{picked.needs}</Callout>
          ) : null}
          {listed ? <Callout tone="warning">{alreadyListedNote(listed, prof)}</Callout> : null}
          {picked.params === 'sleep' ? (
            <div class="stack">
              <Field label={prof === 'tng' ? 'Ausschalten nach' : 'Anhalten nach'}>
                <Segmented<number>
                  label="Minuten"
                  value={ownMinutes === null ? minutes : -1}
                  options={[...SLEEP_MINUTES.map((m) => ({ value: m, label: `${m} Min.` })), { value: -1, label: 'Andere' }]}
                  onChange={(m) => {
                    if (m === -1) setOwnMinutes(ownMinutes ?? String(minutes));
                    else {
                      setOwnMinutes(null);
                      setMinutes(m);
                    }
                  }}
                />
              </Field>
              {ownMinutes !== null ? (
                <Field label="Minuten" id="special-own-minutes" hint={minutesProblem ?? `Jede Zahl von 1 bis ${sleepMaxMinutes(prof)}.`}>
                  <input
                    id="special-own-minutes"
                    class="input"
                    style={{ width: 120 }}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={sleepMaxMinutes(prof)}
                    value={ownMinutes}
                    aria-invalid={minutesProblem ? true : undefined}
                    onInput={(e) => setOwnMinutes((e.currentTarget as HTMLInputElement).value)}
                  />
                </Field>
              ) : null}
              {prof === 'tng' ? (
                <Switch checked={atEnd} onChange={setAtEnd} label="Erst am Ende des Titels ausschalten" hint="Kein Abbruch mitten im Satz." />
              ) : (
                <p class="soft small">Mit TonUINO 2.1 hält die Box nach der Zeit nur an. Ganz aus geht sie dann mit dem Ausschalt-Timer.</p>
              )}
            </div>
          ) : null}
          {picked.params === 'dancePause' && prof === 'tng' ? (
            <Field label="Musik zwischen den Pausen">
              <Segmented<number> label="Pausenlänge" value={pause} options={DANCE_PAUSES.map((p, i) => ({ value: i, label: p }))} onChange={setPause} />
            </Field>
          ) : null}
          <p class="soft small special-howto">
            {isModifier
              ? MODIFIER_HOWTO
              : picked.id === 'admin'
                ? 'Gut aufheben, wo die Kinder nicht drankommen.'
                : 'Lege die Karte auf, und die Box spielt wieder, was zuletzt lief.'}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
