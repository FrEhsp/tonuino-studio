//! A track the player decodes: a file (on the SD card or anywhere the user
//! picked one) or data the page holds in memory (a recording, an import that
//! is not on disk). Decoding is symphonia's (crate::audio::Source); jumps
//! land on the exact sample, for MP3 through the frame index of mp3index.rs.

use super::mp3index::{seek_plan, Mp3Index};
use crate::audio::{protected_or, OpenOptions, Source};
use crate::error::{CmdError, CmdResult};
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use symphonia::core::io::MediaSource;

/// Frames decoded before the one a jump goes to, and thrown away: the MP3
/// decoder needs the bit reservoir (up to 511 bytes, several frames at low
/// bit rates) and the overlap of the frame before.
const PREROLL: u64 = 10;
/// How long a jump waits for the frame index to get there before it seeks
/// the slow way.
const INDEX_WAIT: Duration = Duration::from_secs(3);

/// Where the bytes are.
#[derive(Clone)]
pub enum Media {
    File(PathBuf),
    Memory { data: Arc<[u8]>, name: PathBuf },
}

impl Media {
    fn name(&self) -> &Path {
        match self {
            Media::File(p) => p,
            Media::Memory { name, .. } => name,
        }
    }

    /// The bytes from `start` to the end, as symphonia reads them, and the first few of them.
    fn open_from(&self, start: u64) -> CmdResult<(Box<dyn MediaSource>, Vec<u8>)> {
        match self {
            Media::File(path) => {
                let io = |e: std::io::Error| CmdError::io(&e, path.display());
                let mut file = File::open(path).map_err(io)?;
                let len = file.metadata().map_err(io)?.len();
                file.seek(SeekFrom::Start(start)).map_err(io)?;
                let mut head = Vec::with_capacity(12);
                file.by_ref().take(12).read_to_end(&mut head).map_err(io)?;
                file.seek(SeekFrom::Start(start)).map_err(io)?;
                Ok((Box::new(FileWindow { file, start, len, pos: start }), head))
            }
            Media::Memory { data, .. } => {
                let from = (start as usize).min(data.len());
                let head = data[from..(from + 12).min(data.len())].to_vec();
                Ok((Box::new(Cursor::new(Tail { data: data.clone(), from })), head))
            }
        }
    }

    /// A reader for the frame index (its own handle, so it never moves the decoder's).
    fn reader(&self) -> std::io::Result<Box<dyn ReadSeek>> {
        Ok(match self {
            Media::File(path) => Box::new(File::open(path)?),
            Media::Memory { data, .. } => Box::new(Cursor::new(Tail { data: data.clone(), from: 0 })),
        })
    }

    fn open_source(&self, start: u64, opts: OpenOptions) -> CmdResult<Source> {
        let (media, head) = self.open_from(start)?;
        let on_disk = matches!(self, Media::File(_));
        Source::open_media(media, self.name(), on_disk, &head, Arc::new(AtomicU64::new(0)), opts).map_err(|e| if on_disk { protected_or(e, self.name()) } else { e })
    }
}

trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

/// Data in memory from byte `from` on.
struct Tail {
    data: Arc<[u8]>,
    from: usize,
}

impl AsRef<[u8]> for Tail {
    fn as_ref(&self) -> &[u8] {
        &self.data[self.from..]
    }
}

/// A file read from byte `start` on, as if it began there.
struct FileWindow {
    file: File,
    start: u64,
    len: u64,
    pos: u64,
}

impl Read for FileWindow {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for FileWindow {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let target = match to {
            SeekFrom::Start(p) => self.start.checked_add(p),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        let target = target.filter(|&t| t >= self.start).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before the window"))?;
        self.pos = self.file.seek(SeekFrom::Start(target))?;
        Ok(self.pos - self.start)
    }
}

impl MediaSource for FileWindow {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len - self.start)
    }
}

/// What the player's decoding thread needs from a track (tests use a made-up one).
pub trait Decode: Send {
    fn rate(&self) -> u32;
    fn channels(&self) -> usize;
    /// Appends the next block (interleaved, `channels` wide, at `rate`); false at the end.
    fn next(&mut self, out: &mut Vec<f32>) -> CmdResult<bool>;
    /// The next block starts exactly at `sec`; past the end there is none.
    fn seek(&mut self, sec: f64) -> CmdResult<()>;
    /// Length in seconds, and whether it is exact (an MP3 whose frames are all read).
    fn duration(&self) -> (f64, bool);
}

