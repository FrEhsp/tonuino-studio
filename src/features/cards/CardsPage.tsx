import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { Binary, CardSim, CircleAlert, CircleHelp, ClipboardPaste, Ellipsis, FolderInput, History, KeyRound, ListPlus, Monitor, Nfc, Plus, RotateCcw, Smartphone, Speaker, Usb, Wifi, X } from 'lucide-preact';
import { ADMIN_MODE, type FirmwareProfile } from '../../core/tonuino/card';
import { modifiersFor } from '../../core/tonuino/modes';
import { Cover } from '../../ui/components/Cover';
import { MenuButton } from '../../ui/components/Menu';
import { Button, Callout, IconButton, Segmented } from '../../ui/components/controls';
import { arrowKeyHandler } from '../../ui/arrowKeys';
import { toastError } from '../../ui/components/Toast';
import { boxProfile, card, catalog, chooseCardMethod, coverUrlFor, coverUrlForCard, openVolume, plat, profile, profileDecision, setProfile, settings, shownMemory, type CardMethod } from '../../app/state';
import { PROFILE_NAMES, boxDisagrees, sourceText } from '../../core/tonuino/firmwaredetect';
import { route, routeToHash } from '../../app/router';
import { cardIntoDevice, handheldWord } from '../../app/device';
import { foldersNotOnCard, packageState } from '../../app/pending';
import { namesList } from '../../core/tonuino/guide';
import { folderName } from '../../core/tonuino/sd';
import { CardReader } from '../box/CardReader';
import { RememberedBoxes, RememberedNote } from '../box/Remembered';
import { openPackageDialog } from '../box/PackageDialog';
import { DESKTOP_ONLY, phoneCardMethod } from '../settings/options';
import { PhoneFold } from '../../ui/components/PhoneFold';
import { PHONE_QUERY, useMedia } from '../../ui/useMedia';
import { BoxPanel } from './BoxPanel';
import { FolderCardDialog } from './FolderCardDialog';
import { format20, setFormat20 } from './format20';
import { FreeCardDialog } from './FreeCardDialog';
import { FolderModeDialog } from './FolderModeDialog';
import { PasteListDialog } from './PasteListDialog';
import { canRemoveExtra, cardItems, isFolderExtra, isSelected, removeExtraCard, selectAll, setSelected, supportProblem, type CardItem } from './items';
import { QrPanel } from './QrPanel';
import { ReaderPanel, tappedText, writeRequest, writingNow } from './ReaderPanel';
import { tappedCard } from './nfcTap';
import { ReadCardActions } from './ReadCardActions';
import { MODIFIER_ICONS, SpecialCardDialog } from './SpecialCardDialog';
import { WifiPanel } from './WifiPanel';
import { UsbPanel } from './UsbPanel';
import { keepsLogConnection, logSession } from '../workshop/logsession';
import { boxWritesCards } from '../workshop/writeability';
import { softHyphens } from '../../core/stickers/text';
import '../../ui/styles/freecard.css';

interface MethodInfo {
  id: CardMethod;
  icon: LucideIcon;
  title: string;
  text: string;
  heading: string;
  /** Only in the desktop app. */
  desktop?: boolean;
  /** Only for a box that can write cards itself (UsbPanel). */
  usb?: boolean;
}

const METHODS: MethodInfo[] = [
  { id: 'box', icon: Speaker, title: 'An der Box', text: 'Schritt für Schritt mit den Tasten der Box. Ohne Zubehör.', heading: 'An der Box anlernen' },
  { id: 'qr', icon: Smartphone, title: 'Mit dem Handy', text: 'Android-Handy mit NFC, mit TonUINO Studio für Android oder über einen QR-Code.', heading: 'Mit dem Handy beschreiben' },
  { id: 'reader', icon: Nfc, title: 'Mit dem NFC-Leser', text: 'NFC-Leser am USB, z. B. ACR122U. Am schnellsten bei vielen Karten.', heading: 'Mit dem NFC-Leser beschreiben', desktop: true },
  { id: 'wifi', icon: Wifi, title: 'Über WLAN', text: 'Für Boxen mit ESP32. Ich schicke die Karte über dein WLAN an die Box.', heading: 'Über WLAN an die Box schicken', desktop: true },
  { id: 'usb', icon: Usb, title: 'Über USB an die Box', text: 'Die Box schreibt die Karte selbst. Vorschau, bis die offizielle Firmware das kann.', heading: 'Über USB an die Box', usb: true },
];

