import { describe, expect, it } from 'vitest';
import { ellipsize, fitLine, fitText, hyphenPoints, softHyphens, tokenize, wrap, type Measure } from '../../src/core/stickers/text';
import { compactLogoFits, contentBoxes, isCompact, orientGeometry, PLATE_EDGE, stickerLayout, type Box, type LayoutStyle, type StickerGeometry } from '../../src/core/stickers/layout';
import { contrast, panelColor, bestTextColor, rgbToOklab, type Palette } from '../../src/core/stickers/color';

/** Every character is 0.5 × size wide. */
const mono: Measure = (text, size) => [...text].length * 0.5 * size;

describe('tokenize', () => {
  it('splits words and allows breaks after hyphens', () => {
    expect(tokenize('  Die drei ???  ').map((t) => t.text)).toEqual(['Die', 'drei', '???']);
    const t = tokenize('Kinder-Lieder neu');
    expect(t.map((x) => x.text)).toEqual(['Kinder-', 'Lieder', 'neu']);
    expect(t.map((x) => x.space)).toEqual([false, true, false]);
  });

  it('keeps a dash between words at the end of the line before', () => {
    expect(tokenize('Bibi Blocksberg – Hexen gibt es doch').map((t) => t.text)).toEqual(['Bibi', 'Blocksberg –', 'Hexen', 'gibt', 'es', 'doch']);
    expect(wrap(tokenize('Bibi Blocksberg – Hexen'), 2, 13, mono)).toEqual(['Bibi', 'Blocksberg –', 'Hexen']);
    expect(tokenize('– Ende').map((t) => t.text)).toEqual(['–', 'Ende']);
  });
});

describe('wrap', () => {
  it('wraps greedily and keeps hyphenated words together when they fit', () => {
    expect(wrap(tokenize('Bibi und Tina reiten'), 2, 10, mono)).toEqual(['Bibi und', 'Tina', 'reiten']);
    expect(wrap(tokenize('Kinder-Lieder'), 1, 20, mono)).toEqual(['Kinder-Lieder']);
    expect(wrap(tokenize('Kinder-Lieder'), 1, 4, mono)).toEqual(['Kinder-', 'Lieder']);
  });

  it('refuses or hyphenates words that are too long', () => {
    expect(wrap(tokenize('Weihnachtsgeschichten'), 1, 5, mono)).toBeNull();
    const lines = wrap(tokenize('Weihnachtsgeschichten'), 1, 5, mono, true)!;
    expect(lines.join('').replace(/-/g, '')).toBe('Weihnachtsgeschichten');
    for (const l of lines) expect(mono(l, 1)).toBeLessThanOrEqual(5);
    expect(lines[lines.length - 1].length).toBeGreaterThanOrEqual(2);
  });
});

describe('hyphenPoints', () => {
  const hyphenate = (w: string) => {
    let out = '';
    let last = 0;
    for (const p of hyphenPoints(w)) {
      out += w.slice(last, p) + '-';
      last = p;
    }
    return out + w.slice(last);
  };

  it('splits German words at syllables', () => {
    expect(hyphenate('Weihnachtsgeschichten')).toBe('Weih-nachts-ge-schich-ten');
    expect(hyphenate('Schlummerkarte')).toBe('Schlum-mer-kar-te');
    expect(hyphenate('Piratenschatz')).toBe('Pi-ra-ten-schatz');
    expect(hyphenate('verschwundene')).toBe('ver-schwun-de-ne');
    expect(hyphenate('Tierstimmen')).toBe('Tier-stim-men');
    expect(hyphenate('Zucker')).toBe('Zu-cker');
    expect(hyphenate('Hörspiel')).toBe('Hör-spiel');
    expect(hyphenate('Kirschbaum')).toBe('Kirsch-baum');
    expect(hyphenate('Hirschkäfer')).toBe('Hirsch-kä-fer');
    expect(hyphenate('Herrscher')).toBe('Herr-scher');
  });

  it('keeps a consonant with l or r together after another consonant', () => {
    expect(hyphenate('Hotzenplotz')).toBe('Hot-zen-plotz');
    expect(hyphenate('Ostfriesland')).toBe('Ost-fries-land');
    expect(hyphenate('Zauberflöte')).toBe('Zau-ber-flö-te');
    expect(hyphenate('Elektro')).toBe('Elek-tro');
    expect(hyphenate('Engländer')).toBe('Eng-län-der');
    expect(hyphenate('Handlung')).toBe('Hand-lung');
  });

  it('gives long words soft hyphens for the browser, short ones none', () => {
    expect(softHyphens('Das Lumpenkonzert')).toBe('Das Lum\u00adpen\u00adkon\u00adzert');
    expect(softHyphens('Unter dem Kirschbaum')).toBe('Unter dem Kirschbaum');
    expect(softHyphens('Sternschnuppenlieder')).toBe('Stern\u00adschnup\u00adpen\u00adlie\u00adder');
    expect(softHyphens('Tanz mit mir')).toBe('Tanz mit mir');
    expect(softHyphens('Die Weihnachtsgeschichten (Teil 2)')).toBe('Die Weih\u00adnachts\u00adge\u00adschich\u00adten (Teil 2)');
    // Never fewer than three letters on a line.
    expect(softHyphens('Zauberflötenspiel!').replace(/\u00ad/g, '-')).toBe('Zau-ber-flö-ten-spiel!');
  });

  it('leaves short words, numbers and odd words alone', () => {
    expect(hyphenPoints('Oma')).toEqual([]);
    expect(hyphenPoints('R2D2')).toEqual([]);
    expect(hyphenPoints('Abc!')).toEqual([]);
  });
});

