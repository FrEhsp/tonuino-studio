/**
 * Label sheet templates for TonUINO card stickers.
 *
 * All lengths are millimetres. The origin is the top-left corner of the page
 * and y points down, the same convention jsPDF uses with unit "mm".
 *
 * A template describes where the labels sit on the paper (a regular grid,
 * row-major). The artwork renderer draws one bitmap per label (trim size plus
 * bleed), the PDF code places those bitmaps into the slots.
 */

import { slotRects } from './slots';

export type LabelShape = 'rect' | 'round';

/**
 * - `die-cut`: pre-cut label sheet; bleed only goes into the gaps, never onto a neighbour.
 * - `cut-yourself`: full-sheet paper or film; the user cuts along crop marks.
 * - `single`: one sticker per page (borderless printers) or per picture (photo
 *   stickers, output `images`); page = label + bleed.
 * - `photo`: a print ordered from a photo service, exported as a JPEG image.
 */
export type TemplateKind = 'die-cut' | 'cut-yourself' | 'single' | 'photo';
/**
 * - `pdf`: a PDF to print at home.
 * - `jpeg`: one JPEG per sheet, ordered as a photo print.
 * - `images`: every sticker as its own JPEG in a ZIP, for photo services that
 *   print stickers from single pictures.
 */
export type TemplateOutput = 'pdf' | 'jpeg' | 'images';

export interface PageSize {
  widthMm: number;
  heightMm: number;
}

export interface LabelGeometry {
  widthMm: number;
  heightMm: number;
  /** For round labels this is half the diameter. */
  cornerRadiusMm: number;
  shape: LabelShape;
}

export interface GridGeometry {
  cols: number;
  rows: number;
  /** Distance from the left page edge to the left edge of the first column. */
  marginLeftMm: number;
  /** Distance from the top page edge to the top edge of the first row. */
  marginTopMm: number;
  /** Distance from the left edge of one label to the left edge of the next (label width + gap). */
  pitchXMm: number;
  /** Distance from the top edge of one label to the top edge of the next (label height + gap). */
  pitchYMm: number;
}

export interface LabelTemplate {
  id: string;
  /** German display name. */
  name: string;
  /** German one-line description for the template picker. */
  description: string;
  page: PageSize;
  label: LabelGeometry;
  grid: GridGeometry;
  kind: TemplateKind;
  output: TemplateOutput;
  /** Suggested bleed. The PDF code limits it to half the gap between labels. */
  defaultBleedMm: number;
  /** Keep text and important picture parts this far inside the label edge. */
  safeMarginMm: number;
  /** false: geometry not confirmed with a real sheet; the UI says "bitte mit Testdruck prüfen". */
  verified: boolean;
  /** German notes for the user: paper, cutting, known quirks. */
  notes: string;
}

export interface PrintDefaults {
  bleedMm: number;
  cutMarks: boolean;
  cutLines: boolean;
}

export const MM_PER_INCH = 25.4;
export const A4: PageSize = Object.freeze({ widthMm: 210, heightMm: 297 });

/** ISO/IEC 7810 ID-1, the size of a TonUINO RFID card (53.98 mm rounded to 54). */
export const CARD_WIDTH_MM = 85.6;
export const CARD_HEIGHT_MM = 54;
export const CARD_CORNER_RADIUS_MM = 3.18;

const CARD_LABEL: LabelGeometry = {
  widthMm: CARD_WIDTH_MM,
  heightMm: CARD_HEIGHT_MM,
  cornerRadiusMm: CARD_CORNER_RADIUS_MM,
  shape: 'rect',
};

/**
 * Card-sized cells on A4 for media the user cuts: 2 × 5 cards, 8 mm between
 * the columns (room for crop marks), 3 mm between the rows. That leaves
 * 15.4 mm left/right and 7.5 mm top/bottom, inside the printable area of
 * common home printers. The bleed (3 mm, see CUT_AT_CARD_BLEED_MM) fills the
 * row gap (1.5 mm each side); crop marks for the vertical cuts go into the top and
 * bottom margins and, on a white line, across the row gaps (the margins alone
 * are too close to the edge for many printers), those for the horizontal cuts
 * into the side margins and the column gap.
 */
