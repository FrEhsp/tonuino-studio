import { describe, expect, it } from 'vitest';
import { AdtsPacketReader, chaptersFromVorbisComments, type PacketReader } from '../../src/core/audio/demux';
import { FlacPacketReader, parseFlacFrameHeader } from '../../src/core/audio/flac';
import { kindFromName, sniffContainer } from '../../src/core/audio/formats';
import { buildSmallId3 } from '../../src/core/audio/id3';
import { Mp4PacketReader, parseAsc, probeMp4 } from '../../src/core/audio/mp4';
import { OggPacketReader, opusPacketSamples, xiphLacing } from '../../src/core/audio/ogg';
import { readAllPcm } from '../../src/core/audio/pcm';
import { bufferSource, CHUNK_SIZE } from '../../src/core/audio/source';
import { WavPcmReader, encodeWav16 } from '../../src/core/audio/wav';
import { WebCodecsPcmReader } from '../../src/core/audio/webcodecs';
import {
  adtsFrame,
  ascFor,
  box,
  buildAiff,
  buildFlac,
  buildMp4,
  buildOgg,
  fakeWebCodecs,
  flacFrames,
  oggPages,
  opusFile,
  opusHead,
  pcmPackets,
  ramp,
  vorbisComment,
  vorbisHeaders,
} from './containers';
import { monoMp3 } from './fixtures';
import { concat } from './helpers';

const te = new TextEncoder();

async function allPackets(r: PacketReader): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let p = await r.next(); p; p = await r.next()) out.push(p.data.slice());
  return out;
}

/** Float PCM as the fake decoder returns it (16-bit rounding). */
function quantized(x: Float32Array): Float32Array {
  // "+ 0" turns -0 into 0, like an integer decoder does.
  return Float32Array.from(x, (v) => (Math.max(-32768, Math.min(32767, Math.round(v * 32767))) + 0) / 32767);
}

