import { signal } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ArchiveRestore, CardSim, CircleCheck, Copy, FolderSearch, Hammer, HardDrive, ListOrdered, Nfc, Package, Printer, RefreshCw, ScrollText, ShieldCheck, Wrench, type LucideIcon } from 'lucide-preact';
import { Haken, Hinweis, Lupe, Mehr, Plus, Stift } from '../../ui/icons';
import type { BulkTarget } from '../../core/stickers/bulkcover';
import type { ShelfItem } from '../../core/tonuino/catalog';
import { buildShelf } from '../../core/tonuino/catalog';
import { Button, Callout, EmptyState, IconButton, Progress } from '../../ui/components/controls';
import { Bubble } from '../../ui/components/Sketch';
import { MenuButton } from '../../ui/components/Menu';
import { SdCardArt, WelcomeBoxArt } from '../../ui/components/Art';
import { toast, toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { cardIntoDevice } from '../../app/device';
import { writeGuard } from '../../app/writeguard';
import { ExternalLink, FORUM_URL } from '../help/ExternalLink';
import { card, chooseOtherCard, isBuiltInDrive, looksLikeCard, needsPermission, openVolume, platform, profile, rescan, setCover, settings, shownMemory, startingUp, updateCatalog, volumes } from '../../app/state';
import { offerRemember } from '../../app/remembered';
import { formatBytes, formatDuration, plural } from '../../app/format';
import { canChangeCard, cardNote, chooseCardFolder, packageState, plan, snapshotOfCard } from '../../app/pending';
import { routeToHash } from '../../app/router';
import { useCardDrop } from '../../ui/useCardDrop';
import { CardNoteCallout, CardReader, UPLOAD_HINT } from './CardReader';
import { openPackageDialog } from './PackageDialog';
import { openRebuildDialog } from './RebuildDialog';
import { openCopyToCardDialog } from './CopyToCardDialog';
import { useWaitingGate } from './PackageWaitingGate';
import { PendingChanges } from './PendingChanges';
import { LOOKS_EMPTY_TEXT, rereadText, timeOfDay } from './packageTexts';
import { HealthDialog } from './HealthDialog';
import { ContentListDialog } from './ContentListDialog';
import { fixableLine, WriteAccessNotice, WriteFixButton } from './WriteAccessNotice';
import { installSounds, SoundsDialog, type SoundsProgress } from './SoundsDialog';
import { discoverFolder, unknownFolders, type Discovered } from './discover';
import { BulkCoverDialog, useCoverless } from '../stickers/BulkCoverDialog';
import { FolderShelf, ShelfViewChoice } from './ShelfViews';
import { Dialog } from '../../ui/components/Dialog';
import { Field } from '../../ui/components/controls';
import { PicksTeaser } from '../sources/Picks';
import { isComputerDrive } from '../../core/tonuino/health';
import { MAX_FOLDER, MAX_TRACKS } from '../../core/tonuino/sd';
import { RememberedBoxes, RememberedShelf, RememberOffer } from './Remembered';
import { PackSeriesLine } from './PackSeries';
import { PhoneWelcome } from './PhoneWelcome';
import { PHONE_QUERY, useMedia } from '../../ui/useMedia';

/** Something is being written right now; a selection waiting under "Hinzufügen" is no write and does not count. */
const writingToCard = () => writeGuard.running.value.some((k) => k !== 'selection');

/**
 * "Eigene Ansagen?" on a new card goes on with the dialog of the
 * announcements. By then the card has its catalog and the page shows the
 * shelf, so the dialog lives here.
 */
const setupSounds = signal<string | null>(null);

/**
 * "Karte einrichten" downloads and writes the announcements right away:
 * the click on it was the yes (audit 0.4 #2), the text above the button says
 * so. While it runs, the shelf shows a quiet line with the progress in place
 * of the red box of the health check, which would only say they are missing.
 */
const setupRun = signal<{ volume: string; phase: SoundsProgress | { kind: 'error'; message: string } } | null>(null);

async function runSetupSounds(volume: string) {
  setupRun.value = { volume, phase: { kind: 'download', received: 0 } };
  try {
    await installSounds(false, (phase) => (setupRun.value = { volume, phase }));
    setupRun.value = null;
  } catch (e) {
    setupRun.value = { volume, phase: { kind: 'error', message: e instanceof Error ? e.message : String(e) } };
  }
}

export function BoxPage() {
  const s = card.value;
  return (
    <>
      <BoxView />
      {s?.status === 'ready' && setupSounds.value === s.volume.id ? <SoundsDialog onClose={() => (setupSounds.value = null)} /> : null}
    </>
  );
}

function BoxView() {
  const p = platform.value;
  const s = card.value;
  if (!p) return null;
  // Without the card, a box remembered on this device (Remembered.tsx) when one was opened.
  if (!s && shownMemory.value) return <RememberedShelf />;
  if (!p.capabilities.sd && !p.capabilities.sdPackage) return <NoSdSupport />;
  // Right after the start the app may still find the card: no "Steck die SD-Karte …" for a blink.
  if (!s) return startingUp.value ? <Calm /> : p.capabilities.sd ? <Welcome /> : <PackageWelcome />;
  if (s.status === 'scanning') return <Scanning />;
  if (s.status === 'error') return <CardError message={s.error ?? ''} />;
  if (s.scan?.kind === 'empty') return <SetupCard empty />;
  if (s.scan?.kind === 'foreign' && !s.catalogOnCard) return <SetupCard empty={false} />;
  return <Shelf />;
}

function NoSdSupport() {
  // A phone or tablet: the browser is not the problem, the device is.
  const handheld = !!platform.value?.handheld;
  return (
    <div class="page narrow">
      <EmptyState
        art={<SdCardArt />}
        title={handheld ? 'Die SD-Karte geht nur am Computer' : 'Dieser Browser kann keine SD-Karte lesen'}
        actions={
          <Button variant="primary" onClick={() => navigate({ page: 'help', topic: 'browser' })}>
            Welche Möglichkeiten habe ich?
          </Button>
        }
      >
        Nimm am Computer Firefox, Chrome, Edge oder Safari. Mit der Desktop-App für Windows und Linux geht es auch.
      </EmptyState>
      <RememberedBoxes />
      <FeatureGrid />
    </div>
  );
}

/**
 * Firefox and Safari: the app reads the card once and brings what is new
 * to it as a Paket. The whole welcome box takes a dropped card.
 */
function PackageWelcome() {
  const drop = useCardDrop('card');
  // Said before the button, so nobody finds out about the longer way only after it (audit 0.4 #30).
  // There is no desktop app for the Mac: there Chrome or Edge write to the card directly.
  const mac = platform.value?.os === 'macos';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) && !/Chrom(e|ium)\//.test(ua) ? 'Safari' : 'diesem Browser';
  return (
    <div class="page">
      <CardNoteCallout />
      <section class={`hero card-drop ${drop.over ? 'over' : ''}`} {...drop.handlers}>
        <div class="stack loose">
          <div class="stack">
            <h1>
              Hallo! Stecke die <span class="nowrap">SD-Karte</span> deiner Box in den Computer.
            </h1>
            <p>Dann lese ich die Karte ein. Alles Neue pack ich in ein Paket, das du danach mit ein paar Klicks auf die Karte entpackst.</p>
            <p class="package-way">
              {mac ? `Am Mac geht's am einfachsten mit Chrome oder Edge. Mit ${browser} geht es auch, über ein Paket.` : `Mit der Desktop-App oder Chrome geht alles direkt. Mit ${browser} geht es über ein Paket.`}{' '}
              <a href={routeToHash({ page: 'help', topic: 'browser' })}>Mehr dazu</a>
            </p>
          </div>
          <CardReader purpose="card" over={drop.over} />
          <p class="small muted">{UPLOAD_HINT}</p>
          <a class="small" href={routeToHash({ page: 'workshop', tool: 'paket' })}>
            Du hast ein Paket bekommen?
          </a>
        </div>
        <div class="hero-art">
          <WelcomeBoxArt />
        </div>
      </section>
      <RememberedBoxes />
      <FeatureGrid />
      <PicksTeaser />
    </div>
  );
}

