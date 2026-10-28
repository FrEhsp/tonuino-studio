/**
 * Zuschneiden (TODO 0.3 #131): the track as a wave picture across the
 * width, the new start and end as grips to drag, pieces cut out of the
 * middle, zoom with the wheel or two fingers, listening from each grip,
 * undo and redo. Grips jump into pauses nearby. Works with a finger: the
 * grips' knobs sit in a lane of their own under the wave, 44 px tall, and
 * nothing needs hovering.
 *
 * The picture comes in steps, so a three-hour book is there at once: the
 * frame scan, which saving needs anyway, reads a rough level of every frame
 * on the way (core/audio/mp3levels.ts) and draws while it reads; then the
 * real measurement (AudioBackend.analyze, in a worker or the desktop app's
 * own decoder) replaces it, with exact pauses. Nothing is decoded on the
 * page.
 *
 * The component only edits: it reports the edit (onChange) and its owner
 * saves it (TrimDialog for a track on the card, writeTrimEdit for the file).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Maximize2, Pause, Play, Redo2, Scissors, Undo2, X, ZoomIn, ZoomOut } from 'lucide-preact';
import type { Mp3Index } from '../../core/audio/mp3frames';
import type { Pause as SoundPause } from '../../core/audio/silence';
import { isUntouched, planTrimEdit, wholeTrack, type TrimEdit, type TrimEditPlan } from '../../core/audio/trimedit';
import type { ByteSource } from '../../platform/types';
import { platform } from '../../app/state';
import { Button, IconButton, Progress } from '../../ui/components/controls';
import { toast } from '../../ui/components/Toast';
import { openPlayer, type MediaLike } from '../../ui/nativeAudio';
import { messageOf, parseSeconds } from '../box/trackEdit';
import {
  addCut,
  clockTime,
  commit,
  gripTime,
  moveGrip,
  panView,
  playableFrom,
  redo,
  removeCut,
  sameGrip,
  showTime,
  SNAP_PX,
  snapToPause,
  startHistory,
  undo,
  viewAround,
  wholeView,
  zoomView,
  type Grip,
  type History,
  type View,
} from './model';
import { PeakPyramid } from './peaks';
import '../../ui/styles/trim.css';

/** What the editor knows besides the edit. */
export interface TrimInfo {
  /** The frame index of the track, once scanned (saving needs it); null before. */
  index: Mp3Index | null;
  /** Where the cuts land and how long the track gets; null while scanning or when too little is left. */
  plan: TrimEditPlan | null;
  /** True when the edit changes nothing. */
  untouched: boolean;
}

export interface TrimEditorProps {
  /** The track. An MP3 (the tracks on the card are). */
  source: ByteSource;
  /** Its name, for the players and screen readers. */
  title: string;
  /** Start from this edit instead of the whole track. */
  initial?: TrimEdit;
  /**
   * „Ab hier abschneiden“ while the track played: the end grip starts here
   * (seconds), zoomed in around it. One step, so „Rückgängig“ brings the
   * whole track back.
   */
  cutFrom?: number;
  /** Every change, undo and redo included, and once the track is scanned. */
  onChange?: (edit: TrimEdit, info: TrimInfo) => void;
  /** Called before the editor plays something (other players stop). */
  beforePlay?: () => void;
  /** While the owner saves: nothing can be changed or played. */
  disabled?: boolean;
  /** Below the seconds fields, for the owner's own options. */
  children?: ComponentChildren;
}

/** A piece cut out with the scissors button: this wide on the screen, at most 20 s. */
const NEW_CUT_SCREEN = 0.12;
const NEW_CUT_MAX_SEC = 20;
/** Listening at the end plays up to it from this far before; at a piece cut out, around it. */
const END_PREVIEW_SEC = 5;
const AROUND_SEC = 3;
/** „Ab hier abschneiden“: this much of the track around the grip shows at first. */
const CUT_FROM_SPAN_SEC = 40;
/** Pauses for the grips: shorter than for splitting audiobooks, a breath between sentences counts. */
const SNAP_MIN_PAUSE_SEC = 0.3;

type Envelope = { pyramid: PeakPyramid; exact: boolean };
type Load = { state: 'scanning'; fraction: number } | { state: 'ready'; index: Mp3Index } | { state: 'error'; text: string };

const audioHelpers = () => Promise.all([import('../../core/audio/mp3frames'), import('../../core/audio/mp3levels'), import('../../core/audio/silence')]);

