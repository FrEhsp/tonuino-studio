/**
 * "Aufnehmen": the Android app's own page for recording (a tab of its own,
 * second after the cards). A phone has its microphone in hand, so on the
 * phone this is an everyday way to fill a folder, not a link hidden under
 * "Hinzufügen". The recorder is the one of the dialog (useRecorder); the
 * take goes to "Hinzufügen" like a picked file, where the review asks for
 * the folder. Without an SD card it waits here, or is saved as a file.
 *
 * The page stays built while another one shows (App.tsx), so a take is not
 * lost by a look at "Meine Box"; a recording that runs stops when the page
 * goes out of sight.
 */
import { useEffect } from 'preact/hooks';
import { Check, Mic, Pause, Play, RotateCcw, Square } from 'lucide-preact';
import { MAX_RECORDING_SEC, recordingFileName } from '../../core/audio/recording';
import { formatDuration } from '../../app/format';
import { card, plat } from '../../app/state';
import { canChangeCard } from '../../app/pending';
import { usePageShown } from '../../app/pageAlive';
import { cardIntoDevice, theDevice } from '../../app/device';
import { Button, Callout } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { useRecorder } from './RecordDialog';
import { BackToWorkshop } from '../../ui/components/BackToWorkshop';

export function RecordPage() {
  const r = useRecorder(undefined);
  const { phase, problem, playing, saving, supported, recordingNow, blocked } = r;
  const shown = usePageShown();
  // Out of sight, the microphone stops: what was recorded so far stays as the take.
  useEffect(() => {
    if (!shown && recordingNow) r.finish();
  }, [shown]);

  const s = card.value;
  const cardReady = !!s && s.status === 'ready' && !!s.scan && canChangeCard();
  const recording = phase.kind === 'recording';
  const level = recording ? Math.round(phase.level * 100) : 0;

  const saveFile = async () => {
    if (phase.kind !== 'recorded') return;
    try {
      await plat().files.save(recordingFileName(r.name), phase.wav);
    } catch (e) {
      toastError('Speichern hat nicht geklappt', e);
    }
  };

  return (
    <div class="page narrow record-page">
      <header class="page-header">
        <div class="titles">
          <BackToWorkshop />
          <h1>Selbst aufnehmen</h1>
          <p>Oma liest vor, ihr singt ein Lied. Ich mach daraus einen Titel für die Box.</p>
        </div>
      </header>

      {!supported ? (
        <Callout tone="warning">Auf diesem Gerät kann ich nicht aufnehmen. Das Mikrofon lässt sich hier nicht öffnen.</Callout>
      ) : phase.kind === 'recorded' ? (
        <section class="card pad stack recorder done" aria-label="Deine Aufnahme">
          <div class="recorder-take">
            <Button size="lg" icon={playing ? Pause : Play} onClick={() => void r.listen()}>
              {playing ? 'Anhalten' : 'Anhören'}
            </Button>
            <span class="recorder-clock small-clock">
              {playing ? `${formatDuration(playing.at)} / ` : ''}
              {formatDuration(phase.sec)}
            </span>
          </div>
          <div class="field">
            <label for="record-page-name">Wie soll der Titel heißen?</label>
            <input id="record-page-name" class="input big" placeholder="Zum Beispiel: Oma liest Frau Holle" value={r.name} onInput={(e) => r.setName(e.currentTarget.value)} />
          </div>
          {blocked ? <Callout tone="warning">{blocked}</Callout> : null}
          {cardReady ? (
            <p class="small muted">Danach wählst du unter „Hinzufügen“ den Ordner. Ich wandle die Aufnahme in MP3 um und gleiche die Lautstärke an.</p>
          ) : (
            <p class="small soft">Stecke die SD-Karte der Box {cardIntoDevice()}, dann kommt die Aufnahme in einen Ordner. Bis dahin wartet sie hier.</p>
          )}
          <div class="recorder-actions">
            <Button variant="primary" size="lg" icon={Check} loading={saving} disabled={!cardReady || !!blocked} onClick={() => void r.save(() => undefined)}>
              Auf die SD-Karte …
            </Button>
            {cardReady ? null : <Button onClick={() => void saveFile()}>Als Datei speichern</Button>}
            <Button variant="ghost" icon={RotateCcw} onClick={() => void r.start()}>
              Noch einmal
            </Button>
            <Button variant="ghost" onClick={r.discard}>
              Verwerfen
            </Button>
          </div>
        </section>
      ) : (
        <section class="card pad recorder" aria-label="Aufnahme">
          <div class="recorder-clock" aria-live="off">
            {formatDuration(recording ? phase.sec : 0)}
          </div>
          <div class="record-meter-row">
            <span class={`record-dot ${recording ? 'on' : ''}`} aria-hidden="true" />
            <div class="record-meter" role="meter" aria-label="Lautstärke am Mikrofon" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
              <div class={`record-meter-fill ${recording && phase.advice === 'loud' ? 'loud' : ''}`} style={{ width: `${level}%` }} />
            </div>
          </div>
          {recording && phase.advice ? (
            <p class="small record-advice">{phase.advice === 'loud' ? 'Zu laut: Geh etwas weiter weg vom Mikrofon.' : 'Sehr leise: Geh näher ans Mikrofon oder sprich lauter.'}</p>
          ) : null}
          {/* The one big button, low on the screen where the thumb is: a microphone to start, a stop square while it records. */}
          <button
            type="button"
            class={`record-button ${recording ? 'on' : ''}`}
            disabled={phase.kind === 'asking'}
            onClick={() => (recording ? r.finish() : void r.start())}
          >
            <span class="record-face" aria-hidden="true">
              {recording ? <Square size={34} fill="currentColor" /> : <Mic size={40} strokeWidth={2.2} />}
            </span>
            <span>{recording ? 'Aufnahme beenden' : phase.kind === 'asking' ? 'Mikrofon wird geöffnet …' : 'Aufnahme starten'}</span>
          </button>
          <p class="small muted recorder-hint">
            {recording
              ? 'Sprich ruhig und deutlich, etwa eine Handbreit vom Mikrofon.'
              : `Suche dir einen ruhigen Platz. Beim ersten Mal fragt ${theDevice()}, ob ich das Mikrofon benutzen darf.`}
          </p>
        </section>
      )}

      {problem ? (
        <Callout tone="danger">
          <div class="stack tight">
            <span>{problem}</span>
            {r.askSettings ? (
              <div>
                <Button size="sm" onClick={() => r.p?.openAppSettings?.()}>
                  Berechtigungen öffnen
                </Button>
              </div>
            ) : null}
          </div>
        </Callout>
      ) : null}

      <p class="small muted">Eine Aufnahme dauert höchstens {MAX_RECORDING_SEC / 60} Minuten. Eine längere Geschichte nimmst du in mehreren Teilen auf, dann merkt sich die Box auch, wo ihr wart.</p>
    </div>
  );
}