describe('fitText', () => {
  const base = { maxWidth: 20, maxHeight: 20, maxLines: 3, maxSize: 5, minSize: 2, lineHeight: 1 };

  it('keeps the largest size when the text fits', () => {
    const r = fitText('Bibi', mono, base);
    expect(r.size).toBe(5);
    expect(r.lines).toEqual(['Bibi']);
    expect(r.truncated).toBe(false);
  });

  it('shrinks until the lines fit', () => {
    const r = fitText('Die drei Fragezeichen und der Fluch des Drachen', mono, base);
    expect(r.size).toBeLessThan(5);
    expect(r.size).toBeGreaterThanOrEqual(2);
    expect(r.lines.length).toBeLessThanOrEqual(3);
    for (const l of r.lines) expect(mono(l, r.size)).toBeLessThanOrEqual(20 + 1e-9);
    expect(r.lines.join(' ')).toBe('Die drei Fragezeichen und der Fluch des Drachen');
  });

  it('respects the height as well as the line count', () => {
    const r = fitText('eins zwei drei vier fünf sechs', mono, { ...base, maxHeight: 6, maxLines: 10 });
    expect(r.height).toBeLessThanOrEqual(6 + 1e-9);
  });

  it('balances the lines', () => {
    // Greedy at size 5 would give "Bibi und" / "Tina" style ragged lines; balanced lines differ by little.
    const r = fitText('Hexen hexen nicht immer', mono, { ...base, maxWidth: 30, maxSize: 4, minSize: 4 });
    expect(r.lines.length).toBe(2);
    const [a, b] = r.lines.map((l) => l.length);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(6);
  });

  it('hyphenates a long word at a syllable instead of shrinking it to the minimum', () => {
    // 21 letters: at size 5 one line is 40 letters wide... use a narrow box instead.
    const r = fitText('Weihnachtsgeschichten', mono, { maxWidth: 30, maxHeight: 30, maxLines: 3, maxSize: 5, minSize: 2, lineHeight: 1 });
    expect(r.lines.length).toBe(2);
    expect(r.lines[0].endsWith('-')).toBe(true);
    expect(r.lines.join('').replace('-', '')).toBe('Weihnachtsgeschichten');
    expect(r.size).toBeGreaterThan(30 / (0.5 * 21));
  });

  it('leaves more than a short stub on the next line', () => {
    // "Urlaubslie-" would fit, but "der" alone looks broken: the seam of the word is taken.
    expect(wrap(tokenize('Urlaubslieder'), 2, 12, mono, 'syllables')).toEqual(['Urlaubs-', 'lieder']);
    // A title of one word is rather shrunk a little than split.
    const r = fitText('Urlaubslieder', mono, { maxWidth: 28, maxHeight: 30, maxLines: 3, maxSize: 5, minSize: 2, lineHeight: 1 });
    expect(r.lines).toEqual(['Urlaubslieder']);
  });

  it('prefers no hyphen when shrinking a little is enough', () => {
    const r = fitText('Schlummerkarte', mono, { maxWidth: 30, maxHeight: 30, maxLines: 3, maxSize: 4.6, minSize: 2, lineHeight: 1 });
    expect(r.lines).toEqual(['Schlummerkarte']);
  });

  it('hyphenates and truncates as a last resort', () => {
    const r = fitText('Donaudampfschifffahrtsgesellschaftskapitän erzählt Geschichten aus aller Welt', mono, {
      ...base,
      maxWidth: 10,
      maxLines: 2,
      maxHeight: 10,
    });
    expect(r.size).toBe(2);
    expect(r.lines.length).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.lines[1].endsWith('…')).toBe(true);
    for (const l of r.lines) expect(mono(l, r.size)).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('returns nothing for empty text', () => {
    expect(fitText('   ', mono, base).lines).toEqual([]);
  });
});

describe('ellipsize and fitLine', () => {
  it('cuts with an ellipsis at a word boundary when possible', () => {
    const out = ellipsize('Bibi Blocksberg hext', 1, 8, mono);
    expect(out.endsWith('…')).toBe(true);
    expect(mono(out, 1)).toBeLessThanOrEqual(8);
  });

  it('shrinks a single line to the width', () => {
    expect(fitLine('12', mono, 10, 8)).toBe(8);
    expect(fitLine('1234', mono, 10, 8)).toBeCloseTo(5);
    expect(fitLine('12345678', mono, 10, 8, 3)).toBe(3);
  });
});

const CARD: StickerGeometry = { widthMm: 85.6, heightMm: 54, bleedMm: 2, safeMm: 3, shape: 'rect' };
const HERMA: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 1.5, safeMm: 2.5, shape: 'rect' };
const ROUND: StickerGeometry = { widthMm: 25, heightMm: 25, bleedMm: 1.5, safeMm: 2, shape: 'round' };
const STYLES: LayoutStyle[] = ['blur', 'full', 'tape'];
const eps = 1e-9;
const B_EPS = 1e-6;
const within = (a: Box, b: Box) => a.x >= b.x - B_EPS && a.y >= b.y - B_EPS && a.x + a.width <= b.x + b.width + B_EPS && a.y + a.height <= b.y + b.height + B_EPS;

