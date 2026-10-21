/**
 * Tabs and radio groups move with the arrow keys, Home and End, and wrap
 * around at the ends.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arrowTarget } from '../../src/ui/arrowKeys';

describe('arrowTarget', () => {
  it('moves to the next and previous item and wraps around', () => {
    expect(arrowTarget('ArrowRight', 0, 4)).toBe(1);
    expect(arrowTarget('ArrowDown', 3, 4)).toBe(0);
    expect(arrowTarget('ArrowLeft', 0, 4)).toBe(3);
    expect(arrowTarget('ArrowUp', 2, 4)).toBe(1);
  });

  it('goes to the first and last item with Home and End', () => {
    expect(arrowTarget('Home', 2, 4)).toBe(0);
    expect(arrowTarget('End', 0, 4)).toBe(3);
  });

  it('leaves other keys alone, and an empty group', () => {
    expect(arrowTarget('Enter', 1, 4)).toBeNull();
    expect(arrowTarget('Tab', 1, 4)).toBeNull();
    expect(arrowTarget('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('the Paket guide and the choice of the Paket', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('ties the OS tabs to their panel and lets only the chosen tab take the focus', () => {
    const src = read('../../src/features/box/PackageGuide.tsx');
    const tab = src.slice(src.indexOf('role="tab"'), src.indexOf('</button>', src.indexOf('role="tab"')));
    expect(tab).toMatch(/aria-selected=\{os === t\.os\}/);
    expect(tab).toMatch(/aria-controls=\{panelId\}/);
    expect(tab).toMatch(/tabIndex=\{os === t\.os \? 0 : -1\}/);
    expect(src).toMatch(/role="tablist"[\s\S]*onKeyDown=\{arrowKeyHandler\(/);
    expect(src).toMatch(/role="tabpanel" id=\{panelId\} aria-labelledby=\{tabId\(os\)\}/);
  });

  it('marks the chosen mode with aria-checked and moves between modes with the arrow keys', () => {
    const src = read('../../src/features/box/PackageDialog.tsx');
    expect(src).toMatch(/role="radio"[^>]*aria-checked=\{checked\}[^>]*tabIndex=\{checked \? 0 : -1\}/);
    expect(src).toMatch(/role="radiogroup"[\s\S]{0,120}onKeyDown=\{arrowKeyHandler\(/);
  });
});
