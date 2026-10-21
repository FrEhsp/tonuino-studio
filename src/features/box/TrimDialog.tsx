/**
 * "Anfang/Ende abschneiden", an extra of the settings page: seconds off the
 * start and the end of a track (or of every track of the folder, for the
 * same intro before every episode), cut on frame boundaries without
 * converting (mp3trim.ts). The new start and end can be heard first; the
 * file on the card is replaced only once the new one is complete.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Pause, Play, Scissors } from 'lucide-preact';
import type { Mp3Index } from '../../core/audio/mp3frames';
import type { TrimPlan } from '../../core/audio/mp3trim';
import { isAbortError } from '../../core/audio/errors';
import { folderName } from '../../core/tonuino/sd';
import { card } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { formatDuration, plural } from '../../app/format';
import { Button, Callout, Field, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast } from '../../ui/components/Toast';
import { openPlayer, type MediaLike } from '../../ui/nativeAudio';
import type { TrackRow } from '../cards/trackTitles';
import { afterRewrite, messageOf, parseSeconds, type Rewritten } from './trackEdit';
import { isMp3 } from './tagWrite';
import { isAccessLost, isWriteDenied } from './writeDenied';
import { WriteAccessNotice, WriteFixButton } from './WriteAccessNotice';

/** How long the preview of the new end plays up to it. */
const END_PREVIEW_SEC = 6;

async function audioHelpers() {
  const [{ scanMp3 }, { planTrim, trimMp3 }, { fileSource }] = await Promise.all([import('../../core/audio/mp3frames'), import('../../core/audio/mp3trim'), import('../../core/audio/source')]);
  return { scanMp3, planTrim, trimMp3, fileSource };
}

