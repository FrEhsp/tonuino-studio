import { describe, expect, it } from 'vitest';
import {
  announceFormatOf,
  announcementText,
  announceTrack,
  encodeAnnouncement,
  formatMark,
  parseMark,
  PAUSE_AFTER_SEC,
  PAUSE_BEFORE_SEC,
  readAnnouncement,
  unannounceTrack,
  voicedRange,
} from '../../src/core/audio/announce';
import { buildSmallId3, parseId3v2, readTags } from '../../src/core/audio/id3';
import { loadMp3Encoder, Mp3StreamEncoder } from '../../src/core/audio/mp3encoder';
import { scanMp3, type Mp3Index } from '../../src/core/audio/mp3frames';
import { trimMp3 } from '../../src/core/audio/mp3trim';
import { bufferSource } from '../../src/core/audio/source';
import { encodeWav16 } from '../../src/core/audio/wav';
import { tagsFor } from '../../src/core/library/tagedit';
import { lsfMp3, stereoMp3 } from './fixtures';
import { blobBytes, concat, decodeMp3, makeReservoirStream, rmsDb, synth } from './helpers';

await loadMp3Encoder();

const SLOW = { timeout: 30_000 };

/** What espeak-ng hands back: 22.05 kHz mono, quiet at the start and the end. */
function voiceWav(sec = 1.2, rate = 22050): Uint8Array {
  return encodeWav16([synth(rate, [{ sec: 0.2 }, { sec, freq: 300, amp: 0.4 }, { sec: 0.3 }])], rate);
}

/** A track as LAME writes it (Info frame with delay and padding), with a tag in front. */
function track(sec: number, opts: { rate?: number; channels?: 1 | 2; kbps?: number; title?: string } = {}): Uint8Array {
  const rate = opts.rate ?? 44100;
  const channels = opts.channels ?? 1;
  const tone = synth(rate, [{ sec, freq: 660, amp: 0.3 }]);
  const enc = new Mp3StreamEncoder({ inputChannels: channels, sampleRate: rate, bitrateKbps: opts.kbps ?? 64 });
  enc.push({ channels: channels === 2 ? [tone, tone] : [tone], sampleRate: rate });
  const frames = [...enc.takeOutput(), ...enc.finish()];
  return concat([buildSmallId3({ title: opts.title ?? 'Der Hund', artist: 'Oma' }), enc.infoFrame(), ...frames]);
}

function frameBytes(file: Uint8Array, index: Mp3Index, from = 0): Uint8Array {
  return file.subarray(index.frameOffsets[from], index.audioEnd);
}

const speaker = (wav: Uint8Array) => {
  const said: number[] = [];
  return { said, speak: async () => (said.push(1), wav) };
};

describe('announcementText', () => {
  it('reads the title, with the number when asked', () => {
    expect(announcementText('Der Hund')).toBe('Der Hund');
    expect(announcementText(' Der_Hund  und\tdie Katze.mp3 ')).toBe('Der Hund und die Katze');
    expect(announcementText('Der Hund', 3)).toBe('Titel 3. Der Hund');
    expect(announcementText('Der Hund', 0)).toBe('Der Hund');
    expect(announcementText('', 4)).toBe('Titel 4.');
  });
});

describe('the note in the tag', () => {
  it('goes there and back', () => {
    const m = { frames: 77, bytes: 16_000, crc: 0x0a1b };
    expect(formatMark(m)).toBe('v1 frames=77 bytes=16000 crc=0a1b');
    expect(parseMark(formatMark(m))).toEqual(m);
    for (const bad of [undefined, '', 'v2 frames=1 bytes=1 crc=0000', 'v1 frames=0 bytes=10 crc=0000', 'v1 frames=3 bytes=10 crc=xyz1']) expect(parseMark(bad), bad).toBeNull();
  });

  it('is a TXXX frame that tag edits keep', () => {
    const tag = buildSmallId3({ title: 'Der Hund', announcement: 'v1 frames=3 bytes=600 crc=beef' });
    const parsed = parseId3v2(tag);
    expect(parsed?.frames.map((f) => f.id)).toEqual(['TIT2', 'TXXX']);
    expect(parsed?.tags).toEqual({ title: 'Der Hund', announcement: 'v1 frames=3 bytes=600 crc=beef' });
    // Another program's TXXX is not taken for it.
    const body = new TextEncoder().encode('\0MusicBrainz Album Id\0v1 frames=3 bytes=600 crc=beef');
    const frame = concat([new TextEncoder().encode('TXXX'), new Uint8Array([0, 0, 0, body.length, 0, 0]), body]);
    const other = parseId3v2(concat([new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frame.length]), frame]));
    expect(other?.frames.map((f) => f.id)).toEqual(['TXXX']);
    expect(other?.tags.announcement).toBeUndefined();
    const draft = { tracks: [{ file: '001.mp3', writable: true, title: { value: 'Neu' }, artist: undefined, album: undefined, track: { value: '' } }], artist: { value: '' }, album: { value: '' }, albumArtist: { value: '' }, year: { value: '' }, genre: { value: '' } };
    expect(tagsFor(draft as never, 0, { title: 'Alt', announcement: 'v1 frames=3 bytes=600 crc=beef' }).announcement).toBe('v1 frames=3 bytes=600 crc=beef');
  });
});