const CARD_A4_GRID: GridGeometry = {
  cols: 2,
  rows: 5,
  marginLeftMm: 15.4,
  marginTopMm: 7.5,
  pitchXMm: CARD_WIDTH_MM + 8,
  pitchYMm: CARD_HEIGHT_MM + 3,
};

const SELPHY_BLEED_MM = 2;

/**
 * Cards to cut get 3 mm of picture past the card edge where the gap has room
 * (between the rows it is half the 3 mm gap): cut out roughly, lay the card on
 * top and cut along its edge, which needs no precise cut (as the Yoto
 * community does it; sticker audit 16.10.2026, item 8).
 */
const CUT_AT_CARD_BLEED_MM = 3;
const CUT_AT_CARD =
  'Schneide jeden Sticker grob aus, lege die Karte darauf und schneide an der Kartenkante entlang. ' +
  'Dafür reicht das Bild 3 mm über den Kartenrand, die Schnittmarken brauchst du dann nicht.';

/** One sentence on how long it lasts, for paper labels (sticker audit 16.10.2026: spit, water, teeth come up a lot). */
const DURABLE_PAPER = 'Papier verträgt keine Nässe, mit Klarlack oder selbstklebender Schutzfolie darüber wird der Sticker abwischbar.';
/** The same for paper or film to cut. */
const DURABLE_CUT = 'Folie mit Pigmenttinte oder Laser hält Spucke aus, Papier nur mit Klarlack oder Schutzfolie darüber.';

/** Photo stickers ("4-fach") of dm, Rossmann, CEWE and others; the size differs a little between services. */
const PHOTO_STICKER: LabelGeometry = { widthMm: 82, heightMm: 57, cornerRadiusMm: 0, shape: 'rect' };

