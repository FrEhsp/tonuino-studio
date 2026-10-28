import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { LucideIcon } from 'lucide-preact';
// Only for the sample sticker: its glyph is drawn onto the sticker like those of the special cards.
import { Image as ImageIcon } from 'lucide-preact';
import type { BackMode } from '../../core/stickers/backside';
import { describeCalibration, isIdentityCalibration } from '../../core/stickers/calibration';
import { compactLogoFits, isCompact, type StickerStyle } from '../../core/stickers/layout';
import { sniffImageType } from '../../core/stickers/image';
import { marginChoices } from '../../core/stickers/margin';
import { slotsPerSheet } from '../../core/stickers/slots';
import { BUILTIN_TEMPLATES, getTemplate, type LabelTemplate } from '../../core/stickers/templates';
import { softHyphens } from '../../core/stickers/text';
import type { ByteSource } from '../../platform/types';
import { Button, Callout, Field, IconButton, Progress, Segmented } from '../../ui/components/controls';
import { PenCheck } from '../../ui/components/Hand';
import { PhoneFold } from '../../ui/components/PhoneFold';
import { Bild, Drucker, Hinweis, Kreuz, Links, Lupe, Muelleimer, Plus, Speichern, Stift, Weiter, Winkel } from '../../ui/icons';
import { Cover, inkOn } from '../../ui/components/Cover';
import { Dialog } from '../../ui/components/Dialog';
import { toast, toastError, toastSaved } from '../../ui/components/Toast';
import { useFileDrop } from '../../ui/useFileDrop';
import { card, catalog, coverUrlFor, plat, selection, settings, shownMemory, stickerToEdit } from '../../app/state';
import { plural } from '../../app/format';
import { cardItems, isSelected, selectAll, setSelected, type CardItem } from '../cards/items';
import { RememberedBoxes, RememberedNote } from '../box/Remembered';
import { SpecialCardDialog } from '../cards/SpecialCardDialog';
import type { BulkTarget } from '../../core/stickers/bulkcover';
import { BulkCoverDialog, useCoverless } from './BulkCoverDialog';
import { CoverSearch } from '../box/CoverSearch';
import { CalibrationDialog } from './CalibrationDialog';
import { FitCheckDialog, fitQuestion, fitQuestionAfterPrint, type FitQuestion } from './FitCheckDialog';
import { PaperCodeSearch } from './PaperCodeSearch';
import { CustomSizeDialog } from './CustomSizeDialog';
import { addLooseStickers, folderSticker, IMAGE_EXTENSIONS, imageBlobOf, isWordSticker, looseStickers, measurePictures, removeAllLooseStickers, removeFromSheet, removeLooseSticker, setLooseSelected, stickerFromCard, stickerItems, type LooseSticker, type StickerItem } from './content';
import { restoreLooseStickers } from './looseStore';
import { loadPrinted, markPrinted, neverPrinted, printedRecord } from './printedStore';
import { calibration, changedDesign, design, loadLogoImage, logoImage, ownTemplate, printOptions, printSetup, setLogoImage, setMargin, template, toggleUsedSlot, updateDesign, updatePrint, usedSlots, type StickerDesign } from './design';
import { loadAllTitleFaces, STICKER_FONTS } from './fonts';
import { buildPdf, buildPhotoSheets, buildZip, printsBlurry, type Progress as JobProgress, type RenderSetup, type SheetSetup } from './pipeline';
import { canPrint, printDocument } from './print';
import { PrintChecklist, printedOnce, TrialDialog } from './PrintNotes';
import { SheetPreview, StickerThumb } from './Preview';
import { SheetDiagram } from './SheetDiagram';
import { StickerEditDialog } from './StickerEditDialog';
import { WordCardDialog } from './WordCardDialog';
import { backMode } from './backside';
import { BackSheetPreview } from './BackPreview';
import { placeSticker, placement, printPins, resetPlacement } from './placement';
import { keyHint, type CarryVia } from './sheetMove';
import { folderRuns, paperName, paperSize } from './summary';
import { motifOf } from './bildkarte';
import '../../ui/styles/stickers.css';
import { BackToWorkshop } from '../../ui/components/BackToWorkshop';

// In the order of STICKER_STYLES: "Kassette" right after "Klassisch".
const STYLES: { id: StickerStyle; name: string; text: string }[] = [
  { id: 'blur', name: 'Klassisch', text: 'Bild auf weichem Hintergrund' },
  { id: 'tape', name: 'Kassette', text: 'Wie eine Hörspielkassette' },
  { id: 'bild', name: 'Bildkarte', text: 'Ein Bild und ein Wort, auch für Karten ohne Cover' },
  { id: 'full', name: 'Vollbild', text: 'Bild bis zum Rand' },
];

const PAPER_GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Etikettenbogen', ids: ['herma-5028', 'labelident-85x55'] },
  { label: 'Zum Ausschneiden', ids: ['card-a4', 'film-a4', 'round-30', 'round-25'] },
  { label: 'Fotodrucker und Fotoservice', ids: ['selphy-card', 'photo-13x18', 'photo-sticker-82x57'] },
];

/** Up to this many sheets the pager shows each one as a small sheet; more get arrows. */
const MAX_MINIS = 8;

/** Shown in the style picker while nothing is selected and no card with covers is in. */
export const SAMPLE: StickerItem = {
  key: 'sample',
  title: 'Mein Hörspiel',
  subtitle: 'Folge 1',
  number: '01',
  icon: ImageIcon,
  flatColor: '#0e76bd',
};

/** With a card in and nothing chosen yet, its first folder with a cover shows the styles. */
export function cardSample(): StickerItem | undefined {
  const folders = catalog.value?.folders;
  if (!folders) return undefined;
  for (const name of Object.keys(folders).sort()) {
    const n = Number(name);
    if (Number.isInteger(n) && coverUrlFor(n)) return folderSticker(n, folders[name].title || name);
  }
  return undefined;
}

/**
 * "Sticker drucken" as a workbench (design B of 0.4.1): the tools on the
 * left in one column of fixed width (three questions, everything else under
 * "Mehr …"), the sheet on the right, as large as the column allows and
 * starting at the top. The page scrolls; the print buttons stay at the
 * bottom of the sheet while it does.
 */
