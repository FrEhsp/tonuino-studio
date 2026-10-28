import { useEffect, useRef, useState } from 'preact/hooks';
import { ImageOff, ImagePlus, RotateCcw, ZoomOut } from 'lucide-preact';
import { fromHex, panelColor, rgbToOklab, toHex, type Palette } from '../../core/stickers/color';
import { DEFAULT_FOCUS_Y, LOW_PRINT_DPI } from '../../core/stickers/image';
import { isCompact, type Orientation } from '../../core/stickers/layout';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Field, Segmented } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { cardCatalog, catalog, coverUrlFor, plat, shownMemory, updateCatalog } from '../../app/state';
import { changeLookWithoutCard } from '../../app/waiting';
import { isSnapshotCard } from '../../app/pending';
import { CoverDialog } from '../box/CoverDialog';
import { extras, updateExtraSticker } from '../cards/items';
import { IMAGE_EXTENSIONS, imageBlobOf, looseIdOf, picturePalette, pictureSizeOf, removeFromSheet, replaceLoosePicture, stickerItems, updateLooseSticker, type StickerItem } from './content';
import { Kreuz } from '../../ui/icons';
import { StickerThumb } from './Preview';
import { PictogramPicker } from './PictogramPicker';
import { motifOf } from './bildkarte';
import { pictogramWord } from './pictogramWord';
import { blurryHint } from './blurry';
import { updateDesign } from './design';
import { pictogramInstead, stickerDpi, type RenderSetup } from './pipeline';
import { designZoom, titleShown } from './render';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Adjust one sticker: its text, colour and picture section. */
export function StickerEditDialog({ item: opened, setup, onClose }: { item: StickerItem; setup: RenderSetup; onClose: () => void }) {
  // The sticker as it is now: "Anderes Bild" gives it a new picture while the dialog stays open.
  const item = stickerItems.value.find((x) => x.key === opened.key) ?? opened;
  const folderNumber = item.folder;
  const folderEntry = item.folder !== undefined ? catalog.value?.folders[pad2(item.folder)] : undefined;
  const folder = item.key === `f${item.folder}` ? folderEntry : undefined;
  // One of several cards of a folder (an episode, tracks 13 to 15): a sticker of its own, its picture the folder's.
  const extra = item.folder !== undefined && item.key.startsWith('x:') ? extras.value.find((x) => `x:${x.id}` === item.key) : undefined;
  const looseId = looseIdOf(item);
  // A special card (Schlummerkarte, Stopptanz …): its text and colour stay, a Bildkarte can show a pictogram (TODO 0.3 #103).
  const special = item.folder === undefined && item.key.startsWith('x:') ? extras.value.find((x) => `x:${x.id}` === item.key) : undefined;
  const editable = !!folder || !!extra || !!looseId;
  // "Anderes Bild" for a folder (its cover) or for a sticker from an own picture.
  const canChange = (folderNumber !== undefined && (!!folder || (!!extra && !!folderEntry))) || !!looseId;
  const [title, setTitle] = useState(item.title);
  const [color, setColor] = useState<string | undefined>(item.color);
  // Without a zoom of its own the sticker follows "Ganz gezeigt" of the design (Vollbild always fills).
  const defaultZoom = designZoom(setup.design);
  const [zoom, setZoom] = useState(item.zoom ?? defaultZoom);
  const [orientation, setOrientation] = useState<Orientation | undefined>(item.orientation);
  const [fx, setFx] = useState(item.focusX ?? 0.5);
  const [fy, setFy] = useState(item.focusY ?? DEFAULT_FOCUS_Y);
  const [pictogram, setPictogram] = useState<number | undefined>(item.pictogram);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [coverOpen, setCoverOpen] = useState(false);
  // The picture changed in this dialog (new or removed): it is saved already, "Abbrechen" keeps it.
  const [pictureChange, setPictureChange] = useState<'new' | 'removed' | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const coverBefore = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setPalette(null);
    picturePalette(item).then((p) => alive && setPalette(p), () => undefined);
    return () => {
      alive = false;
    };
  }, [item.picture?.kind === 'url' ? item.picture.url : item.picture?.kind === 'blob' ? item.picture.id : item.key]);

  const ownZoom = Math.abs(zoom - defaultZoom) > 1e-6 ? zoom : undefined;
  const label = setup.template.label;
  const compact = isCompact({ widthMm: label.widthMm, heightMm: label.heightMm, bleedMm: 0, safeMm: 0, shape: label.shape });
  const draft = useDebounced<StickerItem>({ ...item, title: title.trim() || item.title, color, zoom: ownZoom, orientation, focusX: fx, focusY: fy, pictogram }, 90);
  // "Bildkarte" without a cover: the own motif or an ARASAAC pictogram, for folders and their further cards.
  // A sticker from an own picture (no SD card) can swap its picture for a pictogram.
  const picksPictogram = (((!!folder || !!extra || !!special) && !item.picture) || !!looseId) && setup.design.style === 'bild' && !compact;
  // The pictogram stands where the picture was: its section and sharpness do not matter then.
  const showsPicture = !!item.picture && !pictogramInstead({ loose: item.loose, pictogram }, setup);
  // Print resolution with the section as the preview shows it: the hint follows the
  // sliders once they rest, so it does not come and go (and the dialog jump) while dragging.
  const size = showsPicture ? pictureSizeOf(item) : undefined;
  const dpi = size ? stickerDpi(draft, setup, size) : undefined;
  // The title is off for the whole design: the text shows only on the strip of a sticker without a picture.
  const titleOff = !!item.picture && !compact && !titleShown(item, setup.design);
  // A known work's own colour first: "Automatisch" uses it, but it can also be picked to keep it.
  const work = item.work;
  const swatches = palette ? unique([...(work?.band ? [work.band] : []), toHex(panelColor(palette)), toHex(palette.vibrant), toHex(palette.dominant), toHex(palette.muted), toHex(palette.dark), toHex(palette.light)]) : [];

  // A new picture or none: colour, section and orientation chosen for the old one do not fit.
  const forgetOldPicture = (change: 'new' | 'removed' = 'new') => {
    setColor(undefined);
    setZoom(defaultZoom);
    setFx(0.5);
    setFy(DEFAULT_FOCUS_Y);
    setOrientation(undefined);
    setPictureChange(change);
  };

  const pickLoosePicture = async () => {
    if (!looseId) return;
    try {
      const [file] = await plat().pickFiles({ multiple: false, extensions: IMAGE_EXTENSIONS });
      if (!file) return;
      replaceLoosePicture(looseId, await imageBlobOf(file));
      forgetOldPicture();
    } catch (e) {
      toastError('Das Bild ließ sich nicht öffnen', e);
    }
  };

  if (coverOpen && folderNumber !== undefined) {
    const closeCover = () => {
      setCoverOpen(false);
      const now = coverUrlFor(folderNumber);
      if (now !== coverBefore.current) forgetOldPicture(now ? 'new' : 'removed');
    };
    return <CoverDialog folder={folderNumber} query={folderEntry?.title ?? item.title} onClose={closeCover} />;
  }

  const save = async () => {
    setBusy(true);
    try {
      if (special) {
        const tweaks = { ...special.sticker, pictogram };
        const own = Object.fromEntries(Object.entries(tweaks).filter(([, v]) => v !== undefined));
        await updateExtraSticker(special.id, Object.keys(own).length ? own : undefined, special.color);
      } else if (looseId) {
        updateLooseSticker(looseId, { title: title.trim() || item.title, color, focusX: fx, focusY: fy, zoom: ownZoom, orientation, pictogram });
      } else if (extra) {
        // Only what differs from the folder's sticker: the rest keeps following it.
        const base = folderEntry?.sticker;
        const t = title.trim();
        const tweaks = {
          title: t && t !== extra.label ? t : undefined,
          focusX: fx !== (base?.focusX ?? 0.5) ? fx : undefined,
          focusY: fy !== (base?.focusY ?? DEFAULT_FOCUS_Y) ? fy : undefined,
          zoom: ownZoom !== base?.zoom ? ownZoom : undefined,
          orientation: orientation !== base?.orientation ? orientation : undefined,
          pictogram: pictogram !== base?.pictogram ? pictogram : undefined,
        };
        const own = Object.values(tweaks).some((v) => v !== undefined) ? tweaks : undefined;
        await updateExtraSticker(extra.id, own, color !== folderEntry?.color ? color : undefined);
      } else if (folder && item.folder !== undefined && !cardCatalog.value && shownMemory.value) {
        // The remembered box: kept on this device, onto the card when it is open again.
        const t = title.trim();
        const tweaks = { ...folder.sticker, title: t && t !== folder.title ? t : undefined, focusX: fx !== 0.5 ? fx : undefined, focusY: fy !== DEFAULT_FOCUS_Y ? fy : undefined, zoom: ownZoom, orientation, pictogram };
        const own = Object.fromEntries(Object.entries(tweaks).filter(([, v]) => v !== undefined));
        await changeLookWithoutCard({ folder: item.folder }, { sticker: Object.keys(own).length ? own : undefined, color });
      } else if (folder && item.folder !== undefined) {
        const key = pad2(item.folder);
        await updateCatalog((c) => {
          const f = c.folders[key];
          if (!f) return;
          const t = title.trim();
          const tweaks = {
            title: t && t !== f.title ? t : undefined,
            focusX: fx !== 0.5 ? fx : undefined,
            focusY: fy !== DEFAULT_FOCUS_Y ? fy : undefined,
            zoom: ownZoom,
            orientation,
            // Kept: the shelf's choice is made on the folder's page, not here.
            recipe: f.sticker?.recipe,
            pictogram,
          };
          f.sticker = Object.values(tweaks).some((v) => v !== undefined) ? tweaks : undefined;
          f.color = color;
          f.updatedAt = Date.now();
        });
      }
      onClose();
    } catch (e) {
      toastError('Speichern hat nicht geklappt', e);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Sticker anpassen"
      width="wide"
      top
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            icon={Kreuz}
            disabled={busy}
            onClick={() => {
              removeFromSheet(opened);
              onClose();
            }}
          >
            Vom Bogen nehmen
          </Button>
          {editable || picksPictogram ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Abbrechen
              </Button>
              <Button variant="primary" onClick={save} loading={busy}>
                Übernehmen
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Schließen
            </Button>
          )}
        </>
      }
    >
      <div class="sticker-edit">
        <div class="sticker-edit-preview">
          <StickerThumb item={draft} setup={setup} size={340} />
          {canChange ? (
            <Button
              // „Übernehmen“ is the one purple button of the dialog.
              variant={item.picture ? 'ghost' : 'default'}
              icon={ImagePlus}
              onClick={() => {
                if (looseId) return void pickLoosePicture();
                if (folderNumber === undefined) return;
                coverBefore.current = coverUrlFor(folderNumber);
                setCoverOpen(true);
              }}
            >
              {item.picture ? 'Anderes Bild oder Piktogramm' : 'Cover oder Piktogramm'}
            </Button>
          ) : null}
          {extra && canChange ? <p class="soft small center">Das Bild gehört zu Ordner {pad2(extra.folder)} und gilt für alle seine Karten.</p> : null}
          {pictureChange ? (
            <p class="soft small center">
              {pictureChange === 'new' ? 'Das neue Bild bleibt, auch wenn du abbrichst.' : 'Das Bild ist entfernt. Das bleibt so, auch wenn du abbrichst.'}
            </p>
          ) : null}
          {size && dpi !== undefined && dpi < LOW_PRINT_DPI ? (
            <Callout tone="warning" icon={ImageOff}>
              {blurryHint(size, dpi, canChange, (draft.zoom ?? defaultZoom) > 1)}
            </Callout>
          ) : null}
        </div>
        {editable ? (
          <div class="stack">
            <Field
              label="Text auf dem Sticker"
              id="sticker-title"
              hint={
                folder || extra || titleOff ? (
                  <>
                    {folder ? 'Ändert nur den Sticker, nicht den Namen des Ordners. ' : extra ? 'Ändert nur den Sticker, nicht den Namen der Karte in der Liste. ' : null}
                    {titleOff ? (
                      <>
                        Der Titel ist gerade ausgeschaltet.{' '}
                        <button type="button" class="inline-link" onClick={() => updateDesign({ showTitle: true })}>
                          Titel zeigen
                        </button>
                      </>
                    ) : null}
                  </>
                ) : undefined
              }
            >
              <input id="sticker-title" class="input" value={title} placeholder={folder?.title ?? extra?.label} onInput={(e) => setTitle(e.currentTarget.value)} />
            </Field>
            <Field label="Farbe" hint={work ? `„${work.name}“ automatisch erkannt. Die Farben passen dazu, du kannst aber jede andere nehmen.` : undefined}>
              <div class="swatches" role="radiogroup" aria-label="Farbe">
                <button type="button" role="radio" aria-checked={!color} class="swatch auto" onClick={() => setColor(undefined)}>
                  Automatisch
                </button>
                {swatches.map((hex) => (
                  <button type="button" role="radio" aria-checked={color === hex} class="swatch" key={hex} style={{ background: hex }} aria-label={`Farbe ${hex}`} onClick={() => setColor(hex)} />
                ))}
                <label class="swatch custom" title="Eigene Farbe">
                  <input type="color" value={color ?? swatches[0] ?? '#9c5d98'} onInput={(e) => setColor(e.currentTarget.value)} aria-label="Eigene Farbe" />
                </label>
              </div>
            </Field>
            {picksPictogram ? (
              <PictogramPicker word={pictogramWord(title.trim() || item.title)} value={pictogram} own={looseId ? 'picture' : motifOf(item) ? 'motif' : 'word'} onChange={setPictogram} />
            ) : null}
            {!compact ? (
              <Field label="Format">
                <Segmented<Orientation | 'design'>
                  label="Format"
                  value={orientation ?? 'design'}
                  options={[
                    { value: 'design', label: 'Wie die anderen' },
                    { value: 'landscape', label: 'Quer' },
                    { value: 'portrait', label: 'Hochkant' },
                  ]}
                  onChange={(v) => setOrientation(v === 'design' ? undefined : v)}
                />
              </Field>
            ) : null}
            {showsPicture ? (
              <Field label="Bildausschnitt" hint="Ganz links siehst du das ganze Bild. Nach rechts füllt es die Fläche und wird größer.">
                <div class="stack tight">
                  <Slider label="Größe" min={0} max={3} step={0.05} value={zoom} onInput={setZoom} />
                  <Slider label="Links ↔ rechts" min={0} max={1} step={0.01} value={fx} onInput={setFx} />
                  <Slider label="Oben ↔ unten" min={0} max={1} step={0.01} value={fy} onInput={setFy} />
                  <div class="row wrap">
                    <button type="button" class="link-button" onClick={() => setZoom(0)}>
                      <ZoomOut size={14} /> Ganzes Bild
                    </button>
                    <button
                      type="button"
                      class="link-button"
                      onClick={() => {
                        setZoom(defaultZoom);
                        setFx(0.5);
                        setFy(DEFAULT_FOCUS_Y);
                      }}
                    >
                      <RotateCcw size={14} /> Ausschnitt zurücksetzen
                    </button>
                  </div>
                </div>
              </Field>
            ) : null}
            {(folder || extra) && isSnapshotCard() ? <p class="soft small">Wird mit den Namen und Bildern deiner Box gespeichert und kommt mit dem nächsten Paket auf die Karte.</p> : null}
          </div>
        ) : (
          <div class="stack">
            <p class="soft">
              Spezialkarten behalten ihren Text und ihre Farbe, damit man sie auf einen Blick erkennt. {picksPictogram ? 'Statt des gezeichneten Bilds kann ein Piktogramm draufkommen.' : 'Die Schrift änderst du über Stil, Schrift und „Titel zeigen“.'}
            </p>
            {picksPictogram ? (
              <PictogramPicker word={pictogramWord(item.title, true)} value={pictogram} own={motifOf(item) ? 'motif' : 'word'} onChange={setPictogram} />
            ) : special && !compact ? (
              <p class="soft">
                Ein Piktogramm statt des Bilds gibt es im Stil „Bildkarte“.{' '}
                <button type="button" class="inline-link" onClick={() => updateDesign({ style: 'bild' })}>
                  Bogen auf „Bildkarte“ stellen
                </button>
              </p>
            ) : null}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Slider({ label, min, max, step, value, onInput }: { label: string; min: number; max: number; step: number; value: number; onInput: (v: number) => void }) {
  return (
    <label class="slider-row">
      <span class="small">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onInput(Number(e.currentTarget.value))} />
    </label>
  );
}

/** The value, but only after it stopped changing for `ms` (sliders would otherwise render every step). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [key]);
  return v;
}

/** Colours closer than this (OKLab) look the same as swatches. */
const SAME_COLOR = 0.06;

/** The colours without repeats, also without ones that only differ by a shade nobody sees. */
function unique(list: string[]): string[] {
  const out: string[] = [];
  for (const hex of list.map((s) => s.toLowerCase())) {
    const lab = rgbToOklab(fromHex(hex));
    const near = out.some((o) => {
      const other = rgbToOklab(fromHex(o));
      return Math.hypot(lab.L - other.L, lab.a - other.a, lab.b - other.b) < SAME_COLOR;
    });
    if (!near) out.push(hex);
  }
  return out;
}
