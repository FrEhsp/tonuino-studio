import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { TargetedFocusEvent, TargetedKeyboardEvent, TargetedPointerEvent } from 'preact';
import { blockedSlots, isBlocked, sameSpot, stepSpot, type Spot, type Step } from '../../core/stickers/placement';
import { slotRects, slotsPerSheet } from '../../core/stickers/slots';
import type { LabelTemplate } from '../../core/stickers/templates';
import type { StickerItem } from './content';

/**
 * Moving stickers on the sheet preview (Preview.tsx), by pointer (mouse, pen,
 * finger) and by keyboard. While a sticker is carried nothing is drawn anew:
 * a copy of it out of the sheet follows the pointer, a mark on the label
 * below shows where it lands, and only the drop changes the sheet.
 */

/** Pixels the pointer moves before a press becomes a drag; less is a click. */
const DRAG_SLOP = 6;
/** Held this long over the arrows of the pager, the next sheet turns up. */
const FLIP_DWELL_MS = 550;
/** Label outside which a drop still counts (the gaps between labels), mm. */
const NEAR_MM = 4;
/** Carried this close to the top or bottom of what shows of the page, it scrolls by itself (px). */
const EDGE_PX = 80;
/** Fastest scroll while carrying, px per frame (at the very edge). */
const EDGE_STEP = 24;
/** Held this long near the edge before it scrolls: passing by, or a drop on a label down there, scrolls nothing. */
const EDGE_DWELL_MS = 400;

export interface SheetMoveOptions {
  template: LabelTemplate;
  pages: (StickerItem | null)[][];
  sheet: number;
  /** Labels on the first sheet that are gone already. */
  used: number[];
  onSheet?: (sheet: number) => void;
  /** Moves or swaps; false when that label cannot take the sticker. */
  onPlace?: (from: Spot, to: Spot) => boolean;
  /** Told how carrying starts and that it ends (null), e.g. to show the pager as a target. */
  onCarry?: (via: CarryVia | null) => void;
}

export type CarryVia = 'pointer' | 'keys';

interface Carry {
  from: Spot;
  to: Spot | null;
  via: CarryVia;
}

interface Press {
  id: number;
  x: number;
  y: number;
  slot: number;
  /** Where in the sticker it was grabbed, CSS px. */
  dx: number;
  dy: number;
  ghost?: HTMLCanvasElement;
  /** Held over the pager: `to` a sheet of its own (a small sheet) or `by` one step (an arrow). */
  flip?: { aim: string; timer: number };
  /** Where the pointer is now (viewport px), for scrolling at the edges. */
  at?: { x: number; y: number };
  /** The frame that scrolls at the edges. */
  scroll?: number;
  /** Since when the pointer is near the edge (performance.now()). */
  edgeSince?: number;
}

/** The box the sheet scrolls in: the nearest one that can scroll, else the page. */
function scrollerOf(el: HTMLElement | null): HTMLElement {
  for (let e = el?.parentElement; e; e = e.parentElement) {
    const oy = getComputedStyle(e).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight) return e;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * What shows of the scroll box, in viewport px: without what stays on top of
 * it at its bottom (the print bar sticks over the sheet's last labels).
 */
function shownArea(area: HTMLElement, sheet: HTMLElement, x: number): { top: number; bottom: number } {
  const page = area === document.scrollingElement || area === document.documentElement;
  const r = page ? { top: 0, bottom: window.innerHeight } : area.getBoundingClientRect();
  const bottom = Math.min(r.bottom, window.innerHeight);
  // Upwards from the bottom edge: the first thing that stays put over the sheet (it may keep a gap to the edge).
  for (let y = bottom - 2; y > bottom - 300 && y > r.top; y -= 12) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || sheet.contains(hit)) continue;
    for (let e: Element | null = hit; e && e !== area; e = e.parentElement) {
      const pos = getComputedStyle(e).position;
      if (pos === 'sticky' || pos === 'fixed') return { top: Math.max(r.top, 0), bottom: Math.min(bottom, e.getBoundingClientRect().top) };
    }
  }
  return { top: Math.max(r.top, 0), bottom };
}

/** How to carry by keyboard, for the live region and the line under the sheet. */
export function keyHint(sheets: number): string {
  return sheets > 1
    ? 'Pfeiltasten wählen das Etikett, Bild auf und Bild ab den Bogen, Eingabe legt ab, Escape bricht ab.'
    : 'Pfeiltasten wählen das Etikett, Eingabe legt ab, Escape bricht ab.';
}

