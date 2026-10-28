import { afterEach, describe, expect, it, vi } from 'vitest';
import { slotRects } from '../../src/core/stickers/slots';
import {
  cleanCustomParams,
  EMPTY_FORM,
  formFromParams,
  ownTemplateOf,
  parseCount,
  parseLength,
  templateFromForm,
  type OwnSizeForm,
} from '../../src/features/stickers/customSize';

const form = (patch: Partial<OwnSizeForm>): OwnSizeForm => ({ ...EMPTY_FORM, ...patch });

function built(f: OwnSizeForm) {
  const r = templateFromForm(f);
  if (!('template' in r)) throw new Error(r.problem);
  return r;
}

function problem(f: OwnSizeForm): string {
  const r = templateFromForm(f);
  if ('template' in r) throw new Error(`expected a problem, got ${r.template.id}`);
  return r.problem;
}

describe('parsing the fields', () => {
  it('reads millimetres with comma or point', () => {
    expect(parseLength('82')).toBe(82);
    expect(parseLength('82,5')).toBe(82.5);
    expect(parseLength(' 82.5 mm ')).toBe(82.5);
    expect(parseLength(',5')).toBe(0.5);
    expect(parseLength('')).toBeUndefined();
    expect(parseLength('  ')).toBeUndefined();
    expect(parseLength('abc')).toBeNaN();
    expect(parseLength('-3')).toBeNaN();
    expect(parseLength('1,2,3')).toBeNaN();
  });

  it('reads whole numbers from 1 for columns and rows', () => {
    expect(parseCount('3')).toBe(3);
    expect(parseCount('')).toBeUndefined();
    expect(parseCount('0')).toBeNaN();
    expect(parseCount('2,5')).toBeNaN();
  });
});

