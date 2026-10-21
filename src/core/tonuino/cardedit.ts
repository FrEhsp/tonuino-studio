/**
 * Cards made by hand: copying a card that was read, changing it, a folder
 * card for a folder number the open SD card does not have, and the
 * tinkerer's view of the raw numbers and bytes (as in TonUINO NFC Tools,
 * "Erweitert" and "Bytes"). Also the old card format of TonUINO 2.0
 * (version 1), which NFC Tools offers as "Format 1".
 */
import { ADMIN_MODE, CARD_COOKIE, CARD_VERSION, decodeCard, encodeCard, type CardData, type FirmwareProfile } from './card';
import { FORMAT20_MODES, modeByCode, modifiersFor, sleepMaxMinutes, sleepMinutesOf } from './modes';
import { MAX_FOLDER } from './sd';

/** A card with every byte known, the version included. */
export type FullCard = Required<CardData>;

/** The five numbers NFC Tools calls Version, Ordner, Modus, Extra 1 and Extra 2. */
export const RAW_FIELDS = ['version', 'folder', 'mode', 'special', 'special2'] as const;
export type RawField = (typeof RAW_FIELDS)[number];

export const RAW_LABELS: Record<RawField, string> = {
  version: 'Version',
  folder: 'Ordner',
  mode: 'Modus',
  special: 'Extra 1',
  special2: 'Extra 2',
};

/** A card with its version filled in (2 unless it says otherwise). */
export function fullCard(card: CardData): FullCard {
  return { version: card.version ?? CARD_VERSION, folder: card.folder, mode: card.mode, special: card.special, special2: card.special2 };
}

/** The data to store or write: version 2 is the default and left out. */
export function storedCard(card: FullCard): CardData {
  const out: CardData = { folder: card.folder, mode: card.mode, special: card.special, special2: card.special2 };
  if (card.version !== CARD_VERSION) out.version = card.version;
  return out;
}

/** A field's value from what was typed: whole numbers 0 to 255, else undefined. */
export function rawValue(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 255 ? n : undefined;
}

/** Every number field as typed holds a byte; one that does not keeps the card from going on the list. */
export function rawTextsValid(texts: Readonly<Record<RawField, string>>): boolean {
  return RAW_FIELDS.every((f) => rawValue(texts[f]) !== undefined);
}

/** A folder number as typed: 1 to 99 in digits, else undefined (0, 100, empty, "7.5"). */
export function folderNumberOf(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d{1,2}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= MAX_FOLDER ? n : undefined;
}

