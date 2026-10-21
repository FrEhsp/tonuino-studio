//! Audio decoding with symphonia: loudness/pause analysis and streamed PCM.
//!
//! Everything streams packet by packet; a 10-hour M4B is never held in
//! memory. Only the analysis result (one f32 per 10 ms, 1.4 MB per hour)
//! is kept.

use crate::access::Access;
use crate::chapters::{self, Chapter};
use crate::error::{blocking, CmdError, CmdResult};
use crate::framing::frame;
use crate::loudness::{channel_weights, LoudnessMeter};
use crate::resample::Resampler;
use crate::util::CancelFlags;
use crate::SharedState;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use symphonia::core::audio::{Channels, SampleBuffer, SignalSpec};
use symphonia::core::codecs::{CodecParameters, Decoder, DecoderOptions, CODEC_TYPE_MP1, CODEC_TYPE_MP2, CODEC_TYPE_MP3, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, Packet};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::{MetadataOptions, MetadataRevision};
use symphonia::core::probe::Hint;
use symphonia::core::units::TimeBase;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

pub const EVENT_AUDIO_PROGRESS: &str = "audio-progress";

/* ------------------------------------------------------------- source */

/// A file that reports how far the demuxer has read (for progress).
struct ProgressFile {
    file: File,
    offset: u64,
    position: Arc<AtomicU64>,
    len: u64,
}

impl Read for ProgressFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        self.offset += n as u64;
        self.position.store(self.offset, Ordering::Relaxed);
        Ok(n)
    }
}

impl Seek for ProgressFile {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.offset = self.file.seek(pos)?;
        self.position.store(self.offset, Ordering::Relaxed);
        Ok(self.offset)
    }
}

impl MediaSource for ProgressFile {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

fn map_sym(e: SymError, path: &Path) -> CmdError {
    match e {
        SymError::IoError(io) => CmdError::io(&io, path.display()),
        SymError::Unsupported(what) => CmdError::new("unsupported-format", format!("{}: {what}", path.display())),
        SymError::DecodeError(what) => CmdError::new("decode-failed", format!("{}: {what}", path.display())),
        other => CmdError::new("decode-failed", format!("{}: {other}", path.display())),
    }
}

/// Containers symphonia has no reader for. Its probe would search them for
/// MPEG sync words and may take random bytes for an MP3 (a long WebM came
/// out as two seconds of silence), or run to their end.
fn foreign_container(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("WebM/Matroska")
    } else if head.starts_with(&[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]) {
        Some("WMA/ASF")
    } else if head.starts_with(b"caff") {
        Some("CAF")
    } else {
        None
    }
}

/// A probe that ran out of data: a file in a container symphonia reads was
/// cut short, anything else is a format the app does not know. Neither is a
/// read error of the disk.
fn probe_error(e: SymError, path: &Path, head: &[u8]) -> CmdError {
    match e {
        SymError::IoError(io) if io.kind() == std::io::ErrorKind::UnexpectedEof => {
            let known = head.get(4..8) == Some(b"ftyp") || [b"OggS", b"fLaC", b"RIFF", b"FORM"].iter().any(|m| head.starts_with(*m));
            CmdError::new(if known { "decode-failed" } else { "unsupported-format" }, format!("{}: {io}", path.display()))
        }
        e => map_sym(e, path),
    }
}

/// Symphonia skips copy protected tracks ("no audio track"): say why, like the browser.
pub fn protected_or(e: CmdError, path: &Path) -> CmdError {
    if e.code == "unsupported-format" && chapters::mp4_is_protected(path) {
        CmdError::new("drm-protected", format!("{}: copy protected", path.display()))
    } else {
        e
    }
}

/// The playing time of a chained Ogg file, where whole streams follow one
/// another (`cat a.ogg b.ogg`); its container tells the first stream only.
/// Adds up the first audio stream of each link, like the browser. None for
/// other files and for a file of one link; only chains are read page by page.
fn ogg_chain_sec(path: &Path) -> Option<f64> {
    let mut f = File::open(path).ok()?;
    let serial = |h: &[u8]| u32::from_le_bytes([h[14], h[15], h[16], h[17]]);
    let mut h = [0u8; 27];
    f.read_exact(&mut h).ok()?;
    if &h[..4] != b"OggS" {
        return None;
    }
    // A chain ends with another stream than it starts with.
    let first = serial(&h);
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(1 << 16))).ok()?;
    let mut tail = Vec::new();
    f.read_to_end(&mut tail).ok()?;
    let last = tail.windows(4).rposition(|w| w == b"OggS").filter(|&p| p + 27 <= tail.len())?;
    if serial(&tail[last..]) == first {
        return None;
    }
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut f = std::io::BufReader::new(f);
    // Per link: (serial, granule rate, samples skipped at the start, last granule position).
    let mut audio: Vec<(u32, f64, u64, i64)> = Vec::new();
    let (mut links, mut opening) = (0usize, false);
    let mut lacing = [0u8; 255];
    while f.read_exact(&mut h).is_ok() && &h[..4] == b"OggS" {
        let lacing = &mut lacing[..usize::from(h[26])];
        f.read_exact(lacing).ok()?;
        let body: i64 = lacing.iter().map(|&l| i64::from(l)).sum();
        let mut id = Vec::new();
        if h[5] & 0x02 != 0 {
            // The first pages of a link start its streams.
            if !opening {
                links += 1;
            }
            opening = true;
            id.resize(body.min(64) as usize, 0);
            f.read_exact(&mut id).ok()?;
            if audio.len() < links {
                if let Some((rate, skip)) = ogg_clock(&id) {
                    audio.push((serial(&h), rate, skip, -1));
                }
            }
        } else {
            opening = false;
        }
        f.seek_relative(body - id.len() as i64).ok()?;
        let granule = i64::from_le_bytes([h[6], h[7], h[8], h[9], h[10], h[11], h[12], h[13]]);
        if let Some(a) = audio.last_mut().filter(|a| a.0 == serial(&h) && granule >= 0) {
            a.3 = granule;
        }
    }
    (links > 1).then(|| audio.iter().filter(|a| a.3 > 0 && a.1 > 0.0).map(|a| (a.3 as u64).saturating_sub(a.2) as f64 / a.1).sum())
}

