/**
 * "Liste einfügen": cards as lines of text, as TonUINO NFC Tools reads them
 * ("HEX;Titel"), from Tonuino Cards Manager, the TTS-Editor, the Exceltool
 * or an old list of Studio's own. Each line says what card it is, or why it
 * is none; the good ones go on the list of cards to write, selected.
 */
import { useMemo, useState } from 'preact/hooks';
import type { CardData, FirmwareProfile } from '../../core/tonuino/card';
import { parsePastedCards, pastedLabel, type PastedCard } from '../../core/tonuino/cardlist';
import { storedCard } from '../../core/tonuino/cardedit';
import { folderName } from '../../core/tonuino/sd';
import { Dialog } from '../../ui/components/Dialog';
import { Button } from '../../ui/components/controls';
import { toast, toastError } from '../../ui/components/Toast';
import { plural } from '../../app/format';
import { boxScan, catalog, profile } from '../../app/state';
import { addExtraCards, cardItems, extraLabel, isFolderExtra, isSelected, newCards, sameCard, setSelected, trackCounts } from './items';
import '../../ui/styles/freecard.css';

export function PasteListDialog({ onClose }: { onClose: () => void }) {
  const prof = profile.value;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const titles = catalog.value?.folders;
  const scan = boxScan.value;
  const rows = useMemo(() => {
    const counts = scan ? trackCounts(scan) : undefined;
    return parsePastedCards(text, prof, (n) => titles?.[folderName(n)]?.title, counts && ((n) => counts.get(n)));
  }, [text, prof, titles, scan]);
  const good = rows.filter((r) => r.card);
  const bad = rows.length - good.length;

  const add = async () => {
    setBusy(true);
    try {
      await addAllToList(good, prof);
      onClose();
    } catch (e) {
      toastError('Die Karten ließen sich nicht hinzufügen', e);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Liste einfügen"
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={add} loading={busy} disabled={!good.length}>
            {good.length > 1 ? `${good.length} Karten in die Liste` : 'In die Liste'}
          </Button>
        </>
      }
    >
      <div class="stack">
        <label for="paste-list-text" class="small" style={{ fontWeight: 600 }}>
          Eine Karte pro Zeile: erst die Bytes, dann „;“ und ein Titel
        </label>
        <textarea
          id="paste-list-text"
          class="textarea paste-list-text mono"
          rows={6}
          spellcheck={false}
          autocomplete="off"
          placeholder={'1337b347020405000000;Die Olchis\n1337b3470200010f00;Schlummerkarte'}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <p class="small soft">So schreiben TonUINO NFC Tools, Tonuino Cards Manager, der TTS-Editor und das Exceltool ihre Listen. Leere Zeilen stören nicht.</p>
        {rows.length ? (
          <>
            <p class="small" aria-live="polite">
              <b>{good.length ? plural(good.length, 'Karte erkannt', 'Karten erkannt') : 'Noch keine Karte erkannt'}</b>
              {bad ? `, ${plural(bad, 'Zeile passt', 'Zeilen passen')} nicht` : ''}.
            </p>
            <ol class="paste-list-rows">
              {rows.map((r) => (
                <li key={r.line} class={r.card ? 'paste-list-row' : 'paste-list-row bad'}>
                  <span class="paste-list-line">Zeile {r.line}</span>
                  <span class="paste-list-text-col">
                    {r.title ? <b class="block">{r.title}</b> : null}
                    <span class="block">{r.card ? r.says : r.problem}</span>
                    {r.warnings.map((w) => (
                      <span class="block paste-list-warn" key={w}>
                        {w}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Puts the cards on the list of cards to write, selected, as addToList does
 * for one: a card the list has already is selected, not added twice; a card
 * pasted twice comes once.
 */
async function addAllToList(rows: PastedCard[], prof: FirmwareProfile): Promise<void> {
  const items = cardItems.value;
  const cards = rows.flatMap((r) => (r.card ? [{ data: storedCard(r.card), title: r.title }] : []));
  const data = cards.map((c) => c.data);
  const found = new Set(data.map((d) => items.find((i) => sameCard(i.data, d))).filter((i) => i !== undefined));
  for (const item of found) if (!isSelected(item)) setSelected(item, true);
  const listed = found.size;
  const fresh = newCards(items.map((i) => i.data), cards);
  // A further card of a folder keeps the title from the line; a special card is named as the box knows it.
  const labelOf = (d: CardData, title: string) => (isFolderExtra(d) && title ? pastedLabel(title, d.folder, catalog.value?.folders[folderName(d.folder)]?.title) : '') || extraLabel(d, prof);
  if (fresh.length) await addExtraCards(fresh.map(({ data: d, title }) => ({ data: d, label: labelOf(d, title) })));
  const already = listed ? ` ${plural(listed, 'Karte stand', 'Karten standen')} schon drin und ${listed === 1 ? 'ist' : 'sind'} jetzt ausgewählt.` : '';
  if (fresh.length === 1) toast.success('Die Karte steht jetzt in der Liste', `Sie ist ausgewählt. Schreibe sie wie die anderen Karten.${already}`);
  else if (fresh.length) toast.success(`${fresh.length} Karten stehen jetzt in der Liste`, `Sie sind ausgewählt. Schreibe sie wie die anderen Karten.${already}`);
  else toast.success(listed === 1 ? 'Diese Karte steht schon in der Liste' : 'Diese Karten stehen schon in der Liste', listed === 1 ? 'Sie ist jetzt ausgewählt.' : 'Sie sind jetzt ausgewählt.');
}
