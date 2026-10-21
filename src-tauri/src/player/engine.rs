//! The player behind "Anhören" in the desktop app: voices that each play a
//! track (and the next one, gapless, when one is queued), one decoding
//! thread per voice, one output for all of them, and a small thread that
//! tells the page what happened.
//!
//! The output is opened at the first use and kept: starting a track then
//! only means decoding its first packets and handing them to the callback
//! that already runs, a few milliseconds. It is paused (not closed) after a
//! while without sound, so an idle app costs nothing.
//!
//! Everything that touches the system comes in through two traits: the
//! output (cpal in the app, a made-up one in the tests) and the place
//! events go (the window in the app, a list in the tests).

use super::mixer::{Chunk, MixEvent, Mixer, Run};
use super::track::Decode;
use crate::error::{CmdError, CmdResult};
use crate::resample::Resampler;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Decoded audio kept ready per voice: enough to ride out a slow read from the card.
const AHEAD_SEC: f64 = 1.0;
/// Decoded before a load returns, so the first callback already has sound.
const FIRST_SEC: f64 = 0.06;
/// How often the page hears where a playing voice is; it moves its bar
/// smoothly in between on its own.
const POS_EVERY: Duration = Duration::from_millis(250);
/// The event thread's beat.
const TICK: Duration = Duration::from_millis(20);
/// No callback for this long while sound should play: the output is gone.
const STALL: Duration = Duration::from_millis(1500);
/// How often the default device is checked while something plays.
const DEVICE_EVERY: Duration = Duration::from_secs(2);
/// The output is paused after this long without anything playing.
const IDLE: Duration = Duration::from_secs(15);

/* ------------------------------------------------------------ the outside */

/// What the page hears about (event "player").
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerEvent {
    pub voice: u32,
    /// started, ended, seeked, paused, pos, duration, error, device
    pub kind: &'static str,
    pub track: u32,
    pub pos_sec: f64,
    pub playing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u32>,
    /// started: milliseconds from the command to the first frame given to the output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<f64>,
    /// pos: milliseconds of sound missing so far because decoding fell behind (for the measuring mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap_ms: Option<f64>,
    /// error and device: what went wrong (an error code of the "player" area).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl PlayerEvent {
    fn new(voice: u32, kind: &'static str, track: u32, pos_sec: f64, playing: bool) -> Self {
        PlayerEvent { voice, kind, track, pos_sec, playing, duration_sec: None, epoch: None, start_ms: None, gap_ms: None, code: None }
    }
}

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: PlayerEvent);
}

/// Signs of life of the output, written by its callback.
#[derive(Debug)]
pub struct Health {
    start: Instant,
    /// Milliseconds after `start` of the last callback (0: none yet).
    last_beat: AtomicU64,
    /// The output reported that its device is gone.
    pub lost: AtomicBool,
}

impl Default for Health {
    fn default() -> Self {
        Health { start: Instant::now(), last_beat: AtomicU64::new(0), lost: AtomicBool::new(false) }
    }
}

impl Health {
    pub fn beat(&self) {
        self.last_beat.store(self.start.elapsed().as_millis() as u64 + 1, Ordering::Relaxed);
    }

    /// Time since the last callback; None before the first.
    fn since_beat(&self) -> Option<Duration> {
        let at = self.last_beat.load(Ordering::Relaxed);
        (at > 0).then(|| self.start.elapsed().saturating_sub(Duration::from_millis(at - 1)))
    }

    fn reset(&self) {
        self.last_beat.store(0, Ordering::Relaxed);
        self.lost.store(false, Ordering::Relaxed);
    }
}

pub struct OutputInfo {
    pub rate: u32,
    pub channels: usize,
    /// The device, to notice when the system's default changes.
    pub device: Option<String>,
}

/// An open output; dropping it closes it.
pub trait Output: Send {
    fn info(&self) -> &OutputInfo;
    /// Pauses or resumes the callbacks.
    fn set_running(&mut self, on: bool);
}

pub trait OutputFactory: Send + Sync + 'static {
    /// Opens the system's default output; its callback fills from `mixer`
    /// and beats `health`. Err: an error code ("no-device", "output-failed").
    fn open(&self, mixer: Arc<Mutex<Mixer>>, health: Arc<Health>) -> Result<Box<dyn Output>, CmdError>;
    /// The system's default device now.
    fn default_device(&self) -> Option<String>;
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/* ------------------------------------------------------------ conversion */

/// From a track's rate and channels to the output's.
struct Convert {
    from_ch: usize,
    to_ch: usize,
    resampler: Option<Resampler>,
    mapped: Vec<f32>,
}

impl Convert {
    fn new(from_rate: u32, from_ch: usize, to_rate: u32, to_ch: usize) -> Convert {
        let resampler = (from_rate != to_rate).then(|| Resampler::new(from_rate, to_rate, to_ch));
        Convert { from_ch: from_ch.max(1), to_ch: to_ch.max(1), resampler, mapped: Vec::new() }
    }

    /// Mono goes to both sides, more channels to fewer keep the front left and right.
    fn map(&mut self, block: &[f32]) {
        self.mapped.clear();
        let (f, t) = (self.from_ch, self.to_ch);
        if f == t {
            self.mapped.extend_from_slice(block);
            return;
        }
        for frame in block.chunks_exact(f) {
            for c in 0..t {
                let v = match (f, t) {
                    (1, _) if c < 2 => frame[0],
                    (1, _) => 0.0,
                    (_, 1) => (frame[0] + frame[1]) * 0.5,
                    _ => frame.get(c).copied().unwrap_or(0.0),
                };
                self.mapped.push(v);
            }
        }
    }

    fn process(&mut self, block: &[f32], out: &mut Vec<f32>) {
        self.map(block);
        match self.resampler.as_mut() {
            Some(r) => r.process(&self.mapped, out),
            None => out.extend_from_slice(&self.mapped),
        }
    }