/// Granule rate and samples to skip, from the first header packet of an Ogg audio stream.
fn ogg_clock(id: &[u8]) -> Option<(f64, u64)> {
    if id.starts_with(b"OpusHead") && id.len() >= 12 {
        Some((48000.0, u64::from(u16::from_le_bytes([id[10], id[11]]))))
    } else if id.starts_with(b"\x01vorbis") && id.len() >= 16 {
        Some((f64::from(u32::from_le_bytes([id[12], id[13], id[14], id[15]])), 0))
    } else if id.starts_with(b"\x7fFLAC") && id.len() >= 30 {
        // STREAMINFO from byte 17: the sample rate in the 20 bits at its byte 10.
        Some((f64::from((u32::from(id[27]) << 12) | (u32::from(id[28]) << 4) | (u32::from(id[29]) >> 4)), 0))
    } else {
        None
    }
}

fn collect_tags(rev: Option<&MetadataRevision>, out: &mut Vec<(String, String)>) {
    if let Some(rev) = rev {
        for tag in rev.tags() {
            out.push((tag.key.clone(), tag.value.to_string()));
        }
    }
}

/// How the player opens a file (see src/player): the analysis and the PCM
/// stream use the defaults.
#[derive(Debug, Clone, Copy)]
pub struct OpenOptions {
    /// Leave out the encoder's delay and padding (MP3 with a LAME frame).
    pub gapless: bool,
    /// Frames added to every packet's time stamp: the place of the first
    /// byte when only a window of an MP3 file is read (after a jump).
    pub ts_shift: i64,
    /// Decoded frames before this place are dropped, so the first block
    /// starts exactly there.
    pub skip_until: Option<i64>,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions { gapless: true, ts_shift: 0, skip_until: None }
    }
}

/// An open, decoding audio file with a fixed output rate and channel count:
/// those of its first decoded block.
pub struct Source {
    path: PathBuf,
    /// `path` is a file on disk (not only the name of data in memory).
    on_disk: bool,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    params: CodecParameters,
    track_id: u32,
    /// MPEG audio: its decoder keeps the format of the first frame.
    mpeg: bool,
    pub sample_rate: u32,
    pub channels: usize,
    pub channel_layout: Option<Channels>,
    pub n_frames: Option<u64>,
    time_base: Option<TimeBase>,
    pub codec: String,
    pub packet_bytes: u64,
    pub byte_len: u64,
    position: Arc<AtomicU64>,
    tags: Vec<(String, String)>,
    sample_buf: Option<(SignalSpec, usize, SampleBuffer<f32>)>,
    /// Converts blocks in another sample rate (an MP3 part joined on, the
    /// next stream of a chained Ogg file) to `sample_rate`: (their rate, converter).
    rate_fix: Option<(u32, Resampler)>,
    /// Decoded samples held back while opening (to learn the format).
    pending: Vec<f32>,
    ended: bool,
    ts_shift: i64,
    skip_until: Option<i64>,
}

impl Source {
    pub fn open(path: &Path) -> CmdResult<Source> {
        Self::open_file(path).map_err(|e| protected_or(e, path))
    }

    /// The encoder's delay and padding in frames (MP3 with a LAME frame), as the container says.
    pub fn delay_padding(&self) -> (u32, u32) {
        (self.params.delay.unwrap_or(0), self.params.padding.unwrap_or(0))
    }

    /// MPEG audio (MP1, MP2, MP3), read by symphonia's MPEG reader.
    pub fn is_mpeg(&self) -> bool {
        self.mpeg
    }

    /// Jumps to `sec` with symphonia's own exact seek: the next block starts
    /// right there. For MP3 the player has a quicker way (src/player).
    pub fn seek(&mut self, sec: f64) -> CmdResult<()> {
        use symphonia::core::formats::{SeekMode, SeekTo};
        use symphonia::core::units::Time;
        let sec = sec.max(0.0);
        let to = SeekTo::Time { time: Time::new(sec.trunc() as u64, sec.fract()), track_id: Some(self.track_id) };
        match self.format.seek(SeekMode::Accurate, to) {
            Ok(_) => {}
            // Past the end: nothing more to play.
            Err(SymError::SeekError(_)) | Err(SymError::IoError(_)) => {
                self.pending.clear();
                self.ended = true;
                return Ok(());
            }
            Err(e) => return Err(map_sym(e, &self.path)),
        }
        self.decoder.reset();
        self.pending.clear();
        self.ended = false;
        self.rate_fix = None;
        self.skip_until = Some((sec * f64::from(self.sample_rate)).round() as i64);
        Ok(())
    }

    /// Frame of the decoded stream where a packet starts.
    fn packet_frame(&self, ts: u64) -> i64 {
        let rate = i64::from(self.sample_rate.max(1));
        let shifted = match self.time_base {
            Some(tb) if !(tb.numer == 1 && i64::from(tb.denom) == rate) && tb.denom > 0 => {
                (ts as f64 * f64::from(tb.numer) / f64::from(tb.denom) * rate as f64).round() as i64
            }
            _ => ts as i64,
        };
        shifted + self.ts_shift
    }

    fn open_file(path: &Path) -> CmdResult<Source> {
        let mut file = File::open(path).map_err(|e| CmdError::io(&e, path.display()))?;
        let byte_len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut head = Vec::with_capacity(12);
        file.by_ref().take(12).read_to_end(&mut head).map_err(|e| CmdError::io(&e, path.display()))?;
        file.seek(SeekFrom::Start(0)).map_err(|e| CmdError::io(&e, path.display()))?;
        let position = Arc::new(AtomicU64::new(0));
        let source = ProgressFile { file, offset: 0, position: position.clone(), len: byte_len };
        Self::open_media(Box::new(source), path, true, &head, position, OpenOptions::default())
    }

