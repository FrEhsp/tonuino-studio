/**
 * "Inhaltsliste drucken" (Meine Box › Mehr): what is on the SD card, one
 * line per folder, to stick inside the lid. Printed straight away or saved
 * as a PDF, like the sticker sheets.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Download, Printer } from 'lucide-preact';
import { buildShelf } from '../../core/tonuino/catalog';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Spinner } from '../../ui/components/controls';
import { toastError, toastSaved } from '../../ui/components/Toast';
import { card, plat } from '../../app/state';
import { canPrint, printDocument } from '../stickers/print';
import { contentAbout, contentLayout, contentRows } from './contentList';
import { drawContentSheet, sheetPdf, sheetPng, type ContentSheet } from './contentListPage';
import '../../ui/styles/contentlist.css';

/** The file name of the list's PDF. */
function listFileName(name: string): string {
  return `Inhaltsliste ${name.replace(/[\\/:*?"<>|]+/g, ' ').trim()}.pdf`;
}

export function ContentListDialog({ onClose }: { onClose: () => void }) {
  const s = card.value;
  const name = s?.catalog?.name ?? s?.volume.label ?? 'TonUINO';
  const rows = useMemo(() => (s?.scan ? contentRows(buildShelf(s.scan, s.catalog ?? null)) : []), [s?.scan, s?.catalog]);
  const layout = contentLayout(rows.length);
  const [sheet, setSheet] = useState<ContentSheet | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    (async () => {
      const drawn = await drawContentSheet(rows, layout, name, contentAbout(rows, new Date()));
      const png = await sheetPng(drawn);
      if (gone) return;
      url = URL.createObjectURL(png);
      setSheet(drawn);
      setPreview(url);
    })().catch((e) => toastError('Die Liste ließ sich nicht zeichnen', e));
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [rows, name]);

  const printNow = async () => {
    if (!sheet) return;
    setBusy('print');
    try {
      await printDocument(plat(), { name: listFileName(name), page: sheet, pages: 1, pdf: () => sheetPdf(sheet), pictures: async () => [await sheetPng(sheet)] });
    } catch (e) {
      toastError('Drucken hat nicht geklappt', e);
    } finally {
      setBusy(null);
    }
  };

  const savePdf = async () => {
    if (!sheet) return;
    setBusy('pdf');
    try {
      if (await plat().files.save(listFileName(name), await sheetPdf(sheet))) toastSaved('Inhaltsliste gespeichert', 'Drucke mit „Tatsächliche Größe“ (100 %).');
    } catch (e) {
      toastError('Das PDF ließ sich nicht erstellen', e);
    } finally {
      setBusy(null);
    }
  };

  const printing = canPrint(plat());
  return (
    <Dialog
      title="Inhaltsliste drucken"
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Schließen
          </Button>
          <Button variant={printing ? 'ghost' : 'primary'} icon={Download} onClick={savePdf} loading={busy === 'pdf'} disabled={!sheet || !!busy}>
            PDF speichern
          </Button>
          {printing ? (
            <Button variant="primary" icon={Printer} onClick={printNow} loading={busy === 'print'} disabled={!sheet || !!busy}>
              Drucken
            </Button>
          ) : null}
        </>
      }
    >
      <div class="stack">
        <p class="soft">
          {layout.sheet === 'a5x2'
            ? 'Alle Ordner auf einen Blick, für den Deckel der Box. Zwei Listen auf einem A4-Blatt: in der Mitte durchschneiden, eine für die Box, eine für dich.'
            : 'Alle Ordner auf einen Blick. Bei so vielen Ordnern bekommt die Liste ein ganzes A4-Blatt.'}
        </p>
        <div class="content-list-preview">{preview ? <img src={preview} alt="Vorschau der Inhaltsliste" /> : <Spinner />}</div>
      </div>
    </Dialog>
  );
}