    fn finish(&mut self, out: &mut Vec<f32>) {
        if let Some(r) = self.resampler.as_mut() {
            r.finish(out);
        }
    }
}

/* ------------------------------------------------------------ decoding */

enum DecCmd {
    Seek { epoch: u32, sec: f64, track: u32 },
    Queue { track: u32, dec: Box<dyn Decode> },
    Stop,
}

/// What a voice's decoding thread works on.
struct Feeder {
    voice: u32,
    track: u32,
    dec: Box<dyn Decode>,
    /// The track before, kept until the mixer moved on to this one (a jump back into it).
    prev: Option<(u32, Box<dyn Decode>)>,
    next: Option<(u32, Box<dyn Decode>)>,
    epoch: u32,
    /// Place of the first frame after the last jump, and output frames made since.
    base_sec: f64,
    made: u64,
    conv: Convert,
    format: (u32, usize),
    /// The end marker of the last track is queued: nothing more to decode until a jump.
    done: bool,
    exact_told: bool,
    block: Vec<f32>,
    out: Vec<f32>,
}

enum Step {
    /// Decoded and queued a block.
    Fed,
    /// Enough is queued, or the track is done.
    Idle,
}

impl Feeder {
    fn new(voice: u32, track: u32, dec: Box<dyn Decode>, base_sec: f64, format: (u32, usize)) -> Feeder {
        let conv = Convert::new(dec.rate(), dec.channels(), format.0, format.1);
        Feeder { voice, track, dec, prev: None, next: None, epoch: 0, base_sec, made: 0, conv, format, done: false, exact_told: false, block: Vec::new(), out: Vec::new() }
    }

    fn chunk(&mut self, samples: Vec<f32>, last: bool) -> Chunk {
        let start_sec = self.base_sec + self.made as f64 / f64::from(self.format.0);
        self.made += (samples.len() / self.format.1) as u64;
        Chunk { track: self.track, epoch: self.epoch, start_sec, samples, last }
    }

    fn seek(&mut self, epoch: u32, sec: f64, track: u32, sink: &dyn EventSink) {
        if track != self.track {
            // A jump back into the track before, which the decoder had already left.
            if let Some((t, d)) = self.prev.take().filter(|(t, _)| *t == track) {
                let ahead = std::mem::replace(&mut self.dec, d);
                self.next = Some((self.track, ahead));
                self.track = t;
            }
        }
        if let Some((_, n)) = self.next.as_mut() {
            // The next track starts from its beginning again.
            let _ = n.seek(0.0);
        }
        self.epoch = epoch;
        self.base_sec = sec.max(0.0);
        self.made = 0;
        self.done = false;
        self.conv = Convert::new(self.dec.rate(), self.dec.channels(), self.format.0, self.format.1);
        if let Err(e) = self.dec.seek(sec) {
            self.fail(e, sink);
        }
    }

    fn fail(&mut self, e: CmdError, sink: &dyn EventSink) {
        let mut ev = PlayerEvent::new(self.voice, "error", self.track, self.base_sec, false);
        ev.code = Some(e.code.to_string());
        log::warn!("player: {} {}", e.code, e.detail);
        sink.emit(ev);
        self.done = true;
        self.next = None;
    }

    /// Decodes one block when less than `ahead_sec` is queued.
    fn step(&mut self, mixer: &Mutex<Mixer>, ahead_sec: f64, sink: &dyn EventSink) -> Step {
        let (queued, format) = {
            let m = lock(mixer);
            (m.queued_frames(self.voice), (m.rate, m.channels))
        };
        if format != self.format {
            // Another output: what was queued is gone, the engine sends a jump to where the voice was.
            self.format = format;
            self.conv = Convert::new(self.dec.rate(), self.dec.channels(), format.0, format.1);
        }
        if !self.exact_told {
            let (d, exact) = self.dec.duration();
            if exact {
                self.exact_told = true;
                let mut ev = PlayerEvent::new(self.voice, "duration", self.track, 0.0, false);
                ev.duration_sec = Some(d);
                sink.emit(ev);
            }
        }
        if self.done || queued as f64 >= ahead_sec * f64::from(format.0) {
            return Step::Idle;
        }
        self.block.clear();
        self.out.clear();
        let more = match self.dec.next(&mut self.block) {
            Ok(more) => more,
            Err(e) => {
                let chunk = self.chunk(Vec::new(), true);
                lock(mixer).push(self.voice, chunk);
                self.fail(e, sink);
                return Step::Fed;
            }
        };
        if more {
            self.conv.process(&self.block, &mut self.out);
            if !self.out.is_empty() {
                let samples = std::mem::take(&mut self.out);
                let chunk = self.chunk(samples, false);
                lock(mixer).push(self.voice, chunk);
            }
            return Step::Fed;
        }
        // The end of the track: the rest of the converter, then the end marker.
        self.conv.finish(&mut self.out);
        let mut chunks = Vec::new();
        if !self.out.is_empty() {
            let tail = std::mem::take(&mut self.out);
            chunks.push(self.chunk(tail, false));
        }
        chunks.push(self.chunk(Vec::new(), true));
        if let Some((t, d)) = self.next.take() {
            let old = std::mem::replace(&mut self.dec, d);
            self.prev = Some((self.track, old));
            self.track = t;
            self.base_sec = 0.0;
            self.made = 0;
            self.exact_told = false;
            self.conv = Convert::new(self.dec.rate(), self.dec.channels(), format.0, format.1);
        } else {
            self.done = true;
        }
        let mut m = lock(mixer);
        for c in chunks {
            m.push(self.voice, c);
        }
        Step::Fed
    }