    /// Opens any readable bytes: a file, a window of one, or data in memory.
    /// `name` gives the type (its extension) and the name in messages;
    /// `head` is the first bytes, `on_disk` says whether `name` is a file
    /// that may be read again (for Ogg chains and copy protection).
    pub fn open_media(media: Box<dyn MediaSource>, name: &Path, on_disk: bool, head: &[u8], position: Arc<AtomicU64>, opts: OpenOptions) -> CmdResult<Source> {
        let path = name;
        let byte_len = media.byte_len().unwrap_or(0);
        if let Some(kind) = foreign_container(head) {
            return Err(CmdError::new("unsupported-format", format!("{}: {kind}", path.display())));
        }
        let mss = MediaSourceStream::new(media, Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let format_opts = FormatOptions { enable_gapless: opts.gapless, ..Default::default() };
        let mut probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &MetadataOptions::default())
            .map_err(|e| probe_error(e, path, head))?;
        let mut tags = Vec::new();
        if let Some(mut meta) = probed.metadata.get() {
            collect_tags(meta.skip_to_latest(), &mut tags);
        }
        collect_tags(probed.format.metadata().current(), &mut tags);
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| CmdError::new("unsupported-format", format!("{}: no audio track", path.display())))?;
        let params = track.codec_params.clone();
        let track_id = track.id;
        let codec = symphonia::default::get_codecs()
            .get_codec(params.codec)
            .map(|d| d.short_name.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| map_sym(e, path))?;
        let mut src = Source {
            path: path.to_path_buf(),
            on_disk,
            format,
            decoder,
            mpeg: matches!(params.codec, CODEC_TYPE_MP1 | CODEC_TYPE_MP2 | CODEC_TYPE_MP3),
            n_frames: params.n_frames,
            time_base: params.time_base,
            params,
            track_id,
            // From the first decoded block, not the container: an HE-AAC file
            // says 44.1 kHz and decodes at 22.05 kHz (symphonia has no SBR).
            sample_rate: 0,
            channels: 0,
            channel_layout: None,
            codec: normalize_codec(&codec),
            packet_bytes: 0,
            byte_len,
            position,
            tags,
            sample_buf: None,
            rate_fix: None,
            pending: Vec::new(),
            ended: false,
            ts_shift: opts.ts_shift,
            skip_until: opts.skip_until,
        };
        // Decode the first block to learn rate and channels for sure.
        let mut first = Vec::new();
        if !src.decode_raw(&mut first)? {
            return Err(CmdError::new("no-audio", format!("{}: no audio data", path.display())));
        }
        src.pending = first;
        if src.sample_rate == 0 || src.channels == 0 {
            return Err(CmdError::new("decode-failed", format!("{}: unknown sample format", path.display())));
        }
        Ok(src)
    }

    pub fn tags(&self) -> &[(String, String)] {
        &self.tags
    }

    /// Fraction of the file the demuxer has read.
    pub fn progress(&self) -> f64 {
        if self.byte_len == 0 {
            0.0
        } else {
            (self.position.load(Ordering::Relaxed) as f64 / self.byte_len as f64).min(1.0)
        }
    }

    /// The container's length, in its own time base (an MP4's media timescale);
    /// of all streams of a chained Ogg file.
    pub fn duration_estimate(&self) -> f64 {
        if let Some(sec) = self.on_disk.then(|| ogg_chain_sec(&self.path)).flatten() {
            return sec;
        }
        match (self.n_frames, self.time_base) {
            (Some(n), Some(tb)) if tb.denom > 0 => n as f64 * f64::from(tb.numer) / f64::from(tb.denom),
            (Some(n), None) if self.sample_rate > 0 => n as f64 / self.sample_rate as f64,
            _ => 0.0,
        }
    }

    /// Appends the next decoded block (interleaved, `self.channels` wide).
    /// Returns false at the end of the stream.
    pub fn next_block(&mut self, out: &mut Vec<f32>) -> CmdResult<bool> {
        if !self.pending.is_empty() {
            out.append(&mut self.pending);
            return Ok(true);
        }
        self.decode_raw(out)
    }

    fn decode_raw(&mut self, out: &mut Vec<f32>) -> CmdResult<bool> {
        loop {
            if self.ended {
                return Ok(false);
            }
            let mut packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(self.finish(out)),
                // The next stream of a chained Ogg file (`cat a.ogg b.ogg`).
                Err(SymError::ResetRequired) => {
                    self.next_stream()?;
                    continue;
                }
                Err(e) => return Err(map_sym(e, &self.path)),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            self.packet_bytes += packet.data.len() as u64;
            if self.mpeg && packet.dur == 0 && packet.trim_end > 0 {
                // Past the frame count in the MP3's header: files joined byte for byte or edited
                // keep the count of their first part, VBR files without one get an estimate.
                // Players play on, so does the app.
                packet.dur = u64::from(packet.trim_end);
                packet.trim_end = 0;
            }
            let result = self.decoder.decode(&packet).map(|_| ());
            match result {
                Ok(()) => {}
                // The MP3 decoder keeps the format of the first frame. A part joined on in
                // another format (mono intro, other sample rate) needs a decoder of its own.
                Err(SymError::DecodeError(_)) if self.mpeg && self.restart_decoder(&packet) => {}
                // A damaged frame: skip it like players do.
                Err(SymError::DecodeError(_)) => continue,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(self.finish(out)),
                Err(e) => return Err(map_sym(e, &self.path)),
            }
            let decoded = self.decoder.last_decoded();
            let frames = decoded.frames();
            if frames == 0 {
                continue;
            }
            let spec = *decoded.spec();
            let src_channels = spec.channels.count();
            if self.sample_rate == 0 {
                self.sample_rate = spec.rate;
                self.channels = src_channels;
                self.channel_layout = Some(spec.channels);
            }
            // After a jump: frames before the place asked for are dropped.
            let mut skip = 0usize;
            if let Some(until) = self.skip_until {
                let start = self.packet_frame(packet.ts);
                let behind = until - start;
                if behind >= frames as i64 {
                    continue;
                }
                skip = behind.max(0) as usize;
                self.skip_until = None;
            }
            let needs_new = match &self.sample_buf {
                Some((s, cap, _)) => *s != spec || *cap < frames,
                None => true,
            };
            if needs_new {
                let cap = frames.max(decoded.capacity());
                self.sample_buf = Some((spec, cap, SampleBuffer::<f32>::new(cap as u64, spec)));
            }
            let Some((_, _, sb)) = self.sample_buf.as_mut() else { continue };
            sb.copy_interleaved_ref(decoded);
            let samples = &sb.samples()[skip * src_channels..];
            let start = out.len();
            if src_channels == self.channels {
                out.extend_from_slice(samples);
            } else {
                // Channel count changed mid-stream: map onto the opening layout.
                for f in samples.chunks_exact(src_channels.max(1)) {
                    for c in 0..self.channels {
                        out.push(if src_channels == 1 { f[0] } else { f.get(c).copied().unwrap_or(0.0) });
                    }
                }
            }
            if spec.rate != self.sample_rate || self.rate_fix.is_some() {
                let block = out.split_off(start);
                self.convert_rate(spec.rate, &block, out);
            }
            return Ok(true);
        }
    }

    /// A decoder of its own for a packet the current one refused; kept when it decodes it.
    fn restart_decoder(&mut self, packet: &Packet) -> bool {
        let Ok(mut fresh) = symphonia::default::get_codecs().make(&self.params, &DecoderOptions::default()) else { return false };
        if fresh.decode(packet).is_err() {
            return false;
        }
        self.decoder = fresh;
        true
    }

    /// Continues with the first audio track of the stream that follows.
    fn next_stream(&mut self) -> CmdResult<()> {
        let Some(track) = self.format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL) else {
            return Err(CmdError::new("unsupported-format", format!("{}: no audio track in the next stream", self.path.display())));
        };
        let (id, params) = (track.id, track.codec_params.clone());
        self.decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).map_err(|e| map_sym(e, &self.path))?;
        self.track_id = id;
        self.params = params;
        Ok(())
    }

    /// Converts a block in `rate` to the opening rate; a block in the opening
    /// rate passes through, after the tail of the part before.
    fn convert_rate(&mut self, rate: u32, block: &[f32], out: &mut Vec<f32>) {
        if self.rate_fix.as_ref().map(|(r, _)| *r) != Some(rate) {
            self.flush_rate(out);
            if rate != self.sample_rate {
                self.rate_fix = Some((rate, Resampler::new(rate, self.sample_rate, self.channels)));
            }
        }
        match self.rate_fix.as_mut() {
            Some((_, r)) => r.process(block, out),
            None => out.extend_from_slice(block),
        }
    }

    fn flush_rate(&mut self, out: &mut Vec<f32>) {
        if let Some((_, mut r)) = self.rate_fix.take() {
            r.finish(out);
        }
    }

    /// The end of the stream; true when the rate converter still had samples.
    fn finish(&mut self, out: &mut Vec<f32>) -> bool {
        self.ended = true;
        let before = out.len();
        self.flush_rate(out);
        out.len() > before
    }
}