/** The editor (see the top of this file). */
export function TrimEditor({ source, title, initial, cutFrom, onChange, beforePlay, disabled, children }: TrimEditorProps) {
  const [load, setLoad] = useState<Load>({ state: 'scanning', fraction: 0 });
  const [env, setEnv] = useState<Envelope | null>(null);
  const [exactProgress, setExactProgress] = useState<number | null>(null);
  const [places, setPlaces] = useState<number[]>([]);
  const [hist, setHist] = useState<History>(() => startHistory(initial ?? wholeTrack(0)));
  /** While a grip is dragged: the edit as it would be. */
  const [dragEdit, setDragEdit] = useState<{ grip: Grip; edit: TrimEdit; snapped: boolean } | null>(null);
  const [duration, setDuration] = useState(0);
  const [view, setView] = useState<View>(wholeView(0));
  const [playing, setPlaying] = useState(false);
  const [focusGrip, setFocusGrip] = useState<Grip | null>(null);
  const playhead = useRef(0);
  const edit = dragEdit?.edit ?? hist.edit;
  const index = load.state === 'ready' ? load.index : null;
  const plan = useMemo(() => (index ? planTrimEdit(index, hist.edit) : null), [index, hist.edit]);
  const ready = load.state === 'ready';
  // Before the scan ends there is nothing to cut yet: the picture shows the whole track.
  const live = { edit: ready ? edit : wholeTrack(duration), view, duration, env, places, playing, focusGrip, dragEdit };
  const latest = useRef(live);
  latest.current = live;

  /* -------------------------------------------------------- the track, in steps */
  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        if (!/\.mp3$/i.test(source.name)) throw new Error('Zuschneiden geht nur bei MP3-Dateien.');
        const [{ scanMp3 }, { FrameLevels }, { findPauses }] = await audioHelpers();
        const levels = new FrameLevels();
        let fraction = 0;
        // Draws what the scan has read so far, a few times a second.
        const drawSoFar = () => {
          if (!alive || !levels.frameSec || !levels.length) return;
          const sec = levels.length * levels.frameSec;
          const total = fraction > 0.02 ? sec / fraction : sec;
          setDuration((d) => (d ? d : total));
          setEnv({ pyramid: new PeakPyramid(levels.power(), levels.frameSec), exact: false });
          setView((v) => (v.toSec > 0 ? v : wholeView(total)));
        };
        timer = setInterval(drawSoFar, 400);
        const idx = await scanMp3(source, {
          signal: ctrl.signal,
          onFrame: levels.onFrame,
          onProgress: (f) => {
            fraction = f;
            if (alive) setLoad({ state: 'scanning', fraction: f });
          },
        });
        clearInterval(timer);
        if (!alive) return;
        if (idx.layer !== 3) throw new Error('Diese Datei ist eine ältere Variante (MP1 oder MP2). Zuschneiden geht nur bei MP3-Dateien.');
        const rough = levels.power();
        setDuration(idx.durationSec);
        const from = !initial && cutFrom !== undefined ? Math.min(Math.max(0, cutFrom), idx.durationSec) : undefined;
        if (from !== undefined && from < idx.durationSec) {
          // The end grip where the track was playing, close up; the whole track is one „Rückgängig“ away.
          setView(viewAround(from, Math.min(idx.durationSec, CUT_FROM_SPAN_SEC), idx.durationSec));
          setHist((h) => (h.past.length ? h : commit(startHistory(wholeTrack(idx.durationSec)), { startSec: 0, endSec: from, cuts: [] })));
          setFocusGrip({ kind: 'end' });
          playhead.current = Math.max(0, from - END_PREVIEW_SEC);
        } else {
          setView(wholeView(idx.durationSec));
          setHist((h) => (h.past.length || initial ? h : startHistory(wholeTrack(idx.durationSec))));
        }
        setEnv({ pyramid: new PeakPyramid(rough, levels.frameSec), exact: false });
        setPlaces(findPauses(rough, levels.frameSec, { minPauseSec: SNAP_MIN_PAUSE_SEC }).map((p: SoundPause) => p.cutSec));
        setLoad({ state: 'ready', index: idx });
        // The real measurement, in the background: exact picture and pauses.
        const audio = platform.peek()?.audio;
        if (!audio) return;
        setExactProgress(0);
        const analysis = await audio.analyze(source, (f) => alive && setExactProgress(f), ctrl.signal);
        if (!alive) return;
        setEnv({ pyramid: new PeakPyramid(analysis.power, analysis.windowSec), exact: true });
        setPlaces(findPauses(analysis.power, analysis.windowSec, { minPauseSec: SNAP_MIN_PAUSE_SEC }).map((p) => p.cutSec));
        setExactProgress(null);
      } catch (e) {
        clearInterval(timer);
        if (!alive || ctrl.signal.aborted) return;
        setExactProgress(null);
        // Without the measurement the rough picture stays; only a failed scan stops the editor.
        setLoad((l) => (l.state === 'ready' ? l : { state: 'error', text: messageOf(e) }));
      }
    })();
    return () => {
      alive = false;
      clearInterval(timer);
      ctrl.abort();
    };
  }, [source]);

  useEffect(() => {
    onChange?.(hist.edit, { index, plan, untouched: !plan || isUntouched(hist.edit, duration) });
  }, [hist.edit, index, plan]);

  /* -------------------------------------------------------- playing */
  const player = useRef<{ el: MediaLike; free: () => void } | null>(null);
  const stopAt = useRef<number | null>(null);
  const loop = useRef<number | null>(null);
  const stop = () => {
    if (loop.current !== null) cancelAnimationFrame(loop.current);
    loop.current = null;
    player.current?.el.pause();
    setPlaying(false);
  };
  useEffect(
    () => () => {
      stop();
      player.current?.free();
      player.current = null;
    },
    [],
  );
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);

  /** Plays the track as it will be from `from`, up to `until` (or the new end). */
  const play = async (from: number, until: number | null = null) => {
    const start = playableFrom(latest.current.edit, from);
    if (start === null) return stop();
    beforePlay?.();
    try {
      if (!player.current) player.current = await openPlayer(source, source.name);
      const el = player.current.el;
      el.currentTime = start;
      playhead.current = start;
      stopAt.current = until;
      setPlaying(true);
      await el.play();
      const tick = () => {
        const { edit: e } = latest.current;
        const t = el.currentTime;
        const next = playableFrom(e, t);
        if (el.paused || el.ended || next === null || (stopAt.current !== null && t >= stopAt.current)) {
          playhead.current = Math.min(t, e.endSec);
          stop();
          redraw();
          return;
        }
        // Over a piece cut out: on behind it.
        if (next - t > 0.05) el.currentTime = next;
        playhead.current = next;
        const v = latest.current.view;
        if (next > v.toSec || next < v.fromSec) setView(showTime(v, next, latest.current.duration));
        redraw();
        loop.current = requestAnimationFrame(tick);
      };
      if (loop.current !== null) cancelAnimationFrame(loop.current);
      loop.current = requestAnimationFrame(tick);
    } catch (e) {
      stop();
      toast.error('Anhören geht gerade nicht', messageOf(e));
    }
  };

  /** Listening at a grip: from the start on, the last seconds up to the end, or around a piece cut out. */
  const listenAt = (g: Grip) => {
    const e = latest.current.edit;
    if (g.kind === 'start') return play(e.startSec);
    if (g.kind === 'end') return play(Math.max(e.startSec, e.endSec - END_PREVIEW_SEC), e.endSec);
    const c = e.cuts[g.cut];
    return play(Math.max(e.startSec, c.fromSec - AROUND_SEC), c.toSec + AROUND_SEC);
  };

  /* -------------------------------------------------------- drawing */
  const wave = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const frame = useRef<number | null>(null);
  const redraw = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const s = latest.current;
      if (wave.current) drawWave(wave.current, s.env, s.view, s.edit, s.places, playhead.current, s.duration);
      if (overview.current) drawOverview(overview.current, s.env, s.view, s.edit, s.duration);
    });
  };
  useEffect(redraw, [env, view, edit, places, width, duration, ready]);
  useEffect(() => () => void (frame.current !== null && cancelAnimationFrame(frame.current)), []);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const secPerPx = width > 0 ? (view.toSec - view.fromSec) / width : 0;
  const xOf = (t: number) => (secPerPx > 0 ? (t - view.fromSec) / secPerPx : 0);
  const timeAtClientX = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    const s = latest.current;
    if (!r || !r.width) return s.view.fromSec;
    return s.view.fromSec + ((clientX - r.left) / r.width) * (s.view.toSec - s.view.fromSec);
  };

  /* -------------------------------------------------------- the grips */
  const changeTo = (next: TrimEdit) => setHist((h) => commit(h, next));
  const grabbed = useRef<{ grip: Grip; offset: number; x0: number; moved: boolean; id: number } | null>(null);
  const onGripDown = (g: Grip, e: PointerEvent) => {
    if (disabled || !index) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const at = timeAtClientX(e.clientX);
    grabbed.current = { grip: g, offset: gripTime(latest.current.edit, g) - at, x0: e.clientX, moved: false, id: e.pointerId };
    setFocusGrip(g);
  };
  const onGripMove = (e: PointerEvent) => {
    const gr = grabbed.current;
    if (!gr || gr.id !== e.pointerId) return;
    if (!gr.moved && Math.abs(e.clientX - gr.x0) < 4) return;
    gr.moved = true;
    const s = latest.current;
    const want = timeAtClientX(e.clientX) + gr.offset;
    const tolerance = ((s.view.toSec - s.view.fromSec) / Math.max(1, width)) * SNAP_PX;
    const snap = snapToPause(want, s.places, tolerance);
    const next = moveGrip(hist.edit, gr.grip, snap.sec, s.duration);
    setDragEdit({ grip: gr.grip, edit: next, snapped: snap.snapped && Math.abs(gripTime(next, gr.grip) - snap.sec) < 1e-6 });
  };
  const onGripUp = (e: PointerEvent) => {
    const gr = grabbed.current;
    if (!gr || gr.id !== e.pointerId) return;
    grabbed.current = null;
    const drag = latest.current.dragEdit;
    setDragEdit(null);
    if (gr.moved && drag) changeTo(drag.edit);
    // A tap on a grip listens there.
    else if (!gr.moved) void listenAt(gr.grip);
  };
  const onGripKey = (g: Grip, e: KeyboardEvent) => {
    if (disabled || !index) return;
    const step = e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1;
    const t = gripTime(hist.edit, g);
    const to =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown'
        ? t - step
        : e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? t + step
          : e.key === 'PageDown'
            ? t - 10
            : e.key === 'PageUp'
              ? t + 10
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? duration
                  : null;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (playing) stop();
      else void listenAt(g);
      return;
    }
    if (to === null) return;
    e.preventDefault();
    const next = moveGrip(hist.edit, g, to, duration);
    changeTo(next);
    setView((v) => showTime(v, gripTime(next, g), duration));
  };

  /* -------------------------------------------------------- the wave: pan, tap, pinch, wheel */
  const touches = useRef(new Map<number, number>());
  const gesture = useRef<{ kind: 'pan'; x0: number; view0: View; moved: boolean } | { kind: 'pinch'; d0: number; view0: View; anchor: number } | null>(null);
  const onWaveDown = (e: PointerEvent) => {
    if (!index) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    touches.current.set(e.pointerId, e.clientX);
    const xs = [...touches.current.values()];
    if (xs.length >= 2) {
      const mid = (xs[0] + xs[1]) / 2;
      gesture.current = { kind: 'pinch', d0: Math.max(20, Math.abs(xs[0] - xs[1])), view0: latest.current.view, anchor: timeAtClientX(mid) };
    } else gesture.current = { kind: 'pan', x0: e.clientX, view0: latest.current.view, moved: false };
  };
  const onWaveMove = (e: PointerEvent) => {
    if (!touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, e.clientX);
    const g = gesture.current;
    const s = latest.current;
    if (!g || !width) return;
    if (g.kind === 'pan') {
      const dx = e.clientX - g.x0;
      if (!g.moved && Math.abs(dx) < 6) return;
      g.moved = true;
      setView(panView(g.view0, (-dx * (g.view0.toSec - g.view0.fromSec)) / width, s.duration));
    } else {
      const xs = [...touches.current.values()];
      if (xs.length < 2) return;
      const d = Math.max(20, Math.abs(xs[0] - xs[1]));
      const r = box.current!.getBoundingClientRect();
      const mid = ((xs[0] + xs[1]) / 2 - r.left) / r.width;
      const span = ((g.view0.toSec - g.view0.fromSec) * g.d0) / d;
      const z = zoomView(g.view0, span / (g.view0.toSec - g.view0.fromSec), g.anchor, s.duration);
      // The place between the fingers stays under them.
      setView(panView(z, g.anchor - mid * (z.toSec - z.fromSec) - z.fromSec, s.duration));
    }
  };
  const onWaveUp = (e: PointerEvent) => {
    if (!touches.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === 'pan' && !g.moved && touches.current.size === 0) {
      // A tap puts the playhead there.
      const t = Math.min(Math.max(0, timeAtClientX(e.clientX)), latest.current.duration);
      playhead.current = t;
      if (playing) void play(t);
      redraw();
    }
    gesture.current = touches.current.size ? { kind: 'pan', x0: [...touches.current.values()][0], view0: latest.current.view, moved: true } : null;
  };
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = latest.current;
      if (!s.duration) return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      const dx = e.deltaX * px;
      const dy = e.deltaY * px;
      if (!e.ctrlKey && (e.shiftKey || Math.abs(dx) > Math.abs(dy))) {
        const d = e.shiftKey && !dx ? dy : dx;
        setView(panView(s.view, (d * (s.view.toSec - s.view.fromSec)) / Math.max(1, el.clientWidth), s.duration));
        return;
      }
      // A pinch on a touchpad comes as a wheel with Ctrl and small steps.
      const factor = Math.exp(dy * (e.ctrlKey ? 0.01 : 0.002));
      setView(zoomView(s.view, factor, timeAtClientX(e.clientX), s.duration));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const s = latest.current;
    const anchor = s.focusGrip ? gripTime(s.edit, s.focusGrip) : playhead.current >= s.view.fromSec && playhead.current <= s.view.toSec ? playhead.current : (s.view.fromSec + s.view.toSec) / 2;
    setView(zoomView(s.view, factor, anchor, s.duration));
  };

  const onOverview = (e: PointerEvent) => {
    if (!duration || (e.type === 'pointermove' && !(e.buttons & 1))) return;
    if (e.type === 'pointerdown') (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const t = ((e.clientX - r.left) / Math.max(1, r.width)) * duration;
    setView(viewAround(t, view.toSec - view.fromSec, duration));
  };

  const cutHere = () => {
    const s = latest.current;
    const at = playhead.current > s.edit.startSec && playhead.current < s.edit.endSec ? playhead.current : (s.view.fromSec + s.view.toSec) / 2;
    const w = Math.min(NEW_CUT_MAX_SEC, (s.view.toSec - s.view.fromSec) * NEW_CUT_SCREEN);
    const next = addCut(s.edit, at, w);
    if (!next) {
      toast.info('Hier geht kein Stück mehr raus', 'Tippe in der Spur auf eine andere Stelle und versuche es dort.');
      return;
    }
    changeTo(next);
    const i = Math.max(0, next.cuts.findIndex((c) => !s.edit.cuts.some((o) => o.fromSec === c.fromSec)));
    setFocusGrip({ kind: 'from', cut: i });
    // Too thin to grab in a long track: closer, so the piece is a third of the view.
    const c = next.cuts[i];
    if (c && ((c.toSec - c.fromSec) / (s.view.toSec - s.view.fromSec)) * width < 60) setView(viewAround((c.fromSec + c.toSec) / 2, 3 * (c.toSec - c.fromSec), s.duration));
  };

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      setHist((h) => (e.shiftKey ? redo(h) : undo(h)));
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      setHist(redo);
    } else if (e.key === ' ' && !target.closest('button, [role="slider"]')) {
      e.preventDefault();
      if (playing) stop();
      else void play(playhead.current);
    } else if ((e.key === '+' || e.key === '=') && !mod) zoomBy(0.5);
    else if (e.key === '-' && !mod) zoomBy(2);
  };

  /* -------------------------------------------------------- the screen */
  const grips: { grip: Grip; label: string; side: 'left' | 'right' }[] = [
    { grip: { kind: 'start' }, label: 'Neuer Anfang', side: 'right' },
    { grip: { kind: 'end' }, label: 'Neues Ende', side: 'left' },
  ];
  edit.cuts.forEach((c, i) => {
    const narrow = (c.toSec - c.fromSec) / Math.max(1e-9, secPerPx) < 96;
    grips.push({ grip: { kind: 'from', cut: i }, label: `Stück ${i + 1}: Anfang`, side: narrow ? 'left' : 'right' });
    grips.push({ grip: { kind: 'to', cut: i }, label: `Stück ${i + 1}: Ende`, side: narrow ? 'right' : 'left' });
  });
  const kept = plan?.durationSec ?? Math.max(0, edit.endSec - edit.startSec - edit.cuts.reduce((n, c) => n + c.toSec - c.fromSec, 0));

  return (
    <div class="trim-editor" onKeyDown={onKey} data-disabled={disabled || undefined}>
      <div class="trim-overview" aria-hidden="true" onPointerDown={onOverview} onPointerMove={onOverview}>
        <canvas ref={overview} />
      </div>
      <div class="trim-stage" ref={stage}>
        <div
          class="trim-wave"
          ref={box}
          role="img"
          aria-label={`Wellenbild von „${title}“`}
          onPointerDown={onWaveDown}
          onPointerMove={onWaveMove}
          onPointerUp={onWaveUp}
          onPointerCancel={onWaveUp}
        >
          <canvas ref={wave} />
          {load.state === 'scanning' && !env ? <div class="trim-wave-note">Ich lese den Titel …</div> : null}
          {load.state === 'error' ? <div class="trim-wave-note trim-error">{load.text}</div> : null}
          {ready
            ? edit.cuts.map((c, i) => {
                const mid = xOf((c.fromSec + c.toSec) / 2);
                if (mid < -20 || mid > width + 20) return null;
                return (
                  <button
                    key={`keep-${i}`}
                    type="button"
                    class="trim-keep"
                    style={{ left: `${Math.min(Math.max(mid, 18), width - 18)}px` }}
                    title="Dieses Stück doch behalten"
                    aria-label={`Stück ${i + 1} doch behalten`}
                    disabled={disabled}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => changeTo(removeCut(hist.edit, i))}
                  >
                    <X size={16} strokeWidth={2.6} />
                  </button>
                );
              })
            : null}
        </div>
        <div class="trim-lane">
          {ready
            ? grips.map(({ grip, label, side }) => {
                const t = gripTime(edit, grip);
                const x = xOf(t);
                if (x < -60 || x > width + 60) return null;
                const cut = grip.kind === 'from' || grip.kind === 'to';
                const active = sameGrip(dragEdit?.grip ?? null, grip);
                return (
                  <div
                    key={`${grip.kind}-${'cut' in grip ? grip.cut : ''}`}
                    class={`trim-grip ${side} ${cut ? 'cut' : 'end'}${active ? ' active' : ''}${active && dragEdit?.snapped ? ' snapped' : ''}`}
                    style={{ left: `${x}px` }}
                  >
                    <span class="trim-grip-line" aria-hidden="true" onPointerDown={(e) => onGripDown(grip, e as PointerEvent)} onPointerMove={(e) => onGripMove(e as PointerEvent)} onPointerUp={(e) => onGripUp(e as PointerEvent)} onPointerCancel={(e) => onGripUp(e as PointerEvent)} />
                    <span
                      class="trim-knob"
                      role="slider"
                      tabIndex={disabled ? -1 : 0}
                      aria-label={label}
                      aria-valuemin={0}
                      aria-valuemax={Math.round(duration * 10) / 10}
                      aria-valuenow={Math.round(t * 10) / 10}
                      aria-valuetext={clockTime(t)}
                      aria-disabled={disabled || undefined}
                      title={`${label} · ziehen zum Schneiden, tippen zum Anhören`}
                      onPointerDown={(e) => onGripDown(grip, e as PointerEvent)}
                      onPointerMove={(e) => onGripMove(e as PointerEvent)}
                      onPointerUp={(e) => onGripUp(e as PointerEvent)}
                      onPointerCancel={(e) => onGripUp(e as PointerEvent)}
                      onKeyDown={(e) => onGripKey(grip, e as KeyboardEvent)}
                      onFocus={() => setFocusGrip(grip)}
                    >
                      {cut ? <Scissors size={16} strokeWidth={2.4} /> : <span class="trim-knob-ridges" />}
                    </span>
                  </div>
                );
              })
            : null}
        </div>
      </div>
      <div class="trim-tools row wrap">
        <Button icon={playing ? Pause : Play} disabled={!ready || disabled} onClick={() => (playing ? stop() : void play(playhead.current))}>
          {playing ? 'Anhalten' : 'Anhören'}
        </Button>
        <Button icon={Scissors} disabled={!ready || disabled} onClick={cutHere}>
          Stück herausschneiden
        </Button>
        <span class="trim-tool-group row">
          <IconButton label="Rückgängig" icon={Undo2} disabled={!hist.past.length || disabled} onClick={() => setHist(undo)} />
          <IconButton label="Wiederherstellen" icon={Redo2} disabled={!hist.future.length || disabled} onClick={() => setHist(redo)} />
        </span>
        <span class="trim-tool-group row">
          <IconButton label="Näher heran" icon={ZoomIn} disabled={!ready} onClick={() => zoomBy(0.4)} />
          <IconButton label="Weiter weg" icon={ZoomOut} disabled={!ready} onClick={() => zoomBy(2.5)} />
          <IconButton label="Ganzen Titel zeigen" icon={Maximize2} disabled={!ready} onClick={() => setView(wholeView(duration))} />
        </span>
      </div>
      <p class="trim-summary small" aria-live="polite">
        {load.state === 'scanning' ? (
          <span class="trim-scan">
            <Progress value={load.fraction} label="Liest den Titel" />
          </span>
        ) : ready ? (
          <>
            {dragEdit ? (
              <>
                <b>{clockTime(gripTime(dragEdit.edit, dragEdit.grip))}</b>
                {dragEdit.snapped ? ' · in einer Pause' : ''}
              </>
            ) : (
              <>
                Bleibt: <b>{clockTime(kept)}</b> von {clockTime(duration)}
              </>
            )}
            {exactProgress !== null ? <span class="muted"> · Pausen werden genauer … {Math.round(exactProgress * 100)} %</span> : null}
          </>
        ) : null}
      </p>
      <details class="trim-exact">
        <summary>Genaue Zeiten eingeben</summary>
        <div class="trim-exact-body stack tight">
          <div class="row wrap trim-fields">
            <SecondsField label="Am Anfang weg (Sekunden)" id="trim-start" value={edit.startSec} disabled={!ready || disabled} onValue={(v) => changeTo(moveGrip(hist.edit, { kind: 'start' }, v, duration))} />
            <SecondsField
              label="Am Ende weg (Sekunden)"
              id="trim-end"
              value={Math.max(0, duration - edit.endSec)}
              disabled={!ready || disabled}
              onValue={(v) => changeTo(moveGrip(hist.edit, { kind: 'end' }, duration - v, duration))}
            />
          </div>
          {edit.cuts.length ? (
            <p class="small muted">
              Herausgeschnitten:{' '}
              {edit.cuts.map((c, i) => (
                <span key={i}>
                  {i ? ', ' : ''}
                  {clockTime(c.fromSec)} bis {clockTime(c.toSec)}
                </span>
              ))}
            </p>
          ) : null}
          <p class="tiny muted">Die Schnitte liegen auf etwa 1/40 Sekunde genau. Am Ton ändert sich sonst nichts.</p>
          {children}
        </div>
      </details>
    </div>
  );
}

