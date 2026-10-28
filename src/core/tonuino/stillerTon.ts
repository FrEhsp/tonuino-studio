/**
 * A silent MP3 for mp3/0262.mp3: TonUINO TNG plays that file each time a
 * card is put on and needs it (without it the box stops after the first
 * card, health.ts START_TONE_TEXT). Whoever does not want the beep replaces
 * it with silence instead of deleting it (help topic „Ansagen“, Prüfrunde 1,
 * bastler 14).
 *
 * MPEG-1 Layer III, 44.1 kHz, 128 kbit/s, mono, no padding: every frame is
 * 417 bytes, the header and then zeros. Zero side information means no
 * Huffman data, which every decoder plays as silence. 10 frames, about a
 * quarter second: long enough for the DFPlayer to count it as a track.
 */

/** Header of each frame: sync, MPEG-1, Layer III, no CRC; 128 kbit/s, 44.1 kHz; mono. */
const HEADER = [0xff, 0xfb, 0x90, 0xc0] as const;
/** 144 * 128000 / 44100, rounded down (no padding). */
export const SILENT_FRAME_BYTES = 417;
export const SILENT_FRAMES = 10;

export function stillesMp3(): Uint8Array {
  const out = new Uint8Array(SILENT_FRAME_BYTES * SILENT_FRAMES);
  for (let f = 0; f < SILENT_FRAMES; f++) out.set(HEADER, f * SILENT_FRAME_BYTES);
  return out;
}

/** Whether a file on the card is this silence: same size (the scan knows only sizes). */
export function istStill(size: number): boolean {
  return size === SILENT_FRAME_BYTES * SILENT_FRAMES;
}
