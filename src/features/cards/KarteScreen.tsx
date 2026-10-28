/**
 * „Karte beschreiben“ (0.6, 06-entwuerfe 1-karte-*): one card at a time.
 * The folder as a big number with − and + (TonUINO NFC Tools, #132), one
 * sentence what the card plays, how it plays as four rows, and the one
 * button. With the USB reader or the phone's own NFC the card is written
 * right here, read back and the next folder offered; the other ways (at the
 * box, QR code, USB or WLAN to the box) open their panel of „Karten
 * beschreiben“ for this one card. Many cards at once stay on #/karten.
 */
import { effect, signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { CardData } from '../../core/tonuino/card';
import type { FolderCard } from '../../core/tonuino/catalog';
import { folderName } from '../../core/tonuino/sd';
import type { NfcCardInfo } from '../../platform/types';
import { Dialog } from '../../ui/components/Dialog';
import { Button } from '../../ui/components/controls';
import { errorHints, errorText, HintList, type Hint } from '../../ui/components/Hints';
import { ChoiceList, NumberField, Screen, type Choice } from '../../ui/components/Schlank';
import { playCue } from '../../ui/sound';
import { quietMoment } from '../../ui/quiet';
import { PHONE_QUERY, useMedia } from '../../ui/useMedia';
import { boxScan, card, catalog, chooseCardMethod, coverUrlFor, plat, profile, settings, type CardMethod } from '../../app/state';
import { lazyPage } from '../../app/lazyPage';
import { routeToHash } from '../../app/router';
import { handheldWord } from '../../app/device';
import { boxWritesCards } from '../workshop/writeability';
import { folderSticker } from '../stickers/content';
import { useCoverless } from '../stickers/coverless';
import { autoCovers, openProposals } from '../covers/autoCoverState';
import { ProposalPictures } from '../covers/CoverOffer';
import { drawStickerAhead, StickerBild, stickerSizeMm } from '../stickers/StickerBild';
import { folderCardData } from './items';
import { ModePicker } from './ModePicker';
import { holdTaps } from './nfcTap';
import { readCardText } from './ReadCardActions';
import { newRunMemory, writeCards, type ReaderPort } from './readerRun';
import { cardLine, folderWords, FRONT_MODES, isFrontCard, modeName, nextFolder, singleItem } from './single';
import { trackCounts } from './items';

/** The folder and how its card plays, kept while one looks at another screen. */
const chosenFolder = signal<number | null>(null);
/** How the card plays when picked here; null: as the folder's own card plays (catalog), Hörbuch for a folder the app does not know. */
const chosenPlay = signal<Required<FolderCard> | null>(null);

/* ------------------------------------------------------------------ the ways of writing */

interface Way {
  id: CardMethod;
  /** In „Schreiben mit: …“. */
  name: string;
  text: string;
}

const CoverDialog = lazyPage(() => import('../box/CoverDialog').then((m) => m.CoverDialog));
// The ways to write a card come when needed (0.6, #121): with them came the Werkstatt's USB tools and the log of the box.
const BoxPanel = lazyPage(() => import('./BoxPanel').then((m) => m.BoxPanel));
const QrPanel = lazyPage(() => import('./QrPanel').then((m) => m.QrPanel));
const ReaderPanel = lazyPage(() => import('./ReaderPanel').then((m) => m.ReaderPanel));
const UsbPanel = lazyPage(() => import('./UsbPanel').then((m) => m.UsbPanel));
const WifiPanel = lazyPage(() => import('./WifiPanel').then((m) => m.WifiPanel));
const PANELS = { box: BoxPanel, qr: QrPanel, reader: ReaderPanel, usb: UsbPanel, wifi: WifiPanel } as const;
/** The box's log connection (Werkstatt), once its code is loaded: it may know that the box writes cards itself. */
const logSessionModule = signal<typeof import('../workshop/logsession') | null>(null);

function waysHere(): Way[] {
  const p = plat();
  const caps = p.capabilities;
  const ways: Way[] = [];
  if (p.nfc.phone) ways.push({ id: 'reader', name: `dem ${handheldWord()}`, text: `Halte die Karte an die Rückseite. Das ${handheldWord()} schreibt sie selbst.` });
  else if (caps.nfcReader) ways.push({ id: 'reader', name: 'USB-Leser', text: 'NFC-Leser am USB, z. B. ACR122U. Am schnellsten.' });
  ways.push({ id: 'box', name: 'an der Box', text: 'Schritt für Schritt mit den Tasten der Box. Ohne Zubehör.' });
  if (!p.mobile) ways.push({ id: 'qr', name: 'QR-Code fürs Handy', text: 'Android-Handy mit NFC: QR-Code scannen, Karte ans Handy halten.' });
  if (caps.serial && (boxWritesCards.value || logSessionModule.value?.logSession.writeAbility.value === 'yes' || settings.value.cardMethod === 'usb')) ways.push({ id: 'usb', name: 'USB an die Box', text: 'Die Box schreibt die Karte selbst. Vorschau, bis die offizielle Firmware das kann.' });
  if (caps.wifiBox) ways.push({ id: 'wifi', name: 'WLAN an die Box', text: 'Für Boxen mit ESP32. Ich schicke die Karte über dein WLAN an die Box.' });
  return ways;
}

/* ------------------------------------------------------------------ writing one card with the reader or the phone */

type Sheet =
  | { kind: 'hold'; data: CardData }
  | { kind: 'writing'; data: CardData }
  | { kind: 'clash'; data: CardData; uid: string }
  | { kind: 'occupied'; data: CardData; uid: string; now: string }
  | { kind: 'done'; data: CardData; checked: boolean | null }
  | { kind: 'error'; data: CardData; message: string; hints: Hint[]; code?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

/** The USB reader or the phone: found once, then one card after the other, each read back. */
function useWriter(enabled: boolean) {
  const nfc = plat().nfc;
  const [reader, setReader] = useState<string | null | undefined>(undefined);
  const [setup, setSetup] = useState<{ message: string; hints: Hint[]; code?: string } | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [onReader, setOnReader] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** Which card holds which item, across „Nächste Karte“: a card still held is not overwritten unasked. */
  const memory = useRef(newRunMemory());
  const copies = useRef(0);
  const idle = useRef<Promise<void>>(Promise.resolve());
  const idleStop = useRef<(() => void) | null>(null);

  const find = async () => {
    setSetup(null);
    setReader(undefined);
    try {
      const list = await nfc.listReaders();
      setReader(list[0] ?? null);
      if (!list.length) setSetup({ message: nfc.phone ? `Dieses ${handheldWord()} hat kein NFC. Nimm einen anderen Weg, zum Beispiel „an der Box“.` : 'Kein NFC-Leser gefunden. Stecke den Leser ein und warte einen Moment.', hints: [] });
    } catch (e) {
      setReader(null);
      setSetup({ message: errorText(e), hints: errorHints(e), code: codeOf(e) });
    }
  };

  useEffect(() => {
    if (!enabled || !nfc.supported) return undefined;
    void find();
    const stop = nfc.onStateChange?.(() => {
      if (!abort.current) void find();
    });
    return () => {
      stop?.();
      abort.current?.abort();
      idleStop.current?.();
    };
  }, [enabled]);

  // The USB reader while nothing is written: says whether a card lies on it and what it holds (hörbert: the state shows at the thing).
  useEffect(() => {
    if (!enabled || !reader || nfc.phone || sheet) return undefined;
    let on = true;
    idleStop.current = () => void (on = false);
    idle.current = (async () => {
      let shown: string | null = null;
      while (on) {
        let c: NfcCardInfo | null = null;
        try {
          c = await nfc.waitForCard(reader, 1500);
        } catch {
          c = null;
        }
        if (!on) break;
        if (!c) {
          if (shown !== null) setOnReader((shown = null));
          continue;
        }
        if (c.uid !== shown) {
          try {
            const r = await nfc.read(reader);
            if (on) setOnReader(readCardText(r.data));
          } catch {
            if (on) setOnReader('Auf dem Leser liegt eine Karte.');
          }
          shown = c.uid;
        }
        await sleep(400);
      }
    })();
    return () => {
      on = false;
    };
  }, [enabled, reader, sheet === null]);

  const port = (r: string): ReaderPort => ({
    waitForCard: async (signal) => {
      while (!signal.aborted) {
        const c = await nfc.waitForCard(r, 1500);
        if (c) return c;
      }
      return null;
    },
    waitForRemoval: async (uid, signal) => {
      while (!signal.aborted) {
        const c = await nfc.waitForCard(r, 250);
        if (!c || c.uid !== uid) return true;
        await sleep(350);
      }
      return false;
    },
    read: () => nfc.read(r),
    write: (data, uid) => nfc.write(r, data, uid),
  });

  const start = async (data: CardData, title: string | undefined, overwrite?: string) => {
    if (!reader) return;
    abort.current?.abort();
    idleStop.current?.();
    await idle.current;
    const ctrl = new AbortController();
    abort.current = ctrl;
    const item = singleItem(data, { title, profile: profile.value, copy: ++copies.current });
    let checked: boolean | null = null;
    setSheet({ kind: 'hold', data });
    const release = holdTaps();
    try {
      const end = await writeCards(
        [item],
        0,
        port(reader),
        memory.current,
        {
          waiting: () => setSheet({ kind: 'hold', data }),
          clash: (uid) => setSheet({ kind: 'clash', data, uid }),
          occupied: (uid, raw) => setSheet({ kind: 'occupied', data, uid, now: readCardText(raw) }),
          writing: () => setSheet({ kind: 'writing', data }),
          verified: (_key, ok) => void (checked = ok),
          written: () => {
            void playCue('cardWritten');
            setSheet({ kind: 'done', data, checked });
          },
          remove: () => {},
        },
        ctrl.signal,
        overwrite,
      );
      if (end.kind === 'failed') setSheet({ kind: 'error', data, message: errorText(end.error), hints: errorHints(end.error), code: codeOf(end.error) });
    } catch (e) {
      if (!ctrl.signal.aborted) setSheet({ kind: 'error', data, message: errorText(e), hints: errorHints(e), code: codeOf(e) });
    } finally {
      release();
      if (abort.current === ctrl) abort.current = null;
    }
  };

  const close = () => {
    abort.current?.abort();
    abort.current = null;
    setSheet(null);
  };

  return { reader, setup, sheet, onReader, find, start, close };
}

/* ------------------------------------------------------------------ the screen */

export function KarteScreen({ folder: asked }: { folder?: number }) {
  const phone = useMedia(PHONE_QUERY);
  const narrow = useMedia('(max-width: 900px)');
  const scan = boxScan.value;
  const cat = catalog.value;
  // A link to a folder (#/karte/14, „Karte dafür beschreiben“) picks it.
  useEffect(() => {
    if (asked) {
      chosenFolder.value = asked;
      chosenPlay.value = null;
    }
  }, [asked]);
  const firstOnBox = useMemo(() => {
    const numbers = [...(scan?.folders.map((f) => f.number) ?? []), ...Object.keys(cat?.folders ?? {}).map(Number)].filter((n) => n >= 1 && n <= 99);
    return numbers.length ? Math.min(...numbers) : 1;
  }, [scan, cat]);
  const folder = chosenFolder.value ?? firstOnBox;
  const entry = cat?.folders[folderName(folder)];
  const own = folderCardData(folder, entry?.card, entry?.kind);
  const play = chosenPlay.value ?? { mode: own.mode, special: own.special ?? 0, special2: own.special2 ?? 0 };
  const data: CardData = { folder, mode: play.mode, special: play.special, special2: play.special2 };
  const counts = useMemo(() => trackCounts(scan), [scan]);
  const item = singleItem(data, { title: entry?.title, trackCount: scan ? (n) => counts.get(n) : undefined, profile: profile.value, release: settings.value.tngRelease });

  const ways = waysHere();
  const way = ways.find((w) => w.id === settings.value.cardMethod) ?? ways[0];
  const direct = way.id === 'reader' && plat().nfc.supported;
  const writer = useWriter(direct);
  // The chosen way's code ahead of the click, after the page is drawn; the log connection only where there is USB to the box.
  useEffect(() => {
    void PANELS[way.id as keyof typeof PANELS]?.preload();
    if (plat().capabilities.serial && !logSessionModule.value) void import('../workshop/logsession').then((m) => (logSessionModule.value = m));
  }, [way.id]);
  const [otherModes, setOtherModes] = useState(false);
  const [pickFolder, setPickFolder] = useState(false);
  const [chooseWay, setChooseWay] = useState(false);
  const [panel, setPanel] = useState(false);

  const setFolder = (n: number) => {
    chosenFolder.value = n;
  };
  const write = () => {
    if (direct && writer.reader) void writer.start(data, entry?.title);
    else if (direct) void writer.find();
    else setPanel(true);
  };

  const choices: Choice<number>[] = FRONT_MODES.map((m) => ({ value: m.mode, name: m.name, text: m.text }));
  // A card picked under „Andere Arten …“ shows as its own row, chosen.
  if (!isFrontCard(play)) choices.push({ value: -1, name: modeName(play.mode), text: cardLine(data).split(' · ').slice(2).join(' · ') || undefined });
  const chosenRow = isFrontCard(play) ? play.mode : -1;

  // What is in the folder, from the same scan the card beside it shows (Prüfrunde 1, bastler 16).
  const inFolder = scan ? (counts.get(folder) ?? 0) : undefined;
  const sentence = (
    <p class="satz">
      Spielt Ordner {folder}.{' '}
      <span class="muted">{folderWords(entry?.title, inFolder)}</span>
    </p>
  );
  const warning = item.unsupported ?? item.needs;
  const [findCover, setFindCover] = useState(false);
  // A folder on the card without a cover: the hits of the background search to tap, or „Cover suchen …“.
  const bare = useCoverless([folder])[0];
  const proposal = bare ? openProposals(autoCovers.value, (n) => !!coverUrlFor(n)).find((p) => p.folder === folder) : undefined;
  // A cover there can be changed where it is seen, also one the background search took (Prüfrunde 1 B9).
  const hasCover = !bare && !!entry && !!coverUrlFor(folder);
  const fromBox = !!cat && !!Object.keys(cat.folders).length && !phone;
  const coverLine = proposal ? (
    <div class="cover-zeile">
      Noch kein Cover. Passt eins davon?
      <ProposalPictures proposal={proposal} max={4} />
    </div>
  ) : null;
  // „Cover suchen …“ and „Aus der Box wählen …“ share a line: the column has no room for two in a low window (Prüfrunde 1 B4).
  const links =
    (bare && !proposal) || hasCover || fromBox ? (
      <p class="karte-links">
        {bare && !proposal ? (
          <span>
            Noch kein Cover.{' '}
            <button type="button" class="link-button" onClick={() => setFindCover(true)}>
              Cover suchen …
            </button>
          </span>
        ) : hasCover ? (
          <button type="button" class="link-button" onClick={() => setFindCover(true)}>
            Cover ändern …
          </button>
        ) : null}
        {fromBox ? (
          <button type="button" class="link-button" onClick={() => setPickFolder(true)}>
            Aus der Box wählen …
          </button>
        ) : null}
      </p>
    ) : null;

  const big = narrow ? undefined : <BigCard folder={folder} title={entry?.title || `Ordner ${folderName(folder)}`} note={stateNote(direct, writer, way)} />;

  return (
    <>
      <Screen
        name="karte"
        title="Karte beschreiben"
        big={big}
        bigClass="karte-platz"
        help={routeToHash({ page: 'help', topic: 'karten' })}
        foot={
          <>
            {warning ? <p class="zeile-warn">{warning}</p> : null}
            {/* On the phone the line shows only when another way than the phone itself is chosen (06-entwuerfe: the button alone). */}
            {!narrow || (ways.length > 1 && !(direct && plat().nfc.phone)) ? (
              <p class="zeile-klein">
                Schreiben mit: <b>{way.name}</b>
                {ways.length > 1 ? (
                  <>
                    {' · '}
                    <button type="button" class="link-button" onClick={() => setChooseWay(true)}>
                      ändern
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            <Button variant="primary" class="xl wide" onClick={write} disabled={!!item.unsupported}>
              Karte beschreiben
            </Button>
          </>
        }
      >
        <div class="frage">
          <h2 id="karte-ordner">Ordner</h2>
          <NumberField value={folder} onChange={setFolder} label="Ordner" />
          {sentence}
          {coverLine}
          {links}
        </div>
        <div class="frage">
          <h2 id="karte-art">So spielt die Karte</h2>
          <ChoiceList
            label="So spielt die Karte"
            value={chosenRow}
            choices={choices}
            onChange={(m) => {
              if (m >= 0) chosenPlay.value = { mode: m, special: 0, special2: 0 };
            }}
          />
          <button type="button" class="link-button mehr-link" onClick={() => setOtherModes(true)}>
            Andere Arten …
          </button>
        </div>
      </Screen>

      {writer.sheet ? (
        <WriteSheet
          sheet={writer.sheet}
          phone={!!plat().nfc.phone}
          onCancel={writer.close}
          onOverwrite={(uid) => void writer.start(writer.sheet!.data, entry?.title, uid)}
          onAgain={() => void writer.start(writer.sheet!.data, entry?.title)}
          onNext={(n) => {
            setFolder(n);
            const e = cat?.folders[folderName(n)];
            const nextOwn = folderCardData(n, e?.card, e?.kind);
            const p = chosenPlay.value ?? { mode: nextOwn.mode, special: nextOwn.special ?? 0, special2: nextOwn.special2 ?? 0 };
            void writer.start({ folder: n, mode: p.mode, special: p.special, special2: p.special2 }, e?.title);
          }}
        />
      ) : null}
      {direct && writer.setup && !writer.sheet ? <SetupNote setup={writer.setup} onRetry={writer.find} /> : null}
      {otherModes ? <OtherModesDialog folder={folder} value={play} onClose={() => setOtherModes(false)} onPick={(v) => (chosenPlay.value = { mode: v.mode, special: v.special ?? 0, special2: v.special2 ?? 0 })} /> : null}
      {pickFolder ? <FolderPickDialog onClose={() => setPickFolder(false)} onPick={(n) => setFolder(n)} /> : null}
      {chooseWay ? <WayDialog ways={ways} current={way.id} onClose={() => setChooseWay(false)} /> : null}
      {panel ? <WayPanel way={way} item={item} onClose={() => setPanel(false)} /> : null}
      {findCover && (bare || hasCover) ? <CoverDialog folder={folder} query={bare?.query || entry?.title || ''} onClose={() => setFindCover(false)} /> : null}
    </>
  );
}

/** What the reader says under the card on a computer: none, a card on it, or what to do. */
function stateNote(direct: boolean, writer: ReturnType<typeof useWriter>, way: Way): string {
  if (!direct) return way.id === 'box' ? 'Du schreibst die Karte an der Box. Ich zeige dir, welche Taste du drückst.' : way.text;
  if (writer.reader === undefined) return 'Suche den NFC-Leser …';
  if (!writer.reader) return 'Kein NFC-Leser gefunden. Stecke den Leser ein.';
  if (writer.onReader) return `Auf dem Leser liegt eine Karte. ${writer.onReader}`;
  return 'Noch keine Karte auf dem Leser. Lege eine leere Karte drauf.';
}

/** The card in its real shape (85,6 × 54 mm) with the folder's sticker on it, lying like paper on the table. */
// Kept from the last start too: the window has its size again, so the sticker can be drawn ahead (drawKarteAhead).
const WIDTH_KEY = 'tonuino-studio:karte-breite';
let bigCardWidth = (() => {
  try {
    return Math.max(0, Math.floor(Number(localStorage.getItem(WIDTH_KEY)) || 0));
  } catch {
    return 0;
  }
})();

/** The sticker's width on the card of `width` px, a little smaller than the card, as stuck on by hand. */
function stickerOnCardPx(width: number): number {
  const sticker = stickerSizeMm();
  const fit = Math.min((85.6 - 1.8) / sticker.widthMm, (54 - 3.2) / sticker.heightMm, 1);
  return Math.round(sticker.widthMm * fit * (width / 85.6));
}

/** Once after the start: when the first card is read, its sticker for „Karte beschreiben“ in a quiet moment (drawKarteAhead). */
export function installKarteAhead(): void {
  let done = false;
  const stop = effect(() => {
    if (done || card.value?.status !== 'ready') return;
    done = true;
    queueMicrotask(() => stop());
    void quietMoment(1500).then(drawKarteAhead);
  });
}

/** The folder „Karte beschreiben“ shows when it opens: the one picked last, else the first on the box. */
function shownFolder(): number {
  const scan = boxScan.value;
  const numbers = [...(scan?.folders.map((f) => f.number) ?? []), ...Object.keys(catalog.value?.folders ?? {}).map(Number)].filter((n) => n >= 1 && n <= 99);
  return chosenFolder.value ?? (numbers.length ? Math.min(...numbers) : 1);
}

/**
 * The sticker on the card of „Karte beschreiben“, drawn ahead in a quiet moment after the card was
 * read: on its first visit the card showed empty and white for a moment, then the sticker jumped
 * in (Prüfrunde 2, webkit W1). At the card's width of the last visit, so only when there was one.
 */
export async function drawKarteAhead(): Promise<void> {
  // Without the big card (a narrow window, a phone) there is nothing to draw.
  if (!bigCardWidth || !catalog.value || matchMedia('(max-width: 900px)').matches) return;
  const folder = shownFolder();
  const title = catalog.value.folders[folderName(folder)]?.title || `Ordner ${folderName(folder)}`;
  await drawStickerAhead(folderSticker(folder, title), stickerOnCardPx(bigCardWidth));
}

function BigCard({ folder, title, note }: { folder: number; title: string; note: string }) {
  const place = useRef<HTMLDivElement>(null);
  // The width from the last visit, so the card stands in the first frame; measured again before paint (Prüfrunde 1 Aussehen 2).
  const [width, setWidth] = useState(bigCardWidth);
  useLayoutEffect(() => {
    const el = place.current;
    if (!el) return undefined;
    const fit = () => {
      // Seven tenths of the place, and low enough for the line under it: 680 px at 1440, 980 px at 2000 (06-entwuerfe).
      if (!el.clientWidth) return;
      const w = Math.min(el.clientWidth * 0.72, ((el.clientHeight - 90) * 85.6) / 54, 980);
      const was = bigCardWidth;
      bigCardWidth = Math.max(240, Math.floor(w));
      setWidth(bigCardWidth);
      if (bigCardWidth !== was) {
        try {
          localStorage.setItem(WIDTH_KEY, String(bigCardWidth));
        } catch {
          // Not kept: the next start draws the sticker when the page shows.
        }
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mm = width / 85.6;
  // The sticker as big as it fits on the card, a little off the middle like stuck on by hand.
  const item = folderSticker(folder, title);
  return (
    <div class="karte-ort" ref={place}>
      {width ? (
        <div class="karte-gross" style={{ width: `${width}px`, height: `${(width * 54) / 85.6}px`, borderRadius: `${Math.round(3.2 * mm)}px` }}>
          <span class="karte-sticker" style={{ left: `${0.9 * mm}px`, top: `${1.6 * mm}px` }}>
            <StickerBild item={item} widthPx={stickerOnCardPx(width)} name={`Sticker für Ordner ${folderName(folder)}`} />
          </span>
        </div>
      ) : null}
      <p class="zustand" aria-live="polite">
        {note}
      </p>
      {/* Where the card is looked at, the way to the help for a card the box ignores (Prüfrunde 1 B6). */}
      <a class="link-button karte-hilfe" href={routeToHash({ page: 'help', topic: 'karte-geht-nicht' })}>
        Box reagiert nicht auf die Karte?
      </a>
    </div>
  );
}

/** The phone held to the card, or the card on the reader: drawn as in 06-entwuerfe (teile.js, handyKarteArt). */
function PhoneCardArt({ folder }: { folder: number }) {
  return (
    <svg width="190" viewBox="0 0 200 170" aria-hidden="true" class="blatt-bild">
      <g stroke="#2a1f16" stroke-linejoin="round" stroke-linecap="round">
        <path d="M52 12 L121 10 C128 10 132 14 132 21 L134 158 C134 164 130 167 124 167 L56 168 C49 168 45 164 45 157 L44 21 C44 15 47 12 52 12 Z" fill="#4a423b" stroke-width="3.5" />
        <rect x="56" y="22" width="26" height="34" rx="7" fill="#2f2924" stroke-width="2.6" />
        <circle cx="69" cy="32" r="5" fill="#1a1512" stroke-width="2" />
        <circle cx="69" cy="46" r="5" fill="#1a1512" stroke-width="2" />
        <g transform="translate(96 66) rotate(-8)">
          <rect x="-58" y="-30" width="104" height="66" rx="6" fill="#fffcf5" stroke-width="3.2" />
          <rect x="-52" y="-24" width="9" height="54" fill="#f7941d" stroke="none" />
          <rect x="-40" y="-24" width="36" height="36" fill="#f7941d" stroke-width="1.8" />
          <text x="-22" y="1" text-anchor="middle" class="blatt-nr" font-size="20" fill="#fff" stroke="none">
            {folderName(folder)}
          </text>
          <path d="M2 -18 H38 M2 -10 H30" stroke-width="3" opacity="0.8" />
        </g>
        <g fill="none" stroke-width="3">
          <path d="M160 46 C168 56 168 72 160 82" />
          <path d="M172 38 C184 52 184 76 172 90" />
        </g>
      </g>
    </svg>
  );
}

/** A tick drawn with the felt pen. */
export function Haken({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true" class="haken">
      <path d="M6 24 C10 27 14 31 17 37 C23 24 30 14 39 6" fill="none" stroke="#4d8a2a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** After the tap: a sheet from below (phone) or in the middle (computer) with what happens now. */
function WriteSheet({ sheet, phone, onCancel, onOverwrite, onAgain, onNext }: { sheet: Sheet; phone: boolean; onCancel: () => void; onOverwrite: (uid: string) => void; onAgain: () => void; onNext: (folder: number) => void }) {
  const d = sheet.data;
  const what = (
    <>
      Ordner <b>{d.folder}</b> · <b>{cardLine(d).split(' · ').slice(1).join(' · ')}</b>
    </>
  );
  const next = nextFolder(d.folder);
  const where = phone ? `ans ${handheldWord()}` : 'auf den Leser';
  let body;
  switch (sheet.kind) {
    case 'hold':
    case 'writing':
      body = (
        <>
          {phone ? (
            <div class="blatt-bildzeile">
              <PhoneCardArt folder={d.folder} />
            </div>
          ) : null}
          <h2>{sheet.kind === 'writing' ? 'Ich schreibe …' : phone ? `Halte die Karte jetzt hinten ans ${handheldWord()}` : 'Lege die Karte jetzt auf den Leser'}</h2>
          <p class="was">
            {what}. {sheet.kind === 'writing' ? (phone ? 'Halte sie ruhig.' : 'Lasse sie liegen.') : phone ? 'Ich schreibe, sobald sie da ist. Halte sie ruhig, bis es brummt.' : 'Ich schreibe, sobald sie da ist.'}
          </p>
          <div class="knoepfe">
            <Button size="lg" class="wide" onClick={onCancel}>
              Abbrechen
            </Button>
          </div>
        </>
      );
      break;
    case 'done':
      body = (
        <>
          <div class="kopfzeile">
            <Haken size={48} />
            <h2 class="fertig">Fertig.</h2>
          </div>
          <p class="was">
            Auf der Karte steht jetzt:
            <br />
            <b class="was-gross">{cardLine(d)}</b>
          </p>
          <p class={sheet.checked === false ? 'zeile-warn' : 'soft'}>
            {sheet.checked === true
              ? 'Ich hab sie gleich noch mal gelesen, es stimmt.'
              : sheet.checked === false
                ? 'Beim Nachlesen stand etwas anderes darauf. Schreibe sie lieber noch einmal.'
                : 'Nachlesen ging nicht, die Karte war schon weg.'}
          </p>
          <div class="knoepfe">
            {sheet.checked === false ? (
              <Button variant="primary" class="xl wide" onClick={onAgain}>
                Noch einmal schreiben
              </Button>
            ) : next ? (
              <Button variant="primary" class="xl wide" onClick={() => onNext(next)}>
                Nächste Karte: Ordner {next}
              </Button>
            ) : null}
            <Button size="lg" class="wide" onClick={onCancel}>
              Das war's
            </Button>
          </div>
        </>
      );
      break;
    case 'clash':
      body = (
        <>
          <h2>Diese Karte hast du gerade schon beschrieben.</h2>
          <p class="was">Nimm sie weg und halte eine andere Karte {where}. Sie bekommt {what}.</p>
          <div class="knoepfe">
            <Button size="lg" class="wide" onClick={() => onOverwrite(sheet.uid)}>
              Trotzdem überschreiben
            </Button>
            <Button size="lg" class="wide" onClick={onCancel}>
              Abbrechen
            </Button>
          </div>
        </>
      );
      break;
    case 'occupied':
      body = (
        <>
          <h2>Auf dieser Karte steht schon etwas.</h2>
          <dl class="reader-swap">
            <dt>Jetzt</dt>
            <dd>{sheet.now}</dd>
            <dt>Neu</dt>
            <dd>{cardLine(d)}</dd>
          </dl>
          <p class="soft">Nimm eine leere Karte, oder überschreibe diese.</p>
          <div class="knoepfe">
            <Button variant="primary" class="xl wide" onClick={() => onOverwrite(sheet.uid)}>
              Überschreiben
            </Button>
            <Button size="lg" class="wide" onClick={onCancel}>
              Abbrechen
            </Button>
          </div>
        </>
      );
      break;
    case 'error':
      body = (
        <>
          <h2>Das hat nicht geklappt.</h2>
          <p class="was">{sheet.message}</p>
          <HintList hints={sheet.hints} />
          <div class="knoepfe">
            {sheet.code === 'nfc-off' && plat().nfc.openSettings ? (
              <Button variant="primary" class="xl wide" onClick={() => plat().nfc.openSettings?.()}>
                NFC einschalten
              </Button>
            ) : (
              <Button variant="primary" class="xl wide" onClick={onAgain}>
                Noch einmal versuchen
              </Button>
            )}
            <Button size="lg" class="wide" onClick={onCancel}>
              Abbrechen
            </Button>
          </div>
        </>
      );
      break;
  }
  return (
    <div class="blatt-schleier" role="presentation">
      <section class="blatt" role="dialog" aria-modal="true" aria-label="Karte beschreiben" aria-live="polite">
        {body}
      </section>
    </div>
  );
}

/** No reader, or the phone's NFC switched off: said once, with the way out. */
function SetupNote({ setup, onRetry }: { setup: { message: string; hints: Hint[]; code?: string }; onRetry: () => void }) {
  const nfc = plat().nfc;
  return (
    <div class="karte-setup" role="status">
      <p>{setup.message}</p>
      <HintList hints={setup.hints} />
      <div class="row wrap">
        {setup.code === 'nfc-off' && nfc.openSettings ? (
          <Button size="sm" variant="primary" onClick={() => nfc.openSettings?.()}>
            NFC einschalten
          </Button>
        ) : null}
        <Button size="sm" onClick={onRetry}>
          {nfc.phone ? 'Erneut prüfen' : 'Erneut suchen'}
        </Button>
      </div>
    </div>
  );
}

/** „Andere Arten …“: every way a card can play, as on the cards page, for this one card. */
function OtherModesDialog({ folder, value, onClose, onPick }: { folder: number; value: FolderCard; onClose: () => void; onPick: (v: FolderCard) => void }) {
  const [v, setV] = useState<FolderCard>(value);
  const scan = boxScan.value;
  const tracks = scan?.folders.find((f) => f.number === folder)?.tracks.length ?? 0;
  return (
    <Dialog
      title="Andere Arten"
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onPick(v);
              onClose();
            }}
          >
            Übernehmen
          </Button>
        </>
      }
    >
      <div class="stack">
        <ModePicker profile={profile.value} value={v} onChange={setV} trackCount={tracks} folder={folder} advanced={settings.value.advancedModes} list onLeave={onClose} />
        <p class="soft small">
          Spezialkarten wie die Schlummerkarte oder die Admin-Karte findest du unter <a href={routeToHash({ page: 'cards' })}>Viele Karten auf einmal</a>.
        </p>
      </div>
    </Dialog>
  );
}

/** „Aus der Box wählen …“: the folders of the box with their names. */
function FolderPickDialog({ onClose, onPick }: { onClose: () => void; onPick: (n: number) => void }) {
  const cat = catalog.value;
  const rows = Object.entries(cat?.folders ?? {})
    .map(([k, f]) => ({ n: Number(k), title: f.title }))
    .filter((r) => r.n >= 1 && r.n <= 99)
    .sort((a, b) => a.n - b.n);
  return (
    <Dialog title="Aus der Box wählen" onClose={onClose}>
      <ul class="ordner-wahl">
        {rows.map((r) => (
          <li key={r.n}>
            <button
              type="button"
              onClick={() => {
                onPick(r.n);
                onClose();
              }}
            >
              <span class="num">{folderName(r.n)}</span>
              <span class="ellipsis">{r.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** „Schreiben mit: … · ändern“: the ways this app can write a card. */
function WayDialog({ ways, current, onClose }: { ways: Way[]; current: CardMethod; onClose: () => void }) {
  return (
    <Dialog
      title="Womit schreibst du die Karte?"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Fertig
        </Button>
      }
    >
      <ChoiceList
        label="Womit schreibst du die Karte?"
        value={current}
        choices={ways.map((w) => ({ value: w.id, name: w.name.replace(/^dem /, 'Mit dem '), text: w.text }))}
        onChange={(id) => chooseCardMethod(id)}
        class="wege"
      />
    </Dialog>
  );
}

/** The other ways: the panel of „Karten beschreiben“ for this one card. */
function WayPanel({ way, item, onClose }: { way: Way; item: ReturnType<typeof singleItem>; onClose: () => void }) {
  const items = [item];
  const title = way.id === 'box' ? 'An der Box anlernen' : way.id === 'qr' ? 'Mit dem Handy beschreiben' : way.id === 'usb' ? 'Über USB an die Box' : way.id === 'wifi' ? 'Über WLAN an die Box schicken' : 'Mit dem NFC-Leser beschreiben';
  return (
    <Dialog title={title} width="wide" onClose={onClose}>
      {(() => {
        const Panel = PANELS[way.id as keyof typeof PANELS] ?? ReaderPanel;
        return <Panel items={items} />;
      })()}
    </Dialog>
  );
}
