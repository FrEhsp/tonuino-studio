/**
 * Box testen: one guided test for a freshly soldered box, step by step. The
 * drawn box shows every part green or red; a problem names the solder joint
 * to check and shows it ringed in the Lötplan. Logic in boxtest.ts, the
 * meaning of the lines in boxbefund.ts. Uses the connection of the
 * Box-Logbuch; leaving the box tools frees the port for the firmware wizard.
 */
import '../../ui/styles/readertest.css';
import '../../ui/styles/loetplan.css';
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ArrowRight, Check, Flag, Hammer, RotateCcw, SkipForward, X } from 'lucide-preact';
import { Button, Callout } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { plat } from '../../app/state';
import { route } from '../../app/router';
import { playCue } from '../../ui/sound';
import { stellenText, TEIL_NAMEN, type Befund, type TeilId } from './boxbefund';
import { ausstattungAus, BoxTest, SCHRITT_NAMEN, type BoxSchritt } from './boxtest';
import { BoxTestSketch, boxTestLabel } from './BoxTestSketch';
import { hasBootFacts } from './boxfacts';
import { eintragArt, folgeLog } from './boxwatch';
import { BoxTestHeader, NoSerial } from './common';
import { clockTime } from './logbook';
import { ConnectCard } from './LogbookTool';
import { LoetplanSketch } from './LoetplanSketch';
import { loetplanWahl, PLATINEN_NAMEN } from './loetplan';
import { keepsLogConnection, logSession } from './logsession';
import { toDevice } from '../../app/device';

const test = signal(new BoxTest(ausstattungAus(loetplanWahl.peek())));
const rev = signal(0);
const bump = () => rev.value++;
/** The finding whose joint the Lötplan picture shows. */
const gezeigt = signal<string | undefined>(undefined);

function neuerTest() {
  const t = new BoxTest(ausstattungAus(loetplanWahl.peek()));
  if (logSession.connected) {
    t.verbindet(Date.now());
    const info = logSession.book.info;
    if (hasBootFacts(info)) t.kennt(info);
  }
  test.value = t;
  gezeigt.value = undefined;
  bump();
}