export const BUILTIN_TEMPLATES: readonly LabelTemplate[] = [
  {
    id: 'herma-5028',
    name: 'HERMA 5028 (83,8 × 50,8 mm)',
    description: 'A4-Etikettenbogen mit 10 Etiketten, der Klassiker für TonUINO-Karten.',
    page: A4,
    // HERMA lists 5028 with rounded corners; the radius is not published (3 mm assumed).
    label: { widthMm: 83.8, heightMm: 50.8, cornerRadiusMm: 3, shape: 'rect' },
    // Values as used by the TonUINO Card Creator: column gap 5.08 mm, no row gap.
    grid: { cols: 2, rows: 5, marginLeftMm: 18.64, marginTopMm: 21.5, pitchXMm: 83.8 + 5.08, pitchYMm: 50.8 },
    kind: 'die-cut',
    output: 'pdf',
    defaultBleedMm: 1.5,
    safeMarginMm: 2.5,
    verified: true,
    notes:
      'Das Etikett ist etwas kleiner als die Karte (85,6 × 54 mm): Rundherum bleibt etwa 1–1,5 mm Kartenrand frei. ' +
      'Maße wie im TonUINO Card Creator. Liegt der Druck daneben, gleiche den Versatz mit der Testseite aus. ' +
      DURABLE_PAPER,
  },
  {
    id: 'labelident-85x55',
    name: 'Labelident 85 × 55 mm',
    description: 'A4-Bogen mit 10 Etiketten, fast so groß wie die Karte.',
    page: A4,
    label: { widthMm: 85, heightMm: 55, cornerRadiusMm: 0, shape: 'rect' },
    // Assumed: sheet centred, 10 mm column gap, rows touching (15 + 85 + 10 + 85 + 15 = 210; 11 + 5 × 55 + 11 = 297).
    grid: { cols: 2, rows: 5, marginLeftMm: 15, marginTopMm: 11, pitchXMm: 95, pitchYMm: 55 },
    kind: 'die-cut',
    output: 'pdf',
    defaultBleedMm: 1.5,
    safeMarginMm: 2.5,
    verified: false,
    notes:
      'Ränder geschätzt: 15 mm links und rechts, 10 mm zwischen den Spalten, 11 mm oben und unten, Zeilen ohne Abstand. ' +
      'Bitte zuerst die Testseite drucken und gegen einen Bogen halten. ' +
      'Das Etikett ist 1 mm höher als die Karte: Klebe es mittig auf oder schneide oben und unten etwas ab. ' +
      DURABLE_PAPER,
  },
  {
    id: 'card-a4',
    name: 'Ganze Karten zum Ausschneiden (A4)',
    description: '10 Karten in Kartengröße mit Schnittmarken, für Fotopapier, Klebepapier oder Laminiertaschen.',
    page: A4,
    label: CARD_LABEL,
    grid: CARD_A4_GRID,
    kind: 'cut-yourself',
    output: 'pdf',
    defaultBleedMm: CUT_AT_CARD_BLEED_MM,
    safeMarginMm: 3,
    verified: true,
    notes:
      CUT_AT_CARD +
      ' Die Ecken rundest du mit einem Eckenrunder ab (Radius etwa 3 mm). ' +
      'Am längsten hält sie laminiert in einer Tasche mit 90 × 60 mm, mit 2–3 mm Folie rundherum, damit keine Feuchtigkeit an die Kanten kommt.',
  },
  {
    id: 'film-a4',
    name: 'Wasserfeste Folie A4 zum Ausschneiden',
    description: '10 Sticker in Kartengröße auf ganzflächiger Folie, z. B. Avery Zweckform J4775 (Tintenstrahl) oder L4775 (Laser).',
    page: A4,
    label: CARD_LABEL,
    grid: CARD_A4_GRID,
    kind: 'cut-yourself',
    output: 'pdf',
    defaultBleedMm: CUT_AT_CARD_BLEED_MM,
    safeMarginMm: 3,
    verified: true,
    notes:
      CUT_AT_CARD +
      ' Nimm die passende Folie für deinen Drucker: J4775 für Tintenstrahl, L4775 für Laser. ' +
      'Wasserfest wird der Druck nur mit Pigmenttinte oder Laser, dann hält die Folie Spucke aus, aber keine Zähne und Fingernägel.',
  },
  {
    id: 'selphy-card',
    name: 'Canon SELPHY Kreditkarte (54 × 86 mm)',
    description: 'Ein Sticker pro Blatt, randlos auf Canon-Etikettenpapier KC-18IF.',
    page: { widthMm: 86 + 2 * SELPHY_BLEED_MM, heightMm: 54 + 2 * SELPHY_BLEED_MM },
    label: { widthMm: 86, heightMm: 54, cornerRadiusMm: 0, shape: 'rect' },
    grid: { cols: 1, rows: 1, marginLeftMm: SELPHY_BLEED_MM, marginTopMm: SELPHY_BLEED_MM, pitchXMm: 86, pitchYMm: 54 },
    kind: 'single',
    output: 'pdf',
    defaultBleedMm: SELPHY_BLEED_MM,
    safeMarginMm: 3,
    verified: false,
    notes:
      'Braucht die Papierkassette für das Kreditkartenformat (PCC-CP400). ' +
      'Beim randlosen Druck schneidet der Drucker etwa 1–2 mm ab, deshalb hat die Seite 2 mm Beschnitt rundherum. ' +
      'Halte Schrift mindestens 3 mm vom Rand fern. Im Druckdialog „randlos“ und „Tatsächliche Größe“ wählen. ' +
      'Laut Canon bekommt der Druck eine Schutzschicht und ist abwischbar. Ob er Spucke und Zähne aushält, probiere am besten an einer Karte aus.',
  },
  {
    id: 'photo-13x18',
    name: 'Fotoabzug 13 × 18 cm (4 Karten)',
    description: 'Vier Karten auf einem Fotoabzug vom Fotoservice, z. B. dm, Rossmann oder CEWE.',
    // Landscape 18 × 13 cm. Two cards need 171.2 of the 180 mm, so the side margins are small.
    page: { widthMm: 180, heightMm: 130 },
    label: CARD_LABEL,
    grid: { cols: 2, rows: 2, marginLeftMm: 3.4, marginTopMm: 7, pitchXMm: CARD_WIDTH_MM + 2, pitchYMm: CARD_HEIGHT_MM + 8 },
    kind: 'photo',
    output: 'jpeg',
    defaultBleedMm: 1,
    safeMarginMm: 3.5,
    verified: false,
    notes:
      'Wird als JPEG-Bild mit 300 dpi gespeichert. Bestelle es als Abzug 13 × 18 cm. ' +
      'Fotolabore schneiden beim randlosen Druck oft 1–2 mm ab und vergrößern dabei leicht: ' +
      'Schneide an den Schnittmarken aus und prüfe die Größe an einer Karte. ' +
      'Ein Fotoabzug ist abwischbar und hält laminiert noch länger, mit 2–3 mm Folie rundherum.',
  },
  {
    id: 'photo-sticker-82x57',
    name: 'Fotosticker 82 × 57 mm (dm, Rossmann, CEWE)',
    description: 'Für Fotosticker vom Fotoservice: Jeder Sticker wird ein eigenes Bild.',
    // One picture per sticker in the sticker's own proportions; the service fills the sticker with it.
    page: { widthMm: PHOTO_STICKER.widthMm, heightMm: PHOTO_STICKER.heightMm },
    label: PHOTO_STICKER,
    grid: { cols: 1, rows: 1, marginLeftMm: 0, marginTopMm: 0, pitchXMm: PHOTO_STICKER.widthMm, pitchYMm: PHOTO_STICKER.heightMm },
    kind: 'single',
    output: 'images',
    // No bleed: it would change the proportions, and the service cuts a little off the edge itself.
    defaultBleedMm: 0,
    // 3 mm taller than the card: 1.5 mm stick out at the top and bottom and are cut off.
    // 2.5 mm more for what the service cuts off, so title and number stay on the card.
    safeMarginMm: 4,
    verified: false,
    notes:
      'Ich speichere jeden Sticker als eigenes Bild in einer ZIP-Datei. Entpacke sie und lade die Bilder beim Fotoservice als Fotosticker hoch. ' +
      'Der Sticker ist 3 mm höher als die Karte: Klebe ihn mittig auf und schneide oben und unten den Rand an der Kartenkante ab. ' +
      'Titel und Nummer bleiben auf der Karte. ' +
      'Fotosticker sind abwischbar, lösen sich aber mit der Zeit an den Kanten; Klarlack über der Kante hilft.',
  },
  {
    id: 'round-30',
    name: 'Runde Sticker Ø 30 mm',
    description: '40 runde Sticker auf A4, für NFC-Münzen und Anhänger mit 30 mm.',
    page: A4,
    label: { widthMm: 30, heightMm: 30, cornerRadiusMm: 15, shape: 'round' },
    // 5 × 8, 5 mm gaps: 20 + 5 × 30 + 4 × 5 + 20 = 210; 11 + 8 × 30 + 7 × 5 + 11 = 297.
    grid: { cols: 5, rows: 8, marginLeftMm: 20, marginTopMm: 11, pitchXMm: 35, pitchYMm: 35 },
    kind: 'cut-yourself',
    output: 'pdf',
    defaultBleedMm: 1.5,
    safeMarginMm: 2.5,
    verified: true,
    notes:
      'Für ganzflächiges Klebepapier oder Folie. ' +
      'Mit einem Motivstanzer (Kreis 30 mm) oder einer Schere an der Schnittlinie ausschneiden. ' +
      DURABLE_CUT,
  },
  {
    id: 'round-25',
    name: 'Runde Sticker Ø 25 mm',
    description: '54 runde Sticker auf A4, für runde NFC-Sticker mit 25 mm.',
    page: A4,
    label: { widthMm: 25, heightMm: 25, cornerRadiusMm: 12.5, shape: 'round' },
    // 6 × 9, 5 mm gaps: 17.5 + 6 × 25 + 5 × 5 + 17.5 = 210; 16 + 9 × 25 + 8 × 5 + 16 = 297.
    grid: { cols: 6, rows: 9, marginLeftMm: 17.5, marginTopMm: 16, pitchXMm: 30, pitchYMm: 30 },
    kind: 'cut-yourself',
    output: 'pdf',
    defaultBleedMm: 1.5,
    safeMarginMm: 2,
    verified: true,
    notes:
      'Für ganzflächiges Klebepapier oder Folie. ' +
      'Mit einem Motivstanzer (Kreis 25 mm) oder einer Schere an der Schnittlinie ausschneiden. ' +
      DURABLE_CUT,
  },
];

