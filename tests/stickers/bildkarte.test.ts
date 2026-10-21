/**
 * The sticker style "Bildkarte" (style audit 20.10.2026, TODO #91): it took the place of "Farbig",
 * a saved "Farbig" becomes "Kassette", each card gets the motif its words ask for, and the card is
 * drawn with its motif, its word, the number and the mark, nothing running off it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MOTIFS, MOTIF_WORDS, PEN, motifFor, motifParts } from '../../src/core/stickers/motifs';
import { knownStyle, STICKER_STYLES, type StickerGeometry } from '../../src/core/stickers/layout';
import type { StickerItem } from '../../src/features/stickers/content';
import { stickerFont } from '../../src/features/stickers/fonts';
import { renderBildkarte, type BildkarteOptions } from '../../src/features/stickers/bildkarte';
import { PICTOGRAM_CREDIT } from '../../src/core/stickers/arasaac';

const KEY = 'tonuino-studio:stickers';

function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)), removeItem: (k: string) => void data.delete(k) };
}

async function startWith(stored: Record<string, string>) {
  const storage = fakeStorage(stored);
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
  return { mod: await import('../../src/features/stickers/design'), storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
});

describe('Bildkarte takes the place of Farbig', () => {
  it('is the third of the four styles the page offers, Farbig is gone', () => {
    expect(STICKER_STYLES).toEqual(['blur', 'tape', 'bild', 'full']);
  });

  it('a saved Farbig becomes Kassette, and is saved so', async () => {
    const { mod, storage } = await startWith({ [KEY]: JSON.stringify({ design: { style: 'color' } }) });
    expect(mod.design.value.style).toBe('tape');
    expect(JSON.parse(storage.data.get(KEY)!).design.style).toBe('tape');
  });

  it('a saved Bildkarte stays, without any switch', async () => {
    const { mod } = await startWith({ [KEY]: JSON.stringify({ design: { style: 'bild' } }) });
    expect(mod.design.value.style).toBe('bild');
  });

  it('the draft Leerkassette was not taken and becomes Kassette; other lost styles Klassisch', () => {
    expect(knownStyle('leer')).toBe('tape');
    expect(knownStyle('light')).toBe('blur');
    expect(knownStyle(undefined)).toBe('blur');
  });

  it('the default stays Kassette', async () => {
    const { mod } = await startWith({});
    expect(mod.design.value.style).toBe('tape');
  });
});

/* A 2D context that draws nothing and remembers texts, fills and the background. */
class Recorder {
  fillStyle = '#000';
  strokeStyle = '#000';
  font = '10px sans-serif';
  textAlign = 'left';
  texts: { text: string; style: string; align: string; font: string; x: number; y: number }[] = [];
  rects: { style: string }[] = [];
  fills = 0;
  images: { width: number }[] = [];
  globalAlpha = 1;
  constructor(readonly canvas: FakeCanvas) {}
  drawImage(img: { width: number }) {
    this.images.push(img);
  }
  getTransform() {
    return { a: 1, b: 0, c: 0, d: 1 };
  }
  fillRect() {
    this.rects.push({ style: this.fillStyle });
  }
  fill() {
    this.fills++;
  }
  measureText(text: string) {
    const px = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10);
    return { width: text.length * px * 0.6 };
  }
  fillText(text: string, x: number, y: number) {
    this.texts.push({ text, style: this.fillStyle, align: this.textAlign, font: this.font, x, y });
  }
}
for (const name of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'arcTo', 'closePath', 'stroke', 'translate', 'scale', 'clip']) {
  (Recorder.prototype as unknown as Record<string, () => void>)[name] = () => undefined;
}
class FakeCanvas {
  ctx: Recorder;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.ctx = new Recorder(this);
  }
  getContext() {
    return this.ctx;
  }
}
beforeAll(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterAll(() => vi.unstubAllGlobals());

describe('drawing a Bildkarte', () => {
  const LABEL: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 2, safeMm: 3, shape: 'rect' };
  const K = 10;
  const draw = (item: Partial<StickerItem>, o: Partial<BildkarteOptions> = {}) => {
    const full: StickerItem = { key: 'k', title: 'Gute Nacht', icon: { displayName: 'Shapes' } as unknown as StickerItem['icon'], flatColor: '#7a6a5a', ...item };
    const canvas = renderBildkarte({ item: full, picture: null, geometry: LABEL, pxPerMm: K, font: stickerFont('round'), showNumber: true, showTitle: true, ...o });
    return (canvas as unknown as FakeCanvas).ctx;
  };

  it("stands the motif of its words on the motif's calm colour, the word in white under it", () => {
    const ctx = draw({ title: 'Gute Nacht', number: '05' });
    expect(ctx.rects[0].style).toBe('rgb(52 80 127)');
    expect(ctx.fills).toBeGreaterThan(3);
    const word = ctx.texts.find((t) => t.text === 'Gute Nacht')!;
    expect(word.style).toBe('rgb(255 255 255)');
    expect(ctx.texts.some((t) => t.text === '05')).toBe(true);
  });

  it('without a motif for its name writes the word alone, bigger, and draws no stand-in picture', () => {
    const bare = draw({ title: 'Mein Ordner' }, { showNumber: false });
    const moon = draw({ title: 'Gute Nacht' }, { showNumber: false });
    expect(bare.fills).toBe(0);
    expect(moon.fills).toBeGreaterThan(0);
    const size = (ctx: Recorder) => Number(/([\d.]+)px/.exec(ctx.texts[0].font)?.[1]);
    expect(size(bare)).toBeGreaterThan(size(moon));
  });

  it('keeps a title of two lines on the sticker', () => {
    const ctx = draw({ title: 'Lieder zum Mitsingen für die ganze Familie' }, { showNumber: false });
    const lines = ctx.texts;
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l.y).toBeLessThanOrEqual((LABEL.bleedMm + LABEL.heightMm - LABEL.safeMm) * K);
  });

  it("writes the family's own word at the top right in place of a logo", () => {
    const ctx = draw({ title: 'Gute Nacht' }, { word: 'Unsere Box', showNumber: false });
    const mark = ctx.texts.find((t) => t.text === 'Unsere Box')!;
    expect(mark.align).toBe('right');
    expect(mark.y).toBeLessThan((LABEL.bleedMm + 10) * K);
  });
});