export function useSheetMove(o: SheetMoveOptions) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLParagraphElement>(null);
  const carry = useRef<Carry | null>(null);
  const press = useRef<Press | null>(null);
  /** Ends the press with the listeners of the render that started it. */
  const stop = useRef<(() => void) | null>(null);
  const clicked = useRef(false);
  const focusAfter = useRef<Spot | null>(null);
  // Re-rendered on start and end only: the hole where the sticker was.
  const [lifted, setLifted] = useState<Spot | null>(null);
  // The handlers outlive a render (window listeners during a drag): they read the latest options.
  const now = useRef(o);
  now.current = o;

  const perSheet = slotsPerSheet(o.template);
  const movable = !!o.onPlace;

  const say = (text: string) => {
    if (live.current) live.current.textContent = text;
  };

  const itemAt = (s: Spot) => now.current.pages[s.sheet]?.[s.slot] ?? null;

  const where = (s: Spot) => (now.current.pages.length > 1 ? `Bogen ${s.sheet + 1}, Etikett ${s.slot + 1}` : `Etikett ${s.slot + 1}`);

  /** Puts the mark on the target label, if it is on the sheet shown. */
  const paint = () => {
    const el = mark.current;
    if (!el) return;
    const c = carry.current;
    const to = c?.to;
    const { template, sheet } = now.current;
    if (!c || !to || to.sheet !== sheet || sameSpot(to, c.from)) {
      el.removeAttribute('data-kind');
      return;
    }
    const r = slotRects(template)[to.slot];
    if (!r) return;
    const { widthMm: pw, heightMm: ph } = template.page;
    el.style.left = `${(r.x / pw) * 100}%`;
    el.style.top = `${(r.y / ph) * 100}%`;
    el.style.width = `${(r.width / pw) * 100}%`;
    el.style.height = `${(r.height / ph) * 100}%`;
    el.style.borderRadius = template.label.shape === 'round' ? '50%' : '';
    el.dataset.kind = itemAt(to) ? 'swap' : 'move';
  };

  // After every render: the mark where it belongs, and focus after a keyboard drop.
  useLayoutEffect(() => {
    paint();
    const f = focusAfter.current;
    if (f && f.sheet === o.sheet) box.current?.querySelector<HTMLElement>(`[data-slot="${f.slot}"]`)?.focus();
    // Not on another sheet later: that one dropped out, or the user turned away.
    focusAfter.current = null;
  });

  const start = (from: Spot, via: Carry['via']) => {
    carry.current = { from, to: null, via };
    setLifted(from);
    now.current.onCarry?.(via);
  };

  const finish = (drop: boolean) => {
    const c = carry.current;
    if (!c) return;
    carry.current = null;
    setLifted(null);
    now.current.onCarry?.(null);
    paint();
    const it = itemAt(c.from);
    if (drop && c.to && !sameSpot(c.to, c.from) && it) {
      const other = itemAt(c.to);
      if (now.current.onPlace?.(c.from, c.to)) {
        say(other ? `„${it.title}“ und „${other.title}“ getauscht.` : `„${it.title}“ liegt jetzt auf ${where(c.to)}.`);
        if (c.via === 'keys') focusAfter.current = c.to;
        return;
      }
    }
    if (c.via === 'keys') {
      say('Nicht verschoben.');
      focusAfter.current = c.from;
      if (now.current.sheet !== c.from.sheet) now.current.onSheet?.(c.from.sheet);
    }
  };

  /** The label under the pointer on the sheet shown, null off the sheet or on a label that is gone. */
  const spotAt = (x: number, y: number): Spot | null => {
    const el = box.current;
    if (!el) return null;
    const { template, sheet, used } = now.current;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom || !r.width) return null;
    const mx = ((x - r.left) / r.width) * template.page.widthMm;
    const my = ((y - r.top) / r.height) * template.page.heightMm;
    let best: Spot | null = null;
    let bestD = NEAR_MM;
    for (const s of slotRects(template)) {
      const dx = Math.max(s.x - mx, 0, mx - (s.x + s.width));
      const dy = Math.max(s.y - my, 0, my - (s.y + s.height));
      const d = Math.hypot(dx, dy);
      if (d <= bestD) {
        bestD = d;
        best = { sheet, slot: s.index };
      }
    }
    return best && !isBlocked(best, perSheet, blockedSlots(perSheet, used)) ? best : null;
  };

  /* -------------------------------------------------------------- pointer */

  const lift = (p: Press, e: PointerEvent) => {
    const { template, sheet } = now.current;
    start({ sheet, slot: p.slot }, 'pointer');
    window.getSelection()?.removeAllRanges();
    // A copy of the sticker out of the sheet as drawn: nothing is rendered for it.
    const src = canvas.current;
    const r = box.current?.getBoundingClientRect();
    const slot = slotRects(template)[p.slot];
    if (!src || !r || !slot) return;
    const sx = src.width / template.page.widthMm;
    const w = (slot.width / template.page.widthMm) * r.width;
    const h = (slot.height / template.page.heightMm) * r.height;
    const ghost = document.createElement('canvas');
    ghost.className = `sheet-ghost${template.label.shape === 'round' ? ' round' : ''}`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.width = Math.max(1, Math.round(slot.width * sx));
    ghost.height = Math.max(1, Math.round(slot.height * sx));
    ghost.getContext('2d')?.drawImage(src, slot.x * sx, slot.y * sx, slot.width * sx, slot.height * sx, 0, 0, ghost.width, ghost.height);
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h}px`;
    // Smaller around the point where it was grabbed.
    ghost.style.transformOrigin = `${p.dx}px ${p.dy}px`;
    document.body.append(ghost);
    p.ghost = ghost;
    follow(p, e);
  };

  const follow = (p: Press, e: PointerEvent) => {
    if (p.ghost) p.ghost.style.transform = `translate(${e.clientX - p.dx}px, ${e.clientY - p.dy}px) rotate(-3deg) scale(0.78)`;
  };

  /**
   * Over a small sheet of the pager, or an arrow: after a moment that sheet,
   * or the one before or after, turns up. An arrow held on keeps turning.
   */
  const flipOver = (p: Press, e: PointerEvent) => {
    const btn = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLButtonElement>('[data-flip], [data-sheet-to]');
    const live = btn && !btn.disabled ? btn : null;
    const to = live?.dataset.sheetTo !== undefined ? Number(live.dataset.sheetTo) : undefined;
    const dir = live && to === undefined ? Number(live.dataset.flip) : 0;
    const aim = to !== undefined ? `to ${to}` : dir ? `by ${dir}` : '';
    if (p.flip?.aim === aim) return;
    if (p.flip) clearTimeout(p.flip.timer);
    p.flip = undefined;
    if (!aim) return;
    const turn = () => {
      const { sheet, pages, onSheet } = now.current;
      const next = to ?? sheet + dir;
      if (next === sheet || next < 0 || next >= pages.length || !onSheet) return;
      onSheet(next);
      if (p.flip && to === undefined) p.flip.timer = window.setTimeout(turn, FLIP_DWELL_MS * 1.5);
    };
    p.flip = { aim, timer: window.setTimeout(turn, FLIP_DWELL_MS) };
  };

  /** The label under the pointer becomes the target. */
  const aim = (x: number, y: number) => {
    const c = carry.current;
    if (!c) return;
    const to = spotAt(x, y);
    if (to?.sheet === c.to?.sheet && to?.slot === c.to?.slot) return;
    c.to = to;
    paint();
  };

  /**
   * Held a moment near the top or bottom of what shows, the page scrolls by
   * itself, faster the closer the pointer: the sheet is often taller than the
   * window, and a finger cannot scroll while it carries.
   */
  const edgeScroll = (p: Press) => {
    p.scroll = requestAnimationFrame((t) => {
      p.scroll = undefined;
      const sheet = box.current;
      if (press.current !== p || !carry.current || !p.at || !sheet) return;
      const area = scrollerOf(sheet);
      const { top, bottom } = shownArea(area, sheet, p.at.x);
      const r = sheet.getBoundingClientRect();
      let dy = 0;
      // Only while there is more of the sheet that way.
      if (p.at.y < top + EDGE_PX && r.top < top) dy = -Math.ceil(EDGE_STEP * Math.min(1, (top + EDGE_PX - p.at.y) / EDGE_PX));
      else if (p.at.y > bottom - EDGE_PX && r.bottom > bottom) dy = Math.ceil(EDGE_STEP * Math.min(1, (p.at.y - (bottom - EDGE_PX)) / EDGE_PX));
      if (!dy) p.edgeSince = undefined;
      else p.edgeSince ??= t;
      if (dy && t - (p.edgeSince ?? t) >= EDGE_DWELL_MS) {
        const before = area.scrollTop;
        area.scrollTop = before + dy;
        if (area.scrollTop !== before) aim(p.at.x, p.at.y);
      }
      edgeScroll(p);
    });
  };

  const onMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id) return;
    if (!carry.current) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
      lift(p, e);
      edgeScroll(p);
    }
    e.preventDefault();
    p.at = { x: e.clientX, y: e.clientY };
    follow(p, e);
    flipOver(p, e);
    aim(e.clientX, e.clientY);
  };

  const onUp = (e: PointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id) return;
    end(e.type === 'pointerup');
  };

  const onLost = () => end(false);

  /** A finger held still on a sticker opens no menu (Android, ChromeOS): it is picking it up. */
  const onMenu = (e: Event) => e.preventDefault();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && press.current) {
      e.preventDefault();
      e.stopPropagation();
      end(false);
    }
  };

  const end = (drop: boolean) => {
    const p = press.current;
    press.current = null;
    stop.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onLost);
    window.removeEventListener('contextmenu', onMenu, true);
    if (!p) return;
    if (p.flip) clearTimeout(p.flip.timer);
    if (p.scroll) cancelAnimationFrame(p.scroll);
    p.ghost?.remove();
    if (carry.current) {
      // The click that follows the drop is not "anpassen".
      clicked.current = true;
      setTimeout(() => (clicked.current = false), 0);
      finish(drop);
    }
  };

  const onPointerDown = (slot: number) => (e: TargetedPointerEvent<HTMLElement>) => {
    if (!movable || press.current || carry.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, slot, dx: e.clientX - r.left, dy: e.clientY - r.top };
    stop.current = () => end(false);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    // The window lost the pointer (a dialog, another program, the print dialog): no release ever comes, so the sticker goes back.
    window.addEventListener('blur', onLost);
    if (e.pointerType !== 'mouse') window.addEventListener('contextmenu', onMenu, true);
  };

  // The sheet goes away while a sticker is carried (another page): nothing may stay on the screen.
  useEffect(() => () => stop.current?.(), []);

  /** False right after a drag: the click it causes is no click on the sticker. */
  const isClick = () => !clicked.current;

  /* -------------------------------------------------------------- keyboard */

  const STEPS: Record<string, Step> = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
    PageUp: 'prevSheet',
    PageDown: 'nextSheet',
  };

  /** One step while carrying; `lead` goes before what is said about the label. */
  const stepTo = (step: Step, lead = '') => {
    const c = carry.current;
    if (!c) return;
    const { template, pages, used, sheet, onSheet } = now.current;
    const at = c.to ?? c.from;
    const to = stepSpot(at, step, template.grid, pages.length, blockedSlots(perSheet, used));
    if (sameSpot(to, at)) {
      say(`${lead}Weiter geht es nicht. ${where(at)}.`);
      return;
    }
    c.to = to;
    if (to.sheet !== sheet) onSheet?.(to.sheet);
    paint();
    const other = itemAt(to);
    say(lead + (sameSpot(to, c.from) ? `${where(to)}: sein Platz.` : other ? `${where(to)}: tauschen mit „${other.title}“.` : `${where(to)}: frei.`));
  };

  /** On a sticker: the arrow keys pick it up. */
  const onStickerKey = (slot: number) => (e: TargetedKeyboardEvent<HTMLElement>) => {
    const step = STEPS[e.key];
    if (!movable || !step || e.altKey || e.ctrlKey || e.metaKey || carry.current) return;
    e.preventDefault();
    // Not once more on the sheet, which carries from here on.
    e.stopPropagation();
    const from = { sheet: now.current.sheet, slot };
    start(from, 'keys');
    const it = itemAt(from);
    // The sheet keeps the focus while carrying, also when it turns to another sheet.
    box.current?.focus();
    // Said together with the first step, so that one does not cut it off.
    stepTo(step, `„${it?.title ?? 'Sticker'}“ aufgenommen. ${keyHint(now.current.pages.length)} `);
  };

  /** On the sheet while carrying by keyboard. */
  const onSheetKey = (e: TargetedKeyboardEvent<HTMLElement>) => {
    const c = carry.current;
    if (!c || c.via !== 'keys') return;
    const step = STEPS[e.key];
    if (step) {
      e.preventDefault();
      stepTo(step);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === 'Tab') {
      finish(false);
      focusAfter.current = null;
    }
  };

  const onSheetBlur = (e: TargetedFocusEvent<HTMLElement>) => {
    // Clicked elsewhere while carrying by keyboard: put it back.
    if (carry.current?.via === 'keys' && !box.current?.contains(e.relatedTarget as Node | null)) {
      finish(false);
      focusAfter.current = null;
    }
  };

  return { box, canvas, mark, live, lifted, movable, onPointerDown, onStickerKey, onSheetKey, onSheetBlur, isClick };
}
