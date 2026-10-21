//! Where each frame of an MP3 starts, for jumps that land exactly where the
//! bar says, also in a ten-hour audio book and in VBR files without a table
//! of contents.
//!
//! MP3 frames carry no time stamps: the place of a frame is its number
//! times the samples per frame. Symphonia finds a place either by counting
//! frames from the start (exact, but it reads the whole file up to there on
//! every jump backwards) or by guessing a byte position from the average
//! bit rate (quick, but off in VBR files). So the player reads the frame
//! headers once, in a thread of its own while the track already plays, and
//! keeps their byte positions. Reading only headers goes at the speed of the
//! card; a jump waits for it only when it goes further than read so far.

use std::io::{Read, Seek, SeekFrom};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// What one frame header says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    /// 1 (MPEG-1), 2 (MPEG-2) or 25 (MPEG-2.5).
    pub version: u8,
    pub layer: u8,
    pub sample_rate: u32,
    /// Length of the whole frame in bytes, header included.
    pub len: usize,
    pub samples: u32,
    pub mono: bool,
}

const BITRATES_V1: [[u32; 15]; 3] = [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
];
const BITRATES_V2: [[u32; 15]; 3] = [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];

/// Reads a frame header; None for anything that is not one. Free-format
/// frames (no bit rate in the header) count as none: their length is not
/// in the header, and the player then seeks the way symphonia does.
pub fn parse_header(b: [u8; 4]) -> Option<FrameHeader> {
    let h = u32::from_be_bytes(b);
    if h & 0xFFE0_0000 != 0xFFE0_0000 {
        return None;
    }
    let version = match (h >> 19) & 3 {
        0 => 25,
        2 => 2,
        3 => 1,
        _ => return None,
    };
    let layer = match (h >> 17) & 3 {
        1 => 3,
        2 => 2,
        3 => 1,
        _ => return None,
    };
    let bitrate_index = ((h >> 12) & 0xF) as usize;
    let rate_index = ((h >> 10) & 3) as usize;
    if bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
        return None;
    }
    let table = if version == 1 { &BITRATES_V1 } else { &BITRATES_V2 };
    let kbps = table[usize::from(layer - 1)][bitrate_index];
    let base = [44100, 48000, 32000][rate_index];
    let sample_rate = match version {
        1 => base,
        2 => base / 2,
        _ => base / 4,
    };
    let padding = ((h >> 9) & 1) as usize;
    let bps = kbps as usize * 1000;
    let sr = sample_rate as usize;
    let (len, samples) = match layer {
        1 => ((12 * bps / sr + padding) * 4, 384),
        2 => (144 * bps / sr + padding, 1152),
        _ if version == 1 => (144 * bps / sr + padding, 1152),
        _ => (72 * bps / sr + padding, 576),
    };
    if len < 21 {
        return None;
    }
    Some(FrameHeader { version, layer, sample_rate, len, samples, mono: (h >> 6) & 3 == 3 })
}

/// Two headers of the same stream (a joined file may change the bit rate, mono or stereo, not the version).
fn same_stream(a: &FrameHeader, b: &FrameHeader) -> bool {
    a.version == b.version && a.layer == b.layer
}

/// The Xing, Info or VBRI frame at the start of many files: no audio, so it
/// is no frame of the track (symphonia leaves it out too).
fn is_info_frame(h: &FrameHeader, frame: &[u8]) -> bool {
    if h.layer != 3 {
        return false;
    }
    let side = match (h.version == 1, h.mono) {
        (true, true) => 17,
        (true, false) => 32,
        (false, true) => 9,
        (false, false) => 17,
    };
    let at = |o: usize, tag: &[u8]| frame.get(o..o + 4) == Some(tag);
    at(4 + side, b"Xing") || at(4 + side, b"Info") || at(36, b"VBRI")
}

/// Random access to the bytes with a window kept in memory, so reading
/// header after header costs one read per window, not one per frame.
struct Window<R> {
    src: R,
    len: u64,
    at: u64,
    buf: Vec<u8>,
}

const WINDOW: usize = 256 * 1024;

impl<R: Read + Seek> Window<R> {
    fn new(mut src: R) -> std::io::Result<Self> {
        let len = src.seek(SeekFrom::End(0))?;
        Ok(Window { src, len, at: 0, buf: Vec::new() })
    }

