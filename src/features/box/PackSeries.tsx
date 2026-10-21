/**
 * "Reihe in einen Ordner packen" under "Platz auf der Karte" (Meine Box,
 * draft B; Frank 16.10.2026: "das muss sehr leicht sein, weil es viele
 * beschäftigt"). One line: the series found that takes the most folders,
 * with a button; without one a plain button to tick folders by hand. The
 * dialog has the series chosen already, says in one sentence what happens
 * and which cards have to be written anew, and afterwards leads to "Karten
 * beschreiben" with exactly those cards ticked. The packing itself is in
 * core/tonuino/pack.ts and packRun.ts.
 *
 * PackSeriesLine goes into RoomOnCard (BoxPage.tsx); PackDialog is also
 * opened from "Hinzufügen" when no folder is free any more.
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import { Library, Nfc } from 'lucide-preact';
import { rangeCardsTouching, type ShelfItem } from '../../core/tonuino/catalog';
import { planPack, type PackPlan, type PackProgress } from '../../core/tonuino/pack';
import { episodeOrder, findSeries, seriesOfTitle, type FoundSeries } from '../../core/tonuino/series';
import { modeByCode } from '../../core/tonuino/modes';
import { folderName, MAX_TRACKS } from '../../core/tonuino/sd';
import { canChangeCard } from '../../app/pending';
import { navigate } from '../../app/router';
import { card, profile, selection, settings } from '../../app/state';
import { formatBytes, plural } from '../../app/format';
import { Button, Callout, Field, IconButton, Progress } from '../../ui/components/controls';
import { Hoch, Runter } from '../../ui/icons';
import { Dialog } from '../../ui/components/Dialog';
import { extraSelection } from '../cards/items';
import { PackageWaitingDialog } from './PackageWaitingGate';
import { packedSeries, packOnCard, type PackOutcome } from './packRun';
import '../../ui/styles/packseries.css';

/** Room left on the card besides the largest folder copied: the catalog and the cover file are written meanwhile. */
const SPARE_BYTES = 4 * 1024 * 1024;

/** The folders on the card, as the detection and the dialog need them. */
function onCard(shelf: readonly ShelfItem[]): ShelfItem[] {
  return shelf.filter((i) => i.folder && i.state !== 'missing');
}

