import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ArrowRight,
  BookOpen,
  Calculator,
  CardSim,
  ChevronDown,
  CreditCard,
  KeyRound,
  ListChecks,
  Monitor,
  Moon,
  Music,
  Nfc,
  Palette,
  Puzzle,
  RotateCcw,
  Smartphone,
  Speaker,
  Sun,
  Usb,
  Wifi,
  Wrench,
} from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { DEFAULT_SETTINGS, card, chooseCardMethod, platform, profile, resetSettings, setProfile, settings, updateSettings, type CardMethod, type Settings } from '../../app/state';
import { routeToHash } from '../../app/router';
import { handheldWord } from '../../app/device';
import { APP_VERSION, runsAs } from '../../app/version';
import { UpdateCheckSetting } from '../../app/UpdateNotice';
import { adminAccessFor, effectiveAccess, type AdminAccess, type TngRelease } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { Button, Callout, Segmented } from '../../ui/components/controls';
import { arrowKeyHandler } from '../../ui/arrowKeys';
import { Dialog } from '../../ui/components/Dialog';
import { LogoMark } from '../../ui/components/Logo';
import { toast, toastError } from '../../ui/components/Toast';
import {
  ADMIN_ACCESS,
  BITRATES,
  DESKTOP_ONLY,
  PROFILES,
  TNG_RELEASES,
  SETTING_TEXTS,
  SETTINGS_SECTIONS,
  SPLIT_MINUTES,
  THEMES,
  cardMethodsFor,
  changedSettings,
  checkBoxAddress,
  formatSettingValue,
  type SettingChange,
  type SettingKey,
} from './options';
import { RememberedInSettings } from '../box/Remembered';
import { setRemembering } from '../../app/remembered';
import '../../ui/styles/settings.css';

const SECTION_ICONS: Record<string, LucideIcon> = { aussehen: Palette, box: Speaker, hinzufuegen: Music, dateien: CardSim, karten: Nfc, zusatzfunktionen: Puzzle, bastler: Wrench };
const THEME_ICONS: Record<Settings['theme'], LucideIcon> = { auto: Monitor, light: Sun, dark: Moon };
const ACCESS_ICONS: Record<AdminAccess, LucideIcon> = { buttons: ListChecks, card: CreditCard, pin: KeyRound, calc: Calculator };
const METHOD_ICONS: Record<CardMethod, LucideIcon> = { box: Speaker, qr: Smartphone, reader: Nfc, wifi: Wifi, usb: Usb };

/** Every setting of the app in one place, each with a short explanation. */
export function SettingsPage() {
  // Remounts the rows after a reset, so text fields show the defaults again.
  const [generation, setGeneration] = useState(0);
  return (
    <div class="page narrow settings-page">
      <header class="page-header">
        <div class="titles">
          <h1>Einstellungen</h1>
          {/* The web app keeps them in the browser's storage, so another browser starts fresh. */}
          <p>
            Ich merke mir alles {platform.value?.mobile ? `auf diesem ${handheldWord()}` : platform.value?.kind === 'desktop' ? 'auf diesem Computer' : 'in diesem Browser'}. Was du änderst, gilt sofort.
          </p>
        </div>
      </header>

      <div class="stack loose" key={generation}>
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = SECTION_ICONS[section.id] ?? Palette;
          const head = (
            <>
              <span class="settings-section-icon" aria-hidden="true">
                <Icon size={19} strokeWidth={2.2} />
              </span>
              <div class="stack tight grow">
                <h2 id={`settings-${section.id}`}>{section.title}</h2>
                <p class="small muted">{section.intro}</p>
              </div>
            </>
          );
          // „Für Bastler“ stays folded: parents need none of it (audit 0.4 #22).
          if (section.id === 'bastler') {
            return (
              <details class="card settings-section settings-tinker" key={section.id}>
                <summary class="settings-section-head">
                  {head}
                  <ChevronDown class="settings-tinker-chevron" size={20} strokeWidth={2.2} aria-hidden="true" />
                </summary>
                {section.keys.map((key) => (
                  <SettingControl k={key} key={key} />
                ))}
              </details>
            );
          }
          return (
            <section class="card settings-section" aria-labelledby={`settings-${section.id}`} key={section.id}>
              <div class="settings-section-head">
                <span class="settings-section-icon" aria-hidden="true">
                  <Icon size={19} strokeWidth={2.2} />
                </span>
                <div class="stack tight">
                  <h2 id={`settings-${section.id}`}>{section.title}</h2>
                  <p class="small muted">{section.intro}</p>
                </div>
              </div>
              {section.keys.map((key) => (
                <SettingControl k={key} key={key} />
              ))}
            </section>
          );
        })}
      </div>

      <ResetSettings onReset={() => setGeneration((n) => n + 1)} />
      <UpdateCheckSetting />
      <AboutApp />
    </div>
  );
}

