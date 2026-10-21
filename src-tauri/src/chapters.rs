//! Chapter marks of audiobooks. Symphonia does not expose them, so they are
//! read here directly:
//! - MP4/M4B: QuickTime chapter track (`tref/chap` → text track) and Nero `chpl`,
//! - MP3: ID3v2 `CHAP` frames,
//! - Ogg/FLAC: `CHAPTERxxx` / `CHAPTERxxxNAME` Vorbis comments,
//! - FLAC without those: the tracks of an embedded CD cue sheet.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAX_MOOV: u64 = 128 * 1024 * 1024;
const MAX_ID3: usize = 64 * 1024 * 1024;
const MAX_CHAPTERS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub start_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

fn clean_title(s: String) -> Option<String> {
    let t = s.trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
    (!t.is_empty()).then_some(t)
}

fn finish(mut chapters: Vec<Chapter>) -> Vec<Chapter> {
    chapters.retain(|c| c.start_sec.is_finite() && c.start_sec >= 0.0);
    chapters.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
    chapters.truncate(MAX_CHAPTERS);
    chapters
}

/// Reads chapters from the file, choosing the parser from its signature.
pub fn read_chapters(path: &Path) -> Vec<Chapter> {
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    let mut head = [0u8; 12];
    if f.read_exact(&mut head).is_err() {
        return Vec::new();
    }
    let chapters = if &head[4..8] == b"ftyp" {
        mp4_chapters(&mut f).unwrap_or_default()
    } else if &head[..3] == b"ID3" {
        id3_chapters(&mut f).unwrap_or_default()
    } else {
        Vec::new()
    };
    finish(chapters)
}

/// `CHAPTER001=00:01:02.500` and `CHAPTER001NAME=Title` comments.
pub fn chapters_from_tags(tags: &[(String, String)]) -> Vec<Chapter> {
    let mut found: Vec<(String, f64)> = Vec::new();
    for (k, v) in tags {
        let key = k.to_ascii_uppercase();
        if let Some(num) = key.strip_prefix("CHAPTER") {
            if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) {
                if let Some(t) = parse_timestamp(v) {
                    found.push((num.to_string(), t));
                }
            }
        }
    }
    let chapters = found
        .into_iter()
        .map(|(num, start)| {
            let name_key = format!("CHAPTER{num}NAME");
            let title = tags.iter().find(|(k, _)| k.eq_ignore_ascii_case(&name_key)).and_then(|(_, v)| clean_title(v.clone()));
            Chapter { start_sec: start, title }
        })
        .collect();
    finish(chapters)
}

/// "HH:MM:SS.mmm", "MM:SS.mmm" or seconds.
fn parse_timestamp(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for p in &parts {
        let v: f64 = p.parse().ok()?;
        if v < 0.0 {
            return None;
        }
        total = total * 60.0 + v;
    }
    Some(total)
}

/* ------------------------------------------------------------------ MP4 */

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be64(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8).map(|s| u64::from_be_bytes(s.try_into().unwrap_or([0; 8])))
}

/// Iterates the child boxes of a box payload: (type, payload).
fn boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size32 = be32(data, pos).unwrap_or(0) as u64;
        let kind: [u8; 4] = data[pos + 4..pos + 8].try_into().unwrap_or([0; 4]);
        let (size, header) = match size32 {
            0 => ((data.len() - pos) as u64, 8),
            1 => match be64(data, pos + 8) {
                Some(s) => (s, 16),
                None => break,
            },
            s => (s, 8),
        };
        if size < header as u64 || pos as u64 + size > data.len() as u64 {
            break;
        }
        out.push((kind, &data[pos + header..pos + size as usize]));
        pos += size as usize;
    }
    out
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).into_iter().find(|(k, _)| k == kind).map(|(_, p)| p)
}