/** The Android app: the phone or tablet writes the cards itself ('reader' is the device there), and comes first. */
function phoneMethod(device: 'Handy' | 'Tablet'): MethodInfo {
  const { label, text } = phoneCardMethod(device);
  return { id: 'reader', icon: Smartphone, title: label, text, heading: `Mit dem ${device} beschreiben` };
}

/** The ways of this app; the Android app has no QR code to scan with another phone. */
function methodsFor(mobile: boolean): MethodInfo[] {
  return mobile ? [phoneMethod(handheldWord()), ...METHODS.filter((m) => m.id === 'box' || m.id === 'wifi' || m.id === 'usb')] : METHODS;
}

/**
 * „Über USB an die Box“ shows only for a box that can write cards (asked
 * after connecting, or flashed with the preview; writeability.ts), and stays
 * while it is the chosen way on a live connection, so its panel can say why
 * a box cannot.
 */
function usbShown(): boolean {
  if (!plat().capabilities.serial) return false;
  if (boxWritesCards.value || logSession.writeAbility.value === 'yes') return true;
  return settings.value.cardMethod === 'usb' && logSession.link.value.kind === 'connected';
}

export function CardsPage() {
  const s = card.value;
  const items = cardItems.value;
  const chosen = items.filter(isSelected);
  const folders = items.filter((i) => i.folder !== undefined);
  const folderExtras = items.filter((i) => i.extra && isFolderExtra(i.data));
  const specials = items.filter((i) => i.extra && !isFolderExtra(i.data));
  const caps = plat().capabilities;
  const methods = methodsFor(!!plat().mobile).filter((m) => !m.usb || usbShown());
  const available = (m: MethodInfo) => !m.desktop || (m.id === 'reader' ? caps.nfcReader : caps.wifiBox);
  const stored = methods.find((m) => m.id === settings.value.cardMethod) ?? methods[0];
  const method = available(stored) ? stored : methods[0];
  const usableMethods = methods.filter(available);
  const [addSpecial, setAddSpecial] = useState(false);
  const [addFolderCards, setAddFolderCards] = useState(false);
  const [modeOf, setModeOf] = useState<number | null>(null);
  const [free, setFree] = useState<{ bytes: boolean } | null>(null);
  const [paste, setPaste] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  // A box connected for „Über USB an die Box“ (or brought over from the Box-Logbuch) is let go on leaving, so the firmware wizard can use the port.
  useEffect(
    () => () => {
      if (!keepsLogConnection(route.peek())) void logSession.disconnect();
    },
    [],
  );
  // Arriving with cards picked on a folder page (a folder with a new number, audit 0.4 #6): the first of them in
  // view, also when it is folder 48 at the bottom of the list. Once, so it never fights the user's own scrolling.
  useEffect(() => {
    const ul = list.current;
    const row = ul?.querySelector('.pick-row.checked');
    if (!ul || !row) return;
    if (ul.scrollHeight > ul.clientHeight) {
      const offset = row.getBoundingClientRect().top - ul.getBoundingClientRect().top;
      if (offset > ul.clientHeight - row.clientHeight) ul.scrollTop += offset - ul.clientHeight / 3;
      // The cards are chosen already (e.g. „Karte beschreiben“ after adding): the ways to write them in view as well,
      // not below a list that fills the window (Prüfrunde 0.5-1, 1440×830).
      const ways = document.getElementById('cards-step-2')?.closest('section');
      if (ways && ways.getBoundingClientRect().bottom > window.innerHeight) ways.scrollIntoView({ block: 'end' });
    } else if (row.getBoundingClientRect().bottom > window.innerHeight) {
      // On the phone the list is as long as it is and the page scrolls.
      row.scrollIntoView({ block: 'center' });
    }
  }, []);
  const old = format20.value;
  const unsupported = chosen.filter((i) => i.unsupported);
  const mismatched = chosen.filter((i) => i.problems.length);
  const needing = chosen.filter((i) => i.needs && !i.unsupported);
  const allChosen = items.length > 0 && chosen.length === items.length;
  // Cards the box's firmware knows, but not its older TNG release: the version is what to check then.
  const onlyRelease = !old && unsupported.every((i) => !supportProblem(i.data, profile.value));
  // Folders that only wait in the app for the next Paket: the box cannot play them yet.
  const readerShown = chosen.length > 0 && method.id === 'reader';
  const notOnCard = [...new Set(chosen.map(folderOf).filter((f): f is number => f !== undefined && foldersNotOnCard.value.has(f)))].sort((a, b) => a - b);

  return (
    <div class="page cards-page">
      <header class="page-header">
        <div class="titles">
          <h1>Karten beschreiben</h1>
          <p>Wähle die Karten aus und dann, womit du sie beschreibst.</p>
        </div>
        <ProfileSwitch />
      </header>

      {/* The card held to the phone; with the reader panel open it shows there, next to writing. */}
      {plat().nfc.phone && !readerShown ? <TappedCardNote /> : null}

      {s ? null : shownMemory.value ? (
        <RememberedNote page="cards" />
      ) : (
        <>
          <NoCard />
          <RememberedBoxes compact />
        </>
      )}

      {/* A tablet shows the list and the writing side by side (layout.css); elsewhere these wrappers add nothing. */}
      <div class="cards-grid">
        <div class="cards-pick">
          <section class="card" aria-labelledby="cards-step-1">
            <div class="card-header">
              <h2 id="cards-step-1" class="step-heading">
                <span class="step-num">1</span> Welche Karten?
              </h2>
              <span class="soft small">{chosen.length ? `${chosen.length} ausgewählt` : 'noch keine ausgewählt'}</span>
              <div class="spacer" />
              <div class="cards-step-actions">
                {items.length > 1 ? (
                  <button type="button" class="link-button" onClick={() => selectAll(items, !allChosen)}>
                    {allChosen ? 'Keine auswählen' : 'Alle auswählen'}
                  </button>
                ) : null}
                <MenuButton
                  trigger={(open) => <IconButton label="Mehr Karten" icon={Ellipsis} onClick={open} />}
                  items={[
                    { label: 'Karte mit freier Ordnernummer …', icon: FolderInput, onSelect: () => setFree({ bytes: false }) },
                    { label: 'Zahlen und Bytes …', icon: Binary, onSelect: () => setFree({ bytes: true }) },
                    { label: 'Liste einfügen …', icon: ClipboardPaste, onSelect: () => setPaste(true) },
                    { label: old ? 'Kartenformat für TonUINO 2.0 ausschalten' : 'Kartenformat für TonUINO 2.0', icon: History, onSelect: () => setFormat20(!old), separatorBefore: true },
                  ]}
                />
              </div>
            </div>
            {old ? (
              <div class="pad-inline">
                <Callout tone="info" icon={History}>
                  <span>
                    <b>Kartenformat für TonUINO 2.0 ist an.</b> Alle Karten bekommen das alte Format. Nur für Boxen, die noch TonUINO 2.0 haben.{' '}
                    <button type="button" class="link-button" onClick={() => setFormat20(false)}>
                      Ausschalten
                    </button>
                  </span>
                </Callout>
              </div>
            ) : null}
            {items.length ? (
              <ul class="pick-list" ref={list}>
                {/* The remembered box only shows how its cards play: changing that needs the card. */}
                {folders.map((i) => (
                  <PickRow item={i} key={i.key} onChangeMode={s ? () => setModeOf(i.folder!) : undefined} />
                ))}
                {folderExtras.length ? (
                  <li class="pick-group" aria-hidden="true">
                    Weitere Karten für Ordner
                  </li>
                ) : null}
                {folderExtras.map((i) => (
                  <PickRow item={i} key={i.key} removable={canRemoveExtra(i)} />
                ))}
                {specials.length ? (
                  <li class="pick-group" aria-hidden="true">
                    Spezialkarten
                  </li>
                ) : null}
                {specials.map((i) => (
                  <PickRow item={i} key={i.key} removable={canRemoveExtra(i)} />
                ))}
              </ul>
            ) : (
              <p class="soft pad-inline">{s ? 'Auf der SD-Karte sind noch keine Ordner.' : 'Noch keine Karten in der Liste. Füge unten eine Spezialkarte hinzu.'}</p>
            )}
            <div class="card-footer">
              <Button variant="ghost" icon={Plus} onClick={() => setAddSpecial(true)}>
                Spezialkarte hinzufügen
              </Button>
              <span class="soft small">Schlummerkarte, Stopptanz, Kita-Modus, Admin-Karte …</span>
              {folders.length ? (
                <>
                  <div class="spacer" />
                  <Button variant="ghost" icon={ListPlus} onClick={() => setAddFolderCards(true)}>
                    Weitere Karten für einen Ordner
                  </Button>
                </>
              ) : null}
            </div>
          </section>
        </div>

        <div class="cards-write">
          <section class="stack" aria-labelledby="cards-step-2">
            <h2 id="cards-step-2" class="step-heading">
              <span class="step-num">2</span> Womit beschreibst du sie?
            </h2>
            {/* On a phone the way in use folds to one line: it is chosen once and then stays. */}
            <PhoneFold
              label="Womit"
              summary={
                <>
                  <method.icon size={18} aria-hidden="true" /> {method.title}
                </>
              }
            >
              <div
                class="choices methods"
                role="radiogroup"
                aria-labelledby="cards-step-2"
                onKeyDown={arrowKeyHandler(
                  usableMethods.findIndex((m) => m.id === method.id),
                  (i) => chooseCardMethod(usableMethods[i].id),
                )}
              >
                {methods.map((m) => {
                  const Icon = m.icon;
                  const ok = available(m);
                  const checked = ok && m.id === method.id;
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-disabled={!ok}
                      tabIndex={checked ? 0 : -1}
                      class={`choice ${ok ? '' : 'disabled'}`}
                      key={m.id}
                      title={ok ? undefined : DESKTOP_ONLY}
                      onClick={() => ok && chooseCardMethod(m.id)}
                    >
                      <span class="choice-icon">
                        <Icon size={19} strokeWidth={2.2} />
                      </span>
                      <span class="choice-title">{m.title}</span>
                      <span class="choice-text">{m.text}</span>
                      {!ok ? <span class="choice-note">{DESKTOP_ONLY}</span> : null}
                    </button>
                  );
                })}
              </div>
              <div class="row wrap" style={{ gap: 16 }}>
                <a class="link-button" href={routeToHash({ page: 'help', topic: 'kartentypen' })}>
                  <CircleHelp size={15} aria-hidden="true" /> Welche Karten passen?
                </a>
                {usableMethods.length < methods.length ? (
                  <a class="link-button" href={routeToHash({ page: 'help', topic: 'browser' })}>
                    <Monitor size={15} aria-hidden="true" /> {plat().os === 'macos' ? 'Warum nur Windows und Linux?' : 'Mehr zur Desktop-App'}
                  </a>
                ) : null}
              </div>
            </PhoneFold>
          </section>

          <section class="card pad stack" aria-labelledby="cards-step-3">
            <h2 id="cards-step-3" class="step-heading">
              <span class="step-num">3</span> {method.heading}
            </h2>
            {chosen.length ? <ProfileQuestion /> : null}
            {unsupported.length ? (
              <Callout tone="danger" icon={CircleAlert}>
                <div class="stack tight">
                  <span>
                    {unsupported.length === 1 ? `„${unsupported[0].title}“: ${unsupported[0].unsupported}` : `${unsupported.length} Karten passen nicht zu deiner Box: ${unsupported.map((i) => i.title).join(', ')}.`} {onlyRelease ? (
                      method.id === 'box' ? (
                        'Stimmt das nicht? Stelle unten die Version deiner Box um.'
                      ) : (
                        <>
                          Stimmt das nicht? Die Version deiner Box stellst du in den <a href={routeToHash({ page: 'settings' })}>Einstellungen</a> unter „Für Bastler“ um.
                        </>
                      )
                    ) : old ? (
                      'TonUINO 2.0 kennt nur Ordnerkarten.'
                    ) : (
                      'Prüfe, welche Firmware deine Box hat.'
                    )}
                  </span>
                  <div>
                    <Button size="sm" onClick={() => unsupported.forEach((i) => setSelected(i, false))}>
                      Aus der Auswahl nehmen
                    </Button>
                  </div>
                </div>
              </Callout>
            ) : null}
            {mismatched.length ? (
              <Callout tone="warning" icon={CircleAlert}>
                {mismatched.map((i) => (
                  <span key={i.key} class="block">
                    „{i.title}“: {i.problems.join(' ')}
                  </span>
                ))}
              </Callout>
            ) : null}
            {needing.length ? (
              <Callout tone="warning" icon={CircleAlert}>
                {needing.map((i) => (
                  <span key={i.key} class="block">
                    „{i.title}“: {i.needs}
                  </span>
                ))}
              </Callout>
            ) : null}
            {method.id === 'box' && notOnCard.length ? <NotOnCard folders={notOnCard} /> : null}
            {!chosen.length ? (
              <p class="soft">Wähle oben mindestens eine Karte aus.</p>
            ) : method.id === 'box' ? (
              <BoxPanel items={chosen} />
            ) : method.id === 'qr' ? (
              <QrPanel items={chosen} />
            ) : method.id === 'reader' ? (
              <ReaderPanel items={chosen} />
            ) : method.id === 'usb' ? (
              <UsbPanel items={chosen} />
            ) : (
              <WifiPanel items={chosen} />
            )}
          </section>
        </div>
      </div>

      {chosen.length && !writingNow.value ? <PhoneBar count={chosen.length} writes={method.id === 'reader' && !!plat().nfc.phone} /> : null}

      {addSpecial ? <SpecialCardDialog onClose={() => setAddSpecial(false)} /> : null}
      {addFolderCards ? <FolderCardDialog onClose={() => setAddFolderCards(false)} /> : null}
      {free ? <FreeCardDialog bytes={free.bytes} onClose={() => setFree(null)} /> : null}
      {paste ? <PasteListDialog onClose={() => setPaste(false)} /> : null}
      {modeOf !== null ? <FolderModeDialog folder={modeOf} onClose={() => setModeOf(null)} /> : null}
    </div>
  );
}