/* ------------------------------------------------------------------ one row */

function SettingRow({ k, labelFor, below, note, children, after }: { k: SettingKey; labelFor?: string; below?: boolean; note?: string; children: ComponentChildren; after?: ComponentChildren }) {
  const text = SETTING_TEXTS[k];
  const [open, setOpen] = useState(false);
  const id = `setting-${k}`;
  return (
    <div class={`setting ${below ? 'below' : ''}`} id={id}>
      <div class="setting-main">
        <div class="setting-text">
          {labelFor ? (
            <label class="setting-label" id={`${id}-label`} for={labelFor}>
              {text.label}
            </label>
          ) : (
            <span class="setting-label" id={`${id}-label`}>
              {text.label}
            </span>
          )}
          <p class="setting-hint" id={`${id}-hint`}>
            {text.hint}
            {note ? ` ${note}` : null}
          </p>
        </div>
        <div class="setting-control">{children}</div>
      </div>
      {after}
      <button type="button" class="link-button setting-more-toggle" aria-expanded={open} aria-controls={`${id}-more`} onClick={() => setOpen(!open)}>
        Mehr erfahren
        <ChevronDown size={15} strokeWidth={2.4} class={open ? 'turned' : ''} aria-hidden="true" />
      </button>
      <div class="setting-more" id={`${id}-more`} hidden={!open}>
        {text.more.map((p) => (
          <p key={p}>{p}</p>
        ))}
        {text.help ? (
          <a class="setting-help-link" href={routeToHash({ page: 'help', topic: text.help })}>
            <BookOpen size={15} aria-hidden="true" /> In der Hilfe weiterlesen
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** A switch on the right of its row; the row's label names it. */
function RowSwitch({ k, checked, disabled, onChange }: { k: SettingKey; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <span class="switch">
      <input
        type="checkbox"
        role="switch"
        id={`setting-${k}-input`}
        checked={checked}
        disabled={disabled}
        aria-describedby={`setting-${k}-hint`}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </span>
  );
}

function SettingControl({ k }: { k: SettingKey }) {
  const s = settings.value;
  const caps = platform.value?.capabilities;
  switch (k) {
    case 'theme':
      return (
        <SettingRow k={k}>
          <div class="settings-segmented settings-theme">
            <Segmented<Settings['theme']>
              label={SETTING_TEXTS.theme.label}
              value={s.theme}
              options={THEMES.map((t) => ({ value: t.value, label: t.label, icon: THEME_ICONS[t.value] }))}
              onChange={(theme) => updateSettings({ theme })}
            />
          </div>
        </SettingRow>
      );
    case 'profile':
      return (
        <SettingRow k={k}>
          <Segmented<FirmwareProfile>
            label={SETTING_TEXTS.profile.label}
            value={profile.value}
            options={PROFILES.map((p) => ({ value: p.value, label: p.label }))}
            onChange={(p) => setProfile(p).catch((e) => toastError('Speichern hat nicht geklappt', e))}
          />
        </SettingRow>
      );
    case 'tngRelease':
      return (
        <SettingRow k={k}>
          <Segmented<TngRelease>
            label={SETTING_TEXTS.tngRelease.label}
            value={s.tngRelease}
            options={TNG_RELEASES.map((r) => ({ value: r.value, label: r.label }))}
            onChange={(tngRelease) => updateSettings({ tngRelease })}
          />
        </SettingRow>
      );
    case 'adminAccess': {
      // Like the guide on the cards page: the sum to solve only for TonUINO 2.1.
      const offered = adminAccessFor(profile.value);
      return (
        <SettingRow k={k} below>
          <div class={`settings-segmented settings-admin ${offered.length > 3 ? 'many' : ''}`}>
            <Segmented<AdminAccess>
              label="Admin-Menü"
              value={effectiveAccess(s.adminAccess, profile.value)}
              options={ADMIN_ACCESS.filter((a) => offered.includes(a.value)).map((a) => ({ value: a.value, label: a.label, icon: ACCESS_ICONS[a.value] }))}
              onChange={(adminAccess) => updateSettings({ adminAccess })}
            />
          </div>
        </SettingRow>
      );
    }
    case 'bitrateKbps':
      return (
        <SettingRow k={k} below>
          <div class="settings-segmented settings-bitrate">
            <Segmented<Settings['bitrateKbps']>
              label={SETTING_TEXTS.bitrateKbps.label}
              value={s.bitrateKbps}
              options={BITRATES.map((b) => ({
                value: b.value,
                label: (
                  <>
                    {b.word} <small class="bitrate-number">{b.label}</small>
                  </>
                ),
              }))}
              onChange={(bitrateKbps) => updateSettings({ bitrateKbps })}
            />
          </div>
        </SettingRow>
      );
    case 'splitMinutes': {
      // A value from an older version still shows up instead of an empty field.
      const minutes: number[] = SPLIT_MINUTES.includes(s.splitMinutes as (typeof SPLIT_MINUTES)[number]) ? [...SPLIT_MINUTES] : [...SPLIT_MINUTES, s.splitMinutes].sort((a, b) => a - b);
      return (
        <SettingRow k={k} labelFor="setting-splitMinutes-input">
          <select
            id="setting-splitMinutes-input"
            class="select settings-select"
            value={String(s.splitMinutes)}
            aria-describedby="setting-splitMinutes-hint"
            onChange={(e) => updateSettings({ splitMinutes: Number(e.currentTarget.value) })}
          >
            {minutes.map((m) => (
              <option value={String(m)} key={m}>
                etwa {m} Minuten
              </option>
            ))}
          </select>
        </SettingRow>
      );
    }
    case 'cardMethod':
      return (
        <SettingRow k={k} below>
          <CardMethodChoice />
        </SettingRow>
      );
    case 'boxAddress':
      return (
        <SettingRow k={k} below labelFor="setting-boxAddress-input">
          <BoxAddressField enabled={!!caps?.wifiBox} />
        </SettingRow>
      );
    case 'announceTitles':
      // Stays switchable in the browser: the places it adds say that the desktop app speaks.
      return (
        <SettingRow k={k} labelFor={`setting-${k}-input`} note={platform.value?.speech ? undefined : 'Die Ansagen selbst macht nur die Desktop-App.'}>
          <RowSwitch k={k} checked={s.announceTitles} onChange={(v) => updateSettings({ announceTitles: v })} />
        </SettingRow>
      );
    case 'boostQuietMp3': {
      // Only "same loudness" makes quiet albums louder: without it the switch does nothing, and shows off.
      const off = !s.normalizeLoudness;
      return (
        <SettingRow k={k} labelFor={`setting-${k}-input`} note={off ? 'Geht nur mit „Gleiche Lautstärke“.' : undefined}>
          <RowSwitch k={k} checked={s.boostQuietMp3 && !off} disabled={off} onChange={(v) => updateSettings({ boostQuietMp3: v })} />
        </SettingRow>
      );
    }
    case 'rememberBoxes':
      // The boxes remembered so far, each to forget, under the switch.
      return (
        <SettingRow k={k} labelFor={`setting-${k}-input`} after={<RememberedInSettings />}>
          <RowSwitch k={k} checked={s.rememberBoxes} onChange={setRemembering} />
        </SettingRow>
      );
    case 'normalizeLoudness':
    case 'pureNumbers':
    case 'stripTags':
    case 'advancedModes':
    case 'doneSound':
    case 'findCovers':
    case 'joinTracks':
    case 'trimTracks':
    case 'monoSpeech':
    case 'episodePlanner':
    case 'stickerBacks':
    case 'recordAudio':
      // A phone or tablet always offers recording (state.ts recordingOffered): no switch to look for.
      if (k === 'recordAudio' && platform.value?.capabilities.builtInMic) return null;
      return (
        <SettingRow k={k} labelFor={`setting-${k}-input`}>
          <RowSwitch k={k} checked={s[k]} onChange={(v) => updateSettings({ [k]: v })} />
        </SettingRow>
      );
    default: {
      // A new setting without a control here fails the type check instead of leaving a gap on the page.
      const missing: never = k;
      return missing;
    }
  }
}

function CardMethodChoice() {
  const caps = platform.value?.capabilities;
  const mobile = !!platform.value?.mobile;
  const methods = cardMethodsFor(mobile, handheldWord());
  const available = (m: CardMethod) => methods.some((c) => c.value === m) && (m === 'reader' ? !!caps?.nfcReader : m === 'wifi' ? !!caps?.wifiBox : true);
  // The cards page falls back to the first way when the stored way is not available here; show the same.
  const current = available(settings.value.cardMethod) ? settings.value.cardMethod : methods[0].value;
  // The arrow keys move between the ways this app can use; the others are skipped.
  const usable = methods.filter((m) => available(m.value));
  return (
    <div
      class="choices methods settings-methods"
      role="radiogroup"
      aria-labelledby="setting-cardMethod-label"
      aria-describedby="setting-cardMethod-hint"
      onKeyDown={arrowKeyHandler(
        usable.findIndex((m) => m.value === current),
        (i) => chooseCardMethod(usable[i].value),
      )}
    >
      {methods.map((m) => {
        const Icon = mobile && m.value === 'reader' ? Smartphone : METHOD_ICONS[m.value];
        const ok = available(m.value);
        return (
          <button
            type="button"
            role="radio"
            aria-checked={ok && m.value === current}
            aria-disabled={!ok}
            tabIndex={ok && m.value === current ? 0 : -1}
            class={`choice ${ok ? '' : 'disabled'}`}
            key={m.value}
            onClick={() => ok && chooseCardMethod(m.value)}
          >
            <span class="choice-icon">
              <Icon size={19} strokeWidth={2.2} />
            </span>
            <span class="choice-title">{m.label}</span>
            <span class="choice-text">{m.text}</span>
            {!ok ? <span class="choice-note">{DESKTOP_ONLY}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function BoxAddressField({ enabled }: { enabled: boolean }) {
  const [text, setText] = useState(settings.value.boxAddress);
  // A mistake shows once the field is left, not after every key while typing;
  // a stored address that cannot work (typed on the cards page) shows right away.
  const [checked, setChecked] = useState(() => !checkBoxAddress(settings.value.boxAddress).ok);
  const check = checkBoxAddress(text);
  const error = checked && !check.ok ? check.message : null;
  const onInput = (value: string) => {
    setText(value);
    const c = checkBoxAddress(value);
    // Only addresses that can work are kept; until then the last good one stays.
    if (c.ok) updateSettings({ boxAddress: c.value });
  };
  return (
    <div class="stack tight settings-address">
      <input
        id="setting-boxAddress-input"
        class="input"
        value={text}
        disabled={!enabled}
        inputMode="url"
        autocomplete="off"
        spellcheck={false}
        placeholder="z. B. 192.168.178.40 oder tonuino.fritz.box"
        aria-invalid={!!error}
        aria-describedby={error ? 'setting-boxAddress-hint setting-boxAddress-error' : 'setting-boxAddress-hint'}
        onInput={(e) => onInput(e.currentTarget.value)}
        onBlur={() => setChecked(true)}
      />
      <div aria-live="polite">
        {error ? (
          <p class="settings-error small" id="setting-boxAddress-error">
            {error}
          </p>
        ) : null}
      </div>
      {!enabled ? <p class="small muted">{DESKTOP_ONLY}. Der Browser darf die Box im Heimnetz nicht erreichen.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ reset */

function ResetSettings({ onReset }: { onReset: () => void }) {
  const [asking, setAsking] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const changes = changedSettings(settings.value, DEFAULT_SETTINGS);
  // After a reset the button is disabled, so the dialog cannot give focus back
  // to it; keyboard and screen reader users stay here instead of at the top.
  // Runs after the dialog is gone, so its own focus return cannot win.
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    heading.current?.focus();
  }, [refocus]);
  return (
    <section class="card pad stack" aria-labelledby="settings-reset">
      <div class="stack tight">
        <h2 id="settings-reset" tabIndex={-1} ref={heading}>
          Einstellungen zurücksetzen
        </h2>
        <p class="small soft">Stellt die Einstellungen oben wieder so ein wie beim ersten Start. Deine SD-Karte und deine Sticker bleiben, wie sie sind.</p>
      </div>
      <div class="row wrap">
        <Button icon={RotateCcw} disabled={!changes.length} onClick={() => setAsking(true)}>
          Einstellungen zurücksetzen …
        </Button>
        {!changes.length ? <span class="small muted">Alles steht schon auf den Grundeinstellungen.</span> : null}
      </div>
      {asking ? (
        <ResetDialog
          changes={changes}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            setRefocus(true);
            onReset();
          }}
        />
      ) : null}
    </section>
  );
}

function ResetDialog({ changes, onClose, onDone }: { changes: SettingChange[]; onClose: () => void; onDone: () => void }) {
  const open = card.value?.catalog;
  // The card keeps its own firmware; say so when it will differ from the reset default.
  const cardKeeps = open && open.profile !== DEFAULT_SETTINGS.profile ? formatSettingValue('profile', open.profile) : null;
  const reset = () => {
    resetSettings();
    toast.success('Einstellungen zurückgesetzt', 'Alles steht wieder wie beim ersten Start.');
    onDone();
  };
  return (
    <Dialog
      title="Einstellungen zurücksetzen?"
      onClose={onClose}
      footer={
        <>
          <Button autofocus onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="danger" icon={RotateCcw} onClick={reset}>
            Zurücksetzen
          </Button>
        </>
      }
    >
      <div class="stack">
        <p>Das stellt die App zurück:</p>
        <ul class="settings-changes">
          {changes.map((c) => (
            <li key={c.key}>
              <span class="settings-change-label">{c.label}</span>
              <span class="settings-change-values">
                <span class="muted">{c.from}</span>
                <ArrowRight size={14} aria-hidden="true" />
                <span class="visually-hidden"> wird zu </span>
                <strong>{c.to}</strong>
              </span>
            </li>
          ))}
        </ul>
        {cardKeeps ? (
          <Callout tone="neutral">
            Die eingesteckte SD-Karte bleibt bei {cardKeeps}. Jede Karte merkt sich ihre Firmware selbst. Ändern kannst du sie oben bei „{SETTING_TEXTS.profile.label}“.
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ about */

function AboutApp() {
  const where = runsAs(platform.value);
  return (
    <section class="card pad settings-about" aria-label="Über TonUINO Studio">
      <LogoMark size={44} />
      <div class="stack tight grow">
        <strong>TonUINO Studio</strong>
        <span class="small soft">
          Version {APP_VERSION} · {where}
        </span>
        <span class="small muted">Ein unabhängiges Projekt, nicht das offizielle TonUINO-Projekt.</span>
      </div>
      <a class="btn" href={routeToHash({ page: 'help', topic: 'ueber' })}>
        Über TonUINO Studio
      </a>
    </section>
  );
}
