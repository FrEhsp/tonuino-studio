import type { ComponentChildren } from 'preact';
import { computed, effect, signal } from '@preact/signals';
import { CardSim, CircleAlert, CircleCheck, CircleDashed, Eject, MessagesSquare, Package, TriangleAlert } from 'lucide-preact';
import type { Icon } from '../ui/icons';
import { ArcadeCap, CapBox, CapDrucker, CapFrage, CapKarte, CapKompass, CapSchluessel, CapMehr, CapMikro, CapPlus, CapZahnrad } from '../ui/icons/caps';
import type { CapColor } from '../ui/icons/caps';
import { Logo } from '../ui/components/Logo';
import { Button } from '../ui/components/controls';
import { MenuButton } from '../ui/components/Menu';
import { toastError, toast } from '../ui/components/Toast';
import { navBadge, sourcesAvailable } from '../features/sources/state';
import { navigate, route, routeToHash, type Route } from './router';
import { card, chooseOtherCard, ejectCard, needsPermission, plat, platform, recordingInImport, shownMemory, startingUp } from './state';
import { writeGuard } from './writeguard';
import { formatBytes } from './format';
import { handheldWord } from './device';
import { cardChangedElsewhere, packageState, plan, snapshotOfCard } from './pending';
import { openPackageDialog } from '../features/box/PackageDialog';
import { timeOfDay, waitingText } from '../features/box/packageTexts';
import { ExternalLink, FORUM_URL } from '../features/help/ExternalLink';
import { isComputerDrive } from '../core/tonuino/health';
import { UpdateNotice } from './UpdateNotice';
import type { Platform } from '../platform/types';
import { PHONE_QUERY, useMedia } from '../ui/useMedia';

/** A small mark next to a menu item, e.g. the progress of a download. */
type NavBadge = { text?: string; label: string } | null;

/** The SD card Meine Box was opened with last (Volume.id), for the dot of the Android app below. */
const boxSeenWith = signal<string | null>(null);
effect(() => {
  const s = card.value;
  const page = route.value.page;
  if (s && (page === 'box' || page === 'folder')) boxSeenWith.value = s.volume.id;
});

/**
 * The Android app opens at the cards even when a card reader with the SD
 * card is plugged in already. Then Meine Box gets a dot, until it is opened.
 */
export const cardWaitsInBox = computed(() => {
  const s = card.value;
  return !!platform.value?.mobile && !!s && s.status === 'ready' && boxSeenWith.value !== s.volume.id;
});

function boxBadge(): NavBadge {
  return cardWaitsInBox.value ? { label: 'die SD-Karte ist da' } : null;
}

/*
 * Every page sits on a button cap, like the buttons on the front of a box.
 * As in 0.3 a cap lights up in its colour only for the open page and under
 * the pointer (stil-holz.css). The colours take turns red, yellow, green,
 * blue down the menu, set here by hand so a hidden entry (Entdecken in some
 * builds) does not shift the colours of the others.
 */
interface NavItem {
  route: Route;
  label: string;
  /** The name in the tab bar and in the narrow menu of a tablet. */
  short: string;
  icon: Icon;
  cap: CapColor;
  match: Route['page'][];
  badge?: () => NavBadge;
  hidden?: () => boolean;
}

const NAV: NavItem[] = [
  { route: { page: 'box' }, label: 'Meine Box', short: 'Meine Box', icon: CapBox, cap: 'rot', match: ['box', 'folder'], badge: boxBadge },
  { route: { page: 'add' }, label: 'Hinzufügen', short: 'Hinzufügen', icon: CapPlus, cap: 'gelb', match: ['add'] },
  { route: { page: 'sources' }, label: 'Entdecken', short: 'Entdecken', icon: CapKompass, cap: 'gruen', match: ['sources'], badge: () => navBadge.value, hidden: () => !sourcesAvailable.value },
  { route: { page: 'stickers' }, label: 'Sticker drucken', short: 'Sticker', icon: CapDrucker, cap: 'blau', match: ['stickers'] },
  { route: { page: 'cards' }, label: 'Karten beschreiben', short: 'Karten', icon: CapKarte, cap: 'rot', match: ['cards'] },
  { route: { page: 'workshop' }, label: 'Werkstatt', short: 'Werkstatt', icon: CapSchluessel, cap: 'gelb', match: ['workshop'] },
];