function Welcome() {
  const p = platform.value!;
  const list = volumes.value;
  // The Android app: the card sits in a card reader at the phone, picked once in the phone's own window.
  const phone = !!p.mobile;
  const narrow = useMedia(PHONE_QUERY);
  const pick = async () => {
    try {
      const v = await p.volumes.pick();
      if (v) await openVolume(v);
    } catch (e) {
      toastError('Die Karte ließ sich nicht öffnen', e);
    }
  };
  // Phones get their own short welcome where the card is picked by hand (PhoneWelcome.tsx).
  if (narrow && !p.capabilities.sdAutoDetect) return <PhoneWelcome onPick={pick} />;
  return (
    <div class="page">
      <section class="hero">
        <div class="stack loose">
          <div class="stack">
            <h1>
              Hallo! Stecke die <span class="nowrap">SD-Karte</span> deiner Box {cardIntoDevice()}.
            </h1>
            <p>
              {p.capabilities.sdAutoDetect
                ? 'Sobald die Karte steckt, erscheint hier alles, was darauf ist. Du musst nichts weiter tun.'
                : 'Danach wählst du sie einmal aus. Beim nächsten Mal erkenne ich die Karte wieder.'}
            </p>
            <p class="small soft">
              {phone
                ? 'Ein kleiner SD-Kartenleser mit USB-C-Stecker passt an die meisten Handys und Tablets. Über das USB-Kabel der Box geht es nicht, die Karte muss dafür aus der Box.'
                : 'Über das USB-Kabel der Box geht das nicht. Nimm die Karte aus der Box und stecke sie in den Kartenschlitz des Computers oder einen SD-Kartenleser.'}{' '}
              <a href="#/hilfe/sd-karte-herausnehmen">So kommst du an die Karte</a>
            </p>
          </div>
          <div class="row wrap">
            {p.capabilities.sdAutoDetect ? (
              <span class="row soft">
                <span class="spinner" /> Warte auf die SD-Karte …
              </span>
            ) : (
              <Button variant="primary" size="lg" icon={CardSim} onClick={pick}>
                SD-Karte auswählen
              </Button>
            )}
            {needsPermission.value ? (
              <Button size="lg" icon={ShieldCheck} onClick={() => p.volumes.requestPermission?.()}>
                Zugriff erlauben
              </Button>
            ) : null}
            {p.capabilities.sdAutoDetect ? (
              <Button size="lg" variant="ghost" icon={FolderSearch} onClick={pick}>
                Ordner selbst wählen
              </Button>
            ) : null}
          </div>
          {!p.capabilities.sdAutoDetect ? (
            <Bubble tail="top">
              Hier kommt deine <span class="nowrap">SD-Karte</span> rein!
            </Bubble>
          ) : null}
          {!p.capabilities.sdAutoDetect ? (
            <p class="small muted">
              {phone
                ? 'Im Fenster des Handys tippst du im Menü links auf den SD-Kartenleser, dann auf „Diesen Ordner verwenden“ und „Zulassen“. Wähle die ganze Karte, nicht einen Ordner darauf.'
                : 'Wähle im Fenster das Laufwerk der Karte selbst aus, nicht einen Ordner darauf. Der Browser fragt dann, ob ich Dateien ändern darf.'}
            </p>
          ) : null}
          {p.capabilities.sdAutoDetect && list.length ? (
            <div class="stack tight">
              <span class="section-title">Welches Laufwerk ist die SD-Karte?</span>
              <div class="row wrap">
                {list.map((v) => (
                  <Button icon={HardDrive} onClick={() => openVolume(v)}>
                    {isBuiltInDrive(v) ? `${v.label} (fest eingebaut)` : !looksLikeCard(v) ? `${v.label} (wohl keine SD-Karte)` : v.label}
                  </Button>
                ))}
              </div>
              {list.some(isBuiltInDrive) || list.some((v) => !looksLikeCard(v)) ? (
                <p class="small muted">Fest eingebaute Laufwerke und große Festplatten öffne ich nicht von selbst. Wähle so eins nur, wenn es wirklich die SD-Karte ist.</p>
              ) : null}
            </div>
          ) : null}
        </div>
        <div class="hero-art">
          <WelcomeBoxArt />
        </div>
      </section>
      <RememberedBoxes />
      <FeatureGrid />
      <PicksTeaser />
    </div>
  );
}