describe('voicedRange', () => {
  it('finds the voice between the silences, with a little room', () => {
    const x = synth(1000, [{ sec: 0.5 }, { sec: 1, freq: 50 }, { sec: 0.5 }]);
    const [a, b] = voicedRange(x, 1000) as [number, number];
    expect(a).toBeGreaterThanOrEqual(465);
    expect(a).toBeLessThanOrEqual(500);
    expect(b).toBeGreaterThanOrEqual(1500);
    expect(b).toBeLessThanOrEqual(1535);
    expect(voicedRange(new Float32Array(100), 1000)).toBeNull();
  });
});

describe('encodeAnnouncement', SLOW, () => {
  it('makes an MP3 in the format of the track, with pauses around the voice', async () => {
    const mp3 = await encodeAnnouncement(voiceWav(1.2), { sampleRate: 44100, channels: 2, bitrateKbps: 128 });
    const index = await scanMp3(bufferSource(mp3));
    expect(index).toMatchObject({ layer: 3, version: 1, sampleRate: 44100, channels: 2 });
    expect(index.durationSec).toBeGreaterThan(1.2 + PAUSE_BEFORE_SEC + PAUSE_AFTER_SEC - 0.05);
    expect(index.durationSec).toBeLessThan(1.2 + PAUSE_BEFORE_SEC + PAUSE_AFTER_SEC + 0.15);
    const { channelData, sampleRate } = await decodeMp3(mp3);
    // Quiet before the voice, about the app's loudness during it.
    expect(rmsDb(channelData[0], 0, Math.round(0.2 * sampleRate))).toBeLessThan(-50);
    const mid = Math.round((PAUSE_BEFORE_SEC + 0.6) * sampleRate);
    expect(rmsDb(channelData[0], mid - 4410, mid + 4410)).toBeGreaterThan(-25);
  });

  it('follows MPEG-2 tracks and refuses silence', async () => {
    const mp3 = await encodeAnnouncement(voiceWav(0.8, 16000), { sampleRate: 22050, channels: 1, bitrateKbps: 32 });
    expect(await scanMp3(bufferSource(mp3))).toMatchObject({ version: 2, sampleRate: 22050, channels: 1 });
    await expect(encodeAnnouncement(encodeWav16([new Float32Array(22050)], 22050), { sampleRate: 44100, channels: 1, bitrateKbps: 64 })).rejects.toThrow(/nichts gesagt/);
  });

  it('takes the bitrate of the track, at least what speech needs', () => {
    expect(announceFormatOf({ sampleRate: 48000, channels: 2, cbr: true, bitrateKbps: 192, avgBitrateKbps: 192 })).toEqual({ sampleRate: 48000, channels: 2, bitrateKbps: 160 });
    expect(announceFormatOf({ sampleRate: 44100, channels: 1, cbr: false, avgBitrateKbps: 41.7 })).toEqual({ sampleRate: 44100, channels: 1, bitrateKbps: 64 });
  });
});