const NAV2: NavItem[] = [
  { route: { page: 'help' }, label: 'Hilfe', short: 'Hilfe', icon: CapFrage, cap: 'gruen', match: ['help'] },
  { route: { page: 'settings' }, label: 'Einstellungen', short: 'Einstellungen', icon: CapZahnrad, cap: 'blau', match: ['settings'] },
];

/** Recording from the phone's microphone: a page of its own, only in the Android app. */
const RECORD: NavItem = { route: { page: 'record' }, label: 'Selbst aufnehmen', short: 'Aufnehmen', icon: CapMikro, cap: 'gelb', match: ['record'] };

/**
 * The Android app: writing cards and recording are what a phone is for
 * (Frank), so they come first, then Meine Box. Its own colours, so the
 * caps still take turns down the menu.
 */
const PHONE_ORDER: { page: Route['page']; cap: CapColor }[] = [
  { page: 'cards', cap: 'rot' },
  { page: 'record', cap: 'gelb' },
  { page: 'box', cap: 'gruen' },
  { page: 'add', cap: 'blau' },
  { page: 'sources', cap: 'rot' },
  { page: 'stickers', cap: 'gelb' },
  { page: 'workshop', cap: 'blau' },
];

const PHONE_NAV: NavItem[] = PHONE_ORDER.flatMap(({ page, cap }) => {
  const item = [...NAV, RECORD].find((n) => n.route.page === page);
  return item ? [{ ...item, cap }] : [];
});

/**
 * Whether a menu entry is the page you are on. A recording on its way to the
 * card shows on „Hinzufügen“, but it is still „Aufnehmen“ for whoever made
 * it: on a phone that tab stays lit, not „Mehr“ (audit 0.4 #27).
 */
function isHere(item: NavItem, page: Route['page']): boolean {
  // Only the Android app has „Aufnehmen“ in its menu; elsewhere „Hinzufügen“ stays the page.
  if (page === 'add' && recordingInImport.value && platform.value?.mobile) return item.route.page === 'record';
  // Elsewhere „Selbst aufnehmen“ is a way of „Hinzufügen“ (its link is there), so that entry stays lit instead of none.
  if (page === 'record' && !platform.value?.mobile) return item.route.page === 'add';
  return item.match.includes(page);
}

/** The menu of this app: the Android app has its own order (see PHONE_ORDER). */
export function navItems(mobile: boolean): NavItem[] {
  return mobile ? PHONE_NAV : NAV;
}

function NavLink({ item }: { item: NavItem }) {
  const active = isHere(item, route.value.page);
  const badge = item.badge?.();
  // The label keeps its name when narrow screens show only the icon; a badge adds what it shows.
  return (
    <a
      href={routeToHash(item.route)}
      aria-current={active ? 'page' : undefined}
      aria-label={badge ? `${item.label}, ${badge.label}` : item.label}
      title={badge ? `${item.label}: ${badge.label}` : item.label}
    >
      <ArcadeCap icon={item.icon} color={item.cap} size={30} />
      <span class="nav-label">{item.label}</span>
      {/* The narrow menu of a tablet held sideways shows the short name under the cap (layout.css). */}
      <span class="nav-short" aria-hidden="true">
        {item.short}
      </span>
      {badge ? (
        <b class={`nav-badge ${badge.text ? '' : 'dot-only'}`} aria-hidden="true">
          {badge.text ?? ''}
        </b>
      ) : null}
    </a>
  );
}

