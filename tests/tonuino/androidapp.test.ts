import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { androidAppSupport, readCrashNotice, splitForPhoneApp, unknownNotice } from '../../src/core/tonuino/androidapp';
import { cardToQrLine, qrGroups, type CardData } from '../../src/core/tonuino/card';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';
import { blockTexts, helpLinks, pageBlocks } from '../../src/features/help/topics';

const folderCard = (mode: number, special = 0, special2 = 0, folder = 3): CardData => ({ folder, mode, special, special2 });

describe('androidAppSupport', () => {
  it('cards from mode 15 up crash the app when it reads them, whatever the folder', () => {
    expect(androidAppSupport(folderCard(16, 1, 5))).toBe('readCrash');
    expect(androidAppSupport(folderCard(16, 3, 9, 42))).toBe('readCrash');
    expect(androidAppSupport(folderCard(15))).toBe('readCrash');
    // The admin card of the box: folder 0, mode 255.
    expect(androidAppSupport(adminCard())).toBe('readCrash');
    expect(androidAppSupport(folderCard(17))).toBe('readCrash');
    expect(androidAppSupport(modifierCard(15))).toBe('readCrash');
  });

  it('cards newer than the app are unknown', () => {
    for (const code of [8, 9, 10, 11]) expect(androidAppSupport(modifierCard(code)), `modifier ${code}`).toBe('unknown');
    expect(androidAppSupport({ folder: 0, mode: 13, special: 7, special2: 0 })).toBe('unknown');
    expect(androidAppSupport(folderCard(5, 0, 2))).toBe('unknown');
    // Hörbuch Stück für Stück has the same surprise folder.
    expect(androidAppSupport(folderCard(10, 2, 1))).toBe('unknown');
  });

  it('cards the app knows are fine', () => {
    for (let mode = 1; mode <= 14; mode++) expect(androidAppSupport(folderCard(mode)), `mode ${mode}`).toBe('ok');
    for (let code = 1; code <= 7; code++) expect(androidAppSupport(modifierCard(code)), `modifier ${code}`).toBe('ok');
    expect(androidAppSupport(modifierCard(1, 15 + 0x80))).toBe('ok');
    expect(androidAppSupport(folderCard(5))).toBe('ok');
    expect(androidAppSupport(folderCard(10, 2))).toBe('ok');
    // The Nochmal-Karte as the box writes it.
    expect(androidAppSupport({ folder: 0xff, mode: 11, special: 0, special2: 0 })).toBe('ok');
  });

  it('mode 0 is shown as unknown without a crash', () => {
    expect(androidAppSupport(folderCard(0))).toBe('unknown');
    expect(androidAppSupport(modifierCard(0))).toBe('unknown');
    expect(androidAppSupport(modifierCard(12))).toBe('unknown');
  });
});