export function StickerPage() {
  const items = stickerItems.value;
  const t = template.value;
  const d = design.value;
  const print = printOptions.value;
  const logo = logoImage.value;
  const used = usedSlots.value;
  // With backs, a Bildkarte names the source of its pictogram there, else on its front.
  const backs = backMode.value;
  const setup: RenderSetup = useMemo(() => ({ design: d, template: t, bleedMm: print.bleedMm, marginMm: print.marginMm, logo, back: backs }), [d, t, print.bleedMm, print.marginMm, logo, backs]);
  const perSheet = slotsPerSheet(t);
  // Which sticker on which label: in order, or as moved on the sheet (placement.ts).
  const { pages, moved } = placement.value;
  const [sheet, setSheet] = useState(0);
  const [editing, setEditing] = useState<StickerItem | null>(null);
  // Also for the remembered box: what is changed without the card goes onto it when it is open again (app/remembered.ts).
  const edit = (i: StickerItem) => setEditing(i);
  const [calibrating, setCalibrating] = useState(false);
  // „Sitzt es?“ (#128): asked once per printer and paper, right after the first print.
  const [fit, setFit] = useState<FitQuestion | null>(null);
  const [ownSize, setOwnSize] = useState(false);
  const [addSpecial, setAddSpecial] = useState(false);
  const [addWord, setAddWord] = useState(false);
  const [searchCover, setSearchCover] = useState(false);
  // "Welche Sticker?": the list of everything to choose from, in a dialog. Dialogs opened from it
  // (adjusting a sticker, covers, a special card) take its place for a while, then it comes back.
  const [picking, setPicking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [job, setJob] = useState<(JobProgress & { label: string }) | null>(null);
  // After "Erst auf Normalpapier probieren": the one question whether it fits.
  const [trialDone, setTrialDone] = useState(false);
  // Chosen folders without a cover: asked once per visit before the first file is saved.
  const coverless = useCoverless();
  const [coverAsked, setCoverAsked] = useState(false);
  const [askCovers, setAskCovers] = useState<{ targets: readonly BulkTarget[]; save: () => void; printing: boolean } | null>(null);
  const [findCovers, setFindCovers] = useState<readonly BulkTarget[] | null>(null);
  // "Mehr …" in the tool column; "ändern" beside the paper opens it at the paper.
  const [more, setMore] = useState(() => usedSlots.value.length > 0);
  const photo = t.output === 'jpeg';
  // Photo stickers: every sticker is its own picture, there are no sheets.
  const images = t.output === 'images';

  useEffect(() => {
    void loadLogoImage();
    void loadAllTitleFaces();
    void restoreLooseStickers();
    void loadPrinted();
  }, []);
  useEffect(() => setSheet((s) => Math.min(s, Math.max(0, pages.length - 1))), [pages.length]);
  // "Sticker anpassen" from a folder page: open that folder's sticker right away.
  const toEdit = stickerToEdit.value;
  useEffect(() => {
    if (toEdit === null) return;
    stickerToEdit.value = null;
    const own = cardItems.value.find((c) => c.key === `f${toEdit}`);
    if (own) setEditing(stickerFromCard(own));
  }, [toEdit]);
  // Picture sizes for the hint about pictures too small to print sharply.
  useEffect(() => void measurePictures(items), [items]);
  const blurry = items.filter((i) => printsBlurry(i, setup));
  const blurryKeys = new Set(blurry.map((i) => i.key));

  const { over, handlers } = useFileDrop((sources) => void addImages(sources));

  const page = pages[sheet] ?? new Array<StickerItem | null>(perSheet).fill(null);
  // A sticker is being carried: by pointer the small sheets of the pager turn the sheet.
  const [carrying, setCarrying] = useState<CarryVia | null>(null);
  // The print bar keeps its height while a sticker is carried: the line on how to put it down took the
  // place of the list for the print dialog, the bar got lower and its top jumped (TODO #83).
  const bar = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState<number | null>(null);
  const onCarry = (via: CarryVia | null) => {
    setBarHeight(via ? (bar.current?.offsetHeight ?? null) : null);
    setCarrying(via);
  };
  // Extra "Sticker-Rückseite": the preview shows the front or the back of the sheet.
  const back = backs;
  const [side, setSide] = useState<'front' | 'back'>('front');
  const backShown = back !== 'none' && side === 'back' ? back : undefined;

  const run = async (label: string, work: (progress: (p: JobProgress) => void) => Promise<void>, failed = 'Speichern hat nicht geklappt') => {
    setJob({ label, done: 0, total: items.length });
    try {
      await work((p) => setJob({ label, ...p }));
    } catch (e) {
      toastError(failed, e);
    } finally {
      setJob(null);
    }
  };

  const sheetSetup = (): SheetSetup => ({
    ...setup,
    usedSlots: used,
    pins: printPins.value,
    // Read when the file is made: the desktop app's print dialog chooses the printer first (TODO #128).
    calibration: () => calibration.value,
    cutMarks: print.cutMarks,
    cutLines: print.cutLines,
    title: catalog.value?.name ? `Sticker für ${catalog.value.name}` : 'TonUINO-Sticker',
    back,
  });
  const base = fileBase(catalog.value?.name, t);
  // Saved or sent to the printer: these folders count as printed (printedStore.ts).
  const printedNow = () => markPrinted(catalog.value?.id, cardItems.value.filter(isSelected));

  const savePrint = () =>
    run('Sticker werden gezeichnet', async (progress) => {
      if (images) {
        const zip = await buildZip(items, setup, progress);
        if (await plat().files.save(`${base}.zip`, zip)) {
          printedNow();
          toast.success('Bilder gespeichert', 'Entpacke die ZIP-Datei und lade die Bilder beim Fotoservice als Fotosticker hoch.');
        }
      } else if (photo) {
        const sheets = await buildPhotoSheets(items, sheetSetup(), progress);
        let saved = 0;
        for (const [i, blob] of sheets.entries()) {
          if (await plat().files.save(sheets.length > 1 ? `${base} Bogen ${i + 1}.jpg` : `${base}.jpg`, blob)) saved++;
        }
        if (saved) {
          printedNow();
          toastSaved(saved > 1 ? `${saved} Bilder gespeichert` : 'Bild gespeichert', 'Bestelle es als Abzug in 13 × 18 cm, ohne Rand.');
        }
      } else {
        const pdf = await buildPdf(items, sheetSetup(), progress);
        if (await plat().files.save(`${base}.pdf`, pdf)) {
          printedNow();
          toastSaved('PDF gespeichert', 'Drucke mit „Tatsächliche Größe“ (100 %), nicht „An Seite anpassen“.');
        }
      }
    });

  /** Straight to the print dialog, in real size (paper sheets only). */
  const printNow = () =>
    run('Sticker werden gezeichnet', async (progress) => {
      if (!(await sendToPrinter(sheetSetup(), progress))) return;
      printedNow();
      printedOnce();
      setFit(fitQuestionAfterPrint(template.value));
    }, 'Drucken hat nicht geklappt');

  /**
   * "Erst auf Normalpapier probieren": the real sheets with a thin outline
   * around every label, to hold against a label sheet before a sheet of
   * labels is spent. Fronts only, and nothing counts as printed.
   */
  const printTrial = () =>
    run('Probedruck wird gezeichnet', async (progress) => {
      if (await sendToPrinter({ ...sheetSetup(), outlines: true, back: 'none', title: 'Probedruck auf Normalpapier' }, progress)) setTrialDone(true);
    }, 'Drucken hat nicht geklappt');

  /** Resolves false when the user stopped in the app's own print dialog. */
  const sendToPrinter = (s: SheetSetup, progress: (p: JobProgress) => void) =>
    printDocument(plat(), {
      name: `${base}.pdf`,
      page: setup.template.page,
      twoSided: !!s.back && s.back !== 'none',
      pages: pages.length * (s.back && s.back !== 'none' ? 2 : 1),
      pdf: () => buildPdf(items, s, progress),
      pictures: () => buildPhotoSheets(items, s, progress),
    });

  const saveZip = () =>
    run('Einzelbilder werden gezeichnet', async (progress) => {
      // In the order of the sheets, as placed.
      const placed = pages.flat().filter((i): i is StickerItem => i !== null);
      const zip = await buildZip(placed, setup, progress);
      if (await plat().files.save(`${base} Einzelbilder.zip`, zip)) {
        printedNow();
        toastSaved('Einzelbilder gespeichert', setup.marginMm ? `Jeder Sticker als eigenes Bild, mit ${setup.marginMm}\u00a0mm weißem Rand.` : 'Jeder Sticker als eigenes Bild, mit Rand zum Beschneiden.');
      }
    });

  /** Saves, unless chosen folders have no cover yet: then it asks first (once). */
  const askingCovers = (save: () => void, printing = false) => () => {
    const bare = new Set(items.filter((i) => i.folder !== undefined && !i.picture).map((i) => i.folder));
    const targets = coverless.filter((c) => bare.has(c.folder));
    if (coverAsked || !targets.length) return save();
    setCoverAsked(true);
    setAskCovers({ targets, save, printing });
  };

  /** "ändern" beside the paper: "Mehr …" opens and shows the paper. */
  const changePaper = () => {
    setMore(true);
    requestAnimationFrame(() => document.getElementById('st-paper')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  // The page's one main button prints; without a printer here, saving is the main thing.
  const printsHere = !images && !photo && canPrint(plat());
  const none = !items.length || !!job;
  const zipLink = images ? null : (
    <button type="button" class="link-button" disabled={none} onClick={askingCovers(saveZip)}>
      Einzelbilder (ZIP)
    </button>
  );
  // Sheets of A4 and the like get the short list for the print dialog; a single sticker (SELPHY) only the size.
  const sizeNote = images || photo ? null : t.kind === 'single' ? <span class="soft print-bar-note">Druckgröße 100 %, nicht „An Seite anpassen“</span> : <PrintChecklist template={t} />;
  // Labels are dear: on a pre-cut sheet the first try goes on plain paper.
  const trialLink =
    printsHere && t.kind === 'die-cut' ? (
      <button type="button" class="link-button" disabled={none} onClick={printTrial}>
        Erst auf Normalpapier probieren
      </button>
    ) : null;
  // While a sticker is carried, the line in the print bar says how to put it down.
  const carryNote =
    carrying === 'keys' ? keyHint(pages.length) : carrying && pages.length > 1 ? 'Zu einem anderen Bogen? Halte den Sticker kurz über einen der kleinen Bögen oben.' : null;
  const childOpen = !!editing || !!findCovers || addSpecial || addWord || confirmRemove;

  return (
    <div class={`page sticker-bench ${items.length ? '' : 'is-empty'} ${over ? 'drop-over' : ''}`} {...handlers}>
      <header class="bench-head">
        <BackToWorkshop />
        <h1>Sticker drucken</h1>
        <p>Drei Fragen, dann drucken. Der Bogen zeigt genau, was aus dem Drucker kommt.</p>
      </header>

      <section class="bench-tools" aria-label="Einstellungen der Sticker">
        {card.value ? null : shownMemory.value ? <RememberedNote page="stickers" /> : <RememberedBoxes compact />}
        <div class="card bench-card">
          <WhichQuestion
            pages={pages.length}
            blurry={blurry}
            onPick={() => setPicking(true)}
            onEdit={edit}
            onFindCovers={setFindCovers}
            onAddImages={() => void pickImages()}
            onSearchCover={() => setSearchCover(true)}
            onAddSpecial={() => setAddSpecial(true)}
            onAddWord={() => setAddWord(true)}
          />
          <LookFold>
            <StyleQuestion setup={setup} sample={items[0] ?? cardSample() ?? SAMPLE} coverless={items.find((i) => !i.picture && motifOf(i))} />
            <TextQuestion />
          </LookFold>
          <MoreTools open={more} onToggle={setMore} onCalibrate={() => setCalibrating(true)} onOwnSize={() => setOwnSize(true)} onFitCheck={() => setFit(fitQuestion(template.value))} />
        </div>
        {items.length ? (
          <p class="bench-tip soft">
            {images ? 'Ein Sticker soll anders aussehen? Klicke ihn an.' : 'Ein Sticker soll anders aussehen? Klicke ihn im Bogen an. Ziehst du ihn auf ein anderes Etikett, wandert er dorthin.'}
          </p>
        ) : null}
      </section>

      <section class="bench-piece" aria-label="Vorschau">
        <div class="bench-piece-head">
          <div class="bench-piece-title">
            <h2>{images ? 'So sehen deine Sticker aus' : 'So sieht dein Bogen aus'}</h2>
            {/* The paper shows from the start, with what it is (audit 0.4 #13); it is changed under "Mehr …". */}
            <p class="soft paper-line">
              Papier: <b>{paperName(t)}</b>
              {paperSize(t, perSheet, images)} ·{' '}
              <button type="button" class="link-button" onClick={changePaper}>
                ändern
              </button>
            </p>
            {back !== 'none' && items.length ? (
              <div class="sheet-side">
                <Segmented<'front' | 'back'>
                  label="Seite des Bogens"
                  value={side}
                  options={[
                    { value: 'front', label: 'Vorderseite' },
                    { value: 'back', label: 'Rückseite' },
                  ]}
                  onChange={setSide}
                />
                {backShown ? <span class="soft">Die Rückseiten stehen spiegelverkehrt. Nach dem Wenden an der langen Kante liegt jede hinter ihrem Sticker.</span> : null}
              </div>
            ) : null}
          </div>
          {items.length ? (
            <SheetPager
              template={t}
              pages={pages}
              sheet={sheet}
              used={used}
              images={images}
              carrying={carrying === 'pointer'}
              onSheet={setSheet}
              reset={moved && !images ? resetPlacement : undefined}
            />
          ) : null}
        </div>

        {/* The sheet and its bar: the bar may lie over the sheet, never over the title and the paper line above it. */}
        <div class="bench-stage">
          <div class="bench-sheet">
            {backShown ? (
              <BackSheetPreview template={t} page={page} setup={setup} mode={backShown} />
            ) : (
              <SheetPreview
                template={t}
                pages={pages}
                sheet={sheet}
                used={used}
                setup={setup}
                onEdit={edit}
                onRemove={removeFromSheet}
                onToggleUsed={sheet === 0 && perSheet > 1 ? toggleUsedSlot : undefined}
                onPlace={images ? undefined : placeSticker}
                onSheet={setSheet}
                onCarry={onCarry}
              />
            )}
          </div>

          {/* The buttons stay at the bottom of the sheet while the page scrolls (design B). */}
          <div class="card print-bar" ref={bar} style={barHeight ? { minHeight: barHeight } : undefined}>
            {printsHere ? (
              <Button variant="primary" size="lg" icon={Drucker} disabled={none} onClick={askingCovers(printNow, true)}>
                Drucken
              </Button>
            ) : null}
            <Button variant={printsHere ? 'default' : 'primary'} size="lg" icon={Speichern} disabled={none} onClick={askingCovers(savePrint)}>
              {images ? 'Bilder speichern (ZIP)' : photo ? (pages.length > 1 ? 'Bilder speichern' : 'Bild speichern') : 'PDF speichern'}
            </Button>
            {job ? (
              <div class="print-bar-job">
                <span class="small">
                  {job.label}: {job.done} von {job.total}
                </span>
                <Progress value={job.done} max={Math.max(1, job.total)} label={job.label} />
              </div>
            ) : (
              <div class="print-bar-extra">
                {/* While carrying only the line on how to put it down, beside the buttons: the bar stays as it was. */}
                {carryNote ? null : zipLink}
                {carryNote ? null : trialLink}
                {carryNote ? <span class="print-bar-note carry-note">{carryNote}</span> : sizeNote && t.kind !== 'single' && !images && !photo ? <PrintChecklist template={t} inBar /> : sizeNote}
              </div>
            )}
          </div>
        </div>
        {/* Phones: the links and the note under the bar, which has room only for the two buttons. */}
        {trialLink || zipLink || sizeNote ? (
          <div class="print-extra-phone">
            {zipLink}
            {trialLink}
            {sizeNote}
          </div>
        ) : null}
      </section>

      {picking && !childOpen ? (
        <PickDialog
          blurry={blurryKeys}
          onClose={() => setPicking(false)}
          onEdit={edit}
          onFindCovers={setFindCovers}
          onRemoveAll={() => setConfirmRemove(true)}
          onAddSpecial={() => setAddSpecial(true)}
          onAddImages={() => void pickImages()}
          onAddWord={() => setAddWord(true)}
        />
      ) : null}
      {editing ? <StickerEditDialog item={editing} setup={setup} onClose={() => setEditing(null)} /> : null}
      {searchCover ? <LooseCoverDialog onClose={() => setSearchCover(false)} /> : null}
      {askCovers ? (
        <Dialog
          title={`${plural(askCovers.targets.length, 'Sticker hat', 'Sticker haben')} kein Cover`}
          onClose={() => setAskCovers(null)}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setAskCovers(null);
                  askCovers.save();
                }}
              >
                {askCovers.printing ? 'So drucken' : 'So speichern'}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setAskCovers(null);
                  setFindCovers(askCovers.targets);
                }}
              >
                Cover suchen
              </Button>
            </>
          }
        >
          <p>Cover suchen oder so {askCovers.printing ? 'drucken' : 'speichern'}? Ohne Cover bekommt der Sticker eine Farbfläche mit seiner Nummer.</p>
        </Dialog>
      ) : null}
      {confirmRemove ? <RemoveLooseDialog count={looseStickers.value.length} onClose={() => setConfirmRemove(false)} /> : null}
      {findCovers ? <BulkCoverDialog targets={findCovers} onClose={() => setFindCovers(null)} /> : null}
      {trialDone ? (
        <TrialDialog
          onClose={() => setTrialDone(false)}
          onPrint={() => {
            setTrialDone(false);
            askingCovers(printNow, true)();
          }}
        />
      ) : null}
      {fit ? <FitCheckDialog question={fit} onClose={() => setFit(null)} onAlign={() => setCalibrating(true)} /> : null}
      {calibrating ? <CalibrationDialog onClose={() => setCalibrating(false)} /> : null}
      {ownSize ? <CustomSizeDialog onClose={() => setOwnSize(false)} /> : null}
      {addSpecial ? <SpecialCardDialog onClose={() => setAddSpecial(false)} /> : null}
      {addWord ? <WordCardDialog onClose={() => setAddWord(false)} /> : null}
    </div>
  );
}

