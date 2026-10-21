//! What the sound card's callback runs: the voices' queued samples, summed
//! into the output buffer, with short gain ramps wherever the sound would
//! otherwise jump (pause, resume, a jump in the track, a new volume, a gap
//! because the card was too slow). Nothing here touches files or devices,
//! so the tests drive it directly with buffers of any size.
//!
//! Every chunk carries the place in its track where it starts, so the
//! position comes from what was actually played, not from a clock that
//! could run away from the sound.

use std::collections::VecDeque;

/// Length of a gain ramp: long enough to take the click out of a cut, short
/// enough that a pause or jump still feels instant.
pub const RAMP_SEC: f64 = 0.004;

/// Decoded audio of one voice, already in the output's rate and channels.
#[derive(Debug, Clone)]
pub struct Chunk {
    /// The track it belongs to (a voice plays one track, or the next one gapless after it).
    pub track: u32,
    /// Raised by every jump: chunks of an older epoch are thrown away.
    pub epoch: u32,
    /// Place in the track of the chunk's first frame, in seconds.
    pub start_sec: f64,
    pub samples: Vec<f32>,
    /// The track ends after this chunk.
    pub last: bool,
}

/// What a voice is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Run {
    Playing,
    /// Fading out; becomes Paused when the ramp reaches zero.
    Pausing,
    Paused,
    /// Played to the end of its last track.
    Ended,
}

/// What happened in the callback, for the page (collected, sent by the engine).
#[derive(Debug, Clone, PartialEq)]
pub enum MixEvent {
    /// The first frame of `track` was played (also a next track, gapless).
    Started { voice: u32, track: u32 },
    /// The last frame of `track` was played.
    Ended { voice: u32, track: u32 },
    /// The first frame after a jump is ready (paused) or was played.
    Seeked { voice: u32, track: u32, epoch: u32, pos_sec: f64 },
    /// The fade out of a pause is done.
    Paused { voice: u32 },
}

#[derive(Debug)]
struct Voice {
    id: u32,
    chunks: VecDeque<Chunk>,
    /// Read position in the front chunk, in samples.
    read: usize,
    /// Epoch of the frames played now.
    epoch: u32,
    /// Epoch asked for by the last jump; the voice fades out, then switches.
    want_epoch: u32,
    run: Run,
    volume: f32,
    gain: f32,
    /// Place in the track of the next frame to play.
    pos_sec: f64,
    /// Track of the next frame to play.
    track: u32,
    /// Track whose first frame was played (Started sent).
    started: Option<u32>,
    /// A jump whose first frame is not played yet.
    seek_pending: bool,
    /// Frames that were missing while playing (the decoder fell behind).
    pub underruns: u64,
}

impl Voice {
    fn queued_frames(&self, channels: usize) -> usize {
        let samples: usize = self.chunks.iter().filter(|c| c.epoch == self.want_epoch).map(|c| c.samples.len()).sum();
        let read = if self.chunks.front().is_some_and(|c| c.epoch == self.want_epoch) { self.read } else { 0 };
        (samples - read) / channels.max(1)
    }

    /// Drops chunks of older epochs at the front.
    fn drop_stale(&mut self) {
        while self.chunks.front().is_some_and(|c| c.epoch != self.epoch) {
            self.chunks.pop_front();
            self.read = 0;
        }
    }
}

/// All voices and the output format they are mixed in.
#[derive(Debug)]
pub struct Mixer {
    pub rate: u32,
    pub channels: usize,
    voices: Vec<Voice>,
    events: Vec<MixEvent>,
    /// Frames rendered since the output opened.
    pub rendered: u64,
    /// How long a frame takes from the callback to the speaker, as the output reports it.
    pub latency_sec: f64,
    step: f32,
}

impl Mixer {
    pub fn new(rate: u32, channels: usize) -> Mixer {
        let mut m = Mixer { rate: 0, channels: 0, voices: Vec::new(), events: Vec::new(), rendered: 0, latency_sec: 0.0, step: 1.0 };
        m.set_format(rate, channels);
        m
    }

