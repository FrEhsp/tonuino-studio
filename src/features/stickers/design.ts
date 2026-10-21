import { computed, signal } from '@preact/signals';
import type { BackMode } from '../../core/stickers/backside';
import { knownStyle, type Orientation, type StickerStyle } from '../../core/stickers/layout';
import { calibrationKey, getCalibration, setCalibration, type Calibration, type CalibrationStore } from '../../core/stickers/calibration';
import { chosenMargin } from '../../core/stickers/margin';
import { BUILTIN_TEMPLATES, defaultPrintOptions, getTemplate, legacyCustomTemplateId, type CustomTemplateParams, type LabelTemplate } from '../../core/stickers/templates';
import { kv } from '../../platform/web/idb';
import { cleanCustomParams, ownTemplateOf } from './customSize';
import type { FontId } from './fonts';

/** How the stickers look. Saved in the browser, the same for every box. */
export interface StickerDesign {
  /** Klassisch, Kassette, Bildkarte or Vollbild; the same for every sticker. */
  style: StickerStyle;
  /** "auto": each sticker turned like its picture, so portrait pictures get portrait stickers. */
  orientation: Orientation | 'auto';
  /** Show every picture whole instead of filling the picture area; a sticker's own zoom still wins. */
  wholePicture: boolean;
  font: FontId;
  showTitle: boolean;
  /** Vollbild: title in white on a darkened picture instead of on the colour band (a light picture keeps the band). */
  darken: boolean;
  showNumber: boolean;
  /** "tonuino": the official logo, built in with Thorsten Voß's permission (Frank, 17.10.2026). */
  logo: 'none' | 'tonuino' | 'text' | 'image';
  /** Text of the wordmark, e.g. "TonUINO" or "Emmas Box". */
  logoText: string;
  /** Colour the logo like the text (white on dark, dark on light). */
  logoTint: boolean;
}

export interface PrintSetup {
  templateId: string;
  /** null: what suits the template. */
  cutMarks: boolean | null;
  /** The user's own size ("Eigene Größe"); kept when another paper is chosen. */
  custom?: CustomTemplateParams;
  /** Extra "Sticker-Rückseite": what goes on the back of each sticker (see backside.ts). Missing: none. */
  back?: BackMode;
  /**
   * "Weißer Rand" in mm by paper (template id; see core/stickers/margin.ts):
   * the printer that sets some stickers off on one sheet may print another
   * paper, or a photo service, just right. Missing for a paper: what it
   * gets from the start (autoMarginMm: 1 mm on sheets without a gap).
   */
  margins?: Record<string, number>;
}

interface Stored {
  design: StickerDesign;
  print: PrintSetup;
}

const KEY = 'tonuino-studio:stickers';
const CAL_KEY = 'tonuino-studio:calibration';
const LOGO_KEY = 'sticker-logo';
/** Printer name for calibrations; families rarely have more than one printer. */
const PRINTER = 'standard';

export const DEFAULT_DESIGN: StickerDesign = {
  // Like a cassette of a Hörspiel, quer (Frank, 13.10.2026: „Standard ist Hörspiel quer“); the shelf shows the same.
  style: 'tape',
  orientation: 'landscape',
  // The album's whole cover, nothing cut off (Frank, 17.10.2026: „sollte nicht auch der Standard sein, dass er das gesamte Bild vom Album zeigt?“).
  wholePicture: true,
  font: 'round',
  // The title fills the flap next to the cover of "Kassette" (Frank, 17.10.2026: „Titel rein“).
  showTitle: true,
  darken: false,
  showNumber: true,
  logo: 'tonuino',
  logoText: 'TonUINO',
  logoTint: true,
};

const DEFAULT_PRINT: PrintSetup = { templateId: 'herma-5028', cutMarks: null };

function load(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Stored> | null;
    if (raw) {
      const print: PrintSetup = { ...DEFAULT_PRINT, ...raw.print, custom: cleanCustomParams(raw.print?.custom) };
      // An own size saved before its id said the kind of paper: still the one chosen.
      const own = ownTemplateOf(print.custom);
      if (own && print.templateId === legacyCustomTemplateId(own)) print.templateId = own.id;
      if (!resolveTemplate(print)) print.templateId = DEFAULT_PRINT.templateId;
      const design = { ...DEFAULT_DESIGN, ...raw.design };
      // A style that is gone ("Farbig" until 0.5 becomes "Kassette", "Hell" until 0.4 "Klassisch"), and is saved so.
      const style = knownStyle(design.style);
      // The wordmark "TonUINO" stood in for the official logo until it was allowed (0.5): now the logo itself.
      const logo = design.logo === 'text' && design.logoText.trim() === 'TonUINO' ? 'tonuino' : design.logo;
      if (style !== design.style || logo !== design.logo) {
        design.style = style;
        design.logo = logo;
        save({ design, print });
      }
      return { design, print };
    }
  } catch {
    // Blocked storage: defaults.
  }
  return { design: { ...DEFAULT_DESIGN }, print: { ...DEFAULT_PRINT } };
}

