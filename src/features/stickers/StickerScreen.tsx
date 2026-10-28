/**
 * „Sticker drucken“ (0.6, 06-entwuerfe 3-sticker-*): the sheet as big as the
 * window allows, three questions beside it, and „Drucken“. The folders that
 * never got a sticker are chosen to begin with; a click on an empty field of
 * the sheet marks it as used up, so printing starts behind it. Everything
 * else (text, logo, backs, calibration, own pictures …) stays on the full
 * sticker page under „Alle Einstellungen …“, with the same choices.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { StickerStyle } from '../../core/stickers/layout';
import { slotsPerSheet } from '../../core/stickers/slots';
import { Button } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { Screen } from '../../ui/components/Schlank';
import { toastError, toastSaved } from '../../ui/components/Toast';
import { useMedia } from '../../ui/useMedia';
import { plural } from '../../app/format';
import { routeToHash } from '../../app/router';
import { card, catalog, coverUrlFor, plat, shownMemory } from '../../app/state';
import { usePageShown } from '../../app/pageAlive';
import { cardItems, isSelected, selectAll } from '../cards/items';
import { SpecialCardDialog } from '../cards/SpecialCardDialog';
import { WordCardDialog } from './WordCardDialog';
import type { BulkTarget } from '../../core/stickers/bulkcover';
import { BulkCoverDialog, useCoverless } from './BulkCoverDialog';
import { autoCovers, openProposals, type AutoCoverProposal } from '../covers/autoCoverState';
import { ProposalsDialog } from '../covers/CoverOffer';
import { CalibrationDialog } from './CalibrationDialog';
import { FitCheckDialog, fitQuestion, fitQuestionAfterPrint, type FitQuestion } from './FitCheckDialog';
import { CustomSizeDialog } from './CustomSizeDialog';
import { isWordSticker, looseStickers, measurePictures, removeFromSheet, stickerItems, type StickerItem } from './content';
import { restoreLooseStickers } from './looseStore';
import { loadPrinted, markPrinted, neverPrinted, printedRecord } from './printedStore';
import { calibration, design, loadLogoImage, logoImage, printOptions, template, toggleUsedSlot, updateDesign, usedSlots } from './design';
import { loadAllTitleFaces } from './fonts';
import { buildPdf, buildPhotoSheets, buildZip, type Progress as JobProgress, type RenderSetup, type SheetSetup } from './pipeline';
import { canPrint, printDocument, printWay } from './print';
import { printedOnce, TrialDialog } from './PrintNotes';
import { SheetPreview } from './Preview';
import { StickerEditDialog } from './StickerEditDialog';
import { StickerBild } from './StickerBild';
import { backMode } from './backside';
import { placeSticker, placement, printPins } from './placement';
import { cardSample, fileBase, LooseCoverDialog, PaperMore, PickDialog, pickImages, RemoveLooseDialog, SAMPLE } from './StickerPage';
import { chosenLine, firstField, paperName, sheetLine } from './summary';
import '../../ui/styles/stickers.css';

/** The four looks as small real stickers, „Kassette“ first (Frank, 27.10.2026). */
const LOOKS: { id: StickerStyle; name: string }[] = [
  { id: 'tape', name: 'Kassette' },
  { id: 'blur', name: 'Klassisch' },
  { id: 'bild', name: 'Bildkarte' },
  { id: 'full', name: 'Vollbild' },
];

/** Cards whose folders were chosen here once already: the choice is the user's after that. */
const preselected = new Set<string>();

/** As the rule for a low window in schlank.css (.schirm-sticker). */
const LOW_QUERY = '(min-width: 901px) and (max-height: 940px)';
/** A low window under 1000 px wide: the four looks a little smaller, to stand in one row all the same. */
const NARROW_QUERY = '(max-width: 999px)';

/*
 * One column as on a phone (the sheet, the folded line, the questions in a dialog) up to 900 px, where
 * schlank.css stacks the screen: between 561 and 900 px the open questions squeezed the sheet to
 * nothing and it lay over them (Prüfrunde 3, M1).
 */
const ONE_COLUMN_QUERY = '(max-width: 900px)';

