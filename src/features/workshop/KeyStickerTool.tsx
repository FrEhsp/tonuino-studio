/**
 * Werkstatt › Tasten-Sticker: round stickers for the keys of the box (forum
 * 2130, 9551), as many keys as the box has. The number of keys and what Vor
 * and Zurück do come from the box when the app knows it (as for the
 * Bedienkarte); the sheet is printed on the round papers of Sticker drucken,
 * with their printer correction.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleCheck, FileDown, Printer } from 'lucide-preact';
import { fillSheet, keyStickers, sheetSets, type KeySticker, type ThreeKeyMarks } from '../../core/stickers/keysymbols';
import { isIdentityCalibration } from '../../core/stickers/calibration';
import { getTemplate, type LabelTemplate } from '../../core/stickers/templates';
import { Button, Field, Segmented } from '../../ui/components/controls';
import { toastError, toastSaved } from '../../ui/components/Toast';
import { plat, profile } from '../../app/state';
import { calibrationFor } from '../stickers/design';
import { canPrint, printDocument } from '../stickers/print';
import type { KeyColor } from '../stickers/keystickers';
import { manualFacts, type ManualChoice } from '../manual/manualbox';
import { knownBuild } from './boxbuild';
import { ToolHeader } from './common';
import { logSession } from './logsession';
import '../../ui/styles/manual.css';

type KeyPaper = 'round-30' | 'round-25';

/** The colour choices, without loading the renderer (keystickers.ts KEY_COLORS has the same values). */
const COLORS: { value: KeyColor; name: string; bg: string; ink: string }[] = [
  { value: 'white', name: 'Weiß', bg: '#ffffff', ink: '#1f1a16' },
  { value: 'black', name: 'Schwarz', bg: '#1f1a16', ink: '#ffffff' },
  { value: 'red', name: 'Rot', bg: '#e5483b', ink: '#ffffff' },
  { value: 'yellow', name: 'Gelb', bg: '#f6c12c', ink: '#1f1a16' },
  { value: 'green', name: 'Grün', bg: '#58ad46', ink: '#ffffff' },
  { value: 'blue', name: 'Blau', bg: '#3f8fd6', ink: '#ffffff' },
];