    /// `n` bytes at `pos`, or fewer at the end of the file.
    fn get(&mut self, pos: u64, n: usize) -> std::io::Result<&[u8]> {
        let end = (pos + n as u64).min(self.len);
        if pos < self.at || end > self.at + self.buf.len() as u64 {
            self.src.seek(SeekFrom::Start(pos))?;
            let want = (WINDOW.max(n) as u64).min(self.len - pos) as usize;
            self.buf.resize(want, 0);
            let mut got = 0;
            while got < want {
                match self.src.read(&mut self.buf[got..])? {
                    0 => break,
                    k => got += k,
                }
            }
            self.buf.truncate(got);
            self.at = pos;
        }
        let from = (pos - self.at) as usize;
        let to = ((end - self.at) as usize).min(self.buf.len());
        Ok(&self.buf[from.min(to)..to])
    }

    fn header(&mut self, pos: u64) -> std::io::Result<Option<FrameHeader>> {
        let b = self.get(pos, 4)?;
        Ok(if b.len() == 4 { parse_header([b[0], b[1], b[2], b[3]]) } else { None })
    }
}

/// Length of the ID3v2 tag(s) at the start, 0 without one.
fn id3v2_len<R: Read + Seek>(w: &mut Window<R>) -> std::io::Result<u64> {
    let mut pos = 0u64;
    loop {
        let b = w.get(pos, 10)?;
        if b.len() < 10 || &b[..3] != b"ID3" {
            return Ok(pos);
        }
        let size = b[6..10].iter().fold(0u64, |acc, &x| (acc << 7) | u64::from(x & 0x7F));
        let footer = if b[5] & 0x10 != 0 { 10 } else { 0 };
        pos += 10 + size + footer;
    }
}

/// The next frame at or after `from` that is followed by another one of the
/// same stream (or by the end of the file): how players find their way back
/// after damaged bytes.
fn resync<R: Read + Seek>(w: &mut Window<R>, from: u64) -> std::io::Result<Option<(u64, FrameHeader)>> {
    let mut pos = from;
    while pos + 4 <= w.len {
        let b = w.get(pos, 2)?;
        if b.len() == 2 && b[0] == 0xFF && b[1] & 0xE0 == 0xE0 {
            if let Some(h) = w.header(pos)? {
                let next = pos + h.len as u64;
                if next + 4 > w.len {
                    return Ok(Some((pos, h)));
                }
                if w.header(next)?.is_some_and(|n| same_stream(&h, &n)) {
                    return Ok(Some((pos, h)));
                }
            }
        }
        pos += 1;
    }
    Ok(None)
}

/// The frame positions read so far, and whether the reading is over.
#[derive(Debug, Default)]
pub struct IndexState {
    /// Byte position of each audio frame, in order.
    pub frames: Vec<u64>,
    pub samples_per_frame: u32,
    pub sample_rate: u32,
    /// All frames are read.
    pub done: bool,
    /// The positions cannot be trusted for jumps (free format, frames of
    /// another length per frame): the player seeks the way symphonia does.
    pub unusable: bool,
}

/// The index, filled by the reading thread, read by the player.
#[derive(Debug, Default)]
pub struct Mp3Index {
    state: Mutex<IndexState>,
    ready: Condvar,
}

/// Frames added to the index at once (one lock per batch).
const BATCH: usize = 2048;