/** "02, 20 und 21". */
function numberList(numbers: readonly number[]): string {
  const names = numbers.map(folderName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}` : (names[0] ?? '');
}

/** Opens "Karten beschreiben" with exactly these cards ticked. */
function openCards(ids: readonly string[]) {
  selection.value = new Set();
  extraSelection.value = new Set(ids);
  packedSeries.value = null;
  navigate({ page: 'cards' });
}

/** The line under "Platz auf der Karte". */
export function PackSeriesLine({ shelf }: { shelf: ShelfItem[] }) {
  const s = card.value;
  const items = useMemo(() => onCard(shelf), [shelf]);
  const found = useMemo(() => findSeries(items.map((i) => ({ number: i.number, title: i.title, series: i.entry?.series }))), [items]);
  const [open, setOpen] = useState(false);
  if (!s?.scan || (s.status !== 'ready' && !open)) return null;
  // Outside the branches: once packed the line changes, the dialog stays open to show how it went.
  const dialog = open ? <PackDialog shelf={shelf} found={found} onClose={() => setOpen(false)} /> : null;
  return (
    <>
      <Line shelf={items} found={found} onOpen={() => setOpen(true)} />
      {dialog}
    </>
  );
}

function Line({ shelf, found, onOpen }: { shelf: ShelfItem[]; found: FoundSeries[]; onOpen: () => void }) {
  const s = card.value;
  const done = packedSeries.value;
  if (done && done.catalogId === s?.catalog?.id) {
    return (
      <div class="pack-line">
        <span>
          „{done.title}“ ist jetzt Ordner {folderName(done.target)}. {done.cards.length === 1 ? 'Beschreibe die Karte dafür neu.' : `Beschreibe die ${done.cards.length} Karten dafür neu.`}
        </span>
        <Button size="sm" icon={Nfc} onClick={() => openCards(done.cards)}>
          Karten beschreiben
        </Button>
      </div>
    );
  }
  if (found.length) {
    const top = found[0];
    return (
      <div class="pack-line">
        <span>
          „{top.name}“ liegt in {top.folders.length} Ordnern.
        </span>
        <span class="pack-line-actions">
          <Button size="sm" icon={Library} onClick={onOpen}>
            In einen Ordner packen
          </Button>
          {found.length > 1 ? (
            <button type="button" class="link-button" onClick={onOpen}>
              Mehr …
            </button>
          ) : null}
        </span>
      </div>
    );
  }
  if (shelf.length < 2) return null;
  return (
    <div class="pack-line">
      <Button size="sm" variant="ghost" icon={Library} onClick={onOpen}>
        Reihe in einen Ordner packen …
      </Button>
    </div>
  );
}

/** A run keeps its plan: the card read anew afterwards would give a different one. */
type Phase = { kind: 'ask' } | { kind: 'run'; plan: PackPlan; progress?: PackProgress; stopping?: boolean; ordering?: boolean } | { kind: 'done'; plan: PackPlan; outcome: PackOutcome };

/**
 * The dialog: which folders (the series found is ticked), the name, what
 * happens, and the cards to write anew. `found` empty: tick folders by hand.
 * `onPacked`: after a run that packed something (Hinzufügen gives the
 * albums the numbers that became free).
 */
export function PackDialog({ shelf, found, onClose, onPacked }: { shelf: ShelfItem[]; found: FoundSeries[]; onClose: () => void; onPacked?: () => void }) {
  const s = card.value;
  const items = useMemo(() => onCard(shelf), [shelf]);
  // -1: ticked by hand.
  const [which, setWhich] = useState(found.length ? 0 : -1);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(found[0]?.folders ?? []));
  const [typed, setTyped] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });
  const ctrl = useRef<AbortController | null>(null);

  const series = which >= 0 ? found[which] : undefined;
  const shown = series ? items.filter((i) => series.folders.includes(i.number)) : items;
  // The rows in the order of the episodes: by the numbers in the titles, or as moved with the arrows.
  const [moved, setMoved] = useState<number[] | null>(null);
  const sequence = moved ?? episodeOrder(shown.map((i) => ({ number: i.number, title: i.title })));
  const list = sequence.map((n) => shown.find((i) => i.number === n)).filter((i): i is ShelfItem => !!i);
  const numbers = list.filter((i) => chosen.has(i.number)).map((i) => i.number);
  const lowest = Math.min(...numbers);
  const firstTitle = items.find((i) => i.number === lowest)?.title ?? '';
  const name = typed ?? series?.name ?? (seriesOfTitle(firstTitle) || firstTitle);
  const plan = useMemo(
    () =>
      s?.scan
        ? planPack({ scan: s.scan, catalog: s.catalog ?? null, numbers, order: numbers, name, profile: profile.value, pureNumbers: settings.value.pureNumbers, covers: new Set(s.covers.keys()) })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s?.scan, s?.catalog, s?.covers, numbers.join(','), name],
  );
  if (!s || (phase.kind === 'ask' && !plan)) return null;
  if (phase.kind === 'ask' && !canChangeCard()) return <PackageWaitingDialog onClose={onClose} />;

  const packaged = s.volume.access === 'snapshot';
  if (phase.kind === 'done') {
    const { plan, outcome: o } = phase;
    const all = plan.freed.length;
    const packed = o.packed.length;
    const target = plan.groups[0];
    const gone = o.packed.filter((x) => !o.stuck.includes(x.member.number)).map((x) => x.member.number);
    const whole = packed === all && !o.error && !o.cancelled;
    return (
      <Dialog
        title={whole ? 'Fertig gepackt' : o.cancelled ? 'Packen abgebrochen' : 'Packen hat nicht ganz geklappt'}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Schließen</Button>
            {o.cards.length ? (
              <Button variant="primary" icon={Nfc} onClick={() => openCards(o.cards)}>
                Karten beschreiben
              </Button>
            ) : null}
          </>
        }
      >
        <div class="stack">
          {whole ? (
            <p>
              {plan.groups.length === 1
                ? `„${target.title}“ ist jetzt Ordner ${target.name} mit ${plural(target.members.reduce((n, m) => n + m.episodes.length, 0), 'Folge', 'Folgen')}.`
                : `„${plan.name}“ liegt jetzt in den Ordnern ${numberList(plan.groups.map((g) => g.target))}.`}{' '}
              {gone.length === 1 ? `Die Nummer ${numberList(gone)} ist frei.` : gone.length ? `Die Nummern ${numberList(gone)} sind frei.` : ''}
              {packaged ? ' Das kommt mit dem nächsten Paket auf die Karte.' : ''}
            </p>
          ) : (
            <Callout tone={o.cancelled ? 'neutral' : 'danger'}>
              {packed === all
                ? `Alle Ordner sind in Ordner ${target?.name}.`
                : packed
                  ? `${packed} von ${plural(all, 'Ordner', 'Ordnern')} ${packed === 1 ? 'ist' : 'sind'} schon in Ordner ${target?.name}, die anderen sind noch wie vorher.`
                  : 'Es wurde nichts geändert, alle Ordner sind noch wie vorher.'}
              {o.error ? ` ${o.error}` : ''}
            </Callout>
          )}
          {o.stuck.length ? (
            <Callout tone="warning">
              {o.stuck.length === 1 ? `Ordner ${numberList(o.stuck)} ließ sich nicht ganz löschen.` : `Die Ordner ${numberList(o.stuck)} ließen sich nicht ganz löschen.`} Ihre Titel sind schon im neuen Ordner. Schaue unter „Meine Box“ mit „Ansehen und reparieren“ nach, was noch drin ist.
            </Callout>
          ) : null}
          {o.cards.length ? (
            <Callout tone="warning">
              <b>Beschreibe jetzt {o.cards.length === 1 ? 'die Karte' : `die ${o.cards.length} Karten`} dieser Reihe neu.</b> Die alten spielen nichts mehr oder das Falsche. Jede Folge hat ihre eigene Karte „von … bis …“, ich hab sie dir unter „Karten beschreiben“ schon ausgewählt.
            </Callout>
          ) : null}
        </div>
      </Dialog>
    );
  }

  if (phase.kind === 'run') {
    const { plan, progress: p } = phase;
    return (
      <Dialog
        title={`„${plan.name}“ in einen Ordner packen`}
        onClose={() => undefined}
        dismissable={false}
        footer={
          <Button
            disabled={phase.stopping}
            onClick={() => {
              ctrl.current?.abort();
              setPhase({ ...phase, stopping: true });
            }}
          >
            Abbrechen
          </Button>
        }
      >
        <div class="stack">
          <p>
            {phase.ordering ? 'Ich bringe die Folgen in ihre Reihenfolge …' : phase.stopping ? 'Ich höre nach diesem Titel auf …' : p ? `Ich packe „${p.title}“ dazu …` : 'Einen Moment …'}{' '}
            {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
          </p>
          <Progress value={p?.done ?? 0} max={Math.max(1, p?.total ?? 1)} indeterminate={!p} label="Packen" />
          <p class="small soft">Ich kopiere einen Ordner nach dem anderen und prüfe jede Kopie. Einen alten Ordner lösche ich erst, wenn alles von ihm heil angekommen ist.</p>
        </div>
      </Dialog>
    );
  }

  if (!plan) return null;
  const freed = plan.freed.length;
  const after = plan.groups.length + plan.alone.length;
  const freedSet = new Set(plan.freed);
  // The episodes' cards, and the further cards that go along with their tracks.
  const moving = (s.catalog?.extraCards ?? []).filter((x) => freedSet.has(x.folder) && ['track', 'range'].includes(modeByCode(x.mode)?.params ?? '')).length;
  const toWrite = plan.episodes + moving;
  const ranges = s.catalog ? [...new Map(plan.freed.flatMap((n) => rangeCardsTouching(s.catalog!, n, n)).map((r) => [r.folder, r])).values()] : [];
  const free = s.info.freeBytes;
  const tight = !packaged && free !== undefined && plan.groups.length > 0 && free < plan.largest + SPARE_BYTES;
  const ready = !plan.problems.length && !tight && plan.groups.length > 0;

  const move = (from: number, to: number) => {
    const next = list.map((i) => i.number);
    const [n] = next.splice(from, 1);
    next.splice(to, 0, n);
    setMoved(next);
  };

  const pick = (n: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(n);
    else next.delete(n);
    setChosen(next);
  };

  const run = async (plan: PackPlan) => {
    const c = new AbortController();
    ctrl.current = c;
    setPhase({ kind: 'run', plan });
    try {
      const outcome = await packOnCard(plan, {
        signal: c.signal,
        onProgress: (progress) => setPhase((p) => (p.kind === 'run' ? { ...p, progress } : p)),
        onOrder: () => setPhase((p) => (p.kind === 'run' ? { ...p, ordering: true } : p)),
      });
      setPhase({ kind: 'done', plan, outcome });
      if (outcome.packed.length) onPacked?.();
    } catch (e) {
      setPhase({ kind: 'done', plan, outcome: { packed: [], stuck: [], cards: [], error: e instanceof Error ? e.message : String(e) } });
    }
  };

  return (
    <Dialog
      title={series ? `„${series.name}“ in einen Ordner packen` : 'Eine Reihe in einen Ordner packen'}
      onClose={onClose}
      width="wide"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon={Library} disabled={!ready} onClick={() => void run(plan)}>
            {plan.groups.length > 1 ? `In ${plan.groups.length} Ordner packen` : 'In einen Ordner packen'}
          </Button>
        </>
      }
    >
      <div class="stack pack-dialog">
        {found.length ? (
          <Field label="Welche Reihe?" id="pack-which">
            <select
              id="pack-which"
              class="select"
              value={String(which)}
              onChange={(e) => {
                const w = Number(e.currentTarget.value);
                setWhich(w);
                setTyped(null);
                setChosen(new Set(w >= 0 ? found[w].folders : []));
                setMoved(null);
              }}
            >
              {found.map((f, i) => (
                <option value={String(i)} key={f.key}>
                  {f.name} ({plural(f.folders.length, 'Ordner', 'Ordner')})
                </option>
              ))}
              <option value="-1">Ordner selbst ankreuzen</option>
            </select>
          </Field>
        ) : (
          <p>Kreuz die Ordner an, die zusammengehören. Sie kommen als Folgen in den Ordner mit der kleinsten Nummer, in der Reihenfolge der Liste.</p>
        )}

        <ul class="copy-folders pack-folders" aria-label="Folgen in ihrer Reihenfolge">
          {list.map((i, at) => {
            const id = `pack-folder-${i.number}`;
            return (
              <li key={i.number}>
                <input type="checkbox" id={id} checked={chosen.has(i.number)} onChange={(e) => pick(i.number, e.currentTarget.checked)} />
                <label for={id} class="grow">
                  <span class="copy-num">{i.name}</span> {i.title}
                </label>
                <span class="small muted">{plural(i.trackCount, 'Titel', 'Titel')}</span>
                <span class="pack-move">
                  <IconButton size="sm" icon={Hoch} label={`„${i.title}“ nach oben`} disabled={at === 0} onClick={() => move(at, at - 1)} />
                  <IconButton size="sm" icon={Runter} label={`„${i.title}“ nach unten`} disabled={at === list.length - 1} onClick={() => move(at, at + 1)} />
                </span>
              </li>
            );
          })}
        </ul>

        <Field label="Name des Ordners" id="pack-name">
          <input id="pack-name" class="input" value={name} onInput={(e) => setTyped(e.currentTarget.value)} />
        </Field>

        {plan.groups.length ? (
          <p class="pack-sum">
            <b>
              Danach: {plural(after, 'Ordner', 'Ordner')} statt {numbers.length}, {plural(freed, 'Nummer', 'Nummern')} frei.
            </b>{' '}
            {plan.groups.length === 1
              ? `Alles kommt als Folgen in Ordner ${plan.groups[0].name}, in der Reihenfolge der Liste. Mit den Pfeilen änderst du sie.`
              : `Für einen Ordner sind das zu viele Titel (höchstens ${MAX_TRACKS}), deshalb verteile ich sie auf ${plan.groups.length} Ordner: ${numberList(plan.groups.map((g) => g.target))}.`}
            {plan.alone.length ? ` ${plan.alone.length === 1 ? `Ordner ${numberList(plan.alone)} bleibt` : `Die Ordner ${numberList(plan.alone)} bleiben`}, wie ${plan.alone.length === 1 ? 'er ist' : 'sie sind'}: Dafür ist kein Platz mehr.` : ''}
            {packaged ? ' Das kommt mit dem nächsten Paket auf die Karte.' : ''}
          </p>
        ) : null}

        {plan.problems.length && numbers.length ? (
          <Callout tone="neutral">
            <div class="stack tight">
              {plan.problems.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </div>
          </Callout>
        ) : null}
        {tight ? (
          <Callout tone="neutral">
            Auf der Karte ist zu wenig Platz frei. Ich kopiere erst und lösche dann, dafür brauch ich bis zu {formatBytes(plan.largest + SPARE_BYTES)}, frei {free === undefined ? 'ist nicht bekannt' : `sind ${formatBytes(free)}`}.
          </Callout>
        ) : null}

        {plan.groups.length ? (
          <Callout tone="warning">
            <b>Danach musst du {toWrite === 1 ? 'die Karte' : `die ${toWrite} Karten`} dieser Reihe neu beschreiben.</b> Die Box findet einen Ordner nur über seine Nummer. Jede Folge bekommt eine eigene Karte „von … bis …“, ich zeig dir danach, welche.
            {ranges.map((r) => ` Die Karte von „${r.title}“ spielt zufällig einen der Ordner ${folderName(r.folder)} bis ${folderName(r.last)}. Schaue, ob das danach noch passt.`).join('')}
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