/** What the app does, for a first visit, and a thank-you to the people the box comes from. */
function FeatureGrid() {
  return (
    <>
      <div class="feature-grid four">
        <Feature icon={Plus} title="Hörspiele hinzufügen" text="Ziehe die Dateien herein, ich nummeriere, wandle um und teile lange Hörbücher." />
        <Feature icon={Printer} title="Sticker drucken" text="Cover finden, gestalten und passend für deine Etiketten drucken." />
        <Feature icon={Nfc} title="Karten beschreiben" text="Mit dem Handy, einem NFC-Leser am Computer oder direkt an der Box." />
        <Feature icon={Wrench} title="Werkstatt" text="Firmware aufspielen, Fehler finden, Ansagen erneuern." />
      </div>
      <p class="community-line small muted">
        Gemacht für alle, die TonUINO-Boxen bauen, unabhängig und kostenlos. Danke an Thorsten Voß und alle im <ExternalLink href={FORUM_URL}>TonUINO-Forum</ExternalLink>.
      </p>
    </>
  );
}

function Feature({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div class="feature">
      <div class="feature-icon">
        <Icon size={20} strokeWidth={2.2} />
      </div>
      <div class="stack tight">
        <b>{title}</b>
        <span class="small soft">{text}</span>
      </div>
    </div>
  );
}

/** An empty page while the app finds its feet, so nothing shows that is gone again a moment later. */
function Calm() {
  return <div class="page" aria-busy="true" />;
}

/** A card that reads quickly goes straight to the shelf; only a slower one shows its progress. */
const SCANNING_SHOWS_AFTER_MS = 400;

