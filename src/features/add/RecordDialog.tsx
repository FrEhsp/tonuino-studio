/**
 * "Aufnehmen", an extra of the settings page: records from the microphone
 * with a level meter, then listen, record again, give it a name and hand it
 * to the import (recordingImport.ts), which converts it like a picked file.
 *
 * The PCM comes from an AudioWorklet (a ScriptProcessor where a browser has
 * none), not from MediaRecorder: its WebM/Opus would need a decoder the
 * desktop app does not have. Works in the desktop app and in Chrome, Edge
 * and Firefox; a browser without a microphone API says so.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Mic, Pause, Play, RotateCcw, Square } from 'lucide-preact';
import { levelAdvice, MAX_RECORDING_SEC, meterFraction, PcmRecording, peakDb, recordingFileName } from '../../core/audio/recording';
import { formatDuration } from '../../app/format';
import { platform } from '../../app/state';
import { Button, Callout, Field } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { openPlayer, type MediaLike } from '../../ui/nativeAudio';
import { messageOf } from '../box/trackEdit';
import { recordingBlocked, takeRecording } from './recordingImport';
import { session } from './session';

/** The worklet: hands blocks of about 40 ms to the page. */
const TAP_WORKLET = `
class TonuinoTap extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0].length) {
      this.parts.push(input.map((c) => c.slice()));
      this.n += input[0].length;
      if (this.n >= 2048) {
        const k = this.parts[0].length;
        const out = [];
        for (let c = 0; c < k; c++) {
          const ch = new Float32Array(this.n);
          let o = 0;
          for (const p of this.parts) { ch.set(p[c] || p[0], o); o += p[0].length; }
          out.push(ch);
        }
        this.port.postMessage(out, out.map((c) => c.buffer));
        this.parts = [];
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('tonuino-tap', TonuinoTap);
`;

/** Seconds of peaks the advice under the meter looks at. */
const ADVICE_SEC = 3;

type Phase = { kind: 'ready' } | { kind: 'asking' } | { kind: 'recording'; sec: number; level: number; advice: 'loud' | 'quiet' | null } | { kind: 'recorded'; wav: Blob; sec: number };

/** Whether this browser or WebView can record at all. */
export function canRecord(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined';
}

/** Why the microphone could not be opened, in words. */
/** Where the app runs, for the way to the microphone permission. */
export type MicPlace = 'desktop' | 'phone' | 'browser';

/** Whether the microphone was refused (the phone then offers its app settings). */
export function micDenied(e: unknown): boolean {
  const name = e instanceof DOMException ? e.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError';
}

export function micProblem(e: unknown, place: MicPlace): string {
  const name = e instanceof DOMException ? e.name : '';
  if (micDenied(e)) {
    if (place === 'phone') return 'TonUINO Studio darf das Mikrofon nicht benutzen. Erlaube es in den Berechtigungen der App und versuche es noch einmal.';
    return place === 'desktop'
      ? 'TonUINO Studio darf das Mikrofon nicht benutzen. Erlaube es in den Einstellungen deines Computers unter Datenschutz › Mikrofon und versuche es noch einmal.'
      : 'Der Browser darf das Mikrofon nicht benutzen. Erlaube es über das Symbol links neben der Adresse und versuche es noch einmal.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return place === 'phone' ? 'Dieses Gerät hat kein Mikrofon gefunden. Stecke ein Headset an und versuche es noch einmal.' : 'Kein Mikrofon gefunden. Stecke eines an und versuche es noch einmal.';
  }
  if (name === 'NotReadableError') {
    return place === 'phone'
      ? 'Das Mikrofon wird gerade von einer anderen App benutzt, vielleicht von einem Anruf. Beende das und versuche es noch einmal.'
      : 'Das Mikrofon wird gerade von einem anderen Programm benutzt. Schließe es und versuche es noch einmal.';
  }
  return `Das Mikrofon ließ sich nicht öffnen. ${messageOf(e)}`;
}

interface Capture {
  stop(): void;
}

/** Opens the microphone and calls `onBlock` with its PCM until stop(). */
async function startCapture(onBlock: (channels: Float32Array[], sampleRate: number) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } });
  const ctx = new AudioContext();
  const stopAll = () => {
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
  };
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    // Pulled by the output, silent: the recording is never heard while it runs.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'tonuino-tap', { numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<Float32Array[]>) => onBlock(e.data, ctx.sampleRate);
      source.connect(node);
      node.connect(mute);
    } else {
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onBlock([new Float32Array(e.inputBuffer.getChannelData(0))], ctx.sampleRate);
      source.connect(node);
      node.connect(mute);
    }
  } catch (e) {
    stopAll();
    throw e;
  }
  return { stop: stopAll };
}