/// The MP3 facts a jump needs.
struct Mp3Seek {
    index: Arc<Mp3Index>,
    delay: u32,
    padding: u32,
    /// The container's length in frames (from the Xing frame), for the exact length.
    n_frames: Option<u64>,
}

pub struct Track {
    media: Media,
    src: Source,
    mp3: Option<Mp3Seek>,
    rate: u32,
    channels: usize,
    estimate: f64,
    /// A jump went past the end.
    past_end: bool,
    /// Ends the index thread when the track is closed early.
    stop: Arc<AtomicBool>,
}

impl Track {
    pub fn open(media: Media) -> CmdResult<Track> {
        let mut src = media.open_source(0, OpenOptions::default())?;
        let mut mp3 = None;
        let stop = Arc::new(AtomicBool::new(false));
        if src.is_mpeg() {
            let (delay, padding) = src.delay_padding();
            // Without an encoder delay there is nothing to leave out, and
            // symphonia would cut the stream at the length it estimated from
            // the first frames (wrong in VBR files): read it as it is.
            if delay == 0 && padding == 0 {
                src = media.open_source(0, OpenOptions { gapless: false, ..Default::default() })?;
            }
            let index = Arc::new(Mp3Index::default());
            let (reader, idx, flag) = (media.reader(), index.clone(), stop.clone());
            if let Ok(reader) = reader {
                let started = std::thread::Builder::new().name("mp3-index".into()).spawn(move || idx.build(reader, || flag.load(Ordering::Relaxed)));
                if started.is_ok() {
                    mp3 = Some(Mp3Seek { index, delay, padding, n_frames: src.n_frames });
                }
            }
        }
        Ok(Track { rate: src.sample_rate, channels: src.channels, estimate: src.duration_estimate(), media, src, mp3, past_end: false, stop })
    }

    /// An MP3 jump through the frame index: a new reader from a few frames
    /// before the place on, its time stamps shifted to the place of its first frame.
    fn seek_mp3(&self, sec: f64) -> Option<CmdResult<Option<Source>>> {
        let m = self.mp3.as_ref()?;
        let spf = m.index.samples_per_frame();
        if spf == 0 {
            return None;
        }
        let frame = (sec.max(0.0) * f64::from(self.rate)).round() as u64;
        let (first, _) = seek_plan(frame, m.delay, spf, PREROLL);
        let Some(pos) = m.index.frame_pos(first as usize, INDEX_WAIT) else {
            // Past the last frame: nothing more to play.
            return m.index.frame_count().map(|_| Ok(None));
        };
        let opts = OpenOptions { gapless: false, ts_shift: (first * u64::from(spf)) as i64 - i64::from(m.delay), skip_until: Some(frame as i64) };
        match self.media.open_source(pos, opts) {
            Ok(s) if s.sample_rate == self.rate && s.channels == self.channels => Some(Ok(Some(s))),
            // No audio left after the place: the end.
            Err(e) if e.code == "no-audio" => Some(Ok(None)),
            Err(e) if e.code == "io" || e.code == "not-found" => Some(Err(e)),
            // Anything else: the slow way.
            _ => None,
        }
    }
}