function SdStatus() {
  const s = card.value;
  const p = platform.value;
  if (!s) {
    const pkg = !p?.capabilities.sd && p?.capabilities.sdPackage;
    const none = p && !p.capabilities.sd && !p.capabilities.sdPackage;
    // Still looking for the card right after the start: the box is there (its pen line takes its shape
    // from this first size, as always) but says nothing that is gone again a moment later.
    const looking = startingUp.value;
    // Where a card may turn up by itself, the hidden box has the shape of a card's box, so the card comes in without the box growing.
    if (looking && p?.capabilities.sd) return cardShapedPlaceholder(p);
    return (
      <div class="sd-status" aria-hidden={looking ? 'true' : undefined} style={looking ? { visibility: 'hidden' } : undefined}>
        <div class="sd-title">
          <CardSim size={17} />
          <span class="ellipsis">{pkg ? 'Keine SD-Karte eingelesen' : 'Keine SD-Karte'}</span>
        </div>
        <span class="muted">
          {none ? (
            p.handheld ? (
              'Die SD-Karte geht nur am Computer.'
            ) : (
              'Dieser Browser kann keine SD-Karte lesen.'
            )
          ) : pkg ? (
            <>
              Lies die SD-Karte unter <a href="#/">Meine Box</a> ein.
            </>
          ) : p?.capabilities.sdAutoDetect ? (
            'Stecke die SD-Karte ein, ich finde sie von selbst.'
          ) : (
            <>
              Wähle die SD-Karte unter <a href="#/">Meine Box</a> aus.
            </>
          )}
        </span>
        {/* Meine Box shows a remembered box meanwhile: not the card, and the sidebar says so too. */}
        {shownMemory.value ? <span class="muted tiny">Meine Box zeigt den gemerkten Stand von „{shownMemory.value.catalog.name}“.</span> : null}
        {needsPermission.value ? (
          <Button size="sm" variant="soft" onClick={() => plat().volumes.requestPermission?.()}>
            Zugriff erlauben
          </Button>
        ) : null}
      </div>
    );
  }
  const info = s.info;
  const snapshot = snapshotOfCard.value;
  // A folder on the computer's own drive: its numbers are the computer's, not a card's (see isComputerDrive).
  const computer = isComputerDrive(info);
  const used = !computer && info.totalBytes && info.freeBytes !== undefined ? info.totalBytes - info.freeBytes : undefined;
  // A drive with other files on it, or an empty one: the app's name for a box and a green tick would claim too much.
  const setUp = s.catalogOnCard || s.scan?.kind === 'tonuino';
  const name = (setUp && s.catalog?.name) || s.volume.label;
  const status = s.report?.status;
  const StatusIcon = status === 'error' ? CircleAlert : status === 'warning' ? TriangleAlert : CircleCheck;
  const color = status === 'error' ? 'var(--danger)' : status === 'warning' ? 'var(--warning-text)' : 'var(--success)';
  const icon =
    s.status !== 'ready' ? (
      <span class="spinner" style={{ width: 14, height: 14 }} />
    ) : setUp ? (
      <StatusIcon size={16} color={color} />
    ) : (
      <span title="Noch nicht eingerichtet" style={{ display: 'inline-flex' }}>
        <CircleDashed size={16} color="var(--text-muted)" aria-hidden="false" aria-label="Noch nicht eingerichtet" />
      </span>
    );
  if (snapshot) return <SnapshotStatus name={name} takenAt={snapshot.takenAt} icon={icon} setUp={setUp} />;
  const eject = async () => {
    try {
      const note = await ejectCard();
      toast.success('Du kannst die SD-Karte jetzt herausnehmen.', note);
    } catch (e) {
      toastError('Auswerfen hat nicht geklappt', e);
    }
  };
  return (
    <div class="sd-status">
      <div class="sd-title">
        <CardSim size={17} />
        <span class="ellipsis" title={s.volume.root.path ?? s.volume.label}>
          {name}
        </span>
        {icon}
      </div>
      {used !== undefined && info.totalBytes ? (
        <>
          <div class="capacity" title={`${formatBytes(used)} von ${formatBytes(info.totalBytes)} belegt`}>
            <div style={{ width: `${Math.min(100, (used / info.totalBytes) * 100)}%` }} />
          </div>
          <span class="muted tiny">
            {formatBytes(info.freeBytes!)} frei von {formatBytes(info.totalBytes)}
          </span>
        </>
      ) : computer ? (
        <span class="muted tiny" title={s.volume.root.path}>
          {p?.mobile ? `Ordner auf dem ${handheldWord()}, keine SD-Karte` : 'Ordner auf dem Computer, keine SD-Karte'}
          {info.freeBytes !== undefined ? ` · ${formatBytes(info.freeBytes)} frei ${p?.mobile ? `auf dem ${handheldWord()}` : 'auf diesem Laufwerk'}` : ''}
        </span>
      ) : (
        <span class="muted tiny ellipsis" title={s.volume.root.path}>
          {s.volume.root.path ?? (platform.value?.kind === 'web' ? `Laufwerk „${s.volume.label}“` : s.volume.label)}
        </span>
      )}
      {/* The way to a second box, not hidden in a menu. Not while the app writes to this card. */}
      <button type="button" class="link-button tiny" style={{ alignSelf: 'flex-start' }} disabled={writeGuard.running.value.some((k) => k !== 'selection')} onClick={() => { void chooseOtherCard(); navigate({ page: 'box' }); }}>
        Andere Karte wählen
      </button>
      {s.volume.canEject ? (
        <Button size="sm" icon={Eject} onClick={eject}>
          Auswerfen
        </Button>
      ) : (
        <span class="muted tiny">{ejectHint(p?.os, !!p?.mobile)}</span>
      )}
    </div>
  );
}