function Scanning() {
  const s = card.value!;
  const p = s.progress;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), SCANNING_SHOWS_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  if (!shown) return <Calm />;
  return (
    <div class="page narrow">
      <EmptyState art={<SdCardArt size={120} />} title="Lese die SD-Karte …">
        {p ? `${p.done} von ${p.total} Ordnern` : 'Einen Moment.'}
      </EmptyState>
      <div style={{ maxWidth: 360, margin: '0 auto', width: '100%' }}>
        <Progress value={p?.done ?? 0} max={p?.total ?? 1} indeterminate={!p} />
      </div>
    </div>
  );
}

function CardError({ message }: { message: string }) {
  const s = card.value!;
  const snapshot = s.volume.access === 'snapshot';
  return (
    <div class="page narrow">
      <CardNoteCallout />
      <EmptyState
        art={<SdCardArt size={120} />}
        title="Die SD-Karte ließ sich nicht lesen"
        actions={
          snapshot ? (
            <Button variant="primary" icon={RefreshCw} onClick={() => chooseCardFolder('card')}>
              Neu einlesen
            </Button>
          ) : (
            <Button variant="primary" icon={RefreshCw} onClick={() => openVolume(s.volume)}>
              Noch einmal versuchen
            </Button>
          )
        }
      >
        {message}
      </EmptyState>
    </div>
  );
}

