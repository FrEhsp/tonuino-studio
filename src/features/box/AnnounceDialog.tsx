/**
 * "Titelansagen", an extra of the settings page: the computer's voice says
 * each track's title in front of the track, inside the MP3 (announce.ts),
 * so an unchanged TonUINO plays it. "Titelansagen entfernen" cuts exactly
 * that off again; it needs no voice, so it works in the browser too.
 *
 * Like "Anfang/Ende abschneiden", each file on the card is replaced only
 * once its new version is complete.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Megaphone, MegaphoneOff, Pause, Play, RefreshCw } from 'lucide-preact';
import { isAbortError } from '../../core/audio/errors';
import { folderName } from '../../core/tonuino/sd';
import { card, platform } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { plural } from '../../app/format';
import { Button, Callout, Field, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast } from '../../ui/components/Toast';
import { openPlayer, type MediaLike } from '../../ui/nativeAudio';
import { DesktopAppLink } from '../help/DesktopAppLink';
import type { TrackRow } from '../cards/trackTitles';
import { afterRewrite, messageOf, type Rewritten } from './trackEdit';
import { isMp3 } from './tagWrite';
import { isAccessLost, isWriteDenied } from './writeDenied';
import { WriteAccessNotice, WriteFixButton } from './WriteAccessNotice';
import { announceTargets, lookForVoice, voice, voiceLabel, WEB_VOICE_TEXT } from './voice';

async function audioHelpers() {
  const [announce, { readTags }, { fileSource }] = await Promise.all([import('../../core/audio/announce'), import('../../core/audio/id3'), import('../../core/audio/source')]);
  return { ...announce, readTags, fileSource };
}

/** A failure of the voice itself: the next title would fail the same way. */
class VoiceFailed extends Error {}