/** The chosen paper: a built-in template or the user's own size. */
function resolveTemplate(print: PrintSetup): LabelTemplate | undefined {
  const own = ownTemplateOf(print.custom);
  return own && own.id === print.templateId ? own : getTemplate(print.templateId);
}

const initial = load();
export const design = signal<StickerDesign>(initial.design);
export const printSetup = signal<PrintSetup>(initial.print);

function save(stored: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Not saved; the settings still apply for this visit.
  }
}

function persist() {
  save({ design: design.value, print: printSetup.value });
}

export function updateDesign(patch: Partial<StickerDesign>) {
  design.value = { ...design.value, ...patch };
  persist();
}

export function updatePrint(patch: Partial<PrintSetup>) {
  const changedTemplate = patch.templateId !== undefined && patch.templateId !== printSetup.value.templateId;
  printSetup.value = { ...printSetup.value, ...patch, ...(changedTemplate ? { cutMarks: null } : {}) };
  if (changedTemplate) usedSlots.value = [];
  persist();
}

/** "Weißer Rand" for the paper `templateId`. */
export function setMargin(templateId: string, marginMm: number) {
  updatePrint({ margins: { ...printSetup.value.margins, [templateId]: marginMm } });
}

export const template = computed<LabelTemplate>(() => resolveTemplate(printSetup.value) ?? BUILTIN_TEMPLATES[0]);

/** The user's own size as a template, chosen or not. */
export const ownTemplate = computed<LabelTemplate | undefined>(() => ownTemplateOf(printSetup.value.custom));

export const printOptions = computed(() => {
  const t = template.value;
  const d = defaultPrintOptions(t);
  const marks = printSetup.value.cutMarks ?? (d.cutMarks || d.cutLines);
  const marginMm = chosenMargin(printSetup.value.margins, t);
  // With a white margin nothing is printed past the motif: no bleed.
  return { bleedMm: marginMm > 0 ? 0 : d.bleedMm, marginMm, cutMarks: t.label.shape === 'rect' && marks, cutLines: t.label.shape === 'round' && marks, marksDefault: d.cutMarks || d.cutLines };
});

/** Labels on the first sheet that are gone already (0-based); only for this visit. */
export const usedSlots = signal<number[]>([]);

export function toggleUsedSlot(slot: number) {
  const s = new Set(usedSlots.value);
  if (s.has(slot)) s.delete(slot);
  else s.add(slot);
  usedSlots.value = [...s].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ calibration */

function loadCalibrations(): CalibrationStore {
  let store: CalibrationStore;
  try {
    store = (JSON.parse(localStorage.getItem(CAL_KEY) ?? '{}') as CalibrationStore) ?? {};
  } catch {
    return {};
  }
  // The correction for an own size saved under its old id (see legacyCustomTemplateId) moves along.
  const own = ownTemplateOf(initial.print.custom);
  const legacy = own && legacyCustomTemplateId(own);
  if (own && legacy) {
    const from = calibrationKey(PRINTER, legacy);
    const to = calibrationKey(PRINTER, own.id);
    if (store[from] && !store[to]) store = { ...store, [to]: store[from] };
  }
  return store;
}

export const calibrations = signal<CalibrationStore>(loadCalibrations());

export const calibration = computed<Calibration>(() => getCalibration(calibrations.value, PRINTER, template.value.id));

/** The printer correction for a paper other than the chosen one (Werkstatt › Tasten-Sticker prints round stickers). */
export function calibrationFor(templateId: string): Calibration {
  return getCalibration(calibrations.value, PRINTER, templateId);
}

export function saveCalibration(templateId: string, cal: Calibration) {
  calibrations.value = setCalibration(calibrations.value, PRINTER, templateId, cal);
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify(calibrations.value));
  } catch {
    // Kept for this visit.
  }
}

/* ------------------------------------------------------------------ logo picture */

export interface LogoImage {
  data: Uint8Array;
  type: string;
  name: string;
}

export const logoImage = signal<LogoImage | null>(null);
let logoLoaded = false;

export async function loadLogoImage(): Promise<void> {
  if (logoLoaded) return;
  logoLoaded = true;
  const stored = await kv.get<LogoImage>(LOGO_KEY);
  if (stored?.data) logoImage.value = stored;
}

export async function setLogoImage(img: LogoImage | null): Promise<void> {
  logoImage.value = img;
  if (img) await kv.set(LOGO_KEY, img);
  else await kv.delete(LOGO_KEY);
}