impl Drop for Track {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Decode for Track {
    fn rate(&self) -> u32 {
        self.rate
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn next(&mut self, out: &mut Vec<f32>) -> CmdResult<bool> {
        if self.past_end {
            return Ok(false);
        }
        self.src.next_block(out)
    }

    fn seek(&mut self, sec: f64) -> CmdResult<()> {
        self.past_end = false;
        match self.seek_mp3(sec) {
            Some(Ok(Some(src))) => {
                self.src = src;
                Ok(())
            }
            Some(Ok(None)) => {
                self.past_end = true;
                Ok(())
            }
            Some(Err(e)) => Err(e),
            None => self.src.seek(sec),
        }
    }

    fn duration(&self) -> (f64, bool) {
        if let Some(m) = &self.mp3 {
            if let Some(count) = m.index.frame_count() {
                let raw = count as u64 * u64::from(m.index.samples_per_frame());
                let delay = u64::from(m.delay);
                // Symphonia leaves out the padding only where the Xing frame's count is right.
                let trimmed = raw.saturating_sub(delay + u64::from(m.padding));
                let frames = if m.n_frames == Some(trimmed) { trimmed } else { raw.saturating_sub(delay) };
                return (frames as f64 / f64::from(self.rate.max(1)), true);
            }
        }
        (self.estimate, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Option<PathBuf> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name);
        p.exists().then_some(p)
    }

    /// The whole track, decoded from the start.
    fn decode_all(t: &mut dyn Decode) -> Vec<f32> {
        let mut all = Vec::new();
        while t.next(&mut all).unwrap() {}
        all
    }

    /// The first `n` samples after a jump to `sec`.
    fn after_jump(t: &mut dyn Decode, sec: f64, n: usize) -> Vec<f32> {
        t.seek(sec).unwrap();
        let mut got = Vec::new();
        while got.len() < n && t.next(&mut got).unwrap() {}
        got.truncate(n);
        got
    }

    fn wait_exact(t: &Track) -> f64 {
        for _ in 0..500 {
            let (d, exact) = t.duration();
            if exact {
                return d;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("frame index not ready");
    }

    /// The samples after a jump are the samples a decode from the start has
    /// at that place: the jump lands on the exact sample, forwards and back.
    fn jumps_land_on_the_sample(media: Media) {
        let mut whole = Track::open(media.clone()).unwrap();
        let all = decode_all(&mut whole);
        let ch = whole.channels();
        let rate = whole.rate() as f64;
        let mut t = Track::open(media).unwrap();
        let len = wait_exact(&t);
        // The exact length is what decoding from the start gives.
        assert!((len - (all.len() / ch) as f64 / rate).abs() < 0.5 / rate, "length {len} vs {}", (all.len() / ch) as f64 / rate);
        for &sec in &[len * 0.7, 1.0, len * 0.31, 0.0, 0.0123, len * 0.9] {
            let at = (sec * rate).round() as usize * ch;
            let n = 2000.min(all.len() - at);
            let got = after_jump(&mut t, sec, n);
            assert_eq!(got.len(), n, "at {sec}");
            let worst = got.iter().zip(&all[at..at + n]).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
            assert!(worst < 1e-4, "jump to {sec}: off by {worst}");
        }
        // Past the end: nothing more.
        assert!(after_jump(&mut t, len + 5.0, 10).is_empty());
    }

    #[test]
    fn jumps_exactly_in_a_vbr_mp3_without_table_of_contents() {
        let Some(p) = fixture("library/vbr-no-xing.mp3") else { return };
        jumps_land_on_the_sample(Media::File(p));
    }

    #[test]
    fn jumps_exactly_in_an_mp3_with_lame_frame() {
        let Some(p) = fixture("library/tagged.mp3") else { return };
        let t = Track::open(Media::File(p.clone())).unwrap();
        assert!(t.mp3.as_ref().is_some_and(|m| m.delay > 0), "fixture has a LAME delay");
        jumps_land_on_the_sample(Media::File(p));
    }

    #[test]
    fn plays_and_jumps_in_data_from_memory() {
        let Some(p) = fixture("library/vbr-no-xing.mp3") else { return };
        let data: Arc<[u8]> = std::fs::read(&p).unwrap().into();
        jumps_land_on_the_sample(Media::Memory { data, name: PathBuf::from("vorschau.mp3") });
    }

    #[test]
    fn jumps_exactly_in_other_formats() {
        let Some(dir) = fixture("library") else { return };
        for entry in std::fs::read_dir(dir).unwrap() {
            let p = entry.unwrap().path();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            // chain.ogg is two Ogg streams one after the other: symphonia's
            // Ogg reader seeks within the first stream only.
            if !["flac", "wav", "ogg", "m4a", "m4b"].contains(&ext.as_str()) || p.file_name().is_some_and(|n| n == "chain.ogg") {
                continue;
            }
            let Ok(mut whole) = Track::open(Media::File(p.clone())) else { continue };
            let all = decode_all(&mut whole);
            let (ch, rate) = (whole.channels(), whole.rate() as f64);
            let frames = all.len() / ch;
            if frames < rate as usize {
                continue;
            }
            let mut t = Track::open(Media::File(p.clone())).unwrap();
            for &sec in &[frames as f64 / rate * 0.6, 0.25] {
                let at = (sec * rate).round() as usize * ch;
                let n = 1000.min(all.len() - at);
                let got = after_jump(&mut t, sec, n);
                let worst = got.iter().zip(&all[at..at + n]).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
                // AAC decodes the frame before a jump differently (no overlap), so only lossless formats must match exactly.
                let limit = if ext.starts_with("m4") || ext == "ogg" { 0.05 } else { 1e-4 };
                assert!(worst < limit, "{}: jump to {sec} off by {worst}", p.display());
            }
        }
    }
}
