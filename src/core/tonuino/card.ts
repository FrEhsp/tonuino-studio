/**
 * TonUINO RFID card format, as implemented by TonUINO-TNG (src/chip_card.cpp)
 * and TonUINO 2.1.
 *
 * MIFARE Classic: sector 1, block 4, key A = FF FF FF FF FF FF.
 * MIFARE Ultralight / NTAG21x: pages 8-11.
 *
 *   bytes 0-3  cookie 13 37 B3 47
 *   byte  4    version (2)
 *   byte  5    folder 1-99, 0 = modifier or admin card
 *   byte  6    mode
 *   byte  7    special
 *   byte  8    special2
 *   bytes 9-15 zero
 */

export const CARD_COOKIE = [0x13, 0x37, 0xb3, 0x47] as const;
export const CARD_VERSION = 2;
export const ADMIN_MODE = 0xff;

export type FirmwareProfile = 'tng' | 'classic21';

export interface CardData {
  folder: number;
  mode: number;
  special: number;
  special2: number;
  version?: number;
}

export type DecodedCard =
  | { kind: 'empty' }
  | { kind: 'foreign'; bytes: Uint8Array }
  | { kind: 'bad-version'; version: number; bytes: Uint8Array }
  | { kind: 'tonuino'; data: Required<CardData> };

export function encodeCard(card: CardData): Uint8Array {
  const out = new Uint8Array(16);
  out.set(CARD_COOKIE, 0);
  out[4] = card.version ?? CARD_VERSION;
  out[5] = clampByte(card.folder);
  out[6] = clampByte(card.mode);
  out[7] = clampByte(card.special);
  out[8] = clampByte(card.special2);
  return out;
}

export function decodeCard(bytes: Uint8Array): DecodedCard {
  if (bytes.length < 9) return { kind: 'foreign', bytes };
  const cookieZero = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
  if (cookieZero) return { kind: 'empty' };
  const isTonuino = CARD_COOKIE.every((b, i) => bytes[i] === b);
  if (!isTonuino) return { kind: 'foreign', bytes };
  const version = bytes[4];
  // TNG accepts versions 1 and 2 and ignores everything else ("bad ver").
  if (version < 1 || version > 2) return { kind: 'bad-version', version, bytes };
  return {
    kind: 'tonuino',
    data: { version, folder: bytes[5], mode: bytes[6], special: bytes[7], special2: bytes[8] },
  };
}

export function cardToHex(card: CardData, length: 9 | 16 = 9): string {
  return [...encodeCard(card).subarray(0, length)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One line for the "TonUINO NFC Tools" Android app (Liste eingeben / QR-Code
 * lesen). The app splits on ";" or " ": the first part is hex, the rest is
 * shown as the title.
 */
export function cardToQrLine(card: CardData, title: string): string {
  const clean = title.replace(/[\r\n]+/g, ' ').trim();
  return clean ? `${cardToHex(card)};${clean}` : cardToHex(card);
}

/**
 * Most bytes per QR code. Up to here a code stays at version 20 (97 × 97
 * modules at error correction M), which a phone still reads off a screen or a
 * small print; a full code holds about 2300 bytes but is hard to scan.
 */
export const QR_MAX_BYTES = 600;

/**
 * Splits cards into QR codes of at most `perCode` cards and `maxBytes`
 * bytes (UTF-8, lines joined with "\n"). A card longer than that gets a code
 * of its own.
 */
export function qrGroups<T>(items: T[], lineOf: (item: T) => string, perCode: number, maxBytes = QR_MAX_BYTES): T[][] {
  const encoder = new TextEncoder();
  const out: T[][] = [];
  let group: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = encoder.encode(lineOf(item)).length;
    if (group.length && (group.length >= perCode || bytes + 1 + size > maxBytes)) {
      out.push(group);
      group = [];
    }
    bytes = group.length ? bytes + 1 + size : size;
    group.push(item);
  }
  if (group.length) out.push(group);
  return out;
}

/** Several cards in one QR code, as Tonuino Cards Manager does (4 per code by default). */
export function qrPayloads(lines: string[], perCode = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += perCode) out.push(lines.slice(i, i + perCode).join('\n'));
  return out;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}
