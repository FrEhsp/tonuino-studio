import { describe, expect, it } from 'vitest';
import { HexError, parseIntelHex, toIntelHex } from '../../src/core/firmware/intelhex';

/** One record with a correct checksum. */
function line(type: number, offset: number, data: number[]): string {
  return raw([data.length, offset >> 8, offset & 0xff, type, ...data]);
}

/** Bytes as a record, checksum appended. */
function raw(bytes: number[]): string {
  const sum = bytes.reduce((a, b) => a + b, 0);
  return ':' + [...bytes, (0x100 - (sum & 0xff)) & 0xff].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const EOF = ':00000001FF';

function hexError(input: string | Uint8Array, maxSpan?: number): HexError {
  try {
    parseIntelHex(input, maxSpan === undefined ? {} : { maxSpan });
  } catch (e) {
    if (e instanceof HexError) return e;
    throw e;
  }
  throw new Error('expected a HexError');
}

describe('parseIntelHex', () => {
  it('reads data records into one image', () => {
    const image = parseIntelHex([line(0, 0, [1, 2, 3, 4]), line(0, 4, [5, 6]), EOF].join('\n'));
    expect([...image.data]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(image.startAddress).toBe(0);
    expect(image.byteCount).toBe(6);
    expect(image.entryPoint).toBeUndefined();
  });

  it('starts at the lowest address and fills gaps with 0xFF', () => {
    const image = parseIntelHex([line(0, 0x210, [9, 9]), line(0, 0x200, [1, 2]), EOF].join('\r\n'));
    expect(image.startAddress).toBe(0x200);
    expect(image.data.length).toBe(0x12);
    expect([...image.data.subarray(0, 3)]).toEqual([1, 2, 0xff]);
    expect([...image.data.subarray(0x10)]).toEqual([9, 9]);
    expect(image.byteCount).toBe(4);
  });

  it('follows extended linear (04) and extended segment (02) addresses', () => {
    const linear = parseIntelHex([line(4, 0, [0x00, 0x01]), line(0, 0x0010, [0xaa]), EOF].join('\n'));
    expect(linear.startAddress).toBe(0x10010);
    expect([...linear.data]).toEqual([0xaa]);

    const segment = parseIntelHex([line(2, 0, [0x10, 0x00]), line(0, 0x0004, [0xbb]), EOF].join('\n'));
    expect(segment.startAddress).toBe(0x10004);

    const both = parseIntelHex([line(0, 0xfffe, [1, 2]), line(4, 0, [0, 1]), line(0, 0, [3, 4]), EOF].join('\n'));
    expect(both.startAddress).toBe(0xfffe);
    expect([...both.data]).toEqual([1, 2, 3, 4]);
  });

  it('wraps a record that runs over the end of its 64 KiB segment', () => {
    const image = parseIntelHex([line(4, 0, [0, 1]), line(0, 0xfffe, [1, 2, 3, 4]), EOF].join('\n'));
    expect(image.startAddress).toBe(0x10000);
    expect([...image.data.subarray(0, 2)]).toEqual([3, 4]);
    expect([...image.data.subarray(0xfffe)]).toEqual([1, 2]);
  });

  it('reads the entry point from start records (03 and 05)', () => {
    expect(parseIntelHex([line(0, 0, [1]), line(3, 0, [0x12, 0x34, 0x00, 0x05]), EOF].join('\n')).entryPoint).toBe(0x12345);
    expect(parseIntelHex([line(0, 0, [1]), line(5, 0, [0x80, 0x00, 0x01, 0x00]), EOF].join('\n')).entryPoint).toBe(0x80000100);
  });

  it('accepts bytes, lower case, blank lines and stray spaces, and ignores what follows the end record', () => {
    const text = `\n  ${line(0, 0, [0xab, 0xcd]).toLowerCase()}  \r\n\r\n${EOF}\nnoch etwas Text`;
    const image = parseIntelHex(new TextEncoder().encode(text));
    expect([...image.data]).toEqual([0xab, 0xcd]);
  });

  it('names the line with a wrong checksum', () => {
    const good = line(0, 2, [3, 4]);
    const bad = good.slice(0, -2) + ((parseInt(good.slice(-2), 16) + 1) & 0xff).toString(16).padStart(2, '0');
    const error = hexError([line(0, 0, [1, 2]), '', bad, EOF].join('\n'));
    expect(error.reason).toBe('checksum');
    expect(error.line).toBe(3);
    expect(error.message).toBe('Zeile 3: Die Prüfsumme stimmt nicht. Die Datei ist beschädigt. Lade sie bitte neu herunter.');
  });

  it('rejects broken records', () => {
    expect(hexError(`:10000000ZZ\n${EOF}`).reason).toBe('syntax');
    expect(hexError(`:0000000\n${EOF}`).reason).toBe('syntax');
    expect(hexError(`${raw([4, 0, 0, 0, 1, 2, 3])}\n${EOF}`).reason).toBe('length');
    expect(hexError(`${line(0, 0, [1])}\nhallo\n${EOF}`)).toMatchObject({ reason: 'syntax', line: 2 });
    const type = hexError(`${line(6, 0, [1])}\n${EOF}`);
    expect(type.reason).toBe('record-type');
    expect(type.message).toContain('0x06');
    expect(hexError(`${line(4, 0, [1])}\n${EOF}`).reason).toBe('address-record');
  });

  it('notices a download that was cut off', () => {
    const error = hexError([line(0, 0, [1, 2]), line(0, 2, [3, 4])].join('\n'));
    expect(error.reason).toBe('no-eof');
    expect(error.message).toContain('unvollständig');
  });

  it('explains files that are no HEX file at all', () => {
    const html = hexError('<!DOCTYPE html>\n<html><body>404</body></html>');
    expect(html.reason).toBe('not-hex');
    expect(html.message).toBe('Zeile 1: Das ist eine Webseite und keine Firmware-Datei (.hex). Speichere die Datei firmware.hex selbst, nicht die Seite.');
    expect(hexError('PK\u0003\u0004 zip').message).toContain('keine Firmware-Datei');
    expect(hexError('').reason).toBe('empty');
    expect(hexError('\n\n').message).toBe('Die Datei ist leer. Lade sie bitte neu herunter.');
    expect(hexError(EOF).message).toBe('Die Datei enthält keine Firmware-Daten. Lade sie bitte neu herunter.');
  });

  it('refuses addresses that are too far apart', () => {
    const error = hexError([line(0, 0, [1]), line(4, 0, [0x01, 0x00]), line(0, 0, [2]), EOF].join('\n'), 0x10000);
    expect(error.reason).toBe('too-large');
    expect(error.line).toBe(3);
  });
});

describe('toIntelHex', () => {
  it('round-trips data across a 64 KiB boundary', () => {
    const data = new Uint8Array(70000).map((_, i) => (i * 7 + 3) & 0xff);
    const text = toIntelHex(data, 0x8000);
    const lines = text.trim().split('\n');
    expect(lines.at(-1)).toBe(EOF);
    expect(lines.filter((l) => l.slice(7, 9) === '04')).toHaveLength(2);
    expect(lines.every((l) => parseInt(l.slice(1, 3), 16) <= 16)).toBe(true);
    const image = parseIntelHex(text);
    expect(image.startAddress).toBe(0x8000);
    expect(image.byteCount).toBe(70000);
    expect(image.data).toEqual(data);
  });
});
