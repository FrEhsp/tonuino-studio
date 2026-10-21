//! Binary responses that carry JSON metadata plus raw bytes in one IPC reply.
//!
//! Layout (all little endian):
//!   0  "TSB1"           magic
//!   4  u32               length N of the JSON header in bytes
//!   8  N bytes           UTF-8 JSON header
//!   …  0–3 zero bytes    padding so the payload starts at a multiple of 4
//!   …  payload           raw bytes (e.g. f32 LE samples, an HTTP body)
//!
//! The padding lets the bridge view f32 payloads without copying.

use serde::Serialize;

pub const MAGIC: &[u8; 4] = b"TSB1";

pub fn payload_offset(json_len: usize) -> usize {
    (8 + json_len).div_ceil(4) * 4
}

pub fn frame<T: Serialize>(header: &T, payload: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(header).unwrap_or_else(|_| b"{}".to_vec());
    let offset = payload_offset(json.len());
    let mut out = Vec::with_capacity(offset + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.resize(offset, 0);
    out.extend_from_slice(payload);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_with_aligned_payload() {
        for json_text in ["", "x", "xy", "xyz", "wxyz"] {
            let out = frame(&json_text, &[1, 2, 3]);
            assert_eq!(&out[..4], MAGIC);
            let n = u32::from_le_bytes(out[4..8].try_into().unwrap()) as usize;
            let json: String = serde_json::from_slice(&out[8..8 + n]).unwrap();
            assert_eq!(json, json_text);
            let off = payload_offset(n);
            assert_eq!(off % 4, 0);
            assert_eq!(&out[off..], &[1, 2, 3]);
        }
    }
}
