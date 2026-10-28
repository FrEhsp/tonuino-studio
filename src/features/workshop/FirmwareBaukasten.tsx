/**
 * The firmware wizard for Classic and AiO (0.6, design/06-umbau/loetplan,
 * entwurf-baukasten-* and entwurf-verhalten-*): „Extras“ as tiles with
 * pictures and „Deine Auswahl“ always in view, then „Verhalten“ in
 * sentences, each saying whether it goes into the firmware or is set at the
 * box. The rules stay in wizard.ts, baukastenWahl.ts and verhalten.ts.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, FileUp, RotateCcw } from 'lucide-preact';
import { WRITE_CARD_TEXT, choiceStatus, normalizeChoice, type BaukastenManifest, type ExtrasChoice, type KnobKind, type LightKind } from '../../core/firmware/baukasten';
import type { FlashProblem } from '../../core/firmware/flash';
import { CHIP_SYMPTOM_TEXT, CHIP_TEXTS, MH2024K16SS_TEXT } from '../../core/firmware/mp3chip';
import { VARIANTS, askShutdown, type BoardInfo, type ShutdownKind, type Stk500Board } from '../../core/firmware/variants';
import { invertKind } from '../../core/firmware/tngstands';
import { keyCount } from '../../core/tonuino/adminkeys';
import { Button, Segmented, Spinner, Steps } from '../../ui/components/controls';
import { BackToWorkshop } from './common';
import { toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { plat } from '../../app/state';
import { BildWahl, BoxVorne, KastenJa, ZeichenBox, ZeichenFw } from './BaukastenBilder';
import { baukasten, firmwareName, firmwareTeile, knopfName, knopfPins, lichtName, lichtPins, loetplanFuer, type Kachel, type Teil } from './baukastenWahl';
import { APP_BASE, localFetch, useBaukastenManifest } from './ExtrasPanel';
import { KnownExtrasNote } from './ExtrasLost';
import { flashSession } from './flashsession';
import { loetplanWahl, waehle } from './loetplan';
import { ProblemView } from './ProblemView';
import { Saetze, WoMarke } from './VerhaltenSaetze';
import { boxPunkte, draftFrom, firmwareSatz, knowledge, verhalten, visibleParts, wishOf, type Draft } from './verhalten';
import {
  SHUTDOWN_CHOICES,
  baukastenChoice,
  baukastenProblem,
  chooseExtras,
  chooseFirmware,
  chooseShutdown,
  goTo,
  loadBaukasten,
  nextStep,
  pickReadyMade,
  previousStep,
  readOwnFirmware,
  readyMadeAllowed,
  shutdownAdvice,
  stepsFor,
  wantedBuildId,
  type WizardState,
  type WizardStep,
} from './wizard';


const session = flashSession;
const set = (w: WizardState) => (session.wizard.value = w);

/* ------------------------------------------------------------------ the build in the background */

/**
 * Keeps the build the choices ask for loaded: the files come with the app,
 * so this takes a moment only. A file of your own is left alone.
 */
function useBaukastenBuild(board: Stk500Board, manifest: BaukastenManifest | null | 'failed', vorab = false) {
  const s = session.wizard.value;
  const want = wantedBuildId(s);
  const has = s.firmware?.kind === 'download' && s.firmware.baukasten?.id === want;
  const b = baukastenChoice(s);
  const ok = !!b && !!manifest && manifest !== 'failed' && choiceStatus(manifest, b.board, b.buttons, b.choice).kind === 'ok';
  // Drawn ahead while „Tasten“ is asked (FirmwareTool): nothing is loaded until it shows.
  const skip = vorab || s.firmware?.kind === 'file' || !readyMadeAllowed(board, s.shutdown) || !ok;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<FlashProblem | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (skip || has || !manifest) {
      setBusy(false);
      return;
    }
    let live = true;
    setBusy(true);
    setProblem(null);
    loadBaukasten(localFetch, APP_BASE, manifest, session.wizard.value).then(
      (firmware) => {
        const now = session.wizard.value;
        if (live && wantedBuildId(now) === want && now.firmware?.kind !== 'file') set(chooseFirmware(now, firmware));
      },
      (e) => live && setProblem(baukastenProblem(e)),
    );
    return () => {
      live = false;
    };
  }, [want, skip, has, again]);
  return { busy: busy && !has, problem, retry: () => setAgain((n) => n + 1) };
}