describe('templateFromForm', () => {
  it('asks for the size first, without a warning', () => {
    expect(templateFromForm(EMPTY_FORM)).toEqual({ problem: 'Gib Breite und Höhe eines Etiketts in Millimetern ein.', empty: true });
    expect(templateFromForm(form({ shape: 'round' }))).toEqual({ problem: 'Gib den Durchmesser in Millimetern ein.', empty: true });
  });

  it('makes single pictures for a photo service', () => {
    const { template: t, params } = built(form({ paper: 'photo', width: '82', height: '57', cols: '4', marginLeft: '9' }));
    expect(t).toMatchObject({ id: 'custom-82x57-1x1-bilder', kind: 'single', output: 'images', defaultBleedMm: 0, verified: true });
    expect(t.page).toEqual({ widthMm: 82, heightMm: 57 });
    expect(t.safeMarginMm).toBe(4.5);
    // Sheet fields do not apply to single pictures.
    expect(params).toEqual({ labelWidthMm: 82, labelHeightMm: 57, shape: 'rect', kind: 'single', output: 'images' });
  });

  it('places a die-cut sheet as measured', () => {
    const { template: t } = built(form({ paper: 'sheet', width: '70', height: '37', cols: '3', rows: '8', marginLeft: '0', marginTop: '0,5' }));
    expect(t.kind).toBe('die-cut');
    expect(t.grid).toEqual({ cols: 3, rows: 8, marginLeftMm: 0, marginTopMm: 0.5, pitchXMm: 70, pitchYMm: 37 });
    // Not checked against a real sheet: the page asks for the test page (and no note repeats it).
    expect(t.verified).toBe(false);
    expect(t.notes).toBe('');
  });

  it('places a sheet on Letter paper, with its own id (Prüfrunde 1, bastler 26)', () => {
    // Avery 5163 / 8163 by its maker's figures: 2 × 5 labels of 4 × 2 in.
    const { template: t, params } = built(form({ page: 'letter', width: '101,6', height: '50,8', cols: '2', rows: '5', marginLeft: '3,97', marginTop: '12,7', gapX: '4,76', gapY: '0' }));
    expect(t.page).toEqual({ widthMm: 215.9, heightMm: 279.4 });
    expect(t.id).toBe('custom-101_6x50_8-2x5-letter-bogen');
    expect(t.description).toContain('pro Letter-Seite');
    expect(slotRects(t).every((r) => r.x + r.width <= 215.9 && r.y + r.height <= 279.4)).toBe(true);
    expect(formFromParams(params).page).toBe('letter');
    expect(cleanCustomParams(JSON.parse(JSON.stringify(params)))?.page).toEqual({ widthMm: 215.9, heightMm: 279.4 });
    // On A4, 5.9 mm narrower, the same sheet does not fit.
    expect(problem(form({ width: '101,6', height: '50,8', cols: '2', rows: '5', marginLeft: '3,97', marginTop: '12,7', gapX: '4,76', gapY: '0' }))).toContain('ragt über den Seitenrand');
  });

  it('works out empty fields: as many as fit, centred', () => {
    const { template: t, params } = built(form({ paper: 'cut', width: '50', height: '30' }));
    expect(t.kind).toBe('cut-yourself');
    expect(t.grid).toEqual({ cols: 3, rows: 8, marginLeftMm: 26, marginTopMm: 14.5, pitchXMm: 54, pitchYMm: 34 });
    expect(slotRects(t)).toHaveLength(24);
    expect(params).toEqual({ labelWidthMm: 50, labelHeightMm: 30, shape: 'rect', kind: 'cut-yourself' });
  });

  it('takes the diameter for round labels', () => {
    const { template: t } = built(form({ paper: 'cut', shape: 'round', width: '40', height: '99' }));
    expect(t.id).toBe('custom-rund-40x40-4x6');
    expect(t.label).toEqual({ widthMm: 40, heightMm: 40, cornerRadiusMm: 20, shape: 'round' });
  });

  it('says in German what is wrong', () => {
    expect(problem(form({ width: 'abc', height: '30' }))).toBe('„Breite“ ist keine Zahl. Gib Millimeter ein, zum Beispiel 4,5.');
    expect(problem(form({ width: '50', height: '3 0' }))).toContain('„Höhe“ ist keine Zahl');
    expect(problem(form({ width: '10', height: '30' }))).toContain('mindestens 15 mm');
    expect(problem(form({ paper: 'photo', width: '500', height: '30' }))).toContain('höchstens 300 mm');
    expect(problem(form({ width: '50', height: '30', cols: '0' }))).toContain('„Spalten“ braucht eine ganze Zahl ab 1');
    expect(problem(form({ width: '50', height: '30', gapX: 'x' }))).toContain('„Abstand zwischen den Spalten“ ist keine Zahl');
    // Geometry problems come from the template itself.
    expect(problem(form({ width: '50', height: '30', cols: '5' }))).toContain('ragt über den Seitenrand');
    expect(problem(form({ width: '250', height: '30' }))).toContain('passt nicht auf die Seite');
  });

  it('gives the stored size back as the form, to change it', () => {
    const typed = form({ paper: 'sheet', width: '70', height: '37', cols: '2', rows: '8', marginLeft: '0', marginTop: '0,5', gapX: '2,5', gapY: '' });
    expect(formFromParams(built(typed).params)).toEqual(typed);
    const photo = form({ paper: 'photo', width: '82', height: '57' });
    expect(formFromParams(built(photo).params)).toEqual(photo);
    expect(formFromParams(undefined)).toEqual(EMPTY_FORM);
  });
});

describe('stored sizes', () => {
  it('keeps what templateFromForm saves', () => {
    const { params } = built(form({ paper: 'sheet', width: '70', height: '37', cols: '3', rows: '8', marginLeft: '0', marginTop: '0,5' }));
    const stored = JSON.parse(JSON.stringify(params));
    expect(cleanCustomParams(stored)).toEqual(params);
    expect(ownTemplateOf(cleanCustomParams(stored))?.id).toBe('custom-70x37-3x8-bogen');
  });

  it('drops values that are not a stored size', () => {
    expect(cleanCustomParams(undefined)).toBeUndefined();
    expect(cleanCustomParams('herma')).toBeUndefined();
    expect(cleanCustomParams({ labelWidthMm: '50', labelHeightMm: 30 })).toBeUndefined();
    expect(cleanCustomParams({ labelWidthMm: 0, labelHeightMm: 30 })).toBeUndefined();
    expect(cleanCustomParams({ labelWidthMm: 50, labelHeightMm: 30, kind: 'photo', cols: 2.5, gapXMm: -1, marginTopMm: '3', notes: 'x' })).toEqual({
      labelWidthMm: 50,
      labelHeightMm: 30,
      shape: 'rect',
      kind: 'cut-yourself',
    });
    expect(cleanCustomParams({ labelWidthMm: 82, labelHeightMm: 57, output: 'images', cols: 4 })).toEqual({ labelWidthMm: 82, labelHeightMm: 57, shape: 'rect', kind: 'single', output: 'images' });
  });

  it('makes no template from a size that does not fit', () => {
    expect(ownTemplateOf(undefined)).toBeUndefined();
    expect(ownTemplateOf({ labelWidthMm: 250, labelHeightMm: 30 })).toBeUndefined();
  });
});

