/**
 * A rough level of every MP3 frame without decoding it, from the Layer III
 * side information: global_gain is the quantizer's step size (1.5 dB a
 * step), which the encoder raises with the loudness of the granule, and a
 * granule without Huffman data (part2_3_length 0) is silence. Read during
 * the frame scan (scanMp3's onFrame), so the trim editor can draw the whole
 * track and find its pauses at once; the real measurement follows later.
 */
import { LUFS_OFFSET } from './loudness';
import { decodeHeader } from './mp3frames';

/** Level of a silent frame on the scale of frameLevelDb. */
export const SILENT_FRAME_DB = -100;

/**
 * Offset that puts 1.5 dB · global_gain plus the table term near the
 * decoded level (AudioAnalysis): measured on a synthetic Hörspiel as LAME
 * writes it, the median frame then reads within a few dB, 5th to 99th
 * percentile from -18 to +17 dB. A first sketch; the real measurement
 * follows.
 */
const GAIN_OFFSET_DB = 1.5 * 210 + 8;

/** 20·log10(q^(4/3)) for the largest value q each Huffman table of Layer III holds (15 plus the escape bits from table 16 on); -Infinity for "no values". Index 32: only ±1 values (no big values). */
const TABLE_DB: Float64Array = (() => {
  const small = [0, 1, 2, 2, 0, 3, 3, 5, 5, 5, 7, 7, 7, 15, 0, 15];
  const linbits = [1, 2, 3, 4, 6, 8, 10, 13, 4, 5, 6, 7, 8, 9, 11, 13];
  const max = [...small, ...linbits.map((n) => 15 + 2 ** n - 1), 1];
  return Float64Array.from(max, (q) => (q > 0 ? (80 / 3) * Math.log10(q) : -Infinity));
})();

/** Level in dB and as power (AudioAnalysis scale) of each key gain·33 + table (see frameKey); computed once. */
const KEY_DB = new Float64Array(256 * 33);
const KEY_POWER = new Float32Array(256 * 33);
for (let gain = 0; gain < 256; gain++) {
  for (let t = 0; t < 33; t++) {
    const db = 1.5 * gain + TABLE_DB[t] - GAIN_OFFSET_DB;
    KEY_DB[gain * 33 + t] = db === -Infinity ? SILENT_FRAME_DB : db;
    KEY_POWER[gain * 33 + t] = db === -Infinity ? 0 : 10 ** ((db - LUFS_OFFSET) / 10);
  }
}

/** `n` bits (at most 16) from bit position `bit` of `buf`. */
function bitsAt(buf: Uint8Array, bit: number, n: number): number {
  const b = bit >> 3;
  const w = (buf[b] << 16) | (buf[b + 1] << 8) | buf[b + 2];
  return (w >>> (24 - (bit & 7) - n)) & ((1 << n) - 1);
}