/** Feeds the lines of the Box-Logbuch connection into the test while the page is open. */
function useFeed() {
  useEffect(() => {
    const t0 = test.peek();
    // Opened on a live connection: the start of the box may have passed already.
    if (logSession.connected && !t0.verbunden) {
      t0.verbindet(Date.now());
      const info = logSession.book.info;
      if (hasBootFacts(info)) t0.kennt(info);
      bump();
    }
    const stop = folgeLog((e) => {
      if (logSession.source.kind !== 'live') return;
      const t = test.peek();
      const art = eintragArt(e);
      const at = e.time ?? Date.now();
      if (art === 'verbunden') t.verbindet(at);
      else if (art === 'neustart') t.neustartAngestossen(at);
      else if (art === 'zeile') t.zeile(e.text, at);
      else return;
      bump();
    });
    let link = logSession.link.peek();
    const stopLink = logSession.link.subscribe((l) => {
      if (l.kind !== link.kind && (l.kind === 'lost' || l.kind === 'error' || l.kind === 'idle') && link.kind === 'connected') {
        test.peek().getrennt(Date.now(), l.kind !== 'idle');
        bump();
      }
      link = l;
    });
    return () => {
      stop();
      stopLink();
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

const act = (fn: (t: BoxTest) => void) => () => {
  fn(test.value);
  bump();
};

export function BoxTestTool() {
  void rev.value;
  const t = test.value;
  const link = logSession.link.value;
  const serialOk = plat().capabilities.serial;
  useFeed();
  const header = (
    <BoxTestHeader current="testen" meldungen={false}>
      Ich führ dich Schritt für Schritt durch deine Box und zeige dir bei einem Problem, welche Lötstelle du prüfen sollst.
    </BoxTestHeader>
  );
  if (!serialOk) {
    return (
      <div class="page narrow ws-page">
        {header}
        <NoSerial>
          <span>
            Was der Test macht, steht in der Hilfe unter <a href="#/hilfe/tasten-testen">Box testen</a>.
          </span>
        </NoSerial>
      </div>
    );
  }
  const live = link.kind === 'connected';
  const connecting = t.schritt === 'verbinden' && !live;
  const problems = t.befunde.list();
  return (
    <div class="page narrow ws-page bt-page">
      <DoneKnock done={t.schritt === 'ergebnis'} />
      {header}
      <Schritte t={t} />
      {t.schritt !== 'ergebnis' && problems.length ? <Probleme list={problems} /> : null}
      {/* Connecting: the drawing beside the step on a wide window, so the button is in view without scrolling. */}
      <section class={`card pad stack loose rt-stage bt-stage${connecting ? ' is-connect' : ''}`} aria-labelledby="bt-say">
        <Bild t={t} />
        {t.schritt === 'ergebnis' ? (
          <Ergebnis t={t} />
        ) : !live && t.schritt !== 'verbinden' ? (
          <Getrennt />
        ) : connecting ? (
          <div class="stack loose">
            <Schritt t={t} live={live} />
          </div>
        ) : (
          <Schritt t={t} live={live} />
        )}
      </section>
      {t.schritt === 'ergebnis' && problems.length ? <Stellen t={t} list={problems} /> : null}
      <details class="card pad bt-mehr">
        <summary>Mehr: einzelne Tests und das Box-Logbuch</summary>
        <div class="stack tight">
          <p class="soft small">Für Bastler, die genauer hinschauen wollen.</p>
          <div class="row wrap">
            <a class="link-button" href="#/werkstatt/tasten">
              Jede Taste kurz und lang <ArrowRight size={15} strokeWidth={2.2} />
            </a>
            <a class="link-button" href="#/werkstatt/kartenleser">
              Kartenleser mit vielen Karten <ArrowRight size={15} strokeWidth={2.2} />
            </a>
            <a class="link-button" href="#/werkstatt/logbuch">
              Box-Logbuch <ArrowRight size={15} strokeWidth={2.2} />
            </a>
          </div>
        </div>
      </details>
    </div>
  );
}

/** "Schritt 3 von 8: Kartenleser" and a row of small dots. */
function Schritte({ t }: { t: BoxTest }) {
  // The test changes in place: reading the signal draws this again on every change.
  void rev.value;
  const s = t.schritte();
  const { nr, von } = t.position();
  return (
    <div class="bt-steps" aria-label={`Schritt ${nr} von ${von}: ${SCHRITT_NAMEN[t.schritt]}`}>
      <ol>
        {s.map((x, i) => (
          <li key={x} class={x === t.schritt ? 'is-now' : i < nr - 1 ? 'is-done' : ''} aria-current={x === t.schritt ? 'step' : undefined}>
            <span>{SCHRITT_NAMEN[x]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function Bild({ t }: { t: BoxTest }) {
  void rev.value;
  const [, redraw] = useState(0);
  const lit = t.zuletztTaste && Date.now() - t.zuletztTaste.at < 1000 ? t.zuletztTaste.key : undefined;
  useEffect(() => {
    if (!lit || !t.zuletztTaste) return;
    const timer = setTimeout(() => redraw((x) => x + 1), Math.max(0, t.zuletztTaste.at + 1000 - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [lit, t.zuletztTaste?.at]);
  const reduced = typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches;
  const bild = { teile: t.teile(), tasten: t.tasten(), jetzt: t.teilJetzt(), wantTaste: t.wantTaste()?.key, litTaste: lit, reducedMotion: reduced };
  return <BoxTestSketch {...bild} label={boxTestLabel(bild, TEIL_NAMEN)} />;
}

function Say({ main, sub }: { main: string; sub?: string }) {
  return (
    <div class="rt-say" aria-live="polite">
      <h2 id="bt-say" class="rt-say-main">
        {main}
      </h2>
      {sub ? <p class="soft">{sub}</p> : null}
    </div>
  );
}

function JaNein({ teil, ja, nein, frage }: { teil: TeilId; ja: string; nein: string; frage?: string }) {
  void rev.value;
  const t = test.value;
  const a = t.antworten[teil];
  return (
    <div class="stack tight">
      {frage ? <b>{frage}</b> : null}
      <div class="row wrap">
        <Button variant={a === true ? 'primary' : 'default'} icon={Check} onClick={act((x) => x.antwort(teil, true, Date.now()))}>
          {ja}
        </Button>
        <Button variant={a === false ? 'danger' : 'default'} icon={X} onClick={act((x) => x.antwort(teil, false, Date.now()))}>
          {nein}
        </Button>
      </div>
    </div>
  );
}

function Nav({ t, weiter = true, weiterText = 'Weiter', skip, skipText = 'Überspringen' }: { t: BoxTest; weiter?: boolean; weiterText?: string; skip?: () => void; skipText?: string }) {
  return (
    <div class="row wrap bt-nav">
      {t.position().nr > 1 ? (
        <Button variant="ghost" icon={ArrowLeft} onClick={act((x) => x.zurueck())}>
          Zurück
        </Button>
      ) : null}
      <span class="grow" />
      {skip ? (
        <Button variant="ghost" icon={SkipForward} onClick={() => (skip(), bump())}>
          {skipText}
        </Button>
      ) : null}
      {weiter ? (
        <Button variant="primary" iconRight={ArrowRight} onClick={act((x) => x.weiter())}>
          {weiterText}
        </Button>
      ) : null}
    </div>
  );
}

function Lautstaerke({ t }: { t: BoxTest }) {
  void rev.value;
  if (t.lautstaerke === undefined) return null;
  const pct = Math.round((Math.min(30, t.lautstaerke) / 30) * 100);
  return (
    <div class="bt-volume" aria-label={`Lautstärke ${t.lautstaerke}`}>
      <span class="small soft">Lautstärke</span>
      <span class="bt-volume-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <b>{t.lautstaerke}</b>
    </div>
  );
}

function Getrennt() {
  return (
    <div class="stack">
      <Say main="Die Box ist nicht verbunden." sub="Verbinde sie wieder, dann geht es hier weiter." />
      <ConnectCard link={logSession.link.value} bare />
    </div>
  );
}

function Schritt({ t, live }: { t: BoxTest; live: boolean }) {
  void rev.value;
  const s: BoxSchritt = t.schritt;
  switch (s) {
    case 'verbinden':
      return live ? (
        <>
          <Say
            main={t.gestartet ? 'Die Box ist verbunden.' : 'Verbunden. Die Box startet …'}
            sub={t.gestartet ? `Sie hat sich gemeldet${t.board ? `: ${t.board === 'aio' || t.board === 'aioplus' ? PLATINEN_NAMEN[t.board] : 'Arduino Nano'}, ${t.ausstattung.tasten} Tasten` : ''}.` : 'Meldet sie sich nicht, starte sie neu.'}
          />
          {!t.gestartet ? (
            <div>
              <Button size="sm" icon={RotateCcw} onClick={() => void restartBox()}>
                Box neu starten
              </Button>
            </div>
          ) : null}
          <Nav t={t} weiterText="Test starten" />
        </>
      ) : (
        <>
          <Say main={`Stecke die Box per USB ${toDevice()}.`} sub="Wähle sie dann aus. Ich lese nur mit, was die Box meldet, und schreibe nichts auf die Box, die Karten oder die SD-Karte." />
          {/* The step says what to do; the card's own title and sentence repeated it. */}
          <ConnectCard link={logSession.link.value} bare />
        </>
      );
    case 'tasten': {
      if (!t.liestTasten)
        return (
          <>
            <Say main="Drücke nacheinander jede Taste." sub="Deine Firmware meldet Tasten nicht über USB. Schaue selbst: Reagiert die Box auf jede Taste (piept, spielt, springt)?" />
            <JaNein teil="tasten" ja="Ja, jede Taste geht" nein="Eine Taste tut nichts" />
            <Nav t={t} />
          </>
        );
      const want = t.wantTaste();
      const statt = want?.statt;
      return (
        <>
          {statt ? <p class="rt-last warn">Die Box hat „{statt}“ gemeldet. Versuche es noch einmal.</p> : null}
          <Say main={want ? `Drücke kurz auf ${want.name}.` : 'Alle Tasten sind durch.'} sub="Nur kurz drücken. Lang auf Play/Pause schaltet die Box aus." />
          <Nav
            t={t}
            weiter={!want}
            skipText="Passiert nichts"
            skip={
              want
                ? () => {
                    test.value.passiertNichts(Date.now());
                  }
                : undefined
            }
          />
          {want ? <p class="soft small">Passiert nichts, wenn du drückst? Dann tippe auf „Passiert nichts“. Die Taste wird rot, und am Ende siehst du, welche Lötstelle du prüfen sollst.</p> : null}
        </>
      );
    }
    case 'karte':
      return (
        <>
          <Say main="Lege eine Karte mit Musik auf die Box." sub="Lege sie flach auf die Stelle über dem Kartenleser und lasse sie liegen." />
          {!t.liestKarten ? <JaNein teil="leser" ja="Die Box spielt" nein="Es passiert nichts" /> : null}
          <Nav t={t} weiter={t.karteGelesen || t.teilStatus('leser') !== 'offen'} skipText="Passiert nichts" skip={t.teilStatus('leser') === 'offen' ? () => test.value.passiertNichts(Date.now()) : undefined} />
        </>
      );
    case 'ton':
      return (
        <>
          {t.titelGestartet ? (
            <Say main="Hörst du Musik aus dem Lautsprecher?" sub={`Die Box spielt Titel ${t.titelGestartet}. Mache sie lauter, wenn es zu leise ist.`} />
          ) : (
            <Say main="Warte, bis die Box spielt." sub="Liegt die Karte noch drauf? Die Box meldet, wenn sie einen Titel startet." />
          )}
          <Lautstaerke t={t} />
          <JaNein teil="lautsprecher" ja="Ja, ich höre Musik" nein="Nein, es bleibt still" />
          <Nav t={t} weiter={t.antworten.lautsprecher !== undefined} />
        </>
      );
    case 'kopfhoerer':
      return (
        <>
          <Say main="Stecke einen Kopfhörer ein." sub="Kommt die Musik jetzt aus dem Kopfhörer? Danach ziehe ihn wieder ab." />
          {t.kopfhoererGemeldet !== undefined ? <p class="small">{t.kopfhoererGemeldet ? 'Die Box hat den Kopfhörer bemerkt.' : 'Die Box meldet: kein Kopfhörer.'}</p> : null}
          <JaNein teil="kopfhoerer" ja="Ja, im Kopfhörer" nein="Nein, nichts im Kopfhörer" />
          <Nav t={t} weiter={t.antworten.kopfhoerer !== undefined} skip={t.antworten.kopfhoerer === undefined ? () => (test.value.ueberspringe('kopfhoerer'), test.value.weiter()) : undefined} />
        </>
      );
    case 'extras':
      return <Extras t={t} />;
    case 'wackeln':
      return <Wackeln t={t} />;
    default:
      return null;
  }
}

function Extras({ t }: { t: BoxTest }) {
  void rev.value;
  const a = t.ausstattung;
  const jetzt = t.extraJetzt();
  const chip = (id: 'ring' | 'knopf' | 'akku', name: string) => (
    <label class={`lp-extra-chip ${a[id] ? 'is-on' : ''}`}>
      <input type="checkbox" checked={a[id]} onChange={act((x) => x.setzeExtra(id, !a[id]))} /> {name}
    </label>
  );
  return (
    <>
      <Say main={jetzt ? EXTRA_FRAGE[jetzt].main : 'Was hat deine Box noch?'} sub={jetzt ? EXTRA_FRAGE[jetzt].sub : 'Hake an, was du eingebaut hast. Hat sie nichts davon, tippe auf „Weiter“.'} />
      <div class="lp-extra-wahl bt-extra-wahl">
        {chip('ring', 'LED-Ring')}
        {chip('knopf', 'Lautstärke-Knopf')}
        {chip('akku', 'Akku')}
      </div>
      {jetzt === 'ring' ? <JaNein teil="ring" ja="Ja, er leuchtet" nein="Nein, er bleibt dunkel" /> : null}
      {jetzt === 'knopf' ? (
        <>
          <Lautstaerke t={t} />
          <div>
            <Button variant="default" icon={X} onClick={act((x) => x.antwort('knopf', false, Date.now()))}>
              Die Zahl ändert sich nicht
            </Button>
          </div>
        </>
      ) : null}
      {jetzt === 'akku' ? <p class="small">{t.akkuVolt !== undefined ? `Akku: ${t.akkuVolt.toFixed(2).replace('.', ',')} V` : 'Die fertigen Firmwares melden die Akkuspannung nicht über USB. Das kann ich darum nicht prüfen.'}</p> : null}
      <Nav t={t} weiter={!jetzt} skip={jetzt ? () => test.value.ueberspringe(jetzt) : undefined} />
    </>
  );
}

const EXTRA_FRAGE: Record<TeilId, { main: string; sub: string }> = {
  ring: { main: 'Leuchtet der LED-Ring?', sub: 'Wartet die Box, pulsiert er grün. Spielt sie, läuft ein Regenbogen.' },
  knopf: { main: 'Drehe am Lautstärke-Knopf.', sub: 'Die Zahl unten muss sich mit jedem Dreh ändern. Spielt die Box gerade?' },
  akku: { main: 'Der Akku', sub: 'Nimm das USB-Kabel nicht ab, ich brauch es zum Mitlesen.' },
  usb: { main: '', sub: '' },
  strom: { main: '', sub: '' },
  tasten: { main: '', sub: '' },
  leser: { main: '', sub: '' },
  mp3: { main: '', sub: '' },
  lautsprecher: { main: '', sub: '' },
  kopfhoerer: { main: '', sub: '' },
};

function Wackeln({ t }: { t: BoxTest }) {
  void rev.value;
  const laeuft = t.wackelStart !== undefined && t.wackelEnde === undefined;
  if (!laeuft)
    return (
      <>
        <Say main="Zum Schluss der Wackeltest." sub="Lege eine Karte auf und lasse Musik laufen. Klopfe dann mit einem Holzstab, zum Beispiel dem Stiel eines Kochlöffels, sanft auf die Platine, die Kabel und jede Lötstelle." />
        <p class="small soft">
          Fällt dabei etwas aus, steht es sofort in der Liste, mit der Stelle, die du prüfen sollst. Mehr dazu steht in der Hilfe unter <a href="#/hilfe/wackelkontakt">Wackelkontakt und schlechte Lötstellen</a>.
        </p>
        <div class="row wrap bt-nav">
          <Button variant="ghost" icon={ArrowLeft} onClick={act((x) => x.zurueck())}>
            Zurück
          </Button>
          <span class="grow" />
          <Button variant="primary" icon={Hammer} onClick={act((x) => x.starteWackeln(Date.now()))}>
            Wackeltest starten
          </Button>
        </div>
      </>
    );
  const log = [...t.wackelLog].reverse();
  return (
    <>
      <Say main="Klopfe jetzt sanft überall hin." sub="Platine, Kabel, Lötstellen, Kartenleser, Lautsprecher, USB-Buchse. Die Musik soll weiterlaufen." />
      <div class="bt-wackel" aria-live="polite">
        <div class="small soft">Die Box meldet sich: {t.zeilen} Zeilen bisher.</div>
        {log.length ? (
          <ul class="bt-wackel-log">
            {log.slice(0, 30).map((e, i) => (
              <li key={`${e.at}-${i}`} class={e.ton}>
                <span class="bt-time">{clockTime(e.at)}</span> {e.text}
              </li>
            ))}
          </ul>
        ) : (
          <p class="small">Bisher ist nichts ausgefallen.</p>
        )}
      </div>
      <div class="row wrap bt-nav">
        <span class="grow" />
        <Button variant="primary" icon={Flag} onClick={act((x) => x.beendeWackeln(Date.now()))}>
          Fertig geklopft
        </Button>
      </div>
    </>
  );
}

function Probleme({ list }: { list: Befund[] }) {
  const fehler = list.some((b) => b.ton === 'fehler');
  return (
    <Callout tone={fehler ? 'danger' : 'warning'}>
      <div class="stack tight">
        <b>{list.length === 1 ? 'Die Box meldet ein Problem' : `Die Box meldet ${list.length} Probleme`}</b>
        <ul class="bt-problems">
          {list.map((b) => (
            <li key={b.id}>
              {b.titel}
              {b.anzahl > 1 ? ` (${b.anzahl}-mal)` : ''}
            </li>
          ))}
        </ul>
        <span class="small soft">Mache ruhig weiter. Am Ende siehst du, welche Stelle du prüfen sollst.</span>
      </div>
    </Callout>
  );
}

function Ergebnis({ t }: { t: BoxTest }) {
  void rev.value;
  const e = t.ergebnis();
  const teile = t.teile().filter((x) => x.status !== 'aus');
  return (
    <div class="stack">
      <Say main={e.titel} sub={e.text} />
      <ul class="bt-teile">
        {teile.map((x) => {
          const { wort, hinweis } = t.teilWort(x.id);
          return (
            <li key={x.id} class={hinweis ? 'hinweis' : x.status}>
              <span class="bt-dot" aria-hidden="true" />
              <span>
                {TEIL_NAMEN[x.id]}: <b>{wort}</b>
              </span>
            </li>
          );
        })}
      </ul>
      <div class="row wrap bt-nav">
        <Button variant="ghost" icon={ArrowLeft} onClick={act((x) => x.zurueck())}>
          Zurück
        </Button>
        <span class="grow" />
        <Button icon={RotateCcw} onClick={neuerTest}>
          Noch einmal testen
        </Button>
      </div>
    </div>
  );
}

/** Each finding with "Prüf diese Stelle" and, on the Classic board, the joint ringed in the Lötplan. */
function Stellen({ t, list }: { t: BoxTest; list: Befund[] }) {
  void rev.value;
  const w = loetplanWahl.value;
  const platine = t.ausstattung.platine;
  const mitBild = platine === 'classic' && w.platine === 'classic';
  const id = gezeigt.value ?? list.find((b) => b.stellen.length)?.id;
  const zeig = list.find((b) => b.id === id);
  return (
    <section class="card pad stack loose" aria-labelledby="bt-stellen">
      <h2 id="bt-stellen" class="ws-card-title">
        Was du prüfen kannst
      </h2>
      <ul class="bt-befunde">
        {list.map((b) => (
          <li key={b.id} class={`bt-befund ${b.ton} ${b.id === id ? 'is-shown' : ''}`}>
            <b>{b.titel}</b>
            {b.anzahl > 1 ? <span class="soft"> ({b.anzahl}-mal)</span> : null}
            <p class="small">{b.text}</p>
            {b.stellen.length ? (
              <p class="small">
                <b>Prüfe diese Stelle:</b> {stellenText(b.stellen, platine)}
                {b.stellen.some((s) => s.startsWith('nano:')) ? ' (nach dem Aufdruck am Nano)' : ''}.{' '}
                {mitBild && b.id !== id ? (
                  <button type="button" class="link-button" onClick={() => (gezeigt.value = b.id)}>
                    Im Bild zeigen
                  </button>
                ) : null}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {mitBild && zeig?.stellen.length ? (
        <figure class="bt-stelle">
          <figcaption class="small">
            Rot umkreist: {stellenText(zeig.stellen, platine)}. Von oben gesehen, wie im <a href="#/werkstatt/loetplan">Lötplan</a>.
          </figcaption>
          <div class="lp-bild">
            <LoetplanSketch wahl={{ ...w, ansicht: 'oben' }} markiere={zeig.stellen} />
          </div>
        </figure>
      ) : !mitBild && list.some((b) => b.stellen.length) ? (
        <p class="small soft">
          Ein Bild mit der Stelle gibt es für die Classic-Platine v1.7. Für deine Box ({PLATINEN_NAMEN[platine]}) schaue in den <a href="#/werkstatt/loetplan">Lötplan</a>.
        </p>
      ) : null}
    </section>
  );
}

/**
 * A double knock once the guided test reaches its result (the "Töne" switch
 * decides). Only when it gets there: coming back to a result shown before
 * (the test lives on while the user looks at the Box-Logbuch) stays quiet.
 */
function DoneKnock({ done }: { done: boolean }) {
  const before = useRef(done);
  useEffect(() => {
    if (done && !before.current) void playCue('testDone');
    before.current = done;
  }, [done]);
  return null;
}