function paper(id: KeyPaper): LabelTemplate {
  const t = getTemplate(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
}

export function KeyStickerTool() {
  void logSession.revision.value;
  const info = logSession.source.kind === 'live' ? logSession.book.info : undefined;
  const [choice, setChoice] = useState<ManualChoice>({});
  const [size, setSize] = useState<KeyPaper>('round-30');
  const [color, setColor] = useState<KeyColor>('white');
  const [marks, setMarks] = useState<ThreeKeyMarks>('both');
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
  const facts = manualFacts({ info, profile: profile.value, build: knownBuild.value, choice });
  const box = facts.box;
  const template = paper(size);
  const set = keyStickers(box.buttons, { marks, shortPressVolume: box.shortPressVolume });
  const stickers = fillSheet(set, template.grid);
  const { sets, spare } = sheetSets(set.length, template.grid);
  const calibration = calibrationFor(template.id);
  const pictures = useSheetPictures(template, set, stickers, color, calibration);

  const save = async () => {
    setBusy('pdf');
    try {
      const { keySheetPdf } = await import('../stickers/keystickers');
      const blob = await keySheetPdf({ template, stickers, color, calibration });
      if (await plat().files.save('Tasten-Sticker.pdf', blob)) toastSaved('Tasten-Sticker gespeichert', 'Drucke das PDF mit „Tatsächliche Größe“ (100 %).');
    } catch (e) {
      toastError('Das PDF ließ sich nicht erstellen', e);
    } finally {
      setBusy(null);
    }
  };
  // The same way in real size as the stickers and the test page (Prüfrunde 1, bastler 25).
  const printNow = async () => {
    setBusy('print');
    try {
      const { keySheetPdf, keySheetPicture } = await import('../stickers/keystickers');
      const sheet = { template, stickers, color, calibration };
      await printDocument(plat(), { name: 'Tasten-Sticker.pdf', page: template.page, pages: 1, pdf: () => keySheetPdf(sheet), pictures: async () => [await keySheetPicture(sheet, 300)] });
    } catch (e) {
      toastError('Drucken hat nicht geklappt', e);
    } finally {
      setBusy(null);
    }
  };
  const printing = canPrint(plat());

  const shortWord = box.shortPressVolume ? 'lauter' : 'zum nächsten Titel';
  const longWord = box.shortPressVolume ? 'zum nächsten Titel' : 'lauter';

  return (
    <div class="page ws-page">
      <ToolHeader title="Tasten-Sticker" intro="Runde Sticker mit Zeichen für die Tasten deiner Box: Play/Pause, vor, zurück, lauter und leiser. Zum Ausschneiden und Aufkleben." />
      <div class="keys-layout">
        <section class="card pad stack" aria-label="Deine Tasten">
          <h2 class="ws-set-title">Deine Tasten</h2>
          <Field label="Tasten" hint={<Detected on={facts.detected.has('buttons')} />}>
            <Segmented<3 | 5>
              label="Tasten"
              value={box.buttons}
              options={[
                { value: 3, label: '3 Tasten' },
                { value: 5, label: '5 Tasten' },
              ]}
              onChange={(b) => setChoice({ ...choice, buttons: b })}
            />
          </Field>
          <Field label="Größe" hint="Miss die Fläche oben auf deinen Tasten. Der Sticker sollte etwas kleiner sein.">
            <Segmented<KeyPaper>
              label="Größe"
              value={size}
              options={[
                { value: 'round-25', label: 'Ø 25 mm' },
                { value: 'round-30', label: 'Ø 30 mm' },
              ]}
              onChange={setSize}
            />
          </Field>
          <fieldset class="keys-colors">
            <legend class="field-label">Farbe</legend>
            <div class="keys-color-row">
              {COLORS.map((c) => (
                <label key={c.value} class="keys-color">
                  <input type="radio" name="keys-color" value={c.value} checked={color === c.value} onChange={() => setColor(c.value)} />
                  <span class="keys-color-dot" style={{ background: c.bg, color: c.ink }} aria-hidden="true" />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {box.buttons === 3 ? (
            <details class="manual-more">
              <summary>Zeichen auf Vor und Zurück</summary>
              <div class="stack tight">
                <p class="small soft">
                  Bei 3 Tasten geht Vor kurz gedrückt {shortWord} und lang gedrückt {longWord}. „Beides“ zeigt das Kurze groß und das Lange klein darunter.
                </p>
                <Segmented<ThreeKeyMarks>
                  label="Zeichen auf Vor und Zurück"
                  value={marks}
                  options={[
                    { value: 'both', label: 'Beides' },
                    { value: 'skip', label: 'Vor und zurück' },
                    { value: 'volume', label: 'Lauter und leiser' },
                  ]}
                  onChange={setMarks}
                />
              </div>
            </details>
          ) : null}
          <div class="row wrap">
            {printing ? (
              <Button variant="primary" icon={Printer} onClick={printNow} loading={busy === 'print'} disabled={!!busy}>
                Drucken
              </Button>
            ) : null}
            <Button variant={printing ? 'default' : 'primary'} icon={FileDown} onClick={save} loading={busy === 'pdf'} disabled={!!busy}>
              Als PDF speichern
            </Button>
          </div>
          <p class="small soft">
            Ein Bogen hat {sets} {sets === 1 ? 'Satz' : 'Sätze'} für deine Box{spare ? ` und ${spare === 1 ? 'einen Sticker' : `${spare} Sticker`} extra` : ''}. Drucke auf ganzflächiges Klebepapier oder Folie, in echter Größe (beim PDF: „Tatsächliche Größe“, 100&nbsp;%). Schneide die
            Sticker mit einem Kreisstanzer ({template.label.widthMm}&nbsp;mm) oder einer Schere an der Linie aus. Mit Schutzfolie oder Klarlack darüber halten sie länger.
            {isIdentityCalibration(calibration) ? null : ' Den Ausgleich aus „Drucker ausrichten“ für dieses Papier rechne ich mit ein.'}
          </p>
        </section>

        <section class="keys-preview stack" aria-label="So sieht dein Bogen aus">
          <h2 class="ws-set-title">So sieht dein Bogen aus</h2>
          <ul class="keys-set" aria-label="Ein Satz">
            {set.map((s, i) => (
              <li key={`${s.key}-${i}`}>
                {pictures.set[i] ? <img src={pictures.set[i]} alt="" width={96} height={96} /> : <span class="keys-set-empty" />}
                <span class="small">{s.key}</span>
              </li>
            ))}
          </ul>
          <div class="keys-sheet">{pictures.sheet ? <img src={pictures.sheet} alt={`Bogen mit ${sets} Sätzen, ${template.name}`} /> : null}</div>
        </section>
      </div>
    </div>
  );
}

/** One sticker of each key and the whole sheet as pictures, drawn by the same code as the PDF. */
function useSheetPictures(template: LabelTemplate, set: KeySticker[], stickers: (KeySticker | null)[], color: KeyColor, calibration: ReturnType<typeof calibrationFor>) {
  const [pictures, setPictures] = useState<{ set: string[]; sheet?: string }>({ set: [] });
  const shown = useRef<string[]>([]);
  const key = `${template.id}|${color}|${JSON.stringify(set)}|${calibration.offsetXMm}|${calibration.offsetYMm}|${calibration.scaleX ?? 1}|${calibration.scaleY ?? 1}`;
  useEffect(() => {
    let alive = true;
    (async () => {
      const { keySheetPicture, renderKeySticker } = await import('../stickers/keystickers');
      const { canvasToBlob } = await import('../../core/stickers/image');
      // 96 px on the page for the label without its bleed.
      const pxPerMm = (96 * 2) / template.label.widthMm;
      const singles = await Promise.all(set.map((s) => canvasToBlob(renderKeySticker(s.mark, template, color, pxPerMm, 0), 'image/png')));
      const sheet = await keySheetPicture({ template, stickers, color, calibration });
      if (!alive) return;
      const urls = [...singles, sheet].map((b) => URL.createObjectURL(b));
      for (const u of shown.current) URL.revokeObjectURL(u);
      shown.current = urls;
      setPictures({ set: urls.slice(0, -1), sheet: urls[urls.length - 1] });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => () => shown.current.forEach((u) => URL.revokeObjectURL(u)), []);
  return pictures;
}

function Detected({ on }: { on: boolean }) {
  if (on)
    return (
      <span class="manual-detected">
        <CircleCheck size={13} aria-hidden="true" /> automatisch erkannt
      </span>
    );
  return <>Schließe die Box im Box-Logbuch an, dann erkenne ich das.</>;
}
