/**
 * "Zuschneiden …" in the menu of a track on the card (TODO 0.3 #131): the
 * trim editor (src/features/trim/TrimEditor.tsx) in a dialog, and saving
 * its edit on the card. Cut without converting (core/audio/trimedit.ts);
 * the file on the card is replaced only once the new one is complete. On
 * request every track of the folder loses the same seconds at its start
 * and its end (the same title music before every episode).
 *
 * The props are those of the dialog before 0.6 ("Anfang und Ende
 * abschneiden"), so every place that opened it opens the editor now.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Scissors } from 'lucide-preact';
import { isAbortError } from '../../core/audio/errors';
import type { Mp3Index } from '../../core/audio/mp3frames';
import type { TrimEdit } from '../../core/audio/trimedit';
import { folderName } from '../../core/tonuino/sd';
import type { ByteSource } from '../../platform/types';
import { card } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { formatDuration, plural } from '../../app/format';
import { Button, Callout, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast } from '../../ui/components/Toast';
import type { TrackRow } from '../cards/trackTitles';
import { TrimEditor, type TrimInfo } from '../trim/TrimEditor';
import { afterRewrite, messageOf, type Rewritten } from './trackEdit';
import { isMp3 } from './tagWrite';
import { isAccessLost, isWriteDenied } from './writeDenied';
import { WriteAccessNotice, WriteFixButton } from './WriteAccessNotice';

async function audioHelpers() {
  const [{ scanMp3 }, { sameEndsFor, writeTrimEdit, planTrimEdit }, { fileSource }] = await Promise.all([
    import('../../core/audio/mp3frames'),
    import('../../core/audio/trimedit'),
    import('../../core/audio/source'),
  ]);
  return { scanMp3, sameEndsFor, writeTrimEdit, planTrimEdit, fileSource };
}

export interface TrimDialogProps {
  /** The folder on the card (1–99) and its tracks as the list shows them. */
  folder: number;
  rows: TrackRow[];
  /** The track to cut ("003.mp3"). */
  file: string;
  /** Stops the list's player: one thing plays at a time. Called before listening and before saving. */
  beforeSave: () => void;
  onClose: () => void;
  /** „Ab hier abschneiden“ from the player: the end grip starts at this second. */
  cutFrom?: number;
}

