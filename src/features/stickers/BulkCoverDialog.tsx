import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ImagePlus, RotateCcw, Search, X } from 'lucide-preact';
import {
  chosenCandidate,
  coverlessFolders,
  dropCandidate,
  inPool,
  isUnreachable,
  needsLook,
  newRows,
  OFFLINE_MESSAGE,
  pickCandidate,
  pickNone,
  pickOwn,
  reviewSummary,
  rowsToSave,
  runBulkSearch,
  SEARCH_CONCURRENCY,
  SEARCH_SPACING_MS,
  searchProgress,
  setChecked,
  UnreachableError,
  withResult,
  withStatus,
  type BulkRow,
  type BulkTarget,
} from '../../core/stickers/bulkcover';
import { searchCovers, type CoverCandidate } from '../../core/stickers/coversearch';
import { isAbortError } from '../../core/stickers/image';
import { folderName } from '../../core/tonuino/sd';
import { Dialog } from '../../ui/components/Dialog';
import { Badge, Button, Callout, Progress, Spinner } from '../../ui/components/controls';
import { Cover } from '../../ui/components/Cover';
import { toast, toastError } from '../../ui/components/Toast';
import { bytesToObjectUrl } from '../../ui/image';
import { card, catalog, shownMemory, type CoverChange } from '../../app/state';
import { setCoversAnywhere } from '../../app/waiting';
import { plural } from '../../app/format';
import { pickCoverFile, prepareCover, type ReadyCover } from '../box/CoverDialog';
import { coverFetch, loadSearchCover, SOURCE_LABEL } from '../box/CoverSearch';
import '../../ui/styles/bulkcover.css';

/**
 * Folders on the open card that have no cover yet (see coverlessFolders).
 * `only` limits the list, e.g. to the folders picked for printing.
 */
export function coverlessOnCard(only?: readonly number[]): BulkTarget[] {
  const s = card.value;
  // The remembered box: the covers found wait on this device until its card is open again.
  const m = s ? null : shownMemory.value;
  if (m) return coverlessFolders(m.scan, m.catalog, m.coverUrls, only);
  if (s?.status !== 'ready' || !s.scan || !s.catalog) return [];
  return coverlessFolders(s.scan, s.catalog, s.covers, only);
}

type Phase =
  /** What will happen; nothing has gone to the internet yet. */
  | 'intro'
  | 'searching'
  /** Proposals to look through. */
  | 'review'
  /** Loading the chosen pictures; cancelling leaves the card as it was. */
  | 'loading'
  /** Writing the cover file and the catalog; not to be interrupted. */
  | 'writing';

type OwnPicture = ReadyCover & { url: string };

/** Which card is open: the dialog's folders belong to the card it was opened on. */
function openCardKey(): string | undefined {
  const s = card.value;
  const m = s ? null : shownMemory.value;
  if (m) return `gemerkt\n${m.catalog.id}`;
  return s?.catalog ? `${s.volume.id}\n${s.catalog.id}` : undefined;
}

const OTHER_CARD = 'Inzwischen ist eine andere SD-Karte geöffnet. Gespeichert wurde nichts. Schließe das Fenster und suche die Cover für diese Karte neu.';
const CARD_GONE = 'Die SD-Karte ist nicht mehr geöffnet. Öffne sie wieder und sieh in Meine Box nach, welche Cover noch fehlen.';

/**
 * "Cover suchen" for many folders at once: searches every folder without a
 * cover, proposes the best hit with a few others, and saves the chosen ones
 * in one go. Nothing is saved before "Ausgewählte übernehmen".
 */
