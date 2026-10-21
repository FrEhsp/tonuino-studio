/** Phone width on the add page: titles in the review wrap, the eject button moves below its text. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { homeEnd, oneLine } from '../../src/ui/oneLine';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** The declarations of every rule that names all of `selectors`, also inside media queries. */
function rules(css: string, ...selectors: string[]): string {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(plain); m; m = re.exec(plain)) {
    const names = m[1].split(',').map((x) => x.trim());
    if (selectors.every((x) => names.includes(x))) out.push(m[2]);
  }
  return out.join(';');
}

/** The inside of every `@media <query>` block. */
function media(css: string, query: string): string {
  const out: string[] = [];
  for (let at = css.indexOf(`@media ${query} {`); at >= 0; at = css.indexOf(`@media ${query} {`, at + 1)) {
    let depth = 0;
    const start = css.indexOf('{', at);
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(start + 1, i));
        break;
      }
    }
  }
  return out.join('\n');
}

describe('oneLine', () => {
  it('leaves text without line breaks alone', () => {
    expect(oneLine('Die Hexenprüfung', 4)).toEqual({ text: 'Die Hexenprüfung', caret: 4 });
    expect(oneLine('')).toEqual({ text: '', caret: 0 });
  });

  it('turns pasted line breaks and the spaces around them into one space', () => {
    expect(oneLine('Teil 1\nTeil 2').text).toBe('Teil 1 Teil 2');
    expect(oneLine('Teil 1 \r\n  Teil 2').text).toBe('Teil 1 Teil 2');
    expect(oneLine('Teil 1\n\n\nTeil 2\rTeil 3').text).toBe('Teil 1 Teil 2 Teil 3');
    expect(oneLine('Titel\n').text).toBe('Titel ');
    // Spaces without a break stay as they are.
    expect(oneLine('A  B\nC').text).toBe('A  B C');
  });

  it('keeps the cursor behind what was pasted', () => {
    // "abc" and a pasted "X\nY" before "def": the cursor was behind the "Y".
    expect(oneLine('abcX\nYdef', 6)).toEqual({ text: 'abcX Ydef', caret: 6 });
    expect(oneLine('abc \r\n def', 10)).toEqual({ text: 'abc def', caret: 7 });
    // In front of a break nothing moves; inside one the cursor goes behind the space.
    expect(oneLine('abc\ndef', 3).caret).toBe(3);
    expect(oneLine('abc \n  def', 5).caret).toBe(4);
    expect(oneLine('a\nb\nc', 5)).toEqual({ text: 'a b c', caret: 5 });
  });
});