export function getTemplate(id: string): LabelTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

/**
 * How far a label sticks out over a TonUINO card on each side when it is stuck
 * on centred (landscape or portrait). That part is cut off at the card edge.
 */
export function cardOverhangMm(widthMm: number, heightMm: number): number {
  const long = Math.max(widthMm, heightMm);
  const short = Math.min(widthMm, heightMm);
  return round4(Math.max(0, (long - CARD_WIDTH_MM) / 2, (short - CARD_HEIGHT_MM) / 2));
}

/** Print settings that suit the template; the user may still change them. */
export function defaultPrintOptions(template: LabelTemplate): PrintDefaults {
  const round = template.label.shape === 'round';
  switch (template.kind) {
    case 'die-cut':
    case 'single':
      return { bleedMm: template.defaultBleedMm, cutMarks: false, cutLines: false };
    case 'cut-yourself':
      return { bleedMm: template.defaultBleedMm, cutMarks: !round, cutLines: round };
    case 'photo':
      return { bleedMm: template.defaultBleedMm, cutMarks: true, cutLines: round };
  }
}

/**
 * For `single` templates the page is the label plus bleed on every side, so a
 * different bleed changes the page. Other templates are returned unchanged.
 */
export function templateForBleed(template: LabelTemplate, bleedMm: number): LabelTemplate {
  if (template.kind !== 'single') return template;
  const b = Math.max(0, Number.isFinite(bleedMm) ? bleedMm : template.defaultBleedMm);
  const { widthMm, heightMm } = template.label;
  if (b === template.grid.marginLeftMm && b === template.grid.marginTopMm) return template;
  return {
    ...template,
    page: { widthMm: round4(widthMm + 2 * b), heightMm: round4(heightMm + 2 * b) },
    grid: { ...template.grid, cols: 1, rows: 1, marginLeftMm: b, marginTopMm: b },
  };
}