describe('announceTrack and unannounceTrack', SLOW, () => {
  it('puts the title in front without touching the track, and takes it off again exactly', async () => {
    const file = track(3);
    const before = await scanMp3(bufferSource(file));
    const { said, speak } = speaker(voiceWav());
    const r = await announceTrack(bufferSource(file, '001.mp3'), speak);
    expect(said).toHaveLength(1);
    expect(r.replaced).toBe(false);
    const out = await blobBytes(r.blob);
    const index = await scanMp3(bufferSource(out));
    // The track's frames follow the announcement unchanged.
    expect(frameBytes(out, index, r.mark.frames)).toEqual(frameBytes(file, before));
    expect(r.announcementSec).toBeGreaterThan(1.2);
    expect(r.durationSec).toBeCloseTo(before.durationSec + r.announcementSec, 1);
    const { tags } = await readTags(bufferSource(out));
    expect(tags).toMatchObject({ title: 'Der Hund', artist: 'Oma', announcement: formatMark(r.mark) });
    expect((await readAnnouncement(bufferSource(out))).mark).toEqual(r.mark);

    const back = await unannounceTrack(bufferSource(out, '001.mp3'));
    expect(back).not.toBeNull();
    const plain = await blobBytes(back!.blob);
    const plainIndex = await scanMp3(bufferSource(plain));
    expect(frameBytes(plain, plainIndex)).toEqual(frameBytes(file, before));
    expect((await readTags(bufferSource(plain))).tags).toEqual({ title: 'Der Hund', artist: 'Oma' });
    expect(await unannounceTrack(bufferSource(plain))).toBeNull();
  });

  it('replaces an announcement that is there already', async () => {
    const file = track(2);
    const first = await announceTrack(bufferSource(file), speaker(voiceWav(1.5)).speak);
    const again = await announceTrack(bufferSource(await blobBytes(first.blob)), speaker(voiceWav(0.6)).speak);
    expect(again.replaced).toBe(true);
    expect(again.announcementSec).toBeLessThan(first.announcementSec - 0.5);
    const back = await unannounceTrack(bufferSource(await blobBytes(again.blob)));
    const plain = await blobBytes(back!.blob);
    expect(frameBytes(plain, await scanMp3(bufferSource(plain)))).toEqual(frameBytes(file, await scanMp3(bufferSource(file))));
  });

  it('keeps the bytes a track reaches back for, and gives them back', async () => {
    // A track cut from a longer one starts with frames that need bytes before them.
    const long = makeReservoirStream(track(4, { kbps: 128 }).subarray(buildSmallId3({ title: 'Der Hund', artist: 'Oma' }).length));
    const longIndex = await scanMp3(bufferSource(long));
    const cut = await blobBytes(await trimMp3(bufferSource(long), longIndex, 1, 0, { tag: null }));
    const cutIndex = await scanMp3(bufferSource(cut));
    const r = await announceTrack(bufferSource(cut), speaker(voiceWav()).speak);
    const out = await blobBytes(r.blob);
    const plain = await blobBytes((await unannounceTrack(bufferSource(out)))!.blob);
    expect(frameBytes(plain, await scanMp3(bufferSource(plain)))).toEqual(frameBytes(cut, cutIndex));
    // And it plays: the decoded track after the announcement is the tone, not a crackle.
    const decoded = await decodeMp3(out);
    const at = Math.round((r.announcementSec + 0.5) * decoded.sampleRate);
    expect(rmsDb(decoded.channelData[0], at, at + 4410)).toBeGreaterThan(-20);
  });

  it('works with stereo, 48 kHz and MPEG-2 tracks', async () => {
    for (const file of [track(2, { channels: 2, kbps: 128 }), track(2, { rate: 48000, kbps: 96 }), stereoMp3(), lsfMp3()]) {
      const r = await announceTrack(bufferSource(file), speaker(voiceWav(0.5)).speak);
      const index = await scanMp3(bufferSource(await blobBytes(r.blob)));
      const orig = await scanMp3(bufferSource(file));
      expect(index).toMatchObject({ sampleRate: orig.sampleRate, channels: orig.channels, version: orig.version });
      expect(index.frameCount).toBe(orig.frameCount + r.mark.frames);
    }
  });

  it('leaves a track alone whose start changed since', async () => {
    const r = await announceTrack(bufferSource(track(3)), speaker(voiceWav()).speak);
    const out = await blobBytes(r.blob);
    // Cut at the start afterwards ("Anfang abschneiden"): the tag still has the note, the frames do not match it.
    const trimmed = await blobBytes(await trimMp3(bufferSource(out), await scanMp3(bufferSource(out)), 0.5, 0));
    expect((await readTags(bufferSource(trimmed))).tags.announcement).toBe(formatMark(r.mark));
    expect((await readAnnouncement(bufferSource(trimmed))).mark).toBeNull();
    expect(await unannounceTrack(bufferSource(trimmed))).toBeNull();
  });

  it('does not ask the voice for a file it cannot use', async () => {
    const { said, speak } = speaker(voiceWav());
    await expect(announceTrack(bufferSource(new Uint8Array(4000)), speak)).rejects.toThrow();
    expect(said).toHaveLength(0);
  });
});
