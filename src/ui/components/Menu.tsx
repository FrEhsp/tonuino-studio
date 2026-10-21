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
  const tabs = document.querySelector('.phone-tabs');
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
  // Placed before it is painted: below the button, or above it when it would run under the phone tab bar or off the window.
  useLayoutEffect(() => {
    if (!open) {
      setSpot(null);
      return;
    }
    if (!ref.current || !menu.current) return;
    setSpot(
      menuSpot({
        button: ref.current.getBoundingClientRect(),
        menuHeight: menu.current.getBoundingClientRect().height,
        limit: visibleBottom(),
        width: document.documentElement.clientWidth,
        align,
        placement,
      }),
    );
  }, [open, placement, align]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // A menu fixed to the window would stay behind when its list scrolls: it closes instead.
    const scrolled = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const resized = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', resized);
    // Another page under it (the back button of the phone or the mouse): the menu belongs to the page before.
    window.addEventListener('hashchange', resized);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', resized);
      window.removeEventListener('hashchange', resized);
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