/// Nero chapters: moov/udta/chpl.
pub fn parse_chpl(p: &[u8]) -> Vec<Chapter> {
    let mut out = Vec::new();
    let Some(&version) = p.first() else { return out };
    let mut pos = 4 + if version != 0 { 4 } else { 0 };
    let Some(&count) = p.get(pos) else { return out };
    pos += 1;
    for _ in 0..count {
        let (Some(start), Some(&len)) = (be64(p, pos), p.get(pos + 8)) else { break };
        let Some(title) = p.get(pos + 9..pos + 9 + len as usize) else { break };
        out.push(Chapter {
            start_sec: start as f64 / 10_000_000.0,
            title: clean_title(String::from_utf8_lossy(title).into_owned()),
        });
        pos += 9 + len as usize;
    }
    out
}

#[derive(Default, Debug)]
struct Trak {
    id: u32,
    chap_refs: Vec<u32>,
    handler: [u8; 4],
    timescale: u32,
    /// (sample count, delta)
    stts: Vec<(u32, u32)>,
    /// (first chunk, samples per chunk)
    stsc: Vec<(u32, u32)>,
    sample_size: u32,
    sizes: Vec<u32>,
    chunk_offsets: Vec<u64>,
}

fn full_box_entries(p: &[u8], entry_size: usize) -> Option<(u32, &[u8])> {
    let count = be32(p, 4)?;
    let table = p.get(8..)?;
    let n = (count as usize).min(table.len() / entry_size);
    Some((n as u32, &table[..n * entry_size]))
}

fn parse_trak(t: &[u8]) -> Trak {
    let mut trak = Trak::default();
    if let Some(tkhd) = child(t, b"tkhd") {
        let at = if tkhd.first() == Some(&1) { 20 } else { 12 };
        trak.id = be32(tkhd, at).unwrap_or(0);
    }
    if let Some(chap) = child(t, b"tref").and_then(|tref| child(tref, b"chap")) {
        trak.chap_refs = chap.chunks_exact(4).map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]])).collect();
    }
    let Some(mdia) = child(t, b"mdia") else { return trak };
    if let Some(mdhd) = child(mdia, b"mdhd") {
        let at = if mdhd.first() == Some(&1) { 20 } else { 12 };
        trak.timescale = be32(mdhd, at).unwrap_or(0);
    }
    if let Some(hdlr) = child(mdia, b"hdlr") {
        if let Some(h) = hdlr.get(8..12) {
            trak.handler.copy_from_slice(h);
        }
    }
    let Some(stbl) = child(mdia, b"minf").and_then(|m| child(m, b"stbl")) else { return trak };
    if let Some((_, table)) = child(stbl, b"stts").and_then(|p| full_box_entries(p, 8)) {
        trak.stts = table.chunks_exact(8).map(|e| (be32(e, 0).unwrap_or(0), be32(e, 4).unwrap_or(0))).collect();
    }
    if let Some((_, table)) = child(stbl, b"stsc").and_then(|p| full_box_entries(p, 12)) {
        trak.stsc = table.chunks_exact(12).map(|e| (be32(e, 0).unwrap_or(0), be32(e, 4).unwrap_or(0))).collect();
    }
    if let Some(stsz) = child(stbl, b"stsz") {
        trak.sample_size = be32(stsz, 4).unwrap_or(0);
        if trak.sample_size == 0 {
            if let (Some(count), Some(table)) = (be32(stsz, 8), stsz.get(12..)) {
                let n = (count as usize).min(table.len() / 4);
                trak.sizes = table[..n * 4].chunks_exact(4).map(|e| be32(e, 0).unwrap_or(0)).collect();
            }
        }
    }
    if let Some((_, table)) = child(stbl, b"stco").and_then(|p| full_box_entries(p, 4)) {
        trak.chunk_offsets = table.chunks_exact(4).map(|e| be32(e, 0).unwrap_or(0) as u64).collect();
    } else if let Some((_, table)) = child(stbl, b"co64").and_then(|p| full_box_entries(p, 8)) {
        trak.chunk_offsets = table.chunks_exact(8).map(|e| be64(e, 0).unwrap_or(0)).collect();
    }
    trak
}