/**
 * The card's box as it will look in a moment (name, space, the way to another
 * card, ejecting), hidden: on the computer the system tells the free space and
 * the card can be ejected; in the browser neither.
 */
function cardShapedPlaceholder(p: Platform) {
  // Called, not rendered as a component: the same element then becomes the card's box.
  const desktop = p.kind === 'desktop';
  return (
    <div class="sd-status" aria-hidden="true" style={{ visibility: 'hidden' }}>
      <div class="sd-title">
        <CardSim size={17} />
        <span class="ellipsis">SD-Karte</span>
      </div>
      {desktop ? <div class="capacity" /> : null}
      <span class="muted tiny ellipsis">{desktop ? 'frei' : 'Laufwerk'}</span>
      <button type="button" class="link-button tiny" tabIndex={-1} style={{ alignSelf: 'flex-start' }}>
        Andere Karte wählen
      </button>
      {desktop ? (
        <Button size="sm" icon={Eject} tabIndex={-1}>
          Auswerfen
        </Button>
      ) : (
        <span class="muted tiny">{ejectHint(p.os, !!p.mobile)}</span>
      )}
    </div>
  );
}

/** A card read in once (Firefox, Safari): when, and what waits for it. Nothing to eject: the app never writes to it. */
function SnapshotStatus({ name, takenAt, icon, setUp }: { name: string; takenAt: number; icon: ComponentChildren; setUp: boolean }) {
  const st = packageState.value;
  const n = plan.value?.count ?? 0;
  // Only the app's own files changed (names, stickers, how cards play): nothing the box plays yet, so no reason to hurry.
  const appOnly = !plan.value?.changes.length;
  return (
    <div class="sd-status">
      <div class="sd-title">
        <CardSim size={17} />
        <span class="ellipsis" title={name}>
          {name}
        </span>
        {icon}
      </div>
      <span class="muted tiny">Eingelesen um {timeOfDay(takenAt)}</span>
      {cardChangedElsewhere.value ? (
        <span class="muted">Karte hat sich geändert</span>
      ) : st.kind === 'downloaded' ? (
        <span class="muted">Paket wartet aufs Entpacken</span>
      ) : st.kind === 'pending' ? (
        <span class="muted">{appOnly ? 'Änderungen in der App kommen mit dem nächsten Paket' : waitingText(n, true)}</span>
      ) : null}
      {/* Nothing to bring onto a card that is not set up yet. */}
      {setUp || n > 0 ? (
        <Button size="sm" variant="soft" icon={Package} onClick={() => openPackageDialog()}>
          Paket
        </Button>
      ) : null}
    </div>
  );
}

