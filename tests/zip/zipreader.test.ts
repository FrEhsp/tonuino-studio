import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readZipDirectory, ZipReadError, type ZipDirectory } from '../../src/core/zip/zipreader';
import { layoutZip } from '../../src/core/zip/zipwriter';
import { bytesReader, CARD, enc, file, folder, hasTool, layoutReader, tool, zipOf, type TestFile } from './helpers';

const read = (bytes: Uint8Array) => readZipDirectory(bytesReader(bytes), bytes.length);

async function failure(p: Promise<unknown>): Promise<ZipReadError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ZipReadError);
    return e as ZipReadError;
  }
  throw new Error('kein Fehler');
}

/** The entries as the writer was given them. */
function expected(files: TestFile[]) {
  return files.map((f) => ({ path: f.path, size: f.data?.length ?? 0, crc32: f.data ? zlibCrc32(f.data) >>> 0 : 0, isDir: !f.data }));
}

function withoutOffsets(dir: ZipDirectory) {
  return dir.entries.map(({ offset: _offset, ...rest }) => rest);
}

/** Every offset points at a local header that carries the entry's name. */
function checkOffsets(bytes: Uint8Array, dir: ZipDirectory) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const e of dir.entries) {
    expect(dv.getUint32(e.offset, true), e.path).toBe(0x04034b50);
    const nameLen = dv.getUint16(e.offset + 26, true);
    expect(new TextDecoder().decode(bytes.subarray(e.offset + 30, e.offset + 30 + nameLen))).toBe(e.path);
  }
}

/** Offset of the end record (no comment). */
const endAt = (bytes: Uint8Array) => bytes.length - 22;

function patched(bytes: Uint8Array, change: (dv: DataView) => void): Uint8Array {
  const copy = bytes.slice();
  change(new DataView(copy.buffer));
  return copy;
}

