/**
 * "Titel zusammenfügen", an extra of the settings page: asks first and says
 * what will happen, then joins the picked tracks into one MP3 (mp3join.ts)
 * and writes it over the first of them. Deleting the others and closing the
 * gap is left to the folder page's own path for a new order (planReorder),
 * which `onJoined` starts: the catalog, the cards and the order on the card
 * stay right that way. The others are deleted only once the new file is
 * complete on the card.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Combine } from 'lucide-preact';
import { readTags, type SmallTags } from '../../core/audio/id3';
import { isAbortError } from '../../core/audio/errors';
import { planReorder } from '../../core/tonuino/repair';
import { folderName } from '../../core/tonuino/sd';
import { card, plat, settings } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { formatDuration, plural } from '../../app/format';
import { Button, Callout, Field, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import type { TrackRow } from '../cards/trackTitles';
import { afterRewrite, messageOf, noRoomFor, type JoinPlan } from './trackEdit';
import { WriteAccessNotice, WriteFixButton } from './WriteAccessNotice';

export function JoinDialog({
  folder,
  rows,
  plan,
  folderTitle,
  artist,
  numberedCards,
  beforeSave,
  onCancel,
  onJoined,
}: {
  folder: number;
  rows: TrackRow[];
  plan: JoinPlan;
  folderTitle: string;
  artist?: string;
  numberedCards: boolean;
  /** Stops a track that plays: its file is about to change. */
  beforeSave: () => void;
  onCancel: () => void;
  /** The joined file is on the card: delete the others and close the gap. */
  onJoined: (lossless: boolean) => void;
}) {
  const packaged = card.value?.volume.access === 'snapshot';
  const byFile = new Map(rows.map((r) => [r.file, r]));
  const picked = plan.files.map((f) => byFile.get(f)).filter((r): r is TrackRow => !!r);
  const first = picked[0];
  const [title, setTitle] = useState(first?.title ?? '');
  const [busy, setBusy] = useState<{ text: string; fraction?: number } | null>(null);
  const [problem, setProblem] = useState<{ text: string; error: unknown } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const total = picked.every((r) => r.durationSec !== undefined) ? picked.reduce((n, r) => n + (r.durationSec ?? 0), 0) : undefined;
  // planReorder numbers the tracks 1, 2, 3 … in the new order: those whose number changes move up.
  const moving = plan.order.filter((f, i) => f !== plan.first && byFile.get(f)?.number !== i + 1).length;

  const run = async () => {
    const c = new AbortController();
    ctrl.current = c;
    setProblem(null);
    setBusy({ text: 'Die Titel werden zusammengefügt …', fraction: 0 });
    try {
      const s = card.value;
      const before = s?.scan?.folders.find((x) => x.number === folder);
      if (!s || !before) throw new Error('Der Ordner ist nicht mehr auf der Karte. Lies die Karte neu ein.');
      // Asked before anything is written: a new order that cannot be saved would leave the joined track next to its parts.
      const reorder = planReorder(before, plan.order, { pureNumbers: settings.value.pureNumbers, tempDirs: s.scan?.tempDirs });
      if (reorder.leftovers.length) throw new Error(reorder.leftovers[0]);
      const dir = await s.volume.root.dir(folderName(folder));
      const sources = await Promise.all(plan.files.map((f) => dir.source(f)));
      // Artist and album of the first track stay; the title is the one typed here.
      const own = await readTags(sources[0])
        .then((r) => r.tags)
        .catch(() => undefined);
      const tags: SmallTags = {
        title: title.trim() || first?.title,
        artist: own?.artist || artist,
        albumArtist: own?.albumArtist,
        album: own?.album || folderTitle,
        genre: own?.genre,
        year: own?.year,
      };
      const [{ mergeMp3Files }, { scanMp3 }, { fileSource }] = await Promise.all([import('../../core/audio/mp3join'), import('../../core/audio/mp3frames'), import('../../core/audio/source')]);
      const merged = await mergeMp3Files(plat().audio, sources, {
        tags,
        bitrateKbps: settings.value.bitrateKbps,
        signal: c.signal,
        onProgress: (fraction) => setBusy({ text: 'Die Titel werden zusammengefügt …', fraction }),
      });
      const durationSec = (await scanMp3(fileSource(merged.blob, plan.first), { signal: c.signal })).durationSec;
      const room = noRoomFor(merged.blob.size);
      if (room) throw new Error(room);
      beforeSave();
      setBusy({ text: packaged ? 'Der neue Titel wird fürs Paket bereitgelegt …' : 'Der neue Titel wird auf die SD-Karte geschrieben …' });
      await writeGuard.during('tracks', async () => {
        await dir.write(plan.first, merged.blob);
        await afterRewrite(dir, folder, before, [{ file: plan.first, oldSize: sources[0].size, size: merged.blob.size, durationSec, title: tags.title }]);
      });
      onJoined(merged.lossless);
    } catch (e) {
      setBusy(null);
      if (c.signal.aborted || isAbortError(e)) return;
      setProblem({ text: `Es wurde nichts geändert. ${messageOf(e)}`, error: e });
    }
  };

  const stop = () => {
    ctrl.current?.abort();
    setBusy(null);
  };
  // Once the new file is being written it must not be stopped halfway.
  const writing = !!busy && busy.fraction === undefined;
  const number = String(plan.order.indexOf(plan.first) + 1).padStart(3, '0');

  return (
    <Dialog
      title={`${plural(picked.length, 'Titel', 'Titel')} zusammenfügen?`}
      onClose={busy ? stop : onCancel}
      dismissable={!writing}
      footer={
        busy ? (
          <Button onClick={stop} disabled={writing}>
            Abbrechen
          </Button>
        ) : (
          <>
            <Button onClick={onCancel}>Abbrechen</Button>
            <Button variant="primary" icon={Combine} disabled={!!plan.problem} onClick={run}>
              Zusammenfügen
            </Button>
          </>
        )
      }
    >
      <div class="stack">
        <WriteAccessNotice />
        {plan.problem ? <Callout tone="warning">{plan.problem}</Callout> : null}
        <p>Diese Titel werden in dieser Reihenfolge zu einem Titel{total !== undefined ? ` (${formatDuration(total)})` : ''}:</p>
        <ol class="stack tight join-list" style={{ paddingLeft: 22 }}>
          {picked.slice(0, 12).map((r) => (
            <li key={r.file}>
              {r.title} <span class="muted small">({r.file})</span>
            </li>
          ))}
          {picked.length > 12 ? <li>… und {picked.length - 12} weitere</li> : null}
        </ol>
        <Field label="Name des neuen Titels" id="join-title">
          <input id="join-title" class="input" value={title} disabled={!!busy} onInput={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <p>
          Der neue Titel bekommt die Nummer {number} und ersetzt „{first?.title}“. {plan.removed.length === 1 ? 'Der andere Titel wird' : `Die ${plan.removed.length} anderen Titel werden`} danach
          {packaged ? ' mit dem nächsten Paket von der Karte gelöscht' : ' von der SD-Karte gelöscht'}
          {moving ? `, ${plural(moving, 'Titel dahinter rückt', 'Titel dahinter rücken')} nach vorn.` : '.'} Die alten Titel lösche ich erst, wenn der neue fertig
          {packaged ? ' bereitliegt' : ' auf der Karte ist'}.
        </p>
        <p class="small muted">MP3-Dateien im gleichen Format füge ich ohne Umwandeln aneinander. Sonst wandle ich die Titel zusammen neu um. Rückgängig machen lässt sich das nicht.</p>
        <Callout tone="warning">
          {numberedCards
            ? 'Für diesen Ordner gibt es Karten, die bestimmte Titelnummern abspielen (Einzeltitel oder von … bis …). Diese Karten musst du danach neu beschreiben.'
            : 'Karten, die einen bestimmten Titel oder einen Bereich von … bis … abspielen, zeigen danach eventuell auf andere Titel.'}
        </Callout>
        {problem ? (
          <Callout tone="danger">
            <div class="stack tight">
              <span>{problem.text}</span>
              <WriteFixButton error={problem.error} />
            </div>
          </Callout>
        ) : null}
        {busy ? (
          <div class="stack tight">
            <span class="small">
              {busy.text} {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
            </span>
            <Progress value={busy.fraction} indeterminate={busy.fraction === undefined} label="Titel zusammenfügen" />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