export function AnnounceDialog({ folder, rows, mode, beforeSave, onClose }: { folder: number; rows: TrackRow[]; mode: 'add' | 'remove'; beforeSave: () => void; onClose: () => void }) {
  const packaged = card.value?.volume.access === 'snapshot';
  const speech = platform.value?.speech;
  const v = voice.value;
  const [withNumber, setWithNumber] = useState(false);
  const [sample, setSample] = useState(rows.find((r) => isMp3(r.file))?.file ?? '');
  const [playing, setPlaying] = useState<'loading' | 'playing' | null>(null);
  /** Remove: how many files carry an announcement, by their tag. */
  const [noted, setNoted] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [problem, setProblem] = useState<{ text: string; error: unknown } | null>(null);
  const player = useRef<{ el: MediaLike; free: () => void } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const targets = announceTargets(rows, withNumber);

  useEffect(() => {
    if (mode === 'add') void lookForVoice();
  }, [mode]);

  // Which files have an announcement: only their tags are read, the start of each is checked when it is cut off.
  const fileKey = rows.map((r) => r.file).join('/');
  useEffect(() => {
    if (mode !== 'remove') return;
    let alive = true;
    void (async () => {
      const found: string[] = [];
      try {
        const dir = await card.value!.volume.root.dir(folderName(folder));
        const { readTags, parseMark } = await audioHelpers();
        for (const r of rows) {
          if (!alive) return;
          if (!isMp3(r.file)) continue;
          const { tags } = await readTags(await dir.source(r.file)).catch(() => ({ tags: {} as { announcement?: string } }));
          if (parseMark(tags.announcement)) found.push(r.file);
        }
      } catch {
        // Unreadable folder: the dialog says nothing was found.
      }
      if (alive) setNoted(found);
    })();
    return () => {
      alive = false;
    };
  }, [mode, folder, fileKey]);

  const stopPreview = () => {
    const p = player.current;
    player.current = null;
    setPlaying(null);
    p?.free();
  };
  useEffect(() => stopPreview, []);

  /** One title as the box will say it, without changing the card. */
  const preview = async () => {
    if (playing) return stopPreview();
    const t = targets.find((x) => x.file === sample);
    if (!t || !speech) return;
    beforeSave();
    setProblem(null);
    setPlaying('loading');
    try {
      const { encodeAnnouncement } = await audioHelpers();
      const mp3 = await encodeAnnouncement(await speech.say(t.text), { sampleRate: 44100, channels: 1, bitrateKbps: 96 });
      const p = await openPlayer(new Blob([mp3 as BlobPart], { type: 'audio/mpeg' }), 'ansage.mp3');
      const el = p.el;
      player.current = p;
      el.addEventListener('ended', stopPreview);
      setPlaying('playing');
      await el.play();
    } catch (e) {
      stopPreview();
      setProblem({ text: `Die Probe ging nicht. ${messageOf(e)}`, error: null });
    }
  };

  const run = async () => {
    stopPreview();
    beforeSave();
    setProblem(null);
    const s = card.value;
    const before = s?.scan?.folders.find((x) => x.number === folder);
    if (!s || !before) {
      setProblem({ text: 'Der Ordner ist nicht mehr auf der Karte. Lies die Karte neu ein.', error: null });
      return;
    }
    if (mode === 'add' && !speech) return;
    const files = mode === 'add' ? targets.map((t) => t.file) : (noted ?? []);
    const textOf = new Map(targets.map((t) => [t.file, t.text]));
    const written: Rewritten[] = [];
    const skipped: string[] = [];
    let replaced = 0;
    let failure: unknown = null;
    const c = (ctrl.current = new AbortController());
    setBusy({ done: 0, total: files.length });
    try {
      const dir = await s.volume.root.dir(folderName(folder));
      const { announceTrack, unannounceTrack } = await audioHelpers();
      await writeGuard.during('tracks', async () => {
        for (let i = 0; i < files.length && !c.signal.aborted; i++) {
          const f = files[i];
          try {
            const src = await dir.source(f);
            if (mode === 'add') {
              const say = async () => {
                try {
                  return await speech!.say(textOf.get(f)!);
                } catch (e) {
                  throw new VoiceFailed(messageOf(e));
                }
              };
              const r = await announceTrack(src, say, { signal: c.signal });
              await dir.write(f, r.blob);
              if (r.replaced) replaced++;
              written.push({ file: f, oldSize: src.size, size: r.blob.size, durationSec: r.durationSec });
            } else {
              const r = await unannounceTrack(src, { signal: c.signal });
              if (!r) skipped.push(f);
              else {
                await dir.write(f, r.blob);
                written.push({ file: f, oldSize: src.size, size: r.blob.size, durationSec: r.durationSec });
              }
            }
          } catch (e) {
            if (isAbortError(e)) break;
            if (e instanceof VoiceFailed || isWriteDenied(e) || isAccessLost(e)) {
              failure = e;
              break;
            }
            skipped.push(f);
          }
          setBusy({ done: i + 1, total: files.length });
        }
        await afterRewrite(dir, folder, before, written);
      });
    } catch (e) {
      failure ??= e;
    }
    ctrl.current = null;
    setBusy(null);
    const names = (list: string[]) => {
      const t = list.map((f) => `„${rows.find((r) => r.file === f)?.title ?? f}“`);
      return `${t.slice(0, 3).join(', ')}${t.length > 3 ? ' und weitere' : ''}`;
    };
    if (failure && !isAbortError(failure)) {
      const done = written.length ? ` ${plural(written.length, 'Titel ist', 'Titel sind')} schon fertig.` : ' Es wurde nichts geändert.';
      setProblem({ text: `${messageOf(failure)}${done}`, error: failure });
      return;
    }
    if (mode === 'add') {
      const rest = skipped.length ? ` Unverändert, weil die Datei dafür nicht passt: ${names(skipped)}.` : '';
      const again = replaced ? ` ${plural(replaced, 'Titel hatte', 'Titel hatten')} schon eine Ansage, sie ist jetzt neu.` : '';
      if (written.length) toast.success(`${plural(written.length, 'Titel hat', 'Titel haben')} jetzt eine Ansage`, `${packaged ? 'Kommt mit dem nächsten Paket auf die Karte.' : 'Die Box sagt den Titel, bevor er losgeht.'}${again}${rest}`);
      else toast.info('Keine Ansage dazugekommen', c.signal.aborted ? 'Angehalten, bevor ein Titel fertig war.' : `Die Dateien passen nicht dafür.${rest}`);
    } else {
      const rest = skipped.length ? ` Bei ${names(skipped)} hat sich der Anfang seit der Ansage verändert, darum bleiben sie, wie sie sind.` : '';
      if (written.length) toast.success(`${plural(written.length, 'Ansage', 'Ansagen')} entfernt`, `${written.length === 1 ? 'Der Titel ist' : 'Die Titel sind'} wieder wie vorher.${rest}`);
      else toast.info('Nichts entfernt', c.signal.aborted ? 'Angehalten, bevor ein Titel fertig war.' : `Keine Ansage ließ sich sicher abschneiden.${rest}`);
    }
    onClose();
  };

  const stop = () => ctrl.current?.abort();
  const ready = mode === 'add' ? v?.kind === 'ready' && !!targets.length : !!noted?.length;
  const others = rows.length - targets.length;
  return (
    <Dialog
      title={mode === 'add' ? 'Titelansagen hinzufügen' : 'Titelansagen entfernen'}
      onClose={busy ? stop : onClose}
      dismissable={!busy}
      footer={
        busy ? (
          <Button onClick={stop}>Anhalten</Button>
        ) : (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" icon={mode === 'add' ? Megaphone : MegaphoneOff} disabled={!ready} onClick={() => void run()}>
              {mode === 'add' ? 'Ansagen hinzufügen' : 'Ansagen entfernen'}
            </Button>
          </>
        )
      }
    >
      <div class="stack announce-dialog">
        <WriteAccessNotice />
        {mode === 'add' ? (
          <>
            <p>
              Vor {targets.length === 1 ? 'den Titel' : `jeden der ${targets.length} Titel`} kommt sein Name, gesprochen von der Stimme des Computers. So weiß auch ein Kind, das noch nicht lesen kann, was gleich kommt.
              {others > 0 ? ` ${plural(others, 'Datei ist', 'Dateien sind')} keine MP3 und ${others === 1 ? 'bleibt' : 'bleiben'} ohne.` : ''}
            </p>
            {v?.kind === 'web' ? (
              <Callout tone="warning">
                <div class="stack tight">
                  <span>{WEB_VOICE_TEXT}</span>
                  <DesktopAppLink />
                </div>
              </Callout>
            ) : v?.kind === 'none' ? (
              <Callout tone="warning">
                <div class="stack tight">
                  <span>{v.text}</span>
                  <span>
                    <Button size="sm" icon={RefreshCw} onClick={() => void lookForVoice(true)}>
                      Noch einmal suchen
                    </Button>
                  </span>
                </div>
              </Callout>
            ) : v?.kind === 'ready' ? (
              <>
                <p class="small muted">Es spricht: {voiceLabel(v.info)}</p>
                {v.note ? <Callout tone="neutral">{v.note}</Callout> : null}
                <label class="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={withNumber} disabled={!!busy} onChange={(e) => setWithNumber(e.currentTarget.checked)} />
                  <span>
                    Nummer mitsagen
                    <span class="small muted" style={{ display: 'block' }}>
                      Zum Beispiel „Titel 3. {targets[2]?.title ?? targets[0]?.title ?? 'Der Hund'}“, für Hörbücher mit Kapiteln.
                    </span>
                  </span>
                </label>
                {targets.length ? (
                  <div class="row wrap announce-sample" style={{ gap: 8, alignItems: 'flex-end' }}>
                    <Field label="Probe mit diesem Titel" id="announce-sample">
                      <select id="announce-sample" class="select" value={sample} disabled={!!busy} onChange={(e) => (stopPreview(), setSample(e.currentTarget.value))}>
                        {targets.map((t) => (
                          <option key={t.file} value={t.file}>
                            {t.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Button icon={playing === 'playing' ? Pause : Play} loading={playing === 'loading'} disabled={!!busy} onClick={() => void preview()}>
                      {playing === 'playing' ? 'Anhalten' : 'Probe anhören'}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <p class="small muted">Suche die Stimme des Computers …</p>
            )}
            <Callout tone="neutral">
              Die Ansage kommt in die Datei, die Musik selbst wird dabei nicht neu umgewandelt. Mit „Titelansagen entfernen“ im Menü des Ordners ist sie wieder weg. Hat ein Titel schon eine, wird sie ersetzt.
            </Callout>
          </>
        ) : noted === null ? (
          <p class="small muted">Sehe nach, welche Titel eine Ansage haben …</p>
        ) : noted.length ? (
          <p>
            {plural(noted.length, 'Titel hat', 'Titel haben')} eine Ansage von der App. Sie wird genau abgeschnitten, der Titel ist danach wieder wie vorher. Wurde der Anfang eines Titels seitdem geändert, bleibt er, wie er ist.
          </p>
        ) : (
          <Callout tone="info">In diesem Ordner hat kein Titel eine Ansage von der App. Ansagen aus anderen Programmen erkennt sie nicht.</Callout>
        )}
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
              {mode === 'add' ? 'Spreche die Titel ein' : 'Entferne die Ansagen'} … {busy.done} von {busy.total}.{' '}
              {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
            </span>
            <Progress value={busy.done} max={busy.total} label={mode === 'add' ? 'Titelansagen' : 'Ansagen entfernen'} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
