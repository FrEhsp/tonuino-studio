import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/** Gap between the button and its menu, in px. */
const MENU_GAP = 6;

/**
 * Where a menu that should open below its button goes: below if it fits above
 * `limit` (the bottom of the window, or the top of the phone's tab bar), else
 * above if it fits there, else below and the page scrolls it into view.
 */
export function menuPlacement({ triggerTop, triggerBottom, menuHeight, limit }: { triggerTop: number; triggerBottom: number; menuHeight: number; limit: number }): 'below' | 'above' {
  if (triggerBottom + MENU_GAP + menuHeight <= limit) return 'below';
  if (triggerTop - MENU_GAP - menuHeight >= 0) return 'above';
  return 'below';
}

/** The lowest point a menu may reach: the window's bottom, or the top of the phone tab bar when it is shown. */
function visibleBottom(): number {
  const tabs = document.querySelector('.leiste');
  const top = tabs && getComputedStyle(tabs).display !== 'none' ? tabs.getBoundingClientRect().top : Infinity;
  return Math.min(window.innerHeight, top);
}

/**
 * Where an open menu stands in the window. It is fixed to the window, not to
 * its button's box: a list that scrolls (the titles on "Hinzufügen") or a card
 * would otherwise cut it off (Frank 2026-10-17, menu of the only title).
 */
export function menuSpot({
  button,
  menuHeight,
  limit,
  width,
  align,
  placement,
}: {
  button: { top: number; bottom: number; left: number; right: number };
  menuHeight: number;
  limit: number;
  width: number;
  align: 'left' | 'right';
  placement: 'below' | 'above';
}): { top: number; left?: number; right?: number } {
  const side = placement === 'above' ? 'above' : menuPlacement({ triggerTop: button.top, triggerBottom: button.bottom, menuHeight, limit });
  let top = side === 'above' ? button.top - MENU_GAP - menuHeight : button.bottom + MENU_GAP;
  // Fits neither below nor above: as low as it goes without leaving the window.
  top = Math.max(0, Math.min(top, limit - menuHeight));
  return align === 'right' ? { top, right: Math.max(0, width - button.right) } : { top, left: Math.max(0, button.left) };
}

/** How far the button of an open menu may move before the menu closes (a list that scrolls takes it away). */
const MOVED_PX = 4;

/**
 * Whether an open menu stays open when the window changes size. Only a new
 * width closes it (the window or the phone turned). A new height alone is
 * the phone's keyboard going away, or its address bar: the first tap on
 * "…" while the keyboard was open (a number typed, a title renamed) closes
 * the keyboard, and the menu that just opened closed with it (0.6, 360 px).
 */
export function staysOpenOnResize(widthAtOpen: number, width: number): boolean {
  return Math.abs(width - widthAtOpen) < 1;
}

/** Whether an open menu stays open when something scrolls: as long as its button stays where the menu was placed. */
export function staysOpenOnScroll(placedAt: { top: number; left: number }, now: { top: number; left: number }): boolean {
  return Math.abs(now.top - placedAt.top) <= MOVED_PX && Math.abs(now.left - placedAt.left) <= MOVED_PX;
}

/** A button that opens a small menu below it (or above it, e.g. in a bar at the bottom of the screen). */
export function MenuButton({
  trigger,
  items,
  align = 'right',
  placement = 'below',
}: {
  trigger: (open: () => void, isOpen: boolean) => ComponentChildren;
  items: MenuItem[];
  align?: 'left' | 'right';
  placement?: 'below' | 'above';
}) {
  const [open, setOpen] = useState(false);
  const [spot, setSpot] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Where the button was when the menu was placed. */
  const placedAt = useRef<{ top: number; left: number } | null>(null);
  const place = () => {
    if (!ref.current || !menu.current) return;
    const button = ref.current.getBoundingClientRect();
    placedAt.current = { top: button.top, left: button.left };
    setSpot(
      menuSpot({
        button,
        menuHeight: menu.current.getBoundingClientRect().height,
        limit: visibleBottom(),
        width: document.documentElement.clientWidth,
        align,
        placement,
      }),
    );
  };
  // Placed before it is painted: below the button, or above it when it would run under the phone tab bar or off the window.
  useLayoutEffect(() => {
    if (!open) {
      setSpot(null);
      return;
    }
    place();
  }, [open, placement, align]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // A menu fixed to the window would stay behind when its list scrolls: it closes instead.
    // Not for a scroll that leaves its button where it was (the page settling after the keyboard went).
    const scrolled = (e: Event) => {
      if (menu.current?.contains(e.target as Node)) return;
      const b = ref.current?.getBoundingClientRect();
      if (b && placedAt.current && staysOpenOnScroll(placedAt.current, b)) return;
      setOpen(false);
    };
    const widthAtOpen = window.innerWidth;
    // Turned or made narrower: closed. Only taller or lower (the keyboard, the address bar): placed again.
    const resized = () => {
      if (staysOpenOnResize(widthAtOpen, window.innerWidth)) place();
      else setOpen(false);
    };
    const away = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', resized);
    // Another page under it (the back button of the phone or the mouse): the menu belongs to the page before.
    window.addEventListener('hashchange', away);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', resized);
      window.removeEventListener('hashchange', away);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger(() => setOpen(!open), open)}
      {open ? (
        <div ref={menu} class="menu" role="menu" style={spot ? { position: 'fixed', top: `${spot.top}px`, left: spot.left === undefined ? 'auto' : `${spot.left}px`, right: spot.right === undefined ? 'auto' : `${spot.right}px` } : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}>
          {items.map((it) => (
            <>
              {it.separatorBefore ? <hr /> : null}
              <button
                role="menuitem"
                class={it.danger ? 'danger' : ''}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon ? <it.icon size={16} strokeWidth={2.2} /> : null}
                {it.label}
              </button>
            </>
          ))}
        </div>
      ) : null}
    </div>
  );
}
