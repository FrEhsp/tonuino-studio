/**
 * Box-Logbuch: what the box reports over USB, line by line with German
 * explanations, plus a Steckbrief of the box and its problems at a glance.
 * The lines stay between visits; leaving the page frees the USB port, so
 * the firmware wizard can use it.
 */
import { signal } from '@preact/signals';
import { memo } from '../../ui/memo';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowDown, CircleAlert, Cpu, Download, FileText, FolderOpen, Hammer, Megaphone, Pause, Play, Plug, Power, RotateCcw, ScanLine, SlidersHorizontal, Trash, TriangleAlert, Unplug } from 'lucide-preact';
import type { BoxInfo, LineExplanation, LogIssue } from '../../core/firmware/bootlog';
import type { SerialPortInfo } from '../../platform/types';
import { Badge, Button, Callout, Progress, Segmented, Spinner } from '../../ui/components/controls';
import { toast, toastError, toastSaved } from '../../ui/components/Toast';
import { navigate, route } from '../../app/router';
import { card, plat } from '../../app/state';
import { openPackageDialog } from '../box/PackageDialog';
import { openRebuildDialog } from '../box/RebuildDialog';
import { plural } from '../../app/format';
import { boxFacts, hasBootFacts } from './boxfacts';
import { CopyButton, Facts, NoSerial, ToolHeader } from './common';
import { flashSession } from './flashsession';
import {
  clockTime,
  emptyLogText,
  entryLevel,
  exportText,
  forumText,
  isNearBottom,
  logFileName,
  pauseSnapshot,
  readLogFile,
  rebuildWay,
  visibleEntries,
  waitingLines,
  type LogEntry,
  type LogFilter,
  type PauseSnapshot,
} from './logbook';
import { keepsLogConnection, linkProblem, logSession, type LinkState } from './logsession';
import { PortPicker } from './PortPicker';
import { CloneHint } from './CloneHint';
import { ProblemView } from './ProblemView';
import { guessFromInfo } from './wizard';
import { toDevice, cardIntoDevice } from '../../app/device';

const filter = signal<LogFilter>('important');
/** While paused: the rows of that moment. They stay, even when the limit drops them from the logbook. */
const pause = signal<PauseSnapshot | null>(null);