/* ------------------------------------------------------------------ the steps */

/**
 * The steps of „Firmware aufspielen“, the same bar on all five steps (Prüfrunde 1
 * Bastler 1 and 2, Aussehen 5): the ones done are buttons back and show what
 * was chosen. `run`: while the firmware goes onto the box, and after, nothing leads back.
 * On a phone the arrow back stays in front of it.
 */
export function FirmwareSteps({ s, board, run = 'idle' }: { s: WizardState; board?: BoardInfo; run?: 'idle' | 'running' | 'done' }) {
  const steps = stepsFor(board).filter((x) => !(x.id === 'verhalten' && s.firmware?.kind === 'file'));
  const locked = run !== 'idle';
  const active = run === 'done' ? steps.length : run === 'running' ? steps.length - 1 : steps.findIndex((x) => x.id === s.step);
  const wahl: Partial<Record<WizardStep, string>> = { board: board?.shortName, variant: s.variant ? VARIANTS[s.variant].label : undefined };
  const back = locked ? undefined : previousStep(s);
  return (
    <div class="ws-steps fw-steps">
      {back ? (
        <button type="button" class="zurueck nur-handy" aria-label="Zurück" onClick={() => set(goTo(session.wizard.value, back))}>
          <ArrowLeft size={24} aria-hidden="true" />
        </button>
      ) : null}
      <Steps
        steps={steps.map((x) => x.label)}
        active={active}
        values={steps.map((x) => wahl[x.id])}
        onPick={locked ? undefined : (i) => set(goTo(session.wizard.value, steps[i].id))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ Extras */

const FOKUSSIERBAR = 'a[href], button, input, select, textarea, summary, [tabindex]';

/**
 * The screen drawn ahead cannot be reached with Tab: focus that lands in it
 * goes on past it, forward or back, as the key was meant. (`inert` would do
 * the same, but taking it away makes the browser work out the styles of every
 * element in it again, just when it is to show.) Screen readers skip it
 * (aria-hidden), the mouse cannot reach it (clipped away, baukasten.css).
 */
function useVorab(vorab: boolean) {
  const wurzel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wurzel.current;
    if (!el || !vorab) return;
    // Coming from outside the page (the browser's own bar) there is no element to go by, only the key.
    let zurueck = false;
    const taste = (e: KeyboardEvent) => {
      if (e.key === 'Tab') zurueck = e.shiftKey;
    };
    const weiter = (e: FocusEvent) => {
      const von = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      const vorwaerts = von ? !!(von.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : !zurueck;
      const andere = [...document.querySelectorAll<HTMLElement>(FOKUSSIERBAR)].filter((x) => !el.contains(x) && x.tabIndex >= 0 && !x.closest('[inert]') && x.getClientRects().length > 0);
      const nach = andere.filter((x) => el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
      const vor = andere.filter((x) => el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING);
      const ziel = vorwaerts ? (nach[0] ?? vor[0]) : (vor[vor.length - 1] ?? nach[nach.length - 1]);
      if (ziel) ziel.focus();
      else (e.target as HTMLElement).blur();
    };
    el.addEventListener('focusin', weiter);
    document.addEventListener('keydown', taste, true);
    return () => {
      el.removeEventListener('focusin', weiter);
      document.removeEventListener('keydown', taste, true);
    };
  }, [vorab]);
  return wurzel;
}

export const SHUTDOWN_SHORT: Record<ShutdownKind, string> = { switch: 'Schalter oder Powerbank', pololu: 'Pololu-Schalter', traeger: 'CubieKid- oder Trägerplatine', unknown: 'Weiß ich nicht' };

/** `vorab`: drawn ahead and hidden while „Tasten“ is asked (FirmwareTool); „Weiter“ only shows it. */
export function BaukastenSchirm({ s, board, vorab = false }: { s: WizardState; board: Stk500Board; vorab?: boolean }) {
  const manifest = useBaukastenManifest();
  const build = useBaukastenBuild(board, manifest, vorab);
  const wurzel = useVorab(vorab);
  const [warum, setWarum] = useState<{ gruppe: 'knopf' | 'licht' | 'teile' | 'mehr'; text: string } | null>(null);
  const [fileProblem, setFileProblem] = useState<FlashProblem | null>(null);
  const [reading, setReading] = useState(false);
  const b = baukastenChoice(s);
  if (!b || !s.variant) return null;
  const value: ExtrasChoice = s.extras ?? {};
  const choice = b.choice;
  const own = s.firmware?.kind === 'file' ? s.firmware : undefined;
  const asked = askShutdown(board);
  const next = nextStep(s);

  const change = (patch: Partial<ExtrasChoice>) => {
    setWarum(null);
    const now = session.wizard.value;
    set(chooseExtras(pickReadyMade(now), normalizeChoice(b.board, b.buttons, { ...(now.extras ?? {}), ...patch })));
  };

  const pickFile = async () => {
    let file;
    try {
      [file] = await plat().pickFiles({ extensions: ['hex'], multiple: false });
    } catch (e) {
      toastError('Die Dateiauswahl ging nicht auf', e);
      return;
    }
    if (!file) return;
    setFileProblem(null);
    setReading(true);
    const read = await readOwnFirmware(file, board);
    setReading(false);
    if ('problem' in read) setFileProblem(read.problem);
    else set(goTo(chooseFirmware(session.wizard.value, read.firmware), 'flash'));
  };

  const openLoetplan = () => {
    waehle(loetplanFuer(loetplanWahl.value, b.board, b.buttons, choice, s.shutdown));
    navigate({ page: 'workshop', tool: 'loetplan' });
  };

  const bk = manifest && manifest !== 'failed' ? baukasten(manifest, b.board, b.buttons, value, !!choice.traeger) : null;
  const status = manifest && manifest !== 'failed' ? choiceStatus(manifest, b.board, b.buttons, choice) : null;
  const blocker = own
    ? undefined
    : asked && !s.shutdown
      ? 'Sage zuerst, wie deine Box ausgeht.'
      : !readyMadeAllowed(board, s.shutdown)
        ? 'Nimm für deine Box „Eigene Datei“.'
        : status && status.kind !== 'ok'
          ? 'Diese Zusammenstellung gibt es nicht. Nimm ein Extra weniger.'
          : undefined;
  const advice = asked ? shutdownAdvice(board, s.shutdown) : undefined;

  const auswahl = (
    <Auswahl
      board={b.board === 'classic' ? 'Classic mit Nano' : 'AiO'}
      tasten={VARIANTS[s.variant].label}
      choice={choice}
      pins={b.board}
      shutdown={asked ? s.shutdown : undefined}
      name={manifest && manifest !== 'failed' ? firmwareName(manifest.tng.version, b.board, b.buttons, choice) : undefined}
    />
  );

  return (
    // Shown by taking `data-vorab` away, an attribute the drawn frames do not watch: their shapes stay as they are.
    <div ref={wurzel} class="schirm bk-schirm" data-vorab={vorab ? '' : undefined} aria-hidden={vorab ? 'true' : undefined}>
      <div class="arbeit">
        <section class="gross" aria-labelledby="bk-titel">
          {/* The same head as steps 1, 2 and 5: one page, one flow (Prüfrunde 1 Bastler 2). */}
          <div class="bk-kopf nur-rechner">
            <BackToWorkshop />
            <h1 id="bk-titel">Firmware aufspielen</h1>
          </div>
          <FirmwareSteps s={s} board={board} />
          {manifest === 'failed' ? (
            <div class="ws-problem-box">
              <ProblemView compact problem={baukastenProblem(new Error('manifest'))} />
            </div>
          ) : !bk ? (
            <p class="row soft">
              <Spinner size={16} /> Lade die Extras …
            </p>
          ) : (
            <div class="bk">
              <div class="bk-oben">
                <div class="card bk-bild">
                  <BoxVorne knob={choice.knob} light={choice.light} />
                  <p class="unter-bild nur-rechner">
                    So sieht deine Box dann aus.
                    <br />
                    Was du wählst, kommt hier dazu.
                  </p>
                </div>
                <div class="nur-handy">{auswahl}</div>
              </div>
              <div class="bk-wahl">
                {bk.knopf ? (
                  <Gruppe titel="Knopf für die Lautstärke">
                    <Kacheln<KnobKind>
                      label="Knopf für die Lautstärke"
                      kacheln={bk.knopf}
                      value={choice.knob}
                      onPick={(knob) => change({ knob })}
                      onGesperrt={(text) => setWarum({ gruppe: 'knopf', text })}
                    />
                    <SatzWahl kacheln={bk.knopf} value={choice.knob} warum={warum?.gruppe === 'knopf' ? warum.text : undefined} />
                  </Gruppe>
                ) : null}
                {bk.licht ? (
                  <Gruppe titel="Licht">
                    <Kacheln<LightKind>
                      label="Licht"
                      kacheln={bk.licht}
                      value={choice.light}
                      onPick={(light) => change({ light })}
                      onGesperrt={(text) => setWarum({ gruppe: 'licht', text })}
                    />
                    <SatzWahl kacheln={bk.licht} value={choice.light} warum={warum?.gruppe === 'licht' ? warum.text : undefined} />
                  </Gruppe>
                ) : null}
                {bk.teile.length ? (
                  <Gruppe titel="Zusatzteile" klein="nur ankreuzen, was du eingebaut hast">
                    <div class="card teile-liste">
                      {bk.teile.map((t) => (
                        <TeilZeile key={t.id} t={t} an={!!choice[t.id]} onChange={(an) => change({ [t.id]: an })} onGesperrt={(text) => setWarum({ gruppe: 'teile', text })} />
                      ))}
                    </div>
                    {warum?.gruppe === 'teile' ? (
                      <p class="satz-wahl warum" role="status">
                        {warum.text}
                      </p>
                    ) : null}
                    {b.board === 'classic' && (choice.speakerOff || choice.light === 'ledButtons') ? <p class="bk-hinweis">An D6 hängt jetzt ein Teil. Schließe dort nichts anderes an, auch kein Bluetooth-Modul.</p> : null}
                  </Gruppe>
                ) : null}
                {asked ? (
                  <Gruppe titel="Wie geht deine Box aus?">
                    <div class="bk-aus">
                      <Segmented<ShutdownKind>
                        label="Wie geht deine Box aus?"
                        value={s.shutdown ?? ('' as ShutdownKind)}
                        options={SHUTDOWN_CHOICES.map((c) => ({ value: c.id, label: SHUTDOWN_SHORT[c.id] }))}
                        onChange={(kind) => set(chooseShutdown(pickReadyMade(session.wizard.value), kind))}
                      />
                    </div>
                    {advice ? <p class={`satz-wahl${advice.tone === 'warning' ? ' warum' : ''}`}>{advice.text}</p> : null}
                  </Gruppe>
                ) : null}
                <Mehr bk={bk} choice={choice} change={change} />
                {bk.gehtNicht.length ? (
                  <details class="zugeklappt">
                    <summary>
                      <b>Geht gerade nicht ({bk.gehtNicht.length}):</b>
                      <span class="namen">{bk.gehtNicht.map((g) => g.name).join(', ')}</span>
                    </summary>
                    <ul>
                      {bk.gehtNicht.map((g) => (
                        <li key={g.name}>
                          <b>{g.name}:</b> {g.warum}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </div>
          )}
        </section>
        <aside class="spalte">
          <div class="nur-rechner">{auswahl}</div>
          <div class="nur-rechner">
            <KnownExtrasNote board={board.id} variant={s.variant} />
          </div>
          {status?.kind === 'ok' && status.build.needsNewBootloader ? (
            <p class="bk-eigene">Diese Firmware braucht einen Nano mit neuem Startprogramm (Bootloader). Das prüfe ich beim Aufspielen. Passt es nicht, bleibt deine Box, wie sie ist.</p>
          ) : null}
          <p class="bk-eigene">
            <button type="button" class="link-button" onClick={openLoetplan}>
              Lötplan mit diesen Extras ansehen
            </button>
          </p>
          <p class="bk-eigene">
            Du hast eine eigene .hex-Datei?{' '}
            <button type="button" class="link-button" onClick={pickFile}>
              <FileUp size={16} aria-hidden="true" /> Eigene Datei aufspielen
            </button>
          </p>
          {!plat().capabilities.serial ? <p class="bk-eigene">Aufspielen geht nur über USB: in Chrome, Edge, Firefox ab 151 oder der Desktop-App.</p> : null}
          {reading ? (
            <p class="row soft">
              <Spinner size={16} /> Lese die Datei …
            </p>
          ) : null}
          {fileProblem ? (
            <div class="ws-problem-box">
              <ProblemView compact problem={fileProblem}>
                <Button icon={FileUp} onClick={pickFile}>
                  Andere Datei wählen
                </Button>
              </ProblemView>
            </div>
          ) : null}
          {build.problem && !own ? (
            <div class="ws-problem-box">
              <ProblemView compact problem={build.problem}>
                <Button icon={RotateCcw} onClick={build.retry}>
                  Noch einmal versuchen
                </Button>
              </ProblemView>
            </div>
          ) : null}
          <div class="unten">
            {own ? (
              <p class="zeile-klein">
                Du spielst deine Datei „{own.fileName}“ auf.{' '}
                <button type="button" class="link-button" onClick={() => set(pickReadyMade(session.wizard.value))}>
                  Doch die fertige Firmware
                </button>
              </p>
            ) : blocker ? (
              <p class="zeile-klein" role="status">
                {blocker}
              </p>
            ) : (
              <p class="zeile-klein nur-rechner">Die Firmware ist schon fertig in der App. Du musst nichts übersetzen.</p>
            )}
            <button type="button" class="btn primary xl wide" disabled={!next} onClick={() => next && set(goTo(session.wizard.value, next))}>
              {own ? 'Weiter: Aufspielen' : 'Weiter: Verhalten'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Gruppe({ titel, klein, children }: { titel: string; klein?: string; children: ComponentChildren }) {
  return (
    <section>
      <h2>
        {titel} {klein ? <span>{klein}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** The tiles of a group as radio buttons; a grey tile says why it cannot be chosen. */
function Kacheln<T extends string>({ label, kacheln, value, onPick, onGesperrt }: { label: string; kacheln: Kachel<T>[]; value: T | undefined; onPick: (v: T | undefined) => void; onGesperrt: (text: string) => void }) {
  return (
    <div class="bilder" role="radiogroup" aria-label={label}>
      {kacheln.map((k) => (
        <button
          type="button"
          role="radio"
          key={k.id ?? 'kein'}
          class={`choice bk-kachel${k.sperre ? ' gesperrt' : ''}`}
          aria-checked={k.id === value}
          aria-disabled={k.sperre ? true : undefined}
          title={k.sperre}
          onClick={() => (k.sperre ? onGesperrt(`${k.name}: ${k.sperre}`) : onPick(k.id))}
        >
          <BildWahl art={k.bild} />
          <b>
            <span class="vh-lang">{k.name}</span>
            <span class="vh-kurz">{k.kurz}</span>
          </b>
        </button>
      ))}
    </div>
  );
}

/** „Drehregler: Drehen macht lauter oder leiser …“, or why a grey tile cannot be chosen. */
function SatzWahl<T extends string>({ kacheln, value, warum }: { kacheln: Kachel<T>[]; value: T | undefined; warum?: string }) {
  if (warum) {
    return (
      <p class="satz-wahl warum" role="status">
        {warum}
      </p>
    );
  }
  const k = kacheln.find((x) => x.id === value);
  if (!k) return null;
  return (
    <p class="satz-wahl nur-rechner">
      <b>{k.name}:</b> {k.text}
    </p>
  );
}

function TeilZeile({ t, an, onChange, onGesperrt }: { t: Teil; an: boolean; onChange: (an: boolean) => void; onGesperrt: (text: string) => void }) {
  const off = !!t.sperre && !an;
  return (
    <label class={`teil${off ? ' gesperrt' : ''}`} title={off ? t.sperre : undefined} onClick={off ? () => onGesperrt(`${t.name}: ${t.sperre}`) : undefined}>
      <input type="checkbox" checked={an} disabled={off} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <KastenJa an={an} />
      <span class="was">
        {t.name}
        <small>{t.klein}</small>
      </span>
      {t.pin ? <span class="pin">{t.pin}</span> : null}
    </label>
  );
}

/** Folded: another MP3 chip, the alarm start, the preview of writing cards; open when one of them is on. */
function Mehr({ bk, choice, change }: { bk: ReturnType<typeof baukasten>; choice: ExtrasChoice; change: (patch: Partial<ExtrasChoice>) => void }) {
  const [warum, setWarum] = useState<string | null>(null);
  const names = [bk.chips ? 'anderer MP3-Player-Chip' : '', ...bk.mehr.map((m) => m.name)].filter(Boolean);
  if (!names.length) return null;
  return (
    <details class="zugeklappt" open={!!choice.chip || !!choice.alarm || !!choice.writeCard}>
      <summary>
        <b>Mehr:</b>
        <span class="namen">{names.join(', ')}</span>
      </summary>
      <div class="bk-mehr-inhalt">
        {bk.chips ? (
          <fieldset class="ws-extras-group" role="radiogroup" aria-label="MP3-Player-Chip">
            <legend>MP3-Player-Chip</legend>
            <p class="small muted">{CHIP_SYMPTOM_TEXT}</p>
            <ChipZeile name={CHIP_TEXTS.standard.label} text={CHIP_TEXTS.standard.text} an={!choice.chip || choice.chip === 'standard'} onPick={() => change({ chip: undefined })} />
            {bk.chips.map((c) => (
              <ChipZeile key={c.id} name={c.name} text={CHIP_TEXTS[c.id].text} look={CHIP_TEXTS[c.id].look} sperre={c.sperre} an={choice.chip === c.id} onPick={() => change({ chip: c.id })} />
            ))}
            <ChipZeile name={MH2024K16SS_TEXT.label} text={MH2024K16SS_TEXT.text} look={MH2024K16SS_TEXT.look} sperre={MH2024K16SS_TEXT.why} an={false} onPick={() => undefined} />
          </fieldset>
        ) : null}
        {bk.mehr.length ? (
          <div class="card teile-liste">
            {bk.mehr.map((t) => (
              <TeilZeile key={t.id} t={t} an={!!choice[t.id]} onChange={(an) => change({ [t.id]: an })} onGesperrt={setWarum} />
            ))}
          </div>
        ) : null}
        {bk.mehr.some((m) => m.id === 'writeCard') ? <p class="small muted">{WRITE_CARD_TEXT.text}</p> : null}
        {warum ? (
          <p class="satz-wahl warum" role="status">
            {warum}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** A chip of the MP3 player, as the choice of 0.5: name, when to take it, what is printed on it. */
function ChipZeile({ name, text, look, sperre, an, onPick }: { name: string; text: string; look?: string; sperre?: string; an: boolean; onPick: () => void }) {
  const off = !!sperre && !an;
  return (
    <label class={`ws-check${off ? ' is-off' : ''}`}>
      <input type="radio" name="bk-chip" checked={an} disabled={off} onChange={onPick} />
      <span class="stack tight">
        <b>{name}</b>
        <span class="small soft">{text}</span>
        {look ? <span class="small ws-extras-parts">{look}</span> : null}
        {off ? <span class="small muted">{sperre}</span> : null}
      </span>
    </label>
  );
}

/** „Deine Auswahl“: what the build will have, with the pins (tngPins.ts). */
function Auswahl({ board, tasten, choice, pins, shutdown, name }: { board: string; tasten: string; choice: ExtrasChoice; pins: 'classic' | 'aio'; shutdown?: ShutdownKind; name?: string }) {
  const zusatz: [string, string | undefined][] = [];
  if (choice.speakerOff) zusatz.push(['Lautsprecher stumm', pins === 'classic' ? 'D6' : undefined]);
  if (choice.headphones) zusatz.push(['Kopfhörer-Erkennung', 'D8']);
  if (choice.chip && choice.chip !== 'standard') zusatz.push(['anderer MP3-Chip', undefined]);
  if (choice.alarm) zusatz.push(['Wecker-Start', 'A6']);
  if (choice.writeCard) zusatz.push(['Karten über USB', undefined]);
  return (
    <div class="card auswahl">
      <h2>Deine Auswahl</h2>
      <ul>
        <li>
          <i>Platine</i>
          <span>{board}</span>
        </li>
        <li>
          <i>Tasten</i>
          <span>{tasten}</span>
        </li>
        <li>
          <i>Knopf</i>
          {choice.knob ? (
            <span>
              {knopfName(choice.knob)} <span class="muted">{knopfPins(pins, choice.knob)}</span>
            </span>
          ) : (
            <span class="muted">keiner</span>
          )}
        </li>
        <li>
          <i>Licht</i>
          {choice.light ? (
            <span>
              {lichtName(choice.light)} <span class="muted">{lichtPins(pins, choice.light)}</span>
            </span>
          ) : (
            <span class="muted">keins</span>
          )}
        </li>
        {zusatz.map(([n, pin], i) => (
          <li key={n}>
            <i>{i === 0 ? 'Zusatz' : ''}</i>
            <span>
              {n} {pin ? <span class="muted">{pin}</span> : null}
            </span>
          </li>
        ))}
        {shutdown !== undefined || pins === 'classic' ? (
          <li class="nur-rechner">
            <i>Ausschalten</i>
            {shutdown ? <span>{SHUTDOWN_SHORT[shutdown]}</span> : <span class="muted">noch offen</span>}
          </li>
        ) : null}
        <li class="nur-rechner">
          <i>Verhalten</i>
          <span class="muted">kommt als Nächstes</span>
        </li>
      </ul>
      {name ? <p class="firmware-name nur-rechner">{name}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Verhalten */

export function VerhaltenSchirm({ s, board }: { s: WizardState; board: Stk500Board }) {
  const manifest = useBaukastenManifest();
  const build = useBaukastenBuild(board, manifest);
  const b = baukastenChoice(s);
  const box = knowledge();
  const keys = keyCount(s.variant);
  const invert = manifest && manifest !== 'failed' && (s.variant === '3' || s.variant === '5' || s.variant === '3x3') ? invertKind({ buttons: s.variant, version: manifest.tng.version, date: manifest.tng.date }) : undefined;
  const d: Draft = verhalten.value ?? draftFrom(box.values, invert);
  const setDraft = (patch: Partial<Draft>) => (verhalten.value = { ...d, ...patch });
  const fits = (c: ExtrasChoice) => !!b && !!manifest && manifest !== 'failed' && choiceStatus(manifest, b.board, b.buttons, c).kind === 'ok';
  const kontext = { board: board.id, prof: 'tng' as const, bau: b ? { choice: b.choice, fits, ownFile: false } : undefined };
  const weiterAn = s.extras?.preset === 'weiter';
  const setWeiter = (v: boolean | undefined) => {
    setDraft({ weiter: v });
    const now = session.wizard.value;
    set(chooseExtras(now, { ...(now.extras ?? {}), preset: v ? 'weiter' : 'standard' }));
  };
  // „Play ohne Karte“ answered on „Box einstellen“ comes into this build when it fits.
  useEffect(() => {
    const want = verhalten.peek()?.weiter;
    if (want === undefined || want === weiterAn || !b) return;
    if (want && !fits({ ...b.choice, preset: 'weiter' })) return;
    const now = session.wizard.value;
    set(chooseExtras(now, { ...(now.extras ?? {}), preset: want ? 'weiter' : 'standard' }));
  }, [manifest]);

  const visible = visibleParts('tng', keys, invert);
  const wish = wishOf(d, visible);
  const punkte = boxPunkte(wish);
  const next = nextStep(s);
  const teile = b ? firmwareTeile(b.choice) : [];

  return (
    <div class="schirm bk-schirm">
      <div class="arbeit">
        <section class="gross" aria-labelledby="bk-titel">
          {/* The same head as steps 1, 2 and 5: one page, one flow (Prüfrunde 1 Bastler 2). */}
          <div class="bk-kopf nur-rechner">
            <BackToWorkshop />
            <h1 id="bk-titel">Firmware aufspielen</h1>
          </div>
          <FirmwareSteps s={s} board={board} />
          <h2 class="vh-frage">So soll sich meine Box verhalten</h2>
          <p class="einleitung nur-rechner">
            Wähle einfach in Sätzen. Die App weiß, was davon <WoMarke wo="firmware" /> kommt und was du <WoMarke wo="box" /> einstellst.
          </p>
          <p class="einleitung nur-handy">Die App sortiert selbst: was in die Firmware kommt, was du an der Box einstellst.</p>
          <Saetze
            d={d}
            set={setDraft}
            kontext={kontext}
            visible={visible}
            values={box.values}
            keys={keys}
            invert={invert}
            weiter={{ value: d.weiter !== undefined || weiterAn ? weiterAn : undefined, onChange: setWeiter }}
          />
        </section>
        <aside class="spalte">
          <h2 class="nur-rechner">Was dafür passiert</h2>
          <div class="passiert nur-rechner">
            <div class="card block">
              <h2>
                <ZeichenFw /> 1. Firmware aufspielen
              </h2>
              <p>
                <FirmwareSatz teile={teile} weiter={weiterAn} />
              </p>
              <p class="klein">Per USB-Kabel, dauert etwa eine Minute.</p>
            </div>
            <div class="card block">
              <h2>
                <ZeichenBox /> 2. An der Box einstellen
              </h2>
              {punkte.length ? (
                <ol>
                  {punkte.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
              ) : (
                <p>Nichts. Wählst du links etwas, das an die Box gehört, steht es hier.</p>
              )}
              {punkte.length ? <p class="klein">Nach dem Aufspielen zeigt dir die App Schritt für Schritt, welche Tasten du drückst.</p> : null}
            </div>
          </div>
          {build.problem ? (
            <div class="ws-problem-box">
              <ProblemView compact problem={build.problem}>
                <Button icon={RotateCcw} onClick={build.retry}>
                  Noch einmal versuchen
                </Button>
              </ProblemView>
            </div>
          ) : null}
          <div class="unten">
            <p class="vh-danach nur-handy">
              Danach:{' '}
              <span class="marke-fw">
                <ZeichenFw />
                1× aufspielen
              </span>
              {punkte.length ? (
                <span class="marke-box">
                  <ZeichenBox />
                  {punkte.length}× an der Box
                </span>
              ) : null}
            </p>
            {build.busy ? (
              <p class="zeile-klein row tight">
                <Spinner size={14} /> Lege die Firmware bereit …
              </p>
            ) : (
              <p class="zeile-klein nur-rechner">Nichts davon musst du dir merken: Die App hebt es für diese Box auf.</p>
            )}
            <button type="button" class="btn primary xl wide" disabled={!next} onClick={() => next && set(goTo(session.wizard.value, next))}>
              Weiter: Aufspielen
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** „Mit Drehregler, Leuchtring und **Weitermachen**.“: what comes from „Verhalten“ in bold. */
function FirmwareSatz({ teile, weiter }: { teile: string[]; weiter: boolean }) {
  const alle = weiter ? [...teile, 'Weitermachen'] : teile;
  if (!alle.length) return <>{firmwareSatz([])}</>;
  const satz = firmwareSatz(alle);
  if (!weiter) return <>{satz}</>;
  const i = satz.lastIndexOf('Weitermachen');
  return (
    <>
      {satz.slice(0, i)}
      <b>Weitermachen</b>
      {satz.slice(i + 'Weitermachen'.length)}
    </>
  );
}

/** Re-export for the done page: the settings chosen under „Verhalten“ that wait for the box. */
export function wartendePunkte(prof: 'tng' | 'classic21', keys: 3 | 5 | undefined): string[] {
  const box = knowledge();
  const d = verhalten.value;
  if (!d) return [];
  return boxPunkte(wishOf(d, visibleParts(prof, keys, box.invert)));
}
