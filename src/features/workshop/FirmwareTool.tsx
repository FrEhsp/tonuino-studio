/**
 * Firmware aufspielen: board, buttons, firmware, upload. ESP32 boxes get a
 * guide for their update over Wi-Fi instead; boards the app cannot program
 * say why and what works instead. The rules live in wizard.ts, the running
 * upload in flashsession.ts; this file only shows them.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ArrowRight, Check, CircleCheck, CircleDot, Cpu, Download, ExternalLink, FileUp, Hand, History, RotateCcw, ScanSearch, Upload, Wifi, X } from 'lucide-preact';
import { FirmwareDownloadError, describeFlashError, describePortError, downloadFirmwareFile, type FlashProblem } from '../../core/firmware/flash';
import { toIntelHex } from '../../core/firmware/intelhex';
import {
  BOARDS,
  VARIANTS,
  askShutdown,
  firmwareFileName,
  getBoard,
  type BoardId,
  type BoardInfo,
  type ButtonVariant,
  type Esp32Board,
  type ShutdownKind,
  type Stk500Board,
} from '../../core/firmware/variants';
import { normalizeBoxAddress } from '../../core/tonuino/esp32';
import { Badge, Button, Callout, Progress, Spinner } from '../../ui/components/controls';
import { CommandLine, errorText } from '../../ui/components/Hints';
import { toast, toastError, toastSaved } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { noteBoxFirmware, plat, profile, setProfile, settings } from '../../app/state';
import { formatBytes } from '../../app/format';
import { DesktopAppLink } from '../help/DesktopAppLink';
import { Facts, NoSerial, TechDetails, ToolHeader } from './common';
import { probeBox } from './detect';
import { dateTime } from './logbook';
import { flashSession, type FlashRun, type SavedFirmware, type StartFlash } from './flashsession';
import { isBaukastenBoard } from '../../core/firmware/baukasten';
import { BaukastenSchirm, FirmwareSteps, SHUTDOWN_SHORT, VerhaltenSchirm, wartendePunkte } from './FirmwareBaukasten';
import { baukastenManifest } from './ExtrasPanel';
import { CHECKED_TNG, standTitle } from '../../core/firmware/tngstands';
import { logSession } from './logsession';
import { ExtrasLostButtons, KnownExtrasNote } from './ExtrasLost';
import { SettingsCheck } from './SettingsCheck';
import { PortPicker, usePorts } from './PortPicker';
import { ProblemView, offersAction } from './ProblemView';
import { suggestBoards } from './ports';
import {
  ASK_SHUTDOWN_FIRST,
  chooseBoard,
  chooseFirmware,
  chooseShutdown,
  chooseVariant,
  esp32Guide,
  firmwareLabel,
  firmwareVersion,
  flashHints,
  flashPhases,
  boxMayBeChanged,
  goTo,
  guessFromInfo,
  guessText,
  holdAgainFits,
  keepsText,
  acceptUnchecked,
  loadReadyMade,
  nextStep,
  nextSteps,
  percent,
  phaseIndex,
  previousStep,
  pickReadyMade,
  readOwnFirmware,
  readyMadeAllowed,
  shutdownAdvice,
  SHUTDOWN_CHOICES,
  sourceBlocker,
  successFacts,
  successTechnical,
  variantAdvice,
  variantsFor,
  versionFacts,
  versionText,
  uncheckedText,
  type NextStep,
  type WizardState,
  type WizardStep,
} from './wizard';
import { toDevice } from '../../app/device';
import { keyCount } from '../../core/tonuino/adminkeys';

const session = flashSession;

export function FirmwareTool() {
  const s = session.wizard.value;
  const run = session.run.value;
  const board = s.board ? getBoard(s.board) : undefined;
  // With a board of the Baukasten chosen, its manifest loads while the buttons are asked: „Extras“ then shows at once.
  const baukastenBoard = !!board && isBaukastenBoard(board.id);
  useEffect(() => {
    if (baukastenBoard) baukastenManifest().catch(() => undefined);
  }, [baukastenBoard]);

  // Classic and AiO: „Extras“ and „Verhalten“ are screens of 0.6 (FirmwareBaukasten.tsx).
  const schirmBoard = run.phase === 'idle' && board?.method === 'stk500' && isBaukastenBoard(board.id) && s.variant ? board : undefined;
  // While „Tasten“ is asked, „Extras“ is drawn ahead, hidden, when the browser has nothing else to do.
  // „Weiter“ then only shows it: the same elements, laid out and framed already (never slower than 0.5.1).
  const vorabFrage = !!schirmBoard && s.step === 'variant';
  const [vorab, setVorab] = useState(false);
  useEffect(() => {
    if (!vorabFrage || vorab) return;
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(() => setVorab(true), { timeout: 1500 });
      return () => cancelIdleCallback(id);
    }
    const id = window.setTimeout(() => setVorab(true), 300);
    return () => window.clearTimeout(id);
  }, [vorabFrage, vorab]);

  if (schirmBoard && s.step === 'verhalten') return <VerhaltenSchirm s={s} board={schirmBoard} />;
  if (schirmBoard && s.step === 'source')
    // The same place in the tree as the screen drawn ahead below, so it is kept and not drawn again.
    return (
      <>
        {null}
        <BaukastenSchirm key="extras" s={s} board={schirmBoard} />
      </>
    );
  const extrasVorab = schirmBoard && vorabFrage && vorab ? <BaukastenSchirm key="extras" s={{ ...s, step: 'source' }} board={schirmBoard} vorab /> : null;

  return (
    <>
      <div class="page narrow ws-page">
        <ToolHeader title="Firmware aufspielen" intro="Bringe die Software deiner Box auf den neuesten Stand. Schritt für Schritt." />
        <FirmwareSteps s={s} board={board} run={run.phase === 'done' ? 'done' : run.phase === 'idle' ? 'idle' : 'running'} />
        {/* On the board step always, so choosing a board does not move the page; the upload step says it itself. */}
        {!plat().capabilities.serial && run.phase === 'idle' && s.step !== 'flash' && (s.step === 'board' || board?.method !== 'esp32') ? (
          <NoSerial>
            <span>Boxen mit ESP32 bekommen ihre Firmware über WLAN, dafür brauchst du kein USB.</span>
          </NoSerial>
        ) : null}
        {run.phase === 'running' ? (
          <Running run={run} />
        ) : run.phase === 'done' ? (
          <Done run={run} />
        ) : run.phase === 'failed' ? (
          <Failed run={run} />
        ) : (
          <StepView s={s} board={board} />
        )}
      </div>
      {extrasVorab}
    </>
  );
}