export function BulkCoverDialog({ targets, onClose }: { targets: readonly BulkTarget[]; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [rows, setRowState] = useState<BulkRow[]>(() => newRows(targets));
  // The rows as they are now, also for code that awaited something meanwhile.
  const rowsRef = useRef(rows);
  const setRows = (change: (rs: BulkRow[]) => BulkRow[]) => {
    rowsRef.current = change(rowsRef.current);
    setRowState(rowsRef.current);
  };
  const [own, setOwn] = useState<ReadonlyMap<number, OwnPicture>>(new Map());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loaded, setLoaded] = useState({ done: 0, total: 0 });
  const [outcome, setOutcome] = useState<{ saved: number; failed: number; writeError?: string } | null>(null);
  const search = useRef<AbortController | null>(null);
  const loading = useRef<AbortController | null>(null);
  const ownRef = useRef(own);
  ownRef.current = own;
  const openedOn = useRef(openCardKey());

  // Closing the dialog stops the search and the downloads; own pictures are let go.
  useEffect(
    () => () => {
      search.current?.abort();
      loading.current?.abort();
      for (const p of ownRef.current.values()) URL.revokeObjectURL(p.url);
    },
    [],
  );

  const update = (folder: number, change: (r: BulkRow) => BulkRow) => setRows((rs) => rs.map((r) => (r.target.folder === folder ? change(r) : r)));

  const searchable = targets.filter((t) => t.query);
  const progress = searchProgress(rows);
  const toSave = rowsToSave(rows);
  // Not searched yet, or the search did not get an answer: both can be searched again.
  const leftOverRows = rows.filter((r) => !r.saved && r.target.query && (r.status === 'stopped' || r.status === 'failed'));
  const leftOver = leftOverRows.map((r) => r.target);
  const retryLabel = `${plural(leftOver.length, 'Ordner', 'Ordner')} ${leftOverRows.some((r) => r.status === 'stopped') ? 'weitersuchen' : 'noch einmal suchen'}`;
  const busy = phase === 'loading' || phase === 'writing';

  /** Searches the given folders; rows that have an answer already stay as they are. */
  const runSearch = async (list: readonly BulkTarget[]) => {
    setFatal(null);
    setOutcome(null);
    setWarnings([]);
    if (!list.some((t) => t.query)) {
      setPhase('review');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setFatal(OFFLINE_MESSAGE);
      return;
    }
    search.current?.abort();
    const ctrl = new AbortController();
    search.current = ctrl;
    const folders = new Set(list.map((t) => t.folder));
    setRows((rs) => rs.map((r) => (folders.has(r.target.folder) && r.target.query ? withStatus(r, 'waiting') : r)));
    setPhase('searching');
    try {
      await runBulkSearch(list, {
        signal: ctrl.signal,
        search: (query, signal) => searchCovers(query, { fetchFn: coverFetch, signal }),
        onStart: (folder) => update(folder, (r) => withStatus(r, 'searching')),
        onResult: (folder, result) => {
          if (ctrl.signal.aborted) return;
          update(folder, (r) => withResult(r, result));
          // A service that did not answer is worth saying, unless neither did (then the row says it).
          if (result.warnings.length && !isUnreachable(result)) setWarnings((ws) => [...new Set([...ws, ...result.warnings])].slice(-2));
        },
      });
      if (search.current === ctrl) setPhase('review');
    } catch (e) {
      if (search.current !== ctrl) return;
      // Stopped, or no service answers: what was found so far stays, the rest can be searched again.
      setRows((rs) => rs.map((r) => (r.status === 'waiting' || r.status === 'searching' ? withStatus(r, 'stopped') : r)));
      if (e instanceof UnreachableError) setFatal(e.message);
      else if (!isAbortError(e)) setFatal('Die Suche hat nicht geklappt. Versuche es noch einmal.');
      // Without any answer yet, back to the start, where "Noch einmal versuchen" waits.
      const anything = rowsRef.current.some((r) => r.status === 'found' || r.status === 'nothing' || r.choice.kind === 'own');
      setPhase(anything || !(e instanceof UnreachableError) ? 'review' : 'intro');
    } finally {
      if (search.current === ctrl) search.current = null;
    }
  };

  const stopSearch = () => search.current?.abort();

  const chooseOwn = async (row: BulkRow) => {
    try {
      const picture = await pickCoverFile();
      if (!picture) return;
      const ready = await prepareCover(picture, 'image/jpeg', 'Datei');
      const url = bytesToObjectUrl(ready.data, ready.mimeType);
      setOwn((m) => {
        const next = new Map(m);
        const old = next.get(row.target.folder);
        if (old) URL.revokeObjectURL(old.url);
        next.set(row.target.folder, { ...ready, url });
        return next;
      });
      update(row.target.folder, pickOwn);
    } catch (e) {
      toastError('Das Bild passt nicht', e);
    }
  };

  const save = async () => {
    const picks = rowsToSave(rowsRef.current);
    if (!picks.length) return;
    const onCard = openCardKey();
    if (onCard !== openedOn.current) {
      setOutcome(null);
      setFatal(onCard ? OTHER_CARD : CARD_GONE);
      return;
    }
    const ctrl = new AbortController();
    loading.current = ctrl;
    setOutcome(null);
    setFatal(null);
    setPhase('loading');
    setLoaded({ done: 0, total: picks.length });
    setRows((rs) => rs.map((r) => (r.error ? { ...r, error: undefined } : r)));
    const errors = new Map<number, string>();
    const ready: CoverChange[] = [];
    try {
      let done = 0;
      await inPool(picks, SEARCH_CONCURRENCY, async (row) => {
        const folder = row.target.folder;
        try {
          const mine = ownRef.current.get(folder);
          const hit = chosenCandidate(row);
          let cover: ReadyCover;
          if (row.choice.kind === 'own' && mine) cover = mine;
          else if (hit) {
            const blob = await loadSearchCover(hit, ctrl.signal);
            cover = await prepareCover(blob, blob.type || 'image/jpeg', SOURCE_LABEL[hit.source]);
          } else throw new Error('Wähle für diesen Ordner ein Bild aus.');
          if (!ctrl.signal.aborted) ready.push({ folder, data: cover.data, mimeType: cover.mimeType, source: cover.source });
        } catch (e) {
          if (ctrl.signal.aborted) throw e;
          errors.set(folder, e instanceof Error ? e.message : String(e));
        } finally {
          if (!ctrl.signal.aborted) setLoaded({ done: ++done, total: picks.length });
        }
      });
    } catch {
      // Cancelled while loading: nothing was written.
    }
    if (loading.current !== ctrl || ctrl.signal.aborted) {
      if (loading.current === ctrl) setPhase('review');
      return;
    }
    loading.current = null;

    let written: number[] = [];
    let writeError: string | undefined;
    if (ready.length && openCardKey() !== openedOn.current) {
      // The card changed while the pictures loaded: these folders belong to the other one.
      writeError = openCardKey() ? OTHER_CARD : CARD_GONE;
    } else if (ready.length) {
      setPhase('writing');
      try {
        written = await setCoversAnywhere(
          ready.sort((a, b) => a.folder - b.folder),
          { onlyMissing: true },
        );
        if (openCardKey() !== openedOn.current) writeError = CARD_GONE;
      } catch (e) {
        writeError = `Die Cover ließen sich nicht speichern. ${e instanceof Error ? e.message : String(e)} Deine bisherigen Cover sind unverändert.`;
      }
    }
    const savedNow = new Set(written);
    setRows((rs) =>
      rs.map((r) => {
        const folder = r.target.folder;
        if (savedNow.has(folder)) return { ...r, saved: true, checked: false, error: undefined };
        if (errors.has(folder)) return { ...r, error: errors.get(folder) };
        // Got a cover elsewhere while this dialog was open: that one stays.
        if (!writeError && ready.some((c) => c.folder === folder)) return { ...r, checked: false, error: 'Dieser Ordner hat inzwischen ein Cover. Es bleibt, wie es ist.' };
        return r;
      }),
    );
    // Pictures taken over are not needed in memory any more.
    setOwn((m) => {
      const next = new Map(m);
      for (const n of savedNow) {
        const p = next.get(n);
        if (p) URL.revokeObjectURL(p.url);
        next.delete(n);
      }
      return next;
    });
    const failed = errors.size + (writeError ? ready.length : 0);
    if (!failed) {
      if (written.length) toast.success(written.length === 1 ? 'Cover gespeichert' : `${written.length} Cover gespeichert`, 'Du findest sie in Meine Box und auf den Stickern.');
      onClose();
      return;
    }
    setOutcome({ saved: written.length, failed, writeError });
    setPhase('review');
  };

  const cancelLoading = () => {
    loading.current?.abort();
    loading.current = null;
    setPhase('review');
  };

  const footer =
    phase === 'intro' ? (
      <>
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" icon={searchable.length ? Search : undefined} onClick={() => void runSearch(targets)}>
          {searchable.length ? (fatal ? 'Noch einmal versuchen' : 'Suche starten') : 'Weiter'}
        </Button>
      </>
    ) : (
      <>
        {phase === 'loading' ? (
          <Button onClick={cancelLoading}>Abbrechen</Button>
        ) : (
          <Button onClick={onClose} disabled={phase === 'writing'}>
            {rows.some((r) => r.saved) ? 'Schließen' : 'Abbrechen'}
          </Button>
        )}
        <Button variant="primary" disabled={phase !== 'review' || !toSave.length} loading={busy} onClick={() => void save()}>
          {phase === 'loading' ? `Bilder werden geladen: ${loaded.done} von ${loaded.total}` : phase === 'writing' ? 'Wird gespeichert …' : `Ausgewählte übernehmen${toSave.length ? ` (${toSave.length})` : ''}`}
        </Button>
      </>
    );

  return (
    <Dialog title="Fehlende Cover suchen" width={phase === 'intro' ? 'normal' : 'xwide'} onClose={onClose} dismissable={phase !== 'writing'} footer={footer}>
      {phase === 'intro' ? (
        <Intro targets={targets} fatal={fatal} />
      ) : (
        <div class="stack bulk-cover">
          {phase === 'searching' ? (
            <div class="bulk-progress" aria-live="polite">
              <div class="row wrap">
                <span class="grow">
                  <b>Suche läuft:</b> {progress.done} von {progress.total}
                </span>
                <Button size="sm" variant="ghost" icon={X} onClick={stopSearch}>
                  Suche anhalten
                </Button>
              </div>
              <Progress value={progress.done} max={Math.max(1, progress.total)} label="Cover-Suche" />
            </div>
          ) : null}
          {fatal ? (
            <Callout tone="danger">
              <div class="stack tight">
                <span>{fatal}</span>
                {phase === 'review' && leftOver.length ? (
                  <div>
                    <Button size="sm" icon={RotateCcw} onClick={() => void runSearch(leftOver)}>
                      Noch einmal versuchen
                    </Button>
                  </div>
                ) : null}
              </div>
            </Callout>
          ) : null}
          {outcome ? (
            <Callout tone={outcome.writeError ? 'danger' : 'warning'}>
              {outcome.writeError
                ? outcome.writeError
                : `${outcome.saved ? `${plural(outcome.saved, 'Cover ist', 'Cover sind')} gespeichert. ` : ''}Bei ${plural(outcome.failed, 'Ordner', 'Ordnern')} hat es nicht geklappt. Was du tun kannst, steht beim Ordner.`}
            </Callout>
          ) : null}
          {phase === 'review' && !fatal && !outcome ? (
            <p class="soft" aria-live="polite">
              {reviewSummary(rows)}
              {leftOver.length ? (
                <>
                  {' '}
                  <button type="button" class="inline-link" onClick={() => void runSearch(leftOver)}>
                    {retryLabel}
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          {warnings.length ? (
            <Callout tone="warning">
              {warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </Callout>
          ) : null}
          <ul class="bulk-rows" aria-label="Ordner ohne Cover">
            {rows.map((row) => (
              <Row
                key={row.target.folder}
                row={row}
                own={own.get(row.target.folder)}
                locked={busy}
                onCheck={(v) => update(row.target.folder, (r) => setChecked(r, v))}
                onPick={(id) => update(row.target.folder, (r) => pickCandidate(r, id))}
                onNone={() => update(row.target.folder, pickNone)}
                onOwn={() => void chooseOwn(row)}
                onBroken={(id) => update(row.target.folder, (r) => dropCandidate(r, id))}
              />
            ))}
          </ul>
          <p class="hint">Bilder von iTunes und MusicBrainz (Cover Art Archive). Cover sind urheberrechtlich geschützt: Nutze sie nur für deine eigenen Karten und gib sie nicht weiter.</p>
        </div>
      )}
    </Dialog>
  );
}

function Intro({ targets, fatal }: { targets: readonly BulkTarget[]; fatal: string | null }) {
  const searchable = targets.filter((t) => t.query);
  const unnamed = targets.filter((t) => !t.query);
  // One search after the other, a few seconds apart (see SEARCH_SPACING_MS).
  const seconds = Math.ceil((searchable.length * SEARCH_SPACING_MS) / 1000);
  return (
    <div class="stack">
      {fatal ? <Callout tone="danger">{fatal}</Callout> : null}
      <p>
        <b>{plural(targets.length, 'Ordner hat', 'Ordner haben')} noch kein Cover.</b>{' '}
        {searchable.length
          ? 'Ich suche mit den Namen der Hörspiele nach den passenden Bildern. Danach siehst du die Vorschläge und entscheidest bei jedem Ordner selbst. Gespeichert wird erst, wenn du „Ausgewählte übernehmen“ drückst.'
          : 'Für die Suche fehlen ihnen genaue Namen. Du kannst aber für jeden Ordner ein eigenes Bild nehmen.'}
      </p>
      {searchable.length ? (
        <ul class="bulk-facts">
          <li>Gesucht wird bei iTunes (Apple) und MusicBrainz. Diese Dienste bekommen dafür die Namen deiner Hörspiele.</li>
          <li>{seconds < 60 ? 'Das dauert weniger als eine Minute.' : `Das dauert etwa ${plural(Math.round(seconds / 60), 'Minute', 'Minuten')}, weil ich die Dienste nicht überlasten will.`}</li>
          {unnamed.length ? (
            <li>
              {unnamed.length === 1 ? 'Ein Ordner hat' : `${unnamed.length} Ordner haben`} keinen genauen Namen ({unnamed.map((t) => folderName(t.folder)).join(', ')}). Dafür suche ich nicht, du kannst aber ein eigenes Bild nehmen.
            </li>
          ) : null}
        </ul>
      ) : null}
      <p class="small soft">
        Mehr dazu in der Hilfe unter <a href="#/hilfe/cover-finden">Cover für viele Ordner finden</a>.
      </p>
    </div>
  );
}

function Row({
  row,
  own,
  locked,
  onCheck,
  onPick,
  onNone,
  onOwn,
  onBroken,
}: {
  row: BulkRow;
  own?: OwnPicture;
  locked: boolean;
  onCheck: (v: boolean) => void;
  onPick: (id: string) => void;
  onNone: () => void;
  onOwn: () => void;
  onBroken: (id: string) => void;
}) {
  const { target } = row;
  const id = `bulk-${target.folder}`;
  const hit = chosenCandidate(row);
  const picture = row.choice.kind === 'own' ? own?.url : hit?.thumbUrl;
  const canCheck = !row.saved && row.choice.kind !== 'none';
  const weak = needsLook(row) && row.choice.kind === 'candidate';
  return (
    <li class={`bulk-row ${row.checked ? 'checked' : ''} ${row.saved ? 'saved' : ''}`}>
      <input type="checkbox" id={id} checked={row.checked} disabled={!canCheck || locked} onChange={(e) => onCheck(e.currentTarget.checked)} aria-describedby={`${id}-state`} />
      <span class="bulk-picture">
        {picture ? (
          <img src={picture} alt="" referrerpolicy="no-referrer" onError={() => hit && row.choice.kind === 'candidate' && onBroken(hit.id)} />
        ) : row.status === 'searching' ? (
          <Spinner size={22} />
        ) : (
          <Cover title={target.title} seed={target.folder} number={folderName(target.folder)} color={catalog.value?.folders[folderName(target.folder)]?.color} small />
        )}
      </span>
      <div class="bulk-main">
        <label for={id} class={`bulk-title ${target.detail ? '' : 'solo'}`}>
          <span class="pick-num">{folderName(target.folder)}</span>
          {target.title}
        </label>
        {target.detail ? <span class="bulk-detail">{target.detail}</span> : null}
        <div class="bulk-state" id={`${id}-state`}>
          <RowState row={row} hit={hit} weak={weak} />
        </div>
        {row.error ? <p class="bulk-error">{row.error}</p> : null}
        {!row.saved && row.candidates.length ? (
          <div class="bulk-alts" role="radiogroup" aria-label={`Treffer für „${target.title}“`}>
            {row.candidates.map((c) => (
              <Alternative key={c.id} candidate={c} checked={row.choice.kind === 'candidate' && row.choice.id === c.id} disabled={locked} onPick={() => onPick(c.id)} onBroken={() => onBroken(c.id)} />
            ))}
          </div>
        ) : null}
        {!row.saved && row.status !== 'searching' && row.status !== 'waiting' ? (
          <div class="row wrap bulk-actions">
            {row.candidates.length || row.choice.kind === 'own' ? (
              <Button size="sm" variant="ghost" onClick={onNone} disabled={locked || row.choice.kind === 'none'}>
                Kein passendes
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" icon={ImagePlus} onClick={onOwn} disabled={locked}>
              Eigenes Bild …
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function RowState({ row, hit, weak }: { row: BulkRow; hit?: CoverCandidate; weak: boolean }) {
  if (row.saved) return <Badge tone="success">Gespeichert</Badge>;
  if (row.choice.kind === 'own') return <span>Eigenes Bild</span>;
  switch (row.status) {
    case 'waiting':
      return <span class="muted">Wartet auf die Suche …</span>;
    case 'searching':
      return <span class="muted">Sucht …</span>;
    case 'noName':
      return <span class="soft">Ohne genauen Namen suche ich nicht. Gib dem Ordner einen Namen oder nimm ein eigenes Bild.</span>;
    case 'nothing':
      return <span class="soft">Nichts gefunden. Nimm ein eigenes Bild oder gib dem Ordner einen genaueren Namen.</span>;
    case 'failed':
      return <span class="soft">Die Suche hat nicht geklappt, weil ein Dienst nicht geantwortet hat. Suche noch einmal oder nimm ein eigenes Bild.</span>;
    case 'stopped':
      return <span class="muted">Nicht gesucht.</span>;
    case 'found':
      if (!hit) return <span class="soft">Kein Cover für diesen Ordner.</span>;
      return (
        <span class="bulk-hit">
          {weak ? <Badge tone="warning">Unsicher – bitte prüfen</Badge> : null}
          <span>
            {hit.title}
            {hit.artist ? ` · ${hit.artist}` : ''} <span class="muted">({SOURCE_LABEL[hit.source]})</span>
          </span>
        </span>
      );
  }
}

function Alternative({ candidate: c, checked, disabled, onPick, onBroken }: { candidate: CoverCandidate; checked: boolean; disabled: boolean; onPick: () => void; onBroken: () => void }) {
  const label = `${c.title}${c.artist ? ` – ${c.artist}` : ''}${c.year ? `, ${c.year}` : ''} (${SOURCE_LABEL[c.source]})`;
  return (
    <button type="button" role="radio" aria-checked={checked} class="bulk-alt" title={label} aria-label={label} disabled={disabled} onClick={onPick}>
      <img src={c.thumbUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onError={onBroken} />
    </button>
  );
}

/** Folders on the open card without a cover, kept up to date for entry points like "Cover suchen". */
export function useCoverless(only?: readonly number[]): BulkTarget[] {
  const s = card.value;
  const m = shownMemory.value;
  const key = only?.join(',');
  return useMemo(() => coverlessOnCard(only), [s?.scan, s?.catalog, s?.covers, s?.status, m?.catalog, m?.coverUrls, key]);
}