export async function pickImages() {
  try {
    const files = await plat().pickFiles({ multiple: true, extensions: IMAGE_EXTENSIONS });
    await addImages(files);
  } catch (e) {
    toastError('Die Bilder ließen sich nicht öffnen', e);
  }
}

export async function addImages(sources: ByteSource[]) {
  const images = sources.filter((s) => IMAGE_EXTENSIONS.includes(s.name.split('.').pop()?.toLowerCase() ?? ''));
  if (!images.length) {
    if (sources.length) toast.info('Keine Bilder dabei', 'Sticker gehen aus JPG-, PNG- oder WebP-Bildern.');
    return;
  }
  const files = await Promise.all(images.map(async (s) => ({ name: s.relativePath ?? s.name, blob: await imageBlobOf(s) })));
  const skipped = addLooseStickers(files.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true })).map((f) => ({ name: f.name.split('/').pop()!, blob: f.blob })));
  if (skipped) toast.info(skipped === 1 ? 'Ein Bild war schon da' : `${skipped} Bilder waren schon da`, 'Sie stehen schon in der Liste.');
}

export function fileBase(name: string | undefined, t: LabelTemplate): string {
  const box = (name ?? 'TonUINO').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return `Sticker ${box} (${t.name.replace(/\s*\(.*\)$/, '').replace(/[\\/:*?"<>|]+/g, ' ')})`;
}

