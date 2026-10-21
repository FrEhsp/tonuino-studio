/**
 * „Über USB an die Box“ (TODO #93): the box writes the cards itself. Shown
 * only for a box that can (WRITECARD, asked after connecting, logsession.ts).
 * Uses the connection of the Box-Logbuch; the steps live in usbwrite.ts.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { CircleAlert, CircleCheck, Info, RefreshCw, SkipForward, Square, Usb } from 'lucide-preact';
import { Button, Callout, Spinner } from '../../ui/components/controls';
import { ADMIN_MODE } from '../../core/tonuino/card';
import { describeCard } from '../../core/tonuino/modes';
import { plat, profile } from '../../app/state';
import { ConnectCard } from '../workshop/LogbookTool';
import { logSession } from '../workshop/logsession';
import { choiceKey, type CardItem } from './items';
import { readCardText } from './ReadCardActions';
import { UsbCardWriter, problemText, type CardOutcome, type UsbStep } from './usbwrite';

const FIRMWARE_LINK = '#/werkstatt/firmware';

/** Said wherever the way shows: it is a preview of a firmware that is not official yet. */
export const PREVIEW_NOTE = 'Vorschau, bis die offizielle Firmware das kann. Die Box braucht dafür TonUINO TNG mit „Karten über die Box beschreiben“ (Werkstatt, Firmware aufspielen, Extras).';

export function UsbPanel({ items }: { items: CardItem[] }) {
  if (!plat().capabilities.serial) {
    return <Callout tone="info">Über USB geht es in der Desktop-App und in Chrome oder Edge.</Callout>;
  }
  const link = logSession.link.value;
  const ability = logSession.writeAbility.value;
  if (link.kind !== 'connected') {
    return (
      <div class="stack">
        <p>Die Box schreibt die Karten selbst. Dafür verbindest du sie per USB-Kabel mit dem Computer.</p>
        <ConnectCard link={link} />
        <p class="soft small">{PREVIEW_NOTE}</p>
      </div>
    );
  }
  if (ability === 'checking') {
    return (
      <div class="row" aria-live="polite">
        <Spinner size={20} />
        <span>Die Box startet. Ich frage sie gleich, ob sie Karten selbst schreiben kann …</span>
      </div>
    );
  }
  if (ability === 'no') {
    return (
      <Callout tone="warning" icon={CircleAlert}>
        <div class="stack tight">
          <span>
            Diese Box kann Karten nicht selbst schreiben. Dafür braucht sie die Firmware mit „Karten über die Box beschreiben“. Die gibt es unter <a href={FIRMWARE_LINK}>Firmware aufspielen</a> bei den Extras. Oder nimm oben einen anderen Weg.
          </span>
          <div>
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => logSession.checkWriteAbility()}>
              Noch einmal fragen
            </Button>
          </div>
        </div>
      </Callout>
    );
  }
  if (ability !== 'yes') {
    return (
      <Callout tone="info" icon={Info}>
        <div class="stack tight">
          <span>
            {ability === 'busy'
              ? 'Die Box spielt gerade oder ist in ihrem Menü. Dann hört sie nicht zu. Halte die Musik mit Play/Pause an und nimm die Karte von der Box.'
              : 'Ich weiß noch nicht, ob die Box Karten selbst schreiben kann.'}
          </span>
          <div>
            <Button size="sm" icon={RefreshCw} onClick={() => logSession.checkWriteAbility()}>
              Noch einmal fragen
            </Button>
          </div>
        </div>
      </Callout>
    );
  }
  return <Writer items={items} key={choiceKey(items)} />;
}

