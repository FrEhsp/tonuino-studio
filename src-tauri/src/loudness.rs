//! ITU-R BS.1770-4 loudness: K-weighting, 10 ms power windows and gated
//! integrated loudness (EBU R128).
//!
//! The filter coefficients are derived for the actual sample rate from the
//! analogue prototypes (same derivation as libebur128), so 44.1 kHz files are
//! measured as precisely as 48 kHz ones.

use std::collections::VecDeque;
use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BiquadState {
    z1: f64,
    z2: f64,
}

impl Biquad {
    /// Transposed direct form II.
    #[inline]
    pub fn process(&self, s: &mut BiquadState, x: f64) -> f64 {
        let y = self.b0 * x + s.z1;
        s.z1 = self.b1 * x - self.a1 * y + s.z2;
        s.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Stage 1 (high-shelf "pre-filter") and stage 2 (RLB high-pass) of the K-weighting.
pub fn k_weighting(sample_rate: f64) -> (Biquad, Biquad) {
    // High shelf, +4 dB above ~1.7 kHz.
    let f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (PI * f0 / sample_rate).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2.0 * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
    };
    // RLB high-pass at ~38 Hz. BS.1770 specifies the numerator as 1, -2, 1.
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (PI * f0 / sample_rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let highpass = Biquad {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
    };
    (shelf, highpass)
}

/// Loudness of a mean-square power value.
pub fn lufs_of_power(power: f64) -> f64 {
    -0.691 + 10.0 * power.log10()
}

/// Gated integrated loudness from the powers of 400 ms blocks (75 % overlap):
/// absolute gate −70 LUFS, relative gate −10 LU. None for silence.
pub fn integrated_lufs(block_powers: &[f64]) -> Option<f64> {
    let abs_gate = 10f64.powf((-70.0 + 0.691) / 10.0);
    let (sum, n) = block_powers
        .iter()
        .filter(|p| **p > abs_gate)
        .fold((0.0, 0usize), |(s, n), p| (s + p, n + 1));
    if n == 0 {
        return None;
    }
    let rel_gate = (sum / n as f64) * 0.1; // −10 LU
    let (sum, n) = block_powers
        .iter()
        .filter(|p| **p > abs_gate && **p > rel_gate)
        .fold((0.0, 0usize), |(s, n), p| (s + p, n + 1));
    (n > 0).then(|| lufs_of_power(sum / n as f64))
}

/// Channel weights G_i of BS.1770: 1.0 for L, R, C; 1.41 for surround; 0 for LFE.
pub fn channel_weights(channels: Option<symphonia::core::audio::Channels>, count: usize) -> Vec<f64> {
    use symphonia::core::audio::Channels as C;
    match channels {
        Some(ch) if ch.count() == count => ch
            .iter()
            .map(|c| {
                if c == C::LFE1 || c == C::LFE2 {
                    0.0
                } else if c == C::REAR_LEFT || c == C::REAR_RIGHT || c == C::SIDE_LEFT || c == C::SIDE_RIGHT {
                    1.41
                } else {
                    1.0
                }
            })
            .collect(),
        _ => vec![1.0; count],
    }
}

/// Counts flat tops: three or more equal samples in a row, entered or left
/// with a jump. A file that was turned up too far before it was saved
/// (clipping) has them at its loudest level, again and again; music that is
/// merely loud does not. Lossy files smear the flat tops, so this finds
/// clipping in lossless files (WAV, FLAC). Same rules as ClipCounter in
/// src/core/audio/loudness.ts, so both apps say the same.
pub struct ClipCounter {
    prev: Vec<f32>,
    /// Jump into the run of equal samples that ends at `prev`.
    entry: Vec<f32>,
    run: Vec<u32>,
    bins: [u64; ClipCounter::BINS],
}

impl ClipCounter {
    /// Neighbouring samples this close count as the same value (half a step of 16-bit audio).
    const SAME: f32 = 1.0 / 65536.0;
    /// Equal samples in a row that make a flat top.
    const RUN: u32 = 3;
    /// A cut-off top starts or ends with a jump at least this big; the top of a deep bass tone reaches it gently.
    const EDGE: f32 = 1e-3;
    /// Flat tops count from this level (-12 dBFS); which level was cut off is decided at the end.
    const FLOOR: f32 = 0.25;
    const BIN_DB: f64 = 0.1;
    const BINS: usize = 180; // -12 .. +6 dBFS
    /// Flat tops this close under the loudest sample are at the level where the file was cut off.
    const NEAR_PEAK_DB: f64 = 0.3;

    pub fn new(channels: usize) -> Self {
        ClipCounter { prev: vec![0.0; channels], entry: vec![0.0; channels], run: vec![0; channels], bins: [0; Self::BINS] }
    }

    #[inline]
    pub fn push(&mut self, c: usize, v: f32) {
        let jump = (v - self.prev[c]).abs();
        if jump <= Self::SAME {
            self.run[c] += 1;
        } else {
            if self.run[c] >= Self::RUN && (self.entry[c] >= Self::EDGE || jump >= Self::EDGE) {
                self.add(self.prev[c]);
            }
            self.entry[c] = jump;
            self.run[c] = 1;
        }
        self.prev[c] = v;
    }

    fn add(&mut self, level: f32) {
        let a = level.abs();
        if a < Self::FLOOR {
            return;
        }
        let bin = ((20.0 * (a as f64).log10() + 12.0) / Self::BIN_DB).floor() as usize;
        self.bins[bin.min(Self::BINS - 1)] += 1;
    }

    /// Flat tops at the file's loudest level (`peak`, 1.0 = full scale), counted per channel.
    pub fn count(&mut self, peak: f32) -> u64 {
        for c in 0..self.prev.len() {
            // A flat top at the very end of the file.
            if self.run[c] >= Self::RUN && self.entry[c] >= Self::EDGE {
                self.add(self.prev[c]);
            }
            self.run[c] = 0;
        }
        if !(peak >= Self::FLOOR) {
            return 0;
        }
        let from = ((20.0 * (peak as f64).log10() - Self::NEAR_PEAK_DB + 12.0) / Self::BIN_DB).floor().max(0.0) as usize;
        self.bins[from.min(Self::BINS)..].iter().sum()
    }
}

/// Streaming analyser: feed interleaved samples, get one power value per
/// 10 ms window and the integrated loudness.
pub struct LoudnessMeter {
    sample_rate: u64,
    channels: usize,
    weights: Vec<f64>,
    shelf: Biquad,
    highpass: Biquad,
    states: Vec<(BiquadState, BiquadState)>,
    frames: u64,
    /// Windows completed so far.
    windows: u64,
    /// Frame index (exclusive) where the current window ends. Window k spans
    /// [k·fs/100, (k+1)·fs/100), so windows average exactly 10 ms at any rate.
    window_end: u64,
    acc: f64,
    acc_frames: u64,
    pub power: Vec<f32>,
    recent: VecDeque<(f64, u64)>,
    blocks: Vec<f64>,
    /// Largest absolute sample value so far.
    peak: f32,
    clips: ClipCounter,
}

impl LoudnessMeter {
    pub fn new(sample_rate: u32, weights: Vec<f64>) -> Self {
        let channels = weights.len().max(1);
        let (shelf, highpass) = k_weighting(sample_rate as f64);
        LoudnessMeter {
            sample_rate: sample_rate.max(1) as u64,
            channels,
            weights,
            shelf,
            highpass,
            states: vec![(BiquadState::default(), BiquadState::default()); channels],
            frames: 0,
            windows: 0,
            window_end: (sample_rate.max(1) as u64) / 100,
            acc: 0.0,
            acc_frames: 0,
            power: Vec::new(),
            recent: VecDeque::with_capacity(41),
            blocks: Vec::new(),
            peak: 0.0,
            clips: ClipCounter::new(channels),
        }
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Largest absolute sample value pushed so far (1.0 = full scale).
    pub fn peak(&self) -> f32 {
        self.peak
    }

    /// Flat tops at the loudest level (see ClipCounter); call after the last push.
    pub fn clips(&mut self) -> u64 {
        self.clips.count(self.peak)
    }

    pub fn push_interleaved(&mut self, samples: &[f32]) {
        for frame in samples.chunks_exact(self.channels) {
            let mut energy = 0.0;
            for (c, ((x, (s1, s2)), w)) in frame.iter().zip(self.states.iter_mut()).zip(&self.weights).enumerate() {
                let a = x.abs();
                if a > self.peak {
                    self.peak = a;
                }
                self.clips.push(c, *x);
                let y = self.highpass.process(s2, self.shelf.process(s1, *x as f64));
                energy += w * y * y;
            }
            self.acc += energy;
            self.acc_frames += 1;
            self.frames += 1;
            if self.frames >= self.window_end {
                self.close_window(true);
            }
        }
    }

    fn close_window(&mut self, complete: bool) {
        let p = if self.acc_frames > 0 { self.acc / self.acc_frames as f64 } else { 0.0 };
        self.power.push(p as f32);
        self.windows += 1;
        if complete {
            self.recent.push_back((self.acc, self.acc_frames));
            if self.recent.len() > 40 {
                self.recent.pop_front();
            }
            // A 400 ms block ends every 100 ms once 40 windows exist.
            if self.recent.len() == 40 && self.windows % 10 == 0 {
                let (sum, n) = self.recent.iter().fold((0.0, 0u64), |(s, n), (a, b)| (s + a, n + b));
                if n > 0 {
                    self.blocks.push(sum / n as f64);
                }
            }
        }
        self.acc = 0.0;
        self.acc_frames = 0;
        self.window_end = (self.windows + 1) * self.sample_rate / 100;
    }

    /// Flushes the last, partial window (it does not form a gating block).
    pub fn finish(&mut self) {
        if self.acc_frames > 0 {
            self.close_window(false);
        }
    }

    pub fn integrated(&self) -> Option<f64> {
        integrated_lufs(&self.blocks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_stereo(rate: u32, freq: f64, dbfs: f64, seconds: f64) -> Vec<f32> {
        let amp = 10f64.powf(dbfs / 20.0);
        let n = (rate as f64 * seconds) as usize;
        let mut out = Vec::with_capacity(n * 2);
        for i in 0..n {
            let v = (amp * (2.0 * PI * freq * i as f64 / rate as f64).sin()) as f32;
            out.push(v);
            out.push(v);
        }
        out
    }

    fn measure(rate: u32, samples: &[f32]) -> (LoudnessMeter, f64) {
        let mut m = LoudnessMeter::new(rate, vec![1.0, 1.0]);
        // Feed in odd-sized pieces to exercise the streaming path.
        for chunk in samples.chunks(2 * 1237) {
            m.push_interleaved(chunk);
        }
        m.finish();
        let l = m.integrated().unwrap();
        (m, l)
    }

    #[test]
    fn coefficients_at_48k_match_the_standard() {
        let (s, h) = k_weighting(48000.0);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-8;
        assert!(close(s.b0, 1.53512485958697));
        assert!(close(s.b1, -2.69169618940638));
        assert!(close(s.b2, 1.19839281085285));
        assert!(close(s.a1, -1.69065929318241));
        assert!(close(s.a2, 0.73248077421585));
        assert!(close(h.a1, -1.99004745483398));
        assert!(close(h.a2, 0.99007225036621));
    }

    #[test]
    fn sine_minus_23_dbfs_reads_minus_23_lufs_at_44k1_and_48k() {
        for rate in [44100, 48000] {
            let (m, l) = measure(rate, &sine_stereo(rate, 1000.0, -23.0, 20.0));
            assert!((l - -23.0).abs() <= 0.1, "{rate} Hz: {l}");
            assert_eq!(m.power.len(), 2000, "one window per 10 ms");
            // Momentary loudness of a window in the middle.
            let w = lufs_of_power(m.power[1000] as f64);
            assert!((w - -23.0).abs() < 0.1, "{rate} Hz window: {w}");
        }
    }

    #[test]
    fn non_integer_window_lengths_still_average_10ms() {
        // 22.05 kHz: windows alternate 220/221 frames.
        let (m, l) = measure(22050, &sine_stereo(22050, 1000.0, -23.0, 10.0));
        assert_eq!(m.power.len(), 1000);
        assert!((l - -23.0).abs() <= 0.15, "{l}");
    }

    #[test]
    fn gates_silence_and_quiet_parts() {
        let rate = 48000;
        let mut s = sine_stereo(rate, 1000.0, -23.0, 10.0);
        s.extend(std::iter::repeat(0.0).take(rate as usize * 2 * 10));
        let (_, l) = measure(rate, &s);
        assert!((l - -23.0).abs() <= 0.1, "absolute gate: {l}");

        let mut s = sine_stereo(rate, 1000.0, -20.0, 10.0);
        s.extend(sine_stereo(rate, 1000.0, -40.0, 10.0));
        let (_, l) = measure(rate, &s);
        assert!((l - -20.0).abs() <= 0.1, "relative gate: {l}");

        let mut m = LoudnessMeter::new(rate, vec![1.0, 1.0]);
        m.push_interleaved(&vec![0.0; 96000]);
        m.finish();
        assert_eq!(m.integrated(), None);
    }

    #[test]
    fn counts_cut_off_tops_but_not_loud_or_deep_tones() {
        let rate = 44100;
        let clips = |samples: &[f32]| {
            let mut m = LoudnessMeter::new(rate, vec![1.0, 1.0]);
            m.push_interleaved(samples);
            m.finish();
            m.clips()
        };
        // 220 Hz driven 6 dB over full scale and cut off there: a flat top every half wave, on both channels.
        let clipped: Vec<f32> = sine_stereo(rate, 220.0, 6.0, 2.0).iter().map(|v| v.clamp(-1.0, 1.0)).collect();
        assert!((1700..=1800).contains(&clips(&clipped)), "{}", clips(&clipped));
        // The same, turned down 6 dB afterwards: still cut off, at its own loudest level.
        let down: Vec<f32> = clipped.iter().map(|v| v * 0.5).collect();
        assert_eq!(clips(&down), clips(&clipped));
        // A loud tone and a deep tone at full scale, saved with 16 bits: their tops are not cut off.
        let q = |v: &f32| (v * 32767.0).round() / 32767.0;
        assert_eq!(clips(&sine_stereo(rate, 1000.0, -0.01, 2.0).iter().map(q).collect::<Vec<_>>()), 0);
        assert_eq!(clips(&sine_stereo(rate, 25.0, -0.01, 2.0).iter().map(q).collect::<Vec<_>>()), 0);
    }

    #[test]
    fn mono_counts_once_and_lfe_not_at_all() {
        use symphonia::core::audio::Channels as C;
        assert_eq!(channel_weights(Some(C::FRONT_LEFT | C::FRONT_RIGHT), 2), vec![1.0, 1.0]);
        let w = channel_weights(Some(C::FRONT_LEFT | C::FRONT_RIGHT | C::FRONT_CENTRE | C::LFE1 | C::REAR_LEFT | C::REAR_RIGHT), 6);
        assert_eq!(w, vec![1.0, 1.0, 1.0, 0.0, 1.41, 1.41]);
        assert_eq!(channel_weights(None, 1), vec![1.0]);
        // Mono sine at -23 dBFS: one channel → 3 dB quieter than the stereo case.
        let rate = 48000;
        let stereo = sine_stereo(rate, 1000.0, -23.0, 10.0);
        let mono: Vec<f32> = stereo.chunks(2).map(|c| c[0]).collect();
        let mut m = LoudnessMeter::new(rate, vec![1.0]);
        m.push_interleaved(&mono);
        m.finish();
        assert!((m.integrated().unwrap() - -26.01).abs() < 0.1);
    }
}