export function StickerScreen() {
  const items = stickerItems.value;
  const t = template.value;
  const d = design.value;
  const print = printOptions.value;
  const logo = logoImage.value;
  const used = usedSlots.value;
  const backs = backMode.value;
  const setup: RenderSetup = useMemo(() => ({ design: d, template: t, bleedMm: print.bleedMm, marginMm: print.marginMm, logo, back: backs }), [d, t, print.bleedMm, print.marginMm, logo, backs]);
  const perSheet = slotsPerSheet(t);
  const { pages } = placement.value;
  const [sheet, setSheet] = useState(0);
  const phone = useMedia(ONE_COLUMN_QUERY);
  // A laptop's low window: the four looks in one row beside a wider column (schlank.css, Prüfrunde 1 B2).
  const low = useMedia(LOW_QUERY);
  const narrow = useMedia(NARROW_QUERY);
  const [editing, setEditing] = useState<StickerItem | null>(null);
  const [picking, setPicking] = useState(false);
  const [paper, setPaper] = useState(false);
  const [folded, setFolded] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  // „Sitzt es?“ (#128): asked once per printer and paper, right after the first print.
  const [fit, setFit] = useState<FitQuestion | null>(null);
  const [ownSize, setOwnSize] = useState(false);
  const [addSpecial, setAddSpecial] = useState(false);
  const [addWord, setAddWord] = useState(false);
  const [searchCover, setSearchCover] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [findCovers, setFindCovers] = useState<readonly BulkTarget[] | null>(null);
  const [askCovers, setAskCovers] = useState<{ targets: readonly BulkTarget[]; save: () => void; printing: boolean } | null>(null);
  const [coverAsked, setCoverAsked] = useState(false);
  const [proposals, setProposals] = useState<{ folders: readonly number[]; rest: readonly BulkTarget[] } | null>(null);
  const [trialDone, setTrialDone] = useState(false);
  const [job, setJob] = useState<(JobProgress & { label: string }) | null>(null);
  const coverless = useCoverless();
  const photo = t.output === 'jpeg';
  const images = t.output === 'images';

  useEffect(() => {
    void loadLogoImage();
    void loadAllTitleFaces();
    void restoreLooseStickers();
    void loadPrinted();
  }, []);
  useEffect(() => setSheet((s) => Math.min(s, Math.max(0, pages.length - 1))), [pages.length]);
  useEffect(() => void measurePictures(items), [items]);
  usePreselect();

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
    calibration: calibration.value,
    cutMarks: print.cutMarks,
    cutLines: print.cutLines,
    title: catalog.value?.name ? `Sticker für ${catalog.value.name}` : 'TonUINO-Sticker',
    back: backs,
  });
  const base = fileBase(catalog.value?.name, t);
  const printedNow = () => markPrinted(catalog.value?.id, cardItems.value.filter(isSelected));
  const sendToPrinter = (s: SheetSetup, progress: (p: JobProgress) => void) =>
    printDocument(plat(), {
      name: `${base}.pdf`,
      page: setup.template.page,
      twoSided: !!s.back && s.back !== 'none',
      pages: pages.length * (s.back && s.back !== 'none' ? 2 : 1),
      pdf: () => buildPdf(items, s, progress),
      pictures: () => buildPhotoSheets(items, s, progress),
    });
  // The same three ways out as on the full sticker page, with the same words.
  const savePrint = () =>
    run('Sticker werden gezeichnet', async (progress) => {
      if (images) {
        const zip = await buildZip(items, setup, progress);
        if (await plat().files.save(`${base}.zip`, zip)) {
          printedNow();
          toastSaved('Bilder gespeichert', 'Entpacke die ZIP-Datei und lade die Bilder beim Fotoservice als Fotosticker hoch.');
        }
      } else if (photo) {
        const sheets = await buildPhotoSheets(items, sheetSetup(), progress);
        let saved = 0;
        for (const [i, blob] of sheets.entries()) if (await plat().files.save(sheets.length > 1 ? `${base} Bogen ${i + 1}.jpg` : `${base}.jpg`, blob)) saved++;
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
  const printNow = () =>
    run(
      'Sticker werden gezeichnet',
      async (progress) => {
        if (!(await sendToPrinter(sheetSetup(), progress))) return;
        printedNow();
        printedOnce();
        setFit(fitQuestionAfterPrint(template.value));
      },
      'Drucken hat nicht geklappt',
    );
  const printTrial = () =>
    run(
      'Probedruck wird gezeichnet',
      async (progress) => {
        if (await sendToPrinter({ ...sheetSetup(), outlines: true, back: 'none', title: 'Probedruck auf Normalpapier' }, progress)) setTrialDone(true);
      },
      'Drucken hat nicht geklappt',
    );
  const coverLineInView = () =>
    [...document.querySelectorAll('.ohne-cover')].some((e) => {
      const r = e.getBoundingClientRect();
      return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    });
  /** Saves, unless chosen folders have no cover yet: then it asks first (once). */
  const askingCovers = (save: () => void, printing = false) => () => {
    const bare = new Set(items.filter((i) => i.folder !== undefined && !i.picture).map((i) => i.folder));
    const targets = coverless.filter((c) => bare.has(c.folder));
    // The page line „… noch kein Cover“ in view already said it: no second ask (B15).
    if (coverAsked || !targets.length || coverLineInView()) return save();
    setCoverAsked(true);
    setAskCovers({ targets, save, printing });
  };

  const printsHere = !images && !photo && canPrint(plat());
  const none = !items.length || !!job;
  const trial = printsHere && t.kind === 'die-cut';
  const look = LOOKS.find((l) => l.id === d.style)?.name ?? 'Kassette';
  const sample = items[0] ?? cardSample() ?? SAMPLE;

  const big = (
    <SheetArea
      setup={setup}
      pages={pages}
      sheet={sheet}
      used={used}
      perSheet={perSheet}
      images={images}
      onSheet={setSheet}
      onEdit={setEditing}
    />
  );

  const saveLabel = images ? 'Bilder speichern' : photo ? (pages.length > 1 ? 'Bilder speichern' : 'Bild speichern') : 'PDF speichern';
  const fill = job ? <span class="done" style={{ width: `${Math.round((job.done / Math.max(1, job.total)) * 100)}%` }} /> : null;
  const jobLine = job ? `${job.label} … ${job.done} von ${job.total}` : '';
  const busy = job ? (
    <>
      {fill}
      <span class="lbl">{jobLine}</span>
    </>
  ) : null;
  // Beside a second button there is no room for the words: the button fills up, the words stand under it.
  const filling = (label: string) => (
    <>
      {fill}
      <span class="lbl">{label}</span>
    </>
  );

  const allSettings = (
    <a class="link-button mehr-link" href={routeToHash({ page: 'stickers' })}>
      Alle Einstellungen …
    </a>
  );

  const foot = phone ? (
    <>
      <Button variant="primary" class={`xl wide ${job ? 'laeuft' : ''}`} disabled={!items.length} aria-disabled={job ? 'true' : undefined} onClick={job ? undefined : askingCovers(printsHere ? printNow : savePrint, printsHere)}>
        {busy ?? (printsHere ? 'Drucken' : saveLabel)}
      </Button>
      <div class="unter">
        <span class="soft">Drucken mit 100 %</span>
        {trial ? (
          <button type="button" class="link-button" disabled={none} onClick={printTrial}>
            Erst auf Normalpapier
          </button>
        ) : null}
      </div>
    </>
  ) : (
    <>
      <div class="druck">
        {printsHere ? (
          <Button variant="primary" class={`xl ${job ? 'laeuft' : ''}`} disabled={!items.length} aria-disabled={job ? 'true' : undefined} onClick={job ? undefined : askingCovers(printNow, true)}>
            {job ? filling('Drucken') : 'Drucken'}
          </Button>
        ) : null}
        <Button variant={printsHere ? 'default' : 'primary'} class={`xl ${!printsHere && job ? 'laeuft' : ''}`} disabled={none && !(job && !printsHere)} onClick={job ? undefined : askingCovers(savePrint)}>
          {!printsHere && job ? filling(saveLabel) : saveLabel}
        </Button>
      </div>
      {job ? (
        <p class="hinweis" aria-live="polite">
          {jobLine}
        </p>
      ) : images || printWay(plat()) === 'system' ? null : (
        // The desktop app's own print dialog always prints at 100 %: the hint is for the browser's dialog only (Prüfrunde 2, bastler 16).
        <p class="hinweis">Druckgröße 100 %, nicht „Anpassen“.</p>
      )}
      {/* „Alle Einstellungen …“ in the part that never scrolls: at the end of the questions a low window hid it under „Drucken“ (Prüfrunde 2, eltern 2). */}
      <div class="unten-links">
        {trial ? (
          <button type="button" class="link-button probe" disabled={none} onClick={printTrial}>
            Erst auf Normalpapier probieren
          </button>
        ) : null}
        {allSettings}
      </div>
    </>
  );

  const questions = (
    <>
      <WhichQuestion used={used} perSheet={perSheet} images={images} onPick={() => setPicking(true)} onFindCovers={setFindCovers} onProposals={setProposals} onSearchCover={() => setSearchCover(true)} onAddSpecial={() => setAddSpecial(true)} onAddWord={() => setAddWord(true)} />
      <div class="frage">
        <h2>Wie sollen sie aussehen?</h2>
        <div class="stile" role="radiogroup" aria-label="Wie sollen sie aussehen?">
          {LOOKS.map((l) => (
            <button type="button" key={l.id} class="stil-wahl" role="radio" aria-checked={d.style === l.id} onClick={() => updateDesign({ style: l.id })}>
              <span class="mini">
                <StickerBild item={sample} widthPx={phone ? 140 : low ? (narrow ? 76 : 88) : 128} style={l.id} />
              </span>
              <span class="stil-name">{l.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div class="frage">
        <h2>Welches Papier?</h2>
        <p class="wert-zeile">
          <b>{paperName(t)}</b>
          <button type="button" class="link-button" onClick={() => setPaper(true)}>
            ändern
          </button>
        </p>
        <p class="soft">{sheetLine(t, perSheet, images)}</p>
      </div>
      {phone ? allSettings : null}
    </>
  );

  // Neither folders on the card nor own stickers: there is nothing to choose from yet.
  const nothing = !items.length && !cardItems.value.length && !looseStickers.value.length;

  return (
    <>
      <Screen name="sticker" title="Sticker drucken" big={big} bigClass="bogen-platz" foot={foot} phoneBigFirst help={routeToHash({ page: 'help', topic: 'sticker' })}>
        {phone && nothing ? (
          // Nothing to print yet: the first step as a button, the other ways one tap away (Prüfrunde 1 B8).
          <div class="gefaltet-leer">
            <p>
              <b>Noch keine Sticker.</b> {card.value ? 'Eigene Bilder gehen trotzdem.' : "Ohne SD-Karte geht's auch."}
            </p>
            <div class="knopfzeile erst-schritt">
              {card.value ? <Button onClick={() => void pickImages()}>Bilder hinzufügen …</Button> : <Button onClick={() => setSearchCover(true)}>Cover suchen …</Button>}
              <button type="button" class="link-button" onClick={() => setFolded(true)}>
                Andere Sticker …
              </button>
            </div>
          </div>
        ) : phone ? (
          <div class="gefaltet">
            {items.length ? (
              <span>
                <b>{plural(items.length, 'Sticker', 'Sticker')}</b> · {look} · {paperName(t)}
              </span>
            ) : (
              <span>
                <b>Noch keine Sticker.</b>
              </span>
            )}
            <button type="button" class="link-button" onClick={() => setFolded(true)}>
              {items.length ? 'ändern' : 'auswählen …'}
            </button>
          </div>
        ) : null}
        {phone ? null : (
          questions
        )}
      </Screen>

      {folded ? (
        <Dialog
          title="Sticker drucken"
          onClose={() => setFolded(false)}
          footer={
            <Button variant="primary" onClick={() => setFolded(false)}>
              Fertig
            </Button>
          }
        >
          <div class="schirm-fragen">{questions}</div>
        </Dialog>
      ) : null}
      {picking && !editing && !findCovers && !addSpecial && !addWord && !confirmRemove ? (
        <PickDialog
          blurry={new Set()}
          onClose={() => setPicking(false)}
          onEdit={setEditing}
          onFindCovers={setFindCovers}
          onRemoveAll={() => setConfirmRemove(true)}
          onAddSpecial={() => setAddSpecial(true)}
          onAddImages={() => void pickImages()}
          onAddWord={() => setAddWord(true)}
        />
      ) : null}
      {paper ? (
        <Dialog
          title="Welches Papier?"
          width="wide"
          onClose={() => setPaper(false)}
          footer={
            <Button variant="primary" onClick={() => setPaper(false)}>
              Fertig
            </Button>
          }
        >
          <div class="stack">
            <PaperMore
              onCalibrate={() => {
                setPaper(false);
                setCalibrating(true);
              }}
              onOwnSize={() => {
                setPaper(false);
                setOwnSize(true);
              }}
              onFitCheck={() => {
                setPaper(false);
                setFit(fitQuestion(template.value));
              }}
            />
          </div>
        </Dialog>
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
      {proposals ? (
        <ProposalsDialog
          proposals={openProposals(autoCovers.value, (n) => !!coverUrlFor(n)).filter((p) => proposals.folders.includes(p.folder))}
          rest={proposals.rest.length}
          onRest={() => {
            setProposals(null);
            setFindCovers(proposals.rest);
          }}
          onClose={() => setProposals(null)}
        />
      ) : null}
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
    </>
  );
}

/**
 * The first time a card's stickers are looked at here and nothing is chosen:
 * the folders that never got a sticker printed (printedStore), or all of
 * them when none of this card was printed yet (06-entwuerfe: „7 Ordner ohne
 * Sticker“).
 */
function usePreselect() {
  const id = catalog.value?.id;
  const items = cardItems.value;
  const record = printedRecord.value;
  // Only once the page shows: built ahead in a quiet moment, it must not choose for „Karten“ (the choice is shared).
  const shownNow = usePageShown();
  // Before the page is painted: its first frame shows the chosen stickers, not „Noch keine Sticker“ for a
  // frame, and no second big render follows right behind the first (Tempo #121).
  useLayoutEffect(() => {
    if (!shownNow || !id || preselected.has(id) || !items.length) return;
    preselected.add(id);
    if (items.some(isSelected) || looseStickers.value.some((l) => !l.off)) return;
    const folders = items.filter((i) => i.folder !== undefined);
    selectAll(neverPrinted(record, id, folders) ?? folders, true);
  }, [shownNow, id, items.length, record]);
}

/** „Welche Sticker?“ in two lines, „ändern“ for the whole list. */
function WhichQuestion({
  used,
  perSheet,
  images,
  onPick,
  onFindCovers,
  onProposals,
  onSearchCover,
  onAddSpecial,
  onAddWord,
}: {
  used: number[];
  perSheet: number;
  images: boolean;
  onPick: () => void;
  onFindCovers: (t: readonly BulkTarget[]) => void;
  onProposals: (p: { folders: readonly number[]; rest: readonly BulkTarget[] }) => void;
  onSearchCover: () => void;
  onAddSpecial: () => void;
  onAddWord: () => void;
}) {
  const items = cardItems.value;
  const loose = looseStickers.value;
  const folders = items.filter((i) => i.folder !== undefined);
  const chosen = items.filter(isSelected);
  const chosenFolders = chosen.filter((i) => i.folder !== undefined);
  const fresh = neverPrinted(printedRecord.value, catalog.value?.id, folders);
  const onlyFresh = !!fresh && fresh.length < folders.length && chosenFolders.length === fresh.length && chosenFolders.every((c) => fresh.includes(c));
  const words = loose.filter((l) => !l.off && isWordSticker(l)).length;
  const pictures = loose.filter((l) => !l.off).length - words;
  const coverless = useCoverless();
  const bare = coverless.filter((c) => chosenFolders.some((f) => f.folder === c.folder));
  // Of those, the ones the background search found pictures for to choose from; the rest to search for by hand.
  const offered: readonly AutoCoverProposal[] = openProposals(autoCovers.value, (n) => !!coverUrlFor(n)).filter((p) => bare.some((b) => b.folder === p.folder));
  const toFind = bare.filter((b) => !offered.some((p) => p.folder === b.folder));
  const offer = items.length + loose.length;
  return (
    <div class="frage">
      <h2>Welche Sticker?</h2>
      {offer ? (
        <p class="wert-zeile">
          <b>{chosenLine({ folders: chosenFolders.length, allFolders: folders.length, fresh: onlyFresh, specials: chosen.length - chosenFolders.length, pictures, words })}</b>
          <button type="button" class="link-button" onClick={onPick}>
            ändern
          </button>
        </p>
      ) : (
        <>
          {/* Short, so the column fits beside the sheet at 900 px high without a card. */}
          <p class="soft">{card.value || shownMemory.value ? 'Auf der SD-Karte sind noch keine Ordner. Eigene Bilder gehen trotzdem.' : "Ohne SD-Karte geht's auch, zum Beispiel mit dem Cover eines Hörspiels."}</p>
          {/* The first step as a button, the other ways as links below it (Prüfrunde 1 B8). */}
          <div class="knopfzeile erst-schritt">
            {card.value ? <Button onClick={() => void pickImages()}>Bilder hinzufügen …</Button> : <Button onClick={onSearchCover}>Cover suchen …</Button>}
          </div>
          <p class="wert-zeile links-dicht">
            {card.value ? null : (
              <button type="button" class="link-button" onClick={() => void pickImages()}>
                Bilder hinzufügen …
              </button>
            )}
            <button type="button" class="link-button" onClick={onAddSpecial}>
              Spezialkarte …
            </button>
            <button type="button" class="link-button" onClick={onAddWord}>
              Wort + Piktogramm …
            </button>
          </p>
        </>
      )}
      {offer && !images && perSheet > 1 ? <p class="start">Fängt bei Feld {firstField(used, perSheet)} an. Zum Ändern ein Feld anklicken.</p> : null}
      {bare.length ? (
        <p class="start ohne-cover">
          {plural(bare.length, 'Ordner hat', 'Ordner haben')} noch kein Cover.{' '}
          {/* One line, as without hits: the column beside the sheet has no room for a second (1440 × 900). */}
          {offered.length ? (
            <button type="button" class="link-button" onClick={() => onProposals({ folders: offered.map((p) => p.folder), rest: toFind })}>
              Vorschläge …
            </button>
          ) : (
            <button type="button" class="link-button" onClick={() => onFindCovers(bare)}>
              Cover suchen …
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}

/** The sheet, as high as the room beside the questions; more sheets get „Bogen 1 von 3“ with arrows. */
function SheetArea({
  setup,
  pages,
  sheet,
  used,
  perSheet,
  images,
  onSheet,
  onEdit,
}: {
  setup: RenderSetup;
  pages: (StickerItem | null)[][];
  sheet: number;
  used: number[];
  perSheet: number;
  images: boolean;
  onSheet: (n: number) => void;
  onEdit: (i: StickerItem) => void;
}) {
  const place = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // On a touch screen the × of every sticker stood there all the time; there the list under „ändern“ takes them off.
  const touch = useMedia('(hover: none)');
  useEffect(() => {
    const el = place.current;
    if (!el) return undefined;
    // On a computer the room is the screen's work area minus the questions (the sheet and they stand
    // together in the middle, 06-entwuerfe); on a phone it is the place above the folded line.
    const work = el.closest<HTMLElement>('.arbeit');
    const fit = () => {
      const side = work?.querySelector<HTMLElement>('.spalte');
      if (!work || !side || getComputedStyle(side).display === 'contents') {
        setBox({ w: el.clientWidth - 8, h: Math.max(160, el.clientHeight - 8) });
        return;
      }
      const cs = getComputedStyle(work);
      const px = (v: string) => parseFloat(v) || 0;
      const w = work.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight) - side.offsetWidth - px(cs.columnGap);
      const h = work.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
      setBox({ w: w - 8, h: Math.max(200, h - 8) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(work ?? el);
    if (work) ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const t = setup.template;
  const count = Math.max(1, pages.length);
  // As high as the room allows, and never wider than it (a phone).
  const ratio = t.page.widthMm / t.page.heightMm;
  const height = Math.min(box.h - (count > 1 ? 40 : 0), box.w / ratio);
  return (
    <div class="bogen-ort" ref={place} style={height > 0 ? { '--bogen-w': `${Math.floor(height * ratio) + 8}px` } : undefined}>
      {count > 1 ? (
        <p class="bogen-wahl">
          <button type="button" class="link-button" disabled={sheet === 0} onClick={() => onSheet(sheet - 1)} aria-label={images ? 'Vorheriger Sticker' : 'Vorheriger Bogen'}>
            ‹
          </button>
          <span>
            {images ? 'Sticker' : 'Bogen'} <b>{sheet + 1}</b> von {count}
          </span>
          <button type="button" class="link-button" disabled={sheet >= count - 1} onClick={() => onSheet(sheet + 1)} aria-label={images ? 'Nächster Sticker' : 'Nächster Bogen'}>
            ›
          </button>
        </p>
      ) : null}
      {height > 0 ? (
        <div class="bogen-blatt" style={{ width: `${Math.floor(height * ratio)}px` }}>
          <SheetPreview
            template={t}
            pages={pages}
            sheet={sheet}
            used={used}
            setup={setup}
            onEdit={onEdit}
            onRemove={touch ? undefined : removeFromSheet}
            // On an empty sheet a click on a field marked it as used without a word: only with stickers to place (Prüfrunde 1, eltern B11).
            onToggleUsed={sheet === 0 && perSheet > 1 && stickerItems.value.length ? toggleUsedSlot : undefined}
            onPlace={images ? undefined : placeSticker}
            onSheet={onSheet}
            maxHeight={height}
          />
        </div>
      ) : null}
    </div>
  );
}