/**
 * Phones: what is chosen, and the way on, at the bottom of the screen where
 * the thumb is. With the phone's own NFC its button starts writing; with
 * another way it leads to step 3. Hidden on wider screens (layout.css).
 */
function PhoneBar({ count, writes }: { count: number; writes: boolean }) {
  const next = () => {
    if (writes) writeRequest.value++;
    else document.getElementById('cards-step-3')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  return (
    <div class="phone-bar">
      <span class="phone-bar-count">{count === 1 ? 'Eine Karte' : `${count} Karten`} ausgewählt</span>
      <Button variant="primary" icon={writes ? Nfc : undefined} onClick={next}>
        {writes ? (count === 1 ? 'Beschreiben' : 'Alle beschreiben') : 'Weiter'}
      </Button>
    </div>
  );
}

/** The Android app: what is on the card held to the phone last (nfcTap.ts). */
function TappedCardNote() {
  const t = tappedCard.value;
  const note = useRef<HTMLDivElement>(null);
  // A card held to the phone shows at once, also when the list was scrolled down (as in "NFC Tools").
  useEffect(() => {
    if (t?.busy) note.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [t?.seq, t?.busy]);
  if (!t) return null;
  return (
    <div class="tapped-card" ref={note}>
      {t.busy ? (
        <Callout tone="info" icon={Nfc}>
          Lese die Karte …
        </Callout>
      ) : !t.data ? (
        <Callout tone="warning" icon={Nfc}>
          {t.error ?? 'Die Karte konnte nicht gelesen werden.'}
        </Callout>
      ) : (
        <Callout tone="info" icon={Nfc}>
          <div class="stack tight">
            <span>{tappedText({ data: t.data, type: t.type, uid: t.uid })}</span>
            <ReadCardActions data={t.data} />
          </div>
        </Callout>
      )}
    </div>
  );
}

/** No SD card open: how to get one in here, depending on what this app can do with cards. */
function NoCard() {
  const caps = plat().capabilities;
  const pick = async () => {
    try {
      const v = await plat().volumes.pick();
      if (v) await openVolume(v);
    } catch (e) {
      toastError('Die Karte ließ sich nicht öffnen', e);
    }
  };
  const special = 'Spezialkarten wie die Schlummerkarte gehen auch ohne.';
  // Phones: one line and its button, so the list and „Spezialkarte hinzufügen“ stay in view (handy-regeln.md, rule 7).
  const narrow = useMedia(PHONE_QUERY);
  if (narrow && caps.sd && !caps.sdAutoDetect) {
    return (
      <Callout tone="info" icon={null}>
        <div class="nocard-line">
          <span>Die Ordner kommen von der SD-Karte.</span>
          <Button size="sm" icon={CardSim} onClick={pick}>
            SD-Karte auswählen
          </Button>
        </div>
      </Callout>
    );
  }
  // An Android app without the SD card (an APK without its file bridge): folder cards come from the menu of step 1.
  if (plat().mobile && !caps.sd) {
    return (
      <Callout tone="info">
        Auf dem {handheldWord()} gibt es keine SD-Karte. Karten für einen Ordner legst du oben über die drei Punkte an: mit „Karte mit freier Ordnernummer“ oder „Liste einfügen“.
        Spezialkarten wie die Schlummerkarte fügst du unten hinzu.
      </Callout>
    );
  }
  if (caps.sd && caps.sdAutoDetect) {
    return <Callout tone="info">Stecke die SD-Karte der Box ein, ich finde sie von selbst. Dann erscheinen hier alle Ordner. {special}</Callout>;
  }
  if (caps.sd || caps.sdPackage) {
    return (
      <Callout tone="info">
        <div class="stack">
          <span>
            {/* On a phone the card only gets in through a reader at its USB port: said here too, not only on „Meine Box“ (audit 0.4 #26). */}
            {caps.sd ? (plat().mobile ? `Stecke die SD-Karte der Box ${cardIntoDevice()} und wähle sie aus` : 'Wähle die SD-Karte der Box aus') : 'Lies die SD-Karte der Box ein'}, dann erscheinen hier
            alle Ordner. {special}
          </span>
          {caps.sd ? (
            <div>
              <Button icon={CardSim} onClick={pick}>
                SD-Karte auswählen
              </Button>
            </div>
          ) : (
            <CardReader purpose="card" over={false} size="md" />
          )}
        </div>
      </Callout>
    );
  }
  return <Callout tone="info">Spezialkarten wie die Schlummerkarte gehen auch ohne SD-Karte.</Callout>;
}

/** The folder a card plays: its own, or the one a further card for a folder belongs to. */
function folderOf(item: CardItem): number | undefined {
  return item.folder ?? (isFolderExtra(item.data) ? item.data.folder : undefined);
}

/** Teaching a card at the box needs the folder on the box's card: say so while it only waits in the Paket. */
function NotOnCard({ folders }: { folders: number[] }) {
  const names = namesList(folders.map(folderName));
  const waiting = packageState.value.kind === 'downloaded';
  return (
    <Callout tone="warning" icon={CircleAlert}>
      <div class="stack tight">
        <span>
          {folders.length === 1 ? `Ordner ${names} ist` : `Die Ordner ${names} sind`} noch nicht auf der SD-Karte. Bringe erst das Paket auf die Karte, dann kann die Box{' '}
          {folders.length === 1 ? 'ihn' : 'sie'} abspielen.
        </span>
        <div>
          <Button size="sm" variant="primary" onClick={() => openPackageDialog()}>
            {waiting ? 'So geht’s' : 'Paket herunterladen'}
          </Button>
        </div>
      </div>
    </Callout>
  );
}

function PickRow({ item, removable, onChangeMode }: { item: CardItem; removable?: boolean; onChangeMode?: () => void }) {
  const checked = isSelected(item);
  const id = `pick-${item.key}`;
  // Further cards for a folder show that folder's cover and number.
  const folder = folderOf(item);
  const waiting = folder !== undefined && foldersNotOnCard.value.has(folder);
  return (
    <li class={`pick-row ${checked ? 'checked' : ''}`}>
      <input type="checkbox" id={id} checked={checked} onChange={(e) => setSelected(item, e.currentTarget.checked)} />
      <label for={id} class="pick-main">
        <span class="pick-cover">{folder !== undefined ? <Cover url={item.extra ? coverUrlForCard(item.extra) : coverUrlFor(folder)} title={item.title} seed={folder} number={String(folder).padStart(2, '0')} color={item.extra?.color ?? catalog.value?.folders[String(folder).padStart(2, '0')]?.color} small /> : <SpecialIcon item={item} />}</span>
        <span class="pick-text">
          <span class="pick-title">
            {folder !== undefined ? <span class="pick-num">{String(folder).padStart(2, '0')}</span> : null}
            {softHyphens(item.title)}
          </span>
          <span class="pick-desc">{item.summary}</span>
        </span>
        {item.unsupported ? (
          <span class="badge danger" title={item.unsupported}>
            passt nicht
          </span>
        ) : waiting ? (
          <span class="badge" title="Kommt mit dem nächsten Paket auf die SD-Karte.">
            noch nicht auf der Karte
          </span>
        ) : item.duplicate ? (
          <span class="badge warning" title="Diese Karte steht weiter oben schon einmal in der Liste. Du kannst sie hier entfernen.">
            doppelt
          </span>
        ) : item.problems.length || item.needs ? (
          <span class="badge warning" title={[...item.problems, item.needs ?? ''].join(' ').trim()}>
            prüfen
          </span>
        ) : null}
      </label>
      {/* Outside the label: a click here changes how the card plays, it does not tick the row. */}
      {onChangeMode ? (
        <button type="button" class="link-button pick-change" aria-label={`Wie „${item.title}“ spielt, ändern`} onClick={onChangeMode}>
          ändern
        </button>
      ) : null}
      {removable ? (
        <IconButton
          label={`„${item.title}“ entfernen`}
          icon={X}
          size="sm"
          variant="ghost"
          onClick={() => removeExtraCard(item.extra!.id).catch((e) => toastError('Entfernen hat nicht geklappt', e))}
        />
      ) : null}
    </li>
  );
}

function SpecialIcon({ item }: { item: CardItem }) {
  const d = item.data;
  let Icon: LucideIcon = KeyRound;
  if (d.folder === 0 && d.mode !== ADMIN_MODE) {
    // A TNG card on a 2.1 box keeps its own symbol; the key is the Admin-Karte's.
    const mod = modifiersFor(profile.value).find((m) => m.code === d.mode) ?? modifiersFor('tng').find((m) => m.code === d.mode);
    Icon = mod ? MODIFIER_ICONS[mod.symbol] : CircleHelp;
  } else if (d.folder !== 0) {
    Icon = RotateCcw;
  }
  return (
    <span class="special-icon">
      <Icon size={18} strokeWidth={2.2} />
    </span>
  );
}

/** "ändern" next to the firmware found by itself: the question in step 3 shows again. */
const profileAsked = signal(false);

/**
 * Which firmware the box has (#29): once it is known (from the SD card or
 * the box), one line at the top with a small „ändern“. Otherwise nothing
 * here: the question waits in step 3, in the box's own words (audit 0.4 #15),
 * where it matters, and is not the first thing on the page.
 */
function ProfileSwitch() {
  const decision = profileDecision.value;
  const from = sourceText(decision.source);
  if (!from || profileAsked.value) return null;
  return (
    <div class="profile-switch">
      <span class="field-label">Firmware deiner Box</span>
      <span class="profile-detected">
        <span class="profile-auto">Automatisch erkannt: </span>
        <b>{PROFILE_NAMES[decision.profile]}</b> <span class="muted">({from})</span>{' '}
        <button
          type="button"
          class="link-button"
          onClick={() => {
            profileAsked.value = true;
            requestAnimationFrame(() => document.getElementById('cards-profile')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
          }}
        >
          ändern
        </button>
      </span>
    </div>
  );
}

/**
 * The firmware asked the way the box shows it: both say „Oh, eine neue
 * Karte!“, then TNG asks how the card plays and 2.1 asks for the folder
 * (boxguide.ts: tngGuide, classicGuide).
 */
function ProfileQuestion() {
  const decision = profileDecision.value;
  const found = !!sourceText(decision.source);
  if (found && !profileAsked.value) return null;
  const disagree = boxDisagrees(decision, boxProfile.value ?? undefined);
  return (
    <div id="cards-profile" class="profile-question stack tight">
      <span class="field-label">Nach „Oh, eine neue Karte!“ fragt deine Box zuerst …</span>
      <Segmented<FirmwareProfile>
        label="Was fragt deine Box zuerst?"
        value={profile.value}
        options={[
          { value: 'tng', label: 'wie die Karte spielen soll' },
          { value: 'classic21', label: 'nach dem Ordner' },
        ]}
        onChange={(p) => {
          profileAsked.value = false;
          setProfile(p).catch((e) => toastError('Speichern hat nicht geklappt', e));
        }}
      />
      <p class="small soft">
        {disagree
          ? `Die angeschlossene Box meldet beim Start ${PROFILE_NAMES[boxProfile.value!]}.`
          : `Das ist ${PROFILE_NAMES[profile.value]}. Weißt du es nicht? Stecke die Box per USB an und öffne das Box-Logbuch.`}{' '}
        {found ? (
          <button type="button" class="link-button" onClick={() => (profileAsked.value = false)}>
            So lassen
          </button>
        ) : null}
      </p>
    </div>
  );
}