/** Where the app cannot eject the card itself, the system has to, or the last writes may get lost. */
function ejectHint(os: string | undefined, mobile: boolean): string {
  // The Android app: a card reader at the phone is ejected in the phone's settings.
  if (mobile) return 'Vor dem Herausziehen den SD-Kartenleser in den Einstellungen des Handys unter „Speicher“ auswerfen.';
  const where = os === 'windows' ? 'im Explorer' : os === 'macos' ? 'im Finder' : 'im Dateimanager';
  return `Vor dem Herausziehen die Karte ${where} auswerfen.`;
}

/**
 * Phones and small tablets: the four things families do most, each with its
 * name, in a bar at the bottom of the screen; the rest, and the forum, under
 * "Mehr". The sidebar then only shows the mark and the SD card.
 */
const PHONE_TAB_PAGES: Route['page'][] = ['box', 'add', 'stickers', 'cards'];

/** Picked by page, in the order of the sidebar, so reordering NAV cannot swap a tab. */
export const PHONE_TABS: NavItem[] = NAV.filter((item) => PHONE_TAB_PAGES.includes(item.route.page));

/**
 * The Android app: the cards first, recording second, never hidden under
 * "Mehr" (Frank), then Meine Box. An APK without the SD card (without its
 * bridges) has what works on the phone in the bar instead, the cards first;
 * the pages that need a computer go under "Mehr".
 */
export const ANDROID_TABS: NavItem[] = PHONE_NAV.filter((item) => ['cards', 'record', 'box'].includes(item.route.page));

export const MOBILE_TABS: NavItem[] = (['cards', 'sources', 'help'] as const).flatMap((page) => {
  const item = [...PHONE_NAV, ...NAV2].find((n) => n.route.page === page);
  return item ? [item] : [];
});

/**
 * Phones (up to 560 px, 0.5 #74, Frank 17.10. 04:38): Karten, Hinzufügen,
 * Sticker drucken, then "Mehr" with Meine Box first. Recording is a way of
 * adding (its button is on „Hinzufügen“) and stays in "Mehr" as well.
 * Tablets and wider keep their bar.
 */
export const HANDY_TABS: NavItem[] = (['cards', 'add', 'stickers'] as const).flatMap((page) => {
  const item = NAV.find((n) => n.route.page === page);
  return item ? [item] : [];
});

/** The tabs of this app, in their order; `phone` is the phone's width (PHONE_QUERY). */
export function tabsFor(p: Pick<Platform, 'mobile' | 'capabilities'> | null | undefined, phone = false): NavItem[] {
  // An APK without its SD bridge keeps what works on the phone.
  if (p?.mobile && !p.capabilities.sd) return MOBILE_TABS;
  if (phone) return HANDY_TABS;
  return p?.mobile ? ANDROID_TABS : PHONE_TABS;
}

/** On a phone „Selbst aufnehmen“ lights „Hinzufügen“, the way it belongs to; Meine Box leads the "Mehr" menu. */
function isHereOnPhone(item: NavItem, page: Route['page'], phone: boolean): boolean {
  if (!phone) return isHere(item, page);
  if (item.route.page === 'add') return page === 'add' || page === 'record';
  if (item.route.page === 'record') return false;
  return isHere(item, page);
}