impl Mp3Index {
    /// Reads all frame headers of `src` into the index. Stops early (with
    /// what it has, marked done) when `stop` says so.
    pub fn build<R: Read + Seek>(&self, src: R, stop: impl Fn() -> bool) {
        let result = self.scan(src, &stop);
        let mut st = self.lock();
        if result.is_err() {
            st.unusable = st.frames.is_empty();
        }
        st.done = true;
        drop(st);
        self.ready.notify_all();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, IndexState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn scan<R: Read + Seek>(&self, src: R, stop: &impl Fn() -> bool) -> std::io::Result<()> {
        let mut w = Window::new(src)?;
        let start = id3v2_len(&mut w)?;
        let Some((mut pos, first)) = resync(&mut w, start)? else {
            self.lock().unusable = true;
            return Ok(());
        };
        {
            let mut st = self.lock();
            st.samples_per_frame = first.samples;
            st.sample_rate = first.sample_rate;
        }
        let mut batch = Vec::with_capacity(BATCH);
        let mut first_frame = true;
        loop {
            let h = match w.header(pos)? {
                Some(h) if same_stream(&first, &h) => h,
                _ => {
                    // Not a frame where one should be: the end, a tag at the
                    // end, or damaged bytes to find the way through.
                    let tail = w.get(pos, 8)?;
                    if tail.len() < 4 || tail.starts_with(b"TAG") || tail.starts_with(b"APETAGEX") || tail.starts_with(b"LYRICS") {
                        break;
                    }
                    match resync(&mut w, pos + 1)? {
                        Some((p, h)) if same_stream(&first, &h) => {
                            pos = p;
                            h
                        }
                        _ => break,
                    }
                }
            };
            if pos + h.len as u64 > w.len {
                // A frame cut off at the end: symphonia drops it too.
                break;
            }
            if h.samples != first.samples || h.sample_rate != first.sample_rate {
                // A part in another format (joined files): frame numbers no longer give the time.
                self.lock().unusable = true;
                return Ok(());
            }
            let info = first_frame && is_info_frame(&h, w.get(pos, h.len.min(64))?);
            first_frame = false;
            if !info {
                batch.push(pos);
            }
            pos += h.len as u64;
            if batch.len() >= BATCH {
                if stop() {
                    break;
                }
                self.lock().frames.append(&mut batch);
                self.ready.notify_all();
            }
        }
        self.lock().frames.append(&mut batch);
        Ok(())
    }

    /// Byte position of frame `k`, waiting up to `wait` for the reading to
    /// get there. None when the file has fewer frames, the index cannot be
    /// used, or the reading is too slow.
    pub fn frame_pos(&self, k: usize, wait: Duration) -> Option<u64> {
        let until = Instant::now() + wait;
        let mut st = self.lock();
        loop {
            if st.unusable {
                return None;
            }
            if let Some(&p) = st.frames.get(k) {
                return Some(p);
            }
            if st.done {
                return None;
            }
            let left = until.checked_duration_since(Instant::now())?;
            st = self.ready.wait_timeout(st, left).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    /// The number of audio frames, once all are read and usable.
    pub fn frame_count(&self) -> Option<usize> {
        let st = self.lock();
        (st.done && !st.unusable).then_some(st.frames.len())
    }

    pub fn samples_per_frame(&self) -> u32 {
        self.lock().samples_per_frame
    }
}

/// Where a jump to `frame` (counted without the encoder's delay) starts
/// reading: the frame that holds it, a few frames earlier so the decoder has
/// the bit reservoir and the overlap of the frames before, and how many
/// samples to skip from there.
pub fn seek_plan(frame: u64, delay: u32, samples_per_frame: u32, preroll: u64) -> (u64, u64) {
    let raw = frame + u64::from(delay);
    let spf = u64::from(samples_per_frame.max(1));
    let k = raw / spf;
    let first = k.saturating_sub(preroll);
    (first, raw - first * spf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Silent MPEG-1 Layer III frames at 44.1 kHz with the given bit rate index (9 = 128 kbit/s).
    fn frame(index: u8, padded: bool) -> Vec<u8> {
        let h = [0xFF, 0xFB, (index << 4) | if padded { 2 } else { 0 }, 0xC0];
        let len = parse_header(h).unwrap().len;
        let mut f = vec![0u8; len];
        f[..4].copy_from_slice(&h);
        f
    }

    fn built(bytes: Vec<u8>) -> Mp3Index {
        let idx = Mp3Index::default();
        idx.build(Cursor::new(bytes), || false);
        idx
    }

    #[test]
    fn reads_frame_lengths_of_all_versions_and_layers() {
        // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: 417 bytes, 418 padded.
        assert_eq!(parse_header([0xFF, 0xFB, 0x90, 0x00]).unwrap().len, 417);
        assert_eq!(parse_header([0xFF, 0xFB, 0x92, 0x00]).unwrap().len, 418);
        // MPEG-2 Layer III, 64 kbit/s, 22.05 kHz: 576 samples per frame.
        let h = parse_header([0xFF, 0xF3, 0x80, 0x00]).unwrap();
        assert_eq!((h.version, h.sample_rate, h.samples, h.len), (2, 22050, 576, 208));
        // MPEG-1 Layer II, 192 kbit/s, 48 kHz.
        let h = parse_header([0xFF, 0xFD, 0xA4, 0x00]).unwrap();
        assert_eq!((h.layer, h.sample_rate, h.samples, h.len), (2, 48000, 1152, 576));
        // Layer I, 384 kbit/s, 44.1 kHz: slots of four bytes.
        let h = parse_header([0xFF, 0xFF, 0xC0, 0x00]).unwrap();
        assert_eq!((h.layer, h.samples, h.len), (1, 384, 416));
        // MPEG-2.5, 8 kHz.
        assert_eq!(parse_header([0xFF, 0xE3, 0x18, 0x00]).unwrap().sample_rate, 8000);
        // Free format, bad bit rate, reserved rate, no sync.
        assert!(parse_header([0xFF, 0xFB, 0x00, 0x00]).is_none());
        assert!(parse_header([0xFF, 0xFB, 0xF0, 0x00]).is_none());
        assert!(parse_header([0xFF, 0xFB, 0x9C, 0x00]).is_none());
        assert!(parse_header([0x49, 0x44, 0x33, 0x04]).is_none());
    }

    #[test]
    fn indexes_vbr_frames_behind_a_tag_and_skips_the_info_frame() {
        let mut bytes = b"ID3\x04\x00\x00\x00\x00\x00\x0A".to_vec();
        bytes.extend_from_slice(&[0u8; 10]);
        let mut info = frame(9, false);
        info[4 + 17..4 + 21].copy_from_slice(b"Info");
        bytes.extend_from_slice(&info);
        let mut expected = Vec::new();
        // Bit rates that change from frame to frame, as in a VBR file.
        for i in 0..5000usize {
            expected.push(bytes.len() as u64);
            bytes.extend_from_slice(&frame([1, 5, 9, 14][i % 4], i % 3 == 0));
        }
        bytes.extend_from_slice(b"TAG");
        bytes.extend_from_slice(&[0u8; 125]);
        let idx = built(bytes);
        assert_eq!(idx.frame_count(), Some(5000));
        for k in [0, 1, 2, 2047, 2048, 4999] {
            assert_eq!(idx.frame_pos(k, Duration::ZERO), Some(expected[k]), "frame {k}");
        }
        assert_eq!(idx.frame_pos(5000, Duration::ZERO), None);
        assert_eq!(idx.samples_per_frame(), 1152);
    }

    #[test]
    fn finds_its_way_through_damaged_bytes() {
        let mut bytes = Vec::new();
        let mut expected = Vec::new();
        for i in 0..30 {
            if i == 10 {
                bytes.extend_from_slice(&[0xFF, 0x00, 0x12, 0xFF, 0xFB, 0x00]);
            }
            expected.push(bytes.len() as u64);
            bytes.extend_from_slice(&frame(9, false));
        }
        let idx = built(bytes);
        assert_eq!(idx.frame_count(), Some(30));
        assert_eq!(idx.frame_pos(10, Duration::ZERO), Some(expected[10]));
        assert_eq!(idx.frame_pos(29, Duration::ZERO), Some(expected[29]));
    }

    #[test]
    fn gives_up_on_parts_in_another_format() {
        let mut bytes = Vec::new();
        for _ in 0..10 {
            bytes.extend_from_slice(&frame(9, false));
        }
        // MPEG-1 at 48 kHz joined on.
        for _ in 0..10 {
            let h = [0xFF, 0xFB, 0x94, 0xC0];
            let mut f = vec![0u8; parse_header(h).unwrap().len];
            f[..4].copy_from_slice(&h);
            bytes.extend_from_slice(&f);
        }
        let idx = built(bytes);
        assert_eq!(idx.frame_count(), None);
        assert_eq!(idx.frame_pos(0, Duration::ZERO), None);
    }

    #[test]
    fn a_jump_waits_for_the_reading_thread() {
        let idx = std::sync::Arc::new(Mp3Index::default());
        let mut bytes = Vec::new();
        for _ in 0..(BATCH * 3) {
            bytes.extend_from_slice(&frame(9, false));
        }
        let reader = idx.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            reader.build(Cursor::new(bytes), || false);
        });
        assert_eq!(idx.frame_pos(BATCH * 3 - 1, Duration::from_secs(5)), Some(((BATCH * 3 - 1) * 417) as u64));
        t.join().unwrap();
        // Too slow: no answer rather than a wrong one.
        let empty = Mp3Index::default();
        assert_eq!(empty.frame_pos(0, Duration::from_millis(5)), None);
    }

    #[test]
    fn plans_a_jump_with_preroll_and_delay() {
        // Sample 0 of the track is sample 1105 of the raw stream (LAME's delay of 576 + 529).
        assert_eq!(seek_plan(0, 1105, 1152, 8), (0, 1105));
        // 10 s at 44.1 kHz: raw sample 442105 is in frame 383, 889 samples into it.
        let (first, skip) = seek_plan(441_000, 1105, 1152, 8);
        assert_eq!(first, 375);
        assert_eq!(skip, 442_105 - 375 * 1152);
        assert_eq!(skip - 8 * 1152, 442_105 - 383 * 1152);
    }
}