/** Pixel size of one sticker bitmap (trim size plus bleed on every side). */
export function stickerPixelSize(
  template: LabelTemplate,
  dpi = 300,
  bleedMm = template.defaultBleedMm,
): { widthPx: number; heightPx: number } {
  const b = Math.max(0, bleedMm);
  return {
    widthPx: Math.max(1, Math.round(((template.label.widthMm + 2 * b) / MM_PER_INCH) * dpi)),
    heightPx: Math.max(1, Math.round(((template.label.heightMm + 2 * b) / MM_PER_INCH) * dpi)),
  };
}

/**
 * Checks a template for impossible geometry. Returns German messages, an
 * empty list means the template is fine.
 */
export function validateTemplate(template: LabelTemplate): string[] {
  const problems: string[] = [];
  const { page, label, grid } = template;
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  if (!positive(page.widthMm) || !positive(page.heightMm)) {
    problems.push('Die Seite muss breiter und höher als 0 mm sein.');
  }
  if (!positive(label.widthMm) || !positive(label.heightMm)) {
    problems.push('Das Etikett muss breiter und höher als 0 mm sein.');
  }
  if (!Number.isInteger(grid.cols) || !Number.isInteger(grid.rows) || grid.cols < 1 || grid.rows < 1) {
    problems.push('Es muss mindestens eine Spalte und eine Zeile geben.');
  }
  if (problems.length > 0) return problems;

  if (label.shape === 'round' && Math.abs(label.widthMm - label.heightMm) > 0.01) {
    problems.push('Runde Etiketten brauchen gleiche Breite und Höhe.');
  }
  if (!(label.cornerRadiusMm >= 0) || label.cornerRadiusMm > Math.min(label.widthMm, label.heightMm) / 2 + 1e-6) {
    problems.push('Der Eckenradius passt nicht zur Etikettgröße.');
  }
  if (!(template.defaultBleedMm >= 0) || !(template.safeMarginMm >= 0)) {
    problems.push('Beschnitt und Sicherheitsabstand dürfen nicht negativ sein.');
  }
  if (template.safeMarginMm * 2 >= Math.min(label.widthMm, label.heightMm)) {
    problems.push('Der Sicherheitsabstand ist größer als das halbe Etikett.');
  }

  const eps = 1e-6;
  const rects = slotRects(template);
  const outside = rects.find(
    (r) => r.x < -eps || r.y < -eps || r.x + r.width > page.widthMm + eps || r.y + r.height > page.heightMm + eps,
  );
  if (outside) {
    problems.push(`Etikett ${outside.index + 1} ragt über den Seitenrand. Verkleinere die Ränder oder die Anzahl.`);
  }
  // Grid neighbours are the only candidates for overlap; checking the pitch is enough.
  if (grid.cols > 1 && grid.pitchXMm < label.widthMm - eps) {
    problems.push('Die Etiketten 1 und 2 überlappen sich. Vergrößere den Abstand zwischen den Spalten.');
  }
  if (grid.rows > 1 && grid.pitchYMm < label.heightMm - eps) {
    problems.push(`Die Etiketten 1 und ${grid.cols + 1} überlappen sich. Vergrößere den Abstand zwischen den Zeilen.`);
  }
  return problems;
}

