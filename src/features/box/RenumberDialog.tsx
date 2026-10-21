import { signal } from '@preact/signals';
import { useMemo, useState } from 'preact/hooks';
import { Nfc } from 'lucide-preact';
import { moveExtraCards, rangeCardsTouching } from '../../core/tonuino/catalog';
import { checkRenumbered, checkSwapped, planFix, planRenumberFolder, planSwapFolders, renumberTargets, swapTargets } from '../../core/tonuino/repair';
import { folderName, type SdScan } from '../../core/tonuino/sd';
import { Button, Callout, Field, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast, toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { card, renumberCover, runRepair, selection, settings, swapCover, updateCatalog } from '../../app/state';
import { extraSelection } from '../cards/items';

/**
 * "Nummer ändern oder tauschen …" in the menu of a folder (audit 0.4 #6).
 * A folder goes to a free number, or swaps its number with another folder
 * ("05" ↔ "12"), so the order on the shelf can change without any other
 * folder moving. The box finds a folder only by its number, and every card
 * written for it names that number: after the change those cards play
 * nothing, or the other folder, so the dialog says so before anything
 * happens, and afterwards the folder page offers them ticked under
 * "Karten beschreiben".
 */

/** The last renumbering in this visit, for the note on the folder page it led to (and, for a swap, on the other one). */
export const renumbered = signal<{ cardId: string; from: number; to: number; extras: string[]; swap?: boolean } | null>(null);

/**
 * The folder being given another number right now. Once the card is read
 * again its old number is gone, a moment before the app shows the new one:
 * the page of the old number then waits instead of saying it does not exist.
 */
export const renumbering = signal<number | null>(null);

/** A long title cut short for the list of folders. */
function short(title: string): string {
  return title.length > 36 ? `${title.slice(0, 34).trimEnd()} …` : title;
}

export function RenumberDialog({ folder, title, onClose }: { folder: number; title: string; onClose: () => void }) {
  const s = card.value!;
  const packaged = s.volume.access === 'snapshot';
  const free = useMemo(() => renumberTargets(s.scan!, s.catalog), [s.scan, s.catalog]);
  const taken = useMemo(() => swapTargets(s.scan!, folder), [s.scan, folder]);
  // The first free number below this one: moving a folder further up is what people ask for ("45 auf 05").
  // With every number taken, the folder right before it: swapping two neighbours is the usual change of order.
  const [to, setTo] = useState(() => free.find((n) => n < folder) ?? free[0] ?? taken.filter((n) => n < folder).at(-1) ?? taken[0] ?? 0);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const swap = taken.includes(to);
  const numbers = useMemo(() => [...free, ...taken, folder].sort((a, b) => a - b), [free, taken, folder]);
  const name = folderName(folder);
  const target = to ? folderName(to) : '';
  const titleOf = (n: number) => s.catalog?.folders[folderName(n)]?.title ?? `Ordner ${folderName(n)}`;
  const other = swap ? titleOf(to) : '';
  const plan = useMemo(
    () => (!to ? null : swap ? planSwapFolders(s.scan!, folder, to) : planRenumberFolder(s.scan!, folder, to, s.catalog)),
    [s.scan, s.catalog, folder, to, swap],
  );
  const extrasOf = (n: number) => s.catalog?.extraCards.filter((x) => x.folder === n) ?? [];
  const extras = extrasOf(folder).length + (swap ? extrasOf(to).length : 0);
  const ranges = s.catalog && to ? rangeCardsTouching(s.catalog, folder, to) : [];

  /**
   * A swap that stopped half way leaves the folders in helper folders: put
   * them right at once, back or forward as the catalog and the marker say
   * (planRecoverTemp). The card read afterwards, or undefined.
   */
  const putRight = async (scan: SdScan | undefined): Promise<SdScan | undefined> => {
    if (!scan?.tempDirs.some((t) => t.swap)) return scan;
    const fix = planFix(scan, { kind: 'recover-temp' }, { pureNumbers: settings.value.pureNumbers, catalog: card.value?.catalog });
    if (!fix.steps.length) return scan;
    return (await runRepair(fix, { kind: 'repair' }).catch(() => undefined))?.scan;
  };

  const runSwap = async () => {
    if (!plan) return;
    const beforeA = s.scan!.folders.find((f) => f.number === folder)!;
    const beforeB = s.scan!.folders.find((f) => f.number === to)!;
    const ids = [...extrasOf(folder), ...extrasOf(to)].map((x) => x.id);
    setBusy({ done: 0, total: plan.steps.length });
    renumbering.value = folder;
    try {
      // A note left from an earlier swap would make an interrupted one go forward before its catalog is written.
      if (s.catalog?.swap) {
        await updateCatalog((c) => {
          delete c.swap;
        });
      }
      const run = await runRepair(plan, {
        kind: 'repair',
        onProgress: (p) => setBusy({ done: p.done, total: p.total }),
        folders: (done) => (done.length ? [folder, to] : []),
      });
      let scan = run.scan;
      if (run.result.error) {
        scan = await putRight(scan);
        // Put right forward: the swap is done after all.
        if (!scan || scan.tempDirs.length || checkSwapped(beforeA, beforeB, scan)) {
          const waiting = !scan || scan.tempDirs.length > 0;
          toast.error(
            waiting ? 'Der Tausch wurde unterbrochen' : `Ordner ${name} und ${target} haben noch ihre alten Nummern`,
            waiting ? `${run.result.error.message} Tippe unter „Meine Box“ auf „Ansehen und reparieren“ und dann auf „Dateien zurücklegen“.` : run.result.error.message,
          );
          setBusy(null);
          return;
        }
      }
      await swapCover(folder, to).catch(() => undefined);
      if (s.catalog) renumbered.value = { cardId: s.catalog.id, from: folder, to, extras: ids, swap: true };
      selection.value = new Set([folder, to]);
      extraSelection.value = new Set(ids);
      navigate({ page: 'folder', folder: to });
      const problem = scan ? checkSwapped(beforeA, beforeB, scan) : 'Ich konnte die Karte danach nicht neu einlesen.';
      if (problem) toast.error(`Schaue bitte in Ordner ${name} und ${target} nach`, problem);
      else toast.success(`„${title}“ ist jetzt Ordner ${target}, „${other}“ Ordner ${name}`, packaged ? 'Kommt mit dem nächsten Paket auf die Karte.' : undefined);
    } catch (e) {
      setBusy(null);
      toastError('Das hat nicht geklappt', e);
    } finally {
      renumbering.value = null;
    }
  };

  const run = async () => {
    if (!plan || !to) return;
    if (swap) return runSwap();
    const before = s.scan!.folders.find((f) => f.number === folder)!;
    let moved: string[] = [];
    setBusy({ done: 0, total: plan.steps.length });
    renumbering.value = folder;
    try {
      const { result, scan } = await runRepair(plan, {
        kind: 'repair',
        // Only once the folder is there under its new number: then its extra cards belong to that number too.
        prepare: (c, done) => {
          if (done.length) moved = moveExtraCards(c, folder, to);
        },
        folders: (done) => (done.length ? [to] : []),
      });
      if (result.error) {
        toast.error(`Ordner ${name} hat noch seine alte Nummer`, result.error.message);
        setBusy(null);
        return;
      }
      // Before the new page shows it: otherwise the picture would load twice. Without it, it still shows, under the old name in the cover file.
      await renumberCover(folder, to).catch(() => undefined);
      if (s.catalog) renumbered.value = { cardId: s.catalog.id, from: folder, to, extras: moved };
      selection.value = new Set([to]);
      extraSelection.value = new Set(moved);
      navigate({ page: 'folder', folder: to });
      // Read back from the card: every file under the new number, nothing left under the old one.
      const problem = scan ? checkRenumbered(before, scan, to) : 'Ich konnte die Karte danach nicht neu einlesen.';
      if (problem) toast.error(`Schaue bitte in Ordner ${folderName(to)} nach`, problem);
      else toast.success(`„${title}“ ist jetzt Ordner ${folderName(to)}`, packaged ? 'Kommt mit dem nächsten Paket auf die Karte.' : undefined);
    } catch (e) {
      setBusy(null);
      toastError('Das hat nicht geklappt', e);
    } finally {
      renumbering.value = null;
    }
  };

  const extraLine = swap
    ? extras === 1
      ? 'Das gilt auch für die weitere Karte der beiden Ordner. '
      : extras > 1
        ? `Das gilt auch für die ${extras} weiteren Karten der beiden Ordner. `
        : ''
    : extras === 1
      ? 'Das gilt auch für die weitere Karte dieses Ordners. '
      : extras > 1
        ? `Das gilt auch für die ${extras} weiteren Karten dieses Ordners. `
        : '';
  return (
    <Dialog
      title={`„${title}“ eine andere Nummer geben`}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={!!busy}>
            Abbrechen
          </Button>
          <Button variant="primary" loading={!!busy} disabled={!plan?.steps.length} onClick={run}>
            {!to ? 'Nummer ändern' : swap ? `Mit ${target} tauschen` : `Nummer ${target} geben`}
          </Button>
        </>
      }
    >
      <div class="stack">
        {busy ? (
          <>
            <p class="small">
              {swap ? 'Die beiden Ordner tauschen ihre Nummern …' : 'Der Ordner bekommt seine neue Nummer …'}{' '}
              {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
            </p>
            <Progress value={busy.done} max={busy.total} />
          </>
        ) : !free.length && !taken.length ? (
          <Callout tone="neutral">Alle Nummern von 01 bis 99 sind belegt. Lösche erst einen Ordner, den du nicht mehr brauchst.</Callout>
        ) : (
          <>
            <Field label="Neue Nummer" id="renumber-to">
              {/* One list in number order: a free number moves the folder there, a taken one swaps the two. */}
              <select id="renumber-to" class="select" style={{ width: '100%', maxWidth: 340 }} value={to} onChange={(e) => setTo(Number(e.currentTarget.value))}>
                {numbers.map((n) =>
                  n === folder ? (
                    <option value={n} key={n} disabled>
                      Ordner {folderName(n)} · „{short(title)}“ (jetzt)
                    </option>
                  ) : (
                    <option value={n} key={n}>
                      Ordner {folderName(n)} · {taken.includes(n) ? `tauschen mit „${short(titleOf(n))}“` : 'frei'}
                    </option>
                  ),
                )}
              </select>
            </Field>
            {plan?.leftovers.length ? (
              <Callout tone="neutral">{plan.leftovers.join(' ')}</Callout>
            ) : swap ? (
              <p>
                <b>
                  Ordner {name} wird {target}, Ordner {target} wird {name}.
                </b>{' '}
                „{title}“ liegt danach in Ordner {target} und „{other}“ in Ordner {name}, jeweils mit allen Titeln. Alle anderen Ordner behalten ihre Nummer.{' '}
                {packaged ? 'Das kommt mit dem nächsten Paket auf die Karte, beide Ordner mit allen Titeln noch einmal.' : null}
              </p>
            ) : (
              <p>
                {plan?.summary[0]} {packaged ? 'Das kommt mit dem nächsten Paket auf die Karte, mit allen Titeln noch einmal, weil der Ordner dort neu entsteht.' : null}
              </p>
            )}
            {swap ? (
              <Callout tone="warning">
                <b>Danach musst du die Karten für beide Ordner neu beschreiben.</b> Die Box findet einen Ordner nur über seine Nummer. Die alte Karte von „{title}“ spielt sonst „{other}“ ab, und umgekehrt. {extraLine}
                Ich wähl sie dir danach unter „Karten beschreiben“ schon aus.
                {ranges.map((r) => ` Die Karte von „${r.title}“ spielt zufällig einen der Ordner ${folderName(r.folder)} bis ${folderName(r.last)}. Schaue, ob das danach noch passt.`).join('')}
              </Callout>
            ) : (
              <Callout tone="warning">
                <b>Danach musst du die Karte für diesen Ordner neu beschreiben.</b> Die Box findet einen Ordner nur über seine Nummer. Karten, die du schon beschrieben hast, suchen weiter Ordner {name} und spielen dann nichts mehr ab. {extraLine}
                {extras ? 'Ich wähl sie dir' : 'Ich wähl dir die Karte'} danach unter „Karten beschreiben“ schon aus.
                {ranges.map((r) => ` Die Karte von „${r.title}“ spielt zufällig einen der Ordner ${folderName(r.folder)} bis ${folderName(r.last)}. Schaue, ob das danach noch passt.`).join('')}
              </Callout>
            )}
            <p class="small soft">{swap ? 'Zeigen deine Sticker die Nummer, drucke beide Sticker auch neu.' : 'Zeigen deine Sticker die Nummer, drucke den Sticker auch neu.'}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** On the folder page after a renumbering or a swap: the cards that need writing again, one tap away. */
export function RenumberedNote({ folder }: { folder: number }) {
  const r = renumbered.value;
  const s = card.value;
  if (!r || !s?.catalog || s.catalog.id !== r.cardId) return null;
  if (r.to !== folder && !(r.swap && r.from === folder)) return null;
  const numbers = r.swap ? [r.to, r.from] : [r.to];
  const count = numbers.length + r.extras.length;
  const other = folder === r.to ? r.from : r.to;
  const otherTitle = s.catalog.folders[folderName(other)]?.title ?? `Ordner ${folderName(other)}`;
  return (
    <Callout tone="warning">
      <div class="row wrap" style={{ gap: 12 }}>
        <div class="grow" style={{ minWidth: 240 }}>
          <b>Das ist jetzt Ordner {folderName(folder)}.</b>{' '}
          {r.swap
            ? `„${otherTitle}“ ist dafür jetzt Ordner ${folderName(other)}. Die ${count} Karten der beiden kennen noch die alten Nummern. Beschreibe sie neu, dann spielt die Box wieder das Richtige.`
            : `${count === 1 ? 'Die Karte dafür kennt' : `Die ${count} Karten dafür kennen`} noch die alte Nummer ${folderName(r.from)}. Beschreibe sie neu, dann spielt die Box ihn wieder.`}
        </div>
        <Button
          size="sm"
          icon={Nfc}
          onClick={() => {
            selection.value = new Set(numbers);
            extraSelection.value = new Set(r.extras);
            renumbered.value = null;
            navigate({ page: 'cards' });
          }}
        >
          {count === 1 ? 'Karte neu beschreiben' : 'Karten neu beschreiben'}
        </Button>
      </div>
    </Callout>
  );
}
