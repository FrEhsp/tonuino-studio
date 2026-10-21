import { describe, expect, it } from 'vitest';
import { cardToQrLine } from '../../src/core/tonuino/card';
import { parsePastedCards, pastedLabel, splitCardLine } from '../../src/core/tonuino/cardlist';

const OLCHIS = { version: 2, folder: 4, mode: 5, special: 0, special2: 0 };
const SLEEP = { version: 2, folder: 0, mode: 1, special: 15, special2: 0 };

describe('splitting a pasted line', () => {
  it('splits at ";" as NFC Tools does', () => {
    expect(splitCardLine('1337b347020405000000;Die Olchis')).toEqual({ hex: '1337b347020405000000', title: 'Die Olchis' });
    expect(splitCardLine('  13 37 b3 47 02 04 05 00 00 ; Die Olchis  ')).toEqual({ hex: '13 37 b3 47 02 04 05 00 00', title: 'Die Olchis' });
    // A title with ";" inside keeps it.
    expect(splitCardLine('1337b347020405000000;Rock;Pop')).toEqual({ hex: '1337b347020405000000', title: 'Rock;Pop' });
  });

  it('splits at a tab, as pasted from a spreadsheet', () => {
    expect(splitCardLine('1337b347020405000000\tDie Olchis')).toEqual({ hex: '1337b347020405000000', title: 'Die Olchis' });
  });

  it('without ";" takes groups of hex as bytes, and after nine bytes only zeros', () => {
    expect(splitCardLine('1337b347020405000000 Die Olchis')).toEqual({ hex: '1337b347020405000000', title: 'Die Olchis' });
    expect(splitCardLine('13 37 b3 47 02 04 05 00 00 00 Abba Gold')).toEqual({ hex: '13 37 b3 47 02 04 05 00 00 00', title: 'Abba Gold' });
    expect(splitCardLine('13:37:b3:47:02:04:05:00:00 Cafe del Mar')).toEqual({ hex: '13:37:b3:47:02:04:05:00:00', title: 'Cafe del Mar' });
    expect(splitCardLine('1337B347020405000000')).toEqual({ hex: '1337B347020405000000', title: '' });
    expect(splitCardLine('Die Olchis')).toEqual({ hex: '', title: 'Die Olchis' });
  });
});