describe('a Bildkarte with an ARASAAC pictogram', () => {
  const LABEL: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 2, safeMm: 3, shape: 'rect' };
  const K = 10;
  const pictogram = { width: 500, height: 500 } as unknown as BildkarteOptions['pictogram'];
  const draw = (o: Partial<BildkarteOptions> = {}, item: Partial<StickerItem> = {}) => {
    const full: StickerItem = { key: 'k', title: 'Gute Nacht', icon: { displayName: 'Shapes' } as unknown as StickerItem['icon'], flatColor: '#7a6a5a', pictogram: 2382, ...item };
    const canvas = renderBildkarte({ item: full, picture: null, geometry: LABEL, pxPerMm: K, font: stickerFont('round'), showNumber: false, showTitle: true, ...o });
    return (canvas as unknown as FakeCanvas).ctx;
  };

  it('shows the pictogram whole, untinted, on a white plate in place of the own motif', () => {
    const ctx = draw({ pictogram });
    expect(ctx.images).toEqual([pictogram]);
    // The ground, the white plate; the moon would take many more fills.
    expect(ctx.rects[0].style).toBe('rgb(52 80 127)');
    expect(ctx.fills).toBe(1);
    expect(ctx.texts.some((t) => t.text === 'Gute Nacht')).toBe(true);
  });

  it('names the source small at the foot of the front, unless backs are printed', () => {
    const front = draw({ pictogram });
    const credit = front.texts.find((t) => t.text === PICTOGRAM_CREDIT)!;
    expect(credit).toBeDefined();
    expect(credit.align).toBe('center');
    expect(credit.y).toBeLessThanOrEqual((LABEL.bleedMm + LABEL.heightMm) * K);
    const word = front.texts.find((t) => t.text === 'Gute Nacht')!;
    expect(word.y).toBeLessThan(credit.y);
    // Readable in print: at least 0.9 mm (about 2.5 pt), all of it inside the safe width.
    const px = Number(/([\d.]+)px/.exec(credit.font)?.[1]);
    expect(px / K).toBeGreaterThanOrEqual(0.9);
    expect(draw({ pictogram, creditOnBack: true }).texts.some((t) => t.text === PICTOGRAM_CREDIT)).toBe(false);
  });

  it('without the stored picture keeps the own motif and names no source', () => {
    const ctx = draw({ pictogram: null });
    expect(ctx.images).toEqual([]);
    expect(ctx.fills).toBeGreaterThan(1);
    expect(ctx.texts.some((t) => t.text === PICTOGRAM_CREDIT)).toBe(false);
  });
});