fn normalize_codec(short: &str) -> String {
    if short.starts_with("pcm") {
        "pcm".into()
    } else if short.starts_with("adpcm") {
        "adpcm".into()
    } else {
        short.to_string()
    }
}

/* ------------------------------------------------------------ analysis */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisHeader {
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: usize,
    pub window_sec: f64,
    pub window_count: usize,
    pub lufs: Option<f64>,
    /// Largest absolute sample value (1.0 = full scale).
    pub peak: Option<f64>,
    /// Flat tops at the loudest level, where the file was cut off before it came here (loudness::ClipCounter).
    pub clips: Option<u64>,
    pub chapters: Vec<Chapter>,
    pub codec: String,
    pub bitrate_kbps: Option<f64>,
}

pub struct Analysis {
    pub header: AnalysisHeader,
    pub power: Vec<f32>,
}

pub fn analyze_file(path: &Path, cancel: &AtomicBool, mut progress: impl FnMut(f64)) -> CmdResult<Analysis> {
    let mut src = Source::open(path)?;
    let weights = channel_weights(src.channel_layout, src.channels);
    let mut meter = LoudnessMeter::new(src.sample_rate, weights);
    let mut block = Vec::with_capacity(16384);
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CmdError::new("cancelled", "analysis cancelled"));
        }
        block.clear();
        if !src.next_block(&mut block)? {
            break;
        }
        meter.push_interleaved(&block);
        if last.elapsed() >= Duration::from_millis(200) {
            progress(src.progress());
            last = Instant::now();
        }
    }
    meter.finish();
    let duration = meter.frames() as f64 / src.sample_rate as f64;
    let mut chapter_list = chapters::read_chapters(path);
    if chapter_list.is_empty() {
        chapter_list = chapters::chapters_from_tags(src.tags());
    }
    if chapter_list.is_empty() {
        chapter_list = chapters::flac_cue_chapters(path);
    }
    chapter_list.retain(|c| c.start_sec <= duration + 1.0);
    let bitrate = (duration > 0.0).then(|| (src.packet_bytes as f64 * 8.0 / duration / 1000.0 * 10.0).round() / 10.0);
    progress(1.0);
    let lufs = meter.integrated().map(|l| (l * 100.0).round() / 100.0);
    let power = std::mem::take(&mut meter.power);
    Ok(Analysis {
        header: AnalysisHeader {
            duration_sec: duration,
            sample_rate: src.sample_rate,
            channels: src.channels,
            window_sec: 0.01,
            window_count: power.len(),
            lufs,
            peak: (meter.frames() > 0).then(|| meter.peak() as f64),
            clips: (meter.frames() > 0).then(|| meter.clips()),
            chapters: chapter_list,
            codec: src.codec.clone(),
            bitrate_kbps: bitrate,
        },
        power,
    })
}

pub fn f32_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/* ------------------------------------------------------------- PCM */

pub struct PcmStream {
    path: PathBuf,
    src: Source,
    resampler: Option<Resampler>,
    queue: Vec<f32>,
    eof: bool,
    scratch: Vec<f32>,
}

impl PcmStream {
    pub fn open(path: &Path, target_rate: Option<u32>) -> CmdResult<PcmStream> {
        let src = Source::open(path)?;
        let resampler = match target_rate {
            Some(r) if r != src.sample_rate => {
                if !(4000..=384_000).contains(&r) {
                    return Err(CmdError::invalid(format!("unsupported target rate {r}")));
                }
                Some(Resampler::new(src.sample_rate, r, src.channels))
            }
            _ => None,
        };
        Ok(PcmStream { path: path.to_path_buf(), src, resampler, queue: Vec::new(), eof: false, scratch: Vec::new() })
    }

    pub fn out_rate(&self, target: Option<u32>) -> u32 {
        if self.resampler.is_some() {
            target.unwrap_or(self.src.sample_rate)
        } else {
            self.src.sample_rate
        }
    }