export function PhoneTabs() {
  const page = route.value.page;
  const p = platform.value;
  const phone = useMedia(PHONE_QUERY);
  const tabs = tabsFor(p, phone).filter((item) => !item.hidden?.());
  const menu = navItems(!!p?.mobile);
  // The phone's "Mehr" starts with Meine Box, the place of the SD card.
  const ordered = phone ? [...menu.filter((n) => n.route.page === 'box'), ...menu.filter((n) => n.route.page !== 'box')] : menu;
  const more = [...ordered, ...NAV2].filter((n) => !tabs.some((t) => t.route.page === n.route.page) && !n.hidden?.());
  const here = (item: NavItem) => isHereOnPhone(item, page, phone);
  const recordingTab = tabs.some((t) => t.route.page === 'record' && here(t));
  const moreActive = !recordingTab && !tabs.some(here) && more.some(here);
  return (
    <nav class="phone-tabs" aria-label="Hauptmenü">
      {tabs.map((item) => {
        const badge = item.badge?.();
        return (
          <a class="phone-tab" href={routeToHash(item.route)} aria-current={here(item) ? 'page' : undefined} aria-label={badge ? `${item.label}, ${badge.label}` : item.label} key={item.label}>
            <ArcadeCap icon={item.icon} color={item.cap} size={30} />
            <span aria-hidden="true">{item.short}</span>
            {badge ? (
              <b class={`nav-badge ${badge.text ? '' : 'dot-only'}`} aria-hidden="true">
                {badge.text ?? ''}
              </b>
            ) : null}
          </a>
        );
      })}
      <MenuButton
        placement="above"
        trigger={(open, isOpen) => (
          <button type="button" class="phone-more" aria-current={moreActive ? 'page' : undefined} aria-expanded={isOpen} aria-haspopup="menu" onClick={open}>
            <ArcadeCap icon={CapMehr} color="gruen" size={30} />
            <span>Mehr</span>
          </button>
        )}
        items={[
          ...more.map((n) => {
            // A badge of the sidebar (e.g. new in Entdecken) shows in the menu as words.
            const badge = n.badge?.();
            return { label: badge ? `${n.label} (${badge.text ?? badge.label})` : n.label, icon: n.icon, onSelect: () => navigate(n.route) };
          }),
          { label: 'TonUINO-Forum', icon: MessagesSquare, separatorBefore: true, onSelect: openForum },
        ]}
      />
    </nav>
  );
}

/** The forum opens outside the app: in a new tab, or in the system browser of the desktop app. */
function openForum() {
  const p = platform.value;
  if (p?.kind === 'desktop') void p.openExternal(FORUM_URL).catch(() => toast.error('Der Link ließ sich nicht öffnen', `Öffne ihn selbst in deinem Browser: ${FORUM_URL}`));
  else window.open(FORUM_URL, '_blank', 'noopener,noreferrer');
}

export function Sidebar() {
  return (
    <nav class="sidebar" aria-label="Hauptmenü">
      <Logo home={platform.value?.mobile ? routeToHash({ page: 'cards' }) : '#/'} />
      <div class="nav">
        {navItems(!!platform.value?.mobile)
          .filter((n) => !n.hidden?.())
          .map((n) => (
            <NavLink item={n} key={n.label} />
          ))}
      </div>
      <div class="nav-sep" />
      <div class="nav">
        {NAV2.map((n) => (
          <NavLink item={n} key={n.label} />
        ))}
      </div>
      <ExternalLink href={FORUM_URL} class="nav-forum">
        <MessagesSquare size={17} aria-hidden="true" />
        TonUINO-Forum
      </ExternalLink>
      <UpdateNotice />
      {/* The card's box keeps its room from the first picture on: a card coming in makes nothing above it move (layout.css). */}
      <div class="sd-slot">
        <SdStatus />
        {/* Phones: the card in the top bar is the way to Meine Box, which is under "Mehr" there (handy.css). */}
        <a class="sd-chip-link" href={routeToHash({ page: 'box' })} aria-label="Meine Box" tabIndex={-1} />
      </div>
    </nav>
  );
}