export interface CustomTemplateParams {
  name?: string;
  /** Defaults to A4. */
  page?: PageSize;
  labelWidthMm: number;
  labelHeightMm: number;
  shape?: LabelShape;
  /** Defaults to 0 for rectangles; ignored for round labels. */
  cornerRadiusMm?: number;
  /** Defaults to as many as fit (with at least 5 mm page margin). */
  cols?: number;
  rows?: number;
  /** Defaults to a centred grid. */
  marginLeftMm?: number;
  marginTopMm?: number;
  /** Gap between labels. Defaults to 0 for die-cut sheets and 4 mm otherwise. */
  gapXMm?: number;
  gapYMm?: number;
  /** Defaults to `cut-yourself`. */
  kind?: TemplateKind;
  /** `images` (single pictures for a photo service) goes with kind `single`. */
  output?: TemplateOutput;
  /** Defaults to 2 mm for single labels, 0 for single pictures, 1 mm for die-cut sheets and up to 2 mm otherwise. */
  bleedMm?: number;
  /** Defaults to 3 mm (less on tiny labels) plus what sticks out over the card. */
  safeMarginMm?: number;
  verified?: boolean;
  notes?: string;
}

const MIN_AUTO_MARGIN_MM = 5;

/**
 * Builds a template for a user-defined label size or sheet. Throws an Error
 * with a German message when the labels do not fit or overlap.
 */