describe('the chosen paper after a reload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadDesign(stored: unknown, calibrations?: unknown) {
    const saved: Record<string, string> = { 'tonuino-studio:stickers': JSON.stringify(stored) };
    if (calibrations) saved['tonuino-studio:calibration'] = JSON.stringify(calibrations);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved[k] ?? null,
      setItem: (k: string, v: string) => void (saved[k] = v),
    });
    vi.resetModules();
    return import('../../src/features/stickers/design');
  }

  it('keeps the own size chosen', async () => {
    const custom = built(form({ paper: 'photo', width: '80', height: '60' })).params;
    const design = await loadDesign({ print: { templateId: 'custom-80x60-1x1-bilder', cutMarks: null, custom } });
    expect(design.template.value.id).toBe('custom-80x60-1x1-bilder');
    expect(design.template.value.output).toBe('images');
    expect(design.ownTemplate.value?.id).toBe('custom-80x60-1x1-bilder');
  });

  it('keeps an own size saved before its id said the kind of paper, with its printer correction', async () => {
    const custom = built(form({ paper: 'sheet', width: '70', height: '37', cols: '3', rows: '8' })).params;
    const correction = { offsetXMm: 1.2, offsetYMm: -0.8, scaleX: 1, scaleY: 1 };
    const design = await loadDesign({ print: { templateId: 'custom-70x37-3x8', cutMarks: null, custom } }, { 'standard::custom-70x37-3x8': correction });
    expect(design.template.value.id).toBe('custom-70x37-3x8-bogen');
    expect(design.calibration.value).toMatchObject({ offsetXMm: 1.2, offsetYMm: -0.8 });
    const photo = built(form({ paper: 'photo', width: '80', height: '60' })).params;
    const again = await loadDesign({ print: { templateId: 'custom-80x60-1x1', cutMarks: null, custom: photo } });
    expect(again.template.value.id).toBe('custom-80x60-1x1-bilder');
  });

  it('gives each kind of paper with the same labels its own id, so the printer corrections stay apart', () => {
    const size = { width: '50', height: '30', cols: '3', rows: '8' };
    const ids = (['sheet', 'cut'] as const).map((paper) => built(form({ paper, ...size })).template.id);
    expect(ids).toEqual(['custom-50x30-3x8-bogen', 'custom-50x30-3x8']);
    expect(built(form({ paper: 'photo', width: '50', height: '30' })).template.id).toBe('custom-50x30-1x1-bilder');
  });

  it('keeps the own size when a built-in paper is chosen, and switches back', async () => {
    const custom = built(form({ paper: 'sheet', width: '70', height: '37', cols: '3', rows: '8' })).params;
    const design = await loadDesign({ print: { templateId: 'card-a4', cutMarks: null, custom } });
    expect(design.template.value.id).toBe('card-a4');
    expect(design.ownTemplate.value?.id).toBe('custom-70x37-3x8-bogen');
    design.updatePrint({ templateId: 'custom-70x37-3x8-bogen' });
    expect(design.template.value.id).toBe('custom-70x37-3x8-bogen');
  });

  it('falls back to HERMA 5028 when the stored size is gone or broken', async () => {
    let design = await loadDesign({ print: { templateId: 'custom-80x60-1x1', cutMarks: null } });
    expect(design.template.value.id).toBe('herma-5028');
    design = await loadDesign({ print: { templateId: 'custom-250x30-1x9', cutMarks: null, custom: { labelWidthMm: 250, labelHeightMm: 30 } } });
    expect(design.template.value.id).toBe('herma-5028');
    expect(design.ownTemplate.value).toBeUndefined();
  });
});
