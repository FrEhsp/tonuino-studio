/**
 * Kartenleser testen: a guided test of the card reader in the box. It uses
 * the connection of the Box-Logbuch (same port, same lines), checks the
 * reader at the start of the box and then counts per card how often the box
 * read it. The logic lives in readertest.ts; this page feeds it lines, time
 * and clicks. The result stays while the app is open, so a trip to the help
 * and back keeps it. Leaving the page frees the USB port.
 */
import '../../ui/styles/readertest.css';
import { effect, signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, Ref } from 'preact';
import { ArrowRight, CircleAlert, CircleCheck, Info, NotebookText, Play, RotateCcw, TriangleAlert, X } from 'lucide-preact';
import { Button, Callout, Field, Progress, Spinner, Steps } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { plat } from '../../app/state';
import { route } from '../../app/router';
import { hasBootFacts } from './boxfacts';
import { BoxTestHeader, CopyButton, NoSerial } from './common';
import { ConnectCard } from './LogbookTool';
import { keepsLogConnection, logSession } from './logsession';
import {
  ReaderTest,
  cardLabel,
  cardStats,
  cardTypeText,
  cardVerdict,
  failureText,
  overallVerdict,
  rateText,
  readerChipNote,
  readerText,
  resultOf,
  resultText,
  type Advice,
  type CardResult,
  type RoundOutcome,
  type Tone,
} from './readertest';

/** The test of this app session; "Noch einmal testen" starts a new one. */
const test = signal(new ReaderTest());
/** Bumped whenever the test changed. */
const rev = signal(0);
/** The name typed for the next card. */
const nameDraft = signal('');

function bump() {
  rev.value++;
}

const STEPS = ['Box verbinden', 'Kartenleser prüfen', 'Karten testen', 'Ergebnis'];
/** The result without a single card tested (e.g. a reader that does not answer): no step claims cards were tested. */
const STEPS_NO_CARDS = ['Box verbinden', 'Kartenleser prüfen', 'Ergebnis'];

/** Feeds the lines of the Box-Logbuch connection and the clock into the test while the page is open. */
function useFeed() {
  useEffect(() => {
    let book = logSession.book;
    let lastId = book.entries.length ? book.entries[book.entries.length - 1].id : 0;
    let linked = logSession.link.peek().kind === 'connected';
    if (linked) {
      // Opened on a live connection: the start of the box may have passed already.
      const t = test.peek();
      t.connected(Date.now());
      if (hasBootFacts(book.info)) t.seed(book.info);
      bump();
    }
    const stopLink = effect(() => {
      const now = logSession.link.value.kind === 'connected';
      if (now === linked) return;
      linked = now;
      if (now) test.peek().connected(Date.now());
      else test.peek().disconnected();
      bump();
    });
    const stopLines = effect(() => {
      void logSession.revision.value;
      const b = logSession.book;
      if (b !== book) {
        book = b;
        lastId = 0;
      }
      const entries = b.entries;
      let i = entries.length;
      while (i > 0 && entries[i - 1].id > lastId) i--;
      let changed = false;
      const t = test.peek();
      for (; i < entries.length; i++) {
        const e = entries[i];
        lastId = e.id;
        if (e.kind === 'line' && t.observe(e.text, e.time ?? Date.now())) changed = true;
      }
      if (changed) bump();
    });
    const timer = setInterval(() => {
      const t = test.peek();
      const changed = t.tick(Date.now());
      // Countdowns move on their own.
      if (changed || t.remaining(Date.now()) !== undefined || t.phase.kind === 'reader-check') bump();
    }, 200);
    return () => {
      stopLink();
      stopLines();
      clearInterval(timer);
      test.peek().disconnected();
      bump();
      // Frees the port for the firmware wizard, like the Box-Logbuch; going over to the Box-Logbuch keeps it.
      if (!keepsLogConnection(route.peek())) void logSession.disconnect();
    };
  }, []);
}

async function restartBox() {
  test.peek().restartRequested(Date.now());
  bump();
  try {
    await logSession.restartBox();
  } catch (e) {
    toastError('Der Neustart hat nicht geklappt', e);
  }
}