/** First contact with an empty card or a card with other content. */
function SetupCard({ empty }: { empty: boolean }) {
  const s = card.value!;
  const [name, setName] = useState(s.catalog?.name ?? 'Meine TonUINO-Box');
  const [busy, setBusy] = useState(false);
  const snapshot = s.volume.access === 'snapshot';
  const { guard, gate } = useWaitingGate();
  const start = async (sounds: 'now' | 'ask' | 'none') => {
    setBusy(true);
    try {
      await updateCatalog((c) => {
        c.name = name.trim() || 'Meine TonUINO-Box';
        c.profile = settings.value.profile;
      });
      // TonUINO 2.1 needs its own announcements as a ZIP, and a Paket that waits for the card takes none:
      // there the dialog says what to do. Otherwise the click was the yes, no second question.
      const now = sounds === 'now' && profile.value !== 'classic21' && canChangeCard();
      if (now) setupRun.value = { volume: s.volume.id, phase: { kind: 'download', received: 0 } };
      await rescan();
      if (now) void runSetupSounds(s.volume.id);
      else if (sounds !== 'none') setupSounds.value = s.volume.id;
    } catch (e) {
      toastError('Die Karte ließ sich nicht einrichten', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="page narrow">
      <EmptyState art={<SdCardArt size={130} />} title={empty ? 'Eine leere Karte. Richten wir sie ein!' : 'Auf dieser Karte liegen andere Dateien'}>
        {empty
          ? snapshot
            ? 'Gib der Box einen Namen. Danach lege ich die Systemansagen ins Paket für die Karte, damit die Box mit dir sprechen kann.'
            : 'Gib der Box einen Namen. Danach lade ich die Systemansagen herunter (etwa 20 MB) und spiele sie auf, damit die Box mit dir sprechen kann.'
          : 'Ich hab keine TonUINO-Ordner gefunden, aber andere Dateien. Nimm für die Box am besten eine leere Karte, fremde Ordner können den MP3-Player durcheinanderbringen.'}
      </EmptyState>
      {snapshot && cardNote.value?.kind === 'looks-empty' ? (
        <Callout tone="warning">
          <div class="row wrap card-note">
            <span class="grow">{LOOKS_EMPTY_TEXT}</span>
            <Button size="sm" icon={RefreshCw} onClick={() => chooseCardFolder('card')}>
              Noch einmal einlesen
            </Button>
          </div>
        </Callout>
      ) : (
        <CardNoteCallout />
      )}
      <WriteAccessNotice />
      <div class="card pad stack" style={{ maxWidth: 520, margin: '0 auto', width: '100%' }}>
        <Field label="Name der Box" id="boxname">
          <input id="boxname" class="input big" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="z. B. Emmas TonUINO" />
        </Field>
        <div class="row wrap">
          <Button variant="primary" size="lg" icon={Hammer} loading={busy} onClick={guard(() => start('now'))}>
            {empty ? 'Karte einrichten' : 'Trotzdem einrichten'}
          </Button>
          <Button size="lg" variant="ghost" onClick={guard(() => start('none'))} disabled={busy}>
            Ohne Ansagen
          </Button>
        </div>
        {/* Own announcements as a ZIP, and which versions they fit, wait behind this link. */}
        <p class="small">
          <button type="button" class="link-button" disabled={busy} onClick={guard(() => start('ask'))}>
            Eigene Ansagen?
          </button>
        </p>
      </div>
      {/* The way out after picking the wrong drive or folder. */}
      <p class="small" style={{ textAlign: 'center' }}>
        <span class="muted">Falsche Karte erwischt?</span>{' '}
        <button type="button" class="link-button" disabled={busy || writingToCard()} onClick={() => (snapshot ? chooseCardFolder('card') : void chooseOtherCard())}>
          Andere Karte wählen
        </button>
      </p>
      {empty && !snapshot ? (
        <p class="rebuild-entry small" style={{ textAlign: 'center' }}>
          <span class="muted">Hast du eine Sicherung dieser Box?</span>{' '}
          <button type="button" class="link-button" onClick={() => openRebuildDialog('restore')}>
            Sicherung zurückspielen …
          </button>
        </p>
      ) : null}
      {gate}
    </div>
  );
}

/** The announcements of a new card on their way, in place of the health check; or what went wrong. */
function SetupSoundsLine() {
  const run = setupRun.value!;
  const ph = run.phase;
  if (ph.kind === 'error') {
    return (
      <Callout tone="danger">
        <div class="stack tight">
          <span>Die Systemansagen sind nicht auf die Karte gekommen. {fixableLine(ph.message)}</span>
          <WriteFixButton error={ph.message} onFixed={() => void runSetupSounds(run.volume)} />
          <div class="row wrap">
            <Button size="sm" onClick={() => void runSetupSounds(run.volume)}>
              Noch einmal versuchen
            </Button>
            <button
              type="button"
              class="link-button"
              onClick={() => {
                setupRun.value = null;
                setupSounds.value = run.volume;
              }}
            >
              Eigene Ansagen?
            </button>
            <button type="button" class="link-button" onClick={() => (setupRun.value = null)}>
              Später
            </button>
          </div>
        </div>
      </Callout>
    );
  }
  const packaged = card.value?.volume.access === 'snapshot';
  return (
    <div class="setup-sounds stack tight" role="status">
      <p class="small soft">
        {ph.kind === 'download'
          ? `Ich hole die Systemansagen, damit die Box mit dir sprechen kann … ${formatBytes(ph.received)}${ph.total ? ` von ${formatBytes(ph.total)}` : ''}`
          : packaged
            ? `Ich lege Ansage ${ph.done} von ${ph.total} ins Paket …`
            : `Ich schreibe Ansage ${ph.done} von ${ph.total} auf die Karte. Ziehe sie bis dahin nicht heraus.`}
      </p>
      <Progress value={ph.kind === 'download' ? ph.received : ph.done} max={ph.kind === 'download' ? (ph.total ?? 1) : ph.total} indeterminate={ph.kind === 'download' && !ph.total} />
    </div>
  );
}

/**
 * The first sentences of a text, as many as fit in about `max` letters (at
 * least the first one): three or four lines of the narrow column.
 */
function firstSentences(text: string, max = 170): string {
  const [first, ...rest] = text.split(/(?<=[.!?]“?)\s+(?=[A-ZÄÖÜ„])/);
  let out = first;
  for (const s of rest) {
    if (out.length + 1 + s.length > max) break;
    out += ` ${s}`;
  }
  return out;
}

function HealthBanner({ onOpen }: { onOpen: () => void }) {
  const r = card.value?.report;
  if (!r) return null;
  if (r.status === 'ok') {
    // Nothing to do: one quiet line, no box. Tips (cluster size, folder order,
    // other files) only matter when the box misbehaves; they wait in the dialog.
    // In the browser the format stays unknown: no "all fine" for what was not checked.
    // A folder on the computer: the card itself is checked when it is opened.
    const folder = r.issues.some((i) => i.id === 'not-a-card');
    const unchecked = folder || r.issues.some((i) => i.id === 'fs-unknown');
    return (
      <p class="health-quiet small">
        <Haken size={18} />
        <span class="muted">{folder ? 'Ordner und Dateien sind in Ordnung. Die SD-Karte selbst prüfe ich, wenn du sie öffnest.' : unchecked ? 'Ordner und Dateien sind in Ordnung.' : 'Karte geprüft: alles in Ordnung.'}</span>{' '}
        {/* Always a way in: "Gründlich prüfen" sits behind "Mehr" in the dialog, also on a clean card. */}
        <button type="button" class="link-button" onClick={onOpen}>
          {folder ? 'Mehr dazu' : unchecked ? 'So prüfst du das Format' : 'Mehr'}
        </button>
      </p>
    );
  }
  const n = r.counts.error + r.counts.warning;
  return (
    <div class={`health-banner ${r.status}`}>
      <div class="health-icon">
        <Hinweis size={28} />
      </div>
      <div class="grow">
        <b>{r.status === 'error' ? `${plural(n, 'Problem', 'Probleme')} auf der SD-Karte` : `${plural(n, 'Hinweis', 'Hinweise')} zur SD-Karte`}</b>
        <div class="small soft">{r.issues[0]?.title}{n > 1 ? ' und mehr' : ''}</div>
        {/* Why it matters, as in draft B ("Ohne sie bleibt die Box stumm …"); the whole story waits in the dialog. */}
        {r.issues[0]?.detail ? <p class="health-why small">{firstSentences(r.issues[0].detail)}</p> : null}
      </div>
      {/* An ordinary button: the one lila button of the page is "Hinzufügen" (draft B). */}
      <Button icon={Wrench} onClick={onOpen}>
        Ansehen und reparieren
      </Button>
    </div>
  );
}

function Shelf() {
  const s = card.value!;
  const scan = s.scan!;
  const [health, setHealth] = useState(false);
  const [query, setQuery] = useState('');
  const [rename, setRename] = useState(false);
  const coverless = useCoverless();
  const [findCovers, setFindCovers] = useState<readonly BulkTarget[] | null>(null);
  const shelf = useMemo(() => buildShelf(scan, s.catalog ?? null), [scan, s.catalog]);
  const unknown = useMemo(() => unknownFolders(scan, s.catalog ?? null), [scan, s.catalog]);
  const filtered = query ? shelf.filter((i) => `${i.name} ${i.title} ${i.entry?.artist ?? ''}`.toLowerCase().includes(query.toLowerCase())) : shelf;
  // Only when every folder with tracks knows its length: one without would make the sum too short.
  const playable = shelf.filter((i) => i.state !== 'missing' && i.trackCount);
  const totalDuration = playable.every((i) => i.durationSec !== undefined) ? playable.reduce((sum, i) => sum + (i.durationSec ?? 0), 0) : undefined;
  const info = s.info;
  const snapshot = snapshotOfCard.value;
  const pkg = packageState.value;
  const [reread, setReread] = useState(false);
  const [contents, setContents] = useState(false);
  const rebuildLine = !!snapshot && scan.folders.length > 0;
  // What PendingChanges shows with a lila button of its own: changes for a Paket, or a Paket to unpack.
  const waiting = !!snapshot && !!plan.value && pkg.kind !== 'clean';
  const slip = unknown.length > 0 || (coverless.length >= 2 && !query) || offerRemember.value;
  const readAgain = () => {
    if (pkg.kind === 'pending') setReread(true);
    else chooseCardFolder('card');
  };

  // The "…" for the card: a Paket card has none, "Karte neu aufbauen …" under the notes is all it would hold.
  const more = snapshot ? null : (
    <div class="box-more">
      <MenuButton
        trigger={(open) => <IconButton label="Mehr für die Karte" icon={Mehr} class="page-more" onClick={open} />}
        items={[
          { label: 'Karte neu aufbauen …', icon: Hammer, onSelect: () => openRebuildDialog('rebuild') },
          { label: 'Auf eine neue Karte umziehen …', icon: ArchiveRestore, onSelect: () => openRebuildDialog('move') },
          { label: 'Auf eine andere SD-Karte kopieren …', icon: Copy, onSelect: openCopyToCardDialog, separatorBefore: true },
          ...(!writingToCard() ? [{ label: 'Andere Karte wählen', icon: HardDrive, onSelect: () => void chooseOtherCard() }] : []),
          // A card without folders has nothing to list.
          ...(scan.folders.length ? [{ label: 'Inhaltsliste drucken …', icon: ListOrdered, onSelect: () => setContents(true), separatorBefore: true }] : []),
          { label: 'Bedienkarte zum Ausdrucken', icon: ScrollText, onSelect: () => navigate({ page: 'workshop', tool: 'bedienkarte' }), separatorBefore: !scan.folders.length },
        ]}
      />
    </div>
  );

  const report = card.value?.report;
  const healthLine = (!report || report.status === 'ok') && setupRun.value?.volume !== s.volume.id;

  /*
   * #80 "Platz nutzen" (regal audit 20.10.2026): name, facts and buttons in
   * one line at the top (an all-fine health check beside the facts); under
   * them search, view and the room on the card, in one line where the window
   * is wide enough; the shelf over the whole width below. Phones stack them;
   * there the room on the card comes after the shelf.
   */
  return (
    <div class="page box-page">
      <div class="box-bench">
        <header class="page-header box-head">
          <div class="titles">
            <div class="box-name">
              <h1 class="user-name">{s.catalog?.name ?? s.volume.label}</h1>
              <Button size="sm" variant="ghost" icon={Stift} aria-label="Namen ändern" title="Namen ändern" onClick={() => setRename(true)} />
              {more}
            </div>
            <div class="box-facts">
              <p>
                {/* How many of the 99 a box plays: here, not as a second "49" in the strip under the head. */}
                {scan.folders.length} von {MAX_FOLDER} Ordnern
                {totalDuration ? ` · ${formatDuration(totalDuration)}` : ''}
                {info.freeBytes !== undefined ? ` · ${formatBytes(info.freeBytes)} frei${isComputerDrive(info) ? (platform.value?.mobile ? ' auf dem Handy' : ' auf dem Computer') : ''}` : ''}
                {snapshot ? ` · eingelesen um ${timeOfDay(snapshot.takenAt)}` : ''}
                {snapshot ? (
                  pkg.kind === 'downloaded' ? (
                    <Button size="sm" variant="ghost" class="meta-action" icon={CircleCheck} onClick={() => openPackageDialog('check')}>
                      Karte prüfen
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" class="meta-action" icon={RefreshCw} onClick={readAgain}>
                      Neu einlesen
                    </Button>
                  )
                ) : null}
              </p>
              {/* All fine: one quiet line beside the facts. A problem gets its box above the shelf. */}
              {healthLine ? <HealthBanner onOpen={() => setHealth(true)} /> : null}
            </div>
          </div>
          <div class="box-actions">
            {/* While a Paket waits, its button under these is the one lila button of the page. */}
            <Button variant={waiting ? 'default' : 'primary'} icon={Plus} onClick={() => navigate({ page: 'add' })}>
              Hinzufügen
            </Button>
            <Button icon={Printer} onClick={() => navigate({ page: 'stickers' })}>
              Sticker drucken
            </Button>
            {/* While changes wait, the banner under the buttons leads to the Paket. */}
            {snapshot && pkg.kind !== 'pending' ? (
              <Button icon={Package} onClick={() => openPackageDialog()}>
                Paket
              </Button>
            ) : null}
          </div>
        </header>

        <div class="box-tools">
          <CardNoteCallout />
          <WriteAccessNotice />
          <PendingChanges />
          {setupRun.value?.volume === s.volume.id ? <SetupSoundsLine /> : !healthLine ? <HealthBanner onOpen={() => setHealth(true)} /> : null}
          {/* The other notes in one calm box, none at all when there is nothing to say. */}
          {slip || rebuildLine ? (
            <div class="box-notes card">
              {unknown.length ? <DiscoverBanner numbers={unknown} /> : null}
              <RememberOffer />
              {coverless.length >= 2 && !query ? (
                <p class="shelf-note">
                  <span>{plural(coverless.length, 'Ordner hat', 'Ordner haben')} noch kein Cover.</span>
                  <button type="button" class="link-button" onClick={() => setFindCovers(coverless)}>
                    Cover suchen
                  </button>
                </p>
              ) : null}
              {/* "Karte neu aufbauen …" is in the menu "…" and in the health check (audit 0.4 #1): here only for a
                  Paket card, which has no menu. A card without folders has nothing to play, nothing to rebuild. */}
              {rebuildLine ? (
                <p class="rebuild-entry small">
                  <span class="muted">Findet die Box Titel nicht oder springt sie?</span>{' '}
                  <button type="button" class="link-button" onClick={() => openPackageDialog('choose')}>
                    Karte neu aufbauen …
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Search, view and the room on the card in one line when the window has room for it, else two (box.css). */}
        {shelf.length ? (
          <div class="box-bar">
            <div class="shelf-tools">
              {shelf.length > 8 ? (
                <div class="input-group">
                  <Lupe size={18} />
                  <input class="input" type="search" placeholder="Suchen …" aria-label="Ordner suchen" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
                </div>
              ) : null}
              <ShelfViewChoice />
            </div>
            <RoomOnCard shelf={shelf} />
          </div>
        ) : null}

        <section class="box-piece" aria-label="Regal">
          {shelf.length === 0 ? (
            <EmptyState
              art={<SdCardArt size={120} />}
              title="Noch keine Hörspiele auf der Karte"
              actions={
                // Not lila: "Hinzufügen" in the head is the page's one main button.
                <Button size="lg" icon={Plus} onClick={() => navigate({ page: 'add' })}>
                  Erstes Hörspiel hinzufügen
                </Button>
              }
            >
              Ziehe ein Hörspiel, ein Hörbuch oder Musik rein. Um Nummern, Format und Reihenfolge kümmere ich mich.
            </EmptyState>
          ) : query && !filtered.length ? (
            <p class="soft">
              Kein Ordner passt zu „{query}“.{' '}
              <button type="button" class="link-button" onClick={() => setQuery('')}>
                Suche löschen
              </button>
            </p>
          ) : (
            <FolderShelf items={filtered} onOpen={(item) => navigate({ page: 'folder', folder: item.number })} addTile={!query} />
          )}
        </section>
        {/* Under the shelf; on phones after the room on the card, so "In einen Ordner packen" is not the last thing on the page. */}
        {query ? null : <PicksTeaser />}
      </div>
      {health ? <HealthDialog onClose={() => setHealth(false)} /> : null}
      {rename ? <RenameBox onClose={() => setRename(false)} /> : null}
      {findCovers ? <BulkCoverDialog targets={findCovers} onClose={() => setFindCovers(null)} /> : null}
      {reread ? <RereadDialog onClose={() => setReread(false)} /> : null}
      {contents ? <ContentListDialog onClose={() => setContents(false)} /> : null}
    </div>
  );
}

/**
 * How much of what the box can play is taken (draft B): the fullest folder
 * against the 255 titles one folder holds (the folders of the 99 a box plays
 * stand in the facts under the name). Both limits are the same for TonUINO
 * 2.1 and TNG (sd.ts). Only numbers the shelf has anyway; the folder counts
 * by its highest title number, as that is what a card names. A thin strip
 * under the head (#80), in one line down to 1366 px: the number with a
 * short bar, then the series that could share a folder.
 */
function RoomOnCard({ shelf }: { shelf: ShelfItem[] }) {
  let fullest: ShelfItem | null = null;
  let top = 0;
  for (const i of shelf) {
    for (const t of i.folder?.tracks ?? []) {
      if (t.number > top) {
        top = t.number;
        fullest = i;
      }
    }
  }
  const bar = (n: number, of: number) => (
    <span class="capacity" aria-hidden="true">
      <span style={{ width: `${Math.min(100, (n / of) * 100)}%` }} />
    </span>
  );
  return (
    <section class="box-room box-status" aria-labelledby="box-room-h">
      <h2 id="box-room-h">Platz auf der Karte</h2>
      {fullest ? (
        <span class="box-room-line">
          <span>Längster Ordner: {fullest.name}</span>
          <span>
            <b>{top}</b> von {MAX_TRACKS} Titeln
          </span>
          {bar(top, MAX_TRACKS)}
        </span>
      ) : null}
      {/* A series in many folders, and the button that packs it into one (PackSeries.tsx). */}
      <PackSeriesLine shelf={shelf} />
    </section>
  );
}

/** Reading the card again drops what waits for it in the app. */
function RereadDialog({ onClose }: { onClose: () => void }) {
  const p = packageState.value;
  const n = plan.value?.count ?? 0;
  return (
    <Dialog
      title="Karte neu einlesen?"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="danger"
            onClick={() => {
              onClose();
              chooseCardFolder('card');
            }}
          >
            Neu einlesen
          </Button>
        </>
      }
    >
      <p>
        {rereadText(p.kind === 'pending' ? n : 0)}
      </p>
    </Dialog>
  );
}

/** Offers to fill in titles and covers for folders copied with other programs. */
function DiscoverBanner({ numbers }: { numbers: number[] }) {
  const s = card.value!;
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const run = async () => {
    setBusy({ done: 0, total: numbers.length });
    try {
      const found: Discovered[] = [];
      for (const n of numbers) {
        const d = await discoverFolder(s.volume.root, s.scan!, n).catch(() => null);
        if (d) found.push(d);
        setBusy({ done: found.length, total: numbers.length });
      }
      await updateCatalog(
        (c) => {
          for (const d of found) c.folders[String(d.folder).padStart(2, '0')] = d.entry;
        },
        { touchFolders: found.map((d) => d.folder) },
      );
      for (const d of found) if (d.cover) await setCover(d.folder, d.cover.data, d.cover.mimeType, 'Datei');
      const withCover = found.filter((d) => d.cover).length;
      const covers = !withCover ? '' : withCover === found.length ? ' und Cover' : `, ${withCover} davon mit Cover`;
      toast.success('Ordner übernommen', `${plural(found.length, 'Ordner hat', 'Ordner haben')} jetzt Namen${covers}.`);
    } catch (e) {
      toastError('Das Einlesen hat nicht geklappt', e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Callout tone="neutral" icon={null}>
      <div class="row wrap" style={{ gap: 12 }}>
        <div class="grow" style={{ minWidth: 240 }}>
          <b>{plural(numbers.length, 'Ordner kenne', 'Ordner kenne')} ich noch nicht.</b> {numbers.length === 1 ? 'Er wurde' : 'Sie wurden'} mit einem anderen Programm aufgespielt. Namen, Titel und Cover kann ich aus den Dateien übernehmen.
        </div>
        <Button size="sm" loading={!!busy} onClick={run}>
          {busy ? `${busy.done} von ${busy.total}` : 'Übernehmen'}
        </Button>
      </div>
    </Callout>
  );
}

function RenameBox({ onClose }: { onClose: () => void }) {
  const s = card.value!;
  const [name, setName] = useState(s.catalog?.name ?? '');
  const save = async () => {
    await updateCatalog((c) => {
      c.name = name.trim() || c.name;
    }).catch((e) => toastError('Speichern hat nicht geklappt', e));
    onClose();
  };
  return (
    <Dialog
      title="Name der Box"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input class="input big" value={name} onInput={(e) => setName(e.currentTarget.value)} autofocus />
      </form>
    </Dialog>
  );
}

export function useAutoRefresh() {
  useEffect(() => {
    const onFocus = () => {
      // A snapshot does not change behind the app's back: nothing to look at again.
      if (card.value?.status === 'ready' && card.value.volume.access !== 'snapshot') void rescan().catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}

