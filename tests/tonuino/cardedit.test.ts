import { describe, expect, it } from 'vitest';
import { cardBytesText, cardFromBytes, emptyCardBytes, folderNumberOf, fullCard, isFolderCard, parseCardHex, rawCardProblems, rawTextsValid, rawValue, sleepMinutesProblem, storedCard } from '../../src/core/tonuino/cardedit';
import { encodeCard } from '../../src/core/tonuino/card';
import { sleepMaxMinutes, sleepMinutesOf, describeCard } from '../../src/core/tonuino/modes';
import { extraLabel } from '../../src/features/cards/items';

describe('cards made by hand', () => {
  it('fills in and leaves out the version', () => {
    expect(fullCard({ folder: 5, mode: 5, special: 0, special2: 0 })).toEqual({ version: 2, folder: 5, mode: 5, special: 0, special2: 0 });
    expect(storedCard({ version: 2, folder: 5, mode: 5, special: 0, special2: 0 })).toEqual({ folder: 5, mode: 5, special: 0, special2: 0 });
    expect(storedCard({ version: 1, folder: 5, mode: 5, special: 0, special2: 0 }).version).toBe(1);
  });

  it('takes whole numbers from 0 to 255 only', () => {
    expect(rawValue(' 42 ')).toBe(42);
    expect(rawValue('255')).toBe(255);
    expect(rawValue('256')).toBeUndefined();
    expect(rawValue('-1')).toBeUndefined();
    expect(rawValue('1.5')).toBeUndefined();
    expect(rawValue('')).toBeUndefined();
  });

  it('shows the bytes as NFC Tools does and reads them back', () => {
    const text = cardBytesText({ folder: 5, mode: 5, special: 0, special2: 0 });
    expect(text).toBe('13 37 b3 47 02 05 05 00 00 00 00 00 00 00 00 00');
    expect(cardBytesText({ folder: 5, mode: 5, special: 0, special2: 0 }, 9)).toBe('13 37 b3 47 02 05 05 00 00');
    expect(parseCardHex(text)).toEqual({ ok: true, card: { version: 2, folder: 5, mode: 5, special: 0, special2: 0 } });
    expect(parseCardHex('1337B34701030100 00')).toEqual({ ok: true, card: { version: 1, folder: 3, mode: 1, special: 0, special2: 0 } });
    expect(parseCardHex('0x13:0x37:0xb3:0x47:02:00:01:0f:00')).toMatchObject({ ok: true, card: { folder: 0, mode: 1, special: 15 } });
  });

  it('says in German what is wrong with typed bytes', () => {
    const bad = (t: string) => {
      const r = parseCardHex(t);
      return r.ok ? '' : r.message;
    };
    expect(bad('')).toMatch(/Hex-Zahlen/);
    expect(bad('13 37 zz')).toMatch(/nur die Ziffern/);
    expect(bad('13 37 b')).toMatch(/zwei Zeichen/);
    expect(bad('13 37 b3 47 02 05')).toMatch(/fehlen Bytes/);
    expect(bad('00'.repeat(17))).toMatch(/16 Bytes/);
    expect(bad('12 34 56 78 02 05 05 00 00')).toMatch(/13 37 b3 47/);
    expect(bad('13 37 b3 47 02 05 05 00 00 01')).toMatch(/Nullen/);
  });

  it('copies TonUINO cards from the reader, also of an unknown version, but not empty or foreign ones', () => {
    expect(cardFromBytes(encodeCard({ version: 1, folder: 3, mode: 2, special: 0, special2: 0 }))).toEqual({ version: 1, folder: 3, mode: 2, special: 0, special2: 0 });
    const odd = encodeCard({ folder: 3, mode: 2, special: 0, special2: 0 });
    odd[4] = 7;
    expect(cardFromBytes(odd)).toMatchObject({ version: 7, folder: 3 });
    expect(cardFromBytes(emptyCardBytes())).toBeUndefined();
    expect(cardFromBytes(new Uint8Array(16).fill(0xaa))).toBeUndefined();
    expect([...emptyCardBytes()]).toEqual(new Array(16).fill(0));
  });

  it('tells folder cards from special cards', () => {
    expect(isFolderCard({ folder: 99, mode: 5, special: 0, special2: 0 })).toBe(true);
    expect(isFolderCard({ folder: 0, mode: 1, special: 15, special2: 0 })).toBe(false);
    expect(isFolderCard({ folder: 100, mode: 5, special: 0, special2: 0 })).toBe(false);
  });

  it('warns about cards the box will not take', () => {
    expect(rawCardProblems({ version: 2, folder: 5, mode: 5, special: 0, special2: 0 }, 'tng')).toEqual([]);
    expect(rawCardProblems({ version: 3, folder: 5, mode: 5, special: 0, special2: 0 }, 'tng')[0]).toMatch(/Version 3/);
    expect(rawCardProblems({ version: 1, folder: 0, mode: 1, special: 15, special2: 0 }, 'tng')[0]).toMatch(/TonUINO 2.0/);
    expect(rawCardProblems({ version: 1, folder: 5, mode: 6, special: 0, special2: 0 }, 'tng')[0]).toMatch(/TonUINO 2.0/);
    expect(rawCardProblems({ version: 2, folder: 0, mode: 1, special: 0, special2: 0 }, 'tng')).toEqual(['Eine Schlummerkarte mit 0 Minuten schaltet sofort ab.']);
    expect(rawCardProblems({ version: 2, folder: 0, mode: 1, special: 0x80, special2: 0 }, 'tng')).toHaveLength(1);
    expect(rawCardProblems({ version: 2, folder: 0, mode: 200, special: 0, special2: 0 }, 'tng')[0]).toMatch(/Modus 200/);
    expect(rawCardProblems({ version: 2, folder: 120, mode: 5, special: 0, special2: 0 }, 'tng')[0]).toMatch(/Ordner 120/);
    expect(rawCardProblems({ version: 2, folder: 5, mode: 77, special: 0, special2: 0 }, 'tng')[0]).toMatch(/Modus 77/);
  });
});