describe('reading a pasted list', () => {
  it('reads the lines Studio writes for the phone', () => {
    const text = [cardToQrLine(OLCHIS, 'Die Olchis'), cardToQrLine(SLEEP, 'Schlummerkarte, 15 Minuten')].join('\n');
    const rows = parsePastedCards(text, 'tng');
    expect(rows.map((r) => r.card)).toEqual([OLCHIS, SLEEP]);
    expect(rows.map((r) => r.title)).toEqual(['Die Olchis', 'Schlummerkarte, 15 Minuten']);
    expect(rows[0].says).toBe('Hörbuch: Ordner 04.');
    expect(rows[1].says).toBe('Schlummerkarte: schaltet nach 15 Minuten ab.');
    expect(rows.every((r) => !r.problem && !r.warnings.length)).toBe(true);
  });

  it('skips blank lines, takes CRLF, lowercase and uppercase, and counts lines as pasted', () => {
    const rows = parsePastedCards('\r\n1337B347020405000000;Die Olchis\r\n   \r\n﻿1337b347020405000000\r\n', 'tng');
    expect(rows.map((r) => r.line)).toEqual([2, 4]);
    expect(rows.map((r) => r.title)).toEqual(['Die Olchis', '']);
    expect(rows.every((r) => r.card?.folder === 4)).toBe(true);
  });

  it('names the folder the SD card knows', () => {
    const rows = parsePastedCards('1337b347020405000000;x', 'tng', (n) => (n === 4 ? 'Die Olchis' : undefined));
    expect(rows[0].says).toBe('Hörbuch: Ordner 04 („Die Olchis“).');
  });

  it('says why a line is no card', () => {
    const rows = parsePastedCards(['Nur ein Titel', '1337b3470204;Zu kurz', '0000000002040500000;Fremd', '1337b347070405000000;Neu', '1337b347020405000001;Rest'].join('\n'), 'tng');
    expect(rows.map((r) => r.card)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(rows[0].problem).toBe('Am Anfang der Zeile stehen keine Bytes.');
    expect(rows[1].problem).toMatch(/Es fehlen Bytes/);
    expect(rows[2].problem).toMatch(/zwei Zeichen|13 37 b3 47/);
    expect(rows[3].problem).toBe('Version 7 kennt keine TonUINO-Box.');
    expect(rows[4].problem).toMatch(/nur Nullen/);
  });

  it('takes a card the box may not know, with a warning', () => {
    const rows = parsePastedCards('1337b347020009000000;Pause nach jedem Titel', 'classic21');
    // TNG knows this special card, TonUINO 2.1 does not: the list says "passt nicht" then, and the firmware can be switched there.
    expect(rows[0].card).toEqual({ version: 2, folder: 0, mode: 9, special: 0, special2: 0 });
    expect(rows[0].warnings).toEqual(['Eine Spezialkarte mit Modus 9 kennt die Box nicht.']);
    expect(parsePastedCards('1337b347020009000000', 'tng')[0].warnings).toEqual([]);
  });

  it('reads the old card format of TonUINO 2.0', () => {
    const rows = parsePastedCards('1337b347010405000000;Alt', 'tng');
    expect(rows[0].card?.version).toBe(1);
    expect(rows[0].says).toBe('Hörbuch: Ordner 04. Im Kartenformat für TonUINO 2.0.');
  });
});

describe('warnings before the cards go on the list', () => {
  // Folder 4 has 6 tracks on the SD card, folder 48 is not there.
  const counts = (n: number) => (n === 4 ? 6 : undefined);

  it('says when the SD card lacks the folder or the track', () => {
    const rows = parsePastedCards(['1337b347023005000000;Folge vier', '1337b347020404090000;Neun', '1337b347020404030000;Drei'].join('\n'), 'tng', undefined, counts);
    expect(rows[0].warnings).toEqual(['Ordner 48 gibt es auf der SD-Karte nicht.']);
    expect(rows[1].warnings).toEqual(['Titel 9 gibt es im Ordner nicht (nur 1 bis 6).']);
    expect(rows[2].warnings).toEqual([]);
  });

  it('says without an SD card when a track 0 or a backwards range is no track at all', () => {
    const rows = parsePastedCards(['1337b347020404000000;Null', '1337b347020407050300;Rückwärts', '1337b347023005000000;Irgendwo'].join('\n'), 'tng');
    expect(rows[0].warnings).toEqual(['Titel 0 gibt es nicht: Die Titel zählen ab 1.']);
    expect(rows[1].warnings).toEqual(['Der Bereich von … bis … ist ungültig.']);
    expect(rows[2].warnings).toEqual([]);
  });
});

describe('the name of a pasted card', () => {
  it('is the title from the line', () => {
    expect(pastedLabel('  Folge   vier ', 48)).toBe('Folge vier');
    expect(pastedLabel('Konzert als Hörbuch', 1, 'Konzert am Herd')).toBe('Konzert als Hörbuch');
  });

  it('loses the folder Studio\'s own "Liste kopieren" puts in front', () => {
    expect(pastedLabel('Abbey Road · Titel 3', 7, 'Abbey Road')).toBe('Titel 3');
    expect(pastedLabel('Ordner 48 · Das Hexenfest', 48)).toBe('Das Hexenfest');
    // Another folder's name, or nothing after it, stays.
    expect(pastedLabel('Abbey Road · Titel 3', 7, 'Let It Be')).toBe('Abbey Road · Titel 3');
    expect(pastedLabel('Abbey Road · ', 7, 'Abbey Road')).toBe('Abbey Road ·');
  });
});