describe('readZipDirectory', () => {
  it('reads back what the writer wrote, folders and UTF-8 names included', async () => {
    for (const forceZip64 of [false, true]) {
      const { bytes } = zipOf(CARD, { forceZip64 });
      const dir = await read(bytes);
      expect(dir.zip64).toBe(forceZip64);
      expect(dir.size).toBe(bytes.length);
      expect(withoutOffsets(dir)).toEqual(expected(CARD));
      checkOffsets(bytes, dir);
    }
  });

  it('reads an archive without entries', async () => {
    const { bytes } = zipOf([]);
    expect(await read(bytes)).toEqual({ entries: [], zip64: false, size: 22 });
  });

  it('reads the ZIP64 fields of a file over 4 GiB and of entries behind it', async () => {
    const big = 5 * 1024 ** 3;
    const layout = layoutZip(
      [
        { path: 'big/', size: 0, crc32: 0 },
        { path: 'big/001.mp3', size: big, crc32: 0x12345678 },
        { path: 'big/002.mp3', size: 3, crc32: 0x01020304 },
      ],
      { now: new Date(2026, 9, 6) },
    );
    const dir = await readZipDirectory(layoutReader(layout, [0, big, 3]), layout.size);
    expect(dir.zip64).toBe(true);
    expect(dir.entries.map((e) => [e.path, e.size, e.crc32])).toEqual([
      ['big/', 0, 0],
      ['big/001.mp3', big, 0x12345678],
      ['big/002.mp3', 3, 0x01020304],
    ]);
    expect(dir.entries[2].offset).toBeGreaterThan(big);
  });

  it('finds the end record behind an archive comment', async () => {
    const { bytes } = zipOf(CARD);
    // A comment that itself contains the end record's signature.
    const comment = enc.encode('Hallo PK\u0005\u0006 und noch mehr Text');
    const withComment = new Uint8Array(bytes.length + comment.length);
    withComment.set(bytes);
    withComment.set(comment, bytes.length);
    new DataView(withComment.buffer).setUint16(endAt(bytes) + 20, comment.length, true);
    const dir = await read(withComment);
    expect(withoutOffsets(dir)).toEqual(expected(CARD));
  });

  it('reads the ZIP64 end record through its locator', async () => {
    const { bytes } = zipOf(CARD, { forceZip64: true });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const locator = endAt(bytes) - 20;
    expect(dv.getUint32(locator, true)).toBe(0x07064b50);
    // The plain end record holds no usable numbers at all.
    expect(dv.getUint16(endAt(bytes) + 10, true)).toBe(0xffff);
    expect(dv.getUint32(endAt(bytes) + 16, true)).toBe(0xffffffff);
    const dir = await read(bytes);
    expect(dir.entries).toHaveLength(CARD.length);

    // A locator that points elsewhere is a damaged archive.
    const wrong = patched(bytes, (d) => d.setUint32(locator + 8, d.getUint32(locator + 8, true) - 4, true));
    expect((await failure(read(wrong))).code).toBe('truncated');
  });

  it('refuses an end record that points to a ZIP64 record that is not there', async () => {
    const { bytes } = zipOf(CARD);
    const marked = patched(bytes, (d) => {
      d.setUint16(endAt(bytes) + 8, 0xffff, true);
      d.setUint16(endAt(bytes) + 10, 0xffff, true);
    });
    expect((await failure(read(marked))).code).toBe('truncated');
  });

  it('says "truncated" for a download that stopped early', async () => {
    for (const forceZip64 of [false, true]) {
      const { bytes } = zipOf(CARD, { forceZip64 });
      for (const cut of [4, 21, 30, Math.floor(bytes.length / 2), bytes.length - 23, bytes.length - 22, bytes.length - 1]) {
        const err = await failure(read(bytes.subarray(0, cut)));
        expect(err.code, `${forceZip64} ${cut}`).toBe('truncated');
        expect(err.message).toMatch(/^Das Paket ist nicht vollständig/);
      }
    }
    expect((await failure(read(new Uint8Array(0)))).code).toBe('truncated');
  });

  it('says "truncated" when the table of contents does not fit', async () => {
    const { bytes } = zipOf(CARD);
    const e = endAt(bytes);
    const moreEntries = patched(bytes, (d) => {
      d.setUint16(e + 8, CARD.length + 1, true);
      d.setUint16(e + 10, CARD.length + 1, true);
    });
    expect((await failure(read(moreEntries))).code).toBe('truncated');
    const shifted = patched(bytes, (d) => d.setUint32(e + 16, d.getUint32(e + 16, true) + 1, true));
    expect((await failure(read(shifted))).code).toBe('truncated');
    const bytesAfterTheEnd = new Uint8Array(bytes.length + 5);
    bytesAfterTheEnd.set(bytes);
    expect((await failure(read(bytesAfterTheEnd))).code).toBe('truncated');
  });

  it('says "not-zip" for other files', async () => {
    for (const other of ['ID3\u0004\u0000 just an mp3', '%PDF-1.4', '{"app":"tonuino-studio"}', 'PK']) {
      const err = await failure(read(enc.encode(other)));
      expect(err.code, other).toBe('not-zip');
      expect(err.message).toBe('Das ist keine ZIP-Datei.');
    }
  });

  it('says "unsupported" for archives split over several files', async () => {
    const { bytes } = zipOf(CARD);
    const split = patched(bytes, (d) => d.setUint16(endAt(bytes) + 4, 1, true));
    expect((await failure(read(split))).code).toBe('unsupported');
    const z = zipOf(CARD, { forceZip64: true }).bytes;
    const split64 = patched(z, (d) => d.setUint32(endAt(z) - 4, 3, true));
    expect((await failure(read(split64))).code).toBe('unsupported');
  });

  it('reads names without the UTF-8 flag as Latin-1 unless they are valid UTF-8', async () => {
    const { bytes } = zipOf([file('Grüße.txt', 'x'), file('abc.txt', 'y')]);
    // Rewrite the name in the table of contents to Latin-1 bytes of the same length plus padding.
    const dir = await read(bytes);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cd = -1;
    for (let i = 0; i < bytes.length; i++) if (dv.getUint32(i, true) === 0x02014b50) {
      cd = i;
      break;
    }
    expect(dir.entries[0].path).toBe('Grüße.txt');
    const latin1 = patched(bytes, (d) => {
      d.setUint16(cd + 8, 0, true); // no UTF-8 flag
      // "Grüße.txt" in UTF-8 is 11 bytes: write "Gr\xfc\xdfe.txt" (9 bytes) plus two spaces.
      const name = [0x47, 0x72, 0xfc, 0xdf, 0x65, 0x2e, 0x74, 0x78, 0x74, 0x20, 0x20];
      name.forEach((b, k) => d.setUint8(cd + 46 + k, b));
    });
    expect((await read(latin1)).entries[0].path).toBe('Grüße.txt  ');
    const flaggedBroken = patched(latin1, (d) => d.setUint16(cd + 8, 0x0800, true));
    expect((await read(flaggedBroken)).entries[0].path).toBe('Gr��e.txt  ');
  });

  it.runIf(hasTool('zip'))('reads archives made by Info-ZIP zip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tonuino-zipread-'));
    try {
      const card = join(dir, 'card');
      mkdirSync(join(card, '01'), { recursive: true });
      mkdirSync(join(card, 'Grüße'));
      writeFileSync(join(card, '01', '001.mp3'), 'track 1');
      writeFileSync(join(card, 'Grüße', 'Oma.txt'), 'Hallo');
      const out = join(dir, 'card.zip');
      const r = tool('sh', ['-c', `cd '${card}' && zip -0 -r -q '${out}' 01 Grüße`]);
      expect(r.status, r.stderr).toBe(0);
      const bytes = new Uint8Array(readFileSync(out));
      const got = await read(bytes);
      expect(withoutOffsets(got).sort((a, b) => a.path.localeCompare(b.path))).toEqual(
        expected([folder('01/'), file('01/001.mp3', 'track 1'), folder('Grüße/'), file('Grüße/Oma.txt', 'Hallo')]),
      );
      checkOffsets(bytes, got);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasTool('python3'))('reads ZIP64 archives made by Python', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tonuino-zipread-'));
    try {
      const out = join(dir, 'py.zip');
      const script = [
        'import sys, zipfile',
        "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as z:",
        "    for name, data in [('05/001.mp3', b'one'), ('05/002.mp3', b'two two')]:",
        "        with z.open(name, 'w', force_zip64=True) as f:",
        '            f.write(data)',
      ].join('\n');
      const r = tool('python3', ['-c', script, out]);
      expect(r.status, r.stderr).toBe(0);
      const bytes = new Uint8Array(readFileSync(out));
      const got = await read(bytes);
      expect(withoutOffsets(got)).toEqual(expected([file('05/001.mp3', 'one'), file('05/002.mp3', 'two two')]));
      checkOffsets(bytes, got);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
