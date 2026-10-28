/**
 * "Nummer auf der Packung" (TODO #120, sticker audit #12): many people know their paper only by the
 * number on the pack. This finds the paper the app has for such a number.
 *
 * Only numbers whose size the maker publishes are here (sources in the comments); a number the app
 * knows without a matching paper says what is known and leads to "Eigene Größe", any other number too.
 */

export interface PackCode {
  /** The numbers as printed on the pack, without the pack size ("L4775-20" is "L4775"). */
  codes: readonly string[];
  maker: string;
  /** The paper the app has for it; missing: known, but no paper of the app fits (see note). */
  templateId?: string;
  /** German: what it is, in a few words. */
  what: string;
  /** German: why there is no paper for it, or what to mind with the one there is. */
  note?: string;
}

export const PACK_CODES: readonly PackCode[] = [
  // The TonUINO classic; geometry as in the TonUINO Card Creator (templates.ts).
  { codes: ['5028'], maker: 'HERMA', templateId: 'herma-5028', what: 'Etiketten 83,8 × 50,8 mm, 10 pro Bogen' },
  // avery-zweckform.com, products J4775-10 and L4775-8/-20/-100: "Wetterfeste Etiketten", 210 x 297 mm,
  // 1 label per sheet, PVC-free white film; J4775 for inkjet, L4775 for laser.
  {
    codes: ['J4775'],
    maker: 'Avery Zweckform',
    templateId: 'film-a4',
    what: 'Wetterfeste Folie A4 für Tintenstrahl, ein ganzer Bogen',
  },
  { codes: ['L4775'], maker: 'Avery Zweckform', templateId: 'film-a4', what: 'Wetterfeste Folie A4 für Laser, ein ganzer Bogen' },
  // avery.co.uk, L7917-10: "Resistant Waterproof Labels, 210 x 297 mm, Laser", 1 label per sheet.
  { codes: ['L7917'], maker: 'Avery', templateId: 'film-a4', what: 'Wasserfeste Folie A4 für Laser, ein ganzer Bogen' },
  // herma.com, 5065: "Etiketten Premium A4, 210x297 mm", paper, 1 label per sheet.
  { codes: ['5065'], maker: 'HERMA', templateId: 'card-a4', what: 'Etikettenpapier A4, ein ganzer Bogen' },
  // Canon SELPHY credit card size labels (templates.ts).
  { codes: ['KC-18IF', 'KC18IF'], maker: 'Canon', templateId: 'selphy-card', what: 'SELPHY-Etiketten im Kreditkartenformat' },
  // avery-zweckform.com, 3490: "Universal-Etiketten, 70 x 36 mm", 24 per A4 sheet. Where they sit on the
  // sheet is only in the maker's drawing, not in its text, so there is no paper for them yet.
  {
    codes: ['3490'],
    maker: 'Avery Zweckform',
    what: 'Etiketten 70 × 36 mm, 24 pro Bogen',
    note: 'Sie sind kleiner als die Karte (85,6 × 54 mm). Wo sie genau auf dem Bogen sitzen, weiß ich noch nicht. Miss den Bogen aus und gib ihn unter „Eigene Größe“ ein.',
  },
];

/** What a number on the pack leads to. */
export type PackMatch = { kind: 'found'; entry: PackCode; templateId: string } | { kind: 'known'; entry: PackCode } | { kind: 'unknown' } | { kind: 'partial' } | { kind: 'empty' };

/** "Avery Zweckform L4775-20" and "l 4775" both read as "L4775". */
export function normalizePackCode(input: string): string {
  let s = input.toUpperCase().replace(/\s+/g, ' ').trim();
  // Makers' names and "Nr." in front, in any order ("HERMA Nr. 5028").
  for (let before = ''; before !== s; ) {
    before = s;
    s = s.replace(/^(?:AVERY|ZWECKFORM|HERMA|CANON|ART\.?-?NR\.?|NR\.?)(?:\s+|(?=\d))/, '');
  }
  s = s.replace(/[\s.]/g, '');
  // The pack size behind the number: L4775-20, 5028-100. Not KC-18IF, whose dash is part of it.
  s = s.replace(/^([A-Z]?\d{3,5})-\d{1,3}$/, '$1');
  return s;
}

const normalizedCodes = (e: PackCode) => e.codes.map((c) => c.toUpperCase().replace(/[\s.]/g, ''));

export function findPaperByCode(input: string): PackMatch {
  const code = normalizePackCode(input);
  if (!code) return { kind: 'empty' };
  const entry = PACK_CODES.find((e) => normalizedCodes(e).includes(code));
  // Still typing a number the app knows: no "kenne ich nicht" after the first digits.
  if (!entry) return PACK_CODES.some((e) => normalizedCodes(e).some((c) => c.startsWith(code))) ? { kind: 'partial' } : { kind: 'unknown' };
  return entry.templateId ? { kind: 'found', entry, templateId: entry.templateId } : { kind: 'known', entry };
}