/**
 * The recorder itself: microphone, meter, listening and handing the take to
 * the import. Shared by the dialog (a folder's page, "Hinzufügen" on a
 * computer) and the page "Aufnehmen" of the Android app (RecordPage.tsx).
 */
export function useRecorder(folder: number | undefined) {
  const p = platform.value;
  // The Android app counts as 'desktop' for its kind, but its permissions live in the phone's settings.
  const place: MicPlace = p?.mobile ? 'phone' : p?.kind === 'desktop' ? 'desktop' : 'browser';
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [problem, setProblem] = useState<string | null>(null);
  /** The phone refused the microphone: a button leads to the app's permissions. */
  const [askSettings, setAskSettings] = useState(false);
  const [name, setName] = useState('');
  const [playing, setPlaying] = useState<{ at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const capture = useRef<Capture | null>(null);
  const recording = useRef<PcmRecording | null>(null);
  const peaks = useRef<{ db: number; at: number }[]>([]);
  const player = useRef<{ el: MediaLike; free: () => void } | null>(null);
  const frame = useRef(0);

  const stopPlayer = () => {
    const p = player.current;
    player.current = null;
    setPlaying(null);
    p?.free();
  };

  const finish = () => {
    capture.current?.stop();
    capture.current = null;
    cancelAnimationFrame(frame.current);
    const rec = recording.current;
    if (!rec || rec.durationSec < 0.5) {
      setPhase({ kind: 'ready' });
      if (rec) setProblem('Die Aufnahme war zu kurz. Nimm noch einmal auf.');
      return;
    }
    setPhase({ kind: 'recorded', wav: rec.toWav(), sec: rec.durationSec });
  };

  useEffect(
    () => () => {
      capture.current?.stop();
      cancelAnimationFrame(frame.current);
      stopPlayer();
    },
    [],
  );

  const start = async () => {
    stopPlayer();
    setProblem(null);
    setAskSettings(false);
    setPhase({ kind: 'asking' });
    peaks.current = [];
    recording.current = null;
    try {
      capture.current = await startCapture((channels, rate) => {
        recording.current ??= new PcmRecording(rate);
        const db = peakDb(channels);
        peaks.current.push({ db, at: recording.current.durationSec });
        if (!recording.current.push(channels)) queueMicrotask(finish);
      });
    } catch (e) {
      setPhase({ kind: 'ready' });
      setProblem(micProblem(e, place));
      setAskSettings(place === 'phone' && micDenied(e) && !!p?.openAppSettings);
      return;
    }
    // The meter follows the screen, not every block.
    const draw = () => {
      const rec = recording.current;
      const sec = rec?.durationSec ?? 0;
      const recent = peaks.current.filter((p) => p.at >= sec - ADVICE_SEC);
      peaks.current = recent;
      const last = recent.slice(-3).map((p) => p.db);
      setPhase({ kind: 'recording', sec, level: meterFraction(last.length ? Math.max(...last) : Number.NEGATIVE_INFINITY), advice: sec > ADVICE_SEC ? levelAdvice(recent.map((p) => p.db)) : null });
      frame.current = requestAnimationFrame(draw);
    };
    frame.current = requestAnimationFrame(draw);
  };

  const listen = async () => {
    if (phase.kind !== 'recorded') return;
    if (playing) return stopPlayer();
    setPlaying({ at: 0 });
    try {
      const p = await openPlayer(phase.wav, 'aufnahme.wav', 'audio/wav');
      const el = p.el;
      player.current = p;
      el.addEventListener('timeupdate', () => player.current?.el === el && setPlaying({ at: el.currentTime }));
      el.addEventListener('ended', stopPlayer);
      await el.play();
    } catch (e) {
      stopPlayer();
      setProblem(`Anhören geht gerade nicht. ${messageOf(e)}`);
    }
  };

  const save = async (onDone: () => void) => {
    if (phase.kind !== 'recorded') return;
    stopPlayer();
    setProblem(null);
    setSaving(true);
    try {
      await takeRecording(phase.wav, recordingFileName(name), folder);
      onDone();
    } catch (e) {
      setProblem(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  /** Throws the take away; the next one starts afresh. */
  const discard = () => {
    stopPlayer();
    setProblem(null);
    setName('');
    setPhase({ kind: 'ready' });
  };

  const supported = canRecord();
  const recordingNow = phase.kind === 'recording' || phase.kind === 'asking';
  const blocked = phase.kind === 'recorded' ? recordingBlocked(session.value, folder) : null;
  return { p, place, phase, problem, askSettings, name, setName, playing, saving, supported, recordingNow, blocked, start, finish, listen, save, discard };
}

export function RecordDialog({ folder, onClose }: { folder?: number; onClose: () => void }) {
  const { p, place, phase, problem, askSettings, name, setName, playing, saving, supported, recordingNow, blocked, start, finish, listen, save } = useRecorder(folder);
  return (
    <Dialog
      title="Selbst aufnehmen"
      onClose={recordingNow ? finish : onClose}
      dismissable={!recordingNow && !saving}
      footer={
        phase.kind === 'recorded' ? (
          <>
            <Button onClick={onClose}>Verwerfen</Button>
            <Button variant="primary" icon={Check} loading={saving} disabled={!!blocked} onClick={() => void save(onClose)}>
              {folder ? 'In den Ordner übernehmen …' : 'Übernehmen …'}
            </Button>
          </>
        ) : recordingNow ? null : (
          // While it records, "Aufnahme beenden" in the dialog is the one way on.
          <Button onClick={onClose}>Schließen</Button>
        )
      }
    >
      <div class="stack record-dialog">
        {!supported ? (
          <Callout tone="warning">
            {place === 'phone' ? 'Auf diesem Gerät kann TonUINO Studio nicht aufnehmen.' : 'Dieser Browser kann nicht aufnehmen. Nimm Chrome, Edge oder die Desktop-App.'}
          </Callout>
        ) : phase.kind === 'recorded' ? (
          <>
            <div class="row wrap" style={{ gap: 12 }}>
              <Button icon={playing ? Pause : Play} onClick={() => void listen()}>
                {playing ? 'Anhalten' : 'Anhören'}
              </Button>
              <span class="mono small">
                {playing ? `${formatDuration(playing.at)} / ` : ''}
                {formatDuration(phase.sec)}
              </span>
              <Button variant="ghost" icon={RotateCcw} onClick={() => void start()}>
                Noch einmal aufnehmen
              </Button>
            </div>
            <Field label="Name des Titels" id="record-name" hint="So heißt der Titel in der App, zum Beispiel in der Titelliste des Ordners.">
              <input id="record-name" class="input" placeholder="Zum Beispiel: Oma liest Frau Holle" value={name} onInput={(e) => setName(e.currentTarget.value)} />
            </Field>
            <p class="small muted">
              {folder
                ? 'Danach siehst du unter „Hinzufügen“, wie der Titel hinten an den Ordner kommt. Ich wandle ihn in MP3 um und gleiche die Lautstärke an.'
                : 'Danach wählst du unter „Hinzufügen“ den Ordner. Ich wandle die Aufnahme in MP3 um und gleiche die Lautstärke an.'}
            </p>
            {blocked ? <Callout tone="warning">{blocked}</Callout> : null}
          </>
        ) : (
          <>
            <p>
              {phase.kind === 'recording'
                ? 'Die Aufnahme läuft. Sprich ruhig und deutlich, etwa eine Handbreit vom Mikrofon entfernt.'
                : 'Suche dir einen ruhigen Platz. Wenn du auf „Aufnahme starten“ tippst, fragt der Computer vielleicht, ob ich das Mikrofon benutzen darf.'}
            </p>
            <div class="record-meter-row">
              <span class={`record-dot ${phase.kind === 'recording' ? 'on' : ''}`} aria-hidden="true" />
              <div class="record-meter" role="meter" aria-label="Lautstärke am Mikrofon" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.kind === 'recording' ? Math.round(phase.level * 100) : 0}>
                <div class={`record-meter-fill ${phase.kind === 'recording' && phase.advice === 'loud' ? 'loud' : ''}`} style={{ width: `${phase.kind === 'recording' ? Math.round(phase.level * 100) : 0}%` }} />
              </div>
              <span class="mono record-time">{formatDuration(phase.kind === 'recording' ? phase.sec : 0)}</span>
            </div>
            {phase.kind === 'recording' && phase.advice ? (
              <p class="small record-advice">{phase.advice === 'loud' ? 'Zu laut: Geh etwas weiter weg vom Mikrofon.' : 'Sehr leise: Geh näher ans Mikrofon oder sprich lauter.'}</p>
            ) : null}
            {phase.kind === 'recording' ? (
              <Button variant="primary" icon={Square} onClick={finish}>
                Aufnahme beenden
              </Button>
            ) : (
              <Button variant="primary" icon={Mic} loading={phase.kind === 'asking'} onClick={() => void start()}>
                Aufnahme starten
              </Button>
            )}
            <p class="small muted">Eine Aufnahme dauert höchstens {MAX_RECORDING_SEC / 60} Minuten. Eine längere Geschichte nimmst du in mehreren Teilen auf, dann merkt sich die Box auch, wo ihr wart.</p>
          </>
        )}
        {problem ? (
          <Callout tone="danger">
            <div class="stack tight">
              <span>{problem}</span>
              {askSettings ? (
                <div>
                  <Button size="sm" onClick={() => p?.openAppSettings?.()}>
                    Berechtigungen öffnen
                  </Button>
                </div>
              ) : null}
            </div>
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