/** The loudest granule and channel of a Layer III frame as gain·33 + table; -1 for silence, -2 for Layer I and II. */
function frameKey(buf: Uint8Array, i: number, h: number): number {
  if (((h >>> 17) & 3) !== 1) return -2;
  const lsf = ((h >>> 19) & 3) !== 3;
  const channels = ((h >>> 6) & 3) === 3 ? 1 : 2;
  let bit = (i + 4 + ((h & 0x10000) === 0 ? 2 : 0)) * 8;
  // main_data_begin, private bits, scfsi
  bit += lsf ? 8 + (channels === 1 ? 1 : 2) : 9 + (channels === 1 ? 5 : 3) + 4 * channels;
  const granules = lsf ? 1 : 2;
  let best = -1;
  let bestDb = -Infinity;
  for (let g = 0; g < granules; g++) {
    for (let c = 0; c < channels; c++) {
      const part23 = bitsAt(buf, bit, 12);
      const bigValues = bitsAt(buf, bit + 12, 9);
      const gain = bitsAt(buf, bit + 21, 8);
      bit += 29 + (lsf ? 9 : 4); // ... scalefac_compress
      const switched = bitsAt(buf, bit, 1);
      bit++;
      // The Huffman tables of the regions: the largest value they can hold tells how big the coefficients are.
      let t = 32; // without big values only ±1 values are coded
      if (bigValues > 0) {
        const t0 = bitsAt(buf, bit + (switched ? 3 : 0), 5);
        const t1 = bitsAt(buf, bit + (switched ? 8 : 5), 5);
        t = TABLE_DB[t1] > TABLE_DB[t0] ? t1 : t0;
        if (!switched) {
          const t2 = bitsAt(buf, bit + 10, 5);
          if (TABLE_DB[t2] > TABLE_DB[t]) t = t2;
        }
      }
      // Short blocks (a sudden sound): each window's step is 8 gain steps smaller per subblock_gain; the loudest window counts.
      let g8 = gain;
      if (switched && bitsAt(buf, bit, 2) === 2) {
        const sb = Math.min(bitsAt(buf, bit + 13, 3), bitsAt(buf, bit + 16, 3), bitsAt(buf, bit + 19, 3));
        g8 = Math.max(0, gain - 8 * sb);
      }
      bit += 22 + (lsf ? 2 : 3); // the region or block fields, then preflag (MPEG1), scalefac_scale, count1table_select
      if (part23 === 0 || TABLE_DB[t] === -Infinity) continue;
      const key = g8 * 33 + t;
      if (KEY_DB[key] > bestDb) {
        bestDb = KEY_DB[key];
        best = key;
      }
    }
  }
  return best;
}

/**
 * Rough level of the Layer III frame at `buf[i]` with header `h` in dB
 * (near the decoded level, within some 10 dB for most frames),
 * SILENT_FRAME_DB for a frame without sound, NaN for Layer I and II. The
 * loudest granule and channel counts. Caller makes sure the side
 * information lies inside `buf` (scanMp3's onFrame does).
 */
export function frameLevelDb(buf: Uint8Array, i: number, h: number): number {
  const key = frameKey(buf, i, h);
  return key === -2 ? Number.NaN : key < 0 ? SILENT_FRAME_DB : KEY_DB[key];
}

/** The middle one of three numbers. */
function median3(a: number, b: number, c: number): number {
  return a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b;
}

/**
 * The rough levels of a file's frames as the scan finds them (scanMp3's
 * onFrame), each the median of the frame and its neighbours: a single frame
 * read far too loud (an encoder's odd choice at a sudden sound) does not
 * show as a spike or hide a pause.
 */
export class FrameLevels {
  private pow = new Float32Array(4096);
  /** The unfiltered levels of the last two frames. */
  private raw1 = 0;
  private raw2 = 0;
  /** Frames seen so far. */
  length = 0;
  /** Playing time of one frame, once the first is seen. */
  frameSec = 0;

  /** The onFrame of scanMp3. */
  readonly onFrame = (buf: Uint8Array, at: number, header: number): void => {
    if (this.length === this.pow.length) {
      const next = new Float32Array(this.pow.length * 2);
      next.set(this.pow);
      this.pow = next;
    }
    if (!this.frameSec) {
      const h = decodeHeader(header);
      if (h) this.frameSec = h.samplesPerFrame / h.sampleRate;
    }
    const key = frameKey(buf, at, header);
    const p = key >= 0 ? KEY_POWER[key] : 0;
    const n = this.length;
    if (n >= 2) this.pow[n - 1] = median3(this.raw2, this.raw1, p);
    this.pow[n] = p;
    this.raw2 = this.raw1;
    this.raw1 = p;
    this.length = n + 1;
  };

  /**
   * The levels so far as a power envelope like AudioAnalysis.power, one
   * window per frame (the windows start at the first frame, a few
   * milliseconds before time 0 of the decoded sound). Stays as it is while
   * the scan goes on.
   */
  power(): Float32Array {
    return this.pow.subarray(0, this.length);
  }
}
