/**
 * "Liste einfügen": cards pasted as text, one per line, in the bulk format of
 * TonUINO NFC Tools ("HEX;Titel"). Studio writes it for the phone (see
 * cardToQrLine), and so do Tonuino Cards Manager, the TTS-Editor and the
 * Exceltool. Lines copied by hand vary: CRLF, spaces in and around the bytes,
 * a tab from a spreadsheet instead of ";", or no title at all.
 */
import type { FirmwareProfile } from './card';
import { parseCardHex, rawCardProblems, type FullCard } from './cardedit';
import { checkCardAgainstSd, describeCard, modeByCode } from './modes';
import { folderName, MAX_FOLDER } from './sd';

export interface PastedCard {
  /** Line number in the pasted text, from 1. */
  line: number;
  /** The title after the bytes; empty when the line has none. */
  title: string;
  /** The card, when the line holds one the box can read. */
  card?: FullCard;
  /** What the card does, in one sentence (as "Karte prüfen" says it). */
  says?: string;
  /** Why the line is no card to write. */
  problem?: string;
  /** What a box with this firmware will make of the card, when it is not quite right. */
  warnings: string[];
}

/** A byte group in a line without ";": hex digits, maybe "0x" or ":" and "-" inside. */
const HEX_TOKEN = /^(?:0x)?[0-9a-f]+(?:[:.-](?:0x)?[0-9a-f]+)*[:.-]?$/i;

/**
 * Splits a line into the bytes and the title. With ";" (or a tab, from a
 * spreadsheet) the split is there. Without, NFC Tools splits at the first
 * space; here the bytes may hold spaces too ("13 37 b3 47 …"), so groups of
 * hex count as bytes until nine are there. After that only zeros do, since a
 * title like "Abba" or "Cafe" is hex as well.
 */
export function splitCardLine(text: string): { hex: string; title: string } {
  const line = text.replace(/^﻿/, '').trim();
  const cut = line.search(/[;\t]/);
  if (cut >= 0) return { hex: line.slice(0, cut).trim(), title: line.slice(cut + 1).replace(/^[;\t\s]+/, '').trim() };
  let digits = 0;
  let end = 0;
  for (const m of line.matchAll(/[^\s,]+/g)) {
    const token = m[0];
    if (!HEX_TOKEN.test(token)) break;
    const n = token.replace(/0x/gi, '').replace(/[:.-]/g, '').length;
    if (digits >= 18 && (!/^[0:.-]+$/.test(token.replace(/0x/gi, '')) || digits + n > 32)) break;
    digits += n;
    end = m.index! + token.length;
  }
  return { hex: line.slice(0, end).trim(), title: line.slice(end).replace(/^[\s,]+/, '').trim() };
}

/**
 * Reads every line of the pasted text. Blank lines are skipped; every other
 * line gives a card or says why it is none. `folderTitle` names the folders
 * the open SD card knows, as "Karte prüfen" does; with `trackCount` (an SD
 * card is open) a folder or track it lacks is warned of, as the list of
 * cards does later.
 */
export function parsePastedCards(
  text: string,
  profile: FirmwareProfile,
  folderTitle?: (folder: number) => string | undefined,
  trackCount?: (folder: number) => number | undefined,
): PastedCard[] {
  const out: PastedCard[] = [];
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    if (!raw.replace(/^﻿/, '').trim()) return;
    const { hex, title } = splitCardLine(raw);
    const row: PastedCard = { line: i + 1, title, warnings: [] };
    out.push(row);
    if (!hex) {
      row.problem = 'Am Anfang der Zeile stehen keine Bytes.';
      return;
    }
    const parsed = parseCardHex(hex);
    if (!parsed.ok) {
      row.problem = parsed.message;
      return;
    }
    const card = parsed.card;
    // Box and app read only versions 1 and 2; any other card is ignored by the box.
    if (card.version !== 1 && card.version !== 2) {
      row.problem = `Version ${card.version} kennt keine TonUINO-Box.`;
      return;
    }
    row.card = card;
    const named = card.folder ? folderTitle?.(card.folder) : undefined;
    const says = describeCard(card, profile);
    row.says = (named ? `${says.replace(/\.$/, '')} („${named}“).` : says) + (card.version === 1 ? ' Im Kartenformat für TonUINO 2.0.' : '');
    const sd = trackCount && card.folder >= 1 && card.folder <= MAX_FOLDER ? checkCardAgainstSd(card, trackCount) : tracksProblems(card);
    row.warnings = [...new Set([...rawCardProblems(card, profile), ...sd])];
  });
  return out;
}

/** Without an SD card: a track 0 or a range that runs backwards no box can play. */
function tracksProblems(card: FullCard): string[] {
  if (card.folder < 1 || card.folder > MAX_FOLDER) return [];
  const params = modeByCode(card.mode)?.params;
  if (params === 'track' && card.special < 1) return [`Titel ${card.special} gibt es nicht: Die Titel zählen ab 1.`];
  if (params === 'range' && (card.special < 1 || card.special2 < card.special)) return ['Der Bereich von … bis … ist ungültig.'];
  return [];
}

/**
 * The name a pasted card gets in the list: its title from the line. Studio's
 * own "Liste kopieren" puts the folder in front ("Abbey Road · Titel 3"), as
 * the list shows a further card of a folder; that part comes off, the list
 * adds the folder again.
 */
export function pastedLabel(title: string, folder: number, folderTitle?: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  for (const name of [folderTitle?.trim(), `Ordner ${folderName(folder)}`]) {
    if (name && t.startsWith(`${name} · `) && t.length > name.length + 3) return t.slice(name.length + 3).trim();
  }
  return t;
}