    /// A new output (another device): the queued samples are in the old
    /// format, so every voice drops them; the engine jumps each voice to
    /// where it was, which decodes anew in the new format.
    pub fn set_format(&mut self, rate: u32, channels: usize) {
        let rate = rate.max(1);
        self.rate = rate;
        self.channels = channels.max(1);
        self.step = (1.0 / (RAMP_SEC * f64::from(rate)).max(1.0)) as f32;
        self.rendered = 0;
        for v in &mut self.voices {
            v.chunks.clear();
            v.read = 0;
            v.gain = 0.0;
        }
    }

    pub fn add_voice(&mut self, id: u32, track: u32, volume: f32, start_sec: f64) {
        self.voices.retain(|v| v.id != id);
        self.voices.push(Voice {
            id,
            chunks: VecDeque::new(),
            read: 0,
            epoch: 0,
            want_epoch: 0,
            run: Run::Paused,
            volume: volume.clamp(0.0, 1.0),
            gain: 0.0,
            pos_sec: start_sec,
            track,
            started: None,
            seek_pending: false,
            underruns: 0,
        });
    }

    pub fn remove_voice(&mut self, id: u32) {
        self.voices.retain(|v| v.id != id);
    }

    #[cfg(test)]
    pub fn has_voices(&self) -> bool {
        !self.voices.is_empty()
    }

    pub fn any_playing(&self) -> bool {
        self.voices.iter().any(|v| matches!(v.run, Run::Playing | Run::Pausing))
    }

    fn voice(&mut self, id: u32) -> Option<&mut Voice> {
        self.voices.iter_mut().find(|v| v.id == id)
    }

    /// Queues decoded audio. A chunk of the epoch the voice waits for, given
    /// while it does not play, ends a jump at once: nothing has to fade out.
    pub fn push(&mut self, id: u32, chunk: Chunk) {
        let Some(v) = self.voices.iter_mut().find(|v| v.id == id) else { return };
        if chunk.epoch != v.want_epoch {
            return;
        }
        v.chunks.push_back(chunk);
        if v.want_epoch != v.epoch && v.gain == 0.0 && !matches!(v.run, Run::Playing | Run::Pausing) {
            Self::switch_epoch(v, &mut self.events, false);
        }
    }

    /// Frames queued for the voice in the epoch it waits for.
    pub fn queued_frames(&self, id: u32) -> usize {
        self.voices.iter().find(|v| v.id == id).map_or(0, |v| v.queued_frames(self.channels))
    }

    pub fn play(&mut self, id: u32) {
        if let Some(v) = self.voice(id) {
            if v.run != Run::Ended {
                v.run = Run::Playing;
            }
        }
    }

    pub fn pause(&mut self, id: u32) {
        if let Some(v) = self.voice(id) {
            if v.run == Run::Playing {
                v.run = if v.gain > 0.0 { Run::Pausing } else { Run::Paused };
            }
        }
    }

    /// Pauses at once, without a fade: for an output that is gone, where no callback would fade.
    pub fn halt(&mut self, id: u32) {
        if let Some(v) = self.voice(id) {
            if matches!(v.run, Run::Playing | Run::Pausing) {
                v.run = Run::Paused;
            }
            v.gain = 0.0;
        }
    }

    pub fn set_volume(&mut self, id: u32, volume: f32) {
        if let Some(v) = self.voice(id) {
            v.volume = volume.clamp(0.0, 1.0);
        }
    }

    /// Starts a jump: the voice fades out what it plays now, then waits for
    /// chunks of `epoch`. `pos_sec` is where the jump goes, so the position
    /// says the new place at once. A voice that had ended plays again from there.
    pub fn begin_seek(&mut self, id: u32, epoch: u32, pos_sec: f64, track: u32) {
        let Some(v) = self.voices.iter_mut().find(|v| v.id == id) else { return };
        v.want_epoch = epoch;
        v.pos_sec = pos_sec;
        v.track = track;
        v.seek_pending = true;
        if v.run == Run::Ended {
            v.run = Run::Paused;
            v.started = None;
        }
        if v.gain == 0.0 && !matches!(v.run, Run::Playing | Run::Pausing) && v.chunks.iter().any(|c| c.epoch == epoch) {
            Self::switch_epoch(v, &mut self.events, false);
        }
    }

