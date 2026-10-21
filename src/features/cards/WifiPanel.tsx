import { useEffect, useState } from 'preact/hooks';
import { Check, ChevronRight, CircleAlert, CircleCheck, RotateCcw, Send, Wifi } from 'lucide-preact';
import type { BoxStep } from '../../core/tonuino/boxguide';
import { esp32CardProblem, esp32WriteRequest, normalizeBoxAddress, parseEsp32InfoPage, parseEsp32MainPage, type Esp32Box } from '../../core/tonuino/esp32';
import { Button, Callout, Field, Spinner } from '../../ui/components/controls';
import { errorText } from '../../ui/components/Hints';
import { plat, settings, updateSettings } from '../../app/state';
import { GuideStep } from './BoxPanel';
import { choiceKey, type CardItem } from './items';

type Conn = { state: 'idle' | 'checking' | 'ok' } | { state: 'error'; message: string };
type Send = { state: 'idle' | 'sending' | 'sent' } | { state: 'error'; message: string };

/*
 * The box answers 200 to every valid job, but only starts it while it does not
 * play and no card lies on it (state_machine.cpp: checkForWritingCard runs in
 * Idle and Pause and needs the card removed); otherwise the job is lost without
 * a word. After "OK" it keeps waiting until the card is taken off.
 */
const BEFORE_SEND = 'Halte vorher die Musik mit der Play/Pause-Taste an und nimm jede Karte von der Box. Spielt die Box oder liegt eine Karte auf ihr, überhört sie den Auftrag.';

const AFTER_SEND: BoxStep[] = [
  { kind: 'card', text: 'Höre auf die Box. Bittet sie um die Karte, lege sie auf.', hear: '„Bitte lege nun die Karte auf!“' },
  { kind: 'done', text: 'Warte, bis die Box die Karte beschrieben hat. Nimm sie dann ab.', hear: '„OK. Ich habe die Karte konfiguriert.“' },
];