/** Decodes real audio: a second alone, several while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('container sniffing', SLOW, () => {
  it('detects containers by content, not by name', async () => {
    const x = ramp(4410);
    const cases: [Uint8Array, string, string][] = [
      [encodeWav16(x, 44100), 'a.mp3', 'wav'],
      [buildAiff(x, 44100), 'a.aif', 'aiff'],
      [buildFlac(x), 'a.mp3', 'flac'],
      [buildFlac(x, { id3: buildSmallId3({ title: 'x' }) }), 'a.flac', 'flac'],
      [buildMp4({ sampleRate: 44100, channels: 1, packets: pcmPackets(x, 1024), frameSamples: 1024 }), 'a.mp3', 'mp4'],
      [buildOgg([{ data: opusHead(1, 312), granule: 0 }]), 'a.ogg', 'ogg'],
      [concat([adtsFrame(new Uint8Array(100), 4, 1), adtsFrame(new Uint8Array(90), 4, 1), adtsFrame(new Uint8Array(80), 4, 1)]), 'a.m4a', 'aac'],
      [monoMp3(), 'a.m4a', 'mp3'],
      [concat([buildSmallId3({ title: 'x' }), new Uint8Array(500), monoMp3()]), 'a.bin', 'mp3'],
      [Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), 'a.webm', 'webm'],
      [Uint8Array.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]), 'a.wma', 'asf'],
      [te.encode('hello world, this is not audio at all'), 'a.txt', 'unknown'],
    ];
    for (const [bytes, name, kind] of cases) expect(await sniffContainer(bufferSource(bytes, name)), name + ' → ' + kind).toBe(kind);
    expect(kindFromName('Buch.M4B')).toBe('mp4');
  });
});

describe('MP4 demuxer', SLOW, () => {
  const sr = 44100;
  const signal = ramp(1024 * 40, 2);
  const packets = pcmPackets(signal, 1024);
  const chapters = [
    { startSec: 0, title: 'Vorspann' },
    { startSec: 0.3, title: 'Kapitel 1: Der Wald' },
    { startSec: 0.75, title: 'Kapitel 2' },
  ];
  const base = { sampleRate: sr, channels: 2, packets, frameSamples: 1024, edit: { mediaTime: 2112, duration: 1024 * 40 - 2112 - 500 }, chapters };

  for (const layout of ['index at the end', 'index first', 'fragmented'] as const) {
    it(`reads tables, edit list and chapters (${layout})`, async () => {
      const file = buildMp4({ ...base, moovFirst: layout === 'index first', fragmentSamples: layout === 'fragmented' ? 6 : undefined });
      const src = bufferSource(file, 'buch.m4b');
      const probe = await probeMp4(src);
      expect(probe.info).toMatchObject({ codec: 'aac', webCodecs: 'mp4a.40.2', sampleRate: sr, channels: 2, skipSamples: 2112, totalSamples: 1024 * 40 - 2612 });
      expect(probe.info.description).toEqual(ascFor(sr, 2));
      expect(probe.info.durationSec).toBeCloseTo((1024 * 40 - 2612) / sr, 9);
      expect(probe.info.chapters).toEqual(chapters);
      const reader = await Mp4PacketReader.open(src);
      expect(await allPackets(reader)).toEqual(packets);
    });
  }

  it('decodes through WebCodecs with priming and padding trimmed', async () => {
    const src = bufferSource(buildMp4(base), 'buch.m4b');
    const api = fakeWebCodecs();
    const reader = await WebCodecsPcmReader.open(await Mp4PacketReader.open(src), api);
    expect(reader).toMatchObject({ sampleRate: sr, channels: 2 });
    const pcm = await readAllPcm(reader, 3000);
    expect(pcm[0].length).toBe(1024 * 40 - 2612);
    expect(pcm[0]).toEqual(quantized(signal[0]).subarray(2112, 2112 + pcm[0].length));
    expect(pcm[1]).toEqual(quantized(signal[1]).subarray(2112, 2112 + pcm[1].length));
    await reader.close();
    expect(api.closed).toBe(1);
  });

  it('scales the trim when the decoder outputs a higher rate (HE-AAC)', async () => {
    const src = bufferSource(buildMp4({ ...base, sampleRate: 22050, edit: { mediaTime: 1000, duration: 30000 }, chapters: undefined }));
    const reader = await WebCodecsPcmReader.open(await Mp4PacketReader.open(src), fakeWebCodecs({ rateFactor: 2 }));
    expect(reader.sampleRate).toBe(44100);
    const pcm = await readAllPcm(reader);
    expect(pcm[0].length).toBe(60000);
    expect(pcm[0][0]).toBe(quantized(signal[0])[1000]);
  });

  it('uses iTunSMPB and Nero chapters when there is no edit list or chapter track', async () => {
    const nero = [
      { startSec: 0, title: 'Anfang' },
      { startSec: 0.5, title: 'Schluss' },
    ];
    const src = bufferSource(buildMp4({ sampleRate: sr, channels: 2, packets, frameSamples: 1024, smpb: { priming: 2112, padding: 300, total: 30000 }, nero, co64: true }));
    const { info } = await probeMp4(src);
    expect(info).toMatchObject({ skipSamples: 2112, totalSamples: 30000, chapters: nero });
  });

  it('reports copy protection and missing audio', async () => {
    const drm = buildMp4({ sampleRate: sr, channels: 2, packets, frameSamples: 1024, entryType: 'drms' });
    expect((await probeMp4(bufferSource(drm))).info.drm).toBeTruthy();
    await expect(Mp4PacketReader.open(bufferSource(drm))).rejects.toMatchObject({ code: 'drm-protected' });
    const aax = buildMp4({ sampleRate: sr, channels: 2, packets, frameSamples: 1024, brand: 'aax ' });
    await expect(Mp4PacketReader.open(bufferSource(aax))).rejects.toMatchObject({ code: 'drm-protected' });
    const truncated = buildMp4({ ...base }).subarray(0, 5000);
    await expect(probeMp4(bufferSource(truncated))).rejects.toMatchObject({ code: 'decode-failed' });
  });

  it('describes Opus and FLAC tracks for WebCodecs', async () => {
    const dops = box('dOps', [0, 2, 0x01, 0x38], [0, 0, 0xbb, 0x80], [0, 0], [0]);
    const opus = await probeMp4(bufferSource(buildMp4({ sampleRate: 48000, channels: 2, packets, frameSamples: 960, entryType: 'Opus', entryChildren: [dops] })));
    expect(opus.info).toMatchObject({ codec: 'opus', webCodecs: 'opus', sampleRate: 48000, channels: 2 });
    const head = opus.info.description as Uint8Array;
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe('OpusHead');
    expect(head[10] | (head[11] << 8)).toBe(312); // pre-skip, now little endian
    expect(parseAsc(Uint8Array.from([0x2b, 0x92, 0x08, 0x00]))).toMatchObject({ objectType: 5, sampleRate: 22050, outputRate: 44100, channelConfig: 2 });
  });
});

describe('Ogg demuxer', SLOW, () => {
  const comments = ['TITLE=Buch', 'CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Anfang', 'CHAPTER002=00:00:01.250', 'CHAPTER002NAME=Weiter'];

  it('reads Opus with pre-skip, end trimming, chapters and packets across pages', async () => {
    const signal = ramp(48000 * 2 + 312, 1);
    const pk = pcmPackets(signal, 960);
    const real = signal[0].length - 312 - 100; // the last 100 samples are padding
    let pos = 0;
    const audio = pk.map((data, i) => {
      pos += data.length / 2;
      return { data, granule: i === pk.length - 1 ? real + 312 : pos };
    });
    const file = buildOgg(
      [{ data: opusHead(1, 312), granule: 0 }, { data: concat([te.encode('OpusTags'), vorbisComment('x', comments)]), granule: 0 }, ...audio],
      { headerCount: 2, maxSegments: 5 },
    );
    const r = await OggPacketReader.open(bufferSource(file, 'buch.opus'));
    expect(r.info).toMatchObject({ codec: 'opus', webCodecs: 'opus', sampleRate: 48000, channels: 1, skipSamples: 312, totalSamples: real, durationExact: true });
    expect(r.info.chapters).toEqual([
      { startSec: 0, title: 'Anfang' },
      { startSec: 1.25, title: 'Weiter' },
    ]);
    const reader = await WebCodecsPcmReader.open(r, fakeWebCodecs());
    const pcm = await readAllPcm(reader);
    expect(pcm[0].length).toBe(real);
    expect(pcm[0]).toEqual(quantized(signal[0]).subarray(312, 312 + real));
  });

  it('builds the Vorbis description from the three headers', async () => {
    const headers = vorbisHeaders(2, 44100, comments);
    const audio = pcmPackets(ramp(4096, 2), 1024).map((data, i) => ({ data, granule: (i + 1) * 1024 }));
    const file = buildOgg([...headers.map((data) => ({ data, granule: 0 })), ...audio], { headerCount: 3 });
    const r = await OggPacketReader.open(bufferSource(file));
    expect(r.info).toMatchObject({ codec: 'vorbis', sampleRate: 44100, channels: 2, totalSamples: 4096 });
    expect(r.info.description).toEqual(xiphLacing(headers));
    expect(r.info.chapters?.length).toBe(2);
    expect(await allPackets(r)).toEqual(audio.map((a) => a.data));
  });

  it('reads FLAC in Ogg', async () => {
    const signal = ramp(10000, 2);
    const frames = flacFrames(signal, 4096);
    const flac = buildFlac(signal);
    const streaminfo = flac.subarray(4, 4 + 38);
    const first = concat([Uint8Array.from([0x7f]), te.encode('FLAC'), Uint8Array.from([1, 0, 0, 1]), te.encode('fLaC'), streaminfo]);
    const commentBlock = concat([Uint8Array.from([0x84, 0, 0, 0]), vorbisComment('x', comments)]);
    commentBlock.set([(commentBlock.length - 4) >> 16, ((commentBlock.length - 4) >> 8) & 0xff, (commentBlock.length - 4) & 0xff], 1);
    const file = buildOgg([{ data: first, granule: 0 }, { data: commentBlock, granule: 0 }, ...frames.map((data, i) => ({ data, granule: Math.min(10000, (i + 1) * 4096) }))], { headerCount: 2 });
    const r = await OggPacketReader.open(bufferSource(file));
    expect(r.info).toMatchObject({ codec: 'flac', sampleRate: 44100, channels: 2, totalSamples: 10000 });
    expect(r.info.chapters?.length).toBe(2);
    const reader = await WebCodecsPcmReader.open(r, fakeWebCodecs());
    const pcm = await readAllPcm(reader);
    expect(pcm[1]).toEqual(quantized(signal[1]));
  });

  it('hands chained files to the browser decoder, with the playing time of every stream', async () => {
    // As `cat kapitel1.opus kapitel2.opus` makes them: one whole stream after the other, each with its own serial number.
    const chain = concat([opusFile(1, 2), opusFile(2, 6)]);
    await expect(OggPacketReader.open(bufferSource(chain, 'buch.opus'))).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { container: 'ogg', codec: 'opus', durationSec: expect.closeTo((8 * 48000 - 2 * 312) / 48000, 6), fallback: true },
    });
    const vorbis = (serial: number, sec: number) =>
      buildOgg([...vorbisHeaders(1, 44100, []).map((data) => ({ data, granule: 0 })), ...pcmPackets(ramp(44100 * sec, 1), 1024).map((data, i) => ({ data, granule: Math.min(44100 * sec, (i + 1) * 1024) }))], {
        serial,
        headerCount: 3,
      });
    await expect(OggPacketReader.open(bufferSource(concat([vorbis(5, 1), vorbis(6, 2)])))).rejects.toMatchObject({ details: { codec: 'vorbis', durationSec: 3, fallback: true } });
    // One stream alone, or side by side with another stream that ends last, stays with this reader.
    expect((await OggPacketReader.open(bufferSource(opusFile(1, 2)))).info.durationSec).toBeCloseTo((2 * 48000 - 312) / 48000, 6);
    const [a, b] = [oggPages(opusFile(1, 2)), oggPages(buildOgg([{ data: te.encode('fishead\0'), granule: 0 }, { data: new Uint8Array(100), granule: 5 }], { serial: 9, headerCount: 1 }))];
    const grouped = await OggPacketReader.open(bufferSource(concat([a[0], b[0], ...a.slice(1), ...b.slice(1)])));
    expect(grouped.info.durationSec).toBeCloseTo((2 * 48000 - 312) / 48000, 6);
    expect((await allPackets(grouped)).length).toBe(100);
  });

  it('knows Opus packet durations', () => {
    expect(opusPacketSamples(Uint8Array.from([0xfc]))).toBe(960); // CELT 20 ms, one frame
    expect(opusPacketSamples(Uint8Array.from([0x19, 0]))).toBe(5760); // SILK 60 ms, two frames
    expect(opusPacketSamples(Uint8Array.from([0x03, 0x03]))).toBe(1440); // SILK 10 ms, three frames (code 3)
  });
});

describe('FLAC demuxer', SLOW, () => {
  it('finds frame boundaries even when the audio contains sync patterns', async () => {
    // -8 is 0xFFF8 in 16 bit: the raw sample bytes contain fake sync codes.
    const n = 20000;
    const tricky = Float32Array.from({ length: n }, (_, i) => (i % 3 === 0 ? -8 / 32767 : Math.sin(i / 50) * 0.4));
    const signal = [tricky, ramp(n, 1)[0]];
    const file = buildFlac(signal, { blockSize: 1152, cueTrackStarts: [0, 4410, 13230] });
    const r = await FlacPacketReader.open(bufferSource(file, 'cd.flac'));
    expect(r.info).toMatchObject({ codec: 'flac', webCodecs: 'flac', sampleRate: 44100, channels: 2, totalSamples: n, durationExact: true });
    expect(r.info.chapters).toEqual([
      { startSec: 0, title: undefined },
      { startSec: 0.1, title: undefined },
      { startSec: 0.3, title: undefined },
    ]);
    const frames = flacFrames(signal, 1152);
    expect(await allPackets(r)).toEqual(frames);
    const reader = await WebCodecsPcmReader.open(await FlacPacketReader.open(bufferSource(file)), fakeWebCodecs());
    const pcm = await readAllPcm(reader);
    expect(pcm[0]).toEqual(quantized(tricky));
  });

  it('skips a leading ID3 tag and prefers CHAPTER comments', async () => {
    const file = buildFlac(ramp(5000, 1), { id3: buildSmallId3({ title: 'x' }), comments: ['CHAPTER01=00:00:00.05', 'CHAPTER01NAME=Eins'] });
    const r = await FlacPacketReader.open(bufferSource(file));
    expect(r.info.chapters).toEqual([{ startSec: 0.05, title: 'Eins' }]);
    expect((await allPackets(r)).length).toBe(2);
  });

  it('rejects broken headers', () => {
    const frame = flacFrames(ramp(1000, 1), 1000)[0];
    expect(parseFlacFrameHeader(frame, 0, { channels: 1, sampleRate: 44100, maxBlockSize: 4096 })).toMatchObject({ blockSize: 1000, number: 0 });
    const bad = frame.slice();
    bad[4] ^= 1; // frame number changes, CRC-8 no longer matches
    expect(parseFlacFrameHeader(bad, 0)).toBeNull();
    expect(parseFlacFrameHeader(frame, 0, { channels: 2, sampleRate: 44100, maxBlockSize: 4096 })).toBeNull();
  });

  it('reads files larger than one read window', async () => {
    // Verbatim stereo frames of 4096 samples take about 16 KB, so frames cross the borders of the 1 MB windows.
    const signal = ramp(400_000, 2);
    const file = buildFlac(signal);
    expect(file.length).toBeGreaterThan(CHUNK_SIZE * 1.5);
    const frames = flacFrames(signal, 4096);
    const packets = await allPackets(await FlacPacketReader.open(bufferSource(file)));
    expect(packets.map((p) => p.length)).toEqual(frames.map((f) => f.length));
    expect(packets.findIndex((p, i) => p.some((b, k) => b !== frames[i][k]))).toBe(-1);
  });

  it('leaves out a frame with a damaged header and reads on to the end', async () => {
    // Mono frames of 4096 samples take about 8 KB; 400 of them do not fit in one read window.
    for (const count of [40, 400]) {
      const signal = ramp(4096 * count, 1);
      const frames = flacFrames(signal, 4096);
      const clean = buildFlac(signal);
      const audioStart = clean.length - frames.reduce((n, f) => n + f.length, 0);
      const lengths = frames.map((f) => f.length);
      for (const sizes of ['unknown', 'known', 'too small']) {
        for (const at of [10, count - 10]) {
          for (const damage of ['header CRC', 'sync code', 'zeroed bytes'] as const) {
            const file = clean.slice();
            const [min, max] = sizes === 'too small' ? [2000, 4000] : sizes === 'known' ? [Math.min(...lengths), Math.max(...lengths)] : [0, 0];
            file.set([min >> 16, (min >> 8) & 0xff, min & 0xff, max >> 16, (max >> 8) & 0xff, max & 0xff], 8 + 4); // STREAMINFO frame sizes
            const s = audioStart + lengths.slice(0, at).reduce((n, l) => n + l, 0);
            const h = parseFlacFrameHeader(file, s);
            if (damage === 'header CRC') file[s + h!.headerLength - 1] ^= 1;
            else if (damage === 'sync code') file[s + 1] ^= 0x08;
            else file.fill(0, s, s + 512);
            const label = `${count} frames, frame sizes ${sizes}, ${damage} of frame ${at}`;
            // Without a sync code after it, the end of the frame before cannot be checked: it is left out too.
            const lost = damage === 'header CRC' ? [at] : [at - 1, at];
            const packets = await allPackets(await FlacPacketReader.open(bufferSource(file)));
            expect(packets.length, label).toBe(count - lost.length);
            expect(
              packets.findIndex((p, k) => Buffer.compare(Buffer.from(p), Buffer.from(frames.filter((_, j) => !lost.includes(j))[k])) !== 0),
              label,
            ).toBe(-1);
            if (count === 40 && sizes !== 'too small') {
              const reader = await WebCodecsPcmReader.open(await FlacPacketReader.open(bufferSource(file)), fakeWebCodecs());
              expect((await readAllPcm(reader))[0].length, label).toBe(4096 * (count - lost.length));
            }
          }
        }
      }
    }
  });

});

describe('ADTS demuxer', () => {
  it('strips ADTS headers and builds the AudioSpecificConfig', async () => {
    const signal = ramp(1024 * 6, 1);
    const pk = pcmPackets(signal, 1024);
    const file = concat([buildSmallId3({ title: 'radio' }), ...pk.map((p) => adtsFrame(p, 3, 1)), te.encode('TAG'.padEnd(128, '\0'))]);
    const r = await AdtsPacketReader.open(bufferSource(file, 'x.aac'));
    expect(r.info).toMatchObject({ codec: 'aac', webCodecs: 'mp4a.40.2', sampleRate: 48000, channels: 1 });
    expect(r.info.description).toEqual(ascFor(48000, 1));
    expect(r.info.durationSec).toBeCloseTo(0.128, 2);
    expect(await allPackets(r)).toEqual(pk);
  });
});

describe('AIFF', () => {
  it('reads big-endian, 24-bit and little-endian (sowt) files', async () => {
    const signal = ramp(3000, 2, 0.9);
    for (const opts of [{}, { bits: 24 as const }, { sowt: true }]) {
      const reader = await WavPcmReader.open(bufferSource(buildAiff(signal, 22050, opts)));
      expect(reader).toMatchObject({ sampleRate: 22050, channels: 2 });
      expect(reader.durationSec).toBeCloseTo(3000 / 22050, 9);
      const pcm = await readAllPcm(reader, 700);
      for (let i = 0; i < 3000; i += 97) expect(pcm[1][i]).toBeCloseTo(signal[1][i], opts.bits === 24 ? 6 : 4);
    }
  });
});

describe('WebCodecs reader', () => {
  const signal = ramp(1024 * 30, 1);
  const file = () => bufferSource(buildMp4({ sampleRate: 44100, channels: 1, packets: pcmPackets(signal, 1024), frameSamples: 1024 }));

  it('refuses codecs the browser lacks', async () => {
    await expect(WebCodecsPcmReader.open(await Mp4PacketReader.open(file()), fakeWebCodecs({ supported: ['opus'] }))).rejects.toMatchObject({ code: 'unsupported-format' });
  });

  it('turns decoder errors into decode-failed and closes the decoder', async () => {
    const api = fakeWebCodecs({ failAfter: 5 });
    const reader = await WebCodecsPcmReader.open(await Mp4PacketReader.open(file()), api);
    await expect(readAllPcm(reader)).rejects.toMatchObject({ code: 'decode-failed' });
    await reader.close();
  });

  it('honours small reads and the abort signal', async () => {
    const ac = new AbortController();
    const reader = await WebCodecsPcmReader.open(await Mp4PacketReader.open(file()), fakeWebCodecs(), ac.signal);
    const a = await reader.next(100);
    expect(a?.channels[0].length).toBe(100);
    ac.abort();
    await expect(reader.next(5000)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('parses chapter comments', () => {
    expect(chaptersFromVorbisComments(['CHAPTER2=1:02:03.5', 'chapter2name=B', 'CHAPTER1=00:00:00.000', 'CHAPTER1NAME=A', 'CHAPTERX=bad'])).toEqual([
      { startSec: 0, title: 'A' },
      { startSec: 3723.5, title: 'B' },
    ]);
  });
});
