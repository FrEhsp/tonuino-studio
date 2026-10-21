/** Bit access (MSB first) and the CRC-16 used by MPEG audio frames. */

/** Reads `n` bits (n <= 24) starting at absolute bit `bitPos` of `buf`. */
export function readBits(buf: Uint8Array, bitPos: number, n: number): number {
  let value = 0;
  let pos = bitPos;
  let left = n;
  while (left > 0) {
    const byte = buf[pos >> 3];
    const bitInByte = pos & 7;
    const take = Math.min(8 - bitInByte, left);
    const shifted = (byte >> (8 - bitInByte - take)) & ((1 << take) - 1);
    value = (value << take) | shifted;
    pos += take;
    left -= take;
  }
  return value >>> 0;
}

/** Writes the low `n` bits (n <= 24) of `value` at absolute bit `bitPos`. */
export function writeBits(buf: Uint8Array, bitPos: number, n: number, value: number): void {
  let pos = bitPos;
  let left = n;
  while (left > 0) {
    const bitInByte = pos & 7;
    const take = Math.min(8 - bitInByte, left);
    const shift = 8 - bitInByte - take;
    const mask = ((1 << take) - 1) << shift;
    const bits = ((value >>> (left - take)) & ((1 << take) - 1)) << shift;
    const i = pos >> 3;
    buf[i] = (buf[i] & ~mask) | bits;
    pos += take;
    left -= take;
  }
}

const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

/**
 * CRC-16 with polynomial 0x8005, MSB first, no final xor (ISO 11172-3 frame
 * CRC; starts at 0xFFFF). Pass a previous result as `crc` to continue.
 */
export function crc16(data: Uint8Array, start = 0, end = data.length, crc = 0xffff): number {
  let c = crc;
  for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ CRC16_TABLE[((c >> 8) ^ data[i]) & 0xff];
  return c;
}

const CRC16_ARC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/**
 * CRC-16/ARC (polynomial 0x8005 reflected, start 0), used by the LAME tag
 * for its own checksum and the "music CRC". Pass a previous result to continue.
 */
export function crc16Arc(data: Uint8Array, start = 0, end = data.length, crc = 0): number {
  let c = crc;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC16_ARC_TABLE[(c ^ data[i]) & 0xff];
  return c;
}