/* --------------------------------------------------------------- steps */

const TITLES: Record<WizardStep, string> = {
  board: 'Welche Platine steckt in deiner Box?',
  variant: 'Wie viele Tasten hat deine Box?',
  source: 'Welche Firmware soll auf die Box?',
  verhalten: 'So soll sich meine Box verhalten',
  flash: 'Box anschließen und aufspielen',
};

function StepView({ s, board }: { s: WizardState; board: BoardInfo | undefined }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(s.step);
  // Moving to another step puts the focus on its question, so keyboards and screen readers follow.
  useEffect(() => {
    if (shown.current !== s.step) heading.current?.focus();
    shown.current = s.step;
  }, [s.step]);

  const esp32 = board?.method === 'esp32' ? board : undefined;
  const stk = board?.method === 'stk500' ? board : undefined;
  const title = s.step === 'source' && esp32 ? 'Update über WLAN' : TITLES[s.step];
  const prev = previousStep(s);
  const next = nextStep(s);
  // Why „Weiter“ is off, when the step says so (the source step's shutdown question).
  const [blocker, setBlocker] = useState<string | undefined>(undefined);
  const back = prev ? (
    <Button variant="ghost" icon={ArrowLeft} onClick={() => (session.wizard.value = goTo(s, prev))}>
      Zurück
    </Button>
  ) : null;

  let body: ComponentChildren = null;
  let primary: ComponentChildren = (
    <Button variant="primary" iconRight={ArrowRight} disabled={!next} onClick={() => next && (session.wizard.value = goTo(s, next))}>
      Weiter
    </Button>
  );
  if (s.step === 'board') body = <BoardStep s={s} />;
  else if (s.step === 'variant' && board) body = <VariantStep s={s} board={board} />;
  else if (s.step === 'source' && esp32 && s.variant) {
    body = <Esp32Step s={s} board={esp32} variant={s.variant} />;
    primary = null;
  } else if (s.step === 'source' && stk && s.variant) body = <SourceStep s={s} board={stk} variant={s.variant} onBlocker={setBlocker} />;
  else if (s.step === 'flash' && stk && s.firmware) return <FlashStep s={s} board={stk} heading={heading} back={back} />;

  return (
    <section class="card pad stack loose" aria-labelledby="ws-step-title">
      <h2 id="ws-step-title" ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {body}
      {/* „Weiter“ in view on every step, as on the last one (Prüfrunde 2, bastler 4). */}
      <div class="ws-nav ws-nav-fest">
        {back}
        <span class="spacer" />
        {blocker && !next && primary ? <span class="small muted">{blocker}</span> : null}
        {primary}
      </div>
    </section>
  );
}

function BoardStep({ s }: { s: WizardState }) {
  const serialOk = plat().capabilities.serial;
  const { ports } = usePorts(serialOk);
  const seen = useMemo(() => suggestBoards(ports).boards, [ports]);
  const board = s.board ? getBoard(s.board) : undefined;
  const known = session.guess.value;

  // What the box already told decides for the user; else a USB chip that only one board has (the AiO).
  useEffect(() => {
    if (session.wizard.value.board) return;
    const info = logSession.source.kind === 'live' ? logSession.book.info : undefined;
    const logged = info ? guessFromInfo(info) : undefined;
    if (logged?.board) session.useGuess(logged, 'logbook');
  }, []);
  useEffect(() => {
    if (!session.wizard.value.board && seen.length === 1) session.wizard.value = chooseBoard(session.wizard.value, seen[0]);
  }, [seen]);

  // The two boards that do not work yet: folded away, open only when one is chosen (audit 0.4 #18).
  const later = BOARDS.filter((b) => b.method === 'unsupported');
  const notesOf = (b: BoardInfo) => (
    <>
      {seen.includes(b.id) ? (
        <span class="ws-fit">
          <CircleCheck size={14} /> Passt zum eingesteckten Gerät
        </span>
      ) : null}
      {b.method === 'unsupported' ? <span class="choice-note">Geht noch nicht mit TonUINO Studio</span> : null}
      {b.method === 'esp32' ? <span class="choice-note">Update über WLAN</span> : null}
      {b.method === 'stk500' && !serialOk ? <span class="choice-note">Braucht USB</span> : null}
    </>
  );
  const pickOf = (b: BoardInfo) => () => (session.wizard.value = chooseBoard(session.wizard.value, b.id));
  // All boards as the same tiles, as in 0.3.1.
  const tile = (b: BoardInfo) => (
    <button type="button" role="radio" key={b.id} class="choice" aria-checked={s.board === b.id} onClick={pickOf(b)}>
      <span class="choice-icon" aria-hidden="true">
        {b.method === 'esp32' ? <Wifi size={20} /> : <Cpu size={20} />}
      </span>
      <span class="choice-title">{b.name}</span>
      <span class="choice-text">{b.description}</span>
      <span class="ws-chip">{b.mcu}</span>
      {notesOf(b)}
    </button>
  );

  return (
    <>
      {/* Asking the box comes first: whoever has it plugged in need not read eight boards (audit 0.4 #18). */}
      {serialOk ? <Recognize board={s.board} /> : null}
      <p class="soft">Die Platine ist das Herz der Box. Steht nichts drauf? Eine selbst gebaute Box hat meist einen Arduino Nano.</p>
      {/* What "Box erkennen" found is said next to its button. */}
      {known?.from === 'logbook' && known.guess.board && known.guess.board === s.board ? (
        <Callout tone="success">
          <span>
            Erkannt im Box-Logbuch: <b>{guessText(known.guess)}</b>. Stimmt das nicht, wähle unten die richtige Platine.
          </span>
        </Callout>
      ) : null}
      <div class="choices" role="radiogroup" aria-label="Platine">
        {BOARDS.filter((b) => b.method !== 'unsupported').map(tile)}
      </div>
      {later.length ? (
        <details class="ws-boards-later" open={later.some((b) => b.id === s.board)}>
          <summary class="link-button">Noch {later.length === 1 ? 'eine Platine' : `${later.length} Platinen`}, die noch nicht gehen</summary>
          <div class="choices" role="radiogroup" aria-label="Platinen, die noch nicht gehen">
            {later.map(tile)}
          </div>
        </details>
      ) : null}
      <p class="small soft">
        <b>AiO oder AiO+?</b> Auf der Platine steht eine Version: 1.x ist die AiO, 2.x die AiO+. Sie brauchen verschiedene Firmware.
      </p>
      {board?.method === 'unsupported' ? (
        <Callout tone="warning">
          <div class="stack tight">
            <b>{board.reason}</b>
            <span>{board.alternative}</span>
          </div>
        </Callout>
      ) : null}
    </>
  );
}