/** The 16 bytes of a card as hex, two digits each, with spaces: "13 37 b3 47 02 05 05 00 00 00 …". */
export function cardBytesText(card: CardData, length: 9 | 16 = 16): string {
  return [...encodeCard(card).subarray(0, length)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

export type HexParse = { ok: true; card: FullCard } | { ok: false; message: string };

/**
 * Reads a line of hex bytes, as NFC Tools and the QR lists write them
 * ("1337b34702050500 00" or with spaces or colons). At least the first nine
 * bytes (cookie, version, folder, mode, Extra 1, Extra 2); the rest of the
 * sixteen must be zero, since the app writes zeros there. The cookie has to
 * be TonUINO's, otherwise the box does not take the card.
 */
export function parseCardHex(text: string): HexParse {
  const clean = text.replace(/0x/gi, '').replace(/[\s:,;-]+/g, '');
  if (!clean) return { ok: false, message: 'Gib die Bytes als Hex-Zahlen ein, zum Beispiel 13 37 b3 47 02 05 05 00 00.' };
  if (!/^[0-9a-f]+$/i.test(clean)) return { ok: false, message: 'Erlaubt sind nur die Ziffern 0 bis 9 und die Buchstaben a bis f.' };
  if (clean.length % 2) return { ok: false, message: 'Jedes Byte hat zwei Zeichen. Eins ist zu viel oder fehlt.' };
  const bytes = clean.match(/../g)!.map((h) => parseInt(h, 16));
  if (bytes.length < 9) return { ok: false, message: 'Es fehlen Bytes. Eine Karte braucht mindestens neun: Kennung (4), Version, Ordner, Modus, Extra 1 und Extra 2.' };
  if (bytes.length > 16) return { ok: false, message: 'Auf die Karte passen nur 16 Bytes.' };
  if (!CARD_COOKIE.every((b, i) => bytes[i] === b)) return { ok: false, message: 'Die ersten vier Bytes müssen 13 37 b3 47 sein. Nur daran erkennt die Box ihre Karten.' };
  if (bytes.slice(9).some((b) => b !== 0)) return { ok: false, message: 'Nach den ersten neun Bytes schreibe ich nur Nullen. Lasse die übrigen Bytes weg oder setze sie auf 00.' };
  return { ok: true, card: { version: bytes[4], folder: bytes[5], mode: bytes[6], special: bytes[7], special2: bytes[8] } };
}

/** A card read from the reader as one to copy or change; undefined for empty or foreign cards. */
export function cardFromBytes(bytes: Uint8Array): FullCard | undefined {
  const d = decodeCard(bytes);
  if (d.kind === 'tonuino') return d.data;
  if (d.kind === 'bad-version' && bytes.length >= 9) return { version: d.version, folder: bytes[5], mode: bytes[6], special: bytes[7], special2: bytes[8] };
  return undefined;
}

/** Sixteen zero bytes: a card the box treats as new ("Karte löschen"). */
export function emptyCardBytes(): Uint8Array {
  return new Uint8Array(16);
}

/** True for a card that plays a folder (1 to 99); false for special cards, the admin card and "Wiederholen". */
export function isFolderCard(card: CardData): boolean {
  return card.folder >= 1 && card.folder <= MAX_FOLDER && card.mode !== 11 && card.mode !== 14;
}

/**
 * What a box with this firmware will do with the raw card, in plain German,
 * worst first. Empty when it looks like a card the box knows. TNG reads
 * version 1 and 2; TonUINO 2.0 knows only format 1 and no special cards.
 */
export function rawCardProblems(card: FullCard, profile: FirmwareProfile): string[] {
  const out: string[] = [];
  if (card.version !== 1 && card.version !== 2) out.push(`Version ${card.version} kennt keine TonUINO-Box. Sie ignoriert die Karte.`);
  if (card.version === 1 && (card.folder === 0 || !FORMAT20_MODES.includes(card.mode))) {
    out.push('Im Kartenformat für TonUINO 2.0 gibt es nur Ordnerkarten mit den Modi 1 bis 5 und 7 bis 9.');
  }
  if (card.folder === 0) {
    if (card.mode !== ADMIN_MODE && !modifiersFor(profile).some((m) => m.code === card.mode)) out.push(`Eine Spezialkarte mit Modus ${card.mode} kennt die Box nicht.`);
    const sleep = modifiersFor(profile).find((m) => m.code === card.mode && m.params === 'sleep');
    if (sleep && sleepMinutesOf(card, profile) === 0) out.push('Eine Schlummerkarte mit 0 Minuten schaltet sofort ab.');
  } else if (card.folder > MAX_FOLDER && card.mode !== 11 && card.mode !== 14) {
    out.push(`Ordner ${card.folder} gibt es auf keiner SD-Karte. Erlaubt sind 1 bis ${MAX_FOLDER}.`);
  } else if (card.folder !== 0 && !modeByCode(card.mode)) {
    out.push(`Modus ${card.mode} kennt die Box nicht.`);
  }
  return out;
}

/** Whether minutes fit on a Schlummerkarte of this firmware: 1 to 127 (TNG) or 255 (2.1). */
export function sleepMinutesProblem(minutes: number, profile: FirmwareProfile): string | undefined {
  const max = sleepMaxMinutes(profile);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > max) return `Gib eine ganze Zahl von 1 bis ${max} Minuten ein.`;
  return undefined;
}