export function LogbookTool() {
  const session = logSession;
  const link = session.link.value;
  // Read so the page follows new lines (the session bumps it, at most every 80 ms).
  void session.revision.value;
  const book = session.book;
  const loading = session.loading.value;
  const serialOk = plat().capabilities.serial;
  const live = link.kind === 'connected' || link.kind === 'connecting';
  // A pause belongs to the logbook it was taken from; a file or a new connection ends it.
  const paused = pause.value && pause.value.book === book ? pause.value : null;
  const shownEntries = paused ? paused.entries : book.entries;
  const rows = visibleEntries(shownEntries, filter.value);
  const lines = shownEntries.filter((e) => e.kind === 'line').length;
  const waiting = paused ? waitingLines(paused) : 0;

  // Leaving the page frees the port, except for the reader test, which reads the same connection. The lines stay. A file still being read is dropped.
  useEffect(
    () => () => {
      pause.value = null;
      logSession.cancelLoad();
      if (!keepsLogConnection(route.peek())) void logSession.disconnect();
    },
    [],
  );

  const meta = () => ({ at: Date.now(), source: session.sourceText(), dropped: book.dropped });

  const save = async () => {
    const m = meta();
    try {
      const blob = new Blob([exportText(book.entries, book.info, book.issues, m)], { type: 'text/plain' });
      if (await plat().files.save(logFileName(m.at), blob)) toastSaved('Logbuch gespeichert', 'Über „Logbuch-Datei öffnen“ siehst du es dir später wieder an.');
    } catch (e) {
      toastError('Das Speichern hat nicht geklappt', e);
    }
  };

  const openFile = async () => {
    let file;
    try {
      [file] = await plat().pickFiles({ extensions: ['txt', 'log'], multiple: false });
    } catch (e) {
      toastError('Die Dateiauswahl ging nicht auf', e);
      return;
    }
    if (!file) return;
    const read = await readLogFile(file);
    if ('error' in read) {
      toast.error('Die Datei passt nicht', read.error);
      return;
    }
    const wasLive = session.connected;
    if (!(await session.openFile(file.name, read.text))) return;
    pause.value = null;
    if (wasLive) toast.info('Verbindung getrennt', 'Jetzt siehst du die Datei. Zum Mitlesen verbinde die Box neu.');
  };

  const restart = async () => {
    try {
      await session.restartBox();
    } catch (e) {
      toastError('Der Neustart hat nicht geklappt', e);
    }
  };

  const clear = () => {
    pause.value = null;
    session.clear();
  };

  const togglePause = () => (pause.value = paused ? null : pauseSnapshot(book));

  let count = !lines
    ? 'Noch keine Zeilen'
    : filter.value === 'important'
      ? `${rows.filter((e) => e.kind === 'line').length} wichtige von ${plural(lines, 'Zeile', 'Zeilen')}`
      : plural(lines, 'Zeile', 'Zeilen');
  if (book.dropped) count += ` · ${plural(book.dropped, 'ältere Zeile', 'ältere Zeilen')} nicht mehr in der Liste`;
  const empty = emptyLogText({ shown: shownEntries, filter: filter.value, paused: !!paused, live, canConnect: serialOk });

  return (
    <div class="page ws-page">
      <ToolHeader title="Box-Logbuch" intro="Hier siehst du, was die Box über USB meldet. Wichtige Zeilen sind erklärt, mit Tipps zur Lösung." />
      {!serialOk ? (
        <NoSerial>
          <span>Gespeicherte Logbuch-Dateien kannst du trotzdem öffnen.</span>
        </NoSerial>
      ) : null}
      <div class="ws-log-layout">
        <div class="stack loose" style={{ minWidth: 0 }}>
          {serialOk && link.kind !== 'connected' ? <ConnectCard link={link} /> : null}
          <section class="card ws-log-card" aria-label="Meldungen der Box">
            <div class="ws-log-toolbar">
              <LinkPill link={link} file={session.source.kind === 'file' ? session.source.name : undefined} />
              {link.kind === 'connected' ? (
                <Button size="sm" icon={RotateCcw} onClick={restart}>
                  Box neu starten
                </Button>
              ) : null}
              {/* Also after the connection ended: a pause must never get stuck. */}
              {link.kind === 'connected' || paused ? (
                <Button size="sm" icon={paused ? Play : Pause} onClick={togglePause}>
                  {paused ? 'Weiter' : 'Pause'}
                </Button>
              ) : null}
              {link.kind === 'connected' ? (
                <Button size="sm" variant="ghost" icon={Unplug} onClick={() => void session.disconnect()}>
                  Trennen
                </Button>
              ) : null}
              <span class="spacer" />
              <Segmented
                label="Welche Zeilen"
                value={filter.value}
                onChange={(v) => (filter.value = v)}
                options={[
                  { value: 'important', label: 'Nur Wichtiges' },
                  { value: 'all', label: 'Alles' },
                ]}
              />
            </div>
            {loading ? (
              <div class="ws-log-loading" role="status">
                <div class="row">
                  <Spinner size={16} />
                  <span class="grow">
                    Lese „{loading.name}“ … {Math.round(loading.progress * 100)} %
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => session.cancelLoad()}>
                    Abbrechen
                  </Button>
                </div>
                <Progress value={loading.progress} label="Datei wird gelesen" />
              </div>
            ) : null}
            {paused ? (
              <div class="ws-log-paused" role="status">
                <Pause size={15} /> Angehalten.{' '}
                {waiting ? `${plural(waiting, 'neue Zeile wartet', 'neue Zeilen warten')}.` : live ? 'Neue Zeilen werden weiter gesammelt.' : 'Klicke auf „Weiter“, dann siehst du wieder alle Zeilen.'}
              </div>
            ) : null}
            {/* Only the app's own notes so far (connected, the question about writing cards): the box itself is silent, so the hint stays. */}
            <LogList rows={rows} empty={empty} hint={live && !lines && !paused ? empty : undefined} />
            <div class="ws-log-foot">
              <span class="muted">{count}</span>
              {link.kind === 'connected' ? <span class="muted">Verlässt du Box-Logbuch und Box testen, trenne ich die Verbindung.</span> : null}
              <span class="spacer" />
              <Button size="sm" variant="ghost" icon={Trash} disabled={!book.entries.length} onClick={clear}>
                Leeren
              </Button>
              <Button size="sm" variant="ghost" icon={Download} disabled={!lines} onClick={save}>
                Speichern
              </Button>
              <CopyButton
                variant="ghost"
                label="Fürs Forum kopieren"
                disabled={!lines}
                fallback="Speichere das Logbuch stattdessen und hänge die Datei im Forum an."
                text={() => forumText(book.entries, book.info, book.issues, meta())}
              />
              <Button size="sm" variant="ghost" icon={FolderOpen} disabled={!!loading} onClick={openFile}>
                Logbuch-Datei öffnen
              </Button>
            </div>
          </section>
        </div>
        <aside class="ws-side" aria-label="Was die Box verrät">
          <Steckbrief info={book.info} live={link.kind === 'connected'} canConnect={serialOk} fromFile={session.source.kind === 'file'} onRestart={restart} />
          <Issues issues={book.issues} known={hasBootFacts(book.info)} />
          <CloneHint info={book.info} />
          {serialOk ? (
            <a class="link-button" href="#/werkstatt/kartenleser">
              <ScanLine size={16} strokeWidth={2.2} /> Karten werden nicht gelesen? Kartenleser testen
            </a>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function LinkPill({ link, file }: { link: LinkState; file?: string }) {
  if (file && link.kind !== 'connected' && link.kind !== 'connecting') {
    return (
      <span class="ws-link" title={file}>
        <FileText size={14} /> Datei: {file}
      </span>
    );
  }
  switch (link.kind) {
    case 'connected':
      return (
        <span class="ws-link on" title={link.port.label}>
          <span class="dot" /> Verbunden
        </span>
      );
    case 'connecting':
      return (
        <span class="ws-link">
          <Spinner size={12} /> Verbinde …
        </span>
      );
    case 'lost':
      return (
        <span class="ws-link lost">
          <span class="dot" /> Verbindung weg
        </span>
      );
    default:
      return (
        <span class="ws-link">
          <span class="dot" /> Nicht verbunden
        </span>
      );
  }
}

/** Port choice and connect button; the reader test uses it, too. */
/** `bare`: without its title and the sentence about plugging in, under a step that already says it (Box testen). */
export function ConnectCard({ link, bare = false }: { link: LinkState; bare?: boolean }) {
  const session = logSession;
  const [port, setPort] = useState<SerialPortInfo | undefined>(session.lastPort);
  const connecting = link.kind === 'connecting';
  const lost = link.kind === 'lost';
  // An upload that keeps running in the background holds the port; opening it would only fail as "in use by another program".
  const flashing = flashSession.run.value.phase === 'running';
  const connect = () => {
    if (port && !flashing) void session.connect(plat().serial, port);
  };
  return (
    <section class={bare ? 'stack' : 'card pad stack'} aria-labelledby={bare ? undefined : 'ws-connect-title'} aria-label={bare ? 'Box verbinden' : undefined}>
      {bare ? null : (
        <h2 id="ws-connect-title" class="ws-card-title">
          {lost ? 'Die Verbindung zur Box ist weg' : 'Box verbinden'}
        </h2>
      )}
      {lost ? (
        <p>Wurde das USB-Kabel abgezogen oder die Box ausgeschaltet? Stecke sie wieder an und schalte sie ein, dann verbinde sie neu.</p>
      ) : bare ? null : (
        <p class="soft">Stecke die Box per USB-Kabel {toDevice()} und wähle sie aus. Beim Verbinden startet die Box meist neu. So siehst du ihren Start von Anfang an.</p>
      )}
      {link.kind === 'error' ? (
        <div class="ws-problem-box" role="alert">
          <ProblemView compact problem={linkProblem(link, plat().os)} />
        </div>
      ) : null}
      {flashing ? (
        <Callout>
          <div class="stack tight">
            <span>Gerade wird neue Firmware aufgespielt. Wenn sie fertig ist, kannst du die Box hier verbinden.</span>
            <a class="link-button" href="#/werkstatt/firmware">
              Fortschritt ansehen
            </a>
          </div>
        </Callout>
      ) : (
        <>
          <PortPicker value={port?.id} onChange={setPort} onChosen={(p) => void session.connect(plat().serial, p)} disabled={connecting} />
          {/* Without a port the picker's own "Box verbinden …" is the one next step; a dead button beside it only confuses. */}
          {port ? (
            <div class="row wrap">
              <Button variant="primary" icon={Plug} loading={connecting} onClick={connect}>
                {lost ? 'Neu verbinden' : 'Verbinden'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function LogList({ rows, empty, hint }: { rows: LogEntry[]; empty: string; hint?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const lastId = rows.length ? rows[rows.length - 1].id : 0;

  // New lines scroll into view, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lastId, rows.length, follow]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const near = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    if (near !== follow) setFollow(near);
  };

  return (
    <div class="ws-log-wrap">
      <div class={rows.length ? 'ws-log' : 'ws-log ws-log-none'} ref={box} onScroll={onScroll} role="log" aria-live="off" aria-label="Meldungen der Box" tabIndex={0}>
        {rows.length ? (
          <>
            {rows.map((e) => (
              <Row key={e.id} entry={e} />
            ))}
            {hint ? <p class="ws-log-hint">{hint}</p> : null}
          </>
        ) : (
          <div class="ws-log-empty">{empty}</div>
        )}
      </div>
      {!follow && rows.length ? (
        <Button
          class="ws-jump"
          size="sm"
          variant="primary"
          icon={ArrowDown}
          onClick={() => {
            setFollow(true);
          }}
        >
          Zu den neuesten Zeilen
        </Button>
      ) : null}
    </div>
  );
}

const LEVEL_LABEL = { error: 'Fehler', warn: 'Achtung', info: 'Info' } as const;
const LEVEL_TONE = { error: 'danger', warn: 'warning', info: undefined } as const;

/** One entry; memoized because entries never change once added. */
const Row = memo(function Row({ entry: e }: { entry: LogEntry }) {
  const level = entryLevel(e);
  const x = e.explanation;
  const stamp = e.time !== undefined ? clockTime(e.time) : e.lineNo !== undefined ? `Z. ${e.lineNo}` : '';
  const cls = ['ws-row', e.kind, level === 'warn' || level === 'error' ? level : '', x ? 'explained' : ''].filter(Boolean).join(' ');
  return (
    <div class={cls}>
      <span class="ws-row-time">{stamp}</span>
      {x && x.level === 'info' ? (
        // Plain news ("Karte aufgelegt") stays short: title and sentence in one flow.
        <div class="stack tight">
          <p class="ws-row-info">
            <Badge>{LEVEL_LABEL.info}</Badge> <b>{x.title}</b> <span class="ws-row-text">{x.explanation}</span>
          </p>
          <code class="ws-row-raw">{e.text}</code>
        </div>
      ) : x ? (
        <div class="stack tight">
          <div class="ws-row-title">
            <Badge tone={LEVEL_TONE[x.level]}>{LEVEL_LABEL[x.level]}</Badge>
            {x.title}
          </div>
          <div class="ws-row-text">{x.explanation}</div>
          {x.fix ? (
            <div class="ws-row-fix">
              <b>Tipp:</b> {x.fix}
            </div>
          ) : null}
          <FixButton explanation={x} />
          <code class="ws-row-raw">{e.text}</code>
        </div>
      ) : e.kind === 'line' ? (
        <code class="ws-row-raw">{e.text}</code>
      ) : (
        <span class="ws-row-raw">
          {e.kind === 'boot' ? <Power size={14} aria-hidden="true" /> : null} {e.text}
        </span>
      )}
    </div>
  );
});

function Steckbrief({ info, live, canConnect, fromFile, onRestart }: { info: BoxInfo; live: boolean; canConnect: boolean; fromFile: boolean; onRestart: () => void }) {
  const facts = boxFacts(info);
  // The way to a Steckbrief from here. Without USB in this browser, only a saved file has one.
  const connectHint = canConnect ? ' Verbinde die Box, dann siehst du ihren Start.' : '';
  const nextStep = live
    ? ''
    : fromFile
      ? ` In dieser Logbuch-Datei steht dazu nichts.${connectHint}`
      : connectHint || ' Öffne eine gespeicherte Logbuch-Datei, dann steht hier, was die Box beim Start gemeldet hat.';
  // The wizard starts with what the box told: board, buttons and version.
  const toFirmware = () => {
    flashSession.useGuess(guessFromInfo(info), 'logbook', true);
    navigate({ page: 'workshop', tool: 'firmware' });
  };
  return (
    <section class="card" aria-labelledby="ws-facts-title">
      <div class="card-header">
        <h2 id="ws-facts-title">Steckbrief der Box</h2>
      </div>
      <div class="card-body stack">
        {hasBootFacts(info) ? (
          <>
            <Facts facts={facts.box} />
            {facts.settings.length ? (
              <>
                <h3 class="section-title">Einstellungen</h3>
                <Facts facts={facts.settings} />
              </>
            ) : null}
            {info.board && !fromFile ? (
              <div>
                <Button size="sm" icon={Cpu} onClick={toFirmware}>
                  Firmware aufspielen
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p class="soft small">
              Noch nichts bekannt. Beim Start meldet die Box, was in ihr steckt: Firmware, Platine, Kartenleser und MP3-Player.
              {nextStep}
            </p>
            {live ? (
              <div>
                <Button size="sm" icon={RotateCcw} onClick={onRestart}>
                  Box neu starten
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function Issues({ issues, known }: { issues: LogIssue[]; known: boolean }) {
  const errors = issues.filter((i) => i.explanation.level === 'error').length;
  return (
    <section class="card" aria-labelledby="ws-issues-title">
      <div class="card-header">
        <h2 id="ws-issues-title">Auffälligkeiten</h2>
        {issues.length ? (
          <span class="ws-issue-count">
            <Badge tone={errors ? 'danger' : 'warning'}>{issues.length}</Badge>
          </span>
        ) : null}
      </div>
      {issues.length ? (
        <div class="ws-issues">
          {issues.map((i) => {
            const x = i.explanation;
            const error = x.level === 'error';
            return (
              <div class={`issue ${error ? 'error' : 'warning'}`} key={x.id}>
                <span class="issue-icon" aria-hidden="true">
                  {error ? <CircleAlert size={18} /> : <TriangleAlert size={18} />}
                </span>
                <div class="stack tight">
                  <b>
                    <span class="visually-hidden">{error ? 'Fehler: ' : 'Achtung: '}</span>
                    {x.title}
                    {i.count > 1 ? ` (${i.count}×)` : ''}
                  </b>
                  <span class="small soft">{x.explanation}</span>
                  {x.fix ? (
                    <span class="small">
                      <b>Tipp:</b> {x.fix}
                    </span>
                  ) : null}
                  <FixButton explanation={x} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div class="card-body">
          <p class="soft small">{known ? 'Keine. Die Box hat beim Start keine Fehler gemeldet.' : 'Noch keine. Fehler und Warnungen der Box landen hier, nach Art sortiert.'}</p>
        </div>
      )}
    </section>
  );
}

/** The fix as a button, when a tool of the app carries it out. */
function FixButton({ explanation }: { explanation: LineExplanation }) {
  if (explanation.fixIn === 'settings') {
    return (
      <div>
        <Button size="sm" icon={SlidersHorizontal} onClick={() => navigate({ page: 'workshop', tool: 'einstellen' })}>
          Box einstellen
        </Button>
      </div>
    );
  }
  if (explanation.fixIn === 'rebuild') return <RebuildButton />;
  if (explanation.fixIn !== 'sounds') return null;
  return (
    <div>
      <Button size="sm" icon={Megaphone} onClick={() => navigate({ page: 'workshop', tool: 'ansagen' })}>
        Systemansagen erneuern
      </Button>
    </div>
  );
}

/**
 * The rebuild of the SD card the app has open, like on "Meine Box". Without an
 * open card it says, right here and until the card is open, how to get there.
 */
function RebuildButton() {
  const [needCard, setNeedCard] = useState(false);
  const way = rebuildWay(card.value);
  const start = () => {
    if (way === 'rebuild') openRebuildDialog('rebuild');
    else if (way === 'package') openPackageDialog('choose');
    else setNeedCard(true);
  };
  return (
    <div class="stack tight">
      <div>
        <Button size="sm" icon={Hammer} onClick={start}>
          Karte neu aufbauen …
        </Button>
      </div>
      {needCard && way === 'open-card' ? (
        <Callout tone="info">
          <div class="stack tight">
            <span>
              <strong>Erst die SD-Karte auswählen.</strong> Nimm die SD-Karte aus der Box, stecke sie {cardIntoDevice()} und wähle sie unter „Meine Box“ aus. Dort findest du dann „Karte neu aufbauen“.
            </span>
            <div>
              <Button size="sm" onClick={() => navigate({ page: 'box' })}>
                Zu Meine Box
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}
    </div>
  );
}
