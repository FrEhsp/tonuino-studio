/**
 * "Eigene Größe": the form for a label size or sheet the app does not know,
 * turned into a template. Pure functions, so the dialog only shows them.
 */

import { customTemplate, fmtMm, isLetter, LETTER, type CustomTemplateParams, type LabelTemplate } from '../../core/stickers/templates';

/** A pre-cut label sheet, paper or film the user cuts, or single pictures for a photo service. */
export type OwnPaper = 'sheet' | 'cut' | 'photo';

/** The form as typed: millimetres with comma or point; an empty field means "the app works it out". */
export interface OwnSizeForm {
  paper: OwnPaper;
  /** The sheet's size: A4, or US Letter (Prüfrunde 1, bastler 26). */
  page: 'a4' | 'letter';
  shape: 'rect' | 'round';
  width: string;
  height: string;
  cols: string;
  rows: string;
  marginLeft: string;
  marginTop: string;
  gapX: string;
  gapY: string;
}

export const EMPTY_FORM: OwnSizeForm = { paper: 'sheet', page: 'a4', shape: 'rect', width: '', height: '', cols: '', rows: '', marginLeft: '', marginTop: '', gapX: '', gapY: '' };

/** Smallest and largest side the app accepts; smaller labels have no room for anything. */
export const MIN_SIDE_MM = 15;
export const MAX_SIDE_MM = 300;

export type OwnSizeResult = { template: LabelTemplate; params: CustomTemplateParams } | { problem: string; empty?: boolean };

/** "82", "82,5", "82.5 mm" → number; empty → undefined; anything else → NaN. */
export function parseLength(text: string): number | undefined {
  const t = text.trim().replace(',', '.').replace(/\s*mm$/i, '');
  if (!t) return undefined;
  return /^(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : NaN;
}

/** "3" → 3; empty → undefined; anything else (also 0 or 2,5) → NaN. */
export function parseCount(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  return /^\d+$/.test(t) && Number(t) >= 1 ? Number(t) : NaN;
}

/** Builds the template the form describes, or says in German what is missing or wrong. */
export function templateFromForm(form: OwnSizeForm): OwnSizeResult {
  const round = form.shape === 'round';
  const w = parseLength(form.width);
  const h = round ? w : parseLength(form.height);
  if (w === undefined || h === undefined) {
    return { problem: round ? 'Gib den Durchmesser in Millimetern ein.' : 'Gib Breite und Höhe eines Etiketts in Millimetern ein.', empty: true };
  }
  if (Number.isNaN(w)) return { problem: notALength(round ? 'Durchmesser' : 'Breite') };
  if (Number.isNaN(h)) return { problem: notALength('Höhe') };
  if (Math.min(w, h) < MIN_SIDE_MM) return { problem: `Ein Etikett braucht mindestens ${MIN_SIDE_MM} mm, sonst passt nichts darauf.` };
  if (Math.max(w, h) > MAX_SIDE_MM) return { problem: `Ein Etikett darf höchstens ${MAX_SIDE_MM} mm groß sein.` };

  const params: CustomTemplateParams = { labelWidthMm: w, labelHeightMm: h, shape: form.shape };
  if (form.paper === 'photo') {
    params.kind = 'single';
    params.output = 'images';
  } else {
    params.kind = form.paper === 'sheet' ? 'die-cut' : 'cut-yourself';
    if (form.page === 'letter') params.page = LETTER;
    const counts: [keyof OwnSizeForm, string, 'cols' | 'rows'][] = [
      ['cols', 'Spalten', 'cols'],
      ['rows', 'Zeilen', 'rows'],
    ];
    for (const [field, label, key] of counts) {
      const n = parseCount(form[field]);
      if (Number.isNaN(n)) return { problem: `„${label}“ braucht eine ganze Zahl ab 1. Lässt du das Feld leer, nehme ich so viele, wie passen.` };
      if (n !== undefined) params[key] = n;
    }
    const lengths: [keyof OwnSizeForm, string, 'marginLeftMm' | 'marginTopMm' | 'gapXMm' | 'gapYMm'][] = [
      ['marginLeft', 'Rand links', 'marginLeftMm'],
      ['marginTop', 'Rand oben', 'marginTopMm'],
      ['gapX', 'Abstand zwischen den Spalten', 'gapXMm'],
      ['gapY', 'Abstand zwischen den Zeilen', 'gapYMm'],
    ];
    for (const [field, label, key] of lengths) {
      const v = parseLength(form[field]);
      if (Number.isNaN(v)) return { problem: `${notALength(label)} Lässt du das Feld leer, rechne ich selbst.` };
      if (v !== undefined) params[key] = v;
    }
  }
  try {
    return { template: customTemplate(params), params };
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}

function notALength(label: string): string {
  return `„${label}“ ist keine Zahl. Gib Millimeter ein, zum Beispiel 4,5.`;
}

/** The form for a stored size, to change it. */
export function formFromParams(params: CustomTemplateParams | undefined): OwnSizeForm {
  if (!params) return { ...EMPTY_FORM };
  const mm = (v: number | undefined) => (v === undefined ? '' : fmtMm(v));
  const paper: OwnPaper = params.output === 'images' ? 'photo' : params.kind === 'die-cut' ? 'sheet' : 'cut';
  return {
    paper,
    page: params.page && isLetter(params.page) ? 'letter' : 'a4',
    shape: params.shape === 'round' ? 'round' : 'rect',
    width: mm(params.labelWidthMm),
    height: params.shape === 'round' ? '' : mm(params.labelHeightMm),
    cols: params.cols === undefined ? '' : String(params.cols),
    rows: params.rows === undefined ? '' : String(params.rows),
    marginLeft: mm(params.marginLeftMm),
    marginTop: mm(params.marginTopMm),
    gapX: mm(params.gapXMm),
    gapY: mm(params.gapYMm),
  };
}

/**
 * The stored size as saved by templateFromForm; anything else (an older
 * version, a hand-edited value) is dropped instead of breaking the page.
 */
export function cleanCustomParams(raw: unknown): CustomTemplateParams | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined);
  const w = num(r.labelWidthMm);
  const h = num(r.labelHeightMm);
  if (!w || !h) return undefined;
  const params: CustomTemplateParams = { labelWidthMm: w, labelHeightMm: h, shape: r.shape === 'round' ? 'round' : 'rect' };
  if (r.output === 'images') {
    params.kind = 'single';
    params.output = 'images';
    return params;
  }
  params.kind = r.kind === 'die-cut' ? 'die-cut' : 'cut-yourself';
  const page = r.page as { widthMm?: unknown; heightMm?: unknown } | undefined;
  if (page && typeof page.widthMm === 'number' && typeof page.heightMm === 'number' && isLetter({ widthMm: page.widthMm, heightMm: page.heightMm })) params.page = LETTER;
  const optional = { cols: count(r.cols), rows: count(r.rows), marginLeftMm: num(r.marginLeftMm), marginTopMm: num(r.marginTopMm), gapXMm: num(r.gapXMm), gapYMm: num(r.gapYMm) };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) Object.assign(params, { [key]: value });
  return params;
}

/** The template of a stored size, or nothing when it no longer makes one. */
export function ownTemplateOf(params: CustomTemplateParams | undefined): LabelTemplate | undefined {
  if (!params) return undefined;
  try {
    return customTemplate(params);
  } catch {
    return undefined;
  }
}