export function customTemplate(params: CustomTemplateParams): LabelTemplate {
  const kind = params.kind ?? 'cut-yourself';
  const output = params.output ?? (kind === 'photo' ? 'jpeg' : 'pdf');
  const shape = params.shape ?? 'rect';
  const w = params.labelWidthMm;
  const h = shape === 'round' ? params.labelWidthMm : params.labelHeightMm;
  if (!(w > 0) || !(h > 0)) throw new Error('Das Etikett muss breiter und höher als 0 mm sein.');
  const cornerRadiusMm = shape === 'round' ? w / 2 : Math.max(0, params.cornerRadiusMm ?? 0);
  const defaultGap = kind === 'die-cut' ? 0 : 4;
  const gapX = Math.max(0, params.gapXMm ?? defaultGap);
  const gapY = Math.max(0, params.gapYMm ?? defaultGap);
  const images = output === 'images';
  // Single pictures keep the sticker's proportions; the photo service cuts the edge itself.
  const defaultBleed = images ? 0 : kind === 'single' ? 2 : kind === 'die-cut' ? 1 : Math.min(2, Math.max(1, Math.min(gapX, gapY) / 2));
  const bleed = Math.max(0, params.bleedMm ?? defaultBleed);
  // What sticks out over the card is cut off, so text keeps clear of it. At most a quarter of the label keeps the template valid.
  const overhang = cardOverhangMm(w, h);
  const safe = Math.max(0, params.safeMarginMm ?? Math.min(Math.min(3, Math.min(w, h) / 6) + overhang, Math.min(w, h) / 4));
  const label: LabelGeometry = { widthMm: w, heightMm: h, cornerRadiusMm, shape };
  const sizeText = shape === 'round' ? `Ø ${fmtMm(w)} mm` : `${fmtMm(w)} × ${fmtMm(h)} mm`;

  let page: PageSize;
  let grid: GridGeometry;
  if (kind === 'single') {
    page = { widthMm: round4(w + 2 * bleed), heightMm: round4(h + 2 * bleed) };
    grid = { cols: 1, rows: 1, marginLeftMm: bleed, marginTopMm: bleed, pitchXMm: w, pitchYMm: h };
  } else {
    page = params.page ?? A4;
    const fit = (pageLen: number, len: number, gap: number, margin: number | undefined) => {
      const lead = margin ?? MIN_AUTO_MARGIN_MM;
      return Math.floor((pageLen - lead - MIN_AUTO_MARGIN_MM + gap + 1e-9) / (len + gap));
    };
    const cols = params.cols ?? fit(page.widthMm, w, gapX, params.marginLeftMm);
    const rows = params.rows ?? fit(page.heightMm, h, gapY, params.marginTopMm);
    if (!(cols >= 1) || !(rows >= 1)) {
      throw new Error(`Ein Etikett mit ${sizeText} passt nicht auf die Seite. Prüfe Größe und Ränder.`);
    }
    const usedW = cols * w + (cols - 1) * gapX;
    const usedH = rows * h + (rows - 1) * gapY;
    grid = {
      cols,
      rows,
      marginLeftMm: round4(params.marginLeftMm ?? (page.widthMm - usedW) / 2),
      marginTopMm: round4(params.marginTopMm ?? (page.heightMm - usedH) / 2),
      pitchXMm: round4(w + gapX),
      pitchYMm: round4(h + gapY),
    };
  }

  // Unchecked die-cut sizes need no note: the page asks for the test page of every unverified template.
  const notes = [
    images ? 'Ich speichere jeden Sticker als eigenes Bild in einer ZIP-Datei. Entpacke sie und lade die Bilder beim Fotoservice hoch.' : '',
    overhang > 0
      ? `${images ? 'Der Sticker ist größer als die Karte: Klebe ihn' : 'Das Etikett ist größer als die Karte: Klebe es'} mittig auf und schneide den Rand an der Kartenkante ab. Titel und Nummer bleiben auf der Karte.`
      : '',
  ];
  const template: LabelTemplate = {
    id: customTemplateId(`custom-${shape === 'round' ? 'rund-' : ''}${fmtId(w)}x${fmtId(h)}-${grid.cols}x${grid.rows}`, kind, output),
    name: params.name?.trim() || `Eigene Größe ${sizeText}`,
    description: images
      ? `Jeder Sticker wird ein eigenes Bild mit ${sizeText}.`
      : `${grid.cols * grid.rows} ${grid.cols * grid.rows === 1 ? 'Etikett' : 'Etiketten'} mit ${sizeText} pro Seite.`,
    page,
    label,
    grid,
    kind,
    output,
    defaultBleedMm: bleed,
    safeMarginMm: safe,
    verified: params.verified ?? kind !== 'die-cut',
    notes: params.notes ?? notes.filter(Boolean).join(' '),
  };
  const problems = validateTemplate(template);
  if (problems.length > 0) throw new Error(problems.join(' '));
  return template;
}

/**
 * Ids of own sizes say what kind of paper they are for: a die-cut sheet and
 * paper to cut with the same labels need their own printer correction
 * (calibrations are stored by template id). Paper to cut keeps the id it
 * always had; the others get a suffix.
 */
const KIND_SUFFIX: Record<string, string> = {
  'cut-yourself/pdf': '',
  'die-cut/pdf': '-bogen',
  'single/pdf': '-einzeln',
  'single/images': '-bilder',
  'photo/jpeg': '-foto',
};

function customTemplateId(base: string, kind: TemplateKind, output: TemplateOutput): string {
  return base + (KIND_SUFFIX[`${kind}/${output}`] ?? `-${kind}-${output}`);
}

/**
 * The id an own size had before its id said the kind of paper (see
 * KIND_SUFFIX), to carry over the paper chosen and the printer correction.
 * Undefined for built-in templates and where nothing changed.
 */
export function legacyCustomTemplateId(t: Pick<LabelTemplate, 'id' | 'kind' | 'output'>): string | undefined {
  if (!t.id.startsWith('custom-')) return undefined;
  const suffix = KIND_SUFFIX[`${t.kind}/${t.output}`] ?? `-${t.kind}-${t.output}`;
  return suffix && t.id.endsWith(suffix) ? t.id.slice(0, -suffix.length) : undefined;
}

/** Rounds to 0.1 µm to keep sums like 18.64 + 88.88 free of float noise. */
export function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** German number format for mm values: 83.8 → "83,8". */
export function fmtMm(v: number): string {
  return String(round4(v)).replace('.', ',');
}

function fmtId(v: number): string {
  return String(round4(v)).replace('.', '_');
}
