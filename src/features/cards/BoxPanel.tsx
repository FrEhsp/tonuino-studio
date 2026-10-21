import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  Calculator,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleQuestionMark,
  CreditCard,
  Info,
  KeyRound,
  ListChecks,
  Package,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
} from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { ADMIN_MODE, type FirmwareProfile } from '../../core/tonuino/card';
import { adminAccessFor, batchGuide, boxGuide, effectiveAccess, releaseMatters, type AdminAccess, type BoxStep, type GuideStart, type KeyPress, type TngRelease } from '../../core/tonuino/boxguide';
import { folderName } from '../../core/tonuino/sd';
import { Button, Callout, Field, Segmented } from '../../ui/components/controls';
import { boxScan, card, catalog, plat, profile, settings, updateSettings } from '../../app/state';
import { systemSoundsPending } from '../../app/pending';
import { HealthDialog } from '../box/HealthDialog';
import { openPackageDialog } from '../box/PackageDialog';
import { SETTING_TEXTS, TNG_RELEASES } from '../settings/options';
import { knownKeys } from '../workshop/boxbuild';
import { logSession } from '../workshop/logsession';
import { boxTrouble, soundsNotice } from './boxcheck';
import { guideEntries, trackCounts, type CardItem } from './items';

const KEY_ICON: Record<'up' | 'down' | 'pause', LucideIcon> = { up: SkipForward, down: SkipBack, pause: Pause };
const KEY_LABEL: Record<'up' | 'down' | 'pause', string> = { up: 'Vor', down: 'Zurück', pause: 'Play/Pause' };
const ACCESS_OPTIONS: { value: AdminAccess; label: string; icon: LucideIcon }[] = [
  { value: 'buttons', label: 'den Tasten', icon: ListChecks },
  { value: 'card', label: 'der Admin-Karte', icon: CreditCard },
  { value: 'pin', label: 'einer PIN', icon: KeyRound },
  { value: 'calc', label: 'einer Rechenaufgabe', icon: Calculator },
];