    /// Up to `max_frames` interleaved frames; empty at the end.
    pub fn read(&mut self, max_frames: usize) -> CmdResult<Vec<f32>> {
        let ch = self.src.channels;
        while self.queue.len() < max_frames * ch && !self.eof {
            self.scratch.clear();
            if self.src.next_block(&mut self.scratch)? {
                match self.resampler.as_mut() {
                    Some(r) => r.process(&self.scratch, &mut self.queue),
                    None => self.queue.extend_from_slice(&self.scratch),
                }
            } else {
                self.eof = true;
                if let Some(r) = self.resampler.as_mut() {
                    r.finish(&mut self.queue);
                }
            }
        }
        let n = (max_frames * ch).min(self.queue.len());
        Ok(self.queue.drain(..n).collect())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmOpened {
    pub handle: u32,
    pub sample_rate: u32,
    pub channels: usize,
    pub duration_sec: f64,
}

#[derive(Default)]
pub struct AudioState {
    jobs: CancelFlags,
    next: AtomicU32,
    pcm: Mutex<HashMap<u32, Arc<Mutex<PcmStream>>>>,
}

impl AudioState {
    /// Closes PCM readers of files below `root` (before ejecting a card).
    pub fn close_under(&self, root: &Path) {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if let Ok(mut pcm) = self.pcm.lock() {
            pcm.retain(|_, s| s.lock().map(|s| !s.path.starts_with(&root)).unwrap_or(false));
        }
    }

    fn get(&self, handle: u32) -> CmdResult<Arc<Mutex<PcmStream>>> {
        self.pcm
            .lock()
            .ok()
            .and_then(|m| m.get(&handle).cloned())
            .ok_or_else(|| CmdError::new("closed", format!("audio handle {handle} is not open")))
    }
}

/* ------------------------------------------------------------ commands */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    job_id: &'a str,
    fraction: f64,
}

/// Returns a TSB1 frame: JSON `AnalysisHeader` + `windowCount` f32 LE powers.
/// Emits `audio-progress` {jobId, fraction}; cancel with `audio_cancel`.
#[tauri::command]
pub async fn audio_analyze(app: AppHandle, state: State<'_, SharedState>, path: String, job_id: String) -> CmdResult<Response> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Read)?;
        let cancel = st.audio.jobs.register(&job_id);
        let result = analyze_file(&p, &cancel, |fraction| {
            let _ = app.emit(EVENT_AUDIO_PROGRESS, ProgressEvent { job_id: &job_id, fraction });
        });
        st.audio.jobs.finish(&job_id);
        let analysis = result?;
        Ok(Response::new(frame(&analysis.header, &f32_le_bytes(&analysis.power))))
    })
    .await
}

#[tauri::command]
pub fn audio_cancel(state: State<'_, SharedState>, job_id: String) {
    state.audio.jobs.cancel(&job_id);
}

#[tauri::command]
pub async fn audio_pcm_open(state: State<'_, SharedState>, path: String, target_sample_rate: Option<u32>) -> CmdResult<PcmOpened> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Read)?;
        let stream = PcmStream::open(&p, target_sample_rate)?;
        let opened = PcmOpened {
            handle: st.audio.next.fetch_add(1, Ordering::Relaxed) + 1,
            sample_rate: stream.out_rate(target_sample_rate),
            channels: stream.src.channels,
            duration_sec: stream.src.duration_estimate(),
        };
        st.audio
            .pcm
            .lock()
            .map_err(|_| CmdError::other("audio table poisoned"))?
            .insert(opened.handle, Arc::new(Mutex::new(stream)));
        Ok(opened)
    })
    .await
}

/// Raw interleaved f32 LE samples, at most `max_frames` frames; empty at the end.
#[tauri::command]
pub async fn audio_pcm_read(state: State<'_, SharedState>, handle: u32, max_frames: u32) -> CmdResult<Response> {
    let st = state.inner().clone();
    blocking(move || {
        let stream = st.audio.get(handle)?;
        let mut s = stream.lock().map_err(|_| CmdError::other("audio stream poisoned"))?;
        let samples = s.read(max_frames.clamp(1, 1 << 20) as usize)?;
        Ok(Response::new(f32_le_bytes(&samples)))
    })
    .await
}