describe('stickerLayout', () => {
  const geometries = [CARD, HERMA, orientGeometry(CARD, 'portrait'), orientGeometry(HERMA, 'portrait')];

  it('keeps text, number and logo inside the safe area and the picture inside the bleed', () => {
    for (const g of geometries) {
      for (const style of STYLES) {
        for (const title of [true, false]) {
          for (const badge of [true, false]) {
            for (const logo of [true, false]) {
              const l = stickerLayout(g, { style, title, badge, logo });
              const where = `${g.widthMm}×${g.heightMm} ${style} title=${title} badge=${badge} logo=${logo}`;
              for (const b of contentBoxes(l)) {
                expect(b.x, where).toBeGreaterThanOrEqual(g.safeMm - eps);
                expect(b.y, where).toBeGreaterThanOrEqual(g.safeMm - eps);
                expect(b.x + b.width, where).toBeLessThanOrEqual(g.widthMm - g.safeMm + eps);
                expect(b.y + b.height, where).toBeLessThanOrEqual(g.heightMm - g.safeMm + eps);
                expect(b.width, where).toBeGreaterThan(0);
                expect(b.height, where).toBeGreaterThan(0);
              }
              const p = l.picture;
              expect(p.x, where).toBeGreaterThanOrEqual(-g.bleedMm - eps);
              expect(p.y, where).toBeGreaterThanOrEqual(-g.bleedMm - eps);
              expect(p.x + p.width, where).toBeLessThanOrEqual(g.widthMm + g.bleedMm + eps);
              expect(p.y + p.height, where).toBeLessThanOrEqual(g.heightMm + g.bleedMm + eps);
              expect(!!l.text, where).toBe(title);
              expect(!!l.badge, where).toBe(badge);
            }
          }
        }
      }
    }
  });

  it('never lets the text overlap the picture unless it sits on a band or a scrim', () => {
    for (const g of geometries) {
      for (const style of ['blur', 'tape'] as const) {
        const l = stickerLayout(g, { style, title: true, badge: true, logo: true });
        const t = l.text!;
        const p = l.picture;
        const overlap = t.x < p.x + p.width && p.x < t.x + t.width && t.y < p.y + p.height && p.y < t.y + t.height;
        expect(overlap, `${style} ${g.widthMm}`).toBe(false);
      }
      // Vollbild: on a colour band across the foot, beside the number; no darkening.
      const full = stickerLayout(g, { style: 'full', title: true, badge: true, logo: false });
      const band = full.band!;
      const t = full.text!;
      expect(full.scrim).toBeUndefined();
      expect(t.y).toBeGreaterThanOrEqual(band.y);
      expect(t.y + t.height).toBeLessThanOrEqual(g.heightMm - g.safeMm + 1e-9);
      expect(t.x).toBeGreaterThanOrEqual(g.safeMm);
      expect(t.x + t.width).toBeLessThanOrEqual(full.badge!.x);
      expect(band.x + band.width).toBeGreaterThanOrEqual(g.widthMm);
      expect(band.y + band.height).toBeGreaterThanOrEqual(g.heightMm);
      // Darkened: white on the gradient as before.
      const dark = stickerLayout(g, { style: 'full', title: true, badge: true, logo: false, darken: true });
      expect(dark.band).toBeUndefined();
      expect(dark.text!.y).toBeGreaterThanOrEqual(dark.scrim!.y);
    }
  });

  it('centres the picture of the classic style when there is no title', () => {
    const l = stickerLayout(CARD, { style: 'blur', title: false, badge: true, logo: true });
    expect(l.picture.x + l.picture.width / 2).toBeCloseTo(CARD.widthMm / 2);
    expect(l.picture.width).toBeCloseTo(CARD.heightMm - 2 * CARD.safeMm);
    expect(l.badge!.kind).toBe('big');
    expect(l.badge!.x).toBeGreaterThanOrEqual(l.picture.x + l.picture.width);
    expect(l.logo!.x + l.logo!.width).toBeLessThanOrEqual(l.picture.x);
  });

  it('lays out the cassette inlay: spine or head band with series and dot, the cover without a border, title on a flap or a field', () => {
    const land = stickerLayout(CARD, { style: 'tape', title: true, badge: true, logo: true });
    const t = land.tape!;
    expect(land.background).toBe('paper');
    expect(t.band.x).toBeCloseTo(-CARD.bleedMm);
    expect(t.band.height).toBeCloseTo(CARD.heightMm + 2 * CARD.bleedMm);
    // A thin white line between spine and cover; the cover over the full height, without a frame.
    expect(t.lines).toHaveLength(1);
    expect(land.picture.x).toBeCloseTo(t.lines[0].x + t.lines[0].width);
    expect(land.picture.height).toBeCloseTo(CARD.heightMm + 2 * CARD.bleedMm);
    expect(land.picture.radius).toBe(0);
    // A square cover gives up only a little of its width for the flap.
    expect(land.picture.width).toBeGreaterThan(CARD.heightMm * 0.85);
    // The series along the spine, the title and the wordmark on the flap right of the cover.
    expect(t.head!.up).toBe(true);
    expect(t.head!.x + t.head!.width).toBeLessThanOrEqual(t.band.x + t.band.width);
    expect(land.text!.up).toBeUndefined();
    expect(land.text!.x).toBeGreaterThanOrEqual(land.picture.x + land.picture.width);
    expect(land.logo!.x).toBeGreaterThanOrEqual(land.picture.x + land.picture.width);
    expect(land.logo!.y).toBeGreaterThan(land.text!.y + land.text!.height - 1e-9);
    // The number plate at the top of the spine, its digits inside it.
    expect(land.badge!.kind).toBe('plate');
    expect(t.plate!.x + t.plate!.width).toBeLessThan(t.band.x + t.band.width + B_EPS);
    expect(t.plate!.y + t.plate!.height).toBeLessThan(CARD.heightMm / 4);
    expect(within(land.badge!, t.plate!)).toBe(true);

    const portrait = orientGeometry(CARD, 'portrait');
    const up = stickerLayout(portrait, { style: 'tape', title: true, badge: true, logo: true });
    const u = up.tape!;
    // Head band with the series on the left and the dot on the right, inside the band.
    expect(u.head!.up).toBeUndefined();
    expect(u.head!.x + u.head!.width).toBeLessThan(u.plate!.x);
    expect(u.plate!.y + u.plate!.height).toBeLessThanOrEqual(u.band.y + u.band.height);
    expect(within(up.badge!, u.plate!)).toBe(true);
    // The cover over the whole width, square, between two white lines.
    expect(up.picture.width).toBeCloseTo(portrait.widthMm + 2 * portrait.bleedMm);
    expect(up.picture.height).toBeCloseTo(portrait.widthMm, 0);
    expect(u.lines).toHaveLength(2);
    // Title and wordmark in the title field below.
    expect(up.text!.y).toBeGreaterThanOrEqual(u.foot!.y);
    expect(up.logo!.y).toBeGreaterThanOrEqual(u.foot!.y);
    expect(up.logo!.align).toBe('right');
    expect(u.foot!.y + u.foot!.height).toBeGreaterThanOrEqual(portrait.heightMm);
    // A tall cover takes more height where the field can spare it.
    const tall = stickerLayout(portrait, { style: 'tape', title: false, badge: true, logo: false, pictureAspect: 0.64 });
    expect(tall.picture.height).toBeGreaterThan(portrait.widthMm * 1.2);
  });

  it('keeps the wordmark in one calm place: at the foot, level with the number or in the band', () => {
    const portrait = orientGeometry(HERMA, 'portrait');
    for (const g of [HERMA, portrait]) {
      // Vollbild without a title: bottom left, level with the number.
      const bare = stickerLayout(g, { style: 'full', title: false, badge: true, logo: true });
      expect(bare.logo!.y + bare.logo!.height).toBeCloseTo(bare.badge!.y + bare.badge!.height);
      expect(bare.logo!.x).toBeCloseTo(g.safeMm);
      // With a title: in the band.
      const titled = stickerLayout(g, { style: 'full', title: true, badge: true, logo: true });
      expect(titled.logo!.y).toBeGreaterThanOrEqual(titled.band!.y);
    }
    // Klassisch portrait without a title: right under the picture, beside the number.
    const classic = stickerLayout(portrait, { style: 'blur', title: false, badge: true, logo: true });
    expect(classic.logo!.y).toBeGreaterThan(classic.picture.y + classic.picture.height);
    expect(classic.logo!.y + classic.logo!.height).toBeCloseTo(classic.badge!.y + classic.badge!.height);
    // "Hell" is gone (0.4): Klassisch writes the number as before.
    expect(stickerLayout(HERMA, { style: 'blur', title: true, badge: true, logo: true }).badge!.kind).toBe('big');
  });

  it('shows a square cover whole on a portrait Vollbild, its top edge carried on, instead of cutting a third off', () => {
    const portrait = orientGeometry(HERMA, 'portrait');
    for (const title of [true, false]) {
      const l = stickerLayout(portrait, { style: 'full', title, badge: true, logo: true, pictureAspect: 1 });
      const visible = Math.min(l.picture.y + l.picture.height, l.band ? l.band.y + 0.3 : portrait.heightMm + portrait.bleedMm) - Math.max(l.picture.y, -portrait.bleedMm);
      // The box has the cover's shape: filling it cuts (almost) nothing.
      expect(l.picture.width / visible).toBeGreaterThan(0.95);
      expect(l.extend).toBeDefined();
      expect(l.extend!.y + l.extend!.height).toBeCloseTo(l.picture.y);
      expect(l.pictureFit).toBeUndefined();
    }
    // A tall picture still fills the sticker as before.
    const tall = stickerLayout(portrait, { style: 'full', title: true, badge: true, logo: false, pictureAspect: 0.64 });
    expect(tall.extend).toBeUndefined();
    expect(tall.pictureFit).toBeDefined();
  });

  describe('on small labels', () => {
    // A die-cut sheet of 38.1 × 21.2 mm labels and a tiny label of the smallest size the app accepts.
    const SMALL: StickerGeometry = { widthMm: 38.1, heightMm: 21.2, bleedMm: 1, safeMm: 3, shape: 'rect' };
    const TINY: StickerGeometry = { widthMm: 25, heightMm: 15, bleedMm: 1, safeMm: 2.5, shape: 'rect' };
    const PHOTO: StickerGeometry = { widthMm: 82, heightMm: 57, bleedMm: 0, safeMm: 3, shape: 'rect' };
    const meets = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    it('never puts the number plate of the cassette style on the picture, nor near the trim', () => {
      for (const g of [SMALL, TINY, CARD, HERMA]) {
        for (const title of [true, false]) {
          for (const logo of [true, false]) {
            const l = stickerLayout(g, { style: 'tape', title, badge: true, logo });
            const d = l.tape!.plate!;
            const where = `${g.widthMm} title=${title} logo=${logo}`;
            expect(meets(l.picture, d), where).toBe(false);
            expect(d.x, where).toBeGreaterThanOrEqual(PLATE_EDGE - eps);
            expect(d.y, where).toBeGreaterThanOrEqual(PLATE_EDGE - eps);
            expect(within(l.badge!, d), where).toBe(true);
            // Wider than high, like the number of Vollbild, and high enough for digits to read.
            expect(d.width, where).toBeGreaterThan(d.height);
            expect(l.badge!.height, where).toBeGreaterThanOrEqual(2);
            expect(l.picture.width, where).toBeGreaterThanOrEqual(g.heightMm * 0.35);
            if (l.text) expect(meets(l.text, l.badge!), where).toBe(false);
            if (l.logo) expect(meets(l.logo, l.badge!), where).toBe(false);
          }
        }
      }
      // Too small for the flap: the title goes on the spine below the dot, the wordmark is left out.
      const tiny = stickerLayout(TINY, { style: 'tape', title: true, badge: true, logo: true });
      expect(tiny.tape!.plate!.x + tiny.tape!.plate!.width).toBeLessThan(tiny.picture.x);
      expect(tiny.text!.up).toBe(true);
      expect(tiny.logo).toBeUndefined();
    });

    it('starts the picture of Vollbild above the title band, and keeps the band low', () => {
      for (const g of [SMALL, TINY, CARD, HERMA, orientGeometry(CARD, 'portrait')]) {
        const l = stickerLayout(g, { style: 'full', title: true, badge: true, logo: false });
        const band = l.band!;
        expect(l.picture.y + l.picture.height, `${g.widthMm}`).toBeLessThanOrEqual(band.y + 0.5);
        expect(l.picture.y + l.picture.height, `${g.widthMm}`).toBeGreaterThan(band.y);
        expect(l.picture.width).toBeCloseTo(g.widthMm + 2 * g.bleedMm);
        // The title has room for a line.
        expect(l.text!.height, `${g.widthMm}`).toBeGreaterThanOrEqual(2.86);
        expect(l.text!.width, `${g.widthMm}`).toBeGreaterThan(g.widthMm * 0.45);
      }
      const small = stickerLayout(SMALL, { style: 'full', title: true, badge: true, logo: false });
      expect(SMALL.heightMm - small.band!.y).toBeLessThanOrEqual(SMALL.heightMm / 3);
      // Darkened, and without a title, the picture still covers the whole sticker.
      for (const l of [stickerLayout(SMALL, { style: 'full', title: true, badge: true, logo: false, darken: true }), stickerLayout(SMALL, { style: 'full', title: false, badge: true, logo: false })]) {
        expect(l.picture.height).toBeCloseTo(SMALL.heightMm + 2 * SMALL.bleedMm);
      }
    });

    it('keeps everything inside the safe area', () => {
      for (const g of [SMALL, TINY, PHOTO]) {
        for (const style of STYLES) {
          for (const title of [true, false]) {
            const l = stickerLayout(g, { style, title, badge: true, logo: true });
            for (const b of contentBoxes(l)) {
              const where = `${g.widthMm} ${style} title=${title}`;
              expect(b.x, where).toBeGreaterThanOrEqual(g.safeMm - eps);
              expect(b.y, where).toBeGreaterThanOrEqual(g.safeMm - eps);
              expect(b.x + b.width, where).toBeLessThanOrEqual(g.widthMm - g.safeMm + eps);
              expect(b.y + b.height, where).toBeLessThanOrEqual(g.heightMm - g.safeMm + eps);
            }
          }
        }
      }
    });
  });

  it('fills round labels with the picture and centres the number at the bottom', () => {
    expect(isCompact(ROUND)).toBe(true);
    for (const style of STYLES) {
      const l = stickerLayout(ROUND, { style, title: true, badge: true, logo: true });
      expect(l.background).toBe('picture');
      expect(l.text).toBeUndefined();
      expect(l.logo).toBeUndefined();
      const b = l.badge!;
      expect(b.align).toBe('center');
      // The pill stays inside the circle.
      const r = ROUND.widthMm / 2;
      for (const [x, y] of [
        [b.x, b.y + b.height],
        [b.x + b.width, b.y + b.height],
      ]) {
        expect(Math.hypot(x - r, y - r)).toBeLessThanOrEqual(r);
      }
    }
  });

  it('looks the same in every style on round and square labels, with a logo only on big square ones', () => {
    const square: StickerGeometry = { widthMm: 40, heightMm: 40, bleedMm: 1, safeMm: 2.5, shape: 'rect' };
    for (const g of [ROUND, square]) {
      const looks = STYLES.map((style) => JSON.stringify(stickerLayout(g, { style, title: true, badge: true, logo: true })));
      expect(new Set(looks).size).toBe(1);
    }
    expect(compactLogoFits(ROUND)).toBe(false);
    expect(compactLogoFits({ ...ROUND, widthMm: 50 })).toBe(false);
    expect(compactLogoFits(square)).toBe(true);
    expect(stickerLayout(square, { style: 'blur', title: false, badge: true, logo: true }).logo).toBeDefined();
    expect(compactLogoFits({ ...square, widthMm: 30 })).toBe(false);
  });

  it('swaps width and height for portrait artwork, not for round labels', () => {
    expect(orientGeometry(CARD, 'portrait')).toMatchObject({ widthMm: 54, heightMm: 85.6 });
    expect(orientGeometry(CARD, 'landscape')).toBe(CARD);
    expect(orientGeometry(ROUND, 'portrait')).toBe(ROUND);
  });
});