describe('the motif of a card', () => {
  it('follows the words of its title first, then what the card does', () => {
    expect(motifFor({ title: 'Schlummerkarte', symbol: 'Moon' })).toBe('moon');
    // A sleep card renamed for a game of musical statues is a stop card.
    expect(motifFor({ title: 'Stopptanz', symbol: 'Moon' })).toBe('stop');
    expect(motifFor({ title: 'Lauter' })).toBe('louder');
    expect(motifFor({ title: 'Leiser' })).toBe('quieter');
    expect(motifFor({ title: 'Tiere vom Bauernhof' })).toBe('pig');
    expect(motifFor({ title: 'Tiere' })).toBe('cat');
    expect(motifFor({ title: 'Oma liest vor' })).toBe('book');
    expect(motifFor({ title: 'Lieder zum Tanzen' })).toBe('note');
    expect(motifFor({ title: 'Irgendwas', symbol: 'Moon' })).toBe('moon');
    expect(motifFor({ title: 'Irgendwas' })).toBeUndefined();
  });

  it.each([
    ['Gute Nacht', 'moon'],
    ['Schlaflieder', 'moon'],
    ['Gute-Nacht-Geschichten', 'moon'],
    ['Stopptanz', 'stop'],
    ['Freeze Dance', 'stop'],
    ['Pause', 'pause'],
    ['Nächster Titel', 'next'],
    ['Weiter', 'next'],
    ['Voriger Titel', 'prev'],
    ['Zurück', 'prev'],
    ['Zufall', 'dice'],
    ['Zufällige Lieder', 'dice'],
    ['Nochmal', 'repeat'],
    ['Titel wiederholen', 'repeat'],
    ['Krabbelmodus', 'lock'],
    ['Kita', 'blocks'],
    ['Kita-Modus', 'blocks'],
    ['Kindergarten Sonnenschein', 'blocks'],
    ['Lieder zum Mitsingen', 'sing'],
    ['Karaoke', 'sing'],
    ['Weihnachtslieder', 'tree'],
    ['Advent, Advent', 'tree'],
    ['Leise rieselt der Schnee (Weihnachten)', 'tree'],
    ['Geburtstag', 'cake'],
    ['Geburtstagslieder', 'cake'],
    ['Eigene Aufnahme', 'mic'],
    ['Grüße von Opa', 'mic'],
    ['Katzen', 'cat'],
    ['Hunde', 'dog'],
    ['Vögel im Garten', 'bird'],
    ['Fische im Meer', 'fish'],
    ['Auf dem Bauernhof', 'pig'],
    ['Märchen', 'book'],
    ['Hörspiel', 'headphones'],
    ['Musik', 'note'],
  ])('"%s" gets the motif %s', (title, motif) => {
    expect(motifFor({ title })).toBe(motif);
  });

  it('words of the keys count only in a short name', () => {
    expect(motifFor({ title: 'Leise rieselt der Schnee und noch mehr' })).toBeUndefined();
    expect(motifFor({ title: 'Oma liest vor' })).toBe('book');
    expect(motifFor({ title: 'Lauter tolle Sachen zum Hören' })).toBeUndefined();
  });

  it('special cards and folders without words get a motif by what they do, else none', () => {
    expect(motifFor({ title: 'Mein Ordner', symbol: 'PersonStanding' })).toBe('stop');
    expect(motifFor({ title: 'Mein Ordner', symbol: 'Pause' })).toBe('pause');
    expect(motifFor({ title: 'Mein Ordner', symbol: 'School' })).toBe('blocks');
    expect(motifFor({ title: 'Mein Ordner', symbol: 'RotateCcw' })).toBe('repeat');
    expect(motifFor({ title: 'Mein Ordner', symbol: 'Headphones' })).toBe('headphones');
    expect(motifFor({ title: 'Mein Ordner', symbol: 'Shapes' })).toBeUndefined();
    expect(motifFor({ title: 'Mein Ordner', symbol: 'KeyRound' })).toBeUndefined();
  });

  it('every motif has a word and stays inside its box, drawn the same way every time', () => {
    for (const id of MOTIFS) {
      expect(MOTIF_WORDS[id].length, id).toBeGreaterThan(2);
      const parts = motifParts(id);
      expect(parts.length, id).toBeGreaterThan(0);
      for (const p of parts) {
        expect(!!p.outline !== !!p.line, `${id}: an outline or a line`).toBe(true);
        const pts = [...(p.outline ?? []), ...(p.holes ?? []).flat(), ...(p.line ?? [])];
        expect(pts.length, id).toBeGreaterThanOrEqual(p.line ? 2 : 3);
        // A line reaches half its pen beyond its points.
        const reach = 0.5 - (p.line ? (p.width ?? PEN) / 2 : 0) + 0.003;
        for (const [x, y] of pts) {
          expect(Math.abs(x), id).toBeLessThanOrEqual(reach);
          expect(Math.abs(y), id).toBeLessThanOrEqual(reach);
        }
      }
      expect(motifParts(id)).toEqual(parts);
    }
  });

  it('every motif word finds its own motif again', () => {
    for (const id of MOTIFS) if (id !== 'cat') expect(motifFor({ title: MOTIF_WORDS[id] }), id).toBe(id);
  });
});