function Writer({ items }: { items: CardItem[] }) {
  const cards = useMemo(() => items.map((i) => ({ key: i.key, title: i.title, data: i.data })), [items]);
  const writer = useMemo(() => new UsbCardWriter(cards, { send: (line) => logSession.send(line), onLine: (l) => logSession.onLine(l) }), [cards]);
  const [, setRev] = useState(0);
  useEffect(() => {
    const stop = writer.onChange(() => setRev((n) => n + 1));
    const timer = setInterval(() => writer.tick(), 200);
    return () => {
      stop();
      clearInterval(timer);
      // Leaving while the box waits for a card: it stops waiting.
      if (writer.running) void writer.cancel();
      writer.dispose();
    };
  }, [writer]);

  const step = writer.step;
  const notPossible = items.map((i) => ({ item: i, why: UsbCardWriter.problemOf(i.data) })).filter((x) => x.why);
  const writable = items.length - notPossible.length;
  const first = writer.firstOpen();
  const item = 'index' in step ? items[step.index] : undefined;
  const written = items.filter((i) => {
    const o = writer.outcomes.get(i.key);
    return o === 'written' || o === 'checked';
  }).length;

  return (
    <div class="stack">
      <div class="reader-status">
        <span class="reader-dot on" aria-hidden="true" />
        <div class="grow">
          <strong>Box an USB</strong>
          <span class="soft small"> · kann Karten schreiben</span>
        </div>
      </div>

      {notPossible.length ? (
        <Callout tone="warning" icon={CircleAlert}>
          {notPossible.map(({ item: i, why }) => (
            <span key={i.key} class="block">
              „{i.title}“: {why}
            </span>
          ))}
        </Callout>
      ) : null}

      <div class={`reader-stage phase-${stagePhase(step)}`} aria-live="polite">
        {step.kind === 'idle' ? (
          <>
            <p>
              {writable === 1 ? 'Eine Karte' : `${writable} Karten`} der Reihe nach. Die Box schreibt jede Karte selbst. Vorher: Musik anhalten und keine Karte auf der Box.
            </p>
            <Button variant="primary" size="lg" icon={Usb} disabled={!writable || first < 0} onClick={() => void writer.start(first)}>
              {written ? 'Weiter beschreiben' : writable === 1 ? 'Karte beschreiben' : 'Karten beschreiben'}
            </Button>
          </>
        ) : null}
        {step.kind === 'starting' && item ? (
          <>
            <StepCount n={step.index} of={items.length} />
            <p class="reader-big">Schicke „{item.title}“ an die Box …</p>
            <Spinner size={22} />
          </>
        ) : null}
        {step.kind === 'place' && item ? (
          <>
            <StepCount n={step.index} of={items.length} />
            <p class="reader-big">
              Lege die Karte für <strong>„{item.title}“</strong> auf die Box.
            </p>
            <p class="soft small">Die Box sagt „Bitte lege nun die Karte auf!“ Lasse die Karte liegen, bis sie „OK. Ich habe die Karte konfiguriert.“ sagt, dann nimm sie ab.</p>
            {/* The box writes at once: unlike the NFC reader, the app cannot read the card first and ask (forum 14978#67). */}
            <p class="soft small">Die Box überschreibt jede Karte, ohne zu fragen. Nimm eine leere Karte oder eine, die du nicht mehr brauchst.</p>
            <Spinner size={22} />
          </>
        ) : null}
        {step.kind === 'remove' ? (
          <>
            <CircleCheck size={34} class="reader-ok" />
            <p class="reader-big">Geschrieben. Nimm die Karte von der Box.</p>
          </>
        ) : null}
        {/* The outcome as a prop: with the same props, the signals integration skips rendering Check, so „Ja, stimmt“ seemed to do nothing. */}
        {step.kind === 'check' && item ? <Check writer={writer} step={step} item={item} outcome={writer.outcomes.get(item.key)} /> : null}
        {step.kind === 'problem' ? <Problem writer={writer} step={step} /> : null}
        {step.kind === 'done' ? (
          <>
            <CircleCheck size={34} class="reader-ok" />
            <p class="reader-big">{written === items.length ? 'Alle Karten sind beschrieben.' : `${written} von ${items.length} Karten sind beschrieben.`}</p>
            {first >= 0 && writable > written ? (
              <Button variant="primary" icon={Usb} onClick={() => void writer.start(first)}>
                Fehlende Karten beschreiben
              </Button>
            ) : null}
          </>
        ) : null}
        {writer.running ? (
          <Button size="sm" variant="ghost" icon={Square} onClick={() => void writer.cancel()}>
            Abbrechen
          </Button>
        ) : null}
      </div>

      <ol class="reader-queue">
        {items.map((i, n) => {
          const o = writer.outcomes.get(i.key);
          const ok = o === 'written' || o === 'checked';
          const bad = o === 'failed' || o === 'wrong';
          const active = 'index' in step && step.index === n && writer.running;
          return (
            <li key={i.key} class={`${active ? 'active' : ''} ${ok ? 'done' : bad ? 'error' : ''}`}>
              <span class="reader-queue-icon">{ok ? <CircleCheck size={16} /> : bad ? <CircleAlert size={16} /> : n + 1}</span>
              <span class="grow ellipsis">{i.title}</span>
              <span class="soft small ellipsis">{i.summary}</span>
            </li>
          );
        })}
      </ol>

      <details class="small">
        <summary>So geht das</summary>
        <div class="stack tight soft">
          {/* What TNG says (mp3 0800, 0400, 0401 of its SD card), checked in the box simulator (TODO #66). */}
          <p>Ich schicke Ordner, Modus und Titel per USB an die Box. Die Box sagt „Bitte lege nun die Karte auf!“, schreibt die Karte und sagt dann „OK. Ich habe die Karte konfiguriert.“ Sagt sie „Oh weh! Das hat leider nicht geklappt!“, ist die Karte nicht beschrieben.</p>
          <p>Die Box hört nur zu, wenn gerade keine Musik läuft und keine Karte auf ihr liegt. Spezialkarten wie die Schlummerkarte schreibt sie so nicht.</p>
          <p>{PREVIEW_NOTE}</p>
        </div>
      </details>
    </div>
  );
}