/// (file offset, size, start time in timescale units) of every sample.
fn sample_table(t: &Trak) -> Vec<(u64, u32, u64)> {
    let mut times = Vec::new();
    let mut time = 0u64;
    'outer: for &(count, delta) in &t.stts {
        for _ in 0..count {
            if times.len() >= MAX_CHAPTERS {
                break 'outer;
            }
            times.push(time);
            time += delta as u64;
        }
    }
    let n = times.len();
    let mut out = Vec::with_capacity(n);
    let mut sample = 0usize;
    for (ci, &chunk_offset) in t.chunk_offsets.iter().enumerate() {
        let chunk_no = ci as u32 + 1;
        let per_chunk = t.stsc.iter().rev().find(|(first, _)| *first <= chunk_no).map(|(_, s)| *s).unwrap_or(1);
        let mut offset = chunk_offset;
        for _ in 0..per_chunk {
            if sample >= n {
                return out;
            }
            let size = if t.sample_size != 0 { t.sample_size } else { t.sizes.get(sample).copied().unwrap_or(0) };
            out.push((offset, size, times[sample]));
            offset += size as u64;
            sample += 1;
        }
    }
    out
}

/// Text sample: u16 length + UTF-8 or UTF-16 (with BOM) text.
pub fn decode_text_sample(s: &[u8]) -> Option<String> {
    let len = u16::from_be_bytes([*s.first()?, *s.get(1)?]) as usize;
    let text = s.get(2..2 + len.min(s.len().saturating_sub(2)))?;
    let decoded = if text.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = text[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else if text.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = text[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(text).into_owned()
    };
    clean_title(decoded)
}

fn qt_chapters(f: &mut File, traks: &[Trak]) -> Option<Vec<Chapter>> {
    let ids: Vec<u32> = traks.iter().flat_map(|t| t.chap_refs.iter().copied()).collect();
    let track = traks.iter().find(|t| ids.contains(&t.id) && t.timescale > 0)?;
    let mut out = Vec::new();
    for (offset, size, time) in sample_table(track) {
        let mut buf = vec![0u8; (size as usize).min(4096)];
        f.seek(SeekFrom::Start(offset)).ok()?;
        f.read_exact(&mut buf).ok()?;
        out.push(Chapter { start_sec: time as f64 / track.timescale as f64, title: decode_text_sample(&buf) });
    }
    (!out.is_empty()).then_some(out)
}

/// The payload of the `moov` box, wherever it is in the file.
fn read_moov(f: &mut File) -> Option<Vec<u8>> {
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let mut h = [0u8; 16];
        f.read_exact(&mut h[..8]).ok()?;
        let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        let (size, header) = match size32 {
            0 => (len - pos, 8),
            1 => {
                f.read_exact(&mut h[8..16]).ok()?;
                (u64::from_be_bytes(h[8..16].try_into().ok()?), 16)
            }
            s => (s, 8),
        };
        if size < header {
            return None;
        }
        if &h[4..8] == b"moov" {
            if size > MAX_MOOV {
                return None;
            }
            let mut moov = vec![0u8; (size - header) as usize];
            f.read_exact(&mut moov).ok()?;
            return Some(moov);
        }
        pos += size;
    }
    None
}

fn mp4_chapters(f: &mut File) -> Option<Vec<Chapter>> {
    let moov = read_moov(f)?;
    let traks: Vec<Trak> = boxes(&moov).into_iter().filter(|(k, _)| k == b"trak").map(|(_, p)| parse_trak(p)).collect();
    if let Some(ch) = qt_chapters(f, &traks) {
        return Some(ch);
    }
    let chpl = child(&moov, b"udta").and_then(|u| child(u, b"chpl")).map(parse_chpl).unwrap_or_default();
    Some(chpl)
}

