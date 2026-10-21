/**
 * The colours of well-known works (src/core/stickers/works.ts): the table is
 * sound, and real-looking folder names find their work, also when they are
 * spelled the way cards really spell them.
 */
import { describe, expect, it } from 'vitest';
import { contrast, fromHex, luminance } from '../../src/core/stickers/color';
import { recognizeWork, workColors, workColorsByTitle, WORKS } from '../../src/core/stickers/works';
import type { FolderFacts } from '../../src/core/covers/recognize';

const HEX = /^#[0-9a-f]{6}$/;
const id = (f: FolderFacts | string) => recognizeWork(typeof f === 'string' ? { title: f } : f)?.id ?? null;

describe('the table of work colours', () => {
  it('knows more than 80 works, each with an id of its own and words to find it by', () => {
    expect(WORKS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(WORKS.map((w) => w.id)).size).toBe(WORKS.length);
    for (const w of WORKS) {
      expect(w.id, w.id).toMatch(/^[a-z0-9-]+$/);
      expect(w.name.trim(), w.id).not.toBe('');
      expect((w.erkennen.titel?.length ?? 0) + (w.erkennen.kuenstler?.length ?? 0), w.id).toBeGreaterThan(0);
    }
  });

  it('has only real colours: a light plate, readable digits, a plate that stands out from the band', () => {
    for (const w of WORKS) {
      expect(w.plate, w.id).toMatch(HEX);
      expect(w.digits, w.id).toMatch(HEX);
      const plate = fromHex(w.plate);
      // Light like the number of Vollbild (Frank, 14.10.2026).
      expect(luminance(plate), w.id).toBeGreaterThanOrEqual(0.5);
      expect(contrast(fromHex(w.digits), plate), w.id).toBeGreaterThanOrEqual(3);
      if (w.band === 'cover') continue;
      expect(w.band, w.id).toMatch(HEX);
      expect(contrast(fromHex(w.band), plate), w.id).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('names the works Frank asked for', () => {
    const wanted = [
      'die-drei-fragezeichen', 'tkkg', 'benjamin-bluemchen', 'bibi-blocksberg', 'bibi-und-tina', 'fuenf-freunde', 'hanni-und-nanni', 'drache-kokosnuss',
      'das-sams', 'raeuber-hotzenplotz', 'pumuckl', 'sternenschweif', 'schule-der-magischen-tiere', 'paw-patrol', 'conni', 'pettersson-und-findus',
      'unter-meinem-bett', 'rolf-zuckowski', 'deine-freunde', 'simone-sommerland', 'die-olchis', 'lauras-stern', 'grueffelo', 'peppa-wutz',
      'feuerwehrmann-sam', 'yakari', 'gregs-tagebuch', 'harry-potter', 'michel-aus-loenneberga', 'pippi-langstrumpf', 'wieso-weshalb-warum', 'was-ist-was',
    ];
    const ids = new Set(WORKS.map((w) => w.id));
    for (const w of wanted) expect(ids.has(w), w).toBe(true);
  });
});

describe('recognising a work', () => {
  it('finds series by their name, with the episode in any spelling', () => {
    expect(id('Die drei ??? Folge 125: Feuermond')).toBe('die-drei-fragezeichen');
    expect(id('Die Drei Fragezeichen - 012/Der seltsame Wecker')).toBe('die-drei-fragezeichen');
    expect(id('Die 3 ??? und der Super-Papagei')).toBe('die-drei-fragezeichen');
    expect(id({ title: 'Der Super-Papagei', series: 'Die drei ???', episode: 1 })).toBe('die-drei-fragezeichen');
    expect(id('Die drei ??? Kids, Teil 5')).toBe('die-drei-fragezeichen-kids');
    expect(id('TKKG 200 – Gefangen in der Zeit')).toBe('tkkg');
    expect(id('TKKG Junior, Folge 3')).toBe('tkkg-junior');
    expect(id('BENJAMIN BLÜMCHEN – Folge 12: Als Wetterelefant')).toBe('benjamin-bluemchen');
    expect(id('Benjamin Bluemchen 12')).toBe('benjamin-bluemchen');
    expect(id('Fünf Freunde 1 - Fünf Freunde beim Wanderzirkus')).toBe('fuenf-freunde');
    expect(id('5 Freunde und das Burgverlies')).toBe('fuenf-freunde');
    expect(id('Bibi Blocksberg 77 Teil 2')).toBe('bibi-blocksberg');
    expect(id('Gregs Tagebuch 3 - Jetzt reicht’s!')).toBe('gregs-tagebuch');
    expect(id("Greg's Tagebuch")).toBe('gregs-tagebuch');
    expect(id('Die Schule der magischen Tiere 1')).toBe('schule-der-magischen-tiere');
    expect(id('Pettersson & Findus: Wie Findus zu Pettersson kam')).toBe('pettersson-und-findus');
    expect(id("Laura's Stern")).toBe('lauras-stern');
  });

  it('tells "&" and "und" apart from other series and keeps sister series apart', () => {
    expect(id({ title: 'Bibi & Tina: Mädchen gegen Jungs (Soundtrack)', artist: 'Bibi & Tina' })).toBe('bibi-und-tina');
    expect(id({ title: 'Bibi und Tina: Tohuwabohu total', artist: 'Bibi & Tina' })).toBe('bibi-und-tina');
    expect(id('Hanni & Nanni in neuen Abenteuern')).toBe('hanni-und-nanni');
    expect(id('Die drei !!! 12')).toBe('die-drei-ausrufezeichen');
  });

  it('cleans downloader noise and finds a series named only in the artist field', () => {
    expect(id('SomeDownloader.com - Paw Patrol Folge 4')).toBe('paw-patrol');
    expect(id({ title: 'O je, Tannenbaum! Das Weihnachtsalbum', artist: 'Unter meinem Bett' })).toBe('unter-meinem-bett');
    expect(id({ title: 'Unter meinem Bett 8', artist: 'Diverse Interpreten' })).toBe('unter-meinem-bett');
  });

  it('finds artists by their name, also only in the tracks', () => {
    expect(id({ title: 'Weihnachtsbäckerei', artist: 'Rolf Zuckowski' })).toBe('rolf-zuckowski');
    expect(id({ title: 'Rolfs Vogelhochzeit', artist: 'Rolf Zuckowski' })).toBe('rolf-zuckowski');
    expect(id({ title: 'Die 30 besten Kinderlieder', artist: 'Simone Sommerland, Karsten Glück & die Kita-Frösche' })).toBe('simone-sommerland');
    const tracks = ['Schule', 'Komme mit', 'Ab in den Urlaub'].map((title) => ({ title, artist: 'Deine Freunde' }));
    expect(id({ title: 'Kindsköpfe', tracks })).toBe('deine-freunde');
    expect(id({ title: 'Oh, wie schön ist Panama', artist: 'Janosch' })).toBe('oh-wie-schoen-ist-panama');
  });

  it('wants the author for short titles, so another "Momo" or "Hobbit" stays unknown', () => {
    expect(id({ title: 'Der Hobbit (ungekürzte Lesung)', artist: 'J. R. R. Tolkien' })).toBe('der-hobbit');
    expect(id({ title: 'Der Hobbit', artist: 'Irgendwer' })).toBeNull();
    expect(id({ title: 'Momo', artist: 'Michael Ende' })).toBe('momo');
    expect(id({ title: 'Momo', artist: 'Eine Band' })).toBeNull();
  });

  it('knows nothing of works it has no colours for', () => {
    for (const t of ['Abbey Road', 'Graceland', 'Die schönsten Kinderlieder zum Mitsingen', 'Das Lumpenkonzert', 'Kinderdisco', 'Samstagabend']) expect(id(t), t).toBeNull();
    expect(id({ title: 'Rumours', artist: 'Fleetwood Mac' })).toBeNull();
  });

  it('gives each of the three ink books its own colour', () => {
    const band = (t: string) => recognizeWork({ title: t })?.band;
    expect(new Set([band('Tintenherz'), band('Tintenblut'), band('Tintentod')]).size).toBe(3);
  });
});

describe('the colours a sticker carries', () => {
  it('leaves the band to the cover for series whose covers change colour', () => {
    expect(workColors({ title: 'Unter meinem Bett 5', artist: 'Diverse Interpreten', tracks: [] })).toMatchObject({ id: 'unter-meinem-bett', band: undefined, plate: '#fff7e6' });
    expect(workColors({ title: 'Die drei ??? 1', tracks: [] })).toMatchObject({ name: 'Die drei ???', band: '#141414', plate: '#ffffff', digits: '#d7141a' });
  });

  it('is worked out once per catalog entry and per title', () => {
    const entry = { title: 'TKKG 1', tracks: [] };
    expect(workColors(entry)).toBe(workColors(entry));
    expect(workColorsByTitle('Bibi Blocksberg')).toBe(workColorsByTitle('Bibi Blocksberg'));
    expect(workColors(undefined)).toBeUndefined();
    expect(workColorsByTitle('Urlaub 2024')).toBeUndefined();
  });
});