describe('title fields in the review', () => {
  const components = read('src/ui/styles/components.css');
  const layout = read('src/ui/styles/layout.css');

  it('wrap instead of cutting off a long title', () => {
    const page = read('src/features/add/AddPage.tsx');
    for (const label of ['label="Titel des Albums"', 'label="Interpret oder Autor"', 'label={`Titel ${i + 1}`}']) {
      expect(page, label).toContain(label);
    }
    expect(page).not.toMatch(/<input[^>]*inline-edit (album|track)-title/);
  });

  it('grow with their text: the field and the hidden copy are laid out alike', () => {
    // One rule for both, so they cannot drift apart.
    const both = rules(components, '.wrap-input > .input.inline-edit', '.wrap-input::after');
    for (const part of [/grid-area:\s*1 \/ 1/, /padding:\s*var\(--wrap-pad\) var\(--space-3\) var\(--wrap-pad\) var\(--space-2\)/, /font:\s*inherit/, /white-space:\s*pre-wrap/, /overflow-wrap:\s*anywhere/]) {
      expect(both).toMatch(part);
    }
    expect(rules(components, '.wrap-input')).toMatch(/display:\s*grid/);
    const copy = rules(components, '.wrap-input::after');
    expect(copy).toMatch(/content:\s*attr\(data-value\) ' '/);
    expect(copy).toMatch(/border:\s*1px solid transparent/);
    expect(copy).toMatch(/visibility:\s*hidden/);
    const field = rules(components, '.wrap-input > .input.inline-edit');
    for (const part of [/height:\s*auto/, /resize:\s*none/, /overflow:\s*hidden/]) expect(field).toMatch(part);
    // One line is as tall as before: 26px + 2 × 6px + border for the album, 20px + 2 × 4px + border for a track.
    expect(rules(layout, '.wrap-input.album-title')).toMatch(/--wrap-pad:\s*6px[\s\S]*font-size:\s*var\(--text-lg\)[\s\S]*line-height:\s*1\.3;?/);
    expect(rules(layout, '.wrap-input.track-title')).toMatch(/--wrap-pad:\s*4px[\s\S]*line-height:\s*1\.3333/);
  });

  it('stay inside their row, also with a word longer than a line', () => {
    // An auto column would grow to the longest word ("Folge.75.Spuk.im.Netz.mp3") and cover the duration and the menu.
    expect(rules(components, '.wrap-input')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    // Breaking anywhere also lets the row around it shrink; field and copy break alike (see above).
    expect(rules(components, '.wrap-input > .input.inline-edit', '.wrap-input::after')).not.toMatch(/overflow-wrap:\s*break-word/);
  });

  it('get more of a track row on a phone: the duration takes only the room it needs', () => {
    const page = read('src/features/add/AddPage.tsx');
    expect(page).toContain('class="muted small nowrap import-track-duration"');
    expect(page).not.toMatch(/style=\{\{ width: 64/);
    expect(rules(layout.replace(/@media[^{]*\{[\s\S]*$/, ''), '.import-track-duration')).toMatch(/width:\s*64px/);
    expect(rules(media(layout, '(max-width: 560px)'), '.import-track-duration')).toMatch(/width:\s*auto/);
  });

  it('act as one-line fields for the keyboard and for screen readers', () => {
    const field = read('src/ui/components/WrapInput.tsx');
    expect(field).toContain('aria-multiline="false"');
    expect(field).toMatch(/e\.key === 'Home' \|\| e\.key === 'End'/);
  });
});

describe('Home and End in a wrapped title', () => {
  const caret = (at: number) => ({ start: at, end: at, direction: 'none' as const });

  it('go to the start and the end of the whole title, not of the line on screen', () => {
    expect(homeEnd('Home', 60, caret(42))).toEqual({ start: 0, end: 0, direction: 'none' });
    expect(homeEnd('End', 60, caret(12))).toEqual({ start: 60, end: 60, direction: 'none' });
    // A selection ends.
    expect(homeEnd('End', 60, { start: 3, end: 9, direction: 'forward' })).toEqual({ start: 60, end: 60, direction: 'none' });
  });

  it('select from where the selection began with Shift', () => {
    expect(homeEnd('Home', 60, caret(42), true)).toEqual({ start: 0, end: 42, direction: 'backward' });
    expect(homeEnd('End', 60, caret(12), true)).toEqual({ start: 12, end: 60, direction: 'forward' });
    // Selected to the right, then Shift+Home: from the start of the selection back to the beginning.
    expect(homeEnd('Home', 60, { start: 10, end: 20, direction: 'forward' }, true)).toEqual({ start: 0, end: 10, direction: 'backward' });
    // Selected to the left, then Shift+End: from its right end on.
    expect(homeEnd('End', 60, { start: 10, end: 20, direction: 'backward' }, true)).toEqual({ start: 20, end: 60, direction: 'forward' });
    expect(homeEnd('Home', 60, caret(0), true)).toEqual({ start: 0, end: 0, direction: 'forward' });
  });
});

describe('"Fertig für heute?"', () => {
  it('puts the button below the text when the text would get too narrow', () => {
    const layout = read('src/ui/styles/layout.css');
    expect(rules(layout, '.safe-removal-body')).toMatch(/flex-wrap:\s*wrap/);
    expect(rules(layout, '.safe-removal-text')).toMatch(/flex:\s*1 1 15rem/);
    const page = read('src/features/add/AddPage.tsx');
    expect(page).toMatch(/class="feature safe-removal"[\s\S]*class="safe-removal-body"[\s\S]*class="stack tight safe-removal-text"[\s\S]*SD-Karte auswerfen/);
  });
});