/// Whether an MP4 holds copy protected audio: FairPlay (`drms`, `drmi`),
/// Audible (`aavd`, the `aax` brand) or encrypted (`enca`) sample entries.
/// Symphonia does not list such tracks at all.
pub fn mp4_is_protected(path: &Path) -> bool {
    let Ok(mut f) = File::open(path) else { return false };
    let mut head = [0u8; 12];
    if f.read_exact(&mut head).is_err() || &head[4..8] != b"ftyp" {
        return false;
    }
    if &head[8..12] == b"aax " {
        return true;
    }
    let Some(moov) = read_moov(&mut f) else { return false };
    boxes(&moov).into_iter().filter(|(k, _)| k == b"trak").any(|(_, t)| {
        let stsd = child(t, b"mdia").and_then(|m| child(m, b"minf")).and_then(|m| child(m, b"stbl")).and_then(|s| child(s, b"stsd"));
        // A full box with an entry count, then the sample entries.
        let entries = stsd.and_then(|p| p.get(8..)).unwrap_or(&[]);
        boxes(entries).iter().any(|(kind, _)| matches!(kind, b"drms" | b"drmi" | b"aavd" | b"enca"))
    })
}

/* ----------------------------------------------------------------- FLAC */

/// FLAC: one chapter per track of an embedded CD cue sheet (a CD or a book
/// ripped to one file). Like the browser, only for files without CHAPTER comments.
pub fn flac_cue_chapters(path: &Path) -> Vec<Chapter> {
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    finish(flac_cue(&mut f).unwrap_or_default())
}

fn flac_cue(f: &mut File) -> Option<Vec<Chapter>> {
    let mut h = [0u8; 10];
    f.read_exact(&mut h).ok()?;
    let mut pos = 0u64;
    if &h[..3] == b"ID3" {
        // An ID3v2 tag in front (header, body, footer when flagged).
        pos = 10 + syncsafe(&h[6..10]) as u64 + if h[5] & 0x10 != 0 { 10 } else { 0 };
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut h[..4]).ok()?;
    }
    if &h[..4] != b"fLaC" {
        return None;
    }
    pos += 4;
    let (mut rate, mut cue) = (0u32, None);
    loop {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let mut b = [0u8; 4];
        f.read_exact(&mut b).ok()?;
        let len = u32::from_be_bytes([0, b[1], b[2], b[3]]) as usize;
        match b[0] & 0x7f {
            0 if len >= 18 => {
                let mut info = [0u8; 18];
                f.read_exact(&mut info).ok()?;
                rate = (u32::from(info[10]) << 12) | (u32::from(info[11]) << 4) | (u32::from(info[12]) >> 4);
            }
            5 if len < 1 << 20 => {
                let mut sheet = vec![0u8; len];
                f.read_exact(&mut sheet).ok()?;
                cue = Some(sheet);
            }
            _ => {}
        }
        if b[0] & 0x80 != 0 {
            break;
        }
        pos += 4 + len as u64;
    }
    (rate > 0).then(|| parse_cue_sheet(&cue.unwrap_or_default(), rate))
}

/// METADATA_BLOCK_CUESHEET: a chapter at each track's INDEX 01 (else its
/// start); the lead-out track (170, 255) is none.
pub fn parse_cue_sheet(b: &[u8], rate: u32) -> Vec<Chapter> {
    // Catalog 128, lead-in 8, flags and reserved 259, then the track count.
    let Some(&count) = b.get(395) else { return Vec::new() };
    let mut out = Vec::new();
    let mut p = 396;
    for _ in 0..count {
        let (Some(offset), Some(&number), Some(&indices)) = (be64(b, p), b.get(p + 8), b.get(p + 35)) else { break };
        p += 36;
        let mut start = offset;
        for _ in 0..indices {
            let (Some(index_offset), Some(&index)) = (be64(b, p), b.get(p + 8)) else { break };
            if index == 1 {
                start = offset.saturating_add(index_offset);
            }
            p += 12;
        }
        if number != 170 && number != 255 {
            out.push(Chapter { start_sec: start as f64 / f64::from(rate), title: None });
        }
    }
    out
}

/* ------------------------------------------------------------------ ID3 */