function StepCount({ n, of }: { n: number; of: number }) {
  return (
    <span class="reader-step">
      Karte {n + 1} von {of}
    </span>
  );
}

/** After writing: lay the card on again, the box reads it back (its log, or the user's ears). */
function Check({ writer, step, item, outcome }: { writer: UsbCardWriter; step: Extract<UsbStep, { kind: 'check' }>; item: CardItem; outcome: CardOutcome | undefined }) {
  const what = describeCard(item.data, profile.value);
  // Purple only when nothing else is to be done first: beside „Noch einmal schreiben“ or the question it is a way out.
  const nextButton = (main = true) => (
    <Button variant={main ? 'primary' : 'ghost'} icon={SkipForward} onClick={() => void writer.next()}>
      {writer.firstOpen() < 0 ? 'Fertig' : 'Nächste Karte'}
    </Button>
  );
  // The admin card opens the admin menu instead of playing; there the box takes no command until it is left (box simulator, TODO #66).
  const admin = item.data.mode === ADMIN_MODE && item.data.folder === 0;
  const pauseHint = admin ? (
    <p class="soft small">Die Box öffnet jetzt das Admin-Menü. Nimm die Karte ab und halte Play/Pause lang gedrückt, bis die Box „OK, ich habe den Vorgang abgebrochen.“ sagt. Erst dann nimmt sie die nächste Karte an.</p>
  ) : (
    <p class="soft small">Die Box spielt die Karte jetzt ab. Halte die Musik mit Play/Pause an und nimm die Karte ab, bevor die nächste kommt.</p>
  );
  if (step.how === 'log') {
    if (!step.result) {
      return (
        <>
          <CircleCheck size={34} class="reader-ok" />
          <p class="reader-big">Geschrieben. Zum Prüfen lege die Karte noch einmal auf.</p>
          <p class="soft small">Die Box liest sie dann und {admin ? 'öffnet das Admin-Menü' : 'spielt sie ab'}. Ich sehe im Log, was auf der Karte steht.</p>
          <Spinner size={22} />
          <Button size="sm" variant="ghost" onClick={() => void writer.next()}>
            Ohne Prüfen weiter
          </Button>
        </>
      );
    }
    return (
      <>
        {step.result.kind === 'match' ? <CircleCheck size={34} class="reader-ok" /> : <CircleAlert size={34} class="reader-bad" />}
        <p class="reader-big">{step.result.kind === 'match' ? `Stimmt. Auf der Karte steht: ${what}` : 'Auf der Karte steht etwas anderes.'}</p>
        {step.result.kind === 'differs' ? (
          <p class="soft small">
            Gelesen: {readCardText(hexBytes(step.result.read))} ({step.result.read}). Erwartet: {what} ({step.result.want}).
          </p>
        ) : null}
        {pauseHint}
        <div class="row wrap" style={{ justifyContent: 'center' }}>
          {step.result.kind === 'differs' ? (
            <Button variant="primary" onClick={() => void writer.start(step.index)}>
              Noch einmal schreiben
            </Button>
          ) : null}
          {nextButton(step.result.kind !== 'differs')}
        </div>
      </>
    );
  }
  // Answered: the result in place of the question, as when the box's log shows what it read.
  if (outcome === 'checked' || outcome === 'wrong') {
    const right = outcome === 'checked';
    return (
      <>
        {right ? <CircleCheck size={34} class="reader-ok" /> : <CircleAlert size={34} class="reader-bad" />}
        <p class="reader-big">{right ? `Stimmt. Auf der Karte steht: ${what}` : 'Die Box spielt etwas anderes.'}</p>
        {pauseHint}
        <div class="row wrap" style={{ justifyContent: 'center' }}>
          {right ? null : (
            <Button variant="primary" onClick={() => void writer.start(step.index)}>
              Noch einmal schreiben
            </Button>
          )}
          {nextButton(right)}
        </div>
      </>
    );
  }
  return (
    <>
      <CircleCheck size={34} class="reader-ok" />
      <p class="reader-big">Geschrieben. Lege die Karte zum Prüfen noch einmal auf.</p>
      <p>Spielt die Box das Richtige? Auf der Karte soll stehen: {what}</p>
      <div class="row wrap" style={{ justifyContent: 'center' }}>
        <Button variant="primary" onClick={() => writer.confirmCheck(true)}>
          Ja, stimmt
        </Button>
        <Button variant="ghost" onClick={() => writer.confirmCheck(false)}>
          Nein
        </Button>
      </div>
      {pauseHint}
      <Button size="sm" variant="ghost" onClick={() => void writer.next()}>
        Ohne Prüfen weiter
      </Button>
    </>
  );
}