    /// The voice moves on to the epoch it waits for; `played` says whether the
    /// Seeked event waits for the first frame to be played.
    fn switch_epoch(v: &mut Voice, events: &mut Vec<MixEvent>, played: bool) {
        v.epoch = v.want_epoch;
        v.drop_stale();
        if let Some(c) = v.chunks.front() {
            v.pos_sec = c.start_sec;
            v.track = c.track;
            if !played && v.seek_pending {
                v.seek_pending = false;
                events.push(MixEvent::Seeked { voice: v.id, track: v.track, epoch: v.epoch, pos_sec: v.pos_sec });
            }
        }
    }

    pub fn run_of(&self, id: u32) -> Option<Run> {
        self.voices.iter().find(|v| v.id == id).map(|v| v.run)
    }

    /// Place of the voice's next frame in its track, and that track.
    pub fn position(&self, id: u32) -> Option<(u32, f64)> {
        self.voices.iter().find(|v| v.id == id).map(|v| (v.track, v.pos_sec))
    }

    /// Where the listener is: the next frame's place minus what is still on
    /// its way to the speaker. Never before the start of a jump or the track.
    pub fn heard_position(&self, id: u32) -> Option<(u32, f64)> {
        let v = self.voices.iter().find(|v| v.id == id)?;
        if v.seek_pending || v.run != Run::Playing {
            return Some((v.track, v.pos_sec));
        }
        Some((v.track, (v.pos_sec - self.latency_sec).max(0.0)))
    }

    /// Frames queued for all voices (the tests wait for the decoders with it).
    #[cfg(test)]
    pub fn queued_all(&self) -> usize {
        self.voices.iter().map(|v| v.queued_frames(self.channels)).sum()
    }

    pub fn underruns(&self, id: u32) -> u64 {
        self.voices.iter().find(|v| v.id == id).map_or(0, |v| v.underruns)
    }

    pub fn take_events(&mut self) -> Vec<MixEvent> {
        std::mem::take(&mut self.events)
    }

