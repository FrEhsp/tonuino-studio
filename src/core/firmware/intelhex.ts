/**
 * Intel HEX parser for firmware files (avr-objcopy and PlatformIO output).
 *
 * Supports all record types of I8HEX, I16HEX and I32HEX:
 *   00 data, 01 end of file, 02 extended segment address,
 *   03 start segment address, 04 extended linear address, 05 start linear address.
 *
 * The result is one contiguous image from the lowest to the highest address.
 * Gaps are filled with 0xFF, the value of erased flash.
 */

export interface HexImage {
  /** Bytes from `startAddress` up to the highest address in the file. Gaps are 0xFF. */
  data: Uint8Array;
  /** Address of `data[0]`: the lowest address that holds data (0x200 for an AiO+ build). */
  startAddress: number;
  /** Number of bytes the file actually defines (gaps not counted). */
  byteCount: number;
  /** Program entry point from a type 03 or 05 record, when the file has one. */
  entryPoint?: number;
}

export type HexErrorReason =
  | 'not-hex'
  | 'syntax'
  | 'length'
  | 'checksum'
  | 'record-type'
  | 'address-record'
  | 'no-eof'
  | 'empty'
  | 'too-large';

/** A broken or unsuitable HEX file. `message` is German and names the line. */
export class HexError extends Error {
  /** 1-based line number, 0 when the problem is not tied to one line. */
  readonly line: number;
  readonly reason: HexErrorReason;

  constructor(reason: HexErrorReason, line: number, text: string) {
    super(line > 0 ? `Zeile ${line}: ${text}` : text);
    this.name = 'HexError';
    this.reason = reason;
    this.line = line;
  }
}

export interface ParseHexOptions {
  /**
   * Largest distance between the lowest and the highest address. Protects
   * against files that would need a huge image (default 16 MiB).
   */
  maxSpan?: number;
}

const DEFAULT_MAX_SPAN = 16 * 1024 * 1024;
const DAMAGED = 'Die Datei ist beschädigt. Lade sie bitte neu herunter.';

interface Chunk {
  address: number;
  bytes: Uint8Array;
}