fn syncsafe(b: &[u8]) -> usize {
    b.iter().take(4).fold(0usize, |acc, &x| (acc << 7) | (x & 0x7f) as usize)
}

fn remove_unsync(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        out.push(data[i]);
        if data[i] == 0xFF && data.get(i + 1) == Some(&0x00) {
            i += 1;
        }
        i += 1;
    }
    out
}

fn decode_id3_text(data: &[u8]) -> Option<String> {
    let (&enc, text) = data.split_first()?;
    let s = match enc {
        0 => text.iter().map(|&b| b as char).collect(),
        1 | 2 => {
            let (be, body) = match text {
                [0xFE, 0xFF, rest @ ..] => (true, rest),
                [0xFF, 0xFE, rest @ ..] => (false, rest),
                _ => (enc == 2, text),
            };
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
                .take_while(|u| *u != 0)
                .collect();
            String::from_utf16_lossy(&units)
        }
        _ => String::from_utf8_lossy(text.split(|b| *b == 0).next().unwrap_or(&[])).into_owned(),
    };
    clean_title(s)
}

/// Frames of an ID3v2.3/2.4 tag body: (id, data).
fn id3_frames(tag: &[u8], major: u8) -> Vec<([u8; 4], Vec<u8>)> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos + 10 <= tag.len() {
        let id: [u8; 4] = tag[pos..pos + 4].try_into().unwrap_or([0; 4]);
        if !id.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
            break; // padding
        }
        let size = if major >= 4 { syncsafe(&tag[pos + 4..pos + 8]) } else { be32(tag, pos + 4).unwrap_or(0) as usize };
        let flags = tag[pos + 9];
        let Some(raw) = tag.get(pos + 10..pos + 10 + size) else { break };
        let mut data = raw.to_vec();
        if major >= 4 {
            if flags & 0x02 != 0 {
                data = remove_unsync(&data);
            }
            if flags & 0x01 != 0 && data.len() >= 4 {
                data.drain(..4); // data length indicator
            }
        }
        out.push((id, data));
        pos += 10 + size;
    }
    out
}

pub fn parse_chap(data: &[u8], major: u8) -> Option<Chapter> {
    let end = data.iter().position(|&b| b == 0)?;
    let p = end + 1;
    let start_ms = be32(data, p)?;
    let sub = data.get(p + 16..).unwrap_or(&[]);
    let title = id3_frames(sub, major).into_iter().find(|(id, _)| id == b"TIT2").and_then(|(_, d)| decode_id3_text(&d));
    Some(Chapter { start_sec: start_ms as f64 / 1000.0, title })
}

/// Parses a complete ID3v2 tag (header included).
pub fn parse_id3_chapters(tag: &[u8]) -> Vec<Chapter> {
    if tag.len() < 10 || &tag[..3] != b"ID3" {
        return Vec::new();
    }
    let major = tag[3];
    if major != 3 && major != 4 {
        return Vec::new();
    }
    let flags = tag[5];
    let size = syncsafe(&tag[6..10]);
    let mut body = tag.get(10..10 + size).unwrap_or(&tag[10..]).to_vec();
    if major == 3 && flags & 0x80 != 0 {
        body = remove_unsync(&body);
    }
    let mut start = 0;
    if flags & 0x40 != 0 {
        start = if major == 3 { 4 + be32(&body, 0).unwrap_or(0) as usize } else { syncsafe(body.get(..4).unwrap_or(&[])) };
    }
    let frames = id3_frames(body.get(start..).unwrap_or(&[]), major);
    frames.into_iter().filter(|(id, _)| id == b"CHAP").filter_map(|(_, d)| parse_chap(&d, major)).collect()
}

