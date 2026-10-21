import { describe, expect, it } from 'vitest';
import { READ_CRASH_SHEET_NOTE } from '../../src/core/tonuino/androidapp';
import type { CardData } from '../../src/core/tonuino/card';
import { toWinAnsi } from '../../src/core/stickers/calibration';
import { fitSheetLine, qrSheetPdf, type QrCard } from '../../src/features/cards/qrsheet';

const card = (title: string, mode: number, folder = 1): QrCard => ({ title, data: { folder, mode, special: 1, special2: 3 } satisfies CardData });

/** The PDF's text, as jsPDF writes it uncompressed: each string in brackets. */
async function pdfText(groups: QrCard[][], opts?: Parameters<typeof qrSheetPdf>[1]): Promise<string> {
  const blob = await qrSheetPdf(groups, opts);
  return new TextDecoder('latin1').decode(await blob.arrayBuffer());
}

describe('qrSheetPdf', () => {
  it('stars the cards the phone app cannot read back and says why on the sheet', async () => {
    const text = await pdfText([[card('Bibi', 2), card('Drei Buecher', 16)]]);
    expect(text).toContain('(1. Bibi)');
    expect(text).toContain('(2. Drei Buecher *)');
    // jsPDF may break the note into lines, so look for its start.
    expect(text).toContain(toWinAnsi(READ_CRASH_SHEET_NOTE).slice(0, 40));
  });

  it('a sheet without such cards has no star and no note', async () => {
    const text = await pdfText([[card('Bibi', 2), card('Album', 2, 3)]]);
    expect(text).not.toContain(' *)');
    expect(text).not.toContain('nicht auslesen');
  });

  it('a star on a card that is cut from the list goes on the "weitere" line', async () => {
    const many = Array.from({ length: 9 }, (_, i) => card(`Karte ${i + 1}`, 2));
    many[8] = card('Teil 3', 16);
    const text = await pdfText([many]);
    expect(text).toMatch(/weitere Karten \*\)/);
  });

  it('says at the top how to write the cards, with the box and the day', async () => {
    const one = await pdfText([[card('Bibi', 2)]], { boxName: 'Emmas Box', date: new Date(2026, 9, 9) });
    expect(one).toContain('Liste eingeben');
    expect(one).toContain('Abarbeiten starten');
    expect(one).toContain('Emmas Box');
    expect(one).toContain('2026');
    // PDF strings escape their brackets.
    expect(one).toContain('TonUINO NFC Tools \\(F-Droid\\)');
    // One code: nothing about the next one.
    expect(one).not.toContain('Startbildschirm');
    const two = await pdfText([[card('Bibi', 2)], [card('Benjamin', 2)]]);
    expect(two).toContain('Startbildschirm');
    expect(two).toContain('(von 2)');
  });

  it('puts four codes on the first page and six on the next ones', async () => {
    const groups = Array.from({ length: 11 }, (_, i) => [card(`Karte ${i + 1}`, 2)]);
    const blob = await qrSheetPdf(groups);
    const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(3);
  });
});

describe('fitSheetLine', () => {
  const len = (t: string) => t.length;
  const extra = (folder: string, label: string) => ({ title: `${folder} · ${label}`, extra: { label } });

  it('shortens the folder of a further card and keeps its own name', () => {
    expect(fitSheetLine('1. ', extra('Bibi Blocksberg – Hexen-Hörbuch', 'Das Hexenfest'), 40, len)).toBe('1. Bibi Blocksberg… · Das Hexenfest');
    // Lines of the same folder still differ.
    expect(fitSheetLine('2. ', extra('Bibi Blocksberg – Hexen-Hörbuch', 'Der Wetterzauber'), 40, len)).toBe('2. Bibi Blocksberg… · Der Wetterzauber');
  });

  it('cuts the name itself only when it alone is too long', () => {
    expect(fitSheetLine('1. ', extra('Bibi', 'Ein sehr, sehr langer Name für eine Karte'), 20, len)).toBe('1. Ein sehr, sehr…');
  });

  it('ends any other cut line on "…", and leaves short lines alone', () => {
    expect(fitSheetLine('3. ', { title: 'Die unendliche Geschichte vom kleinen Drachen' }, 20, len)).toBe('3. Die unendliche…');
    expect(fitSheetLine('3. ', extra('Bibi', 'Hexenfest'), 40, len)).toBe('3. Bibi · Hexenfest');
  });
});