/** Starts a new test; on a live connection it begins with the reader again. */
function newTest() {
  const t = new ReaderTest();
  if (logSession.link.peek().kind === 'connected') {
    t.connected(Date.now());
    const info = logSession.book.info;
    if (hasBootFacts(info)) t.seed(info);
  }
  test.value = t;
  nameDraft.value = '';
  bump();
}

export function ReaderTestTool() {
  void rev.value;
  const t = test.value;
  const link = logSession.link.value;
  const serialOk = plat().capabilities.serial;
  useFeed();

  const header = (
    <BoxTestHeader current="kartenleser">Finde heraus, ob die Box deine Karten zuverlässig liest. Und wenn nicht: ob es an einer Karte, am Kartentyp oder am Kartenleser in der Box liegt.</BoxTestHeader>
  );
  if (!serialOk) {
    return (
      <div class="page narrow ws-page">
        {header}
        <NoSerial>
          <span>
            Was der Test macht, steht in der Hilfe unter <a href="#/hilfe/kartenleser-testen">Box testen: Kartenleser</a>.
          </span>
        </NoSerial>
      </div>
    );
  }

  const p = t.phase;
  const live = link.kind === 'connected';
  const noCards = p.kind === 'results' && !t.cards.length;
  const step = p.kind === 'results' ? (noCards ? 2 : 3) : !live || p.kind === 'connect' ? 0 : p.kind.startsWith('reader') ? 1 : 2;
  let body: ComponentChildren;
  if (p.kind === 'results') body = <Results t={t} />;
  else if (!live) body = <Connect t={t} />;
  else if (p.kind === 'reader-check' || p.kind === 'connect') body = <ReaderChecking />;
  else if (p.kind === 'reader-missed') body = <ReaderMissed t={t} />;
  else if (p.kind === 'reader-done') body = <ReaderDone t={t} />;
  else if (p.kind === 'card-ready') body = <CardReady t={t} index={p.card} />;
  else if (p.kind === 'card-done') body = <CardDone t={t} index={p.card} />;
  else body = <Round t={t} />;

  // Cards tested before, without the one on screen right now: a card being tested or just finished has its own panel.
  const shown = 'card' in p ? p.card : -1;
  const earlier = p.kind === 'results' ? [] : t.cards.map((_, i) => i).filter((i) => i !== shown);

  return (
    <div class="page narrow ws-page">
      {header}
      <div class="ws-steps">
        <Steps steps={noCards ? STEPS_NO_CARDS : STEPS} active={step} />
      </div>
      {t.poweredOff && live && p.kind !== 'results' ? <PoweredOff /> : null}
      {body}
      {earlier.length ? <CardList t={t} title="Bisher getestet" only={earlier} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ steps */

/** The box switched itself off (standby timer, sleep timer, a long press or a low battery): it reads no card until it is on again. */
function PoweredOff() {
  return (
    <Callout tone="warning">
      <div class="stack tight">
        <span>
          Die Box hat sich ausgeschaltet, etwa durch ihren Ausschalt-Timer. So liest sie keine Karte. Schalte sie wieder ein oder starte sie neu. Dann teste die Karte noch einmal.
        </span>
        <div>
          <Button size="sm" icon={RotateCcw} onClick={() => void restartBox()}>
            Box neu starten
          </Button>
        </div>
      </div>
    </Callout>
  );
}

/** Moves focus to a step's heading when the step appears, so keyboards and screen readers land there. */
function useFocusHeading() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

function Connect({ t }: { t: ReaderTest }) {
  const link = logSession.link.value;
  const fresh = t.phase.kind === 'connect' && !t.cards.length;
  return (
    <div class="stack loose">
      {fresh ? (
        <section class="card pad stack" aria-labelledby="rt-how">
          <h2 id="rt-how" class="ws-card-title">
            So geht der Test
          </h2>
          <ol class="ws-numbered">
            <li>Du verbindest die Box per USB. Beim Start meldet sie, ob ihr Kartenleser antwortet.</li>
            <li>Dann legst du jede Karte {t.rounds}-mal auf die Box und nimmst sie wieder weg. Ich zähle mit.</li>
            <li>Am Ende siehst du für jede Karte, wie oft es geklappt hat, und was du tun kannst.</li>
          </ol>
          <p class="soft small">Ich schreibe dabei nichts auf deine Karten oder die SD-Karte. Lege 2 bis {t.maxCards} Karten bereit, am besten verschiedene.</p>
        </section>
      ) : null}
      {t.interrupted ? <Callout tone="warning">Die Verbindung zur Box war weg. Verbinde sie neu, dann testest du die Karte noch einmal von vorn.</Callout> : null}
      <ConnectCard link={link} />
    </div>
  );
}

function ReaderChecking() {
  return (
    <section class="card pad stack" aria-labelledby="rt-check" aria-busy="true">
      <div class="row">
        <Spinner size={20} />
        <h2 id="rt-check" class="ws-card-title">
          Die Box startet …
        </h2>
      </div>
      <p class="soft">Beim Verbinden startet die Box meist neu. Dabei meldet sie, ob ihr Kartenleser antwortet. Warte einen Moment.</p>
    </section>
  );
}

function ReaderMissed({ t }: { t: ReaderTest }) {
  const heading = useFocusHeading();
  return (
    <section class="card pad stack" aria-labelledby="rt-missed">
      <h2 id="rt-missed" class="ws-card-title" ref={heading} tabIndex={-1}>
        Die Box ist nicht neu gestartet
      </h2>
      <p>
        Nur beim Start meldet die Box, ob ihr Kartenleser antwortet.{' '}
        {t.restarts ? 'Schalte die Box aus und wieder ein. Lasse dabei das USB-Kabel stecken.' : 'Starte sie neu, dann prüfe ich den Kartenleser.'}
      </p>
      <div class="row wrap">
        <Button variant="primary" icon={RotateCcw} onClick={() => void restartBox()}>
          Box neu starten
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            t.skipReaderCheck();
            bump();
          }}
        >
          Ohne Prüfung weiter
        </Button>
      </div>
    </section>
  );
}

function ReaderDone({ t }: { t: ReaderTest }) {
  const heading = useFocusHeading();
  const r = t.reader;
  const toCards = () => {
    t.startCards();
    bump();
  };
  const toResults = () => {
    t.finish();
    bump();
  };

  if (r.state === 'broken') {
    return (
      <AdviceView advice={overallVerdict(resultOf(t))} headingRef={heading}>
        <Button variant="primary" icon={RotateCcw} onClick={() => void restartBox()}>
          Noch einmal prüfen
        </Button>
        <Button icon={ArrowRight} onClick={toResults}>
          Zum Ergebnis
        </Button>
      </AdviceView>
    );
  }
  if (t.cardsUntestable) {
    return (
      <AdviceView advice={overallVerdict(resultOf(t))} headingRef={heading}>
        <a class="btn" href="#/werkstatt/logbuch">
          <NotebookText size={18} strokeWidth={2.2} /> Box-Logbuch öffnen
        </a>
      </AdviceView>
    );
  }

  const known = r.state !== 'unknown';
  return (
    <section class="card pad stack loose" aria-labelledby="rt-reader">
      <div class="rt-head">
        <ToneIcon tone={r.state === 'ok' ? 'ok' : r.state === 'warn' ? 'warn' : 'neutral'} />
        <div class="stack tight">
          <h2 id="rt-reader" class="ws-card-title" ref={heading} tabIndex={-1}>
            {known ? 'Der Kartenleser antwortet' : 'Keine Meldung vom Kartenleser'}
          </h2>
          <p class="soft">
            {r.state === 'ok'
              ? `Beim Start hat er sich gemeldet (${r.chip}). Jetzt testest du, wie gut er deine Karten liest.`
              : r.state === 'warn'
                ? `${readerChipNote(r) ?? ''} Der Test zeigt, wie gut er deine Karten liest.`
                : 'Beim Start hat die Box nichts über den Kartenleser gemeldet. Du kannst die Karten trotzdem testen.'}
          </p>
        </div>
      </div>
      <div class="row wrap">
        <Button variant="primary" iconRight={ArrowRight} onClick={toCards}>
          Karten testen
        </Button>
        {!known ? (
          <Button icon={RotateCcw} onClick={() => void restartBox()}>
            Box neu starten
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function CardReady({ t, index }: { t: ReaderTest; index: number }) {
  const heading = useFocusHeading();
  const first = index === 0;
  const start = () => {
    t.startCard(nameDraft.value, Date.now());
    nameDraft.value = '';
    bump();
  };
  return (
    <section class="card pad stack loose" aria-labelledby="rt-ready">
      <div class="stack tight">
        <h2 id="rt-ready" class="ws-card-title" ref={heading} tabIndex={-1}>
          Karte {index + 1}
        </h2>
        <p class="soft">
          Nimm {first ? 'die erste' : 'die nächste'} Karte zur Hand. Du legst sie {t.rounds}-mal auf die Box und nimmst sie wieder weg. Ich sag dir jeweils, wann.
        </p>
      </div>
      {t.interrupted ? <Callout tone="warning">Die Verbindung zur Box war kurz weg. Teste die Karte noch einmal von vorn.</Callout> : null}
      {first ? (
        <ul class="rt-tips">
          <li>Drehe die Box leise: Bei jeder Karte spielt sie kurz los.</li>
          <li>Nimm Karten, die schon Musik abspielen. Eine leere Karte oder die Admin-Karte öffnet ein Menü der Box.</li>
          <li>Teste mehrere Karten, gern verschiedene Sorten. Dann zeigt der Test, ob es an einer Karte, am Kartentyp oder am Kartenleser liegt.</li>
        </ul>
      ) : null}
      <Field label="Name der Karte (freiwillig)" id="rt-name" hint="Damit du die Karte im Ergebnis wiederfindest.">
        <input
          id="rt-name"
          class="input"
          value={nameDraft.value}
          maxLength={60}
          placeholder="z. B. Feuerwehr"
          autoComplete="off"
          onInput={(e) => (nameDraft.value = e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') start();
          }}
        />
      </Field>
      <div class="row wrap">
        <Button variant="primary" icon={Play} onClick={start}>
          Los
        </Button>
        {t.cards.length ? (
          <Button
            iconRight={ArrowRight}
            onClick={() => {
              t.finish();
              bump();
            }}
          >
            Fertig, zum Ergebnis
          </Button>
        ) : null}
      </div>
    </section>
  );
}

const OUTCOME_TEXT: Record<RoundOutcome | 'skipped', string> = {
  read: 'Gelesen.',
  'bad-version': 'Gelesen.',
  foreign: 'Gelesen.',
  unreadable: 'Bemerkt, aber die Box konnte die Karte nicht lesen.',
  missed: 'Nicht bemerkt.',
  skipped: 'Zu kurz aufgelegt, oder die Box war beschäftigt. Diese Runde zählt nicht, sie kommt noch einmal.',
};

function Round({ t }: { t: ReaderTest }) {
  const p = t.phase;
  if (!('card' in p)) return null;
  const card = t.cards[p.card];
  if (!card) return null;
  const now = Date.now();
  const round = Math.min(card.rounds.length + 1, t.rounds);
  const left = t.remaining(now);
  const last = t.last?.card === p.card ? t.last.outcome : undefined;
  let say: string;
  let sub: string;
  switch (p.kind) {
    case 'clear':
      say = 'Nimm die Karte von der Box.';
      sub = 'Es liegt noch eine Karte auf. Erst wenn sie weg ist, beginnt die Runde.';
      break;
    case 'lay':
      say = 'Lege die Karte jetzt auf.';
      sub = 'Mitten auf die Stelle über dem Kartenleser, und lasse sie kurz liegen.';
      break;
    case 'reading':
      say = 'Die Box liest die Karte …';
      sub = 'Lasse sie liegen.';
      break;
    default:
      say = 'Nimm die Karte wieder weg.';
      sub = left !== undefined ? 'Gleich geht es mit der nächsten Runde weiter.' : 'Die nächste Runde beginnt, wenn die Karte weg ist.';
  }
  const lastText = last && (p.kind === 'lay' || p.kind === 'remove' || p.kind === 'clear') ? OUTCOME_TEXT[last] : '';
  const lastTone = last === 'missed' ? 'error' : last === 'unreadable' ? 'warn' : last === 'skipped' ? 'neutral' : 'ok';
  return (
    <section class="card pad stack loose rt-stage" aria-labelledby="rt-round">
      <div class="rt-stage-head">
        <span class="section-title">{cardLabel(card, p.card)}</span>
        <span class="rt-round-count">
          Runde {round} von {t.rounds}
        </span>
      </div>
      <Dots card={card} rounds={t.rounds} current={card.rounds.length} />
      <div class="rt-say" aria-live="polite">
        {lastText ? <p class={`rt-last ${lastTone}`}>{lastText}</p> : null}
        <h2 id="rt-round" class="rt-say-main">
          {say}
        </h2>
        <p class="soft">{sub}</p>
      </div>
      {left !== undefined ? <Progress value={left} label={p.kind === 'lay' ? 'Zeit zum Auflegen' : 'Zeit zum Wegnehmen'} /> : null}
      {last === 'skipped' ? (
        <Callout tone="neutral">
          <div class="stack tight">
            <span>Lasse die Karte liegen, bis hier „Nimm die Karte wieder weg“ steht. Passiert das immer wieder, ist die Box vielleicht in einem Menü, etwa nach einer leeren Karte. Dann starte sie neu.</span>
            <div>
              <Button size="sm" icon={RotateCcw} onClick={() => void restartBox()}>
                Box neu starten
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}
      <div class="row wrap">
        <Button
          variant="ghost"
          icon={X}
          onClick={() => {
            t.cancelCard();
            bump();
          }}
        >
          Karte abbrechen
        </Button>
      </div>
    </section>
  );
}

function Dots({ card, rounds, current }: { card: CardResult; rounds: number; current?: number }) {
  const label = (i: number) => {
    const r = card.rounds[i];
    if (!r) return i === current ? 'läuft' : 'kommt noch';
    return r.outcome === 'unreadable' ? 'nicht lesbar' : r.outcome === 'missed' ? 'nicht bemerkt' : 'gelesen';
  };
  return (
    <ol class="rt-dots" aria-label="Runden">
      {Array.from({ length: rounds }, (_, i) => {
        const r = card.rounds[i];
        const cls = !r ? (i === current ? 'current' : '') : r.outcome === 'unreadable' ? 'warn' : r.outcome === 'missed' ? 'miss' : 'ok';
        return (
          <li key={i} class={`rt-dot ${cls}`} title={`Runde ${i + 1}: ${label(i)}`}>
            <span aria-hidden="true">{!r ? i + 1 : r.outcome === 'missed' ? '–' : r.outcome === 'unreadable' ? '!' : '✓'}</span>
            <span class="visually-hidden">
              Runde {i + 1}: {label(i)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CardDone({ t, index }: { t: ReaderTest; index: number }) {
  const heading = useFocusHeading();
  const card = t.cards[index];
  if (!card) return null;
  const v = cardVerdict(card, t.box);
  const menu = card.stop === 'blank' || card.stop === 'admin' || card.stop === 'busy';
  const more = t.cards.length < t.maxCards;
  return (
    <section class="card pad stack loose" aria-labelledby="rt-done">
      <div class="rt-head">
        <ToneIcon tone={v.tone} />
        <div class="stack tight">
          <span class="section-title">{cardLabel(card, index)}</span>
          <h2 id="rt-done" class="ws-card-title" ref={heading} tabIndex={-1}>
            {cardStats(card).total ? `${rateText(card)} gelesen: ` : ''}
            {v.title}
          </h2>
          <p class="soft">{v.text}</p>
        </div>
      </div>
      {menu ? (
        <Callout tone="neutral">
          <div class="stack tight">
            <span>Die Box ist jetzt vielleicht in einem Menü und liest keine Karten. Starte sie neu, bevor du die nächste Karte testest.</span>
            <div>
              <Button size="sm" icon={RotateCcw} onClick={() => void restartBox()}>
                Box neu starten
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}
      {!more ? <p class="soft small">Das waren {t.maxCards} Karten. Mehr gehen in einem Test nicht.</p> : null}
      <div class="row wrap">
        {more ? (
          <Button
            variant="primary"
            icon={Play}
            onClick={() => {
              t.nextCard();
              bump();
            }}
          >
            Nächste Karte testen
          </Button>
        ) : null}
        <Button
          variant={more ? 'default' : 'primary'}
          iconRight={ArrowRight}
          onClick={() => {
            t.finish();
            bump();
          }}
        >
          Fertig, zum Ergebnis
        </Button>
        <Button
          variant="ghost"
          icon={RotateCcw}
          onClick={() => {
            t.repeatCard(Date.now());
            bump();
          }}
        >
          Diese Karte noch einmal
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ results */

function Results({ t }: { t: ReaderTest }) {
  const heading = useFocusHeading();
  const r = resultOf(t);
  const advice = overallVerdict(r);
  return (
    <div class="stack loose">
      <AdviceView advice={advice} headingRef={heading} summary={`Kartenleser: ${readerText(r)}`}>
        <CopyButton size="md" label="Ergebnis kopieren" text={() => resultText(r, t.rounds, Date.now())} fallback="Mache stattdessen ein Bildschirmfoto von dieser Seite." />
        <Button icon={RotateCcw} onClick={newTest}>
          Noch einmal testen
        </Button>
      </AdviceView>
      {t.cards.length ? <CardList t={t} title="Deine Karten" /> : null}
      <Callout tone="neutral" icon={Info}>
        <div class="stack tight">
          <b>Was der Test nicht sieht</b>
          <span>
            Er zeigt, wie gut die Box deine Karten gerade jetzt liest. Fehler, die nur ab und zu auftreten, etwa wenn die Box warm wird, der Akku schwach ist oder ein Kabel wackelt, sieht er nur, wenn
            sie gerade passieren. Mehr dazu in der Hilfe unter <a href="#/hilfe/kartenleser-testen">Box testen: Kartenleser</a>.
          </span>
        </div>
      </Callout>
    </div>
  );
}

function AdviceView({ advice, headingRef, summary, children }: { advice: Advice; headingRef?: Ref<HTMLHeadingElement>; summary?: string; children?: ComponentChildren }) {
  return (
    <section class={`card pad stack loose rt-advice ${advice.tone}`} aria-labelledby="rt-advice-title">
      <div class="rt-head">
        <ToneIcon tone={advice.tone} />
        <div class="stack tight">
          {summary ? <span class="section-title">{summary}</span> : null}
          <h2 id="rt-advice-title" class="ws-card-title" ref={headingRef} tabIndex={-1}>
            {advice.title}
          </h2>
          <p>{advice.text}</p>
        </div>
      </div>
      {advice.steps.length ? (
        <div class="stack">
          <span class="section-title">Das kannst du tun</span>
          <ol class="ws-numbered">
            {advice.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {advice.notes.map((n) => (
        <Callout key={n} tone="warning">
          {n}
        </Callout>
      ))}
      {advice.links.length ? (
        <div class="row wrap">
          {advice.links.map((l) => (
            <a key={l.href} class="link-button" href={l.href}>
              {l.label}
              <ArrowRight size={15} strokeWidth={2.2} />
            </a>
          ))}
        </div>
      ) : null}
      {children ? <div class="row wrap">{children}</div> : null}
    </section>
  );
}

const TONE_ICON = { ok: CircleCheck, warn: TriangleAlert, error: CircleAlert, neutral: Info } as const;

function ToneIcon({ tone }: { tone: Tone }) {
  const Icon = TONE_ICON[tone];
  return (
    <span class={`rt-icon ${tone}`} aria-hidden="true">
      <Icon size={24} strokeWidth={2.2} />
    </span>
  );
}

function CardList({ t, title, only }: { t: ReaderTest; title: string; only?: number[] }) {
  return (
    <section class="card" aria-labelledby="rt-list-title">
      <div class="card-header">
        <h2 id="rt-list-title" class="ws-card-title">
          {title}
        </h2>
      </div>
      <ul class="rt-cards">
        {t.cards.map((card, i) => {
          if (only && !only.includes(i)) return null;
          const v = cardVerdict(card, t.box);
          const s = cardStats(card);
          const type = cardTypeText(card);
          const fail = failureText(card);
          return (
            <li key={i} class="rt-card">
              <div class="rt-card-name">
                <b>{card.name || `Karte ${i + 1}`}</b>
                {card.name ? <span class="small muted">Karte {i + 1}</span> : null}
                {type ? <span class="ws-chip">{type}</span> : null}
              </div>
              <div class={`rt-rate ${v.tone}`}>
                {s.total ? (
                  <>
                    <b>{rateText(card)}</b> gelesen
                  </>
                ) : (
                  'nicht gezählt'
                )}
              </div>
              <div class="rt-card-verdict stack tight">
                <b>{v.title}</b>
                <span class="small soft">{v.text}</span>
                {fail ? <span class="small muted">{fail}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
