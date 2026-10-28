/**
 * „Zuschneiden …“ for a title that is not on the card yet (0.6, #131): the
 * same editor as for a title on the card (src/features/trim/TrimEditor.tsx).
 * The cut is kept with the title (session.ts trimTracks): the picked file
 * stays as it is, the card gets the cut title when it is copied. Opened
 * again, the editor shows the whole file with the cut as it was.
 */
import { useState } from 'preact/hooks';
import { Scissors } from 'lucide-preact';
import type { TrimEdit } from '../../core/audio/trimedit';
import { sameEndsFor, timeBeforeEdit } from '../../core/audio/trimedit';
import { isPlayableAsIs } from '../../core/library/grouping';
import type { ByteSource } from '../../platform/types';
import { formatDuration, plural } from '../../app/format';
import { Button, Callout, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast, toastError } from '../../ui/components/Toast';
import { TrimEditor, type TrimInfo } from '../trim/TrimEditor';
import { session, trimTracks, untrimTrack, type ImportAlbum } from './session';

export interface TrimPendingProps {
  /** The album in the selection and the title's file as the list has it now. */
  albumId: string;
  source: ByteSource;
  /** „Ab hier abschneiden“ from the player: the end grip starts at this second. */
  cutFrom?: number;
  /** Stops the list's player: one thing plays at a time. */
  beforePlay?: () => void;
  onClose: () => void;
}

export function TrimPendingDialog({ albumId, source, cutFrom, beforePlay, onClose }: TrimPendingProps) {
  const album: ImportAlbum | undefined = session.value.albums.find((a) => a.id === albumId);
  const track = album?.tracks.find((t) => t.source === source);
  const [edit, setEdit] = useState<TrimEdit | null>(null);
  const [info, setInfo] = useState<TrimInfo | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  if (!album || !track) return null;
  const title = track.title || track.source.name;
  const original = track.trimmed?.source ?? track.source;
  const mp3s = album.tracks.filter((t) => isPlayableAsIs(t));
  const cutsInside = (edit?.cuts.length ?? 0) > 0;
  // „Ab hier abschneiden“ on a title cut before: the player played the cut title, the editor shows the whole file.
  const before = track.trimmed?.edit;
  const ownFrom = before && cutFrom !== undefined ? timeBeforeEdit(before, cutFrom) : undefined;
  const initial = before && ownFrom !== undefined ? { startSec: before.startSec, endSec: ownFrom, cuts: before.cuts.filter((c) => c.toSec < ownFrom) } : before;
  const each = all && !cutsInside && mp3s.length > 1;

  const run = async () => {
    if (!edit || !info?.index) return;
    beforePlay?.();
    const own = info.index.durationSec;
    const edits = new Map<ByteSource, TrimEdit>([[track.source, edit]]);
    if (each)
      for (const t of mp3s) {
        if (t === track) continue;
        const sec = t.trimmed?.info?.durationSec ?? t.info?.durationSec;
        if (sec) edits.set(t.source, sameEndsFor(edit, own, sec));
      }
    setBusy({ done: 0, total: edits.size });
    try {
      const r = await trimTracks(album.id, edits, { onProgress: (done, total) => setBusy({ done, total }) });
      const rest = r.skipped.length ? ` Zu kurz dafür, darum unverändert: ${r.skipped.slice(0, 3).join(', ')}${r.skipped.length > 3 ? ' und weitere' : ''}.` : '';
      if (r.cut)
        toast.success(
          each ? `${plural(r.cut, 'Titel', 'Titel')} zugeschnitten` : `„${title}“ zugeschnitten`,
          `${r.cut > 1 ? 'So kommen sie' : 'So kommt er'} auf die Karte. Deine ${r.cut > 1 ? 'Dateien bleiben' : 'Datei bleibt'}, wie sie ${r.cut > 1 ? 'sind' : 'ist'}.${rest}`,
        );
      else if (!r.skipped.length) toast.info('Nichts geschnitten', 'Der Titel bleibt ganz.');
      else toast.info('Nichts geschnitten', 'Der Titel ist zu kurz dafür.');
      onClose();
    } catch (e) {
      toastError('Zuschneiden hat nicht geklappt', e);
      setBusy(null);
    }
  };

  const tooMuch = !!info?.index && !info.plan;
  const changed = !!info?.index && !!info.plan && (!info.untouched || !!track.trimmed);
  return (
    <Dialog
      title="Zuschneiden"
      width="xwide"
      onClose={onClose}
      dismissable={!busy}
      footer={
        busy ? null : (
          <>
            {track.trimmed ? (
              <Button
                variant="ghost"
                onClick={() => {
                  untrimTrack(album.id, track.source);
                  toast.info('Schnitt zurückgenommen', `„${title}“ kommt ganz auf die Karte.`);
                  onClose();
                }}
              >
                Schnitt zurücknehmen
              </Button>
            ) : null}
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" icon={Scissors} disabled={!changed} onClick={() => void run()}>
              {info?.plan && changed ? `Zuschneiden (${formatDuration(info.plan.durationSec)})` : 'Zuschneiden'}
            </Button>
          </>
        )
      }
    >
      <div class="stack trim-dialog">
        <p class="trim-track ellipsis" style={{ margin: 0 }}>
          <b>{title}</b> <span class="muted small">({original.relativePath ?? original.name})</span>
        </p>
        <TrimEditor
          source={original}
          title={title}
          initial={initial}
          cutFrom={before ? undefined : cutFrom}
          beforePlay={beforePlay}
          disabled={!!busy}
          onChange={(e, i) => {
            setEdit(e);
            setInfo(i);
          }}
        >
          {mp3s.length > 1 ? (
            <label class="row trim-all" style={{ gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={each} disabled={!!busy || cutsInside} onChange={(e) => setAll(e.currentTarget.checked)} />
              <span class="small">
                Bei allen {mp3s.length} Titeln Anfang und Ende gleich abschneiden
                <span class="tiny muted" style={{ display: 'block' }}>
                  {cutsInside ? 'Geht nur ohne herausgeschnittene Stücke.' : 'Für die gleiche Titelmusik vor jeder Folge. Titel, die dafür zu kurz sind, bleiben, wie sie sind.'}
                </span>
              </span>
            </label>
          ) : null}
        </TrimEditor>
        {tooMuch ? <Callout tone="warning">Dann bliebe von diesem Titel fast nichts übrig. Lasse mehr übrig.</Callout> : null}
        <p class="tiny muted" style={{ margin: 0 }}>
          Deine Datei bleibt, wie sie ist. Auf die SD-Karte kommt der zugeschnittene Titel, wenn du kopierst.
        </p>
        {busy ? (
          <div class="stack tight">
            <span class="small">
              Schneide … {busy.done} von {busy.total}.
            </span>
            <Progress value={busy.done} max={busy.total} label="Zuschneiden" />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