    /// A next track that comes after the end of the last one was decoded (a
    /// short track): it still follows without a gap if the end has not been
    /// played yet. Checked and claimed under one lock, so the mixer cannot
    /// reach the end in between. Too late, the voice has ended and the page
    /// loads the track anew.
    fn append_after_end(&mut self, track: u32, dec: Box<dyn Decode>, mixer: &Mutex<Mixer>) {
        let mut m = lock(mixer);
        if m.run_of(self.voice) == Some(Run::Ended) {
            return;
        }
        let old = std::mem::replace(&mut self.dec, dec);
        self.prev = Some((self.track, old));
        self.track = track;
        self.base_sec = 0.0;
        self.made = 0;
        self.exact_told = false;
        self.done = false;
        self.conv = Convert::new(self.dec.rate(), self.dec.channels(), self.format.0, self.format.1);
        // An empty chunk of the new track keeps the voice from ending at the old one's end marker.
        m.push(self.voice, Chunk { track, epoch: self.epoch, start_sec: 0.0, samples: Vec::new(), last: false });
    }

    /// The decoding thread: keeps the queue filled and follows the commands.
    fn run(mut self, rx: Receiver<DecCmd>, mixer: Arc<Mutex<Mixer>>, sink: Arc<dyn EventSink>) {
        loop {
            let idle = matches!(self.step(&mixer, AHEAD_SEC, sink.as_ref()), Step::Idle);
            let cmd = if idle {
                // Full or done: wait for a command, looking at the queue now and then.
                match rx.recv_timeout(if self.done && self.exact_told { Duration::from_millis(500) } else { Duration::from_millis(30) }) {
                    Ok(c) => Some(c),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            } else {
                match rx.try_recv() {
                    Ok(c) => Some(c),
                    Err(mpsc::TryRecvError::Empty) => None,
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            };
            match cmd {
                None => {}
                Some(DecCmd::Stop) => return,
                Some(DecCmd::Seek { epoch, sec, track }) => self.seek(epoch, sec, track, sink.as_ref()),
                Some(DecCmd::Queue { track, dec }) if !self.done => self.next = Some((track, dec)),
                Some(DecCmd::Queue { track, dec }) => self.append_after_end(track, dec, &mixer),
            }
        }
    }
}

/* ------------------------------------------------------------ the engine */

struct VoiceCtl {
    tx: Sender<DecCmd>,
    epoch: u32,
    /// When the command that should make it sound came (for start_ms).
    asked: Option<Instant>,
    thread: Option<JoinHandle<()>>,
}

struct OutputSlot {
    out: Box<dyn Output>,
    running: bool,
}

struct Inner {
    mixer: Arc<Mutex<Mixer>>,
    health: Arc<Health>,
    factory: Box<dyn OutputFactory>,
    sink: Arc<dyn EventSink>,
    output: Mutex<Option<OutputSlot>>,
    voices: Mutex<HashMap<u32, VoiceCtl>>,
    next_id: AtomicU32,
    pump_started: AtomicBool,
    shutdown: AtomicBool,
}

pub struct LoadOptions {
    /// Where to start, seconds.
    pub at: f64,
    pub play: bool,
    pub volume: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub voice: u32,
    pub track: u32,
    pub duration_sec: f64,
    /// The length is exact (otherwise a "duration" event follows when it is).
    pub exact: bool,
}

pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    pub fn new(factory: Box<dyn OutputFactory>, sink: Arc<dyn EventSink>) -> Engine {
        Engine {
            inner: Arc::new(Inner {
                mixer: Arc::new(Mutex::new(Mixer::new(48000, 2))),
                health: Arc::new(Health::default()),
                factory,
                sink,
                output: Mutex::new(None),
                voices: Mutex::new(HashMap::new()),
                next_id: AtomicU32::new(1),
                pump_started: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
            }),
        }
    }

    /// Opens the output now (when a page with tracks shows), so the first "Anhören" is quick.
    pub fn warm(&self) -> CmdResult<()> {
        self.inner.ensure_output(false)?;
        // The event thread pauses the output again when nothing plays for a while.
        self.inner.start_pump();
        Ok(())
    }

    /// Opens a track as a new voice, decodes its first packets and, with
    /// `play`, lets it sound. The track keeps decoding in a thread of its own.
    pub fn load(&self, dec: Box<dyn Decode>, opts: LoadOptions) -> CmdResult<Loaded> {
        let asked = Instant::now();
        let inner = &self.inner;
        inner.ensure_output(opts.play)?;
        let mut dec = dec;
        let at = opts.at.max(0.0);
        if at > 0.0 {
            dec.seek(at)?;
        }
        let (duration_sec, exact) = dec.duration();
        let voice = inner.next_id.fetch_add(1, Ordering::Relaxed);
        let track = inner.next_id.fetch_add(1, Ordering::Relaxed);
        let format = {
            let mut m = lock(&inner.mixer);
            m.add_voice(voice, track, opts.volume, at);
            (m.rate, m.channels)
        };
        let mut feeder = Feeder::new(voice, track, dec, at, format);
        // The first packets now, so the sound starts with the next callback.
        while matches!(feeder.step(&inner.mixer, FIRST_SEC, inner.sink.as_ref()), Step::Fed) {}
        if opts.play {
            lock(&inner.mixer).play(voice);
        }
        let (tx, rx) = mpsc::channel();
        let (mixer, sink) = (inner.mixer.clone(), inner.sink.clone());
        let thread = std::thread::Builder::new().name(format!("player-{voice}")).spawn(move || feeder.run(rx, mixer, sink)).map_err(|e| CmdError::other(format!("player thread: {e}")))?;
        lock(&inner.voices).insert(voice, VoiceCtl { tx, epoch: 0, asked: opts.play.then_some(asked), thread: Some(thread) });
        inner.start_pump();
        Ok(Loaded { voice, track, duration_sec, exact })
    }

    /// Plays `dec` right after the voice's current track, without a gap.
    pub fn queue(&self, voice: u32, dec: Box<dyn Decode>) -> CmdResult<u32> {
        let track = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let voices = lock(&self.inner.voices);
        let ctl = voices.get(&voice).ok_or_else(|| closed(voice))?;
        let _ = ctl.tx.send(DecCmd::Queue { track, dec });
        Ok(track)
    }

    pub fn play(&self, voice: u32) -> CmdResult<()> {
        let inner = &self.inner;
        inner.ensure_output(true)?;
        let ended = lock(&inner.mixer).run_of(voice).ok_or_else(|| closed(voice))? == Run::Ended;
        if ended {
            // Played to the end: "play" starts it again, like a browser's player.
            self.seek(voice, 0.0)?;
        }
        lock(&inner.mixer).play(voice);
        Ok(())
    }

    pub fn pause(&self, voice: u32) -> CmdResult<()> {
        let mut m = lock(&self.inner.mixer);
        m.run_of(voice).ok_or_else(|| closed(voice))?;
        m.pause(voice);
        Ok(())
    }

    pub fn seek(&self, voice: u32, sec: f64) -> CmdResult<()> {
        self.inner.seek(voice, sec)
    }

    pub fn set_volume(&self, voice: u32, volume: f32) -> CmdResult<()> {
        let mut m = lock(&self.inner.mixer);
        m.run_of(voice).ok_or_else(|| closed(voice))?;
        m.set_volume(voice, volume);
        Ok(())
    }

    /// Where the listener is in the voice's track, and whether it plays.
    #[cfg(test)]
    pub fn position(&self, voice: u32) -> Option<(u32, f64, bool)> {
        let inner = &self.inner;
        let m = lock(&inner.mixer);
        let (track, pos) = inner.heard(&m, voice)?;
        Some((track, pos, m.run_of(voice) == Some(Run::Playing)))
    }

    /// Lets go of a voice: its thread ends, its file is closed.
    pub fn close(&self, voice: u32) {
        self.inner.close(voice);
    }

    /// Lets go of every voice (the page reloads, the window closes).
    pub fn close_all(&self) {
        let ids: Vec<u32> = lock(&self.inner.voices).keys().copied().collect();
        for id in ids {
            self.inner.close(id);
        }
    }

    /// The app quits: everything stops, the output is closed.
    pub fn shutdown(&self) {
        self.close_all();
        self.inner.shutdown.store(true, Ordering::Relaxed);
        *lock(&self.inner.output) = None;
    }

    #[cfg(test)]
    fn mixer(&self) -> Arc<Mutex<Mixer>> {
        self.inner.mixer.clone()
    }

    /// One beat of the event thread (the tests run it by hand).
    #[cfg(test)]
    fn tick(&self, state: &mut PumpState) {
        self.inner.tick(state);
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn closed(voice: u32) -> CmdError {
    CmdError::new("closed", format!("player voice {voice} is not open"))
}

/// What the event thread remembers between beats.
struct PumpState {
    last_pos: Instant,
    last_device_check: Instant,
    idle_since: Option<Instant>,
}

impl PumpState {
    fn new() -> PumpState {
        let now = Instant::now();
        PumpState { last_pos: now, last_device_check: now, idle_since: None }
    }
}

impl Inner {
    /// Opens the output if there is none; with `run`, lets its callbacks run.
    fn ensure_output(&self, run: bool) -> CmdResult<()> {
        let mut slot = lock(&self.output);
        if slot.is_none() {
            self.health.reset();
            let out = self.factory.open(self.mixer.clone(), self.health.clone())?;
            let (rate, channels) = (out.info().rate, out.info().channels);
            let changed = {
                let mut m = lock(&self.mixer);
                let changed = (m.rate, m.channels) != (rate, channels);
                if changed {
                    m.set_format(rate, channels);
                }
                changed
            };
            *slot = Some(OutputSlot { out, running: true });
            drop(slot);
            if changed {
                self.reseek_all();
            }
            slot = lock(&self.output);
        }
        if let Some(s) = slot.as_mut() {
            if run && !s.running {
                self.health.reset();
                s.out.set_running(true);
                s.running = true;
            }
        }
        Ok(())
    }

    /// Every voice jumps to where it is: after a change of output, its
    /// queued sound was in the old format.
    fn reseek_all(&self) {
        // Locks are taken voices first, mixer second (as in seek), never the other way round.
        let ids: Vec<u32> = lock(&self.voices).keys().copied().collect();
        let places: Vec<(u32, f64)> = {
            let m = lock(&self.mixer);
            ids.into_iter().filter_map(|v| m.position(v).map(|(_, p)| (v, p))).collect()
        };
        for (v, p) in places {
            let _ = self.seek(v, p);
        }
    }

    fn seek(&self, voice: u32, sec: f64) -> CmdResult<()> {
        let mut voices = lock(&self.voices);
        let ctl = voices.get_mut(&voice).ok_or_else(|| closed(voice))?;
        ctl.epoch += 1;
        let epoch = ctl.epoch;
        let sec = if sec.is_finite() { sec.max(0.0) } else { 0.0 };
        let track = {
            let mut m = lock(&self.mixer);
            let (track, _) = m.position(voice).ok_or_else(|| closed(voice))?;
            m.begin_seek(voice, epoch, sec, track);
            track
        };
        let _ = ctl.tx.send(DecCmd::Seek { epoch, sec, track });
        Ok(())
    }

    fn close(&self, voice: u32) {
        let ctl = lock(&self.voices).remove(&voice);
        lock(&self.mixer).remove_voice(voice);
        if let Some(mut ctl) = ctl {
            let _ = ctl.tx.send(DecCmd::Stop);
            // The thread ends on its own; it is not waited for, a slow card must not hold the page.
            ctl.thread.take();
        }
    }

    /// Where the listener is: the mixer's place, moved on by the time since
    /// the last callback, so the bar does not stand still between them.
    fn heard(&self, m: &Mixer, voice: u32) -> Option<(u32, f64)> {
        let (track, pos) = m.heard_position(voice)?;
        if m.run_of(voice) != Some(Run::Playing) {
            return Some((track, pos));
        }
        let since = self.health.since_beat().unwrap_or_default().as_secs_f64().min(m.latency_sec);
        let (_, next) = m.position(voice)?;
        Some((track, (pos + since).min(next)))
    }

    fn start_pump(self: &Arc<Self>) {
        if self.pump_started.swap(true, Ordering::Relaxed) {
            return;
        }
        let me = Arc::downgrade(self);
        let _ = std::thread::Builder::new().name("player-events".into()).spawn(move || {
            let mut state = PumpState::new();
            loop {
                std::thread::sleep(TICK);
                let Some(inner) = me.upgrade() else { return };
                if inner.shutdown.load(Ordering::Relaxed) {
                    return;
                }
                inner.tick(&mut state);
            }
        });
    }

    fn tick(&self, st: &mut PumpState) {
        let now = Instant::now();
        let (events, playing) = {
            let mut m = lock(&self.mixer);
            (m.take_events(), m.any_playing())
        };
        for e in events {
            let ev = match e {
                MixEvent::Started { voice, track } => {
                    let mut ev = PlayerEvent::new(voice, "started", track, 0.0, true);
                    if let Some(asked) = lock(&self.voices).get_mut(&voice).and_then(|c| c.asked.take()) {
                        ev.start_ms = Some((now - asked).as_secs_f64() * 1000.0);
                    }
                    if let Some((_, p)) = self.heard(&lock(&self.mixer), voice) {
                        ev.pos_sec = p;
                    }
                    ev
                }
                MixEvent::Ended { voice, track } => {
                    let still = lock(&self.mixer).run_of(voice) != Some(Run::Ended);
                    PlayerEvent::new(voice, "ended", track, 0.0, still)
                }
                MixEvent::Seeked { voice, track, epoch, pos_sec } => {
                    let playing = lock(&self.mixer).run_of(voice) == Some(Run::Playing);
                    let mut ev = PlayerEvent::new(voice, "seeked", track, pos_sec, playing);
                    ev.epoch = Some(epoch);
                    ev
                }
                MixEvent::Paused { voice } => {
                    let (track, pos) = lock(&self.mixer).position(voice).unwrap_or((0, 0.0));
                    PlayerEvent::new(voice, "paused", track, pos, false)
                }
            };
            self.sink.emit(ev);
        }
        if now - st.last_pos >= POS_EVERY {
            st.last_pos = now;
            let ids: Vec<u32> = lock(&self.voices).keys().copied().collect();
            let m = lock(&self.mixer);
            for v in ids {
                if m.run_of(v) == Some(Run::Playing) {
                    if let Some((track, pos)) = self.heard(&m, v) {
                        let mut ev = PlayerEvent::new(v, "pos", track, pos, true);
                        ev.gap_ms = Some(m.underruns(v) as f64 * 1000.0 / f64::from(m.rate));
                        self.sink.emit(ev);
                    }
                }
            }
        }
        let running = lock(&self.output).as_ref().is_some_and(|s| s.running);
        if running && playing {
            st.idle_since = None;
            let stalled = self.health.since_beat().is_some_and(|d| d > STALL);
            if self.health.lost.load(Ordering::Relaxed) || stalled {
                self.output_lost();
                return;
            }
            if now - st.last_device_check >= DEVICE_EVERY {
                st.last_device_check = now;
                self.follow_default_device();
            }
        } else if running {
            let since = *st.idle_since.get_or_insert(now);
            if now - since >= IDLE {
                if let Some(s) = lock(&self.output).as_mut() {
                    s.out.set_running(false);
                    s.running = false;
                }
                st.idle_since = None;
            }
        }
    }

    /// The device is gone (headphones pulled out, a USB box unplugged): every
    /// voice pauses where it is, the page says so, and the system's default
    /// device takes over for the next "Anhören".
    fn output_lost(&self) {
        *lock(&self.output) = None;
        let ids: Vec<u32> = lock(&self.voices).keys().copied().collect();
        let paused: Vec<(u32, u32, f64)> = {
            let mut m = lock(&self.mixer);
            ids.into_iter()
                .filter(|&v| matches!(m.run_of(v), Some(Run::Playing | Run::Pausing)))
                .collect::<Vec<u32>>()
                .into_iter()
                .map(|v| {
                    // No callback will fade it out any more.
                    m.halt(v);
                    let (t, p) = m.position(v).unwrap_or((0, 0.0));
                    (v, t, p)
                })
                .collect()
        };
        let reopened = self.ensure_output(false);
        if let Some(s) = lock(&self.output).as_mut() {
            s.out.set_running(false);
            s.running = false;
        }
        for (v, t, p) in paused {
            self.sink.emit(PlayerEvent::new(v, "paused", t, p, false));
        }
        let mut ev = PlayerEvent::new(0, "device", 0, 0.0, false);
        ev.code = Some(if reopened.is_ok() { "device-lost" } else { "no-device" }.to_string());
        self.sink.emit(ev);
    }

    /// The system's default device changed while something plays (headphones
    /// plugged in on Windows): the sound moves there and plays on.
    fn follow_default_device(&self) {
        let now = self.factory.default_device();
        let same = match lock(&self.output).as_ref() {
            Some(s) => now.is_none() || s.out.info().device == now,
            None => true,
        };
        if same {
            return;
        }
        let old = lock(&self.output).take();
        match self.ensure_output(true) {
            Ok(()) => drop(old),
            Err(_) => *lock(&self.output) = old,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// Samples of the made-up track are frame numbers times this: exact in
    /// an f32 for tracks up to 349 s at 48 kHz.
    const SCALE: f32 = 1.0 / 16_777_216.0;

    fn frame_of(s: f32) -> i64 {
        (s / SCALE).round() as i64
    }

    /// A made-up track: mono, its samples say their own frame number, so a
    /// test can tell which place of the track came out.
    struct Counter {
        rate: u32,
        frames: u64,
        pos: u64,
        block: u64,
        exact_after: usize,
        asked: AtomicUsize,
    }

    impl Counter {
        fn new(rate: u32, sec: f64) -> Box<Counter> {
            Box::new(Counter { rate, frames: (sec * f64::from(rate)) as u64, pos: 0, block: 1152, exact_after: 0, asked: AtomicUsize::new(0) })
        }
    }

    impl Decode for Counter {
        fn rate(&self) -> u32 {
            self.rate
        }
        fn channels(&self) -> usize {
            1
        }
        fn next(&mut self, out: &mut Vec<f32>) -> CmdResult<bool> {
            if self.pos >= self.frames {
                return Ok(false);
            }
            let end = (self.pos + self.block).min(self.frames);
            out.extend((self.pos..end).map(|i| i as f32 * SCALE));
            self.pos = end;
            Ok(true)
        }
        fn seek(&mut self, sec: f64) -> CmdResult<()> {
            self.pos = ((sec * f64::from(self.rate)).round() as u64).min(self.frames);
            Ok(())
        }
        fn duration(&self) -> (f64, bool) {
            let n = self.asked.fetch_add(1, Ordering::Relaxed);
            (self.frames as f64 / f64::from(self.rate), n >= self.exact_after)
        }
    }

    #[derive(Default)]
    struct Events(Mutex<Vec<PlayerEvent>>);
    impl EventSink for Events {
        fn emit(&self, event: PlayerEvent) {
            lock(&self.0).push(event);
        }
    }
    impl Events {
        fn kinds(&self) -> Vec<&'static str> {
            lock(&self.0).iter().map(|e| e.kind).collect()
        }
        fn take(&self) -> Vec<PlayerEvent> {
            std::mem::take(&mut lock(&self.0))
        }
    }

    /// A made-up output: nothing runs by itself; the test pulls buffers
    /// through the mixer (`render`), as a sound card's callback would.
    struct FakeOutput {
        info: OutputInfo,
        running: Arc<AtomicBool>,
    }
    impl Output for FakeOutput {
        fn info(&self) -> &OutputInfo {
            &self.info
        }
        fn set_running(&mut self, on: bool) {
            self.running.store(on, Ordering::Relaxed);
        }
    }

    #[derive(Default)]
    struct FakeOutputs {
        opened: AtomicUsize,
        fail: AtomicBool,
        rate: AtomicU32,
        device: Mutex<String>,
        running: Arc<AtomicBool>,
        health: Mutex<Option<Arc<Health>>>,
    }
    impl OutputFactory for Arc<FakeOutputs> {
        fn open(&self, _mixer: Arc<Mutex<Mixer>>, health: Arc<Health>) -> Result<Box<dyn Output>, CmdError> {
            if self.fail.load(Ordering::Relaxed) {
                return Err(CmdError::new("no-device", "none"));
            }
            self.opened.fetch_add(1, Ordering::Relaxed);
            *lock(&self.health) = Some(health);
            let rate = match self.rate.load(Ordering::Relaxed) {
                0 => 48000,
                r => r,
            };
            self.running.store(true, Ordering::Relaxed);
            Ok(Box::new(FakeOutput { info: OutputInfo { rate, channels: 2, device: Some(lock(&self.device).clone()) }, running: self.running.clone() }))
        }
        fn default_device(&self) -> Option<String> {
            Some(lock(&self.device).clone())
        }
    }

    fn engine() -> (Engine, Arc<FakeOutputs>, Arc<Events>) {
        let outputs = Arc::new(FakeOutputs::default());
        let events = Arc::new(Events::default());
        (Engine::new(Box::new(outputs.clone()), events.clone()), outputs, events)
    }

    /// Pulls `frames` through the mixer in callback-sized buffers. Before
    /// each it gives the decoding threads a moment to catch up (a test pulls
    /// much faster than a sound card), so gaps only come from the player.
    fn render(e: &Engine, outputs: &FakeOutputs, frames: usize) -> Vec<f32> {
        let mixer = e.mixer();
        let mut left = Vec::new();
        let mut done = 0;
        while done < frames {
            let n = 480.min(frames - done);
            for _ in 0..100 {
                if lock(&mixer).queued_all() >= n {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            let mut buf = vec![0.0; n * 2];
            if let Some(h) = lock(&outputs.health).as_ref() {
                h.beat();
            }
            lock(&mixer).fill(&mut buf);
            left.extend(buf.chunks_exact(2).map(|f| f[0]));
            done += n;
        }
        left
    }

    /// Waits until the voice has `sec` of sound queued.
    fn wait_queued(e: &Engine, voice: u32, sec: f64) {
        for _ in 0..500 {
            if lock(&e.mixer()).queued_frames(voice) as f64 >= sec * 48000.0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("decoder did not fill the queue");
    }

    fn opts(play: bool) -> LoadOptions {
        LoadOptions { at: 0.0, play, volume: 1.0 }
    }

    #[test]
    fn the_first_packets_are_ready_when_load_returns() {
        let (e, outputs, events) = engine();
        let t0 = Instant::now();
        let l = e.load(Counter::new(48000, 10.0), opts(true)).unwrap();
        // Opening the output and decoding the first packets: well under the few milliseconds of a click.
        assert!(t0.elapsed() < Duration::from_millis(200));
        assert!(lock(&e.mixer()).queued_frames(l.voice) as f64 >= FIRST_SEC * 48000.0);
        let out = render(&e, &outputs, 480);
        // Sound in the very first buffer (after the 4 ms fade in).
        assert_eq!(frame_of(out[300]), 300);
        let mut st = PumpState::new();
        e.tick(&mut st);
        let started = events.take().into_iter().find(|ev| ev.kind == "started").unwrap();
        assert!(started.start_ms.is_some());
    }

    #[test]
    fn a_jump_lands_on_the_frame_and_says_so() {
        let (e, outputs, events) = engine();
        let l = e.load(Counter::new(48000, 300.0), opts(true)).unwrap();
        render(&e, &outputs, 4800);
        e.seek(l.voice, 237.25).unwrap();
        // The bar may show the new place at once.
        assert_eq!(e.position(l.voice).map(|p| p.1), Some(237.25));
        wait_queued(&e, l.voice, 0.05);
        let out = render(&e, &outputs, 960);
        // The old place fades out to silence, then the new one comes,
        // starting with exactly the frame at 237.25 s.
        let silent = out.iter().position(|&s| s == 0.0).unwrap();
        let k = silent + 1 + 300;
        assert_eq!(frame_of(out[k]), 237 * 48000 + 12000 + 300);
        let mut st = PumpState::new();
        e.tick(&mut st);
        let seeked = events.take().into_iter().find(|ev| ev.kind == "seeked").unwrap();
        assert_eq!(seeked.pos_sec, 237.25);
        assert!(seeked.playing);
    }

    #[test]
    fn plays_at_another_rate_and_counts_the_time_right() {
        let (e, outputs, _) = engine();
        let l = e.load(Counter::new(44100, 5.0), opts(true)).unwrap();
        render(&e, &outputs, 48000);
        let (_, pos, playing) = e.position(l.voice).unwrap();
        assert!(playing);
        assert!((pos - 1.0).abs() < 0.002, "{pos}");
    }

    #[test]
    fn goes_on_with_a_queued_track_without_a_gap() {
        let (e, outputs, events) = engine();
        // Three seconds: the next track is queued long before the decoder gets to the end.
        let l = e.load(Counter::new(48000, 3.0), opts(true)).unwrap();
        let next = e.queue(l.voice, Counter::new(48000, 1.0)).unwrap();
        let out = render(&e, &outputs, 48000 * 7 / 2);
        let jump = out.windows(2).position(|w| w[1] < w[0]).unwrap();
        assert_eq!(jump + 1, 3 * 48000);
        assert_eq!(frame_of(out[jump + 2]), 1, "no gap");
        assert_eq!(frame_of(out[jump + 1000]), 999);
        let mut st = PumpState::new();
        e.tick(&mut st);
        let evs = events.take();
        assert_eq!(evs.iter().find(|ev| ev.kind == "ended").unwrap().track, l.track);
        assert!(evs.iter().any(|ev| ev.kind == "started" && ev.track == next));
    }

    #[test]
    fn ends_with_an_event_and_goes_on_with_a_track_queued_after_the_decoding_ended() {
        let (e, outputs, events) = engine();
        let l = e.load(Counter::new(48000, 0.5), opts(true)).unwrap();
        // The whole short track is decoded before the next one is queued.
        wait_queued(&e, l.voice, 0.5);
        std::thread::sleep(Duration::from_millis(20));
        let next = e.queue(l.voice, Counter::new(48000, 0.5)).unwrap();
        let out = render(&e, &outputs, 48000 * 3 / 4);
        // Track one counts up to 0.5 s, track two starts at 0 right after it.
        let jump = out.windows(2).position(|w| w[1] < w[0]).unwrap();
        assert_eq!(jump + 1, 24000);
        assert_eq!(out[jump + 1], 0.0);
        assert!(out[jump + 2] > 0.0, "no gap");
        let mut st = PumpState::new();
        e.tick(&mut st);
        let evs = events.take();
        let ended = evs.iter().find(|ev| ev.kind == "ended").unwrap();
        assert_eq!(ended.track, l.track);
        assert!(evs.iter().any(|ev| ev.kind == "started" && ev.track == next));
        // The second track ends the voice.
        render(&e, &outputs, 48000);
        e.tick(&mut st);
        let last = events.take().into_iter().find(|ev| ev.kind == "ended").unwrap();
        assert_eq!((last.track, last.playing), (next, false));
    }

    #[test]
    fn a_track_queued_after_the_end_is_not_played() {
        let (e, outputs, events) = engine();
        let l = e.load(Counter::new(48000, 0.1), opts(true)).unwrap();
        render(&e, &outputs, 9600);
        e.queue(l.voice, Counter::new(48000, 0.5)).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(render(&e, &outputs, 4800).iter().all(|&s| s == 0.0));
        let mut st = PumpState::new();
        e.tick(&mut st);
        assert_eq!(events.kinds().iter().filter(|k| **k == "started").count(), 1);
    }

    #[test]
    fn play_after_the_end_starts_again() {
        let (e, outputs, _) = engine();
        let l = e.load(Counter::new(48000, 0.1), opts(true)).unwrap();
        render(&e, &outputs, 9600);
        assert_eq!(lock(&e.mixer()).run_of(l.voice), Some(Run::Ended));
        e.play(l.voice).unwrap();
        wait_queued(&e, l.voice, 0.05);
        let out = render(&e, &outputs, 960);
        assert_eq!(frame_of(out[500]), 500);
    }

    #[test]
    fn pause_and_play_keep_the_place() {
        let (e, outputs, events) = engine();
        let l = e.load(Counter::new(48000, 10.0), opts(true)).unwrap();
        render(&e, &outputs, 4800);
        e.pause(l.voice).unwrap();
        render(&e, &outputs, 480);
        let (_, at, playing) = e.position(l.voice).unwrap();
        assert!(!playing);
        render(&e, &outputs, 4800);
        assert_eq!(e.position(l.voice).unwrap().1, at);
        e.play(l.voice).unwrap();
        let out = render(&e, &outputs, 480);
        assert_eq!(frame_of(out[400]), (at * 48000.0).round() as i64 + 400);
        let mut st = PumpState::new();
        e.tick(&mut st);
        assert!(events.kinds().contains(&"paused"));
    }

    #[test]
    fn tells_the_exact_length_once_it_is_known() {
        let (e, _outputs, events) = engine();
        let mut c = Counter::new(48000, 3.0);
        c.exact_after = 3;
        let l = e.load(c, opts(false)).unwrap();
        assert!(!l.exact);
        for _ in 0..200 {
            if events.kinds().contains(&"duration") {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let d = events.take().into_iter().find(|ev| ev.kind == "duration").unwrap();
        assert_eq!(d.duration_sec, Some(3.0));
    }

    #[test]
    fn a_lost_device_pauses_with_a_message_and_the_next_play_works() {
        let (e, outputs, events) = engine();
        let l = e.load(Counter::new(48000, 10.0), opts(true)).unwrap();
        render(&e, &outputs, 4800);
        let mut st = PumpState::new();
        e.tick(&mut st);
        events.take();
        // The callbacks stop coming (the device hangs or is gone).
        std::thread::sleep(STALL + Duration::from_millis(100));
        e.tick(&mut st);
        let evs = events.take();
        assert!(evs.iter().any(|ev| ev.kind == "paused" && ev.voice == l.voice));
        let dev = evs.iter().find(|ev| ev.kind == "device").unwrap();
        assert_eq!(dev.code.as_deref(), Some("device-lost"));
        assert_eq!(outputs.opened.load(Ordering::Relaxed), 2);
        let (_, at, playing) = e.position(l.voice).unwrap();
        assert!(!playing && at > 0.09);
        // Play goes on at the same place on the new output.
        e.play(l.voice).unwrap();
        wait_queued(&e, l.voice, 0.05);
        let out = render(&e, &outputs, 960);
        let frame = frame_of(out[600]) as f64 / 48000.0;
        assert!((frame - at).abs() < 0.05, "{frame} vs {at}");
    }

    #[test]
    fn without_any_device_the_page_hears_why() {
        let (e, outputs, events) = engine();
        let l = e.load(Counter::new(48000, 10.0), opts(true)).unwrap();
        render(&e, &outputs, 480);
        outputs.fail.store(true, Ordering::Relaxed);
        lock(&outputs.health).as_ref().unwrap().lost.store(true, Ordering::Relaxed);
        let mut st = PumpState::new();
        e.tick(&mut st);
        assert_eq!(events.take().into_iter().find(|ev| ev.kind == "device").unwrap().code.as_deref(), Some("no-device"));
        assert_eq!(e.play(l.voice).unwrap_err().code, "no-device");
        // A new device: plays again.
        outputs.fail.store(false, Ordering::Relaxed);
        e.play(l.voice).unwrap();
    }

    #[test]
    fn a_new_default_device_takes_over_while_playing() {
        let (e, outputs, _) = engine();
        let l = e.load(Counter::new(48000, 10.0), opts(true)).unwrap();
        render(&e, &outputs, 4800);
        *lock(&outputs.device) = "kopfhoerer".into();
        outputs.rate.store(44100, Ordering::Relaxed);
        let mut st = PumpState::new();
        st.last_device_check = Instant::now() - DEVICE_EVERY;
        e.tick(&mut st);
        assert_eq!(outputs.opened.load(Ordering::Relaxed), 2);
        assert_eq!(lock(&e.mixer()).rate, 44100);
        let (_, _, playing) = e.position(l.voice).unwrap();
        assert!(playing, "plays on");
    }

    #[test]
    fn closing_lets_go_of_the_voice() {
        let (e, outputs, _) = engine();
        let a = e.load(Counter::new(48000, 10.0), opts(true)).unwrap();
        let b = e.load(Counter::new(48000, 10.0), opts(false)).unwrap();
        render(&e, &outputs, 480);
        e.close(a.voice);
        assert!(e.position(a.voice).is_none());
        assert_eq!(e.play(a.voice).unwrap_err().code, "closed");
        e.close_all();
        assert!(e.position(b.voice).is_none());
        assert!(!lock(&e.mixer()).has_voices());
    }

    #[test]
    fn pauses_the_output_when_nothing_plays_for_a_while() {
        let (e, outputs, _) = engine();
        let l = e.load(Counter::new(48000, 10.0), opts(true)).unwrap();
        render(&e, &outputs, 480);
        e.pause(l.voice).unwrap();
        render(&e, &outputs, 480);
        let mut st = PumpState::new();
        e.tick(&mut st);
        st.idle_since = Some(Instant::now() - IDLE);
        e.tick(&mut st);
        assert!(!outputs.running.load(Ordering::Relaxed));
        e.play(l.voice).unwrap();
        assert!(outputs.running.load(Ordering::Relaxed));
    }

    #[test]
    fn converts_mono_to_stereo_and_stereo_to_mono() {
        let mut c = Convert::new(48000, 1, 48000, 2);
        let mut out = Vec::new();
        c.process(&[0.5, -0.5], &mut out);
        assert_eq!(out, vec![0.5, 0.5, -0.5, -0.5]);
        let mut c = Convert::new(48000, 2, 48000, 1);
        let mut out = Vec::new();
        c.process(&[1.0, 0.0, 0.2, 0.4], &mut out);
        assert_eq!(out, vec![0.5, 0.3]);
        let mut c = Convert::new(48000, 6, 48000, 2);
        let mut out = Vec::new();
        c.process(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], &mut out);
        assert_eq!(out, vec![0.1, 0.2]);
    }
}