describe('free Schlummer minutes', () => {
  it('fit into seven bits on TNG and a whole byte on 2.1', () => {
    expect(sleepMaxMinutes('tng')).toBe(127);
    expect(sleepMaxMinutes('classic21')).toBe(255);
    expect(sleepMinutesProblem(127, 'tng')).toBeUndefined();
    expect(sleepMinutesProblem(128, 'tng')).toMatch(/1 bis 127/);
    expect(sleepMinutesProblem(200, 'classic21')).toBeUndefined();
    expect(sleepMinutesProblem(0, 'classic21')).toMatch(/1 bis 255/);
    expect(sleepMinutesProblem(2.5, 'tng')).toBeDefined();
  });

  it('are read the way each firmware reads them', () => {
    expect(sleepMinutesOf({ special: 0x80 + 45 }, 'tng')).toBe(45);
    expect(sleepMinutesOf({ special: 200 }, 'classic21')).toBe(200);
    expect(describeCard({ folder: 0, mode: 1, special: 200, special2: 0 }, 'classic21')).toMatch(/200 Minuten/);
    expect(extraLabel({ folder: 0, mode: 1, special: 0x80 + 45, special2: 0 }, 'tng')).toBe('Schlummerkarte, 45 Minuten (bis Titelende)');
    expect(extraLabel({ folder: 0, mode: 1, special: 200, special2: 0 }, 'classic21')).toMatch(/200 Minuten$/);
  });
});

describe('free card fields as typed', () => {
  it('take folders 1 to 99 only', () => {
    expect(folderNumberOf('7')).toBe(7);
    expect(folderNumberOf(' 99 ')).toBe(99);
    for (const bad of ['0', '100', '', ' ', '7.5', '-1', '1e1', '007']) expect(folderNumberOf(bad)).toBeUndefined();
  });

  it('hold a byte in every number field, or keep the card off the list', () => {
    const ok = { version: '2', folder: '7', mode: '5', special: '0', special2: '0' };
    expect(rawTextsValid(ok)).toBe(true);
    expect(rawTextsValid({ ...ok, mode: '300' })).toBe(false);
    expect(rawTextsValid({ ...ok, special: '' })).toBe(false);
    expect(rawTextsValid({ ...ok, folder: '0' })).toBe(true);
  });
});

