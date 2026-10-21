/**
 * Small pieces of the interface that decide something on their own: where
 * a menu opens, when a shelf sticker is drawn, what a cover without a
 * picture shows, which pages the phone tab bar has, and how the choices of
 * the settings react to the keyboard.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
import { menuPlacement, menuSpot } from '../../src/ui/components/Menu';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

describe('a menu below its button', () => {
  it('stays below when it fits above the tab bar or the window edge', () => {
    expect(menuPlacement({ triggerTop: 100, triggerBottom: 140, menuHeight: 120, limit: 700 })).toBe('below');
  });

  it('opens above when it would run under the phone tab bar', () => {
    // 844 px phone, tab bar from 772 px, "…" at 700 px: below it would end at 866 px.
    expect(menuPlacement({ triggerTop: 700, triggerBottom: 740, menuHeight: 120, limit: 772 })).toBe('above');
  });

  it('stays below (and is scrolled into view) when there is no room above either', () => {
    expect(menuPlacement({ triggerTop: 60, triggerBottom: 100, menuHeight: 300, limit: 320 })).toBe('below');
  });
});

describe('shelf stickers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('share one observer, are drawn near the screen, dropped far from it, and let go on unmount', async () => {
    const made: { cb: (e: { target: object; isIntersecting: boolean }[]) => void; observed: Set<object> }[] = [];
    class FakeObserver {
      observed = new Set<object>();
      constructor(public cb: (e: { target: object; isIntersecting: boolean }[]) => void) {
        made.push(this);
      }
      observe(el: object) {
        this.observed.add(el);
      }
      unobserve(el: object) {
        this.observed.delete(el);
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { watchNear } = await import('../../src/ui/nearScreen');
    const a = {} as Element;
    const b = {} as Element;
    const seen: [string, boolean][] = [];
    const stopA = watchNear(a, (near) => seen.push(['a', near]));
    watchNear(b, (near) => seen.push(['b', near]));
    expect(made).toHaveLength(1);
    made[0].cb([{ target: a, isIntersecting: true }]);
    made[0].cb([{ target: a, isIntersecting: false }, { target: b, isIntersecting: true }]);
    expect(seen).toEqual([
      ['a', true],
      ['a', false],
      ['b', true],
    ]);
    stopA();
    expect(made[0].observed.has(a)).toBe(false);
    made[0].cb([{ target: a, isIntersecting: true }]);
    expect(seen).toHaveLength(3);
  });

  it('are all drawn without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { watchNear } = await import('../../src/ui/nearScreen');
    const cb = vi.fn();
    watchNear({} as Element, cb);
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('watch the screen through the small module, not one of their own', () => {
    // The test above loads src/ui/nearScreen.ts alone: quick also on a busy computer.
    expect(read('src/ui/nearScreen.ts')).not.toMatch(/^import /m);
    expect(read('src/features/stickers/FolderSticker.tsx')).toMatch(/import \{ watchNear \} from '\.\.\/\.\.\/ui\/nearScreen';/);
  });

  it('never show the sticker\'s finished picture for the built card', () => {
    // Same size, same place: keyed by the sticker alone, the built card showed the sticker drawn before it.
    const src = read('src/features/stickers/FolderSticker.tsx');
    expect(src).toMatch(/const what = cardIn && built \? `karte:\$\{built\.key\}` : id;/);
    expect(src).toMatch(/hash\(\[BAKED_LOOK, pictureId,/);
  });

  it('are rendered in turn and not kept in the preview cache', () => {
    // The shelf draws its stickers one at a time (work()), outside the preview cache, and lets each rendering go.
    const src = read('src/features/stickers/FolderSticker.tsx');
    expect(src).toMatch(/renderThumb\(job\.item, job\.setup, job\.k\)/);
    expect(src).not.toMatch(/renderPreview/);
    expect(src).toMatch(/c\.width = 0;/);
    expect(src).toMatch(/if \(working >= WORKERS\) return;/);
  });
});

describe('a cover without a picture', () => {
  afterEach(() => vi.resetModules());

  /** Every text in the tree the cover renders to. */
  function texts(node: unknown): string[] {
    if (node == null || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(texts);
    const v = node as VNode<{ children?: unknown }>;
    if (typeof v.type === 'function') return texts((v.type as (p: unknown) => unknown)(v.props));
    return texts(v.props?.children);
  }

  it('shows the folder number only when there is one', async () => {
    const { Cover } = await import('../../src/ui/components/Cover');
    // A new album has no folder number yet (target 0): nothing like "01" may appear.
    expect(texts(Cover({ title: 'Neues Album', seed: 1 })).join(' ')).not.toMatch(/\d/);
    expect(texts(Cover({ title: 'Neues Album', seed: 7, number: '07' }))).toContain('07');
  });
});