/** A field for seconds ("12", "2,5", "1:30") that takes the value on Enter or when it is left. */
function SecondsField({ label, id, value, disabled, onValue }: { label: string; id: string; value: number; disabled?: boolean; onValue: (v: number) => void }) {
  const shown = value > 0 ? String(Math.round(value * 10) / 10).replace('.', ',') : '';
  const [text, setText] = useState<string | null>(null);
  const parsed = text === null ? value : parseSeconds(text);
  const bad = text !== null && !(Number.isFinite(parsed) && parsed >= 0);
  const take = () => {
    if (text === null) return;
    if (!bad) onValue(parsed);
    setText(null);
  };
  return (
    <label class="field trim-field" for={id}>
      <span class="small">{label}</span>
      <input
        id={id}
        class="input"
        inputMode="decimal"
        placeholder="0"
        value={text ?? shown}
        disabled={disabled}
        aria-invalid={bad}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={take}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            take();
          }
        }}
      />
      {bad ? <span class="small trim-error">Zum Beispiel 12 oder 1:30.</span> : null}
    </label>
  );
}

/* ------------------------------------------------------------ canvas */

interface Colors {
  paper: string;
  sunken: string;
  ink: string;
  wave: string;
  gone: string;
  pencil: string;
  playhead: string;
  view: string;
  pause: string;
}

