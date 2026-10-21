import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { CircleAlert, CircleCheck, Ellipsis, Eraser, Nfc, RefreshCw, ScanLine, SkipForward, Square } from 'lucide-preact';
import type { NfcAccess, NfcCardInfo, PhoneNfcState } from '../../platform/types';
import { Button, Callout, IconButton, Spinner } from '../../ui/components/controls';
import { MenuButton } from '../../ui/components/Menu';
import { errorHints, errorText, HintList, type Hint } from '../../ui/components/Hints';
import { describeCard } from '../../core/tonuino/modes';
import { plat, profile } from '../../app/state';
import type { CardItem } from './items';
import { newRunMemory, readCardNow, writeCards, type ReaderPort } from './readerRun';
import { playCue } from '../../ui/sound';
import { DeleteCardDialog, ReadCardActions, readCardText } from './ReadCardActions';
import { holdTaps, tappedCard, type TappedCard } from './nfcTap';
import { handheldWord } from '../../app/device';

type Phase = 'idle' | 'waiting' | 'writing' | 'remove' | 'clash' | 'occupied' | 'error' | 'done';

interface CardResult {
  status: 'done' | 'error';
  message?: string;
  hints?: Hint[];
  /** Error code, e.g. 'nfc-off' (the phone's NFC is switched off). */
  code?: string;
  /** What was on the card before, when it was a TonUINO card. */
  before?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The bar at the bottom of the cards page on a phone (CardsPage.tsx) starts
 * writing from there, in reach of the thumb: each tap counts this up.
 */
export const writeRequest = signal(0);

/** True while a run writes cards: the bar on the phone then steps aside. */
export const writingNow = signal(false);

/** The error code of a platform error, if it has one. */
function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Writing cards with a USB reader (ACR122U) in the desktop app, or with the
 * phone's own NFC in the Android app (`nfc.phone`): there the card is held to
 * the back of the phone, and switched-off NFC gets a way to the settings.
 */
export function ReaderPanel({ items }: { items: CardItem[] }) {
  const nfc = plat().nfc;
  const phone = !!nfc.phone;
  const [readers, setReaders] = useState<string[] | null>(null);
  const [setupError, setSetupError] = useState<{ message: string; hints: Hint[]; code?: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [current, setCurrent] = useState(0);
  const [results, setResults] = useState<Record<string, CardResult>>({});
  /** What "Karte prüfen" found, or the card last held to the phone (`tapped`). */
  const [inspect, setInspect] = useState<{ busy: boolean; text?: string; error?: string; data?: Uint8Array; tapped?: boolean } | null>(null);
  const [erase, setErase] = useState(false);
  /** The card on the reader already holds another card of this run (key of that item). */
  const [clash, setClash] = useState<{ uid: string; key: string } | null>(null);
  /** The card on the reader holds something from before: asked before it is overwritten (forum 14978#67). */
  const [occupied, setOccupied] = useState<{ uid: string; data: Uint8Array } | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** Which card holds which item; kept across "Anhalten" so a card put back is not overwritten without asking. */
  const memory = useRef(newRunMemory());
  const reader = readers?.[0];

  /** Counts the searches for a reader: a check of a card started before one is old news. */
  const search = useRef(0);
  /** The phone: what the last search found out about NFC (on, off, none). */
  const nfcState = useRef<PhoneNfcState | null>(null);

  const findReaders = async () => {
    search.current++;
    // The result of "Karte prüfen" was for the reader found before: it goes with it.
    setInspect(null);
    setErase(false);
    setSetupError(null);
    setReaders(null);
    try {
      const list = await nfc.listReaders();
      setReaders(list);
      nfcState.current = list.length ? 'on' : 'none';
      if (!list.length) {
        setSetupError(
          phone
            ? { message: `Dieses ${handheldWord()} hat kein NFC. Damit kann es keine Karten beschreiben. Nimm einen anderen Weg, zum Beispiel „An der Box“.`, hints: [] }
            : { message: 'Kein NFC-Leser gefunden. Stecke den Leser ein und warte einen Moment.', hints: await diagnose(nfc) },
        );
      }
    } catch (e) {
      setReaders([]);
      if (codeOf(e) === 'nfc-off') nfcState.current = 'off';
      setSetupError({ message: errorText(e), hints: [...errorHints(e), ...(await diagnose(nfc))], code: codeOf(e) });
    }
  };

  /** Whether a run writes cards right now (read by the NFC state listener). */
  const busy = useRef(false);
  const findLater = useRef(findReaders);
  findLater.current = findReaders;

  useEffect(() => {
    if (nfc.supported) void findReaders();
    // The phone: NFC switched on (or off) in the settings meanwhile, seen when the app comes back.
    const stopListening = nfc.onStateChange?.((state) => {
      if (state !== nfcState.current && !busy.current) void findLater.current();
    });
    return () => {
      stopListening?.();
      abort.current?.abort();
    };
  }, []);

  if (!nfc.supported) {
    return (
      <Callout tone="info" icon={Nfc}>
        Mit einem NFC-Leser am USB (z. B. ACR122U) beschreibst du Karten am schnellsten. Das geht in der Desktop-App für Windows und Linux, nicht im Browser.
      </Callout>
    );
  }

  const setResult = (key: string, r: CardResult) => setResults((all) => ({ ...all, [key]: r }));

  const waitForCard = async (signal: AbortSignal): Promise<NfcCardInfo | null> => {
    while (!signal.aborted) {
      const c = await nfc.waitForCard(reader!, 1500);
      if (c) return c;
    }
    return null;
  };

  const waitForRemoval = async (uid: string, signal: AbortSignal): Promise<boolean> => {
    while (!signal.aborted) {
      const c = await nfc.waitForCard(reader!, 250);
      if (!c || c.uid !== uid) return true;
      await sleep(350);
    }
    return false;
  };

  const port: ReaderPort = {
    waitForCard,
    waitForRemoval,
    read: () => nfc.read(reader!),
    write: (data, uid) => nfc.write(reader!, data, uid),
  };

  /** Writes the open cards from `start` on. `overwrite` allows to overwrite that one card of this run. */
  const runFrom = async (start: number, overwrite?: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setClash(null);
    setOccupied(null);
    try {
      const end = await writeCards(
        items,
        start,
        port,
        memory.current,
        {
          waiting: (i) => {
            setClash(null);
            setOccupied(null);
            setCurrent(i);
            setPhase('waiting');
          },
          clash: (uid, key) => {
            setClash({ uid, key });
            setPhase('clash');
          },
          occupied: (uid, data) => {
            setOccupied({ uid, data });
            setPhase('occupied');
          },
          writing: () => setPhase('writing'),
          written: (key, before, replaced) => {
            // Eyes are on the card: a short "Klack" says it is done.
            void playCue('cardWritten');
            setResults((all) => {
              const next: Record<string, CardResult> = { ...all, [key]: { status: 'done', before: before && describeCard(before, profile.value) } };
              // Overwritten on purpose: that item needs a new card.
              if (replaced !== undefined) delete next[replaced];
              return next;
            });
          },
          remove: () => setPhase('remove'),
        },
        ctrl.signal,
        overwrite,
      );
      if (end.kind === 'done') {
        setPhase('done');
      }
      if (end.kind === 'failed') {
        setResult(end.key, { status: 'error', message: errorText(end.error), hints: errorHints(end.error), code: codeOf(end.error) });
        setPhase('error');
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setSetupError({ message: errorText(e), hints: errorHints(e), code: codeOf(e) });
      setPhase('idle');
    }
  };

  const stop = () => {
    abort.current?.abort();
    setClash(null);
    setPhase('idle');
  };

  const restart = () => {
    memory.current = newRunMemory();
    setResults({});
    setPhase('idle');
  };

  const checkCard = async () => {
    const at = search.current;
    setInspect({ busy: true });
    try {
      // The phone waits until a card comes to it.
      const r = await readCardNow(nfc, reader!);
      if (!r) {
        if (at === search.current) setInspect({ busy: false, error: 'Keine Karte erkannt. Halte die Karte an die Rückseite deines Handys und tippe noch einmal auf „Karte prüfen“.' });
        return;
      }
      if (at === search.current) setInspect({ busy: false, text: tappedText(r), data: r.data });
    } catch (e) {
      if (at === search.current) setInspect({ busy: false, error: errorText(e) });
    }
  };

  const doneCount = items.filter((i) => results[i.key]?.status === 'done').length;
  const firstOpen = items.findIndex((i) => results[i.key]?.status !== 'done');
  const item = items[Math.min(current, items.length - 1)];
  const running = phase === 'waiting' || phase === 'writing' || phase === 'remove' || phase === 'clash' || phase === 'occupied';
  busy.current = running;
  useEffect(() => {
    writingNow.value = running;
  }, [running]);
  useEffect(() => () => void (writingNow.value = false), []);

  // A tap on the bar of the phone: as "Weiter beschreiben" here, once the phone's NFC is ready.
  const stage = useRef<HTMLDivElement>(null);
  const request = writeRequest.value;
  const handledRequest = useRef(request);
  useEffect(() => {
    if (request === handledRequest.current || !reader || running) return;
    handledRequest.current = request;
    stage.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    void runFrom(firstOpen < 0 ? 0 : firstOpen);
  }, [request, reader]);

  // The phone: a card held to it while no run waits shows here at once (nfcTap.ts).
  // During a run it belongs to the run, also in the moments it does not wait.
  useEffect(() => (running ? holdTaps() : undefined), [running]);
  const tapped = phone ? tappedCard.value : null;
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tapped || running) return;
    setErase(false);
    setInspect(tappedInspect(tapped));
    // On a phone the list above is long: the card shows where the eyes are, as in "NFC Tools".
    if (tapped.busy) status.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [tapped?.seq, tapped?.busy]);
  const clashItem = clash ? items.find((i) => i.key === clash.key) : undefined;

  return (
    <div class="stack">
      <div class="reader-status" ref={status}>
        <span class={`reader-dot ${reader ? 'on' : ''}`} aria-hidden="true" />
        <div class="grow">
          {readers === null ? (phone ? 'Prüfe NFC …' : 'Suche NFC-Leser …') : reader ? <strong>{phone ? 'NFC des Handys' : reader}</strong> : phone ? 'Kein NFC' : 'Kein NFC-Leser'}
          {reader ? <span class="soft small"> · bereit</span> : null}
        </div>
        {phone && reader ? null : (
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={findReaders} disabled={running}>
            {phone ? 'Erneut prüfen' : 'Erneut suchen'}
          </Button>
        )}
        {reader ? (
          <Button size="sm" icon={ScanLine} onClick={checkCard} disabled={running} loading={inspect?.busy}>
            Karte prüfen
          </Button>
        ) : null}
        {reader ? (
          <MenuButton
            trigger={(open) => <IconButton label={phone ? 'Mehr zu NFC' : 'Mehr zum NFC-Leser'} icon={Ellipsis} onClick={open} disabled={running} />}
            items={[{ label: 'Karte löschen …', icon: Eraser, danger: true, onSelect: () => setErase(true) }]}
          />
        ) : null}
      </div>

      {setupError ? (
        <Callout tone="warning" icon={CircleAlert}>
          <div class="stack tight">
            <span>{setupError.message}</span>
            <HintList hints={setupError.hints} />
            {setupError.code === 'nfc-off' && nfc.openSettings ? (
              <div>
                <Button size="sm" variant="primary" icon={Nfc} onClick={() => nfc.openSettings?.()}>
                  NFC einschalten
                </Button>
              </div>
            ) : null}
          </div>
        </Callout>
      ) : null}
      {phone && inspect?.busy ? <p class="soft small">{inspect.tapped ? 'Lese die Karte …' : 'Halte die Karte an die Rückseite deines Handys.'}</p> : null}

      {inspect && !inspect.busy && reader ? (
        <Callout tone={inspect.error ? 'warning' : 'info'} icon={ScanLine}>
          {inspect.error ?? (
            <div class="stack tight">
              <span>{inspect.text}</span>
              {inspect.tapped && !running && firstOpen >= 0 ? (
                <div>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={Nfc}
                    onClick={() => {
                      setInspect(null);
                      void runFrom(firstOpen);
                    }}
                  >
                    „{items[firstOpen].title}“ auf diese Karte schreiben
                  </Button>
                </div>
              ) : null}
              {inspect.data ? <ReadCardActions data={inspect.data} /> : null}
            </div>
          )}
        </Callout>
      ) : null}
      {erase && reader ? (
        <DeleteCardDialog
          nfc={nfc}
          reader={reader}
          onClose={() => {
            setErase(false);
            setInspect(null);
          }}
        />
      ) : null}

      {reader ? (
        <>
          <div class={`reader-stage phase-${phase}`} aria-live="polite" ref={stage}>
            {phase === 'idle' ? (
              <>
                <p>
                  {items.length === 1 ? 'Eine Karte' : `${items.length} Karten`} der Reihe nach beschreiben.{' '}
                  {phone
                    ? 'Halte jede Karte an die Rückseite deines Handys und nimm sie weg, wenn sie fertig ist.'
                    : 'Lege jede Karte mittig auf den Leser und nimm sie ab, wenn sie fertig ist.'}
                </p>
                {phone ? <p class="soft small">Die NFC-Stelle ist meist in der Mitte der Rückseite, bei manchen Handys oben bei der Kamera.</p> : null}
                <Button variant="primary" size="lg" icon={Nfc} onClick={() => runFrom(firstOpen < 0 ? 0 : firstOpen)}>
                  {doneCount ? 'Weiter beschreiben' : items.length === 1 ? 'Karte beschreiben' : 'Karten beschreiben'}
                </Button>
              </>
            ) : null}
            {phase === 'waiting' ? (
              <>
                <span class="reader-step">
                  Karte {current + 1} von {items.length}
                </span>
                <p class="reader-big">
                  {phone ? 'Halte' : 'Lege'} die Karte für <strong>„{item.title}“</strong> {phone ? 'an die Rückseite deines Handys' : 'auf den Leser'}.
                </p>
                <Spinner size={22} />
              </>
            ) : null}
            {phase === 'writing' ? (
              <>
                <span class="reader-step">
                  Karte {current + 1} von {items.length}
                </span>
                <p class="reader-big">
                  Schreibe „{item.title}“ … {phone ? `Karte am ${handheldWord()} lassen.` : 'Karte liegen lassen.'}
                </p>
                <Spinner size={22} />
              </>
            ) : null}
            {phase === 'remove' ? (
              <>
                <CircleCheck size={34} class="reader-ok" />
                <p class="reader-big">Fertig! Nimm die Karte {phone ? 'weg' : 'ab'}.</p>
                {results[item.key]?.before ? <p class="soft small">Vorher stand darauf: {results[item.key]!.before}</p> : null}
              </>
            ) : null}
            {phase === 'clash' && clash ? (
              <>
                <CircleAlert size={34} class="reader-bad" />
                <p class="reader-big">{clashItem ? `Diese Karte hast du gerade für „${clashItem.title}“ beschrieben.` : 'Diese Karte hast du gerade schon beschrieben.'}</p>
                <p>
                  {phone ? (
                    <>
                      Nimm sie weg und halte eine andere Karte für <strong>„{item.title}“</strong> ans {handheldWord()}.
                    </>
                  ) : (
                    <>
                      Nimm sie ab und lege eine andere Karte für <strong>„{item.title}“</strong> auf.
                    </>
                  )}
                </p>
                <div class="row wrap" style={{ justifyContent: 'center' }}>
                  <Button onClick={() => runFrom(current, clash.uid)}>Trotzdem überschreiben</Button>
                </div>
                {clashItem ? <p class="soft small">Überschreibst du sie, braucht „{clashItem.title}“ eine neue Karte.</p> : null}
              </>
            ) : null}
            {phase === 'occupied' && occupied ? (
              <>
                <CircleAlert size={34} class="reader-bad" />
                <p class="reader-big">Auf dieser Karte steht schon etwas.</p>
                {/* Two rows instead of „Jetzt: Album: Ordner 12 …“ with two colons in one line. */}
                <dl class="reader-swap">
                  <dt>Jetzt</dt>
                  <dd>{readCardText(occupied.data)}</dd>
                  <dt>Neu</dt>
                  <dd>
                    <strong>„{item.title}“</strong>
                    {item.summary ? ` (${item.summary})` : ''}.
                  </dd>
                </dl>
                <p class="soft small">
                  {phone ? `Nimm sie weg und halte eine leere Karte ans ${handheldWord()}, oder überschreibe sie.` : 'Nimm sie ab und lege eine leere Karte auf, oder überschreibe sie.'}
                </p>
                <div class="row wrap" style={{ justifyContent: 'center' }}>
                  <Button onClick={() => runFrom(current, occupied.uid)}>Überschreiben</Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      memory.current.overwriteAll = true;
                      void runFrom(current, occupied.uid);
                    }}
                  >
                    Immer überschreiben
                  </Button>
                </div>
              </>
            ) : null}
            {phase === 'error' ? (
              <>
                <CircleAlert size={34} class="reader-bad" />
                <p class="reader-big">„{item.title}“ hat nicht geklappt.</p>
                <p>{results[item.key]?.message}</p>
                <HintList hints={results[item.key]?.hints ?? []} />
                <div class="row wrap" style={{ justifyContent: 'center' }}>
                  {results[item.key]?.code === 'nfc-off' && nfc.openSettings ? (
                    <Button icon={Nfc} onClick={() => nfc.openSettings?.()}>
                      NFC einschalten
                    </Button>
                  ) : null}
                  <Button variant="primary" onClick={() => runFrom(current)}>
                    Noch einmal versuchen
                  </Button>
                  {current < items.length - 1 ? (
                    <Button icon={SkipForward} onClick={() => runFrom(current + 1)}>
                      Diese Karte überspringen
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
            {phase === 'done' ? (
              <>
                <CircleCheck size={34} class="reader-ok" />
                <p class="reader-big">
                  {doneCount === items.length ? 'Alle Karten sind beschrieben.' : `${doneCount} von ${items.length} Karten sind beschrieben.`}
                </p>
                <div class="row wrap" style={{ justifyContent: 'center' }}>
                  {firstOpen >= 0 ? (
                    <Button variant="primary" icon={Nfc} onClick={() => runFrom(firstOpen)}>
                      Fehlende Karten beschreiben
                    </Button>
                  ) : null}
                  <Button onClick={restart}>Noch einmal von vorn</Button>
                </div>
              </>
            ) : null}
            {running ? (
              <Button size="sm" variant="ghost" icon={Square} onClick={stop}>
                Anhalten
              </Button>
            ) : null}
          </div>

          <ol class="reader-queue">
            {items.map((i, n) => {
              const r = results[i.key];
              const active = running && n === current;
              return (
                <li key={i.key} class={`${active ? 'active' : ''} ${r?.status ?? ''}`}>
                  <span class="reader-queue-icon">{r?.status === 'done' ? <CircleCheck size={16} /> : r?.status === 'error' ? <CircleAlert size={16} /> : n + 1}</span>
                  <span class="grow ellipsis">{i.title}</span>
                  <span class="soft small ellipsis">{i.summary}</span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </div>
  );
}

async function diagnose(nfc: NfcAccess): Promise<Hint[]> {
  const d = (nfc as NfcAccess & { diagnose?: () => Promise<Hint[]> }).diagnose;
  if (!d) return [];
  try {
    return await d.call(nfc);
  } catch {
    return [];
  }
}

/** A card held to the phone, as the result of "Karte prüfen" shows it. */
function tappedInspect(t: TappedCard): { busy: boolean; text?: string; error?: string; data?: Uint8Array; tapped: boolean } {
  if (t.busy) return { busy: true, tapped: true };
  if (!t.data) return { busy: false, error: t.error ?? 'Die Karte konnte nicht gelesen werden.', tapped: true };
  return { busy: false, text: tappedText({ data: t.data, type: t.type, uid: t.uid }), data: t.data, tapped: true };
}

/** What the card holds, its type and number, in the words of "Karte prüfen". */
export function tappedText(t: { data: Uint8Array; type: string; uid: string }): string {
  return `${readCardText(t.data)} Kartentyp: ${cardTypeName(t.type)}, Nummer ${t.uid}.`;
}

export function cardTypeName(t: string): string {
  switch (t) {
    case 'mifare-classic-1k':
      return 'MIFARE Classic 1K';
    case 'mifare-classic-4k':
      return 'MIFARE Classic 4K';
    case 'mifare-classic-mini':
      return 'MIFARE Mini';
    case 'mifare-ultralight':
      return 'NTAG / Ultralight';
    case 'ntag213':
    case 'ntag215':
    case 'ntag216':
      return t.toUpperCase();
    default:
      return 'unbekannt';
  }
}