export function TrimDialog({ folder, rows, file, beforeSave, onClose, cutFrom }: TrimDialogProps) {
  const packaged = card.value?.volume.access === 'snapshot';
  const row = rows.find((r) => r.file === file);
  const title = row?.title || file;
  const [source, setSource] = useState<ByteSource | { error: string } | null>(null);
  const [edit, setEdit] = useState<TrimEdit | null>(null);
  const [info, setInfo] = useState<TrimInfo | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [problem, setProblem] = useState<{ text: string; error: unknown } | null>(null);
  const stopRef = useRef(false);
  const others = rows.filter((r) => isMp3(r.file)).length;
  const cutsInside = (edit?.cuts.length ?? 0) > 0;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!isMp3(file)) throw new Error('Zuschneiden geht nur bei MP3-Dateien.');
        const dir = await card.value!.volume.root.dir(folderName(folder));
        const src = await dir.source(file);
        if (alive) setSource(src);
      } catch (e) {
        if (alive) setSource({ error: messageOf(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [folder, file]);

  const run = async () => {
    if (!edit || !info?.index) return;
    beforeSave();
    setProblem(null);
    stopRef.current = false;
    const s = card.value;
    const before = s?.scan?.folders.find((x) => x.number === folder);
    if (!s || !before) {
      setProblem({ text: 'Der Ordner ist nicht mehr auf der Karte. Lies die Karte neu ein.', error: null });
      return;
    }
    const each = all && !cutsInside;
    const targets = each ? rows.map((r) => r.file) : [file];
    const written: Rewritten[] = [];
    const skipped: string[] = [];
    let failure: unknown = null;
    setBusy({ done: 0, total: targets.length });
    try {
      const dir = await s.volume.root.dir(folderName(folder));
      const { scanMp3, sameEndsFor, writeTrimEdit, planTrimEdit, fileSource } = await audioHelpers();
      const own: Mp3Index = info.index;
      await writeGuard.during('tracks', async () => {
        for (let i = 0; i < targets.length && !stopRef.current; i++) {
          const f = targets[i];
          try {
            if (!isMp3(f)) throw new Error('keine MP3');
            const src = await dir.source(f);
            const idx = await scanMp3(src);
            const e = f === file ? edit : sameEndsFor(edit, own.durationSec, idx.durationSec);
            const p = idx.layer === 3 ? planTrimEdit(idx, e) : null;
            if (!p) {
              skipped.push(f);
            } else if (p.parts.length > 1 || p.parts[0].startFrame > 0 || p.parts[0].endFrame < idx.frameCount) {
              const blob = await writeTrimEdit(src, idx, e);
              const durationSec = (await scanMp3(fileSource(blob, f))).durationSec;
              await dir.write(f, blob);
              written.push({ file: f, oldSize: src.size, size: blob.size, durationSec });
            }
          } catch (err) {
            if (isWriteDenied(err) || isAccessLost(err)) {
              failure = err;
              break;
            }
            skipped.push(f);
          }
          setBusy({ done: i + 1, total: targets.length });
        }
        await afterRewrite(dir, folder, before, written);
      });
    } catch (e) {
      failure ??= e;
    }
    setBusy(null);
    if (failure && !isAbortError(failure)) {
      const done = written.length ? ` ${plural(written.length, 'Titel ist', 'Titel sind')} schon geschnitten.` : ' Es wurde nichts geändert.';
      setProblem({ text: `${messageOf(failure)}${done}`, error: failure });
      return;
    }
    const names = (files: string[]) => files.map((f) => rows.find((r) => r.file === f)?.title ?? f);
    if (written.length) {
      const rest = skipped.length ? ` Zu kurz oder keine MP3, darum unverändert: ${names(skipped).slice(0, 3).join(', ')}${skipped.length > 3 ? ' und weitere' : ''}.` : '';
      toast.success(
        each ? `${plural(written.length, 'Titel', 'Titel')} zugeschnitten` : `„${title}“ zugeschnitten`,
        `${packaged ? 'Kommt mit dem nächsten Paket auf die Karte.' : 'Am Ton hat sich sonst nichts geändert.'}${rest}`,
      );
    } else toast.info('Nichts geschnitten', skipped.length ? 'Die Titel sind zu kurz dafür oder keine MP3-Dateien.' : 'Es gab nichts abzuschneiden.');
    onClose();
  };

  const tooMuch = !!info?.index && !info.plan;
  const ready = !!info?.index && !!info.plan && !info.untouched;
  return (
    <Dialog
      title="Zuschneiden"
      width="xwide"
      onClose={busy ? () => (stopRef.current = true) : onClose}
      dismissable={!busy}
      footer={
        busy ? (
          <Button onClick={() => (stopRef.current = true)}>Anhalten</Button>
        ) : (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" icon={Scissors} disabled={!ready} onClick={() => void run()}>
              {info?.plan && ready ? `Zuschneiden (${formatDuration(info.plan.durationSec)})` : 'Zuschneiden'}
            </Button>
          </>
        )
      }
    >
      <div class="stack trim-dialog">
        <WriteAccessNotice />
        <p class="trim-track ellipsis" style={{ margin: 0 }}>
          <b>{title}</b> <span class="muted small">({file})</span>
        </p>
        {source && 'error' in source ? <Callout tone="warning">{source.error}</Callout> : null}
        {source && !('error' in source) ? (
          <TrimEditor
            source={source}
            title={title}
            cutFrom={cutFrom}
            beforePlay={beforeSave}
            disabled={!!busy}
            onChange={(e, i) => {
              setEdit(e);
              setInfo(i);
            }}
          >
            {others > 1 ? (
              <label class="row trim-all" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={all && !cutsInside} disabled={!!busy || cutsInside} onChange={(e) => setAll(e.currentTarget.checked)} />
                <span class="small">
                  Bei allen {others} Titeln im Ordner Anfang und Ende gleich abschneiden
                  <span class="tiny muted" style={{ display: 'block' }}>
                    {cutsInside ? 'Geht nur ohne herausgeschnittene Stücke.' : 'Für die gleiche Titelmusik vor jeder Folge. Titel, die dafür zu kurz sind, bleiben, wie sie sind.'}
                  </span>
                </span>
              </label>
            ) : null}
          </TrimEditor>
        ) : null}
        {tooMuch ? <Callout tone="warning">Dann bliebe von diesem Titel fast nichts übrig. Lasse mehr übrig.</Callout> : null}
        <p class="tiny muted" style={{ margin: 0 }}>
          Was du wegschneidest, ist danach {packaged ? 'mit dem nächsten Paket ' : ''}von der Karte weg. Brauchst du es noch, behalte die Originale auf deinem Computer.
        </p>
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
              Schneide … {busy.done} von {busy.total}.{' '}
              {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
            </span>
            <Progress value={busy.done} max={busy.total} label="Zuschneiden" />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
