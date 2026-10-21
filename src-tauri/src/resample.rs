//! Streaming sample-rate converter: Kaiser-windowed sinc, polyphase table
//! with linear interpolation between phases (works for any rate pair).
//!
//! Output sample n sits at input position n·in/out (exact rational
//! bookkeeping, no drift). Stopband attenuation is about 80 dB, the passband
//! reaches 94 % of the lower Nyquist frequency.

const PHASES: usize = 256;
const ZERO_CROSSINGS: f64 = 24.0;
const ROLLOFF: f64 = 0.94;
const KAISER_BETA: f64 = 8.0;

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// Modified Bessel function of the first kind, order 0.
fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..64 {
        term *= q / (k as f64 * k as f64);
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

pub struct Resampler {
    channels: usize,
    /// Input frames advanced per output frame = step_num / step_den.
    step_num: u64,
    step_den: u64,
    taps: usize,
    /// (PHASES + 1) rows of `taps` coefficients.
    table: Vec<f32>,
    /// Interleaved input; `buf[0]` is input frame `buf_start`.
    buf: Vec<f32>,
    buf_start: i64,
    /// Next output position: pos_int + pos_rem / step_den input frames.
    pos_int: i64,
    pos_rem: u64,
    input_frames: i64,
    outputs: u64,
    finished: bool,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Self {
        let g = gcd(in_rate as u64, out_rate as u64).max(1);
        let step_num = in_rate as u64 / g;
        let step_den = out_rate as u64 / g;
        // Cutoff relative to the input Nyquist frequency.
        let ratio = (out_rate as f64 / in_rate as f64).min(1.0);
        let fc = ratio * ROLLOFF;
        let half = (ZERO_CROSSINGS / fc).ceil() as usize;
        let taps = 2 * half;
        let mut table = vec![0f32; (PHASES + 1) * taps];
        let i0_beta = bessel_i0(KAISER_BETA);
        for p in 0..=PHASES {
            let frac = p as f64 / PHASES as f64;
            let row = &mut table[p * taps..(p + 1) * taps];
            let mut sum = 0.0;
            let mut coeffs = vec![0f64; taps];
            for (j, c) in coeffs.iter_mut().enumerate() {
                // Tap j multiplies input frame floor(t) + j - (half - 1).
                let d = j as f64 - (half as f64 - 1.0) - frac;
                let x = d / half as f64;
                if x.abs() >= 1.0 {
                    continue;
                }
                let w = bessel_i0(KAISER_BETA * (1.0 - x * x).sqrt()) / i0_beta;
                let arg = std::f64::consts::PI * fc * d;
                let sinc = if arg.abs() < 1e-12 { 1.0 } else { arg.sin() / arg };
                *c = fc * sinc * w;
                sum += *c;
            }
            for (dst, c) in row.iter_mut().zip(&coeffs) {
                *dst = (c / sum) as f32;
            }
        }
        // Prime the history with zeros so output 0 lines up with input 0.
        let pre = half as i64;
        Resampler {
            channels: channels.max(1),
            step_num,
            step_den,
            taps,
            table,
            buf: vec![0.0; pre as usize * channels.max(1)],
            buf_start: -pre,
            pos_int: 0,
            pos_rem: 0,
            input_frames: 0,
            outputs: 0,
            finished: false,
        }
    }

    fn half(&self) -> i64 {
        (self.taps / 2) as i64
    }

    /// Number of output frames `input_frames` input frames turn into.
    pub fn expected_outputs(&self, input_frames: u64) -> u64 {
        (input_frames * self.step_den).div_ceil(self.step_num)
    }

    /// Feeds interleaved input and appends all outputs that are ready.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.buf.extend_from_slice(input);
        self.input_frames += (input.len() / self.channels) as i64;
        self.produce(out, false);
    }

    /// Flushes the tail: appends the remaining outputs (zeros assumed after the end).
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        if self.finished {
            return;
        }
        self.finished = true;
        let pad = (self.half() + 1) as usize * self.channels;
        self.buf.extend(std::iter::repeat(0.0).take(pad));
        self.produce(out, true);
    }

    fn produce(&mut self, out: &mut Vec<f32>, flushing: bool) {
        let half = self.half();
        let ch = self.channels;
        let buffered_end = self.buf_start + (self.buf.len() / ch) as i64;
        let total = self.expected_outputs(self.input_frames.max(0) as u64);
        loop {
            if flushing && self.outputs >= total {
                break;
            }
            // Frames needed: pos_int - (half - 1) ..= pos_int + half.
            let last_needed = self.pos_int + half;
            if last_needed >= buffered_end || (!flushing && last_needed >= self.input_frames) {
                break;
            }
            let first = (self.pos_int - (half - 1) - self.buf_start) as usize;
            let f = self.pos_rem as f64 / self.step_den as f64 * PHASES as f64;
            let p = (f as usize).min(PHASES - 1);
            let a = (f - p as f64) as f32;
            let row0 = &self.table[p * self.taps..(p + 1) * self.taps];
            let row1 = &self.table[(p + 1) * self.taps..(p + 2) * self.taps];
            for c in 0..ch {
                let mut s0 = 0f32;
                let mut s1 = 0f32;
                let mut idx = first * ch + c;
                for j in 0..self.taps {
                    let x = self.buf[idx];
                    s0 += row0[j] * x;
                    s1 += row1[j] * x;
                    idx += ch;
                }
                out.push(s0 + a * (s1 - s0));
            }
            self.outputs += 1;
            self.pos_rem += self.step_num;
            self.pos_int += (self.pos_rem / self.step_den) as i64;
            self.pos_rem %= self.step_den;
        }
        // Drop history that no future output needs.
        let keep_from = self.pos_int - (half - 1);
        let drop_frames = (keep_from - self.buf_start).max(0) as usize;
        let drop_frames = drop_frames.min(self.buf.len() / ch);
        if drop_frames > 0 {
            self.buf.drain(..drop_frames * ch);
            self.buf_start += drop_frames as i64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn sine(rate: u32, freq: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (0.5 * (2.0 * PI * freq * i as f64 / rate as f64).sin()) as f32).collect()
    }

    fn run(r: &mut Resampler, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for c in input.chunks(chunk) {
            r.process(c, &mut out);
        }
        r.finish(&mut out);
        out
    }

    #[test]
    fn upsamples_44k1_to_48k_accurately() {
        let input = sine(44100, 1000.0, 44100);
        let mut r = Resampler::new(44100, 48000, 1);
        let out = run(&mut r, &input, 4096);
        assert_eq!(out.len(), 48000);
        let expected = sine(48000, 1000.0, 48000);
        let max_err = out[200..47800]
            .iter()
            .zip(&expected[200..47800])
            .map(|(a, b)| (a - b).abs())
            .fold(0f32, f32::max);
        assert!(max_err < 2e-4, "max error {max_err}");
    }

    #[test]
    fn downsamples_and_rejects_aliases() {
        // 1 kHz passes 48k → 22.05k unchanged...
        let mut r = Resampler::new(48000, 22050, 1);
        let out = run(&mut r, &sine(48000, 1000.0, 48000), 1000);
        assert_eq!(out.len(), 22050);
        let expected = sine(22050, 1000.0, 22050);
        let max_err = out[200..21800].iter().zip(&expected[200..21800]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(max_err < 2e-4, "max error {max_err}");
        // ...while 15 kHz (above the new Nyquist of 11.025 kHz) is removed.
        let mut r = Resampler::new(48000, 22050, 1);
        let out = run(&mut r, &sine(48000, 15000.0, 48000), 1000);
        let rms = (out[500..21500].iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / 21000.0).sqrt();
        assert!(rms < 0.5 * 1e-3, "alias rms {rms}"); // > 60 dB below the 0.35 rms input
    }

    #[test]
    fn chunking_does_not_change_the_result_and_channels_stay_apart() {
        let left = sine(32000, 440.0, 10000);
        let right = sine(32000, 3000.0, 10000);
        let stereo: Vec<f32> = left.iter().zip(&right).flat_map(|(l, r)| [*l, *r]).collect();
        let a = run(&mut Resampler::new(32000, 44100, 2), &stereo, 2 * 10000);
        let b = run(&mut Resampler::new(32000, 44100, 2), &stereo, 2 * 333);
        assert_eq!(a, b);
        let mono = run(&mut Resampler::new(32000, 44100, 1), &right, 777);
        let right_out: Vec<f32> = a.chunks(2).map(|c| c[1]).collect();
        assert_eq!(right_out, mono);
    }

    #[test]
    fn dc_gain_is_one_and_lengths_add_up() {
        let mut r = Resampler::new(11025, 48000, 1);
        let out = run(&mut r, &vec![0.25; 11025], 500);
        assert_eq!(out.len(), 48000);
        assert!(out[1000..47000].iter().all(|v| (v - 0.25).abs() < 1e-4));
        let r = Resampler::new(44100, 48001, 1);
        assert_eq!(r.expected_outputs(44100), 48001);
    }
}
