/**
 * 0.6 „Schlank neu“: the bar on top of a computer's window and the bar at
 * the bottom of a phone, instead of the sidebar of 0.5.
 *
 * On top: the mark, the three tasks as words on their caps (Musik yellow,
 * Karte blue, Sticker red), the SD card with its name, free space and
 * „Auswerfen“ (always in the same place), and „Werkstatt“ behind which all
 * else is. On a phone: Musik, Karte, Sticker and „Mehr“ at the bottom, the
 * open one underlined. The caps are always lit in their full colour.
 */
import { computed, effect, signal } from '@preact/signals';
import { CircleAlert, TriangleAlert } from 'lucide-preact';
import type { Icon } from '../ui/icons';
import { ArcadeCap, CapDrucker, CapHoch, CapKarte, CapMehr, CapSchluessel, type CapColor } from '../ui/icons/caps';
import { LogoMark } from '../ui/components/Logo';
import { Button } from '../ui/components/controls';
import { MenuButton, type MenuItem } from '../ui/components/Menu';
import { toast, toastError } from '../ui/components/Toast';
import { navigate, route, routeToHash, type Route } from './router';
import { card, chooseOtherCard, ejectCard, needsPermission, openVolume, plat, platform, shownMemory, startingUp } from './state';
import { writeGuard } from './writeguard';
import { formatBytes } from './format';
import { handheldWord } from './device';
import { cardChangedElsewhere, cardReading, chooseCardFolder, packageState, plan, snapshotOfCard } from './pending';
import { openPackageDialog } from '../features/box/PackageDialog';
import { timeOfDay, waitingText } from '../features/box/packageTexts';
import { FORUM_URL } from '../features/help/ExternalLink';
import { isComputerDrive, problemWords } from '../core/tonuino/health';
import { UpdateNotice } from './UpdateNotice';
import { autoCovers, searchLine } from '../features/covers/autoCoverState';

export interface Task {
  route: Route;
  label: string;
  /** The name in the bar of a phone (and on top in a narrow window). */
  short: string;
  icon: Icon;
  cap: CapColor;
}

/** The three tasks in front, in this order everywhere (06-entwuerfe). */
export const TASKS: readonly Task[] = [
  { route: { page: 'musik' }, label: 'Musik auf die SD-Karte', short: 'Musik', icon: CapHoch, cap: 'gelb' },
  { route: { page: 'karte' }, label: 'Karte beschreiben', short: 'Karte', icon: CapKarte, cap: 'blau' },
  { route: { page: 'sticker' }, label: 'Sticker drucken', short: 'Sticker', icon: CapDrucker, cap: 'rot' },
];

/** The task a page belongs to; every other page is behind „Werkstatt“ („Mehr“ on a phone). */
export function taskOf(page: Route['page']): Route['page'] | 'workshop' {
  return TASKS.some((t) => t.route.page === page) ? page : 'workshop';
}

/** The start page: the music on a computer, the cards on the phone, where there is no SD card. */
export function startPage(mobile: boolean): Route {
  return mobile ? { page: 'karte' } : { page: 'musik' };
}

/** The SD card the music was opened with last (Volume.id), for the dot of the Android app below. */
const musicSeenWith = signal<string | null>(null);
effect(() => {
  const s = card.value;
  const page = route.value.page;
  if (s && (page === 'musik' || page === 'box' || page === 'folder')) musicSeenWith.value = s.volume.id;
});

/**
 * The Android app opens at „Karte beschreiben“ even when a card reader with
 * the SD card is plugged in already. Then „Musik“ gets a dot, until it (or
 * Meine Box) is opened.
 */
export const cardWaits = computed(() => {
  const s = card.value;
  return !!platform.value?.mobile && !!s && s.status === 'ready' && musicSeenWith.value !== s.volume.id;
});