export function TrimDialog({ folder, rows, file, beforeSave, onClose }: { folder: number; rows: TrackRow[]; file: string; beforeSave: () => void; onClose: () => void }) {
  const packaged = card.value?.volume.access === 'snapshot';
  const row = rows.find((r) => r.file === file);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [all, setAll] = useState(false);
  const [look, setLook] = useState<{ index: Mp3Index } | { error: string } | null>(null);
  const [plan, setPlan] = useState<TrimPlan | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [problem, setProblem] = useState<{ text: string; error: unknown } | null>(null);
  const [playing, setPlaying] = useState<'start' | 'end' | null>(null);
  const player = useRef<{ el: MediaLike; free: () => void } | null>(null);
  const stopRef = useRef(false);

  const start = parseSeconds(startText);
  const end = parseSeconds(endText);
  const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= 0;
  const index = look && 'index' in look ? look.index : null;
  const others = rows.filter((r) => isMp3(r.file)).length;

  // The frames of the track: they tell where the cuts land and how long it gets.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        if (!isMp3(file)) throw new Error('Abschneiden geht nur bei MP3-Dateien.');
        const dir = await card.value!.volume.root.dir(folderName(folder));
        const { scanMp3 } = await audioHelpers();
        const idx = await scanMp3(await dir.source(file), { signal: ctrl.signal });
        if (idx.layer !== 3) throw new Error('Diese Datei ist eine ältere Variante (MP1 oder MP2). Abschneiden geht nur bei MP3-Dateien.');
        setLook({ index: idx });
      } catch (e) {
        if (!ctrl.signal.aborted) setLook({ error: messageOf(e) });
      }
    })();
    return () => ctrl.abort();
  }, [folder, file]);

  useEffect(() => {
    if (!index || !valid) return setPlan(null);
    let alive = true;
    void audioHelpers().then(({ planTrim }) => alive && setPlan(planTrim(index, start, end)));
    return () => {
      alive = false;
    };
  }, [index, start, end, valid]);

  const stopPreview = () => {
    const p = player.current;
    player.current = null;
    setPlaying(null);
    p?.free();
  };
  useEffect(() => stopPreview, []);

  /** Plays the track from `from` (seconds) up to `until`, or to its end. */
  const preview = async (which: 'start' | 'end') => {
    if (playing === which) return stopPreview();
    stopPreview();
    if (!plan || !index) return;
    // Only one thing plays at a time: the list's player stops.
    beforeSave();
    const newEnd = index.durationSec - plan.cutEndSec;
    const from = which === 'start' ? plan.cutStartSec : Math.max(plan.cutStartSec, newEnd - END_PREVIEW_SEC);
    const until = newEnd;
    try {
      const dir = await card.value!.volume.root.dir(folderName(folder));
      const p = await openPlayer(await dir.source(file), file);
      const el = p.el;
      player.current = p;
      el.addEventListener('timeupdate', () => {
        if (el.currentTime >= until) stopPreview();
      });
      el.addEventListener('ended', stopPreview);
      el.currentTime = from;
      setPlaying(which);
      await el.play();
    } catch (e) {
      stopPreview();
      toast.error('Anhören geht gerade nicht', messageOf(e));
    }
  };

  const run = async () => {
    stopPreview();
    beforeSave();
    setProblem(null);
    stopRef.current = false;
    const s = card.value;
    const before = s?.scan?.folders.find((x) => x.number === folder);
    if (!s || !before) {
      setProblem({ text: 'Der Ordner ist nicht mehr auf der Karte. Lies die Karte neu ein.', error: null });
      return;
    }
    const targets = all ? rows.map((r) => r.file) : [file];
    const written: Rewritten[] = [];
    const skipped: string[] = [];
    let failure: unknown = null;
    setBusy({ done: 0, total: targets.length });
    try {
      const dir = await s.volume.root.dir(folderName(folder));
      const { scanMp3, planTrim, trimMp3, fileSource } = await audioHelpers();
      await writeGuard.during('tracks', async () => {
        for (let i = 0; i < targets.length && !stopRef.current; i++) {
          const f = targets[i];
          try {
            if (!isMp3(f)) throw new Error('keine MP3');
            const src = await dir.source(f);
            const idx = await scanMp3(src);
            const p = planTrim(idx, start, end);
            if (!p || idx.layer !== 3) {
              skipped.push(f);
            } else if (p.startFrame > 0 || p.endFrame < idx.frameCount) {
              const blob = await trimMp3(src, idx, start, end);
              const durationSec = (await scanMp3(fileSource(blob, f))).durationSec;
              await dir.write(f, blob);
              written.push({ file: f, oldSize: src.size, size: blob.size, durationSec });
            }
          } catch (e) {
            if (isWriteDenied(e) || isAccessLost(e)) {
              failure = e;
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
      const done = written.length ? ` ${plural(written.length, 'Titel ist', 'Titel sind')} schon gekürzt.` : ' Es wurde nichts geändert.';
      setProblem({ text: `${messageOf(failure)}${done}`, error: failure });
      return;
    }
    const names = (files: string[]) => files.map((f) => rows.find((r) => r.file === f)?.title ?? f);
    if (written.length) {
      const rest = skipped.length ? ` Zu kurz oder keine MP3, darum unverändert: ${names(skipped).slice(0, 3).join(', ')}${skipped.length > 3 ? ' und weitere' : ''}.` : '';
      toast.success(
        all ? `${plural(written.length, 'Titel', 'Titel')} gekürzt` : `„${row?.title ?? file}“ gekürzt`,
        `${packaged ? 'Kommt mit dem nächsten Paket auf die Karte.' : 'Am Ton hat sich sonst nichts geändert.'}${rest}`,
      );
    } else toast.info('Nichts gekürzt', skipped.length ? 'Die Titel sind zu kurz dafür oder keine MP3-Dateien.' : 'Es gab nichts abzuschneiden.');
    onClose();
  };

  const tooMuch = !!index && valid && (start > 0 || end > 0) && !plan;
  const nothing = valid && start === 0 && end === 0;
  return (
    <Dialog
      title="Anfang und Ende abschneiden"
      onClose={busy ? () => (stopRef.current = true) : onClose}
      dismissable={!busy}
      footer={
        busy ? (
          <Button onClick={() => (stopRef.current = true)}>Anhalten</Button>
        ) : (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" icon={Scissors} disabled={!plan || nothing} onClick={run}>
              Abschneiden
            </Button>
          </>
        )
      }
    >
      <div class="stack trim-dialog">
        <WriteAccessNotice />
        <p>
          <b>{row?.title ?? file}</b> <span class="muted small">({file})</span>
          {index ? <span class="muted small"> · {formatDuration(index.durationSec)}</span> : null}
        </p>
        {look && 'error' in look ? <Callout tone="warning">{look.error}</Callout> : null}
        <div class="row wrap trim-fields" style={{ gap: 16 }}>
          <Field label="Am Anfang weg (Sekunden)" id="trim-start">
            <input id="trim-start" class="input" inputMode="decimal" placeholder="0" value={startText} disabled={!!busy} aria-invalid={!Number.isFinite(start)} onInput={(e) => setStartText(e.currentTarget.value)} />
          </Field>
          <Field label="Am Ende weg (Sekunden)" id="trim-end">
            <input id="trim-end" class="input" inputMode="decimal" placeholder="0" value={endText} disabled={!!busy} aria-invalid={!Number.isFinite(end)} onInput={(e) => setEndText(e.currentTarget.value)} />
          </Field>
        </div>
        {!valid ? <p class="small trim-error">Gib die Sekunden als Zahl ein, zum Beispiel 12 oder 1:30.</p> : null}
        {tooMuch ? <Callout tone="warning">Dann bliebe von diesem Titel fast nichts übrig. Schneide weniger ab.</Callout> : null}
        {plan && index && !nothing ? (
          <p class="small">
            Danach dauert der Titel {formatDuration(plan.durationSec)} statt {formatDuration(index.durationSec)}. Die Schnitte liegen auf etwa 1/40{' '}Sekunde genau.
          </p>
        ) : null}
        <div class="row wrap" style={{ gap: 8 }}>
          <Button size="sm" icon={playing === 'start' ? Pause : Play} disabled={!plan || !!busy} onClick={() => void preview('start')}>
            {playing === 'start' ? 'Anhalten' : 'Neuen Anfang anhören'}
          </Button>
          <Button size="sm" icon={playing === 'end' ? Pause : Play} disabled={!plan || !!busy} onClick={() => void preview('end')}>
            {playing === 'end' ? 'Anhalten' : 'Neues Ende anhören'}
          </Button>
        </div>
        {others > 1 ? (
          <label class="row trim-all" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={all} disabled={!!busy} onChange={(e) => setAll(e.currentTarget.checked)} />
            <span>
              Bei allen {others} Titeln im Ordner gleich abschneiden
              <span class="small muted" style={{ display: 'block' }}>
                Für die gleiche Titelmusik vor jeder Folge. Titel, die dafür zu kurz sind, bleiben, wie sie sind.
              </span>
            </span>
          </label>
        ) : null}
        <Callout tone="neutral">
          Was du abschneidest, ist danach {packaged ? 'mit dem nächsten Paket ' : ''}von der Karte weg. Brauchst du es noch, behalte die Originale auf deinem Computer.
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
              Schneide … {busy.done} von {busy.total}.{' '}
              {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
            </span>
            <Progress value={busy.done} max={busy.total} label="Abschneiden" />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