/* ------------------------------------------------------------------ the paper line and the pager */

/**
 * Above the sheet: which one shows, each sheet as a small sheet to click,
 * its labels filled as on the big one. While a sticker is carried, holding
 * it over a small sheet turns to that sheet (sheetMove.ts, data-sheet-to).
 * Many sheets, or single pictures for a photo service, get arrows instead.
 */
function SheetPager({
  template: t,
  pages,
  sheet,
  used,
  images,
  carrying,
  onSheet,
  reset,
}: {
  template: LabelTemplate;
  pages: (StickerItem | null)[][];
  sheet: number;
  used: number[];
  images: boolean;
  carrying: boolean;
  onSheet: (n: number) => void;
  reset?: () => void;
}) {
  const count = Math.max(1, pages.length);
  const minis = !images && count > 1 && count <= MAX_MINIS;
  if (count === 1 && !reset) return null;
  return (
    <div class={`sheet-pager ${carrying ? 'flip-target' : ''}`}>
      <span class="soft sheet-count">
        {count > 1 ? (
          <>
            {images ? 'Sticker' : 'Bogen'} <b>{sheet + 1}</b> von {count}
          </>
        ) : null}
        {reset ? (
          <>
            {count > 1 ? ' · ' : null}
            <button type="button" class="link-button" onClick={reset}>
              Reihenfolge zurücksetzen
            </button>
          </>
        ) : null}
      </span>
      {minis ? (
        <div class="sheet-minis">
          {pages.map((p, i) => (
            <button
              type="button"
              class="sheet-mini"
              key={i}
              aria-label={`Bogen ${i + 1}`}
              aria-current={i === sheet ? 'true' : undefined}
              data-sheet-to={i}
              onClick={() => onSheet(i)}
            >
              <SheetDiagram template={t} height={44} used={i === 0 ? used : undefined} filled={p.map(Boolean)} />
            </button>
          ))}
        </div>
      ) : count > 1 ? (
        <div class="row tight sheet-arrows">
          <IconButton label={images ? 'Vorheriger Sticker' : 'Vorheriger Bogen'} icon={Links} size="sm" disabled={sheet === 0} onClick={() => onSheet(sheet - 1)} data-flip="-1" />
          <IconButton label={images ? 'Nächster Sticker' : 'Nächster Bogen'} icon={Weiter} size="sm" disabled={sheet >= count - 1} onClick={() => onSheet(sheet + 1)} data-flip="1" />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 1: which stickers */

/**
 * The first question in short: what is chosen and on how many sheets, and
 * "Ändern …" for the whole list. Without a card the own pictures and the
 * special cards are the way in, so their buttons stay in view here.
 */
function WhichQuestion({
  pages,
  blurry,
  onPick,
  onEdit,
  onFindCovers,
  onAddImages,
  onSearchCover,
  onAddSpecial,
  onAddWord,
}: {
  pages: number;
  blurry: StickerItem[];
  onPick: () => void;
  onEdit: (i: StickerItem) => void;
  onFindCovers: (targets: readonly BulkTarget[]) => void;
  onAddImages: () => void;
  onSearchCover: () => void;
  onAddSpecial: () => void;
  onAddWord: () => void;
}) {
  const items = cardItems.value;
  const loose = looseStickers.value;
  const t = template.value;
  const images = t.output === 'images';
  const folders = items.filter((i) => i.folder !== undefined);
  const chosen = items.filter(isSelected);
  const chosenFolders = chosen.filter((i) => i.folder !== undefined);
  const chosenSpecial = chosen.length - chosenFolders.length;
  const chosenLoose = loose.filter((l) => !l.off);
  const count = chosen.length + chosenLoose.length;
  const offer = items.length + loose.length;
  // "Cover suchen": the picked folders without a cover, or else every folder without one.
  const coverless = useCoverless();
  const picked = selection.value;
  const pickedCoverless = coverless.filter((c) => picked.has(c.folder));
  const coverTargets = pickedCoverless.length ? pickedCoverless : coverless;

  const what: string[] = [];
  if (chosenFolders.length) what.push(chosenFolders.length === folders.length && folders.length > 1 ? `Alle ${folders.length} Ordner` : plural(chosenFolders.length, 'Ordner', 'Ordner'));
  if (chosenSpecial) what.push(plural(chosenSpecial, 'Spezialkarte', 'Spezialkarten'));
  const chosenWords = chosenLoose.filter(isWordSticker).length;
  if (chosenLoose.length > chosenWords) what.push(plural(chosenLoose.length - chosenWords, 'eigenes Bild', 'eigene Bilder'));
  if (chosenWords) what.push(plural(chosenWords, 'Wortkarte', 'Wortkarten'));
  const which = chosenFolders.length ? folderRuns(chosenFolders.map((i) => i.folder!)) : chosenLoose.length ? chosenLoose.slice(0, 2).map((l) => l.title).join(', ') + (chosenLoose.length > 2 ? ' …' : '') : '';
  const amount = images ? plural(count, 'Bild', 'Bilder') : plural(Math.max(1, pages), 'Bogen', 'Bögen');

  return (
    <div class="bench-question" aria-labelledby="st-1">
      <h2 id="st-1" class="bench-q">
        <span class="bench-num">1</span> Welche Sticker?
      </h2>
      {offer ? (
        <div class="pick-summary">
          <div class="pick-summary-text">
            {count ? (
              <>
                <b>{what.join(', ').replace(/, ([^,]*)$/, ' und $1')}</b>
                <span class="soft">
                  {which ? `${which} · ` : null}
                  <span class="nowrap">{amount}</span>
                </span>
              </>
            ) : (
              <>
                <b>Noch keine ausgewählt</b>
                <span class="soft">{folders.length ? `${plural(folders.length, 'Ordner', 'Ordner')} auf der Karte` : plural(offer, 'Sticker', 'Sticker') + ' zur Auswahl'}</span>
              </>
            )}
          </div>
          <Button onClick={onPick}>{count ? 'Ändern …' : 'Auswählen …'}</Button>
        </div>
      ) : (
        <p class="soft">
          {card.value
            ? 'Auf der SD-Karte sind noch keine Ordner. Eigene Bilder gehen trotzdem.'
            : "Ohne SD-Karte geht's auch: Suche ein Cover oder ziehe eigene Bilder hierher. Aus dem Dateinamen wird der Titel, eine Zahl vorne wird die Nummer."}
        </p>
      )}
      {offer > 1 && !count ? (
        <button
          type="button"
          class="link-button pick-all"
          onClick={() => {
            selectAll(items, true);
            setLooseSelected(true);
          }}
        >
          {folders.length && !loose.length ? `Alle ${folders.length} Ordner nehmen` : 'Alle nehmen'}
        </button>
      ) : null}
      {/* Without a card, pictures and special cards are the way in; with one they are in the list. */}
      {!card.value || !offer ? (
        <div class="row wrap pick-add">
          {/* Without a card no folder has a cover to find, so the online search makes stickers of its own (TODO #76). */}
          {card.value ? null : (
            <Button icon={Lupe} onClick={onSearchCover}>
              Cover suchen
            </Button>
          )}
          <Button icon={Bild} onClick={onAddImages}>
            Bilder hinzufügen
          </Button>
          <Button icon={Plus} onClick={onAddSpecial}>
            Spezialkarte
          </Button>
          <Button icon={Stift} onClick={onAddWord}>
            Wort + Piktogramm
          </Button>
        </div>
      ) : null}
      {coverTargets.length ? (
        <p class="bench-hint">
          <Hinweis size={18} />
          <span>
            {pickedCoverless.length
              ? `${plural(pickedCoverless.length, 'ausgewählter Ordner hat', 'ausgewählte Ordner haben')} noch kein Cover.`
              : `${plural(coverless.length, 'Ordner hat', 'Ordner haben')} noch kein Cover.`}{' '}
            <button type="button" class="link-button" onClick={() => onFindCovers(coverTargets)}>
              Cover suchen
            </button>
          </span>
        </p>
      ) : null}
      {blurry.length ? <BlurryNote items={blurry} onEdit={onEdit} /> : null}
    </div>
  );
}

/** Stickers whose pictures are too small to print sharply, each a shortcut to "Sticker anpassen". */
function BlurryNote({ items, onEdit }: { items: StickerItem[]; onEdit: (i: StickerItem) => void }) {
  const shown = items.slice(0, 5);
  return (
    <p class="bench-hint warn">
      <Hinweis size={18} />
      <span>
        {items.length === 1 ? 'Ein Bild ist zu klein und wird unscharf gedruckt: ' : `${items.length} Bilder sind zu klein und werden unscharf gedruckt: `}
        {shown.map((item, n) => (
          <span key={item.key}>
            {n ? ', ' : null}
            <button type="button" class="inline-link" onClick={() => onEdit(item)}>
              {item.title}
            </button>
          </span>
        ))}
        {items.length > shown.length ? ` und ${items.length - shown.length} weitere` : null}. Klicke auf einen Namen, um ein größeres Bild zu wählen.
      </span>
    </p>
  );
}

/** In the pick list: the picture is too small to print sharply. Opens "Sticker anpassen". */
function BlurryBadge({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button type="button" class="badge warning blurry-badge" title="Das Bild ist zu klein und wird unscharf gedruckt." aria-label={`„${title}“: Bild zu klein, wird unscharf gedruckt. Anpassen`} onClick={onClick}>
      Bild zu klein
    </button>
  );
}

/** "Welche Sticker?" in full: every folder, special card and own picture to tick. */
export function PickDialog({
  blurry,
  onClose,
  onEdit,
  onFindCovers,
  onRemoveAll,
  onAddSpecial,
  onAddImages,
  onAddWord,
}: {
  /** Keys of stickers whose pictures are too small to print sharply. */
  blurry: ReadonlySet<string>;
  onClose: () => void;
  onEdit: (i: StickerItem) => void;
  onFindCovers: (targets: readonly BulkTarget[]) => void;
  onRemoveAll: () => void;
  onAddSpecial: () => void;
  onAddImages: () => void;
  onAddWord: () => void;
}) {
  const items = cardItems.value;
  const loose = looseStickers.value;
  const chosen = items.filter(isSelected).length + loose.filter((l) => !l.off).length;
  // "Alle" and "Keine" go for the cards and the own pictures alike.
  const all = items.length + loose.length > 0 && items.every(isSelected) && loose.every((l) => !l.off);
  // "Cover suchen": the picked folders without a cover, or else every folder without one.
  const coverless = useCoverless();
  const picked = selection.value;
  const pickedCoverless = coverless.filter((t) => picked.has(t.folder));
  const coverTargets = pickedCoverless.length ? pickedCoverless : coverless;
  // The new folders among many (audit 0.4 #11): only once something of this card was printed here, and not all of it.
  const fresh = neverPrinted(printedRecord.value, catalog.value?.id, items);
  const offerFresh = !!fresh?.length && fresh.length < items.filter((i) => i.folder !== undefined).length;
  const onlyFresh = offerFresh && items.every((i) => isSelected(i) === fresh.includes(i)) && loose.every((l) => l.off);
  return (
    <Dialog
      title="Welche Sticker?"
      width="wide"
      onClose={onClose}
      bodyClass="pick-dialog-body"
      footer={
        <Button variant="primary" onClick={onClose}>
          Fertig
        </Button>
      }
    >
      <div class="row wrap sticker-pick-head">
        <span class="soft">{chosen ? `${chosen} ausgewählt` : 'noch keine ausgewählt'}</span>
        <div class="spacer" />
        {items.length + loose.length > 1 ? (
          <button
            type="button"
            class="link-button"
            onClick={() => {
              selectAll(items, !all);
              setLooseSelected(!all);
            }}
          >
            {all ? 'Keine' : 'Alle'}
          </button>
        ) : null}
        {offerFresh && !onlyFresh ? (
          <button
            type="button"
            class="link-button"
            onClick={() => {
              selectAll(items, false);
              selectAll(fresh, true);
              setLooseSelected(false);
            }}
          >
            Noch nie gedruckt
          </button>
        ) : null}
      </div>
      {items.length || loose.length ? (
        <ul class="pick-list sticker-pick">
          {items.map((i) => (
            <PickRow item={i} key={i.key} blurry={blurry.has(i.key)} onEdit={onEdit} />
          ))}
          {loose.length ? (
            <li class="pick-group row">
              <span>{loose.every(isWordSticker) ? 'Wortkarten' : loose.some(isWordSticker) ? 'Eigene Bilder und Wortkarten' : 'Eigene Bilder'}</span>
              <div class="spacer" />
              <button type="button" class="link-button danger-link" onClick={onRemoveAll}>
                Alle entfernen
              </button>
            </li>
          ) : null}
          {loose.map((l) => (
            <LooseRow sticker={l} key={l.id} blurry={blurry.has(`l:${l.id}`)} onEdit={onEdit} />
          ))}
        </ul>
      ) : (
        <p class="soft">{card.value ? 'Auf der SD-Karte sind noch keine Ordner.' : 'Noch keine Sticker.'}</p>
      )}
      {coverTargets.length ? (
        <p class="bench-hint">
          <Hinweis size={18} />
          <span>
            {pickedCoverless.length
              ? `${plural(pickedCoverless.length, 'ausgewählter Ordner hat', 'ausgewählte Ordner haben')} noch kein Cover.`
              : `${plural(coverless.length, 'Ordner hat', 'Ordner haben')} noch kein Cover.`}{' '}
            <button type="button" class="link-button" onClick={() => onFindCovers(coverTargets)}>
              Cover suchen
            </button>
          </span>
        </p>
      ) : null}
      <div class="row wrap pick-add">
        <Button icon={Bild} onClick={onAddImages}>
          Bilder hinzufügen
        </Button>
        <Button icon={Plus} onClick={onAddSpecial}>
          Spezialkarte
        </Button>
        <Button icon={Stift} onClick={onAddWord}>
          Wort + Piktogramm
        </Button>
        {/* The same examples as under „Karten beschreiben“: the word alone said nothing (audit 0.4 #12). */}
        <span class="soft small">Schlummerkarte, Stopptanz, Kita-Modus, Admin-Karte …</span>
      </div>
    </Dialog>
  );
}

export function RemoveLooseDialog({ count, onClose }: { count: number; onClose: () => void }) {
  return (
    <Dialog
      title={`${plural(count, 'eigenes Bild', 'eigene Bilder')} entfernen?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="danger"
            icon={Muelleimer}
            onClick={() => {
              onClose();
              removeAllLooseStickers();
            }}
          >
            Entfernen
          </Button>
        </>
      }
    >
      <p>{count === 1 ? 'Ausschnitt, Text und Farbe gehen dabei verloren.' : 'Ausschnitt, Text und Farbe aller eigenen Bilder gehen dabei verloren.'}</p>
    </Dialog>
  );
}

function PickRow({ item, blurry, onEdit }: { item: CardItem; blurry: boolean; onEdit: (i: StickerItem) => void }) {
  const checked = isSelected(item);
  const id = `st-pick-${item.key}`;
  const sticker = stickerFromCard(item);
  return (
    <li class={`pick-row ${checked ? 'checked' : ''}`}>
      <input type="checkbox" class="pen-box" id={id} checked={checked} onChange={(e) => setSelected(item, e.currentTarget.checked)} />
      <label for={id} class="pick-main">
        <span class="pick-cover">
          {item.folder !== undefined ? (
            <Cover url={coverUrlFor(item.folder)} title={item.title} seed={item.folder} number={sticker.number} color={sticker.color} small />
          ) : (
            <span class="special-icon" style={{ background: sticker.flatColor, color: inkOn(sticker.flatColor) }}>
              <SpecialGlyph icon={sticker.icon} />
            </span>
          )}
        </span>
        <span class="pick-text">
          <span class="pick-title">
            {item.folder !== undefined ? <span class="pick-num">{String(item.folder).padStart(2, '0')}</span> : null}
            {softHyphens(sticker.title)}
          </span>
          {sticker.subtitle ? <span class="pick-desc">{sticker.subtitle}</span> : null}
        </span>
      </label>
      {checked && blurry ? <BlurryBadge title={sticker.title} onClick={() => onEdit(sticker)} /> : null}
      {checked ? <IconButton label={`„${sticker.title}“ anpassen`} icon={Stift} size="sm" variant="ghost" onClick={() => onEdit(sticker)} /> : null}
    </li>
  );
}

/** An own picture in the list: chosen or not, to adjust and to remove. */
function LooseRow({ sticker: l, blurry, onEdit }: { sticker: LooseSticker; blurry: boolean; onEdit: (i: StickerItem) => void }) {
  const checked = !l.off;
  const id = `st-pick-l-${l.id}`;
  const edit = () => {
    const s = stickerItems.value.find((x) => x.key === `l:${l.id}`);
    if (s) onEdit(s);
  };
  return (
    <li class={`pick-row ${checked ? 'checked' : ''}`}>
      <input type="checkbox" class="pen-box" id={id} checked={checked} onChange={(e) => setLooseSelected(e.currentTarget.checked, l.id)} />
      <label for={id} class="pick-main">
        <span class="pick-cover">
          <img class="cover-img" src={l.url} alt="" />
        </span>
        <span class="pick-text">
          <span class="pick-title">
            {l.number ? <span class="pick-num">{String(l.number).padStart(2, '0')}</span> : null}
            {softHyphens(l.title)}
          </span>
          <span class="pick-desc">Eigenes Bild</span>
        </span>
      </label>
      {checked && blurry ? <BlurryBadge title={l.title} onClick={edit} /> : null}
      {checked ? <IconButton label={`„${l.title}“ anpassen`} icon={Stift} size="sm" variant="ghost" onClick={edit} /> : null}
      <IconButton label={`„${l.title}“ entfernen`} icon={Kreuz} size="sm" variant="ghost" onClick={() => removeLooseSticker(l.id)} />
    </li>
  );
}

function SpecialGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size={18} strokeWidth={2.2} />;
}

/* ------------------------------------------------------------------ 2 and 3: style, what is on it */

function isCompactTemplate(t: LabelTemplate): boolean {
  return isCompact({ widthMm: t.label.widthMm, heightMm: t.label.heightMm, bleedMm: 0, safeMm: 0, shape: t.label.shape });
}

const shapeNameOf = (t: LabelTemplate) => (t.label.shape === 'round' ? 'Runde' : 'Quadratische');

/** The four styles as real small stickers, drawn by the renderer of the sheet. */
/**
 * `coverless`: a chosen card without a cover that has a motif (a Schlummerkarte, "Gute Nacht"): the
 * tile of Bildkarte shows it, as that is what the style is for.
 */
function StyleQuestion({ setup, sample, coverless }: { setup: RenderSetup; sample: StickerItem; coverless?: StickerItem }) {
  const d = design.value;
  const t = template.value;
  const compact = isCompactTemplate(t);
  return (
    <div class="bench-question" aria-labelledby="st-2">
      <h2 id="st-2" class="bench-q">
        <span class="bench-num">2</span> Welcher Stil?
      </h2>
      {compact ? (
        // Round and square stickers look the same in every style: nothing to choose.
        <div class="row compact-style">
          <StickerThumb item={sample} setup={setup} size={120} label="Beispiel" />
          <p class="soft">{shapeNameOf(t)} Sticker haben nur einen Stil. Das Bild füllt den ganzen Sticker, unten steht die Nummer.</p>
        </div>
      ) : (
        <div class="style-grid" role="radiogroup" aria-label="Stil">
          {STYLES.map((s) => (
            <button type="button" role="radio" aria-checked={d.style === s.id} class="style-choice" key={s.id} title={s.text} onClick={() => updateDesign({ style: s.id })}>
              <StickerThumb item={s.id === 'bild' && coverless ? coverless : sample} setup={{ ...setup, design: changedDesign(d, { style: s.id }) }} size={136} fluid label={`Beispiel: ${s.name}`} />
              <span class="style-name">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Phones: style and text, set once, in one line with „ändern“ (handy-regeln.md, rule 8); elsewhere as they are. */
function LookFold({ children }: { children: ComponentChildren }) {
  const d = design.value;
  const compact = isCompactTemplate(template.value);
  const text = compact ? (d.showNumber ? 'Bild und Nummer' : 'nur Bild') : d.showTitle && d.showNumber ? 'Titel und Nummer' : d.showTitle ? 'nur Titel' : d.showNumber ? 'nur Nummer' : 'ohne Text';
  return (
    <PhoneFold
      label="Stil und Text"
      summary={
        <>
          <span class="bench-num">2</span>
          <span class="ellipsis">
            {compact ? shapeNameOf(template.value) : STYLES.find((s) => s.id === d.style)?.name} · {text}
          </span>
        </>
      }
    >
      {children}
    </PhoneFold>
  );
}

function TextQuestion() {
  const d = design.value;
  const t = template.value;
  const compact = isCompactTemplate(t);
  return (
    <div class="bench-question" aria-labelledby="st-3">
      <h2 id="st-3" class="bench-q">
        <span class="bench-num">3</span> Was steht drauf?
      </h2>
      <div class="row wrap bench-checks">
        {compact ? null : (
          <PenCheck checked={d.showTitle} onChange={(v) => updateDesign({ showTitle: v })}>
            Titel
          </PenCheck>
        )}
        <PenCheck checked={d.showNumber} onChange={(v) => updateDesign({ showNumber: v })}>
          Nummer
        </PenCheck>
      </div>
      {compact ? <p class="soft small">{shapeNameOf(t)} Sticker zeigen nur Bild und Nummer, ohne Titel.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Mehr …: everything else */

/**
 * What is set once and then rarely touched: format, picture, font, logo,
 * the paper, labels already gone, aligning the printer and the backs. In
 * the controls of 0.3.1 (switches of two or three, tiles, ticks).
 */
function MoreTools({ open, onToggle, onCalibrate, onOwnSize, onFitCheck }: { open: boolean; onToggle: (open: boolean) => void; onCalibrate: () => void; onOwnSize: () => void; onFitCheck: () => void }) {
  const t = template.value;
  const cal = calibration.value;
  const calibrated = !isIdentityCalibration(cal);
  const backs = settings.value.stickerBacks;
  const what = ['Format', 'Schrift', 'Logo', 'Papier', ...(backs ? ['Rückseite'] : []), ...(t.output === 'images' ? [] : ['Ausrichten'])];
  const margin = printOptions.value.marginMm;
  return (
    <div class={`bench-more ${open ? 'open' : ''}`}>
      <button type="button" class="bench-more-toggle" aria-expanded={open} aria-controls="st-more" onClick={() => onToggle(!open)}>
        <Winkel size={20} strokeWidth={2.4} class="bench-more-arrow" aria-hidden="true" />
        <span>
          <b>Mehr …</b> <span class="soft">{what.join(', ')}</span>
          {calibrated ? <span class="soft"> · Drucker-Korrektur an</span> : null}
          {margin ? <span class="soft"> · Weißer Rand {margin} mm</span> : null}
        </span>
      </button>
      {open ? (
        <div class="bench-more-body" id="st-more">
          <LookMore />
          <PaperMore onCalibrate={onCalibrate} onOwnSize={onOwnSize} onFitCheck={onFitCheck} />
        </div>
      ) : null}
    </div>
  );
}

function LookMore() {
  const d = design.value;
  const t = template.value;
  const logo = logoImage.value;
  const compact = isCompactTemplate(t);

  const uploadLogo = async () => {
    try {
      const [file] = await plat().pickFiles({ multiple: false, extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp'] });
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) throw new Error('Das Bild ist größer als 5 MB. Nimm eine kleinere Datei.');
      const data = await file.read(0, file.size);
      const svg = file.name.toLowerCase().endsWith('.svg');
      const type = svg ? 'image/svg+xml' : sniffImageType(data);
      if (!type) throw new Error('Das ist kein Bild, das ich lesen kann. Nimm PNG, SVG oder JPG.');
      await setLogoImage({ data, type, name: file.name });
      updateDesign({ logo: 'image' });
    } catch (e) {
      toastError('Das Logo ließ sich nicht laden', e);
    }
  };

  return (
    <>
      {!compact ? (
        <Field label="Format" hint={d.orientation === 'auto' ? 'Bilder im Hochformat bekommen einen hohen Sticker, alle anderen einen breiten.' : undefined}>
          <Segmented<StickerDesign['orientation']>
            label="Format"
            value={d.orientation}
            options={[
              { value: 'landscape', label: 'Quer' },
              { value: 'portrait', label: 'Hochkant' },
              { value: 'auto', label: 'Wie das Bild' },
            ]}
            onChange={(v) => updateDesign({ orientation: v })}
          />
        </Field>
      ) : null}

      {/* Vollbild always fills the sticker (render.ts designZoom), Bildkarte shows the whole cover in its square: nothing to choose there. */}
      {d.style !== 'full' && d.style !== 'bild' ? (
        <Field label="Bild" hint={d.wholePicture ? 'Nichts wird abgeschnitten. Ist ein Bild nicht quadratisch, bleibt daneben etwas Hintergrund.' : undefined}>
          <Segmented<'cut' | 'whole'>
            label="Bild"
            value={d.wholePicture ? 'whole' : 'cut'}
            options={[
              { value: 'cut', label: 'Zugeschnitten' },
              { value: 'whole', label: 'Ganz gezeigt' },
            ]}
            onChange={(v) => updateDesign({ wholePicture: v === 'whole' })}
          />
        </Field>
      ) : null}

      {d.style === 'full' && d.showTitle && !compact ? (
        <Field label="Titel auf dem Bild" hint={d.darken ? 'Bei hellen Bildern bleibt der Farbbalken.' : undefined}>
          <Segmented<'bar' | 'dark'>
            label="Titel auf dem Bild"
            value={d.darken ? 'dark' : 'bar'}
            options={[
              { value: 'bar', label: 'Farbbalken' },
              { value: 'dark', label: 'Bild abgedunkelt' },
            ]}
            onChange={(v) => updateDesign({ darken: v === 'dark' })}
          />
        </Field>
      ) : null}

      <Field label="Schrift">
        <div class="font-choices" role="radiogroup" aria-label="Schrift">
          {STICKER_FONTS.map((f) => (
            <button type="button" role="radio" aria-checked={d.font === f.id} class="font-choice" key={f.id} title={f.name} onClick={() => updateDesign({ font: f.id })}>
              <span class="font-sample" style={{ fontFamily: `'${f.title.family}', sans-serif`, fontWeight: f.title.weight }}>
                Mond 01
              </span>
              <span class="small soft">{f.name}</span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Logo">
        <div class="stack">
          <Segmented<'none' | 'tonuino' | 'text' | 'image'>
            label="Logo"
            value={d.logo}
            options={[
              { value: 'none', label: 'Ohne' },
              { value: 'tonuino', label: 'TonUINO' },
              { value: 'text', label: 'Schriftzug' },
              { value: 'image', label: 'Eigenes Bild' },
            ]}
            onChange={(v) => (v === 'image' && !logo ? void uploadLogo() : updateDesign({ logo: v }))}
          />
          {d.logo === 'text' ? (
            <input class="input logo-text" value={d.logoText} maxLength={24} aria-label="Text des Schriftzugs" placeholder="z. B. TonUINO oder Emmas Box" onInput={(e) => updateDesign({ logoText: e.currentTarget.value })} />
          ) : null}
          {d.logo === 'image' && logo ? (
            <div class="row wrap logo-file">
              <span class="small">{logo.name}</span>
              <Button size="sm" variant="ghost" onClick={() => void uploadLogo()}>
                Anderes Bild
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void setLogoImage(null);
                  updateDesign({ logo: 'none' });
                }}
              >
                Entfernen
              </Button>
            </div>
          ) : null}
          {d.logo === 'image' ? (
            <PenCheck checked={d.logoTint} onChange={(v) => updateDesign({ logoTint: v })}>
              Logo einfärben: weiß auf dunklem Grund, dunkel auf hellem (nur bei durchsichtigem PNG oder SVG)
            </PenCheck>
          ) : null}
          {compact && d.logo !== 'none' && !compactLogoFits(t.label) ? <span class="field-hint">Auf {t.label.shape === 'round' ? 'runden' : 'so kleinen'} Stickern ist kein Platz für ein Logo.</span> : null}
        </div>
      </Field>
    </>
  );
}

export function PaperMore({ onCalibrate, onOwnSize, onFitCheck }: { onCalibrate: () => void; onOwnSize: () => void; onFitCheck?: () => void }) {
  const t = template.value;
  const own = ownTemplate.value;
  const print = printOptions.value;
  const used = usedSlots.value;
  const cal = calibration.value;
  const multi = slotsPerSheet(t) > 1;
  const cutting = t.kind === 'cut-yourself' || t.kind === 'photo';
  // Single pictures for a photo service: nothing to align or mark.
  const images = t.output === 'images';
  const calibrated = !isIdentityCalibration(cal);
  const margins = marginChoices(t.label);
  return (
    <>
      <div class="field bench-paper" id="st-paper">
        <span class="field-label" id="st-paper-label">
          Papier
        </span>
        <div class="paper-list" role="radiogroup" aria-labelledby="st-paper-label">
          {PAPER_GROUPS.map((g) => (
            <div class="paper-group" key={g.label}>
              <span class="section-title">{g.label}</span>
              {g.ids
                .map((id) => getTemplate(id) ?? BUILTIN_TEMPLATES[0])
                .map((p) => (
                  <PaperOption template={p} checked={p.id === t.id} key={p.id} />
                ))}
            </div>
          ))}
          {own ? (
            <div class="paper-group">
              <span class="section-title">Eigene Größe</span>
              <PaperOption template={own} checked={own.id === t.id} />
            </div>
          ) : null}
        </div>
        <div class="row wrap own-size-row">
          <Button icon={own ? Stift : Plus} onClick={onOwnSize}>
            {own ? 'Eigene Größe ändern' : 'Eigene Größe eingeben'}
          </Button>
          <span class="soft small">Für Etiketten und Fotosticker, die oben fehlen.</span>
        </div>
        <PaperCodeSearch onOwnSize={onOwnSize} />
      </div>

      {t.notes ? <Callout tone="neutral">{t.notes}</Callout> : null}
      {!t.verified ? (
        <Callout tone="warning">
          {images
            ? 'Die Maße sind noch nicht mit echten Fotostickern geprüft, und jeder Fotoservice schneidet etwas anders. Steht im Bestellformular eine andere Größe, gib sie unter „Eigene Größe“ ein.'
            : 'Die Maße dieser Vorlage sind noch nicht mit einem echten Bogen geprüft. Drucke zuerst die Testseite unter „Drucker ausrichten“.'}
        </Callout>
      ) : null}

      {cutting ? (
        <PenCheck checked={print.cutMarks || print.cutLines} onChange={(v) => updatePrint({ cutMarks: v })}>
          {t.label.shape === 'round' ? 'Dünne Kreise zum Ausschneiden drucken' : 'Schnittmarken an die Ecken drucken'}
        </PenCheck>
      ) : null}

      {multi ? (
        <Field label="Fehlen auf deinem Bogen schon Etiketten?" hint={used.length ? `${plural(used.length, 'Etikett bleibt', 'Etiketten bleiben')} frei.` : 'Klicke sie an, dann bleiben sie beim Druck frei.'}>
          <div class="used-picker">
            <SheetDiagram template={t} used={used} onToggle={toggleUsedSlot} />
          </div>
        </Field>
      ) : null}

      {margins.length > 1 ? (
        <Field
          label="Weißer Rand"
          hint={
            print.marginMm && printSetup.value.margins?.[t.id] === undefined
              ? `Die Etiketten liegen hier dicht an dicht, darum ist ${print.marginMm}\u00a0mm voreingestellt.`
              : print.marginMm
                ? `Rundherum bleiben ${print.marginMm}\u00a0mm weiß. Verrutscht ein Sticker um bis zu ${print.marginMm}\u00a0mm, landet trotzdem nichts auf dem Nachbarn.`
                : 'Hilft, wenn der Drucker manche Sticker ein Stück daneben setzt.'
          }
        >
          <Segmented<number>
            label="Weißer Rand"
            value={print.marginMm}
            options={margins.map((m) => ({ value: m, label: m ? `${m} mm` : 'Ohne' }))}
            onChange={(m) => setMargin(t.id, m)}
          />
        </Field>
      ) : null}

      {images ? null : (
        <Field label="Drucker ausrichten">
          <div class="row wrap calibrate-row">
            <Button onClick={onCalibrate}>Drucker ausrichten</Button>
            <span class="soft small">{calibrated ? `Korrektur aktiv: ${describeCalibration(cal)}.` : 'Druckt dein Drucker etwas daneben? Mit einer Testseite gleichst du das aus.'}</span>
          </div>
          {onFitCheck && t.output === 'pdf' ? (
            <p class="soft small">
              Sitzen die gedruckten Sticker nicht auf den Etiketten?{' '}
              <button type="button" class="link-button" onClick={onFitCheck}>
                Beschreiben, was nicht passt
              </button>
            </p>
          ) : null}
        </Field>
      )}

      {settings.value.stickerBacks ? <BackChoice template={t} /> : null}
    </>
  );
}

/** Extra "Sticker-Rückseite": what goes on the back, and how to print on both sides. */
function BackChoice({ template: t }: { template: LabelTemplate }) {
  const value = printSetup.value.back ?? 'none';
  if (t.output !== 'pdf') {
    return <p class="soft small">Rückseiten gibt es nur, wenn du selbst auf Papier druckst, nicht beim Fotoservice.</p>;
  }
  return (
    <Field label="Rückseite" hint="Für jeden Sticker eine Rückseite mit dem, was seine Karte spielt.">
      <div class="stack tight">
        <Segmented<BackMode>
          label="Rückseite"
          value={value}
          options={[
            { value: 'none', label: 'Keine' },
            { value: 'list', label: 'Titelliste' },
            { value: 'qr', label: 'QR-Code' },
          ]}
          onChange={(back) => updatePrint({ back })}
        />
        {value !== 'none' ? (
          <Callout tone={t.kind === 'die-cut' ? 'warning' : 'neutral'}>
            <b>Beidseitig drucken.</b> Auf jeden Bogen folgt ein Bogen mit den Rückseiten. Stelle im Druckdialog „Beidseitig“ ein und wende an der langen Kante. Kann
            dein Drucker das nicht, drucke erst die ungeraden Seiten, lege das Papier gewendet wieder ein und drucke dann die geraden. Probiere es zuerst mit Normalpapier.
            {t.kind === 'die-cut' ? ' Auf Etikettenbögen landet die Rückseite auf dem Trägerpapier. Nimm lieber Papier oder Fotopapier zum Ausschneiden.' : ''}
          </Callout>
        ) : null}
      </div>
    </Field>
  );
}

function PaperOption({ template: p, checked }: { template: LabelTemplate; checked: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={checked} class="paper-option" onClick={() => updatePrint({ templateId: p.id })}>
      <SheetDiagram template={p} height={46} />
      <span class="paper-text">
        <span class="paper-name">{p.name}</span>
        <span class="paper-desc">{p.description}</span>
      </span>
    </button>
  );
}

/**
 * „Cover suchen“ without a card (TODO #76): each picked cover becomes an own
 * picture named after the album, as if it had been dragged in. The dialog
 * stays open, so a series is found one cover after the other.
 */
export function LooseCoverDialog({ onClose }: { onClose: () => void }) {
  const [added, setAdded] = useState<string[]>([]);
  return (
    <Dialog title="Cover suchen" width="wide" bodyClass="cover-dialog-body" onClose={onClose} footer={<Button onClick={onClose}>{added.length ? 'Fertig' : 'Schließen'}</Button>}>
      <div class="stack cover-dialog">
        <p class="soft">
          {added.length ? `Auf dem Bogen: ${added.map((t) => `„${t}“`).join(', ')}. Noch eins? Suche einfach weiter.` : 'Jedes Cover, das du wählst, kommt als Sticker auf den Bogen. Titel und Nummer änderst du danach mit einem Klick auf den Sticker.'}
        </p>
        <div class="cover-dialog-main">
          <div class="cover-dialog-pick">
            <CoverSearch
              initialQuery=""
              onPick={(blob, _source, _kind, hit) => {
                const title = hit.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Cover';
                if (addLooseStickers([{ name: `${title}.jpg`, blob }])) toast.info('Dieses Cover ist schon da', 'Es steht schon auf dem Bogen.');
                else setAdded((a) => [...a, title]);
              }}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