    /// Fills `out` (interleaved, `self.channels` wide) with the sum of all voices.
    pub fn fill(&mut self, out: &mut [f32]) {
        out.iter_mut().for_each(|s| *s = 0.0);
        let ch = self.channels;
        let frames = out.len() / ch;
        let rate = f64::from(self.rate);
        let step = self.step;
        for v in &mut self.voices {
            let mut f = 0;
            while f < frames {
                // Pausing or jumping: fade out, then stop taking frames.
                let stopping = v.run != Run::Playing || v.want_epoch != v.epoch;
                let target = if stopping { 0.0 } else { v.volume };
                if v.gain == 0.0 && stopping {
                    if v.want_epoch != v.epoch {
                        Self::switch_epoch(v, &mut self.events, v.run == Run::Playing);
                    }
                    if v.run == Run::Pausing {
                        v.run = Run::Paused;
                        self.events.push(MixEvent::Paused { voice: v.id });
                    }
                    if v.run != Run::Playing || v.want_epoch != v.epoch {
                        break;
                    }
                    continue;
                }
                v.drop_stale();
                let Some(c) = v.chunks.front() else {
                    // Nothing to play: the decoder fell behind. The sound
                    // stops here and fades in again when data comes.
                    if !stopping && !v.seek_pending {
                        v.underruns += (frames - f) as u64;
                    }
                    v.gain = 0.0;
                    if v.run == Run::Pausing {
                        v.run = Run::Paused;
                        self.events.push(MixEvent::Paused { voice: v.id });
                    }
                    break;
                };
                if c.samples.len() <= v.read {
                    // The chunk is used up (or an empty end marker).
                    let done = v.chunks.pop_front().unwrap_or_else(|| unreachable!());
                    v.read = 0;
                    if done.last {
                        self.events.push(MixEvent::Ended { voice: v.id, track: done.track });
                        match v.chunks.iter().find(|c| c.epoch == v.epoch) {
                            Some(next) => {
                                v.track = next.track;
                                v.pos_sec = next.start_sec;
                            }
                            None => {
                                v.run = Run::Ended;
                                v.gain = 0.0;
                                break;
                            }
                        }
                    }
                    continue;
                }
                // The old place still fading out does not count as the jump's first frame.
                let jumped = v.seek_pending && v.epoch == v.want_epoch;
                if v.started != Some(c.track) || jumped {
                    if v.started != Some(c.track) {
                        v.started = Some(c.track);
                        self.events.push(MixEvent::Started { voice: v.id, track: c.track });
                    }
                    if jumped {
                        v.seek_pending = false;
                        self.events.push(MixEvent::Seeked { voice: v.id, track: c.track, epoch: v.epoch, pos_sec: c.start_sec + (v.read / ch) as f64 / rate });
                    }
                }
                // Copy frames up to the end of the chunk or of the buffer,
                // ramping the gain one step per frame towards its target.
                let avail = (c.samples.len() - v.read) / ch;
                let n = avail.min(frames - f);
                let src = &c.samples[v.read..v.read + n * ch];
                let dst = &mut out[f * ch..(f + n) * ch];
                let mut gain = v.gain;
                let mut taken = 0;
                for (o, i) in dst.chunks_exact_mut(ch).zip(src.chunks_exact(ch)) {
                    if gain != target {
                        gain = if gain < target { (gain + step).min(target) } else { (gain - step).max(target) };
                    }
                    for (a, b) in o.iter_mut().zip(i) {
                        *a += b * gain;
                    }
                    taken += 1;
                    // Faded out for a pause or a jump: stop right here.
                    if gain == 0.0 && stopping {
                        break;
                    }
                }
                v.gain = gain;
                v.read += taken * ch;
                v.pos_sec = c.start_sec + (v.read / ch) as f64 / rate;
                v.track = c.track;
                f += taken;
            }
        }
        self.rendered += frames as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A chunk whose samples say their own frame number (mono), so a test
    /// can see which frame came out where.
    fn ramp(track: u32, epoch: u32, start_frame: usize, frames: usize, rate: u32) -> Chunk {
        Chunk { track, epoch, start_sec: start_frame as f64 / f64::from(rate), samples: (start_frame..start_frame + frames).map(|i| i as f32).collect(), last: false }
    }

    fn ones(track: u32, epoch: u32, start_sec: f64, frames: usize, channels: usize) -> Chunk {
        Chunk { track, epoch, start_sec, samples: vec![1.0; frames * channels], last: false }
    }

    #[test]
    fn plays_frames_in_order_and_counts_the_position() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 7, 1.0, 0.0);
        m.push(1, ramp(7, 0, 0, 100, 1000));
        m.push(1, ramp(7, 0, 100, 100, 1000));
        m.play(1);
        let mut out = vec![0.0; 150];
        m.fill(&mut out);
        // The first frames fade in (4 ms = 4 frames at 1 kHz), then they pass unchanged.
        assert!(out[0] < 1.0);
        for (i, s) in out.iter().enumerate().skip(4) {
            assert_eq!(*s, i as f32, "frame {i}");
        }
        let (track, pos) = m.position(1).unwrap();
        assert_eq!(track, 7);
        assert!((pos - 0.15).abs() < 1e-12, "{pos}");
        assert_eq!(m.take_events(), vec![MixEvent::Started { voice: 1, track: 7 }]);
    }

    #[test]
    fn heard_position_takes_off_the_output_latency() {
        let mut m = Mixer::new(1000, 1);
        m.latency_sec = 0.02;
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ramp(1, 0, 0, 500, 1000));
        m.play(1);
        m.fill(&mut [0.0; 100]);
        let (_, heard) = m.heard_position(1).unwrap();
        assert!((heard - 0.08).abs() < 1e-9, "{heard}");
    }

    #[test]
    fn pause_fades_out_and_resume_goes_on_at_the_same_frame() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ramp(1, 0, 0, 1000, 1000));
        m.play(1);
        m.fill(&mut [0.0; 50]);
        m.take_events();
        m.pause(1);
        let mut out = vec![0.0; 50];
        m.fill(&mut out);
        // Four frames of fade out, then silence; no frame is skipped.
        assert!(out[0] > 0.0 && out[3] < out[0] * 0.5);
        assert!(out[4..].iter().all(|&s| s == 0.0));
        assert_eq!(m.run_of(1), Some(Run::Paused));
        assert_eq!(m.take_events(), vec![MixEvent::Paused { voice: 1 }]);
        let (_, paused_at) = m.position(1).unwrap();
        assert!((paused_at - 0.054).abs() < 1e-9, "{paused_at}");
        m.play(1);
        let mut out = vec![0.0; 10];
        m.fill(&mut out);
        // Fades in from frame 54 on, with no jump: gain rises step by step.
        assert!(out[0] > 0.0 && out[0] < 54.0);
        assert_eq!(out[5], 59.0);
    }

    #[test]
    fn a_ramp_never_jumps_more_than_one_step() {
        // Constant signal, pause and play in the middle of buffers: the largest
        // change from one frame to the next is one ramp step.
        let mut m = Mixer::new(48000, 2);
        m.add_voice(1, 1, 0.8, 0.0);
        m.push(1, ones(1, 0, 0.0, 48000, 2));
        m.play(1);
        let mut all = Vec::new();
        for i in 0..40 {
            if i == 10 {
                m.pause(1);
            }
            if i == 20 {
                m.play(1);
            }
            if i == 30 {
                m.set_volume(1, 0.2);
            }
            let mut out = vec![0.0; 2 * 97];
            m.fill(&mut out);
            all.extend(out.chunks_exact(2).map(|f| f[0]));
        }
        let step = 1.0 / (RAMP_SEC * 48000.0) as f32;
        let worst = all.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
        assert!(worst <= step + 1e-6, "jump of {worst}, step {step}");
    }

    #[test]
    fn a_jump_fades_out_then_plays_the_new_place() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ramp(1, 0, 0, 1000, 1000));
        m.play(1);
        m.fill(&mut [0.0; 100]);
        m.take_events();
        m.begin_seek(1, 1, 0.5, 1);
        // The position says the target at once.
        assert_eq!(m.heard_position(1), Some((1, 0.5)));
        // Old epoch chunks are no longer counted as queued.
        assert_eq!(m.queued_frames(1), 0);
        // Chunks of the old epoch given late are ignored.
        m.push(1, ramp(1, 0, 1000, 100, 1000));
        m.push(1, ramp(1, 1, 500, 200, 1000));
        let mut out = vec![0.0; 40];
        m.fill(&mut out);
        // Fade out of frames 100..104, then the new place fades in.
        assert!((out[0] - 75.0).abs() < 1e-3, "{out:?}");
        let new_start = out.iter().position(|&s| s >= 500.0 * 0.2).unwrap();
        assert!(new_start <= 6, "{out:?}");
        assert_eq!(out[30], 500.0 + (30 - new_start) as f32);
        assert_eq!(m.take_events(), vec![MixEvent::Seeked { voice: 1, track: 1, epoch: 1, pos_sec: 0.5 }]);
    }

    #[test]
    fn a_jump_while_paused_is_done_when_the_new_place_is_decoded() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ramp(1, 0, 0, 1000, 1000));
        m.begin_seek(1, 1, 0.3, 1);
        assert!(m.take_events().is_empty());
        m.push(1, ramp(1, 1, 300, 100, 1000));
        assert_eq!(m.take_events(), vec![MixEvent::Seeked { voice: 1, track: 1, epoch: 1, pos_sec: 0.3 }]);
        m.play(1);
        let mut out = vec![0.0; 10];
        m.fill(&mut out);
        assert_eq!(out[9], 309.0);
    }

    #[test]
    fn an_empty_queue_fades_in_again_and_counts_the_gap() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ones(1, 0, 0.0, 20, 1));
        m.play(1);
        let mut out = vec![0.0; 30];
        m.fill(&mut out);
        assert_eq!(m.underruns(1), 10);
        m.push(1, ones(1, 0, 0.02, 20, 1));
        let mut out = vec![0.0; 10];
        m.fill(&mut out);
        assert!(out[0] < 0.5, "fades in after a gap: {out:?}");
    }

    #[test]
    fn ends_a_track_and_goes_on_with_the_next_without_a_gap() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ones(1, 0, 0.0, 50, 1));
        m.push(1, Chunk { track: 1, epoch: 0, start_sec: 0.05, samples: Vec::new(), last: true });
        m.push(1, ones(2, 0, 0.0, 50, 1));
        m.play(1);
        let mut out = vec![0.0; 80];
        m.fill(&mut out);
        // No dip at the change of track.
        assert!(out[10..80].iter().all(|&s| s == 1.0), "{out:?}");
        assert_eq!(
            m.take_events(),
            vec![MixEvent::Started { voice: 1, track: 1 }, MixEvent::Ended { voice: 1, track: 1 }, MixEvent::Started { voice: 1, track: 2 }]
        );
        assert_eq!(m.position(1), Some((2, 0.03)));
    }

    #[test]
    fn stops_at_the_end_of_the_last_track() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ones(1, 0, 0.0, 50, 1));
        m.push(1, Chunk { track: 1, epoch: 0, start_sec: 0.05, samples: Vec::new(), last: true });
        m.play(1);
        m.fill(&mut [0.0; 100]);
        assert_eq!(m.run_of(1), Some(Run::Ended));
        assert_eq!(m.underruns(1), 0);
        assert_eq!(m.take_events(), vec![MixEvent::Started { voice: 1, track: 1 }, MixEvent::Ended { voice: 1, track: 1 }]);
        // play() after the end needs a jump first (the engine sends one to 0).
        m.play(1);
        assert_eq!(m.run_of(1), Some(Run::Ended));
        m.begin_seek(1, 1, 0.0, 1);
        m.push(1, ones(1, 1, 0.0, 10, 1));
        m.play(1);
        let mut out = vec![0.0; 10];
        m.fill(&mut out);
        assert!(out[9] > 0.0);
    }

    #[test]
    fn mixes_two_voices_and_keeps_their_volumes() {
        let mut m = Mixer::new(1000, 2);
        m.add_voice(1, 1, 0.5, 0.0);
        m.add_voice(2, 1, 0.25, 0.0);
        m.push(1, ones(1, 0, 0.0, 100, 2));
        m.push(2, ones(1, 0, 0.0, 100, 2));
        m.play(1);
        m.play(2);
        let mut out = vec![0.0; 2 * 50];
        m.fill(&mut out);
        assert!((out[2 * 40] - 0.75).abs() < 1e-6);
        m.remove_voice(1);
        m.fill(&mut out);
        assert!((out[2 * 40] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn plays_on_silently_at_volume_zero() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 0.0, 0.0);
        m.push(1, ones(1, 0, 0.0, 100, 1));
        m.play(1);
        let mut out = vec![1.0; 50];
        m.fill(&mut out);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(m.position(1), Some((1, 0.05)));
    }

    #[test]
    fn a_new_format_drops_what_was_queued() {
        let mut m = Mixer::new(1000, 1);
        m.add_voice(1, 1, 1.0, 0.0);
        m.push(1, ones(1, 0, 0.0, 100, 1));
        m.set_format(48000, 2);
        assert_eq!(m.queued_frames(1), 0);
        assert_eq!((m.rate, m.channels), (48000, 2));
    }
}