/** The forum opens outside the app: in a new tab, or in the system browser of the desktop app. */
export function openForum() {
  const p = platform.value;
  if (p?.kind === 'desktop') void p.openExternal(FORUM_URL).catch(() => toast.error('Der Link ließ sich nicht öffnen', `Öffne ihn selbst in deinem Browser: ${FORUM_URL}`));
  else window.open(FORUM_URL, '_blank', 'noopener,noreferrer');
}

/** A small SD card drawn in ink (06-entwuerfe, teile.js): not a symbol from an icon set. */
export function SdGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg class="sd-glyph" width={size * 0.8} height={size} viewBox="0 0 16 20" aria-hidden="true">
      <path
        d="M3 1.2 L10.6 1 L14.6 5 L14.8 17.4 C14.8 18.3 14.2 18.9 13.3 18.9 L2.9 19 C2 19 1.3 18.4 1.3 17.5 L1.4 2.8 C1.4 1.9 2.1 1.2 3 1.2 Z"
        fill="#fff"
        stroke="#2a1f16"
        stroke-width="1.8"
        stroke-linejoin="round"
      />
      <path d="M4.5 3.6v3.2 M7 3.6v3.2 M9.5 3.6v3.2" stroke="#2a1f16" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

/** Where the app cannot eject the card itself, the system has to, or the last writes may get lost. */
export function ejectHint(os: string | undefined, mobile: boolean): string {
  // The Android app: a card reader at the phone is ejected in the phone's settings.
  if (mobile) return 'Vor dem Herausziehen den SD-Kartenleser in den Einstellungen des Handys unter „Speicher“ auswerfen.';
  const where = os === 'windows' ? 'im Explorer' : os === 'macos' ? 'im Finder' : 'im Dateimanager';
  return `Vor dem Herausziehen die Karte ${where} auswerfen.`;
}

/** Opens the SD card the person picks (browsers without a look at the drives, the desktop app on a computer). */
export async function pickSdCard() {
  try {
    const v = await plat().volumes.pick();
    if (v) await openVolume(v);
  } catch (e) {
    toastError('Die Karte ließ sich nicht öffnen', e);
  }
}

async function eject() {
  try {
    const note = await ejectCard();
    toast.success('Du kannst die SD-Karte jetzt herausnehmen.', note);
  } catch (e) {
    toastError('Auswerfen hat nicht geklappt', e);
  }
}

/** What the SD card line says: its name and free space, or what to do without one. */
interface SdLine {
  name: string;
  /** e.g. "21,2 GB frei" or "eingelesen um 10:12". */
  more?: string;
  /** Nothing to show yet (looking for the card right after the start). */
  hidden?: boolean;
  /** No card: the words say what to do. */
  none?: boolean;
  status?: 'error' | 'warning';
  /** What the mark next to the name means, in words (Prüfrunde 1 B1). */
  problem?: ReturnType<typeof problemWords>;
  /** `more` says what still waits for the card (the Paket): it keeps its room, the name gives way. */
  waits?: boolean;
  title?: string;
  /** The covers searched in the background: „Suche Cover … 4 von 12“ while it runs. */
  search?: string;
}

function sdLine(): SdLine {
  const line = cardLine();
  // Meine Box shows a remembered box meanwhile: not the card, and the line says so too.
  const memory = shownMemory.value;
  if (memory && line.none) return { ...line, title: `Meine Box zeigt den gemerkten Stand von „${memory.catalog.name}“.` };
  const searching = !line.none && !snapshotOfCard.value ? searchLine(autoCovers.value) : null;
  return searching ? { ...line, search: searching } : line;
}

/**
 * What follows the card's name in the bar on top: the free space, or while the covers are searched,
 * „Suche Cover …“ in its place. The search writes over the free space, in the room that takes, and
 * says how far it is in the name's tooltip: the bar keeps its width, nothing in it moves, and
 * nothing is drawn again for each folder. It changed its width with each step before, and the
 * card's name and mark moved along until the search was done (Prüfrunde 2, webkit W3).
 */
