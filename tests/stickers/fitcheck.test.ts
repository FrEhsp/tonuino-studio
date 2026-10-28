/**
 * "Sitzt es?" (TODO #128): a white strip at one edge of the printed stickers moves the next print that
 * far, through the printer correction, which is now kept per printer; the question comes once per
 * printer and paper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calibrationKey, type CalibrationStore } from '../../src/core/stickers/calibration';
import { correctionFor, describeShift, fitKey, movesPrint } from '../../src/core/stickers/fitcheck';
import { getTemplate } from '../../src/core/stickers/templates';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('correctionFor', () => {
  it('moves the print into the white strip', () => {
    expect(correctionFor(null, { vertical: { side: 'top', mm: 1.5 } })).toEqual({ offsetXMm: 0, offsetYMm: -1.5 });
    expect(correctionFor(null, { vertical: { side: 'bottom', mm: 1 } })).toEqual({ offsetXMm: 0, offsetYMm: 1 });
    expect(correctionFor(null, { horizontal: { side: 'left', mm: 0.5 } })).toEqual({ offsetXMm: -0.5, offsetYMm: 0 });
    expect(correctionFor(null, { horizontal: { side: 'right', mm: 2 } })).toEqual({ offsetXMm: 2, offsetYMm: 0 });
  });

  it('adds to the correction the print was made with and keeps its size', () => {
    const now = { offsetXMm: 0.3, offsetYMm: -0.7, scaleX: 1.004, scaleY: 1 };
    expect(correctionFor(now, { vertical: { side: 'bottom', mm: 0.5 }, horizontal: { side: 'left', mm: 1 } })).toEqual({ offsetXMm: -0.7, offsetYMm: -0.2, scaleX: 1.004 });
    expect(correctionFor({ offsetXMm: 1, offsetYMm: 0 }, { horizontal: { side: 'left', mm: 1 } })).toEqual({ offsetXMm: 0, offsetYMm: 0 });
  });

  it('ignores widths that are no widths', () => {
    expect(correctionFor(null, { vertical: { side: 'top', mm: Number.NaN }, horizontal: { side: 'right', mm: -2 } })).toEqual({ offsetXMm: 0, offsetYMm: 0 });
  });
});

describe('what the dialog says', () => {
  it('tells where the print moves, in plain words', () => {
    // Number and unit stay on one line (a no-break space between them).
    const say = (a: Parameters<typeof describeShift>[0]) => describeShift(a).replace(/\u00a0/g, ' ');
    expect(describeShift({ vertical: { side: 'top', mm: 1 } })).toContain('1\u00a0mm');
    expect(say({ vertical: { side: 'top', mm: 1.5 }, horizontal: { side: 'left', mm: 0.5 } })).toBe('Ich rücke den Druck 1,5 mm nach oben und 0,5 mm nach links.');
    expect(say({ horizontal: { side: 'right', mm: 2 } })).toBe('Ich rücke den Druck 2 mm nach rechts.');
    expect(describeShift({})).toBe('');
    expect(movesPrint({})).toBe(false);
    expect(movesPrint({ vertical: { side: 'bottom', mm: 0.5 } })).toBe(true);
  });

  it('counts a printer the same however its name is spaced or written', () => {
    expect(fitKey(' Brother  MFC ', 'herma-5028')).toBe(fitKey('brother mfc', 'herma-5028'));
    expect(fitKey('', 'x')).toBe('standard::x');
  });
});

describe('the correction per printer', () => {
  it('uses a printer’s own correction, else the one without a printer from before 0.6', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const { calibrationOf } = await import('../../src/features/stickers/design');
    const store: CalibrationStore = {
      [calibrationKey('standard', 'herma-5028')]: { offsetXMm: 1, offsetYMm: 0 },
      [calibrationKey('Brother', 'herma-5028')]: { offsetXMm: 0, offsetYMm: -2 },
      [calibrationKey('Canon', '*')]: { offsetXMm: 0.5, offsetYMm: 0.5 },
    };
    expect(calibrationOf(store, 'Brother', 'herma-5028')).toEqual({ offsetXMm: 0, offsetYMm: -2 });
    expect(calibrationOf(store, 'Epson', 'herma-5028')).toEqual({ offsetXMm: 1, offsetYMm: 0 });
    expect(calibrationOf(store, 'Canon', 'herma-5028')).toEqual({ offsetXMm: 0.5, offsetYMm: 0.5 });
    expect(calibrationOf(store, 'Epson', 'avery-l7165')).toEqual({ offsetXMm: 0, offsetYMm: 0 });
  });

  it('keeps "no correction" for a printer where an old one without a printer would else come back', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const { calibrationOf, storeCalibration } = await import('../../src/features/stickers/design');
    const old: CalibrationStore = { [calibrationKey('standard', 'herma-5028')]: { offsetXMm: 1, offsetYMm: 0 } };
    const reset = storeCalibration(old, 'Brother', 'herma-5028', { offsetXMm: 0, offsetYMm: 0 });
    expect(calibrationOf(reset, 'Brother', 'herma-5028')).toEqual({ offsetXMm: 0, offsetYMm: 0 });
    expect(calibrationOf(reset, 'Epson', 'herma-5028')).toEqual({ offsetXMm: 1, offsetYMm: 0 });
    expect(storeCalibration({}, 'Brother', 'herma-5028', { offsetXMm: 0, offsetYMm: 0 })).toEqual({});
    expect(storeCalibration(old, 'standard', 'herma-5028', { offsetXMm: 0, offsetYMm: 0 })).toEqual({});
  });

  it('saves for the printer chosen in the print dialog, and the next print reads that one', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const design = await import('../../src/features/stickers/design');
    const printers = await import('../../src/features/stickers/printers');
    const id = design.template.value.id;
    expect(printers.activePrinter.value).toBe('standard');
    design.saveCalibration(id, { offsetXMm: 1, offsetYMm: 0 });
    printers.storePrinter('Brother_MFC_J5320DW');
    expect(design.calibration.value).toEqual({ offsetXMm: 1, offsetYMm: 0 });
    design.saveCalibration(id, { offsetXMm: 0, offsetYMm: -1.5 });
    expect(design.calibration.value).toEqual({ offsetXMm: 0, offsetYMm: -1.5 });
    printers.storePrinter('PDF');
    expect(design.calibration.value).toEqual({ offsetXMm: 1, offsetYMm: 0 });
    expect(storage.getItem('tonuino-studio:drucker')).toBe('PDF');
    expect(JSON.parse(storage.getItem('tonuino-studio:calibration')!)).toEqual({
      [calibrationKey('standard', id)]: { offsetXMm: 1, offsetYMm: 0 },
      [calibrationKey('Brother_MFC_J5320DW', id)]: { offsetXMm: 0, offsetYMm: -1.5 },
    });
  });

  it('starts with the printer chosen last time', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'tonuino-studio:drucker': 'Brother' }));
    const { activePrinter } = await import('../../src/features/stickers/printers');
    expect(activePrinter.value).toBe('Brother');
  });
});

describe('when the question comes', () => {
  it('asks after the first print of a sheet on a printer, and not again', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'tonuino-studio:drucker': 'Brother' }));
    const { fitQuestionAfterPrint, fitQuestion, markFitAsked } = await import('../../src/features/stickers/FitCheckDialog');
    const { storePrinter } = await import('../../src/features/stickers/printers');
    const sheet = getTemplate('herma-5028')!;
    const q = fitQuestionAfterPrint(sheet);
    expect(q).toEqual({ templateId: 'herma-5028', templateName: sheet.name, printer: 'Brother' });
    markFitAsked(q!);
    expect(fitQuestionAfterPrint(sheet)).toBeNull();
    // Asked on purpose it comes any time.
    expect(fitQuestion(sheet)).toEqual(q);
    storePrinter('Canon');
    expect(fitQuestionAfterPrint(sheet)?.printer).toBe('Canon');
  });

  it('does not ask for prints from a photo service', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const { fitQuestionAfterPrint } = await import('../../src/features/stickers/FitCheckDialog');
    const { BUILTIN_TEMPLATES } = await import('../../src/core/stickers/templates');
    const photo = BUILTIN_TEMPLATES.find((t) => t.output !== 'pdf');
    expect(photo).toBeDefined();
    expect(fitQuestionAfterPrint(photo!)).toBeNull();
  });
});