type ProbeState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'unnamed' } | { kind: 'silent' } | { kind: 'failed'; problem: FlashProblem };

/**
 * "Box erkennen": reads the start of the box, which names its board and
 * buttons. What it found lives in the session, so it is still said when the
 * user comes back to this step.
 */
function Recognize({ board }: { board?: BoardId }) {
  const [state, setState] = useState<ProbeState>({ kind: 'idle' });
  const probe = useRef<AbortController | null>(null);
  // Leaving the step frees the port at once, so the upload can open it.
  useEffect(() => () => probe.current?.abort(), []);
  const port = session.port.value;
  const busy = state.kind === 'busy';
  const known = session.guess.value;
  const found = known?.from === 'probe' && known.guess.board && known.guess.board === board ? known.guess : undefined;
  const recognize = async () => {
    if (!port) return;
    setState({ kind: 'busy' });
    const ctrl = new AbortController();
    probe.current = ctrl;
    // The Box-Logbuch may hold the port; the box is ours for a moment.
    await logSession.disconnect();
    try {
      const { info, heard } = await probeBox(plat().serial, port, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      const guess = guessFromInfo(info);
      if (info.firmware) void noteBoxFirmware(info).catch(() => undefined);
      if (guess.board) {
        session.useGuess(guess, 'probe');
        setState({ kind: 'idle' });
      } else setState({ kind: heard ? 'unnamed' : 'silent' });
    } catch (e) {
      if (!ctrl.signal.aborted) setState({ kind: 'failed', problem: describePortError(e, { os: plat().os, port }) });
    }
  };
  return (
    <section class="ws-recognize stack" aria-labelledby="ws-recognize-title">
      <h3 id="ws-recognize-title">Box schon angesteckt? Dann lasse sie selbst sagen, was in ihr steckt.</h3>
      <p class="small soft">Schalte die Box ein und stecke sie per USB-Kabel an. Beim Start nennt sie ihre Platine und ihre Tasten. Das klappt, wenn schon eine TonUINO-Firmware auf ihr läuft.</p>
      <PortPicker value={port?.id} onChange={(p) => (session.port.value = p)} disabled={busy} />
      <div class="row wrap">
        <Button icon={ScanSearch} loading={busy} disabled={!port} onClick={recognize}>
          Box erkennen
        </Button>
        {busy ? <span class="small muted">Lese den Start der Box …</span> : null}
      </div>
      <div aria-live="polite">
        {state.kind === 'idle' && found ? (
          <Callout tone="success">
            <span>
              Erkannt: <b>{guessText(found)}</b>. Das ist unten ausgewählt. Stimmt es, geht es mit „Weiter“ weiter.
            </span>
          </Callout>
        ) : state.kind === 'unnamed' ? (
          <Callout tone="warning">Die Box hat sich gemeldet, aber ihre Platine nicht genannt. Vielleicht läuft eine ältere oder eine selbst gebaute Firmware. Wähle die Platine dann selbst.</Callout>
        ) : state.kind === 'silent' ? (
          <Callout tone="warning">
            Die Box hat nichts gemeldet. Ist sie eingeschaltet? AiO und AiO+ brauchen dafür ihren Schalter oder die Play/Pause-Taste. Ist noch gar keine Firmware auf der Box, wähle die Platine selbst.
          </Callout>
        ) : state.kind === 'failed' ? (
          <div class="ws-problem-box">
            <ProblemView compact problem={state.problem} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

const VARIANT_MARKS: Record<ButtonVariant, string> = { '3': '3', '5': '5', '3x3': '3×3', '5f': '5+' };

function VariantStep({ s, board }: { s: WizardState; board: BoardInfo }) {
  const known = session.guess.value?.guess;
  const advice = variantAdvice(board, known?.board === board.id ? known.buttons : undefined);
  return (
    <>
      <p class="soft">Zähle die Tasten an deiner Box. Die Firmware muss dazu passen, sonst machen die Tasten das Falsche.</p>
      {advice ? <Callout tone="neutral">{advice}</Callout> : null}
      <div class="choices" role="radiogroup" aria-label="Tasten">
        {variantsFor(board).map((v) => (
          <button type="button" role="radio" key={v.id} class="choice" aria-checked={s.variant === v.id} onClick={() => (session.wizard.value = chooseVariant(session.wizard.value, v.id))}>
            <span class="choice-icon ws-variant-mark" aria-hidden="true">
              {VARIANT_MARKS[v.id]}
            </span>
            <span class="choice-title">{v.label}</span>
            <span class="choice-text">{v.description}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function SourceStep({ s, board, variant, onBlocker }: { s: WizardState; board: Stk500Board; variant: ButtonVariant; onBlocker: (reason: string | undefined) => void }) {
  const [kind, setKind] = useState<'download' | 'file' | null>(s.firmware?.kind === 'download' || s.firmware?.kind === 'file' ? s.firmware.kind : null);
  const blocker = sourceBlocker(board, kind, s.shutdown);
  useEffect(() => onBlocker(blocker), [blocker]);
  useEffect(() => () => onBlocker(undefined), []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<FlashProblem | null>(null);
  const loading = useRef<AbortController | null>(null);
  // Leaving the step stops a download nobody waits for anymore.
  useEffect(() => () => loading.current?.abort(), []);

  const fetchReadyMade = async () => {
    setKind('download');
    setProblem(null);
    // A file of your own chosen before must not stay behind the ready-made choice.
    session.wizard.value = pickReadyMade(session.wizard.value);
    // Boards that are asked how they switch off load the build only after a fitting answer.
    if (!readyMadeAllowed(board, session.wizard.value.shutdown)) return;
    const have = session.wizard.value.firmware;
    if (have?.kind === 'download' && have.board === board.id && have.variant === variant) return;
    session.wizard.value = chooseFirmware(session.wizard.value, undefined);
    loading.current?.abort();
    const ctrl = new AbortController();
    loading.current = ctrl;
    setBusy(true);
    try {
      // Classic and AiO have the Firmware-Baukasten (FirmwareBaukasten.tsx); the other boards download.
      const firmware = await loadReadyMade(plat().fetch, board, variant, ctrl.signal);
      if (!ctrl.signal.aborted) session.wizard.value = chooseFirmware(session.wizard.value, firmware);
    } catch (e) {
      if (!ctrl.signal.aborted) setProblem(e instanceof FirmwareDownloadError ? e.problem : describeFlashError(e, { board }));
    } finally {
      if (loading.current === ctrl) {
        loading.current = null;
        setBusy(false);
      }
    }
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
    loading.current?.abort();
    loading.current = null;
    setKind('file');
    setProblem(null);
    setBusy(true);
    const read = await readOwnFirmware(file, board);
    setBusy(false);
    if ('problem' in read) {
      session.wizard.value = chooseFirmware(session.wizard.value, undefined);
      setProblem(read.problem);
    } else {
      session.wizard.value = chooseFirmware(session.wizard.value, read.firmware);
    }
  };

  const answerShutdown = (shutdown: ShutdownKind) => {
    session.wizard.value = chooseShutdown(session.wizard.value, shutdown);
    if (kind !== 'download') return;
    if (readyMadeAllowed(board, shutdown)) void fetchReadyMade();
    else {
      loading.current?.abort();
      setProblem(null);
    }
  };

  const firmware = s.firmware;
  const shown = firmware && firmware.kind === kind ? firmware : undefined;
  const known = session.guess.value?.guess;
  const versions = shown ? versionFacts(firmwareVersion(shown.image), known?.board === board.id ? known.version : undefined) : undefined;
  const asked = kind === 'download' && askShutdown(board);
  const blocked = kind === 'download' && !readyMadeAllowed(board, s.shutdown);
  return (
    <>
      <div class="choices ws-two" role="radiogroup" aria-label="Firmware">
        <button type="button" role="radio" class="choice" aria-checked={kind === 'download'} onClick={fetchReadyMade}>
          <span class="choice-icon" aria-hidden="true">
            <Download size={20} />
          </span>
          <span class="choice-title row tight">
            Fertige Firmware <Badge tone="success">Für die meisten Boxen</Badge>
          </span>
          <span class="choice-text">{`Der neueste Stand von TonUINO TNG für „${board.shortName}“ mit ${VARIANTS[variant].label}. Er wird von der Seite des TNG-Teams geladen.`}</span>
        </button>
        <button type="button" role="radio" class="choice" aria-checked={kind === 'file'} onClick={pickFile}>
          <span class="choice-icon" aria-hidden="true">
            <FileUp size={20} />
          </span>
          <span class="choice-title">Eigene Datei</span>
          <span class="choice-text">Eine .hex-Datei, die du selbst gebaut oder aus dem Forum hast.</span>
        </button>
      </div>
      <KnownExtrasNote board={board.id} variant={variant} />
      {asked ? <ShutdownQuestion board={board} value={s.shutdown} onChange={answerShutdown} /> : null}
      <div aria-live="polite">
        {blocked ? null : busy ? (
          <p class="row soft">
            <Spinner size={16} /> {kind === 'file' ? 'Lese die Datei …' : 'Lade die Firmware …'}
          </p>
        ) : problem ? (
          <div class="ws-problem-box">
            <ProblemView compact problem={problem}>
              {kind === 'file' ? (
                <Button icon={FileUp} onClick={pickFile}>
                  Andere Datei wählen
                </Button>
              ) : (
                <Button icon={RotateCcw} onClick={fetchReadyMade}>
                  Noch einmal versuchen
                </Button>
              )}
            </ProblemView>
          </div>
        ) : shown ? (
          <div class="stack">
            <div class="ws-file">
              <CircleCheck size={22} aria-hidden="true" />
              <div class="stack tight grow">
                <span class="ws-file-name">{shown.fileName}</span>
                <span class="small muted">
                  {formatBytes(shown.image.byteCount)} Firmware ·{' '}
                  {shown.kind === 'download'
                    ? shown.baukasten
                      ? shown.baukasten.summary
                        ? `mit Extras: ${shown.baukasten.summary}`
                        : `${shown.baukasten.stand}, geprüft, in der App dabei`
                      : 'geladen von tonuino.github.io'
                    : 'eigene Datei'}
                </span>
                {shown.kind === 'download' && shown.baukasten ? <span class="small muted">Quelle: {shown.baukasten.source}</span> : null}
              </div>
              {shown.kind === 'file' ? (
                <button type="button" class="link-button" onClick={pickFile}>
                  Andere Datei
                </button>
              ) : null}
            </div>
            {versions?.facts.length ? <Facts facts={versions.facts} /> : null}
            {versions?.note ? <Callout tone="neutral">{versions.note}</Callout> : null}
            {shown.kind === 'download' && shown.unchecked ? <UncheckedNote unchecked={shown.unchecked} ok={!!s.uncheckedOk} /> : null}
          </div>
        ) : null}
      </div>
      {kind === 'download' && !blocked ? (
        <Callout tone="neutral">
          <div class="stack tight">
            <b>Gut zu wissen</b>
            <span>
              Die fertige Firmware passt zu Boxen, die nach Anleitung gebaut sind, auch mit Pololu-Schalter. Wurde deine Box beim Bauen angepasst, zum Beispiel mit anderem MP3-Chip, Drehregler oder LED-Ring, fehlt das danach. Dann frage, wer die Box gebaut hat, nach der passenden Datei und nimm „Eigene Datei“.
            </span>
            <span>Im Zweifel hilft die Sicherung: Vor dem Aufspielen sichere ich die alte Firmware. Fehlt danach etwas, spielst du sie einfach zurück.</span>
          </div>
        </Callout>
      ) : null}
    </>
  );
}

/**
 * A download from tonuino.github.io that is not the checked TNG state: said
 * plainly, and „Weiter“ only after a tick (canEnter, WizardState.uncheckedOk).
 */
function UncheckedNote({ unchecked, ok }: { unchecked: { version?: string; date?: string }; ok: boolean }) {
  const t = uncheckedText(unchecked);
  return (
    <Callout tone="warning">
      <div class="stack tight">
        <b>{t.title}</b>
        <span>{t.text}</span>
        <label class="row tight">
          <input type="checkbox" checked={ok} onChange={(e) => (session.wizard.value = acceptUnchecked(session.wizard.value, (e.currentTarget as HTMLInputElement).checked))} />
          <span>{t.confirm}</span>
        </label>
      </div>
    </Callout>
  );
}

/** ESP32 boxes get the file from tonuino.github.io, which always has the newest main (tngstands.ts). */
export const ESP32_STAND_NOTE = `Die Datei kommt von der Seite des TNG-Teams. Dort liegt immer der neueste Entwicklungsstand. Den hat TonUINO Studio nicht geprüft; geprüft ist ${standTitle(CHECKED_TNG)}.`;

/**
 * „Wie geht deine Box aus?“: the ready-made build drives the shutdown pin one
 * way, and CubieKid or carrier boards (on the Nano) or a Pololu switch (on
 * the WROOM) want it the other way. Says what follows from the answer.
 */
function ShutdownQuestion({ board, value, onChange }: { board: BoardInfo; value: ShutdownKind | undefined; onChange: (kind: ShutdownKind) => void }) {
  const advice = shutdownAdvice(board, value);
  return (
    <section class="stack" aria-labelledby="ws-shutdown-title">
      <h3 id="ws-shutdown-title">Wie geht deine Box aus?</h3>
      <div class="choices ws-two ws-shutdown" role="radiogroup" aria-labelledby="ws-shutdown-title">
        {SHUTDOWN_CHOICES.map((c) => (
          <button type="button" role="radio" key={c.id} class="choice" aria-checked={value === c.id} onClick={() => onChange(c.id)}>
            <span class="choice-title">{c.label}</span>
            {c.description ? <span class="choice-text">{c.description}</span> : null}
          </button>
        ))}
      </div>
      <div aria-live="polite">{advice ? <Callout tone={advice.tone}>{advice.text}</Callout> : null}</div>
    </section>
  );
}

function FlashStep({ s, board, heading, back }: { s: WizardState; board: Stk500Board; heading: { current: HTMLHeadingElement | null }; back: ComponentChildren }) {
  const firmware = s.firmware!;
  const serialOk = plat().capabilities.serial;
  const port = session.port.value;
  const backup = session.backupWanted.value;
  const saved = session.saved.value?.board === board.id ? session.saved.value : null;
  const known = session.guess.value?.guess;
  const [held, setHeld] = useState(false);
  const hints = flashHints(board, plat().os, port);
  const ready = serialOk && !!port && (!board.holdPlayPause || held);
  const request = (): Omit<StartFlash, 'firmware'> | undefined => (port ? { serial: plat().serial, port, board, os: plat().os } : undefined);
  const start = () => {
    const r = request();
    if (r && ready) void session.start({ ...r, firmware, backup });
  };
  const restore = () => {
    const r = request();
    if (r && ready) void session.restore(r);
  };
  if (!serialOk) {
    // No way on in this browser: say where it works instead of a form that cannot start.
    return (
      <section class="card pad stack loose" aria-labelledby="ws-step-title">
        <h2 id="ws-step-title" ref={heading} tabIndex={-1}>
          So kommt die Firmware auf die Box
        </h2>
        <Facts
          facts={[
            { label: 'Platine', value: board.name },
            ...(s.variant ? [{ label: 'Tasten', value: VARIANTS[s.variant].label }] : []),
            { label: 'Firmware', value: firmwareLabel(firmware) },
            ...(firmware.kind === 'download' && firmware.baukasten?.summary ? [{ label: 'Extras', value: firmware.baukasten.summary }] : []),
            // The answer to „Wie geht deine Box aus?“ belongs to the summary too (Prüfrunde 1 Bastler 3).
            ...(s.shutdown && askShutdown(board) ? [{ label: 'Ausschalten', value: SHUTDOWN_SHORT[s.shutdown] }] : []),
          ]}
        />
        <Callout tone="warning">
          <div class="stack tight">
            <b>Aufspielen geht nur über USB, und das kann dieser Browser nicht.</b>
            <span>Öffne TonUINO Studio dafür in Chrome, Edge oder Firefox ab Version 151 auf einem Computer, oder nimm die Desktop-App für Windows und Linux.</span>
            <span class="row wrap">
              <a href="#/hilfe/browser">Web-App oder Desktop-App?</a>
              <DesktopAppLink />
            </span>
          </div>
        </Callout>
        <div class="ws-nav">{back}</div>
      </section>
    );
  }
  return (
    <section class="card pad stack loose" aria-labelledby="ws-step-title">
      <h2 id="ws-step-title" ref={heading} tabIndex={-1}>
        {TITLES.flash}
      </h2>
      <Facts
        facts={[
          { label: 'Platine', value: board.name },
          ...(s.variant ? [{ label: 'Tasten', value: VARIANTS[s.variant].label }] : []),
          { label: 'Firmware', value: firmwareLabel(firmware) },
          ...(firmware.kind === 'download' && firmware.baukasten?.summary ? [{ label: 'Extras', value: firmware.baukasten.summary }] : []),
          ...(s.shutdown && askShutdown(board) ? [{ label: 'Ausschalten', value: SHUTDOWN_SHORT[s.shutdown] }] : []),
        ]}
      />
      {firmware.kind === 'download' && firmware.baukasten?.needsNewBootloader ? (
        <Callout tone="neutral">Diese Firmware braucht einen Nano mit neuem Startprogramm (Bootloader). Hat deiner das alte, sagt TonUINO Studio Bescheid, bevor etwas geschrieben wird.</Callout>
      ) : null}
      <p class="soft">{keepsText(known?.board === board.id ? known.version?.family : undefined)}</p>
      <div class="stack">
        <h3>Stecke die Box per USB-Kabel {toDevice()}</h3>
        {session.portGone.value ? (
          <Callout tone="warning">Die Box war kurz nicht mehr da und hat dabei einen neuen Anschluss bekommen. Wähle sie unten noch einmal aus und starte dann neu.</Callout>
        ) : null}
        <PortPicker board={board} value={port?.id} onChange={(p) => (session.port.value = p)} />
      </div>
      {board.holdPlayPause ? (
        <div class="ws-hold">
          <div class="ws-hold-icon" aria-hidden="true">
            <Hand size={24} />
          </div>
          <div class="stack tight">
            <h3>Halte Play/Pause gedrückt</h3>
            <p>
              Drücke die <span class="keycap key-pause">Play/Pause</span>-Taste, bevor du startest, und lasse sie erst los, wenn „Fertig“ erscheint. Sonst geht die Platine mittendrin aus.
            </p>
            <label class="ws-hold-check">
              <input type="checkbox" checked={held} onChange={(e) => setHeld((e.currentTarget as HTMLInputElement).checked)} />
              <span>Verstanden. Ich halte die Taste gedrückt.</span>
            </label>
          </div>
        </div>
      ) : null}
      <label class="ws-check">
        <input type="checkbox" checked={backup} onChange={(e) => (session.backupWanted.value = (e.currentTarget as HTMLInputElement).checked)} />
        <span class="stack tight">
          <b>Alte Firmware vorher sichern</b>
          <span class="small soft">Dauert ein paar Sekunden länger. Passt die neue Firmware nicht zu deiner Box, spielst du die alte wieder zurück.</span>
        </span>
      </label>
      {hints.length ? (
        <ul class="plain-steps small">
          {hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      ) : null}
      {saved ? <SavedBackup saved={saved} earlier onRestore={ready ? restore : undefined} /> : null}
      {/* Held at the bottom of the window, so „Firmware aufspielen“ is in view without scrolling (Prüfrunde 1 Bastler 3). */}
      <div class="ws-nav ws-nav-fest">
        {back}
        <span class="spacer" />
        {!ready ? (
          <span class="small muted">{!port ? 'Wähle zuerst den Anschluss der Box.' : 'Bestätige zuerst, dass du Play/Pause gedrückt hältst.'}</span>
        ) : null}
        <Button variant="primary" size="lg" icon={Upload} disabled={!ready} onClick={start}>
          Firmware aufspielen
        </Button>
      </div>
    </section>
  );
}

/**
 * The firmware saved before the last upload: keep it as a file, or put it
 * back. `earlier`: shown before the next upload, when another box may be
 * plugged in by now.
 */
function SavedBackup({ saved, onRestore, earlier }: { saved: SavedFirmware; onRestore?: () => void; earlier?: boolean }) {
  if (!saved.backup.data.length) {
    return <p class="small soft">Vor dem letzten Aufspielen war keine Firmware auf der Box. Es gibt nichts zum Zurückspielen.</p>;
  }
  const save = async () => {
    try {
      const blob = new Blob([toIntelHex(saved.backup.data, saved.backup.startAddress)], { type: 'text/plain' });
      if (await plat().files.save(saved.fileName, blob)) toastSaved('Sicherung gespeichert', 'Über „Eigene Datei“ spielst du sie später wieder auf.');
    } catch (e) {
      toastError('Das Speichern hat nicht geklappt', e);
    }
  };
  const version = firmwareVersion(saved.backup);
  return (
    <div class="ws-backup">
      <History size={20} aria-hidden="true" />
      <div class="stack tight grow">
        <b>{earlier ? 'Gesicherte Firmware vom letzten Aufspielen' : 'Die alte Firmware ist gesichert'}</b>
        <span class="small soft">
          {version ? `${versionText(version)}, ` : ''}gelesen am {dateTime(saved.at)} Uhr.{' '}
          {earlier
            ? 'Sie stammt von der Box, die du zuletzt bespielt hast. Spiele sie nur auf genau diese Box zurück.'
            : 'Speichere sie als Datei, dann bleibt sie auch nach dem Schließen der App.'}
        </span>
        <div class="row wrap">
          {onRestore ? (
            <Button size="sm" icon={RotateCcw} onClick={onRestore}>
              Alte Firmware wieder aufspielen
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon={Download} onClick={save}>
            Sicherung speichern
          </Button>
        </div>
      </div>
    </div>
  );
}

function Esp32Step({ s, board, variant }: { s: WizardState; board: Esp32Board; variant: ButtonVariant }) {
  const allowed = readyMadeAllowed(board, s.shutdown);
  // An answer the ready-made build does not fit: the steps are for the file from whoever built the box.
  const unfitting = !allowed && !!s.shutdown;
  const address = normalizeBoxAddress(settings.value.boxAddress);
  const guide = esp32Guide(board, unfitting ? null : firmwareFileName(board, variant), address);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<FlashProblem | null>(null);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const file = await downloadFirmwareFile(plat().fetch, board, variant);
      if (await plat().files.save(file.fileName, new Blob([file.bytes as BlobPart], { type: 'application/octet-stream' }))) {
        toastSaved('Firmware gespeichert', `Die Datei heißt „${file.fileName}“.`);
      }
    } catch (e) {
      setProblem(
        e instanceof FirmwareDownloadError
          ? e.problem
          : { code: 'unknown', title: 'Das Speichern hat nicht geklappt', explanation: errorText(e), steps: ['Versuche es noch einmal und wähle einen anderen Ordner.'] },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p class="soft">Boxen mit ESP32 haben eine eigene Webseite im WLAN. Darüber spielst du die neue Firmware auf, ganz ohne USB-Kabel.</p>
      <p class="small muted">{ESP32_STAND_NOTE}</p>
      {askShutdown(board) ? (
        <ShutdownQuestion board={board} value={s.shutdown} onChange={(kind) => (session.wizard.value = chooseShutdown(session.wizard.value, kind))} />
      ) : null}
      <ol class="ws-numbered">
        {guide.steps.map((step, i) => (
          <li key={step.text}>
            <div class="stack tight">
              <span>{step.text}</span>
              {i === 0 && !unfitting ? (
                <div class="row wrap">
                  <Button variant="primary" icon={Download} loading={busy} disabled={!allowed} onClick={save}>
                    Firmware herunterladen
                  </Button>
                  {!allowed ? <span class="small muted">{ASK_SHUTDOWN_FIRST}</span> : null}
                </div>
              ) : null}
              {step.link ? (
                <div>
                  <Button icon={ExternalLink} onClick={() => void plat().openExternal(step.link!.url)}>
                    {step.link.label}
                  </Button>
                </div>
              ) : null}
              {step.command ? <CommandLine command={step.command} /> : null}
            </div>
          </li>
        ))}
      </ol>
      {problem ? (
        <div class="ws-problem-box">
          <ProblemView compact problem={problem}>
            <Button icon={RotateCcw} onClick={save}>
              Noch einmal versuchen
            </Button>
          </ProblemView>
        </div>
      ) : null}
      <div class="stack">
        {guide.notes.map((n) => (
          <Callout tone="neutral" key={n.text}>
            <div class="stack tight">
              <span>{n.text}</span>
              {n.command ? <CommandLine command={n.command} /> : null}
            </div>
          </Callout>
        ))}
      </div>
      {/* The address is saved only where the app can talk to the box over Wi-Fi (desktop app). */}
      {!address && plat().capabilities.wifiBox ? <p class="small muted">Tipp: Speicherst du beim Karten-Beschreiben über WLAN die Adresse deiner Box, steht hier ein direkter Link zur Update-Seite.</p> : null}
    </>
  );
}

/* ------------------------------------------------------------ the upload */

type Running = Extract<FlashRun, { phase: 'running' }>;
type Done = Extract<FlashRun, { phase: 'done' }>;
type Failed = Extract<FlashRun, { phase: 'failed' }>;

function holdsPlayPause(board: BoardInfo): boolean {
  return board.method === 'stk500' && board.holdPlayPause;
}

function Running({ run }: { run: Running }) {
  const { status, request } = run;
  const backup = !!request.backup;
  const index = phaseIndex(status.step, backup);
  const value = percent(status);
  const restoring = request.firmware.kind === 'backup';
  return (
    <section class="card pad stack loose" aria-labelledby="ws-run-title">
      <div class="ws-progress">
        <h2 id="ws-run-title">{restoring ? 'Die alte Firmware wird wieder aufgespielt' : 'Die Firmware wird aufgespielt'}</h2>
        <span class="ws-percent" aria-hidden="true">
          {value} %
        </span>
        <Progress value={value} max={100} label="Fortschritt" />
        <p class="soft" role="status">
          {status.message}
        </p>
        <ol class="ws-phases" aria-label="Ablauf">
          {flashPhases(backup).map((p, i) => (
            <li key={p.id} class={i < index ? 'done' : ''} aria-current={i === index ? 'step' : undefined}>
              {i < index ? <CircleCheck size={15} /> : i === index ? <Spinner size={14} /> : <CircleDot size={15} />}
              {p.label}
            </li>
          ))}
        </ol>
      </div>
      {holdsPlayPause(request.board) ? (
        <div class="ws-hold compact">
          <div class="ws-hold-icon" aria-hidden="true">
            <Hand size={20} />
          </div>
          <b>Halte Play/Pause weiter gedrückt, bis „Fertig“ erscheint.</b>
        </div>
      ) : null}
      <Callout tone="warning">Ziehe das USB-Kabel nicht ab und schließe TonUINO Studio nicht, bis „Fertig“ erscheint.</Callout>
      <div class="row">
        <Button icon={X} onClick={() => session.cancel()}>
          Abbrechen
        </Button>
      </div>
    </section>
  );
}

function Done({ run }: { run: Done }) {
  const { result, request } = run;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const restored = request.firmware.kind === 'backup';
  // The box runs this firmware now: „Karten beschreiben“ takes it over (#29).
  useEffect(() => {
    const v = firmwareVersion(request.firmware.image);
    if (v) void noteBoxFirmware({ firmware: v.family, version: v.version, versionDate: v.date, board: request.board.id }).catch(() => undefined);
  }, [request]);
  const saved = session.saved.value?.board === request.board.id ? session.saved.value : null;
  const wizard = session.wizard.value;
  const shutdown = wizard.board === request.board.id ? wizard.shutdown : undefined;
  const backup = !!saved && !restored && saved.backup.data.length > 0;
  const einstellen = request.firmware.kind === 'download' && request.firmware.baukasten ? wartendePunkte(profile.value, keyCount(request.firmware.variant)) : [];
  const next = nextSteps(request.board, request.firmware, profile.value, { shutdown, backup, einstellen }).filter((n) => n.id !== 'release');
  return (
    <>
      <section class="card pad stack loose" aria-labelledby="ws-done-title">
        <div class="ws-done">
          <div class="done-icon" aria-hidden="true">
            <Check size={40} strokeWidth={2.6} />
          </div>
          <h2 id="ws-done-title" ref={heading} tabIndex={-1}>
            {restored ? 'Fertig! Die alte Firmware ist wieder auf der Box.' : 'Fertig! Die neue Firmware ist auf der Box.'}
          </h2>
          <p class="soft">
            {holdsPlayPause(request.board)
              ? `Du kannst Play/Pause jetzt loslassen. Die Box startet dann mit der ${restored ? 'alten' : 'neuen'} Firmware.`
              : `Die Box startet jetzt mit der ${restored ? 'alten' : 'neuen'} Firmware.`}
          </p>
          {restored ? null : <p class="soft small">{keepsText()}</p>}
        </div>
        <Facts facts={successFacts(result, request.board, request.firmware)} />
        <TechDetails text={successTechnical(result)} />
      </section>
      {request.board.method === 'stk500' && request.serial.supported ? <SettingsCheck serial={request.serial} port={request.port} board={request.board} auto={!holdsPlayPause(request.board)} /> : null}
      {saved && !restored ? <SavedBackup saved={saved} onRestore={() => void session.restore()} /> : null}
      <section class="stack" aria-labelledby="ws-next-title">
        <h2 id="ws-next-title" class="section-title">
          Wie geht es weiter?
        </h2>
        <div class="ws-next">
          {next.map((n) => (
            <NextItem key={n.id} step={n} />
          ))}
        </div>
      </section>
      <div class="row wrap">
        <Button variant="primary" icon={Upload} onClick={() => session.dismiss()}>
          Nächste Box bespielen
        </Button>
        <Button variant="ghost" onClick={() => session.reset()}>
          Andere Platine oder Firmware
        </Button>
      </div>
    </>
  );
}

function NextItem({ step }: { step: NextStep }) {
  let action: ComponentChildren = null;
  if (step.id === 'sounds') {
    action = (
      <Button size="sm" iconRight={ArrowRight} onClick={() => navigate({ page: 'workshop', tool: 'ansagen' })}>
        Zu den Systemansagen
      </Button>
    );
  } else if (step.id === 'logbook') {
    action = (
      <Button size="sm" iconRight={ArrowRight} onClick={() => navigate({ page: 'workshop', tool: 'logbuch' })}>
        Box-Logbuch öffnen
      </Button>
    );
  } else if (step.id === 'profile') {
    const switchProfile = async () => {
      try {
        await setProfile('tng');
        toast.success('Umgestellt auf TonUINO TNG');
      } catch (e) {
        toastError('Das Umstellen hat nicht geklappt', e);
      }
    };
    action = (
      <Button size="sm" onClick={switchProfile}>
        Auf TNG umstellen
      </Button>
    );
  } else if (step.link) {
    action = (
      <a class="btn sm" href={step.link.href}>
        {step.link.label}
        <ArrowRight size={16} strokeWidth={2.2} aria-hidden="true" />
      </a>
    );
  }
  return (
    <div class={step.id === 'power' ? 'ws-next-item ws-next-wide' : 'ws-next-item'}>
      <b>{step.title}</b>
      <span class="small soft">{step.text}</span>
      {step.note ? <span class="small soft">{step.note}</span> : null}
      {action}
    </div>
  );
}

function Failed({ run }: { run: Failed }) {
  const { problem, request } = run;
  const saved = session.saved.value?.board === request.board.id ? session.saved.value : null;
  const again = (patch: Partial<StartFlash> = {}) => void session.retry(patch);
  const backTo = (step: WizardStep) => {
    session.dismiss();
    session.wizard.value = goTo(session.wizard.value, step);
  };
  let buttons: ComponentChildren;
  if (problem.code === 'wrong-board') {
    buttons = (
      <Button variant="primary" icon={ArrowLeft} onClick={() => backTo('board')}>
        Platine ändern
      </Button>
    );
  } else if (problem.code === 'extras-lost') {
    buttons = (
      <ExtrasLostButtons
        wizard={session.wizard.value}
        setWizard={(w) => {
          session.dismiss();
          session.wizard.value = w;
        }}
        again={() => again({ skipExtrasCheck: true })}
        back={() => backTo('source')}
      />
    );
  } else if (problem.code === 'too-large' || problem.code === 'bad-image') {
    buttons = (
      <Button variant="primary" icon={ArrowLeft} onClick={() => backTo('source')}>
        Andere Firmware wählen
      </Button>
    );
  } else {
    buttons = (
      <>
        <Button variant={offersAction(problem) ? 'default' : 'primary'} icon={RotateCcw} onClick={() => again()}>
          {problem.code === 'aborted' ? 'Noch einmal aufspielen' : 'Noch einmal versuchen'}
        </Button>
        {problem.code === 'backup-failed' ? (
          <Button icon={Upload} onClick={() => again({ backup: false })}>
            Ohne Sicherung aufspielen
          </Button>
        ) : null}
        <Button variant="ghost" icon={ArrowLeft} onClick={() => backTo('flash')}>
          Zurück
        </Button>
      </>
    );
  }
  const holdNote = holdAgainFits(request.board, problem) ? (
    <div class="ws-hold compact">
      <div class="ws-hold-icon" aria-hidden="true">
        <Hand size={20} />
      </div>
      <b>Halte Play/Pause wieder gedrückt, bevor du es noch einmal versuchst.</b>
    </div>
  ) : null;
  return (
    <div class="stack loose">
      <ProblemView problem={problem} note={holdNote} onFlashAnyway={() => again({ ignoreUsbMismatch: true })}>
        {buttons}
      </ProblemView>
      {/* Nothing written yet: the old firmware is still on the box, only keeping it as a file makes sense. */}
      {saved && request.firmware.kind !== 'backup' ? <SavedBackup saved={saved} onRestore={boxMayBeChanged(problem) ? () => void session.restore() : undefined} /> : null}
    </div>
  );
}