fn id3_chapters(f: &mut File) -> Option<Vec<Chapter>> {
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut header = [0u8; 10];
    f.read_exact(&mut header).ok()?;
    let size = syncsafe(&header[6..10]);
    if size > MAX_ID3 {
        return None;
    }
    let mut tag = header.to_vec();
    tag.resize(10 + size, 0);
    f.read_exact(&mut tag[10..]).ok()?;
    Some(parse_id3_chapters(&tag))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut b = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(payload);
        b
    }

    fn full(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut p = vec![0, 0, 0, 0];
        p.extend_from_slice(body);
        mp4_box(kind, &p)
    }

    #[test]
    fn parses_nero_chpl() {
        let mut p = vec![1, 0, 0, 0, 0, 0, 0, 0, 2];
        p.extend_from_slice(&0u64.to_be_bytes());
        p.push(5);
        p.extend_from_slice(b"Intro");
        p.extend_from_slice(&(615_000_000u64).to_be_bytes());
        p.push(9);
        p.extend_from_slice(b"Kapitel 1");
        assert_eq!(
            parse_chpl(&p),
            vec![Chapter { start_sec: 0.0, title: Some("Intro".into()) }, Chapter { start_sec: 61.5, title: Some("Kapitel 1".into()) }]
        );
    }

    #[test]
    fn reads_quicktime_chapter_track_from_a_file() {
        // Text samples live in mdat; the chapter track (id 2) is referenced by track 1.
        let samples: Vec<Vec<u8>> = ["Anfang", "Mitte", "Schluss"]
            .iter()
            .map(|t| {
                let mut s = (t.len() as u16).to_be_bytes().to_vec();
                s.extend_from_slice(t.as_bytes());
                s
            })
            .collect();
        let ftyp = mp4_box(b"ftyp", b"M4B \0\0\0\0M4B mp42");
        let mdat_payload: Vec<u8> = samples.concat();
        let mdat = mp4_box(b"mdat", &mdat_payload);
        let mdat_data_offset = (ftyp.len() + 8) as u32;

        let tkhd = |id: u32| {
            let mut b = vec![0u8; 8];
            b.extend_from_slice(&id.to_be_bytes());
            b.extend_from_slice(&[0u8; 68]);
            full(b"tkhd", &b)
        };
        let cat = |parts: &[&[u8]]| -> Vec<u8> { parts.concat() };
        let mdhd = full(b"mdhd", &cat(&[&[0u8; 8], &1000u32.to_be_bytes(), &[0u8; 8]]));
        let hdlr = full(b"hdlr", &cat(&[&[0u8; 4], b"text", &[0u8; 13]]));
        let mut stts_body = 3u32.to_be_bytes().to_vec();
        for (count, delta) in [(1u32, 60_000u32), (1, 90_500), (1, 1000)] {
            stts_body.extend_from_slice(&count.to_be_bytes());
            stts_body.extend_from_slice(&delta.to_be_bytes());
        }
        let stts = full(b"stts", &stts_body);
        let stsc = full(b"stsc", &cat(&[&1u32.to_be_bytes(), &1u32.to_be_bytes(), &3u32.to_be_bytes(), &1u32.to_be_bytes()]));
        let mut stsz_body = 0u32.to_be_bytes().to_vec();
        stsz_body.extend_from_slice(&3u32.to_be_bytes());
        for s in &samples {
            stsz_body.extend_from_slice(&(s.len() as u32).to_be_bytes());
        }
        let stsz = full(b"stsz", &stsz_body);
        let stco = full(b"stco", &cat(&[&1u32.to_be_bytes(), &mdat_data_offset.to_be_bytes()]));
        let stbl = mp4_box(b"stbl", &[stts, stsc, stsz, stco].concat());
        let minf = mp4_box(b"minf", &stbl);
        let mdia = mp4_box(b"mdia", &[mdhd, hdlr, minf].concat());
        let text_trak = mp4_box(b"trak", &[tkhd(2), mdia].concat());
        let tref = mp4_box(b"tref", &mp4_box(b"chap", &2u32.to_be_bytes()));
        let audio_trak = mp4_box(b"trak", &[tkhd(1), tref].concat());
        let moov = mp4_box(b"moov", &[audio_trak, text_trak].concat());
        let file: Vec<u8> = [ftyp, mdat, moov].concat();

        let path = std::env::temp_dir().join(format!("tonuino-chapters-{}.m4b", std::process::id()));
        std::fs::write(&path, &file).unwrap();
        let ch = read_chapters(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            ch,
            vec![
                Chapter { start_sec: 0.0, title: Some("Anfang".into()) },
                Chapter { start_sec: 60.0, title: Some("Mitte".into()) },
                Chapter { start_sec: 150.5, title: Some("Schluss".into()) },
            ]
        );
    }

    fn id3_frame(id: &[u8; 4], data: &[u8], major: u8) -> Vec<u8> {
        let mut f = id.to_vec();
        if major >= 4 {
            let n = data.len();
            f.extend_from_slice(&[(n >> 21) as u8 & 0x7f, (n >> 14) as u8 & 0x7f, (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]);
        } else {
            f.extend_from_slice(&(data.len() as u32).to_be_bytes());
        }
        f.extend_from_slice(&[0, 0]);
        f.extend_from_slice(data);
        f
    }

    fn chap(id: &str, start_ms: u32, title: &[u8], major: u8) -> Vec<u8> {
        let mut d = id.as_bytes().to_vec();
        d.push(0);
        d.extend_from_slice(&start_ms.to_be_bytes());
        d.extend_from_slice(&(start_ms + 1000).to_be_bytes());
        d.extend_from_slice(&[0xFF; 8]);
        d.extend_from_slice(&id3_frame(b"TIT2", title, major));
        id3_frame(b"CHAP", &d, major)
    }

    fn tag(major: u8, frames: &[Vec<u8>]) -> Vec<u8> {
        let body: Vec<u8> = frames.concat();
        let mut t = b"ID3".to_vec();
        t.extend_from_slice(&[major, 0, 0]);
        let n = body.len() + 20; // padding
        t.extend_from_slice(&[(n >> 21) as u8 & 0x7f, (n >> 14) as u8 & 0x7f, (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]);
        t.extend_from_slice(&body);
        t.extend_from_slice(&[0; 20]);
        t
    }

    #[test]
    fn parses_id3_chap_frames() {
        for major in [3u8, 4] {
            let mut utf16 = vec![1u8, 0xFF, 0xFE];
            for u in "Kapitel 2 – Wald".encode_utf16() {
                utf16.extend_from_slice(&u.to_le_bytes());
            }
            let t = tag(major, &[
                id3_frame(b"TIT2", b"\x03Hoerbuch", major),
                chap("ch1", 125_000, &utf16, major),
                chap("ch0", 0, b"\x03Kapitel 1\0", major),
            ]);
            let ch = finish(parse_id3_chapters(&t));
            assert_eq!(
                ch,
                vec![
                    Chapter { start_sec: 0.0, title: Some("Kapitel 1".into()) },
                    Chapter { start_sec: 125.0, title: Some("Kapitel 2 – Wald".into()) },
                ],
                "ID3v2.{major}"
            );
        }
    }

    #[test]
    fn parses_vorbis_chapter_comments() {
        let tags: Vec<(String, String)> = [
            ("CHAPTER002", "00:10:00.500"),
            ("CHAPTER002NAME", "Teil 2"),
            ("chapter001", "00:00:00.000"),
            ("CHAPTER001NAME", "Teil 1"),
            ("TITLE", "Buch"),
            ("CHAPTER003", "kaputt"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(
            chapters_from_tags(&tags),
            vec![Chapter { start_sec: 0.0, title: Some("Teil 1".into()) }, Chapter { start_sec: 600.5, title: Some("Teil 2".into()) }]
        );
        assert_eq!(parse_timestamp("1:02:03.5"), Some(3723.5));
    }

    #[test]
    fn decodes_text_samples() {
        assert_eq!(decode_text_sample(&[0, 3, b'a', b'b', b'c', 0, 0, 0, 12]), Some("abc".into()));
        assert_eq!(decode_text_sample(&[0, 6, 0xFE, 0xFF, 0, b'h', 0, b'i']), Some("hi".into()));
        assert_eq!(decode_text_sample(&[0]), None);
    }
}