describe('the phone tab bar', () => {
  type Phone = Parameters<typeof import('../../src/app/Sidebar').tabsFor>[0];
  const android = (sd: boolean) => ({ mobile: true, capabilities: { sd } }) as Phone;

  it('has Meine Box, Hinzufügen, Sticker and Karten, picked by page', async () => {
    const src = read('src/app/Sidebar.tsx');
    expect(src).not.toMatch(/NAV\[\d\]/);
    const { tabsFor } = await import('../../src/app/Sidebar');
    expect(tabsFor(null).map((t) => [t.route.page, t.short])).toEqual([
      ['box', 'Meine Box'],
      ['add', 'Hinzufügen'],
      ['stickers', 'Sticker'],
      ['cards', 'Karten'],
    ]);
  });

  it('starts with the cards and recording in the Android app, then Meine Box, nothing of it under "Mehr"', async () => {
    const { tabsFor, navItems } = await import('../../src/app/Sidebar');
    expect(tabsFor(android(true)).map((t) => [t.route.page, t.short])).toEqual([
      ['cards', 'Karten'],
      ['record', 'Aufnehmen'],
      ['box', 'Meine Box'],
    ]);
    // The menu of a tablet in the same order; the computer's keeps Meine Box first and has no recording page.
    expect(navItems(true).map((n) => n.route.page).slice(0, 3)).toEqual(['cards', 'record', 'box']);
    expect(navItems(false).map((n) => n.route.page)).not.toContain('record');
    expect(navItems(false)[0].route.page).toBe('box');
    // An APK without the SD card: what works on the phone.
    expect(tabsFor(android(false)).map((t) => t.route.page)).toEqual(['cards', 'sources', 'help']);
  });

  it('is Karten, Hinzufügen, Sticker drucken and Mehr on a phone, in the app and in the browser (0.5 #74)', async () => {
    const { tabsFor } = await import('../../src/app/Sidebar');
    for (const p of [null, android(true)]) {
      expect(tabsFor(p, true).map((t) => [t.route.page, t.label])).toEqual([
        ['cards', 'Karten beschreiben'],
        ['add', 'Hinzufügen'],
        ['stickers', 'Sticker drucken'],
      ]);
    }
    // Werkstatt and Meine Box are under "Mehr"; the APK without the SD card keeps its bar.
    expect(tabsFor(android(false), true).map((t) => t.route.page)).toEqual(['cards', 'sources', 'help']);
    // "Mehr" on a phone starts with Meine Box.
    expect(read('src/app/Sidebar.tsx')).toMatch(/phone \? \[\.\.\.menu\.filter\(\(n\) => n\.route\.page === 'box'\)/);
  });
});

describe('a narrow window', () => {
  it('never grows wider than the screen for a long box name in the card box', () => {
    const css = read('src/ui/styles/layout.css');
    const narrow = css.slice(css.indexOf('/* ------------------------------------------------------------------ responsive */'));
    expect(narrow).toMatch(/\.app \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  });
});

describe('the choices in the settings', () => {
  const src = read('src/features/settings/SettingsPage.tsx');

  it('move with the arrow keys and are one tab stop, for the way to write cards', () => {
    const method = src.slice(src.indexOf('function CardMethodChoice'), src.indexOf('function BoxAddressField'));
    expect(method).toMatch(/role="radiogroup"[\s\S]{0,200}onKeyDown=\{arrowKeyHandler\(/);
    expect(method).toMatch(/tabIndex=\{ok && m\.value === current \? 0 : -1\}/);
  });

  it('skip ways this app cannot use', () => {
    expect(read('src/ui/arrowKeys.ts')).toMatch(/getAttribute\('aria-disabled'\) !== 'true'/);
  });
});

describe('menuSpot', () => {
  const button = { top: 700, bottom: 740, left: 1500, right: 1540 };
  it('opens below the button, fixed to the window, whatever box the button sits in', () => {
    expect(menuSpot({ button, menuHeight: 120, limit: 1250, width: 2000, align: 'right', placement: 'below' })).toEqual({ top: 746, right: 460 });
  });
  it('opens above when the window ends below the button', () => {
    expect(menuSpot({ button, menuHeight: 120, limit: 800, width: 2000, align: 'left', placement: 'below' })).toEqual({ top: 574, left: 1500 });
  });
  it('stays inside the window when it fits on neither side', () => {
    expect(menuSpot({ button: { top: 60, bottom: 100, left: 10, right: 50 }, menuHeight: 300, limit: 320, width: 400, align: 'left', placement: 'below' }).top).toBe(20);
  });
});
