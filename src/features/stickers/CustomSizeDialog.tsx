import { useState } from 'preact/hooks';
import { fmtMm } from '../../core/stickers/templates';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Field, Segmented } from '../../ui/components/controls';
import { formFromParams, templateFromForm, type OwnPaper, type OwnSizeForm } from './customSize';
import { printSetup, updatePrint } from './design';
import { SheetDiagram } from './SheetDiagram';

const PAPERS: { value: OwnPaper; label: string; hint: string }[] = [
  { value: 'sheet', label: 'Etikettenbogen', hint: 'Fertig ausgestanzte Etiketten auf einem Bogen. Miss die Ränder vom Blattrand bis zum ersten Etikett.' },
  { value: 'cut', label: 'Zum Ausschneiden', hint: 'Klebepapier oder Folie. Du schneidest die Sticker an den Schnittmarken selbst aus.' },
  { value: 'photo', label: 'Fotoservice', hint: 'Fotosticker vom Fotoservice: Jeder Sticker wird ein eigenes Bild. Die Größe steht im Bestellformular.' },
];

/** A label size or sheet the app does not know: entered by hand, with a drawing of the sheet. */
export function CustomSizeDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<OwnSizeForm>(() => formFromParams(printSetup.value.custom));
  const set = (patch: Partial<OwnSizeForm>) => setForm((f) => ({ ...f, ...patch }));
  const result = templateFromForm(form);
  const t = 'template' in result ? result.template : undefined;
  const sheet = form.paper !== 'photo';
  const round = form.shape === 'round';
  // What the app works out for an empty field is shown in it.
  const g = t?.grid;
  const l = t?.label;

  const apply = () => {
    if (!('template' in result)) return;
    updatePrint({ templateId: result.template.id, custom: result.params });
    onClose();
  };

  return (
    <Dialog
      title="Eigene Größe"
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" disabled={!t} onClick={apply}>
            Übernehmen
          </Button>
        </>
      }
    >
      <div class="stack loose own-size">
        <p class="soft">Für Etiketten und Fotosticker, die ich noch nicht kenne. Miss ein Etikett mit dem Lineal aus.</p>
        <Field label="Worauf druckst du?" hint={PAPERS.find((p) => p.value === form.paper)?.hint}>
          <Segmented value={form.paper} options={PAPERS.map((p) => ({ value: p.value, label: p.label }))} onChange={(paper) => set({ paper })} label="Worauf druckst du?" />
        </Field>
        {sheet ? (
          <Field label="Papierformat">
            <Segmented
              value={form.page}
              options={[
                { value: 'a4', label: 'A4' },
                { value: 'letter', label: 'Letter (USA)' },
              ]}
              onChange={(page) => set({ page })}
              label="Papierformat"
            />
          </Field>
        ) : null}
        <Field label="Form">
          <Segmented
            value={form.shape}
            options={[
              { value: 'rect', label: 'Eckig' },
              { value: 'round', label: 'Rund' },
            ]}
            onChange={(shape) => set({ shape })}
            label="Form"
          />
        </Field>
        <div class="own-size-grid">
          <NumberField id="own-w" label={round ? 'Durchmesser' : 'Breite'} unit="mm" value={form.width} onInput={(width) => set({ width })} />
          {round ? null : <NumberField id="own-h" label="Höhe" unit="mm" value={form.height} onInput={(height) => set({ height })} />}
        </div>
        {sheet ? (
          <fieldset class="own-size-sheet">
            <legend>Auf dem {form.page === 'letter' ? 'Letter' : 'A4'}-Bogen</legend>
            <p class="soft small">Leere Felder rechne ich selbst aus, so viele Etiketten, wie passen, mittig auf dem Bogen.</p>
            <div class="own-size-grid">
              <NumberField id="own-cols" label="Spalten" value={form.cols} placeholder={g ? String(g.cols) : undefined} onInput={(cols) => set({ cols })} />
              <NumberField id="own-rows" label="Zeilen" value={form.rows} placeholder={g ? String(g.rows) : undefined} onInput={(rows) => set({ rows })} />
              <NumberField id="own-left" label="Rand links" unit="mm" value={form.marginLeft} placeholder={g ? fmtMm(g.marginLeftMm) : undefined} onInput={(marginLeft) => set({ marginLeft })} />
              <NumberField id="own-top" label="Rand oben" unit="mm" value={form.marginTop} placeholder={g ? fmtMm(g.marginTopMm) : undefined} onInput={(marginTop) => set({ marginTop })} />
              <NumberField id="own-gap-x" label="Abstand zwischen den Spalten" unit="mm" value={form.gapX} placeholder={g && l ? fmtMm(g.pitchXMm - l.widthMm) : undefined} onInput={(gapX) => set({ gapX })} />
              <NumberField id="own-gap-y" label="Abstand zwischen den Zeilen" unit="mm" value={form.gapY} placeholder={g && l ? fmtMm(g.pitchYMm - l.heightMm) : undefined} onInput={(gapY) => set({ gapY })} />
            </div>
          </fieldset>
        ) : null}
        {t ? (
          <div class="own-size-preview">
            <SheetDiagram template={t} height={sheet ? 150 : 90} />
            <div class="stack tight">
              <strong>{t.name}</strong>
              <span class="soft small">{t.description}</span>
              {form.paper === 'sheet' ? <span class="soft small">Drucke danach unter „Drucker ausrichten“ die Testseite und halte sie gegen einen Bogen.</span> : null}
            </div>
          </div>
        ) : 'problem' in result ? (
          <Callout tone={result.empty ? 'neutral' : 'warning'}>{result.problem}</Callout>
        ) : null}
      </div>
    </Dialog>
  );
}

function NumberField({ id, label, unit, value, placeholder, onInput }: { id: string; label: string; unit?: string; value: string; placeholder?: string; onInput: (v: string) => void }) {
  return (
    <Field label={label} id={id}>
      <div class="input-suffix">
        <input id={id} class="input" inputMode="decimal" autoComplete="off" value={value} placeholder={placeholder} onInput={(e) => onInput(e.currentTarget.value)} />
        {unit ? <span>{unit}</span> : null}
      </div>
    </Field>
  );
}
