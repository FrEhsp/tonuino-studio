/**
 * Box testen, tab "Tasten": after soldering, press every button and watch it
 * being ticked off, plus card reader and MP3 player. It uses the connection
 * of the Box-Logbuch (same port, same lines). The logic lives in
 * partstest.ts; this page feeds it lines and shows the rows. Leaving the page
 * frees the USB port, except towards the Box-Logbuch and the reader test.
 */
import '../../ui/styles/readertest.css';
import { effect, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { ArrowRight, CircleCheck, Flag, NotebookText, Play, RotateCcw, TriangleAlert } from 'lucide-preact';
import { Badge, Button, Callout } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { plat } from '../../app/state';
import { route } from '../../app/router';
import { BoxSketch, LIT_MS, sketchButtons } from './BoxSketch';
import { hasBootFacts } from './boxfacts';
import { BoxTestHeader, NoSerial } from './common';
import { clockTime } from './logbook';
import { ConnectCard } from './LogbookTool';
import { keepsLogConnection, logSession } from './logsession';
import { PartsTest, allArrived, instruction, otherHint, rowHint, summary, type PartRow } from './partstest';
import { playCue } from '../../ui/sound';

/** The test of this app session; "Noch einmal testen" starts a new one. */
const test = signal(new PartsTest());
/** Bumped whenever the test changed. */
const rev = signal(0);

function bump() {
  rev.value++;
}

function seeded(): PartsTest {
  const t = new PartsTest();
  const info = logSession.book.info;
  if (hasBootFacts(info)) t.seed(info);
  return t;
}

/** Feeds the lines of the Box-Logbuch connection into the test while the page is open. */
function useFeed() {
  useEffect(() => {
    let book = logSession.book;
    let lastId = book.entries.length ? book.entries[book.entries.length - 1].id : 0;
    // Opened on a live connection: the start of the box may have passed already.
    if (hasBootFacts(book.info)) {
      test.peek().seed(book.info);
      bump();
    }
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
      const before = allArrived(t);
      for (; i < entries.length; i++) {
        const e = entries[i];
        lastId = e.id;
        if (e.kind === 'line' && t.observe(e.text, e.time ?? Date.now())) changed = true;
      }
      if (changed) bump();
      // The last tick: a quiet double knock, so the box can be put down without looking.
      if (changed && !before && allArrived(t)) void playCue('testDone');
    });
    return () => {
      stopLines();
      // Frees the port for the firmware wizard, like the Box-Logbuch; going over to the Box-Logbuch keeps it.
      if (!keepsLogConnection(route.peek())) void logSession.disconnect();
    };
  }, []);
}

async function restartBox() {
  try {
    await logSession.restartBox();
  } catch (e) {
    toastError('Der Neustart hat nicht geklappt', e);
  }
}

function newTest() {
  test.value = seeded();
  bump();
}

export function PartsTestTool() {
  void rev.value;
  const t = test.value;
  const link = logSession.link.value;
  const serialOk = plat().capabilities.serial;
  useFeed();

  const header = <BoxTestHeader current="tasten">Drücke jede Taste und sieh, ob die Box sie meldet. Lege auch eine Karte auf, dann siehst du, ob Kartenleser und MP3-Player antworten.</BoxTestHeader>;
  if (!serialOk) {
    return (
      <div class="page narrow ws-page">
        {header}
        <NoSerial>
          <span>
            Was der Test macht, steht in der Hilfe unter <a href="#/hilfe/tasten-testen">Box testen: Tasten</a>.
          </span>
        </NoSerial>
      </div>
    );
  }

  const live = link.kind === 'connected';
  const rows = t.rows();
  const started = rows.some((r) => r.at !== undefined);
  return (
    <div class="page narrow ws-page">
      {header}
      {!live ? <Connect fresh={!started} /> : t.support !== 'ok' ? <Unsupported t={t} /> : <Stage t={t} />}
      {rows.length && (live || started) ? <Checklist t={t} rows={rows} /> : null}
      {t.others.length ? <Others t={t} /> : null}
    </div>
  );
}

