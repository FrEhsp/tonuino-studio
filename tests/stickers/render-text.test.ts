/** How the renderer fits the texts of a sticker: the series in the head band, title and subtitle. */
import { describe, expect, it } from 'vitest';
import { stickerLayout, type StickerGeometry } from '../../src/core/stickers/layout';
import type { Measure } from '../../src/core/stickers/text';
import { fitTitle, headLines } from '../../src/features/stickers/render';

const mono: Measure = (text, size) => [...text].length * 0.55 * size;
const portrait: StickerGeometry = { widthMm: 50.8, heightMm: 83.8, bleedMm: 1.5, safeMm: 2.5, shape: 'rect' };

describe('the series in the head band', () => {
  const head = stickerLayout(portrait, { style: 'tape', title: true, badge: true, logo: false }).tape!.head!;

  it('keeps the number of the episode of a long series', () => {
    const fitted = headLines('Der kleine Drache Kokosnuss, Folge 12', mono, head);
    expect(fitted.lines.join(' ')).toContain('12');
    expect(fitted.size).toBeGreaterThanOrEqual(2.1);
    for (const l of fitted.lines) expect(mono(l, fitted.size)).toBeLessThanOrEqual(head.width + 0.05);
  });

  it('cuts only the name short when even two lines are too few', () => {
    const fitted = headLines('Die unglaublich lange Geschichte vom allerkleinsten Drachen der ganzen Welt und seinen Freunden, Folge 12', mono, { width: 20, height: 3 });
    expect(fitted.lines).toHaveLength(1);
    expect(fitted.lines[0]).toMatch(/… · 12$/);
  });

  it('writes a short series in one line', () => {
    expect(headLines('Conni, Folge 5', mono, head).lines).toEqual(['Conni, Folge 5']);
  });

  it('writes every series at one size: a longer one is shortened, not shrunk', () => {
    const short = headLines('Conni, Folge 5', mono, head);
    const longer = headLines('Bibi & Tina, Folge 50', mono, head);
    expect(longer.lines).toEqual(['Bibi & Tina · 50']);
    expect(longer.size).toBe(short.size);
  });
});

describe('title and subtitle', () => {
  const slot = { x: 0, y: 0, width: 17.2, height: 5.8, align: 'left' as const, valign: 'middle' as const, maxLines: 2 };

  it('gives the title all the room when the subtitle would cut it short', () => {
    const fitted = fitTitle(slot, { title: 'Feuerwehrmann Sam', subtitle: 'Folge 3' }, mono, mono);
    expect(fitted.title.truncated).toBe(false);
    expect(fitted.subtitle).toBeNull();
    expect(fitted.title.lines.join(' ')).not.toContain('…');
  });

  it('keeps the subtitle where both fit', () => {
    const fitted = fitTitle({ ...slot, width: 60, height: 14 }, { title: 'Feuerwehrmann Sam', subtitle: 'Folge 3' }, mono, mono);
    expect(fitted.subtitle?.lines).toEqual(['Folge 3']);
    expect(fitted.title.truncated).toBe(false);
  });
});

describe('the flap line of "Kassette" (audit 20.10.2026)', () => {
  const slot = { x: 0, y: 0, width: 19.5, height: 22, align: 'left' as const, valign: 'top' as const, maxLines: 3, maxSize: 3.2 };

  it('never makes the title smaller, and is written at least 2.4 mm', () => {
    const title = 'Tierisch coole Kinderlieder';
    const alone = fitTitle(slot, { title }, mono, mono);
    const aside = fitTitle({ ...slot, aside: true }, { title, subtitle: '13 Titel · 38 Min.' }, mono, mono);
    expect(aside.title.size).toBe(alone.title.size);
    expect(aside.title.lines).toEqual(alone.title.lines);
    expect(aside.subtitle).not.toBeNull();
    expect(aside.subtitle!.size).toBeGreaterThanOrEqual(2.4 - 1e-9);
    // A plain subtitle still gets room kept for it, as before.
    const plain = fitTitle(slot, { title, subtitle: 'LiBaTiBa' }, mono, mono);
    expect(plain.title.size).toBeLessThanOrEqual(alone.title.size);
  });

  it('is left out rather than cutting the title short where there is no room', () => {
    const tight = fitTitle({ ...slot, height: 7, aside: true }, { title: 'Zehn kleine Zappelmänner', subtitle: '22 Titel · 48 Min.' }, mono, mono);
    expect(tight.title.truncated).toBe(false);
    expect(tight.subtitle).toBeNull();
  });
});