let colorCache: { root: string; colors: Colors } | null = null;

function colors(): Colors {
  const root = document.documentElement;
  const key = `${root.dataset.stil ?? ''}|${root.dataset.theme ?? ''}`;
  if (colorCache?.root === key) return colorCache.colors;
  const css = getComputedStyle(root);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const c: Colors = {
    paper: v('--surface', '#fffdf8'),
    sunken: v('--bg-sunken', '#ede6d9'),
    ink: v('--ink', '#1f1a16'),
    wave: v('--primary-text', '#7e4479'),
    gone: v('--border-strong', '#bdb3a0'),
    pencil: v('--pencil', '#8a8174'),
    playhead: v('--danger', '#c2352b'),
    view: v('--highlight', '#fdd459'),
    pause: v('--success', '#4d8a2a'),
  };
  colorCache = { root: key, colors: c };
  return c;
}

/** Sizes the canvas to its box at the screen's pixel density; null when it has no size. */
function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** Stretches cut away: before the start, the pieces in between, after the end. */
function goneStretches(edit: TrimEdit, duration: number): [number, number][] {
  return [[0, edit.startSec] as [number, number], ...edit.cuts.map((c) => [c.fromSec, c.toSec] as [number, number]), [edit.endSec, duration] as [number, number]].filter(([a, b]) => b > a);
}