function Connect({ fresh }: { fresh: boolean }) {
  return (
    <div class="stack loose">
      {fresh ? (
        <section class="card pad stack" aria-labelledby="pt-how">
          <h2 id="pt-how" class="ws-card-title">
            So geht der Test
          </h2>
          <ol class="ws-numbered">
            <li>Du verbindest die Box per USB. Beim Start meldet sie, wie viele Tasten sie hat.</li>
            <li>Du legst eine Karte auf und drückst jede Taste einmal kurz und einmal lang. Ich hake ab, was die Box meldet.</li>
            <li>Bleibt etwas offen, steht dabei, was du prüfen kannst.</li>
          </ol>
          <p class="soft small">Ich schreibe dabei nichts auf die Box, deine Karten oder die SD-Karte.</p>
        </section>
      ) : null}
      <ConnectCard link={logSession.link.value} />
    </div>
  );
}

function Unsupported({ t }: { t: PartsTest }) {
  const aio = t.support === 'aio';
  return (
    <Callout tone="warning">
      <div class="stack tight">
        <b>Mit dieser Firmware geht der Test nicht.</b>
        <span>
          {aio
            ? 'Die Firmware der AiO-Platine meldet Tastendrücke und aufgelegte Karten nicht über USB. Ich kann darum nichts abhaken. Die AiO+ meldet sie.'
            : 'TonUINO 2.1 meldet Tastendrücke nicht so, dass ich sie lesen kann. Der Test braucht TonUINO TNG.'}
        </span>
        <div class="row wrap">
          <a class="link-button" href="#/werkstatt/logbuch">
            <NotebookText size={15} strokeWidth={2.2} /> Box-Logbuch öffnen
          </a>
          {!aio ? (
            <a class="link-button" href="#/werkstatt/kartenleser">
              Kartenleser testen <ArrowRight size={15} strokeWidth={2.2} />
            </a>
          ) : null}
        </div>
      </div>
    </Callout>
  );
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** The drawing of the box; it draws again when a lit button goes dark. */
function BoxIllustrationSlot({ t }: { t: PartsTest }) {
  // The test changes in place: reading the signal draws this again on every change.
  void rev.value;
  const [, redraw] = useState(0);
  const now = Date.now();
  const buttons = sketchButtons(t, now);
  const litUntil = buttons.some((b) => b.lit) && t.lastHit ? t.lastHit.at + LIT_MS : undefined;
  useEffect(() => {
    if (litUntil === undefined) return;
    const timer = setTimeout(() => redraw((x) => x + 1), Math.max(0, litUntil - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [litUntil]);
  if (t.support !== 'ok') return null;
  const reduced = typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches;
  return <BoxSketch buttons={buttons} reducedMotion={reduced} />;
}

function Stage({ t }: { t: PartsTest }) {
  void rev.value;
  const { done, total } = t.progress();
  if (t.finished) return <Summary t={t} />;
  const next = t.current();
  const say = next ? instruction(t, next) : { say: 'Alles ist abgehakt.', sub: 'Tippe auf „Fertig“, dann siehst du das Ergebnis.' };
  const hitRow = t.lastHit ? t.rows().find((r) => r.id === t.lastHit?.id) : undefined;
  const mismatch = t.lastMismatch && next?.id === t.lastMismatch.want ? t.lastMismatch : undefined;
  return (
    <section class="card pad stack loose rt-stage" aria-labelledby="pt-say">
      <div class="rt-stage-head">
        <span class="section-title">Drücke jede Taste einmal kurz und einmal lang</span>
        <span class="rt-round-count">
          {done} von {total}
        </span>
      </div>
      <BoxIllustrationSlot t={t} />
      <div class="rt-say" aria-live="polite">
        {mismatch ? (
          <p class="rt-last warn">
            Die Box hat „{mismatch.got}“ gemeldet. Versuche es noch einmal.
          </p>
        ) : hitRow ? (
          <p class="rt-last ok">{hitRow.label}: angekommen.</p>
        ) : null}
        <h2 id="pt-say" class="rt-say-main">
          {say.say}
        </h2>
        <p class="soft">{say.sub}</p>
      </div>
      {!t.variantKnown ? (
        <Callout tone="neutral">
          <div class="stack tight">
            <span>Ich weiß noch nicht, wie viele Tasten deine Box hat. Das meldet sie beim Start. Starte sie neu, dann stimmt die Liste.</span>
            <div>
              <Button size="sm" icon={RotateCcw} onClick={() => void restartBox()}>
                Box neu starten
              </Button>
            </div>
          </div>
        </Callout>
      ) : null}
      <div class="row wrap">
        <Button variant={next ? 'default' : 'primary'} icon={Flag} onClick={() => (t.finish(), bump())}>
          Fertig
        </Button>
      </div>
    </section>
  );
}

function Summary({ t }: { t: PartsTest }) {
  const s = summary(t);
  const Icon = s.tone === 'ok' ? CircleCheck : TriangleAlert;
  return (
    <section class={`card pad stack loose rt-advice ${s.tone}`} aria-labelledby="pt-summary">
      <div class="rt-head">
        <span class={`rt-icon ${s.tone}`} aria-hidden="true">
          <Icon size={24} strokeWidth={2.2} />
        </span>
        <div class="stack tight">
          <h2 id="pt-summary" class="ws-card-title">
            {s.title}
          </h2>
          <p>{s.text}</p>
        </div>
      </div>
      <div class="row wrap">
        <Button icon={Play} onClick={() => (t.resume(), bump())}>
          Weiter testen
        </Button>
        <Button variant="ghost" icon={RotateCcw} onClick={newTest}>
          Noch einmal testen
        </Button>
      </div>
    </section>
  );
}

function rowTone(t: PartsTest, r: PartRow): string {
  if (r.at !== undefined) return r.doubled || r.unreadable ? 'warn' : 'ok';
  return t.finished ? 'error' : '';
}

function Checklist({ t, rows }: { t: PartsTest; rows: PartRow[] }) {
  const next = t.finished ? undefined : t.current();
  return (
    <section class="card" aria-labelledby="pt-list">
      <div class="card-header">
        <h2 id="pt-list" class="ws-card-title">
          Was die Box gemeldet hat
        </h2>
      </div>
      <ul class="rt-cards">
        {rows.map((r) => {
          const hint = rowHint(t, r);
          const tone = rowTone(t, r);
          return (
            <li key={r.id} class="rt-card" aria-current={r.id === next?.id ? 'step' : undefined}>
              <div class="rt-card-name">
                <b>{r.label}</b>
                {r.id === next?.id ? (
                  <div>
                    <Badge tone="brand">jetzt</Badge>
                  </div>
                ) : t.lastHit?.id === r.id ? (
                  <div>
                    <Badge tone="success">gerade gemeldet</Badge>
                  </div>
                ) : null}
              </div>
              <div class={`rt-rate ${tone}`}>{r.at !== undefined ? `✓ ${clockTime(r.at)}` : t.finished ? 'fehlt' : 'wartet'}</div>
              <div class="rt-card-verdict stack tight">
                {r.detail ? <span class="small soft">{r.detail}</span> : null}
                {hint ? <span class="small">{hint.text}</span> : null}
                {hint?.readerTest ? (
                  <a class="link-button" href="#/werkstatt/kartenleser">
                    Kartenleser testen <ArrowRight size={15} strokeWidth={2.2} />
                  </a>
                ) : null}
                {hint?.logbook ? (
                  <a class="link-button" href="#/werkstatt/logbuch">
                    Box-Logbuch öffnen <ArrowRight size={15} strokeWidth={2.2} />
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {t.variantKnown && t.buttonCount === 3 && t.buttons !== '3x3' ? (
        <p class="soft small ws-card-note">
          Hat deine Box 5 Tasten? Dann ist Firmware für 3 Tasten drauf, und Lauter und Leiser melden sich nie. <a href="#/werkstatt/firmware">Firmware für 5 Tasten aufspielen</a>
        </p>
      ) : null}
    </section>
  );
}

function Others({ t }: { t: PartsTest }) {
  return (
    <section class="card" aria-labelledby="pt-others">
      <div class="card-header">
        <h2 id="pt-others" class="ws-card-title">
          Andere Meldungen
        </h2>
      </div>
      <ul class="rt-cards">
        {t.others.map((o, i) => (
          <li key={`${o.at}-${i}`} class="rt-card">
            <div class="rt-card-name">
              <b>{o.label}</b>
              <span class="small muted">{o.text}</span>
            </div>
            <div class="rt-rate warn">{clockTime(o.at)}</div>
            <div class="rt-card-verdict">
              <span class="small soft">{otherHint(o)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