describe('splitForPhoneApp', () => {
  interface Item {
    title: string;
    data: CardData;
  }
  const items: Item[] = [
    { title: 'Bibi und Tina', data: folderCard(5, 0, 0, 1) },
    { title: 'Drei Bücher', data: folderCard(16, 1, 4, 2) },
    { title: 'Jukebox', data: modifierCard(8) },
    { title: 'Schlummerkarte', data: modifierCard(1, 15) },
    { title: 'Admin-Karte', data: adminCard() },
  ];

  it('names the cards for the notices and keeps every card in the codes', () => {
    const split = splitForPhoneApp(items, (i) => i.data);
    expect(split.readCrash.map((i) => i.title)).toEqual(['Drei Bücher', 'Admin-Karte']);
    expect(split.unknown.map((i) => i.title)).toEqual(['Jukebox']);

    // The app writes the bytes of each line as they are, so a mode 16 card is in a code like any other.
    for (const perCode of [1, 4, Infinity]) {
      const groups = qrGroups(items, (i) => cardToQrLine(i.data, i.title), perCode);
      expect(groups.flat()).toHaveLength(items.length);
      expect(groups.flat().some((i) => i.data.mode === 16)).toBe(true);
    }
  });

  it('says the app writes the card but crashes when it reads it', () => {
    const split = splitForPhoneApp(items, (i) => i.data);
    const text = readCrashNotice(split.readCrash.map((i) => i.title));
    expect(text).toContain('„Drei Bücher“ und „Admin-Karte“');
    expect(text).toContain('schreiben, aber nicht auslesen');
    expect(text).toContain('stürzt die App ab');
    expect(text).toContain('an der Box');
    // Nothing is left out, so the notice must not say so.
    expect(text).not.toContain('in keinem Code');
    expect(readCrashNotice(['Drei Bücher'])).toContain('„Drei Bücher“ schreiben, aber nicht auslesen');
    expect(unknownNotice(split.unknown.map((i) => i.title))).toContain('„Jukebox“');
  });

  it('lists several titles and shortens a long list', () => {
    expect(readCrashNotice(['A', 'B', 'C'])).toContain('„A“, „B“ und „C“');
    expect(unknownNotice(['A', 'B'])).toContain('„A“ und „B“');
    const many = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const text = unknownNotice(many);
    expect(text).toContain('„5“ und 3 weitere');
    expect(text).not.toContain('„6“');
  });

  it('leaves an all-fine list without notices', () => {
    const fine = [items[0], items[3]];
    expect(splitForPhoneApp(fine, (i) => i.data)).toEqual({ readCrash: [], unknown: [] });
  });
});

describe('where to get the phone app', () => {
  const storeOrder = (hrefs: string[]) =>
    hrefs.map((h) => (h.includes('f-droid.org') ? 'fdroid' : h.includes('play.google.com') ? 'play' : '')).filter(Boolean);

  it('the help section names F-Droid before Google Play', () => {
    const hrefs = helpLinks()
      .filter((l) => l.part === 'handy')
      .map((l) => l.href);
    expect(storeOrder(hrefs)).toEqual(['fdroid', 'play']);
    const text = pageBlocks('handy').flatMap(blockTexts).join(' ');
    expect(text.indexOf('F-Droid')).toBeGreaterThan(-1);
    expect(text.indexOf('F-Droid')).toBeLessThan(text.indexOf('Google Play'));
  });

  it('the QR panel names F-Droid before Google Play', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/features/cards/QrPanel.tsx', import.meta.url)), 'utf8');
    const intro = source.slice(source.indexOf('<div class="qr-intro">'));
    expect(intro.indexOf('>F-Droid<')).toBeGreaterThan(-1);
    expect(intro.indexOf('>F-Droid<')).toBeLessThan(intro.indexOf('>Google Play<'));
  });
});

describe('what the help and the QR panel say about the phone app', () => {
  const handy = () => pageBlocks('handy').flatMap(blockTexts).join(' ');

  it('quotes the app the way it really reads', () => {
    const text = handy();
    // values-de/strings.xml of TonUINO NFC Tools 1.0.3: written_unsupported_tag_type and edit_modifier_tags.
    expect(text).toContain('„Die App kann auf diese Art NFC Tag nicht schreiben“');
    expect(text).toContain('„SAK: 08“');
    expect(text).toContain('„Sperre“');
    expect(text).not.toContain('Gesperrt');
    expect(text).not.toContain('aktualisiere sie');
  });

  it('says the crash comes when the app reads a card, and who lists the cards', () => {
    const text = handy();
    expect(text).toContain('schreiben, aber nicht auslesen');
    expect(text).not.toContain('aus den Codes weg');
    expect(text).toContain('TonUINO Studio nennt dir');
    expect(text).not.toMatch(/Die App (lässt|zeigt)/);
  });

  it('the QR panel shows its notes above the steps', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/features/cards/QrPanel.tsx', import.meta.url)), 'utf8');
    const body = source.slice(source.indexOf('return ('));
    expect(body.indexOf('readCrashNotice(')).toBeGreaterThan(-1);
    expect(body.indexOf('readCrashNotice(')).toBeLessThan(body.indexOf('<ol class="plain-steps">'));
    expect(body.indexOf('unknownNotice(')).toBeLessThan(body.indexOf('<ol class="plain-steps">'));
  });
});