const RULER_PX = 18;
/** Pause marks show when at most this much of the track shows. */
const PAUSE_MARKS_SEC = 90;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function drawWave(canvas: HTMLCanvasElement, env: Envelope | null, view: View, edit: TrimEdit, places: readonly number[], playhead: number, duration: number) {
  const p = prepare(canvas);
  if (!p) return;
  const { ctx, w, h } = p;
  const c = colors();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.paper;
  ctx.fillRect(0, 0, w, h);
  const span = view.toSec - view.fromSec;
  if (!(span > 0)) return;
  const x = (t: number) => ((t - view.fromSec) / span) * w;
  const waveH = h - RULER_PX;
  const mid = waveH / 2;
  // Cut away: a sunken stripe with pencil hatching.
  ctx.save();
  for (const [a, b] of goneStretches(edit, duration)) {
    const x0 = Math.max(0, x(a));
    const x1 = Math.min(w, x(b));
    if (x1 <= x0) continue;
    ctx.fillStyle = c.sunken;
    ctx.fillRect(x0, 0, x1 - x0, waveH);
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, waveH);
    ctx.clip();
    ctx.strokeStyle = c.gone;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = Math.floor(x0 / 10) * 10 - waveH; k < x1; k += 10) {
      ctx.moveTo(k, waveH);
      ctx.lineTo(k + waveH, 0);
    }
    ctx.stroke();
    ctx.restore();
    ctx.save();
  }
  ctx.restore();
  // The wave: one bar per pixel column, ink where it stays, pencil where it goes.
  if (env) {
    const cols = Math.max(1, Math.floor(w));
    const body = new Float32Array(cols);
    const heights = env.pyramid.columns(view.fromSec, view.toSec, cols, undefined, body);
    const gone = goneStretches(edit, duration);
    const isGone = (t: number) => gone.some(([a, b]) => t >= a && t < b);
    const room = mid - 6;
    // Peaks light, the body of the wave (mean level) dark: a long book shows its quiet and loud parts.
    for (const [arr, light] of [
      [heights, true],
      [body, false],
    ] as const) {
      ctx.globalAlpha = light ? 0.45 : 1;
      for (let i = 0; i < cols; i++) {
        const hh = Math.max(0.6, arr[i] * room);
        ctx.fillStyle = isGone(view.fromSec + ((i + 0.5) / cols) * span) ? c.gone : c.wave;
        ctx.fillRect(i, mid - hh, 1, 2 * hh);
      }
    }
    ctx.globalAlpha = 1;
    // Where the grips snap to: small marks on the middle line, once there is room to tell them apart.
    if (span <= PAUSE_MARKS_SEC) {
      ctx.fillStyle = c.pause;
      for (const t of places) {
        if (t < view.fromSec || t > view.toSec) continue;
        ctx.fillRect(x(t) - 1, mid - 3, 2, 6);
      }
    }
  }
  // Ruler.
  ctx.fillStyle = c.paper;
  ctx.fillRect(0, waveH, w, RULER_PX);
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, waveH + 0.5);
  ctx.lineTo(w, waveH + 0.5);
  ctx.stroke();
  const step = STEPS.find((s) => (s / span) * w >= 70) ?? 7200;
  ctx.fillStyle = c.pencil;
  ctx.font = `11px ${getComputedStyle(canvas).fontFamily || 'sans-serif'}`;
  ctx.textBaseline = 'top';
  ctx.beginPath();
  for (let t = Math.ceil(view.fromSec / step) * step; t <= view.toSec; t += step) {
    const xx = Math.round(x(t)) + 0.5;
    ctx.moveTo(xx, waveH);
    ctx.lineTo(xx, waveH + 5);
    ctx.fillText(clockTime(t, step < 1), xx + 3, waveH + 4);
  }
  ctx.strokeStyle = c.pencil;
  ctx.stroke();
  // Playhead.
  if (playhead >= view.fromSec && playhead <= view.toSec) {
    ctx.fillStyle = c.playhead;
    ctx.fillRect(Math.round(x(playhead)) - 1, 0, 2, waveH);
  }
}

