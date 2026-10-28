import { useState } from 'preact/hooks';
import { FileDown, RotateCcw } from 'lucide-preact';
import {
  buildTestPagePdf,
  calibrationFromReadings,
  describeCalibration,
  isIdentityCalibration,
  measureLinePlacement,
  NO_CALIBRATION,
  readingsFromFields,
  scaleOff,
  testPagePicture,
  validateCalibration,
} from '../../core/stickers/calibration';
import { slotsPerSheet } from '../../core/stickers/slots';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Field } from '../../ui/components/controls';
import { Drucker } from '../../ui/icons';
import { toast, toastError, toastSaved } from '../../ui/components/Toast';
import { plat } from '../../app/state';
import { marginChoices } from '../../core/stickers/margin';
import { calibration, printOptions, saveCalibration, setMargin, template } from './design';
import { activePrinter, ANY_PRINTER, printerLabel } from './printers';
import { printDocument, printWay } from './print';

/** "+1,5", "-0,5", "–2" → number; empty → undefined; garbage → NaN. */
export function parseMm(text: string): number | undefined {
  const t = text.trim().replace(/[–−]/g, '-').replace(',', '.').replace(/\s*mm$/i, '');
  if (!t) return undefined;
  return /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** Test page and correction for printers that print slightly off. */
export function CalibrationDialog({ onClose }: { onClose: () => void }) {
  const t = template.value;
  const current = calibration.value;
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [x2, setX2] = useState('');
  const [y2, setY2] = useState('');
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);
  const last = slotsPerSheet(t);
  // The line to measure the size with; the SELPHY page has no room for one.
  const measure = measureLinePlacement(t);
  // The test page goes the way the stickers go ("Drucken"), so both come out the same size.
  const printsHere = printWay(plat()) !== null;
  // The desktop app's own print dialog always prints in real size: it has no 100 % to look for (Prüfrunde 1, bastler 24).
  const realSize = printWay(plat()) === 'system';

  const values = [x, y, x2, y2].map(parseMm);
  const invalid = values.some((v) => Number.isNaN(v));
  const readings = invalid ? null : readingsFromFields(values);
  const next = readings ? calibrationFromReadings(t, current, readings.topLeft, readings.bottomRight) : null;
  const problems = next ? validateCalibration(next) : [];
  // About 1 % off in size or more: the print dialog scales. That is set right there, not corrected here.
  const tooBig = next ? scaleOff(next) : null;
  // A correction saved before that already makes up for such a size.
  const savedSize = next ? null : scaleOff(current);
  const fileName = `Testseite ${t.name.replace(/[\\/:*?"<>|]+/g, ' ')}.pdf`;

  const printTest = async () => {
    setBusy('print');
    try {
      await printDocument(plat(), { name: fileName, page: t.page, pages: 1, pdf: () => buildTestPagePdf(t, calibration.value), pictures: async () => [await testPagePicture(t, calibration.value)] });
    } catch (e) {
      toastError('Die Testseite ließ sich nicht drucken', e);
    } finally {
      setBusy(null);
    }
  };

  const saveTest = async () => {
    setBusy('pdf');
    try {
      const pdf = await buildTestPagePdf(t, current);
      if (await plat().files.save(fileName, pdf)) toastSaved();
    } catch (e) {
      toastError('Die Testseite ließ sich nicht erstellen', e);
    } finally {
      setBusy(null);
    }
  };

  /** After a size warning: the numbers read so far belong to the scaled print, so they go. */
  const again = () => {
    for (const set of [setX, setY, setX2, setY2]) set('');
    void (printsHere ? printTest() : saveTest());
  };

  const save = () => {
    if (!next) return;
    saveCalibration(t.id, next);
    toast.success('Korrektur gespeichert', 'Sie gilt ab jetzt für diese Vorlage. Drucke zur Kontrolle noch einmal die Testseite.');
    onClose();
  };

  return (
    <Dialog
      title="Drucker ausrichten"
      width="wide"
      onClose={onClose}
      footer={
        tooBig ? (
          <>
            <Button variant="ghost" disabled={invalid} onClick={save}>
              Trotzdem speichern
            </Button>
            <Button variant="primary" icon={printsHere ? Drucker : FileDown} loading={busy !== null} onClick={again}>
              {printsHere ? 'Testseite noch mal drucken' : 'Testseite noch mal speichern'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!next || invalid} onClick={save}>
              Korrektur speichern
            </Button>
          </>
        )
      }
    >
      <div class="stack loose">
        <p class="soft">Viele Drucker drucken ein bis zwei Millimeter daneben. Mit einer Testseite findest du heraus, wie viel, und ich gleiche es bei jedem Druck aus.</p>
        <ol class="plain-steps">
          <li>
            <div class="stack tight">
              <strong>Testseite drucken</strong>
              <span class="soft small">{realSize ? 'Auf normales Papier. Ich drucke sie in echter Größe.' : 'Auf normales Papier, im Druckdialog „Tatsächliche Größe“ oder 100 % wählen.'}</span>
              <div class="row wrap calibration-test">
                {printsHere ? (
                  <Button icon={Drucker} onClick={() => void printTest()} loading={busy === 'print'} disabled={busy !== null}>
                    Testseite drucken
                  </Button>
                ) : null}
                {printsHere ? (
                  <button type="button" class="link-button" disabled={busy !== null} onClick={() => void saveTest()}>
                    Als PDF speichern
                  </button>
                ) : (
                  <Button icon={FileDown} onClick={() => void saveTest()} loading={busy === 'pdf'}>
                    Testseite speichern
                  </Button>
                )}
              </div>
            </div>
          </li>
          {measure ? (
            <li>
              <div class="stack tight">
                <strong>{`Die ${measure.lengthMm / 10}-cm-Linie nachmessen`}</strong>
                <span class="soft small">
                  {realSize
                    ? 'Ist sie mit dem Lineal kürzer oder länger, obwohl ich in echter Größe drucke, verkleinert der Drucker selbst. Schaue in seinen Einstellungen nach „An Seite anpassen“ oder „Randlos“ und schalte es aus.'
                    : 'Ist sie mit dem Lineal kürzer oder länger, stimmt die Größe im Druckdialog nicht. Stelle dort 100 % ein und drucke die Seite noch einmal.'}
                </span>
              </div>
            </li>
          ) : null}
          <li>
            <div class="stack tight">
              <strong>Auf einen Etikettenbogen legen</strong>
              <span class="soft small">Lege das Blatt genau auf einen Bogen „{t.name}“ und halte beides gegen ein Fenster.</span>
            </div>
          </li>
          <li>
            <div class="stack">
              <div class="stack tight">
                <strong>Zahlen an Etikett 1 ablesen</strong>
                <span class="soft small">Lies an beiden Skalen die Zahl ab, auf der die echte Kante des Etiketts liegt. Liegt alles genau, ist es die 0.</span>
              </div>
              <div class="row wrap" style={{ gap: 16 }}>
                <MmField id="cal-x" label="Waagerecht (linke Kante)" value={x} onInput={setX} />
                <MmField id="cal-y" label="Senkrecht (obere Kante)" value={y} onInput={setY} />
              </div>
              {last > 1 ? (
                <details class="calibration-more">
                  <summary>Ist das letzte Etikett weiter verrutscht als das erste?</summary>
                  <p class="soft small">Dann druckt dein Drucker etwas zu groß oder zu klein. Trage auch die Zahlen an Etikett {last} ein (rechte und untere Kante).</p>
                  <div class="row wrap" style={{ gap: 16 }}>
                    <MmField id="cal-x2" label="Waagerecht (rechte Kante)" value={x2} onInput={setX2} />
                    <MmField id="cal-y2" label="Senkrecht (untere Kante)" value={y2} onInput={setY2} />
                  </div>
                </details>
              ) : null}
            </div>
          </li>
        </ol>
        <UnevenNote />
        {invalid ? <Callout tone="warning">Gib die Zahlen so ein, wie sie auf der Skala stehen, zum Beispiel 1,5 oder -0,5.</Callout> : null}
        {problems.map((p) => (
          <Callout tone="warning" key={p}>
            {p}
          </Callout>
        ))}
        {savedSize ? (
          <Callout tone="warning">
            {`Die gespeicherte Korrektur gleicht aus, dass dein Drucker etwa ${savedSize.percent} % ${savedSize.smaller ? 'zu klein' : 'zu groß'} druckt. `}
            {realSize ? 'Ich drucke in echter Größe: Schaue in den Einstellungen des Druckers nach „An Seite anpassen“, setze die Korrektur zurück und miss neu.' : 'Das kommt fast immer vom Druckdialog. Stelle dort 100 % ein, setze die Korrektur zurück und miss neu.'}
          </Callout>
        ) : null}
        <div class="row wrap calibration-now">
          <span class="soft small">
            {isIdentityCalibration(current)
              ? 'Bisher ohne Korrektur.'
              : `Aktuelle Korrektur: ${describeCalibration(current)}.`}
            {next ? ` Neu: ${describeCalibration(next)}.` : ''}
            {activePrinter.value !== ANY_PRINTER ? ` Gilt für „${printerLabel(activePrinter.value)}“.` : ''}
          </span>
          {!isIdentityCalibration(current) ? (
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              onClick={() => {
                saveCalibration(t.id, { ...NO_CALIBRATION });
                toast.success('Korrektur zurückgesetzt');
              }}
            >
              Zurücksetzen
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Ausrichten moves and scales the whole sheet. When only some stickers land
 * off (the paper is fed unevenly), the white margin helps instead.
 */
function UnevenNote() {
  const t = template.value;
  const margin = printOptions.value.marginMm;
  const suggested = Math.max(...marginChoices(t.label).filter((m) => m <= 2));
  if (t.output === 'images' || !(suggested > 0)) return null;
  return (
    <p class="soft small">
      Sitzen manche Sticker genau und andere ein Stück daneben? Das gleicht Ausrichten nicht aus. Dafür gibt es unter „Mehr …“ beim Papier den weißen Rand
      {margin ? ` (gerade ${margin}\u00a0mm).` : '. '}
      {margin ? null : (
        <button
          type="button"
          class="link-button"
          onClick={() => {
            setMargin(t.id, suggested);
            toast.success(`Weißer Rand: ${suggested}\u00a0mm`, 'Jeder Sticker wird rundherum etwas kleiner gedruckt.');
          }}
        >
          {`${suggested}\u00a0mm Rand einstellen`}
        </button>
      )}
    </p>
  );
}

function MmField({ id, label, value, onInput }: { id: string; label: string; value: string; onInput: (v: string) => void }) {
  return (
    <Field label={label} id={id}>
      <div class="input-suffix">
        <input id={id} class="input" inputMode="decimal" placeholder="0" value={value} style={{ width: 110 }} onInput={(e) => onInput(e.currentTarget.value)} />
        <span>mm</span>
      </div>
    </Field>
  );
}