describe('panelColor', () => {
  const palette = (vibrant: [number, number, number], dominant: [number, number, number]): Palette => {
    const c = (v: [number, number, number]) => ({ r: v[0], g: v[1], b: v[2] });
    return { vibrant: c(vibrant), dominant: c(dominant), muted: c(dominant), dark: c([20, 20, 20]), light: c([240, 240, 240]), swatches: [] };
  };

  it('prefers the vibrant colour and keeps text readable', () => {
    const red = panelColor(palette([230, 40, 40], [200, 200, 200]));
    expect(red.r).toBeGreaterThan(red.g + 60);
    expect(contrast(bestTextColor(red), red)).toBeGreaterThanOrEqual(4.5);
  });

  it('pulls very light and very dark colours into the middle', () => {
    const pale = panelColor(palette([255, 250, 200], [255, 255, 240]));
    const deep = panelColor(palette([10, 0, 40], [5, 5, 5]));
    for (const c of [pale, deep]) {
      const sum = c.r + c.g + c.b;
      expect(sum).toBeGreaterThan(90);
      expect(sum).toBeLessThan(700);
    }
  });

  it('never gives a pale or grey picture a grey panel', () => {
    const chroma = (c: { r: number; g: number; b: number }) => Math.hypot(rgbToOklab(c).a, rgbToOklab(c).b);
    const grey = panelColor(palette([200, 200, 200], [225, 225, 225]));
    const cream = panelColor(palette([250, 245, 232], [240, 236, 226]));
    const bluish = panelColor(palette([205, 212, 222], [230, 232, 236]));
    for (const c of [grey, cream, bluish]) {
      expect(chroma(c)).toBeGreaterThanOrEqual(0.04);
      expect(contrast(bestTextColor(c), c)).toBeGreaterThanOrEqual(4.5);
    }
    // Warm sand without any hue, the picture's own hue when it has a hint of one.
    expect(grey.r).toBeGreaterThan(grey.b + 15);
    expect(bluish.b).toBeGreaterThan(bluish.r + 10);
  });
});
