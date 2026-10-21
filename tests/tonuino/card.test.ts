import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { cardToQrLine, decodeCard, encodeCard, QR_MAX_BYTES, qrGroups, qrPayloads } from '../../src/core/tonuino/card';
import { checkCardAgainstSd, describeCard, modifierCard } from '../../src/core/tonuino/modes';

describe('TonUINO card format', () => {
  it('encodes the forum example 13 37 B3 47 02 15 07 0A 1A', () => {
    const bytes = encodeCard({ folder: 21, mode: 7, special: 10, special2: 26 });
    expect([...bytes.subarray(0, 9)]).toEqual([0x13, 0x37, 0xb3, 0x47, 0x02, 0x15, 0x07, 0x0a, 0x1a]);
    expect([...bytes.subarray(9)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('decodes empty, foreign, bad version and valid cards', () => {
    expect(decodeCard(new Uint8Array(16)).kind).toBe('empty');
    expect(decodeCard(Uint8Array.from([1, 2, 3, 4, 2, 1, 1, 0, 0])).kind).toBe('foreign');
    expect(decodeCard(Uint8Array.from([0x13, 0x37, 0xb3, 0x47, 3, 1, 1, 0, 0])).kind).toBe('bad-version');
    const ok = decodeCard(encodeCard({ folder: 5, mode: 5, special: 0, special2: 0 }));
    expect(ok).toEqual({ kind: 'tonuino', data: { version: 2, folder: 5, mode: 5, special: 0, special2: 0 } });
  });

  it('builds QR lines like Tonuino Cards Manager', () => {
    expect(cardToQrLine({ folder: 1, mode: 2, special: 0, special2: 0 }, 'Album 1')).toBe('1337b34702010200 00'.replace(' ', '') + ';Album 1');
    expect(qrPayloads(['a', 'b', 'c', 'd', 'e'], 4)).toEqual(['a\nb\nc\nd', 'e']);
  });

  it('describes cards in plain German', () => {
    expect(describeCard({ folder: 3, mode: 5, special: 0, special2: 2 })).toBe('Hörbuch: zufällig einer der Ordner 03 bis 05.');
    expect(describeCard(modifierCard(1, 15 + 0x80))).toContain('15 Minuten');
    expect(describeCard({ folder: 0, mode: 0xff, special: 0, special2: 0 })).toContain('Admin-Karte');
  });

  it('finds ranges that do not fit the SD card', () => {
    const counts = new Map([[1, 12], [2, 0]]);
    const tc = (f: number) => counts.get(f);
    expect(checkCardAgainstSd({ folder: 1, mode: 8, special: 3, special2: 20 }, tc)[0]).toContain('nur 12 Titel');
    expect(checkCardAgainstSd({ folder: 2, mode: 2, special: 0, special2: 0 }, tc)[0]).toContain('leer');
    expect(checkCardAgainstSd({ folder: 7, mode: 2, special: 0, special2: 0 }, tc)[0]).toContain('gibt es auf der SD-Karte nicht');
  });

  it('warns about a party card for a single track (forum 10620#9)', () => {
    const counts = new Map([[1, 1], [2, 12]]);
    const tc = (f: number) => counts.get(f);
    const party = checkCardAgainstSd({ folder: 1, mode: 3, special: 0, special2: 0 }, tc);
    expect(party).toHaveLength(1);
    expect(party[0]).toContain('nur ein Titel');
    expect(party[0]).toContain('„Album“');
    // A part of a folder with only one track in it.
    expect(checkCardAgainstSd({ folder: 2, mode: 9, special: 4, special2: 4 }, tc)[0]).toContain('nur einen Titel');
    // Two tracks or more, or another mode: nothing to say.
    expect(checkCardAgainstSd({ folder: 2, mode: 3, special: 0, special2: 0 }, tc)).toEqual([]);
    expect(checkCardAgainstSd({ folder: 2, mode: 9, special: 4, special2: 5 }, tc)).toEqual([]);
    expect(checkCardAgainstSd({ folder: 1, mode: 2, special: 0, special2: 0 }, tc)).toEqual([]);
    expect(checkCardAgainstSd({ folder: 1, mode: 4, special: 1, special2: 0 }, tc)).toEqual([]);
  });
});

describe('qrGroups', () => {
  const folderCard = (folder: number) => ({ folder, mode: 5, special: 0, special2: 0 });
  const line = (n: number) => cardToQrLine(folderCard(n), `Die drei ??? Folge ${100 + n}: Das Geheimnis der Särge`);
  const numbers = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const bytes = (group: number[]) => new TextEncoder().encode(group.map(line).join('\n')).length;

  it('keeps the chosen number of cards per code while they fit', () => {
    expect(qrGroups(numbers(9), line, 4)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
    expect(qrGroups(numbers(3), line, 1)).toEqual([[1], [2], [3]]);
  });

  it('"alle" with many long titles makes several codes that can all be drawn', () => {
    // 48 cards of about 75 bytes: far more than one code can hold.
    const groups = qrGroups(numbers(48), line, Infinity);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toEqual(numbers(48));
    for (const g of groups) {
      expect(bytes(g)).toBeLessThanOrEqual(QR_MAX_BYTES);
      expect(QRCode.create(g.map(line).join('\n'), { errorCorrectionLevel: 'M' }).version).toBeLessThanOrEqual(20);
    }
  });

  it('a card longer than a code allows gets a code of its own', () => {
    const long = (n: number) => (n === 2 ? 'x'.repeat(QR_MAX_BYTES + 10) : line(n));
    expect(qrGroups([1, 2, 3], long, Infinity)).toEqual([[1], [2], [3]]);
  });
});