function Problem({ writer, step }: { writer: UsbCardWriter; step: Extract<UsbStep, { kind: 'problem' }> }) {
  const { title, text } = problemText(step.problem, step.detail);
  const later = step.index < writer.cards.length - 1;
  return (
    <>
      <CircleAlert size={34} class="reader-bad" />
      <p class="reader-big">{title}</p>
      <p>{text}</p>
      <div class="row wrap" style={{ justifyContent: 'center' }}>
        {step.problem !== 'not-possible' ? (
          <Button variant="primary" onClick={() => void writer.start(step.index)}>
            Noch einmal versuchen
          </Button>
        ) : null}
        {later ? (
          <Button icon={SkipForward} onClick={() => void writer.next()}>
            Diese Karte überspringen
          </Button>
        ) : (
          <Button onClick={() => writer.reset()}>Zurück</Button>
        )}
      </div>
    </>
  );
}

function stagePhase(step: UsbStep): string {
  switch (step.kind) {
    case 'starting':
    case 'place':
      return 'waiting';
    case 'remove':
    case 'check':
      return 'remove';
    case 'problem':
      return 'error';
    default:
      return step.kind;
  }
}

/** "13 37 B3 47 …" as bytes. */
function hexBytes(text: string): Uint8Array {
  return Uint8Array.from(text.trim().split(/\s+/).map((h) => parseInt(h, 16) || 0));
}