const NOT_HEARD =
  'Die Box sagt nichts? Dann hat sie den Auftrag überhört, weil sie gerade spielte oder eine Karte auf ihr lag. Halte die Musik an, nimm die Karte ab und sende noch einmal. Sagt sie „Oh, eine neue Karte!“, halte die Play/Pause-Taste lang, bis sie „OK, ich habe den Vorgang abgebrochen.“ sagt. Nimm dann die Karte ab und sende noch einmal.';

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Writing cards through an ESP32 box with TNG in the home network. */
export function WifiPanel({ items }: { items: CardItem[] }) {
  const p = plat();
  const [address, setAddress] = useState(settings.value.boxAddress);
  const [conn, setConn] = useState<Conn>({ state: 'idle' });
  /** What the box's pages say about its firmware, after a successful check. */
  const [box, setBox] = useState<Esp32Box | null>(null);
  const [index, setIndex] = useState(0);
  const [send, setSend] = useState<Send>({ state: 'idle' });
  /** The parent confirmed the last card. */
  const [finished, setFinished] = useState(false);
  const base = normalizeBoxAddress(address);

  // Other cards chosen (also the same number of different ones): start over at the first.
  const chosenKey = choiceKey(items);
  useEffect(() => {
    setIndex(0);
    setSend({ state: 'idle' });
    setFinished(false);
  }, [chosenKey]);

  if (!p.capabilities.wifiBox) {
    return (
      <Callout tone="info" icon={Wifi}>
        Boxen mit ESP32 und WLAN beschreiben Karten auch auf Zuruf vom Computer. Das geht in der Desktop-App für Windows und Linux; der Browser darf die Box im Heimnetz nicht erreichen.
      </Callout>
    );
  }

  /** The info page lists the options compiled into the firmware. A busy box may not answer; then nothing is known. */
  const readInfo = async (): Promise<Partial<Esp32Box>> => {
    try {
      const res = await withTimeout(6000, (signal) => p.fetch(`${base}/info`, { signal }));
      return res.ok ? parseEsp32InfoPage(await res.text()) : {};
    } catch {
      return {};
    }
  };

  const check = async () => {
    if (!base) return;
    updateSettings({ boxAddress: address.trim() });
    setConn({ state: 'checking' });
    setBox(null);
    // A failed send belongs to the old check; after a new one, sending starts clean.
    setSend((s) => (s.state === 'sending' ? s : { state: 'idle' }));
    try {
      const res = await withTimeout(6000, (signal) => p.fetch(`${base}/`, { signal }));
      const text = await res.text();
      if (!res.ok || !/tonuino/i.test(text)) throw new Error('Unter dieser Adresse antwortet keine TonUINO-Box.');
      setBox({ modifiers: parseEsp32MainPage(text), ...(await readInfo()) });
      setConn({ state: 'ok' });
    } catch (e) {
      setConn({ state: 'error', message: friendly(e) });
    }
  };

  const item = items[Math.min(index, items.length - 1)];
  const req = item ? esp32WriteRequest(item.data) : null;
  /** Why this card cannot go to this box; the box would answer 200 and write a card that does nothing. */
  const blocked = !req ? undefined : !req.ok ? req.reason : box ? esp32CardProblem(item.data, box) : undefined;

  const sendCard = async () => {
    if (!base || !req?.ok || blocked) return;
    setSend({ state: 'sending' });
    try {
      const res = await withTimeout(8000, (signal) =>
        p.fetch(`${base}${req.request.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: req.request.body.toString(),
          signal,
        }),
      );
      if (!res.ok) throw new Error((await res.text()).trim() || `Die Box hat mit Fehler ${res.status} geantwortet.`);
      setSend({ state: 'sent' });
    } catch (e) {
      setSend({ state: 'error', message: friendly(e) });
    }
  };

  const next = () => {
    setIndex(index + 1);
    setSend({ state: 'idle' });
  };

  const isLast = index >= items.length - 1;
  const startOver = () => {
    setIndex(0);
    setSend({ state: 'idle' });
    setFinished(false);
  };
  /** The box said "OK" and the card is off again. */
  const confirm = () => {
    if (!isLast) return next();
    setFinished(true);
  };

  return (
    <div class="stack">
      <p class="soft">
        Für Boxen mit ESP32 und TNG-Firmware. Box und Computer müssen im selben WLAN sein. Die Adresse findest du in deinem Router (Gerät „tonuino“). Hat die Box kein WLAN eingerichtet, öffnet sie ihr eigenes Netz „TonUINO“; dann ist die Adresse 192.168.4.1.
      </p>
      <form
        class="row wrap"
        style={{ alignItems: 'flex-end', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <Field label="Adresse der Box" id="box-address">
          <input
            id="box-address"
            class="input"
            style={{ width: 280 }}
            value={address}
            placeholder="z. B. 192.168.178.40 oder tonuino.fritz.box"
            onInput={(e) => {
              setAddress(e.currentTarget.value);
              setConn({ state: 'idle' });
            }}
          />
        </Field>
        <Button type="submit" disabled={!base} loading={conn.state === 'checking'}>
          Verbindung prüfen
        </Button>
        {conn.state === 'ok' ? (
          <span class="row tight success-text">
            <CircleCheck size={17} /> Box gefunden
          </span>
        ) : null}
      </form>
      {conn.state === 'error' ? (
        <Callout tone="warning" icon={CircleAlert}>
          {conn.message}
        </Callout>
      ) : null}

      {conn.state === 'ok' && item ? (
        <div class="guide">
          <div class="guide-head">
            <div class="guide-title">
              {items.length > 1 ? (
                <span class="guide-count">
                  Karte {index + 1} von {items.length}
                </span>
              ) : null}
              <strong>{item.title}</strong>
              <span class="soft small">{item.summary}</span>
            </div>
          </div>
          {finished ? (
            <>
              <Callout tone="success" icon={CircleCheck}>
                {items.length > 1 ? 'Fertig. Alle Karten sind beschrieben.' : 'Fertig. Die Karte ist beschrieben.'}
              </Callout>
              <div class="row wrap">
                <Button icon={RotateCcw} onClick={startOver}>
                  {items.length > 1 ? 'Noch einmal von vorn' : 'Noch eine Karte so beschreiben'}
                </Button>
              </div>
            </>
          ) : blocked ? (
            <Callout tone="warning">{blocked}</Callout>
          ) : send.state === 'sent' ? (
            <>
              <p>Die Box hat den Auftrag bekommen.</p>
              <ol class="guide-steps">
                {AFTER_SEND.map((s, i) => (
                  <GuideStep step={s} n={i + 1} key={i} />
                ))}
              </ol>
              <div class="row wrap">
                <Button variant="primary" icon={Check} onClick={confirm}>
                  {isLast ? 'Karte ist fertig' : 'Karte ist fertig, weiter'}
                </Button>
                <Button icon={RotateCcw} onClick={sendCard}>
                  Noch einmal senden
                </Button>
              </div>
              <p class="guide-help">{NOT_HEARD}</p>
            </>
          ) : (
            <>
              <p>{BEFORE_SEND}</p>
              <div class="row wrap">
                <Button variant="primary" icon={Send} onClick={sendCard} loading={send.state === 'sending'}>
                  An die Box senden
                </Button>
                {send.state === 'sending' ? <Spinner size={18} /> : null}
              </div>
            </>
          )}
          {send.state === 'error' && !blocked ? (
            <Callout tone="warning" icon={CircleAlert}>
              {send.message}
            </Callout>
          ) : null}
          {blocked && !isLast ? (
            <div class="row" style={{ justifyContent: 'flex-end' }}>
              <Button iconRight={ChevronRight} onClick={next}>
                Nächste Karte
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function friendly(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return 'Die Box antwortet nicht. Prüfe die Adresse und ob die Box eingeschaltet ist.';
  const text = errorText(e);
  return /fetch|network|load failed/i.test(text) ? 'Die Box ist nicht erreichbar. Prüfe die Adresse und ob Box und Computer im selben WLAN sind.' : text;
}