function SdMore({ l }: { l: SdLine }) {
  if (!l.more && !l.search) return null;
  const problem = l.status === 'error' && l.problem?.short === l.more;
  const waits = l.waits ? 'sd-wartet' : '';
  if (!l.search || !l.more) return <span class={`sd-more ${problem && !l.search ? 'sd-problem' : ''} ${waits}`}> · {l.search ? 'Suche Cover …' : l.more}</span>;
  return (
    <span class={`sd-more sd-statt ${waits}`}>
      <span class={problem ? 'sd-problem' : undefined} aria-hidden="true">
        {' · '}
        {l.more}
      </span>
      <span class="sd-suche"> · Suche Cover …</span>
    </span>
  );
}

function cardLine(): SdLine {
  const s = card.value;
  const p = platform.value;
  if (!s) {
    const caps = p?.capabilities;
    if (startingUp.value && caps?.sd) return { name: 'SD-Karte', more: 'frei', hidden: true };
    if (p && !caps?.sd && !caps?.sdPackage) return { name: 'Keine SD-Karte', none: true, title: p.handheld ? 'Im Browser am Handy geht die SD-Karte nicht.' : 'Dieser Browser kann keine SD-Karte lesen.' };
    if (caps?.sdPackage) return { name: 'Keine SD-Karte eingelesen', none: true };
    if (caps?.sdAutoDetect) return { name: 'Stecke die SD-Karte der Box ein', none: true, title: 'Ich finde sie von selbst.' };
    return { name: 'Keine SD-Karte drin', none: true };
  }
  const info = s.info;
  const setUp = s.catalogOnCard || s.scan?.kind === 'tonuino';
  const name = (setUp && s.catalog?.name) || s.volume.label;
  const report = s.report?.status;
  const status = report === 'error' || report === 'warning' ? report : undefined;
  const problem = problemWords(s.report);
  const snapshot = snapshotOfCard.value;
  if (snapshot) {
    const st = packageState.value;
    const n = plan.value?.count ?? 0;
    const pending = st.kind === 'pending' && !!plan.value?.changes.length;
    // Short in the bar, the name gives way to it: „Paket wartet aufs Entpacken“ was cut to „Paket…“ (Prüfrunde 1 B5, Prüfrunde 2 eltern 3).
    const more = cardChangedElsewhere.value
      ? 'Karte hat sich geändert'
      : st.kind === 'downloaded'
        ? 'Paket wartet'
        : pending
          ? `${n.toLocaleString('de-DE')} ${n === 1 ? 'wartet' : 'warten'}`
          : `Eingelesen um ${timeOfDay(snapshot.takenAt)}`;
    const waiting = pending ? waitingText(n) : st.kind === 'downloaded' ? 'Das Paket wartet darauf, dass du es auf die SD-Karte entpackst.' : undefined;
    return { name, more, status, problem, title: waiting, waits: !cardChangedElsewhere.value && (pending || st.kind === 'downloaded') };
  }
  const computer = isComputerDrive(info);
  // A problem says itself in place of the free space: a red mark alone said nothing (Prüfrunde 1 B1).
  const free = status === 'error' && problem ? problem.short : info.freeBytes !== undefined ? `${formatBytes(info.freeBytes)} frei` : undefined;
  if (computer) return { name, more: free, status, problem, title: p?.mobile ? `Ordner auf dem ${handheldWord()}, keine SD-Karte` : 'Ordner auf dem Computer, keine SD-Karte' };
  return { name, more: s.status === 'ready' ? free : 'wird gelesen …', status, problem, title: s.volume.root.path ?? s.volume.label };
}