/** Programming cards with the box's own buttons and voice menu. */
export function BoxPanel({ items }: { items: CardItem[] }) {
  const prof = profile.value;
  const [start, setStart] = useState<GuideStart>('blank');
  const [index, setIndex] = useState(0);
  // A sum to solve exists only in TonUINO 2.1; a TNG box opens without it.
  const access = effectiveAccess(settings.value.adminAccess, prof);
  const counts = useMemo(() => trackCounts(boxScan.value), [boxScan.value]);

  // Single-track cards of one folder in a row are written in one go ("Einzelkarten für einen Ordner").
  const entries = guideEntries(items);
  useEffect(() => setIndex((i) => Math.min(i, Math.max(0, entries.length - 1))), [entries.length]);
  const entry = entries[Math.min(index, entries.length - 1)];
  if (!entry) return null;
  const item = items[entry.first];
  const last = items[entry.last];
  const run = entry.last > entry.first;

  const isModifier = item.data.folder === 0 && item.data.mode !== ADMIN_MODE;
  const usesAdminMenu = run || start === 'reuse' || isModifier;
  const trackCount = (n: number) => counts.get(n);
  const release = settings.value.tngRelease;
  // A TNG box with five keys opens the admin menu two ways; the guide names both when the keys are known.
  void logSession.revision.value;
  const buttons = knownKeys(logSession.source.kind === 'live' ? logSession.book.info : undefined);
  const result = run
    ? batchGuide(item.data.folder, item.data.special, last.data.special, prof, { access, trackCount, buttons })
    : boxGuide(item.data, prof, { start, access, trackCount, release, buttons });
  const unsupported = items.slice(entry.first, entry.last + 1).find((i) => i.unsupported)?.unsupported;
  const folderTitle = catalog.value?.folders[folderName(item.data.folder)]?.title || `Ordner ${folderName(item.data.folder)}`;
  // Asked for all chosen cards at once, so the field does not come and go from one card to the next.
  const askRelease = prof === 'tng' && items.some((i) => releaseMatters(i.data));

  return (
    <div class="stack">
      <SoundsNotice />

      {result.ok || askRelease ? (
        <>
          <div class="row wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
            {/* Special cards go through the admin menu either way: blank or used makes no difference there. */}
            {result.ok && !run && !isModifier ? (
              <Field label="Die Karte ist">
                <Segmented<GuideStart>
                  label="Die Karte ist"
                  value={start}
                  options={[
                    { value: 'blank', label: 'neu und leer' },
                    { value: 'reuse', label: 'schon benutzt' },
                  ]}
                  onChange={setStart}
                />
              </Field>
            ) : null}
            {result.ok && usesAdminMenu ? (
              <Field label="Das Admin-Menü öffnest du mit">
                <Segmented<AdminAccess>
                  label="Admin-Menü"
                  value={access}
                  options={ACCESS_OPTIONS.filter((o) => adminAccessFor(prof).includes(o.value))}
                  onChange={(v) => updateSettings({ adminAccess: v })}
                />
              </Field>
            ) : null}
            {askRelease ? (
              <Field label={SETTING_TEXTS.tngRelease.label} hint={SETTING_TEXTS.tngRelease.hint}>
                <Segmented<TngRelease>
                  label={SETTING_TEXTS.tngRelease.label}
                  value={release}
                  options={TNG_RELEASES.map((r) => ({ value: r.value, label: r.label }))}
                  onChange={(tngRelease) => updateSettings({ tngRelease })}
                />
              </Field>
            ) : null}
          </div>

          {result.ok ? <KeyLegend /> : null}
        </>
      ) : null}

      <div class="guide">
        <div class="guide-head">
          {entries.length > 1 ? (
            <Button size="sm" variant="ghost" icon={ChevronLeft} aria-label="Vorherige Karte" disabled={index === 0} onClick={() => setIndex(index - 1)} />
          ) : null}
          <div class="guide-title">
            {items.length > 1 ? (
              <span class="guide-count">
                {run ? `Karten ${entry.first + 1} bis ${entry.last + 1} von ${items.length}` : `Karte ${entry.first + 1} von ${items.length}`}
              </span>
            ) : null}
            <strong>{run ? `Eine Karte pro Titel: ${folderTitle}` : item.title}</strong>
            <span class="soft small">
              {run ? `Titel ${item.data.special} bis ${last.data.special}, ${entry.last - entry.first + 1} Karten in einem Durchgang` : item.summary}
            </span>
          </div>
          {entries.length > 1 ? (
            <Button size="sm" variant="ghost" icon={ChevronRight} aria-label="Nächste Karte" disabled={index >= entries.length - 1} onClick={() => setIndex(index + 1)} />
          ) : null}
        </div>

        {result.ok ? (
          <>
            <ol class="guide-steps">
              {stepNumbers(result.guide.steps).map((n, i) => (
                <GuideStep step={result.guide.steps[i]} n={n} key={i} onAnswer={(asks) => updateSettings({ tngRelease: asks ? 'newer' : 'older' })} />
              ))}
            </ol>
            {result.guide.notes.length ? (
              <div class="guide-notes">
                {result.guide.notes.map((n) => (
                  <p key={n}>
                    <Info size={15} /> {n}
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : !unsupported ? (
          // A card the firmware does not know is named above the guide already, with what to do.
          <Callout tone="warning" icon={CircleAlert}>
            {result.reason}
          </Callout>
        ) : null}

        {result.ok ? (
          <p class="guide-help">
            {prof === 'classic21'
              ? 'Verdrückt? Mit der Zurück-Taste gehst du eine Zahl zurück. Ganz von vorn: In einem Menü die Play/Pause-Taste lang drücken. Wartet die Box auf die Karte, bricht ein kurzer Druck auf Vor oder Zurück ab.'
              : 'Verdrückt? Mit der Zurück-Taste gehst du eine Zahl zurück. Ganz von vorn: die Play/Pause-Taste lang drücken, dann bricht die Box ab.'}
          </p>
        ) : null}

        {entries.length > 1 ? (
          <div class="row" style={{ justifyContent: 'flex-end' }}>
            {index < entries.length - 1 ? (
              <Button variant="primary" iconRight={ChevronRight} onClick={() => setIndex(index + 1)}>
                Nächste Karte
              </Button>
            ) : (
              <span class="soft small">Das war die letzte Karte.</span>
            )}
          </div>
        ) : null}
      </div>

      <Trouble prof={prof} />
    </div>
  );
}

/**
 * Whether the box can speak while it learns a card: a warning when the open
 * SD card has a problem with its announcements, a hint when no card is open.
 */
function SoundsNotice() {
  const [health, setHealth] = useState(false);
  const notice = soundsNotice(card.value && { ...card.value, soundsPending: systemSoundsPending.value });
  if (!notice) return null;
  if (notice.kind === 'pending') {
    return (
      <Callout tone="warning">
        <div class="sounds-warning">
          <span>{notice.text}</span>
          <Button size="sm" icon={Package} class="sounds-warning-action" onClick={() => openPackageDialog()}>
            Paket für die SD-Karte
          </Button>
        </div>
      </Callout>
    );
  }
  if (notice.kind === 'hint') {
    const caps = plat().capabilities;
    return (
      <Callout tone="neutral" icon={Volume2}>
        Die Box spricht beim Anlernen nur, wenn ihre SD-Karte die Systemansagen hat.{' '}
        {caps.sd || caps.sdPackage ? (
          <>
            Prüfen kannst du das unter <a href="#/">Meine Box</a>.
          </>
        ) : (
          <>
            Wie du sie aufspielst, steht unter <a href="#/hilfe/ansagen">Systemansagen</a>.
          </>
        )}
      </Callout>
    );
  }
  const { text, action } = notice.warning;
  // Red only on „Meine Box“: here a calm line with the way to fix it, so the box does not look broken (audit 0.4 #20).
  return (
    <>
      <p class="sounds-line small">
        <Info size={15} aria-hidden="true" />
        <span>
          {text}{' '}
          {action.kind === 'link' ? (
            <a href={action.href}>{action.label}</a>
          ) : (
            <button type="button" class="link-button" onClick={() => setHealth(true)}>
              {action.label}
            </button>
          )}
        </span>
      </p>
      {health && card.value?.report ? <HealthDialog onClose={() => setHealth(false)} /> : null}
    </>
  );
}

/** What goes wrong most often while a card is taught at the box, folded away under the guide. */
function Trouble({ prof }: { prof: FirmwareProfile }) {
  return (
    <details class="trouble">
      <summary>
        <CircleQuestionMark size={18} strokeWidth={2.2} aria-hidden="true" />
        Klappt es nicht?
        <ChevronDown class="trouble-chevron" size={18} strokeWidth={2.2} aria-hidden="true" />
      </summary>
      <ul class="trouble-list">
        {boxTrouble(prof).map((c) => (
          <li key={c.title}>
            <strong>{c.title}</strong>
            <p>{c.text}</p>
            <a href={c.link.href}>{c.link.label}</a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The number of each step; steps only some boxes ask have none (0). */
export function stepNumbers(steps: readonly BoxStep[]): number[] {
  let n = 0;
  return steps.map((s) => (s.optional ? 0 : ++n));
}

/** `onAnswer`: for a step only some boxes ask, the family can say whether theirs does. */
export function GuideStep({ step, n, onAnswer }: { step: BoxStep; n: number; onAnswer?: (asks: boolean) => void }) {
  return (
    <li class={`guide-step kind-${step.kind} ${step.optional ? 'optional' : ''}`}>
      <span class="guide-num" aria-hidden="true">
        {step.optional ? '?' : n}
      </span>
      <div class="guide-body">
        {step.optional ? <span class="guide-optional-label">Nur falls die Box fragt</span> : null}
        <p>{step.text}</p>
        {step.presses?.length ? <Presses presses={step.presses} /> : null}
        {step.hear ? (
          <p class="guide-hear">
            <Volume2 size={15} aria-hidden="true" /> <span class="visually-hidden">Die Box sagt: </span>
            {step.hear}
          </p>
        ) : null}
        {step.optional && onAnswer ? (
          <div class="row wrap guide-answer">
            <Button size="sm" onClick={() => onAnswer(true)}>
              Meine Box fragt das
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAnswer(false)}>
              Meine Box fragt das nicht
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** The presses of one step as button pictures. */
export function Presses({ presses }: { presses: KeyPress[] }) {
  return (
    <div class="presses" aria-hidden="true">
      {presses.map((p, i) => (
        <span class="press" key={i}>
          {p.key === 'all' ? (
            <>
              <Keycap k="down" />
              <span class="press-plus">+</span>
              <Keycap k="pause" />
              <span class="press-plus">+</span>
              <Keycap k="up" />
            </>
          ) : (
            <Keycap k={p.key} />
          )}
          <span class="press-count">
            {p.times > 1 ? `${p.times}× ` : p.key === 'all' ? 'zusammen ' : ''}
            {p.long ? 'lang' : 'kurz'}
          </span>
        </span>
      ))}
    </div>
  );
}

function Keycap({ k }: { k: 'up' | 'down' | 'pause' }) {
  const Icon = KEY_ICON[k];
  return (
    <span class={`keycap key-${k}`}>
      <Icon size={14} strokeWidth={2.4} />
      {KEY_LABEL[k]}
    </span>
  );
}

export function KeyLegend() {
  return (
    <div class="key-legend">
      <div class="key-legend-box" aria-hidden="true">
        <Keycap k="down" />
        <Keycap k="pause" />
        <Keycap k="up" />
      </div>
      <p class="small soft">
        <strong>kurz</strong> heißt antippen, <strong>lang</strong> heißt etwa eine Sekunde halten, bis die Box spricht. Die Box nennt Vor- und Zurück-Taste auch „Lautstärketasten“.
      </p>
    </div>
  );
}
