/**
 * Binary IPC helpers. Raw command replies arrive as ArrayBuffer; replies
 * that carry metadata plus bytes use the "TSB1" frame written by
 * src-tauri/src/framing.rs:
 *
 *   "TSB1" | u32 LE json length N | N bytes JSON | 0–3 zero bytes | payload
 *
 * The payload starts at a multiple of 4, so f32 data can be viewed in place.
 */

const MAGIC = [0x54, 0x53, 0x42, 0x31]; // "TSB1"

/** Accepts what Tauri may hand back for raw replies. */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value === null || value === undefined) return new Uint8Array(0);
  throw new TypeError('expected binary data');
}

export interface Frame<T> {
  header: T;
  payload: Uint8Array;
}

export function parseFrame<T>(value: unknown): Frame<T> {
  const bytes = toBytes(value);
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new TypeError('not a TSB1 frame');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(4, true);
  if (8 + jsonLength > bytes.length) throw new TypeError('truncated TSB1 frame');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength))) as T;
  const offset = Math.ceil((8 + jsonLength) / 4) * 4;
  return { header, payload: bytes.subarray(Math.min(offset, bytes.length)) };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Little-endian f32 samples; a zero-copy view when alignment allows. */
export function f32FromBytes(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 4);
  if (LITTLE_ENDIAN && bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, count);
  }
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Splits interleaved samples into one array per channel. */
export function deinterleave(samples: Float32Array, channels: number): Float32Array[] {
  const frames = Math.floor(samples.length / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out[c][f] = samples[f * channels + c];
  }
  return out;
}

/** Bytes of a Uint8Array or Blob slice. */
export async function sliceBytes(data: Uint8Array | Blob, start: number, end: number): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data.subarray(start, end);
  return new Uint8Array(await data.slice(start, end).arrayBuffer());
}