/** The menu at the card's name: the way to Meine Box and to another card. */
function sdMenu(): MenuItem[] {
  const busy = writeGuard.running.value.some((k) => k !== 'selection');
  const items: MenuItem[] = [{ label: 'Meine Box öffnen', onSelect: () => navigate({ page: 'box' }) }];
  // The announcements are what a new card lacks most: the way to them right here.
  if (problemWords(card.value?.report)?.sounds) items.unshift({ label: 'Ansagen der Box aufspielen …', onSelect: () => navigate({ page: 'workshop', tool: 'ansagen' }) });
  if (card.value && !snapshotOfCard.value)
    items.push({
      label: 'Andere SD-Karte wählen …',
      disabled: busy,
      onSelect: () => {
        void chooseOtherCard();
        navigate({ page: 'box' });
      },
    });
  return items;
}

/** The button next to the card: eject it, bring the Paket, or get a card in. */
function SdAction({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const s = card.value;
  const p = platform.value;
  const caps = p?.capabilities;
  if (needsPermission.value)
    return (
      <Button size={size} onClick={() => plat().volumes.requestPermission?.()}>
        Zugriff erlauben
      </Button>
    );
  if (!s) {
    if (startingUp.value && caps?.sd) return <span class="sd-room" aria-hidden="true" />;
    if (caps?.sdPackage && !caps.sd)
      return (
        <Button size={size} loading={cardReading.value?.purpose === 'card'} onClick={() => chooseCardFolder('card')}>
          Einlesen …
        </Button>
      );
    if (caps?.sd && !caps.sdAutoDetect)
      return (
        <Button size={size} onClick={pickSdCard}>
          Auswählen …
        </Button>
      );
    return null;
  }
  if (snapshotOfCard.value) {
    const n = plan.value?.count ?? 0;
    const setUp = s.catalogOnCard || s.scan?.kind === 'tonuino';
    if (!setUp && !n) return null;
    // A frame button, not a second purple one beside the screen's own (Prüfrunde 1 B5): the words before it say what waits.
    return (
      <Button size={size} onClick={() => openPackageDialog()}>
        Paket
      </Button>
    );
  }
  if (s.volume.canEject)
    return (
      <Button size={size} onClick={eject} disabled={s.status !== 'ready'}>
        Auswerfen
      </Button>
    );
  return null;
}

function StatusMark({ status, text }: { status?: 'error' | 'warning'; text?: string }) {
  if (!status) return null;
  const Mark = status === 'error' ? CircleAlert : TriangleAlert;
  const said = text ?? (status === 'error' ? 'Die Karte hat einen Fehler' : 'Die Karte braucht einen Blick');
  return (
    <span class={`sd-mark-wrap`} title={said}>
      <Mark size={16} class={`sd-mark ${status}`} aria-label={said} role="img" />
    </span>
  );
}

/** The SD card in the bar on top: name · free space, „Auswerfen“. */
function SdKopf() {
  const l = sdLine();
  const p = platform.value;
  const ejectNote = card.value && !snapshotOfCard.value && !card.value.volume.canEject ? ejectHint(p?.os, !!p?.mobile) : undefined;
  return (
    <div class={`sd-zeile ${l.none ? 'none' : ''}`} style={l.hidden ? { visibility: 'hidden' } : undefined} aria-hidden={l.hidden ? 'true' : undefined}>
      <SdGlyph />
      {l.none ? (
        <span class="sd-none" title={l.title}>
          {l.name}
        </span>
      ) : (
        <MenuButton
          trigger={(open, isOpen) => (
            <button type="button" class="sd-name-button" aria-haspopup="menu" aria-expanded={isOpen} title={[l.search, l.problem?.long, l.title, ejectNote].filter(Boolean).join(' · ') || undefined} onClick={open}>
              <StatusMark status={l.status} text={l.problem?.long} />
              <span class="sd-name">{l.name}</span>
              <SdMore l={l} />
            </button>
          )}
          items={sdMenu()}
        />
      )}
      <SdAction />
    </div>
  );
}

/** The SD card as the first line on a phone („Musik“): name, free space under it, „Auswerfen“. */
export function SdZeile() {
  const line = sdLine();
  // A line of its own here, under the name: the search in place of the free space moves nothing else.
  const l = line.search ? { ...line, more: line.search } : line;
  return (
    <div class={`sd-oben ${l.none ? 'none' : ''}`} style={l.hidden ? { visibility: 'hidden' } : undefined}>
      <SdGlyph size={24} />
      <span class="sd-wer" title={l.title}>
        {l.none ? (
          <span class="sd-none">{l.name}</span>
        ) : (
          <a class="sd-name" href={routeToHash({ page: 'box' })}>
            <StatusMark status={l.status} text={l.problem?.long} />
            {l.name}
          </a>
        )}
        {l.more && !l.none ? <span class={l.status === 'error' && l.problem?.short === l.more ? 'sd-problem' : 'muted'}>{l.more}</span> : null}
      </span>
      <SdAction size="md" />
    </div>
  );
}

/** The bar on top of a computer's window. Hidden on a phone, where the bar at the bottom takes over (schlank.css). */
export function Kopf() {
  const here = taskOf(route.value.page);
  const home = routeToHash(startPage(!!platform.value?.mobile));
  return (
    <header class="kopf">
      <a class="marke" href={home} aria-label="TonUINO Studio, Startseite">
        <LogoMark size={38} />
        <b>TonUINO Studio</b>
      </a>
      <nav class="aufgaben" aria-label="Hauptmenü">
        {TASKS.map((t) => (
          <a key={t.short} class="tab" href={routeToHash(t.route)} aria-current={here === t.route.page ? 'page' : undefined} title={t.label}>
            <ArcadeCap icon={t.icon} color={t.cap} size={30} />
            <span class="tab-long">{t.label}</span>
            <span class="tab-short" aria-hidden="true">
              {t.short}
            </span>
          </a>
        ))}
      </nav>
      <span class="rest" />
      <SdKopf />
      <UpdateNotice />
      <span class="trenn" aria-hidden="true" />
      {/* From every screen one click to the help, not only from the Werkstatt (Prüfrunde 1 B6). */}
      <a class="hilfe-kopf" href={routeToHash({ page: 'help' })} aria-current={route.value.page === 'help' ? 'page' : undefined}>
        Hilfe
      </a>
      {/* On the help only „Hilfe“ is marked: one sign for „you are here“ (Prüfrunde 2, eltern 7 and WebKit W5). */}
      <a class="werkstatt" href={routeToHash({ page: 'workshop' })} aria-current={here === 'workshop' && route.value.page !== 'help' ? 'page' : undefined}>
        <ArcadeCap icon={CapSchluessel} color="weiss" size={30} />
        Werkstatt
      </a>
    </header>
  );
}

/** The bar at the bottom of a phone: the three tasks and „Mehr“ (the Werkstatt). */
export function Leiste() {
  const here = taskOf(route.value.page);
  const dot = cardWaits.value;
  return (
    <nav class="leiste" aria-label="Hauptmenü">
      {TASKS.map((t) => {
        const badge = t.route.page === 'musik' && dot;
        return (
          <a key={t.short} href={routeToHash(t.route)} aria-current={here === t.route.page ? 'page' : undefined} aria-label={badge ? `${t.label}, die SD-Karte ist da` : t.label}>
            <ArcadeCap icon={t.icon} color={t.cap} size={32} />
            <span aria-hidden="true">{t.short}</span>
            {badge ? <b class="leiste-dot" aria-hidden="true" /> : null}
          </a>
        );
      })}
      <a href={routeToHash({ page: 'workshop' })} aria-current={here === 'workshop' ? 'page' : undefined} aria-label="Mehr: Meine Box, Werkstatt, Einstellungen, Hilfe">
        <ArcadeCap icon={CapMehr} color="weiss" size={32} />
        <span aria-hidden="true">Mehr</span>
      </a>
    </nav>
  );
}