#[tauri::command]
pub async fn audio_pcm_close(state: State<'_, SharedState>, handle: u32) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let removed = st.audio.pcm.lock().map_err(|_| CmdError::other("audio table poisoned"))?.remove(&handle);
        drop(removed);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// Writes a 16-bit PCM WAV file.
    fn write_wav(path: &Path, rate: u32, channels: u16, samples: &[f32]) {
        let data: Vec<u8> = samples.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes()).collect();
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&channels.to_le_bytes());
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        w.extend_from_slice(&(channels * 2).to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&(data.len() as u32).to_le_bytes());
        w.extend_from_slice(&data);
        std::fs::write(path, w).unwrap();
    }

    fn stereo_sine(rate: u32, seconds: f64, dbfs: f64) -> Vec<f32> {
        let amp = 10f64.powf(dbfs / 20.0);
        (0..(rate as f64 * seconds) as usize)
            .flat_map(|i| {
                let v = (amp * (2.0 * PI * 1000.0 * i as f64 / rate as f64).sin()) as f32;
                [v, v]
            })
            .collect()
    }

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tonuino-audio-{}-{name}", std::process::id()))
    }

    fn fixtures() -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/library");
        dir.exists().then_some(dir)
    }

    /// Writes `bytes` to a temp file, runs `f` on it and removes it again.
    fn with_file<T>(name: &str, bytes: &[u8], f: impl FnOnce(&Path) -> T) -> T {
        let path = tmp(name);
        std::fs::write(&path, bytes).unwrap();
        let out = f(&path);
        let _ = std::fs::remove_file(&path);
        out
    }

    /// Frames of the whole PCM stream.
    fn pcm_frames(path: &Path, rate: Option<u32>) -> usize {
        let mut s = PcmStream::open(path, rate).unwrap();
        let mut frames = 0;
        loop {
            let block = s.read(1 << 16).unwrap();
            if block.is_empty() {
                return frames;
            }
            frames += block.len() / s.src.channels;
        }
    }

    /// Silent MPEG audio frames: the 4 header bytes, then zeros up to `bytes`.
    fn mpeg_frames(count: usize, header: [u8; 4], bytes: usize) -> Vec<u8> {
        let mut frame = vec![0u8; bytes];
        frame[..4].copy_from_slice(&header);
        frame.repeat(count)
    }

    /// Silent MP3 frames (MPEG-1 Layer III, 44.1 kHz mono) at 128 kbit/s, or 320 or 32.
    fn mp3_frames(count: usize, kbps: u32) -> Vec<u8> {
        let index = match kbps {
            32 => 1,
            320 => 14,
            _ => 9,
        };
        mpeg_frames(count, [0xFF, 0xFB, index << 4, 0xC0], (144_000 * kbps / 44_100) as usize)
    }

    /// An "Info" frame (the Xing header of CBR files) announcing `frames` frames.
    fn info_frame(frames: u32) -> Vec<u8> {
        let mut f = mp3_frames(1, 128);
        f[21..25].copy_from_slice(b"Info"); // after the header and 17 bytes of side info
        f[25..29].copy_from_slice(&1u32.to_be_bytes()); // flags: frame count present
        f[29..33].copy_from_slice(&frames.to_be_bytes());
        f
    }

    /// Writes a 16-bit AIFF file at 44.1 kHz.
    fn aiff(channels: u16, samples: &[f32]) -> Vec<u8> {
        let mut comm = channels.to_be_bytes().to_vec();
        comm.extend_from_slice(&((samples.len() / channels as usize) as u32).to_be_bytes());
        comm.extend_from_slice(&16u16.to_be_bytes());
        comm.extend_from_slice(&[0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]); // 44100 as 80-bit float
        let mut ssnd = vec![0u8; 8]; // offset, block size
        ssnd.extend(samples.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_be_bytes()));
        let mut w = b"FORM".to_vec();
        w.extend_from_slice(&((4 + 8 + comm.len() + 8 + ssnd.len()) as u32).to_be_bytes());
        w.extend_from_slice(b"AIFF");
        for (id, body) in [(b"COMM", &comm), (b"SSND", &ssnd)] {
            w.extend_from_slice(id);
            w.extend_from_slice(&(body.len() as u32).to_be_bytes());
            w.extend_from_slice(body);
        }
        w
    }

    #[test]
    fn analyzes_a_wav_file_end_to_end() {
        let path = tmp("sine.wav");
        let mut samples = stereo_sine(44100, 5.0, -23.0);
        samples.extend(std::iter::repeat(0.0).take(44100 * 2)); // 1 s pause
        write_wav(&path, 44100, 2, &samples);
        let mut fractions = Vec::new();
        let a = analyze_file(&path, &AtomicBool::new(false), |f| fractions.push(f)).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(a.header.sample_rate, 44100);
        assert_eq!(a.header.channels, 2);
        assert!((a.header.duration_sec - 6.0).abs() < 1e-6, "{}", a.header.duration_sec);
        assert_eq!(a.header.window_count, 600);
        assert_eq!(a.power.len(), 600);
        // 47 full blocks of sine plus 3 blocks straddling the pause with 75 %, 50 %
        // and 25 % of the power (all above the relative gate): 10·log10(48.5/50).
        let expected = -23.0 + 10.0 * (48.5f64 / 50.0).log10();
        assert!((a.header.lufs.unwrap() - expected).abs() <= 0.03, "{:?} vs {expected}", a.header.lufs);
        assert_eq!(a.header.codec, "pcm");
        assert!((a.header.bitrate_kbps.unwrap() - 1411.2).abs() < 2.0);
        // The sine's amplitude is the sample peak.
        let amp = 10f64.powf(-23.0 / 20.0);
        assert!((a.header.peak.unwrap() - amp).abs() < 0.002, "{:?} vs {amp}", a.header.peak);
        assert_eq!(a.header.clips, Some(0));
        // The pause is visible in the power windows.
        assert!(a.power[550] < 1e-9 && a.power[250] > 1e-4);
        assert_eq!(fractions.last().copied(), Some(1.0));
    }

    #[test]
    fn counts_the_cut_off_tops_of_a_clipped_file() {
        // 1 kHz driven 6 dB over full scale, saved with 16 bits: two flat tops per wave and channel.
        let path = tmp("clipped.wav");
        write_wav(&path, 44100, 2, &stereo_sine(44100, 1.0, 6.0));
        let a = analyze_file(&path, &AtomicBool::new(false), |_| ()).unwrap();
        let _ = std::fs::remove_file(&path);
        let clips = a.header.clips.unwrap();
        assert!((3900..=4000).contains(&clips), "{clips}");
    }

    #[test]
    fn cancels_analysis() {
        let path = tmp("cancel.wav");
        write_wav(&path, 8000, 1, &vec![0.1; 8000]);
        let err = analyze_file(&path, &AtomicBool::new(true), |_| {}).err().unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(err.code, "cancelled");
    }

    #[test]
    fn streams_resampled_pcm() {
        let path = tmp("pcm.wav");
        write_wav(&path, 44100, 2, &stereo_sine(44100, 2.0, -6.0));
        let mut s = PcmStream::open(&path, Some(48000)).unwrap();
        assert_eq!(s.out_rate(Some(48000)), 48000);
        assert_eq!(s.src.channels, 2);
        assert!((s.src.duration_estimate() - 2.0).abs() < 1e-6);
        let mut total = 0;
        loop {
            let block = s.read(4096).unwrap();
            if block.is_empty() {
                break;
            }
            assert!(block.len() <= 4096 * 2 && block.len() % 2 == 0);
            total += block.len() / 2;
        }
        let _ = std::fs::remove_file(&path);
        assert_eq!(total, 96000);
    }

    /// The library fixtures of the TypeScript tests: real MP3, AAC (M4B with
    /// chapter track, moov before and after mdat) and FLAC files.
    #[test]
    fn analyzes_real_files_with_chapters() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/library");
        if !dir.exists() {
            eprintln!("fixtures missing, skipped");
            return;
        }
        let chapters = |a: &Analysis| -> Vec<(f64, Option<String>)> {
            a.header.chapters.iter().map(|c| ((c.start_sec * 10.0).round() / 10.0, c.title.clone())).collect()
        };
        let expected = vec![(0.0, Some("Anfang".to_string())), (1.5, Some("Ende".to_string()))];

        let mp3 = analyze_file(&dir.join("tagged.mp3"), &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!((mp3.header.codec.as_str(), mp3.header.channels, mp3.header.sample_rate), ("mp3", 1, 22050));
        assert!((2.9..3.2).contains(&mp3.header.duration_sec), "{}", mp3.header.duration_sec);
        assert_eq!(mp3.power.len(), (mp3.header.duration_sec * 100.0).ceil() as usize);
        assert!(mp3.header.lufs.is_some());
        assert_eq!(chapters(&mp3), expected);

        for name in ["book.m4b", "book-faststart.m4b"] {
            let m4b = analyze_file(&dir.join(name), &AtomicBool::new(false), |_| {}).unwrap();
            assert_eq!(m4b.header.codec, "aac", "{name}");
            assert!(m4b.header.duration_sec > 3.9, "{name}: {}", m4b.header.duration_sec);
            assert_eq!(chapters(&m4b), expected, "{name}");
        }

        let flac = analyze_file(&dir.join("song.flac"), &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(flac.header.codec, "flac");
        assert!((flac.header.duration_sec - 1.0).abs() < 0.05, "{}", flac.header.duration_sec);

        for name in ["tagged.mp3", "book.m4b", "song.flac"] {
            let s = PcmStream::open(&dir.join(name), None).unwrap();
            assert!(s.src.duration_estimate() > 0.9, "{name}: duration known before decoding");
        }
        // PCM of the same files streams and resamples.
        let mut s = PcmStream::open(&dir.join("tagged.mp3"), Some(44100)).unwrap();
        let mut frames = 0;
        loop {
            let block = s.read(10_000).unwrap();
            if block.is_empty() {
                break;
            }
            frames += block.len();
        }
        assert!((frames as f64 / 44100.0 - mp3.header.duration_sec).abs() < 0.01, "{frames}");
    }

    /// Audio from video sites arrives as fragmented MP4 with AAC-LC (DASH,
    /// tests/fixtures/library/dash.m4a made with ffmpeg), unrepaired: the app
    /// reads it itself, without ffmpeg.
    #[test]
    fn reads_fragmented_mp4_from_web_downloads() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/library/dash.m4a");
        if !path.exists() {
            eprintln!("fixture missing, skipped");
            return;
        }
        let a = analyze_file(&path, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!((a.header.codec.as_str(), a.header.channels, a.header.sample_rate), ("aac", 2, 44100));
        assert!((a.header.duration_sec - 2.02).abs() < 0.1, "{}", a.header.duration_sec);
        assert!(a.header.lufs.is_some());
        let mut s = PcmStream::open(&path, Some(44100)).unwrap();
        let mut samples = 0;
        loop {
            let block = s.read(10_000).unwrap();
            if block.is_empty() {
                break;
            }
            samples += block.len();
        }
        assert!((samples as f64 / 2.0 / 44100.0 - a.header.duration_sec).abs() < 0.05, "{samples}");
    }

    /// MP3s play on past the frame count in their header, like in players and
    /// in the browser: files joined byte for byte keep the count of their first
    /// part, VBR files without a Xing frame get an estimate from their first frames.
    #[test]
    fn decodes_mp3_frames_past_the_header_count() {
        let duration = |name: &str, bytes: &[u8]| {
            with_file(name, bytes, |path| {
                let a = analyze_file(path, &AtomicBool::new(false), |_| {}).unwrap();
                assert_eq!(pcm_frames(path, None) as f64 / f64::from(a.header.sample_rate), a.header.duration_sec, "{name}: PCM as long as the analysis");
                a.header.duration_sec
            })
        };
        let frame = 1152.0 / 44100.0;
        // An Info frame announcing 50 frames, then 200.
        let stale = [info_frame(50), mp3_frames(200, 128)].concat();
        assert!((duration("stale.mp3", &stale) - 200.0 * frame).abs() < 1e-9);
        // Loud (large) frames first: the estimate from them says 35 frames.
        let vbr = [mp3_frames(16, 320), mp3_frames(200, 32)].concat();
        assert!((duration("vbr.mp3", &vbr) - 216.0 * frame).abs() < 1e-9);

        let Some(dir) = fixtures() else { return };
        // A real file twice (`copy /b`): the second part's LAME delay plays like in mpg123.
        let single = std::fs::read(dir.join("tagged.mp3")).unwrap();
        let tag = 10 + single[6..10].iter().fold(0usize, |acc, &b| (acc << 7) | (b & 0x7f) as usize);
        let one = duration("one.mp3", &single);
        let two = duration("two.mp3", &[&single[..], &single[tag..]].concat());
        assert!((two - 2.0 * one).abs() < 0.1, "{two} vs 2 × {one}");
    }

    /// Rate and channels come from the decoded audio: an HE-AAC M4A names its
    /// output rate (44.1 kHz) in the sample entry, symphonia decodes the AAC
    /// core at 22.05 kHz. The length comes from the container's own timescale.
    #[test]
    fn takes_the_rate_from_the_decoded_audio() {
        let Some(dir) = fixtures() else { return };
        let mut m4b = std::fs::read(dir.join("book.m4b")).unwrap();
        let entry = m4b.windows(4).position(|w| w == b"mp4a").unwrap();
        // The sample rate of the audio sample entry (16.16 fixed point): 22050 → 44100.
        assert_eq!(m4b[entry + 28..entry + 30], 22050u16.to_be_bytes());
        m4b[entry + 28..entry + 30].copy_from_slice(&44100u16.to_be_bytes());
        with_file("heaac.m4b", &m4b, |path| {
            let a = analyze_file(path, &AtomicBool::new(false), |_| {}).unwrap();
            assert_eq!(a.header.sample_rate, 22050);
            assert!((a.header.duration_sec - 4.0).abs() < 0.1, "{}", a.header.duration_sec);
            assert_eq!(a.header.chapters.len(), 2);
            let s = PcmStream::open(path, Some(44100)).unwrap();
            assert_eq!(s.out_rate(Some(44100)), 44100);
            assert!((s.src.duration_estimate() - a.header.duration_sec).abs() < 0.1, "{}", s.src.duration_estimate());
            let frames = pcm_frames(path, Some(44100));
            assert!((frames as f64 / 44100.0 - a.header.duration_sec).abs() < 0.01, "{frames}");
        });
    }

    /// AIFF and MP2 open. WebM, WMA and CAF are refused at once (symphonia's
    /// probe took a WebM with MPEG-like bytes for an MP3), and data the probe
    /// reads to its end is an unknown format, not a read error. A cut-off M4A
    /// is damaged, a copy protected one says so.
    #[test]
    fn opens_aiff_and_mp2_and_names_what_it_cannot_read() {
        let code = |name: &str, bytes: &[u8]| with_file(name, bytes, |path| Source::open(path).err().map(|e| e.code));
        let sine = stereo_sine(44100, 1.0, -20.0);
        with_file("song.aiff", &aiff(2, &sine), |path| {
            let a = analyze_file(path, &AtomicBool::new(false), |_| {}).unwrap();
            assert_eq!((a.header.sample_rate, a.header.channels), (44100, 2));
            assert!((a.header.duration_sec - 1.0).abs() < 1e-9);
        });
        // MPEG-1 Layer II, 192 kbit/s, 44.1 kHz mono.
        let mp2 = mpeg_frames(100, [0xFF, 0xFD, 0xA0, 0xC0], 626);
        with_file("radio.mp3", &mp2, |path| {
            let a = analyze_file(path, &AtomicBool::new(false), |_| {}).unwrap();
            assert_eq!(a.header.codec, "mp2");
            assert!((a.header.duration_sec - 100.0 * 1152.0 / 44100.0).abs() < 1e-9);
        });
        let webm = [&[0x1A, 0x45, 0xDF, 0xA3][..], &mp3_frames(50, 128)].concat();
        assert_eq!(code("clip.webm", &webm), Some("unsupported-format"));
        // One MPEG-like header in other data: the probe searches on to the end of the file.
        let stray = |head: &[u8]| [head, &[0x5A; 3000], &[0xFF, 0xFB, 0x90, 0xC0], &[0x5A; 2000]].concat();
        assert_eq!(code("song.wma", &stray(&[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9])), Some("unsupported-format"));
        assert_eq!(code("song.caf", &stray(b"caff\0\x01\0\0")), Some("unsupported-format"));
        assert_eq!(code("noise.bin", &stray(b"")), Some("unsupported-format"));

        let Some(dir) = fixtures() else { return };
        // book.m4b keeps its index (moov) at the end.
        let m4b = std::fs::read(dir.join("book.m4b")).unwrap();
        assert_eq!(code("cut.m4b", &m4b[..m4b.len() / 2]), Some("decode-failed"));
        let mut drm = m4b.clone();
        let entry = drm.windows(4).position(|w| w == b"mp4a").unwrap();
        drm[entry..entry + 4].copy_from_slice(b"drms");
        assert_eq!(code("drm.m4b", &drm), Some("drm-protected"));
    }

    /// An MP3 joined from parts in other formats (a mono intro at 44.1 kHz, then
    /// stereo at 48 kHz) plays to its end in the format of its start.
    #[test]
    fn decodes_mp3_parts_in_another_format() {
        let joined = [mp3_frames(100, 128), mpeg_frames(100, [0xFF, 0xFB, 0x94, 0x00], 384)].concat();
        with_file("joined.mp3", &joined, |path| {
            let a = analyze_file(path, &AtomicBool::new(false), |_| {}).unwrap();
            assert_eq!((a.header.sample_rate, a.header.channels), (44100, 1));
            let expected = 100.0 * 1152.0 / 44100.0 + 100.0 * 1152.0 / 48000.0;
            assert!((a.header.duration_sec - expected).abs() < 0.01, "{} vs {expected}", a.header.duration_sec);
            assert_eq!(pcm_frames(path, None) as f64 / 44100.0, a.header.duration_sec);
        });
    }

    /// Ogg files whose streams follow each other (`cat a.ogg b.ogg`) play to the
    /// end, like in the browser. chain.ogg: 2 s Vorbis at 44.1 kHz stereo, then
    /// 1 s at 22.05 kHz mono, which is converted.
    #[test]
    fn decodes_chained_ogg_streams() {
        let Some(dir) = fixtures() else { return };
        let path = dir.join("chain.ogg");
        let a = analyze_file(&path, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!((a.header.sample_rate, a.header.channels), (44100, 2));
        assert!((a.header.duration_sec - 3.0).abs() < 0.01, "{}", a.header.duration_sec);
        assert_eq!(pcm_frames(&path, None) as f64 / 44100.0, a.header.duration_sec);
        // Known before decoding too (the length check while reading); the container tells 2 s.
        let s = PcmStream::open(&path, None).unwrap();
        assert!((s.src.duration_estimate() - 3.0).abs() < 0.01, "{}", s.src.duration_estimate());
        // Its first link alone is no chain.
        let bytes = std::fs::read(&path).unwrap();
        let second = (1..bytes.len() - 27).find(|&p| &bytes[p..p + 4] == b"OggS" && bytes[p + 5] & 0x02 != 0 && bytes[p + 14..p + 18] != bytes[14..18]).unwrap();
        with_file("link.ogg", &bytes[..second], |p| {
            assert_eq!(ogg_chain_sec(p), None);
            let s = PcmStream::open(p, None).unwrap();
            assert!((s.src.duration_estimate() - 2.0).abs() < 0.01, "{}", s.src.duration_estimate());
        });
    }

    /// A long FLAC with an embedded cue sheet is cut at its tracks, like in the
    /// browser; CHAPTER comments still come first.
    #[test]
    fn reads_chapters_from_a_flac_cue_sheet() {
        let Some(dir) = fixtures() else { return };
        let flac = std::fs::read(dir.join("song.flac")).unwrap(); // 1 s at 8 kHz
        // Metadata blocks: (type, start, end).
        let mut blocks = Vec::new();
        let mut p = 4;
        loop {
            let len = u32::from_be_bytes([0, flac[p + 1], flac[p + 2], flac[p + 3]]) as usize;
            blocks.push((flac[p] & 0x7f, p, p + 4 + len));
            if flac[p] & 0x80 != 0 {
                break;
            }
            p += 4 + len;
        }
        let block = |kind: u8, body: &[u8]| [&[kind][..], &(body.len() as u32).to_be_bytes()[1..], body].concat();
        // Tracks 1 (0 s), 2 (INDEX 00 at 0.25 s, INDEX 01 at 0.3 s), 3 (0.7 s) and the lead-out.
        let mut cue = vec![0u8; 395];
        cue.push(4);
        for (number, offset, indices) in [(1u8, 0u64, vec![(0u64, 1u8)]), (2, 2000, vec![(0, 0), (400, 1)]), (3, 5600, vec![(0, 1)]), (255, 8000, vec![])] {
            cue.extend_from_slice(&offset.to_be_bytes());
            cue.push(number);
            cue.extend_from_slice(&[0; 26]);
            cue.push(indices.len() as u8);
            for (at, index) in indices {
                cue.extend_from_slice(&at.to_be_bytes());
                cue.extend_from_slice(&[index, 0, 0, 0]);
            }
        }
        let (streaminfo, comments) = (blocks[0], blocks[1]);
        assert_eq!((streaminfo.0, comments.0), (0, 4));
        let chapters = |bytes: Vec<u8>| {
            with_file("cue.flac", &bytes, |path| {
                let a = analyze_file(path, &AtomicBool::new(false), |_| {}).unwrap();
                a.header.chapters.iter().map(|c| ((c.start_sec * 100.0).round() / 100.0, c.title.clone())).collect::<Vec<_>>()
            })
        };
        let with_cue = [&flac[..streaminfo.2], &block(5, &cue), &flac[streaminfo.2..]].concat();
        assert_eq!(chapters(with_cue), vec![(0.0, None), (0.3, None), (0.7, None)]);

        let mut vorbis = 1u32.to_le_bytes().to_vec();
        vorbis.push(b'x');
        vorbis.extend_from_slice(&1u32.to_le_bytes());
        let comment = b"CHAPTER001=00:00:00.500";
        vorbis.extend_from_slice(&(comment.len() as u32).to_le_bytes());
        vorbis.extend_from_slice(comment);
        let both = [&flac[..streaminfo.2], &block(5, &cue), &block(4, &vorbis), &flac[comments.2..]].concat();
        assert_eq!(chapters(both), vec![(0.5, None)]);
    }

    #[test]
    fn rejects_non_audio() {
        let path = tmp("not-audio.mp3");
        std::fs::write(&path, b"this is not an mp3 file at all, just text").unwrap();
        let err = Source::open(&path).err().unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(["unsupported-format", "decode-failed"].contains(&err.code), "{}", err.code);
    }
}