/** Parses Intel HEX text (or the raw bytes of a .hex file). Throws HexError. */
export function parseIntelHex(input: string | Uint8Array, opts: ParseHexOptions = {}): HexImage {
  const text = typeof input === 'string' ? input : latin1(input);
  const maxSpan = opts.maxSpan ?? DEFAULT_MAX_SPAN;
  const lines = text.split(/\r\n|\n|\r/);

  const chunks: Chunk[] = [];
  let base = 0;
  let entryPoint: number | undefined;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let sawRecord = false;
  let eof = false;

  const addChunk = (address: number, bytes: Uint8Array, lineNo: number) => {
    if (bytes.length === 0) return;
    low = Math.min(low, address);
    high = Math.max(high, address + bytes.length);
    if (high - low > maxSpan) {
      throw new HexError('too-large', lineNo, 'Die Adressen liegen zu weit auseinander. Das ist keine passende Firmware-Datei. Wähle die Firmware für deine Platine.');
    }
    chunks.push({ address, bytes });
  };

  for (let i = 0; i < lines.length && !eof; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const lineNo = i + 1;

    if (line[0] !== ':') {
      if (!sawRecord) {
        throw new HexError(
          'not-hex',
          lineNo,
          line[0] === '<'
            ? 'Das ist eine Webseite und keine Firmware-Datei (.hex). Speichere die Datei firmware.hex selbst, nicht die Seite.'
            : 'Das ist keine Firmware-Datei im HEX-Format. Wähle eine Datei mit der Endung .hex.',
        );
      }
      throw new HexError('syntax', lineNo, `Die Zeile beginnt nicht mit einem Doppelpunkt. ${DAMAGED}`);
    }
    sawRecord = true;

    const hex = line.slice(1);
    if (hex.length < 10 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new HexError('syntax', lineNo, `Die Zeile ist kein gültiger HEX-Datensatz. ${DAMAGED}`);
    }
    const record = hexToBytes(hex);
    const length = record[0];
    if (record.length !== length + 5) {
      throw new HexError('length', lineNo, `Die Längenangabe passt nicht zur Zeile. ${DAMAGED}`);
    }
    let sum = 0;
    for (const b of record) sum += b;
    if ((sum & 0xff) !== 0) {
      throw new HexError('checksum', lineNo, `Die Prüfsumme stimmt nicht. ${DAMAGED}`);
    }

    const offset = (record[1] << 8) | record[2];
    const type = record[3];
    const payload = record.subarray(4, 4 + length);

    switch (type) {
      case 0x00: {
        // The 16-bit offset wraps inside its 64 KiB segment.
        const first = Math.min(payload.length, 0x10000 - offset);
        addChunk(base + offset, payload.subarray(0, first), lineNo);
        addChunk(base, payload.subarray(first), lineNo);
        break;
      }
      case 0x01:
        eof = true;
        break;
      case 0x02:
        expectLength(length, 2, lineNo);
        base = ((payload[0] << 8) | payload[1]) * 16;
        break;
      case 0x03:
        expectLength(length, 4, lineNo);
        entryPoint = ((payload[0] << 8) | payload[1]) * 16 + ((payload[2] << 8) | payload[3]);
        break;
      case 0x04:
        expectLength(length, 2, lineNo);
        base = ((payload[0] << 8) | payload[1]) * 0x10000;
        break;
      case 0x05:
        expectLength(length, 4, lineNo);
        entryPoint = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
        break;
      default:
        throw new HexError('record-type', lineNo, `Unbekannter Datensatztyp ${hex2(type)}. ${DAMAGED}`);
    }
  }

  if (!sawRecord) throw new HexError('empty', 0, 'Die Datei ist leer. Lade sie bitte neu herunter.');
  if (!eof) {
    throw new HexError('no-eof', lines.length, 'Die Datei ist unvollständig, das Ende fehlt. Lade sie bitte neu herunter.');
  }
  if (chunks.length === 0) throw new HexError('empty', 0, 'Die Datei enthält keine Firmware-Daten. Lade sie bitte neu herunter.');

  const data = new Uint8Array(high - low).fill(0xff);
  const used = new Uint8Array(high - low);
  for (const c of chunks) {
    data.set(c.bytes, c.address - low);
    used.fill(1, c.address - low, c.address - low + c.bytes.length);
  }
  let byteCount = 0;
  for (const u of used) byteCount += u;

  const image: HexImage = { data, startAddress: low, byteCount };
  if (entryPoint !== undefined) image.entryPoint = entryPoint;
  return image;
}

/** Encodes bytes as Intel HEX (data records of `perLine` bytes, extended linear addresses as needed). */
export function toIntelHex(data: Uint8Array, startAddress = 0, perLine = 16): string {
  const out: string[] = [];
  let upper = -1;
  for (let i = 0; i < data.length; ) {
    const address = startAddress + i;
    if (address >>> 16 !== upper) {
      upper = address >>> 16;
      out.push(record(0x04, 0, Uint8Array.of(upper >> 8, upper & 0xff)));
    }
    // Do not let one record cross a 64 KiB boundary.
    const n = Math.min(perLine, data.length - i, 0x10000 - (address & 0xffff));
    out.push(record(0x00, address & 0xffff, data.subarray(i, i + n)));
    i += n;
  }
  out.push(':00000001FF');
  return out.join('\n') + '\n';
}

function record(type: number, offset: number, payload: Uint8Array): string {
  const bytes = [payload.length, offset >> 8, offset & 0xff, type, ...payload];
  const sum = bytes.reduce((a, b) => a + b, 0);
  bytes.push((0x100 - (sum & 0xff)) & 0xff);
  return ':' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function expectLength(length: number, expected: number, lineNo: number): void {
  if (length !== expected) {
    throw new HexError('address-record', lineNo, `Ungültiger Adress-Datensatz. ${DAMAGED}`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hex2(n: number): string {
  return '0x' + n.toString(16).padStart(2, '0').toUpperCase();
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}