function drawOverview(canvas: HTMLCanvasElement, env: Envelope | null, view: View, edit: TrimEdit, duration: number) {
  const p = prepare(canvas);
  if (!p) return;
  const { ctx, w, h } = p;
  const c = colors();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.paper;
  ctx.fillRect(0, 0, w, h);
  if (!(duration > 0)) return;
  const x = (t: number) => (t / duration) * w;
  for (const [a, b] of goneStretches(edit, duration)) {
    ctx.fillStyle = c.sunken;
    ctx.fillRect(x(a), 0, Math.max(1, x(b) - x(a)), h);
  }
  if (env) {
    const cols = Math.max(1, Math.floor(w));
    const heights = env.pyramid.columns(0, duration, cols);
    ctx.fillStyle = c.pencil;
    for (let i = 0; i < cols; i++) {
      const hh = Math.max(0.5, heights[i] * (h / 2 - 2));
      ctx.fillRect(i, h / 2 - hh, 1, 2 * hh);
    }
  }
  // The part that shows below: a marker-yellow window (none while all of it shows).
  if (view.fromSec <= 0 && view.toSec >= duration) return;
  const x0 = x(view.fromSec);
  const x1 = Math.max(x0 + 3, x(view.toSec));
  ctx.fillStyle = c.view;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(x0, 0, x1 - x0, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 + 1, 1, x1 - x0 - 2, h - 2);
}
