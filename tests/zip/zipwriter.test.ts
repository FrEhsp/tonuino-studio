import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../../src/core/zip/crc32';
import { dosDateTime, EMPTY_ZIP, layoutZip, ZipPathError } from '../../src/core/zip/zipwriter';
import { readZipDirectory } from '../../src/core/zip/zipreader';
import { assemble, bytesReader, CARD, file, folder, hasTool, layoutReader, tool, withTool, zipOf, type TestFile } from './helpers';

async function jszipRoundTrip(bytes: Uint8Array, files: TestFile[]) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  expect(Object.keys(zip.files)).toEqual(files.map((f) => f.path));
  for (const f of files) {
    const entry = zip.file(f.path);
    if (!f.data) {
      expect(zip.files[f.path].dir, f.path).toBe(true);
      continue;
    }
    expect(entry, f.path).not.toBeNull();
    expect(await entry!.async('uint8array'), f.path).toEqual(f.data);
  }
}

/** Central directory headers of an archive, raw. */
function centralHeaders(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { madeBy: number; needed: number; flags: number; time: number; date: number; attrs: number; name: string }[] = [];
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (dv.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = dv.getUint16(i + 28, true);
    out.push({
      madeBy: dv.getUint16(i + 4, true),
      needed: dv.getUint16(i + 6, true),
      flags: dv.getUint16(i + 8, true),
      time: dv.getUint16(i + 12, true),
      date: dv.getUint16(i + 14, true),
      attrs: dv.getUint32(i + 38, true),
      name: new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLen)),
    });
  }
  return out;
}

describe('layoutZip', () => {
  it('builds an archive JSZip reads back with every CRC checked', async () => {
    const { bytes, layout } = zipOf(CARD);
    expect(layout.zip64).toBe(false);
    expect(layout.entryCount).toBe(CARD.length);
    await jszipRoundTrip(bytes, CARD);
  });

  it('builds the same content with every ZIP64 field forced', async () => {
    const { bytes, layout } = zipOf(CARD, { forceZip64: true });
    expect(layout.zip64).toBe(true);
    await jszipRoundTrip(bytes, CARD);
    const dir = await readZipDirectory(bytesReader(bytes), bytes.length);
    expect(dir.zip64).toBe(true);
    expect(dir.entries.map((e) => [e.path, e.size])).toEqual(CARD.map((f) => [f.path, f.data?.length ?? 0]));
  });

  it('an empty archive is just the end record', async () => {
    const { bytes, layout } = zipOf([]);
    expect(bytes).toEqual(EMPTY_ZIP);
    expect(layout.size).toBe(22);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toEqual([]);
  });

  it('sets the UTF-8 flag only for names that need it, says Unix and gives sensible attributes', () => {
    const { bytes } = zipOf(CARD);
    const headers = centralHeaders(bytes);
    for (const h of headers) {
      const ascii = !/[^\x20-\x7e]/.test(h.name);
      expect(h.flags & 0x0800, h.name).toBe(ascii ? 0 : 0x0800);
      expect(h.madeBy >> 8, h.name).toBe(3);
      if (h.name.endsWith('/')) {
        expect(h.attrs >>> 16, h.name).toBe(0o40755);
        expect(h.attrs & 0xff, h.name).toBe(0x10);
        expect(h.needed, h.name).toBe(20);
      } else {
        expect(h.attrs >>> 16, h.name).toBe(0o100644);
        expect(h.attrs & 0xff, h.name).toBe(0x20);
        expect(h.needed, h.name).toBe(10);
      }
    }
    expect(headers.find((h) => h.name.includes('Oma'))!.name).toBe('Andere Sachen/Grüße an Oma.txt');
  });

  it('writes the time in MS-DOS form, in two-second steps', () => {
    const { date, time } = dosDateTime(new Date(2026, 9, 6, 14, 32, 11));
    expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 6);
    expect(time).toBe((14 << 11) | (32 << 5) | 5);
    expect(dosDateTime(new Date(1970, 0, 1))).toEqual({ date: 33, time: 0 });
    const { bytes } = zipOf(CARD);
    const h = centralHeaders(bytes)[0];
    expect([h.date, h.time]).toEqual([((2026 - 1980) << 9) | (10 << 5) | 6, (14 << 11) | (32 << 5) | 5]);
  });

  it('refuses names a card cannot hold', () => {
    const bad = ['', '/', '/abs.mp3', 'a/../b.mp3', './a.mp3', 'a\\b.mp3', 'a//b.mp3', 'tab\there.mp3', 'x\u0000.mp3', 'a'.repeat(70000)];
    for (const path of bad) expect(() => layoutZip([{ path, size: 1, crc32: 0 }]), JSON.stringify(path.slice(0, 20))).toThrow(ZipPathError);
  });

  it('refuses two names that differ only in case, files and folders alike', () => {
    expect(() =>
      layoutZip([
        { path: '05/001.mp3', size: 1, crc32: 0 },
        { path: '05/001.MP3', size: 1, crc32: 0 },
      ]),
    ).toThrow(/zweimal/);
    expect(() =>
      layoutZip([
        { path: 'MP3/', size: 0, crc32: 0 },
        { path: 'mp3/', size: 0, crc32: 0 },
      ]),
    ).toThrow(ZipPathError);
    expect(() =>
      layoutZip([
        { path: 'mp3', size: 1, crc32: 0 },
        { path: 'mp3/', size: 0, crc32: 0 },
      ]),
    ).toThrow(ZipPathError);
  });

  it('merges header bytes into as few parts as possible', () => {
    const { layout } = zipOf(CARD);
    for (let i = 1; i < layout.parts.length; i++) {
      expect(layout.parts[i - 1] instanceof Uint8Array && layout.parts[i] instanceof Uint8Array, `parts ${i - 1} and ${i}`).toBe(false);
    }
    const entries = layout.parts.filter((p) => !(p instanceof Uint8Array)).map((p) => (p as { entry: number }).entry);
    // Folders and empty files have no data part; every other file has exactly one, in order.
    expect(entries).toEqual(CARD.flatMap((f, i) => (f.data?.length ? [i] : [])));
    const sum = layout.parts.reduce((n, p) => n + (p instanceof Uint8Array ? p.length : CARD[p.entry].data!.length), 0);
    expect(sum).toBe(layout.size);
  });

  it('keeps an empty file as a file with no data part', async () => {
    const files = [folder('01/'), file('01/001.mp3', ''), file('01/002.mp3', 'x')];
    const { bytes } = zipOf(files);
    await jszipRoundTrip(bytes, files);
  });

  it('uses the ZIP64 end record for 70,000 entries, which every reader understands', async () => {
    const files: TestFile[] = [];
    for (let f = 1; f <= 99 && files.length < 70_000; f++) {
      const dir = String(f).padStart(2, '0');
      files.push(folder(`${dir}/`));
      for (let t = 1; t <= 255 && files.length < 70_000; t++) files.push(file(`${dir}/${String(t).padStart(3, '0')}.mp3`, `x${f}-${t}`));
    }
    while (files.length < 70_000) files.push(file(`extra/${files.length}.txt`, `y${files.length}`));
    const { bytes, layout } = zipOf(files);
    expect(layout.zip64).toBe(true);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint16(bytes.length - 22 + 10, true)).toBe(0xffff);
    expect(dv.getUint32(bytes.length - 22 - 20, true)).toBe(0x07064b50);
    const dir = await readZipDirectory(bytesReader(bytes), bytes.length);
    expect(dir.entries.length).toBe(70_000);
    expect(dir.entries[69_999].path).toBe(files[69_999].path);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(Object.keys(zip.files).length).toBe(70_000);
    if (hasTool('unzip')) {
      const r = withTool(bytes, (p) => tool('unzip', ['-tqq', p]));
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  }, 120_000);

  it('describes files over 4 GiB with ZIP64 sizes and offsets (layout only)', async () => {
    const big = 5 * 1024 ** 3 + 123;
    const entries = [
      { path: '01/', size: 0, crc32: 0 },
      { path: '01/001.mp3', size: big, crc32: 0x11223344 },
      { path: '01/002.mp3', size: 17, crc32: 0x55667788 },
      { path: '02/', size: 0, crc32: 0 },
    ];
    const layout = layoutZip(entries, { now: new Date(2026, 9, 6) });
    expect(layout.zip64).toBe(true);
    const sizes = entries.map((e) => e.size);
    const dir = await readZipDirectory(layoutReader(layout, sizes), layout.size);
    expect(dir.zip64).toBe(true);
    expect(dir.entries.map((e) => [e.path, e.size, e.crc32])).toEqual(entries.map((e) => [e.path, e.size, e.crc32]));
    // The local header of each entry sits where the central directory says.
    const read = layoutReader(layout, sizes);
    for (const e of dir.entries) {
      const h = await read(e.offset, 4);
      expect(new DataView(h.buffer).getUint32(0, true), e.path).toBe(0x04034b50);
    }
    expect(dir.entries[2].offset).toBeGreaterThan(0xffffffff);
    expect(layout.size).toBeGreaterThan(big);
  });
});

describe('outside tools read the archives', () => {
  const tools = hasTool('unzip') && hasTool('zipinfo') && hasTool('python3');

  it.skipIf(!tools)('unzip tests it, zipinfo lists it in order, Python finds nothing wrong', () => {
    for (const force of [false, true]) {
      const { bytes } = zipOf(CARD, { forceZip64: force });
      withTool(bytes, (path) => {
        const t = tool('unzip', ['-t', path]);
        expect(t.status, t.stdout + t.stderr).toBe(0);
        expect(t.stdout).toContain('No errors detected');
        const list = tool('zipinfo', ['-1', path]);
        expect(list.stdout.trim().split('\n')).toEqual(CARD.map((f) => f.path));
        const py = tool('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print("\\n".join(z.namelist()))', path]);
        expect(py.status, py.stderr).toBe(0);
        const [first, ...names] = py.stdout.trim().split('\n');
        expect(first).toBe('None');
        expect(names).toEqual(CARD.map((f) => f.path));
      });
    }
  });

  /** strace writes bytes outside ASCII as octal escapes ("\\303\\266"). */
  function unescape(s: string): string {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const m = /^\\([0-7]{3})/.exec(s.slice(i));
      if (m) {
        bytes.push(parseInt(m[1], 8));
        i += 3;
      } else bytes.push(...new TextEncoder().encode(s[i]));
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  /** Files and folders an extractor creates, in the order it creates them (strace). */
  function creationOrder(cmd: string[], out: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'tonuino-trace-'));
    try {
      const log = join(dir, 'trace.log');
      const r = tool('strace', ['-f', '-e', 'trace=openat,mkdir,mkdirat', '-o', log, ...cmd]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const lines = tool('cat', [log]).stdout.split('\n');
      const made: string[] = [];
      for (const line of lines) {
        const m = /(?:mkdir(?:at)?\((?:AT_FDCWD, )?|openat\(AT_FDCWD, )"([^"]+)"(.*)$/.exec(line);
        if (!m || !m[1].startsWith(out + '/')) continue;
        if (line.includes('openat') && !m[2].includes('O_CREAT')) continue;
        const rel = unescape(m[1].slice(out.length + 1)) + (line.includes('mkdir') ? '/' : '');
        if (!made.includes(rel)) made.push(rel);
      }
      return made;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(!tools || !hasTool('strace'))('unzip and Python create files in archive order, names in UTF-8', () => {
    const files = [folder('mp3/'), file('mp3/0002.mp3', 'b'), file('mp3/0001.mp3', 'a'), folder('Größe/'), file('Größe/Ä.txt', 'ä'), folder('01/'), file('01/001.mp3', 'c')];
    const { bytes } = zipOf(files);
    withTool(bytes, (path) => {
      for (const cmd of [(out: string) => ['unzip', '-o', path, '-d', out], (out: string) => ['python3', '-m', 'zipfile', '-e', path, out]]) {
        const out = mkdtempSync(join(tmpdir(), 'tonuino-unzip-'));
        try {
          expect(creationOrder(cmd(out), out)).toEqual(files.map((f) => f.path));
          expect(tool('cat', [join(out, 'Größe', 'Ä.txt')]).stdout).toBe('ä');
        } finally {
          rmSync(out, { recursive: true, force: true });
        }
      }
    });
  });

  it.skipIf(!process.env.ZIP64_BIG || !hasTool('unzip'))('unzip checks a real archive over 4 GiB (ZIP64_BIG=1)', () => {
    const big = 4 * 1024 ** 3 + 100 * 1024 ** 2 + 7;
    const zeros = Buffer.alloc(64 * 1024 * 1024);
    let c = 0;
    for (let left = big; left > 0; left -= zeros.length) c = zlibCrc32(zeros.subarray(0, Math.min(left, zeros.length)), c);
    const tail = new TextEncoder().encode('after the big one');
    const entries = [
      { path: '01/', size: 0, crc32: 0 },
      { path: '01/001.mp3', size: big, crc32: c >>> 0 },
      { path: '01/002.mp3', size: tail.length, crc32: crc32(tail) },
    ];
    const layout = layoutZip(entries);
    const dir = mkdtempSync(join(tmpdir(), 'tonuino-big-'));
    try {
      const path = join(dir, 'big.zip');
      const fd = openSync(path, 'w');
      let pos = 0;
      for (const p of layout.parts) {
        if (p instanceof Uint8Array) {
          writeSync(fd, p, 0, p.length, pos);
          pos += p.length;
        } else if (p.entry === 2) {
          writeSync(fd, tail, 0, tail.length, pos);
          pos += tail.length;
        } else pos += entries[p.entry].size;
      }
      ftruncateSync(fd, pos);
      closeSync(fd);
      const r = tool('unzip', ['-t', path]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it('assembles exactly the size the layout promises', () => {
    const { layout } = zipOf(CARD);
    expect(assemble(layout, CARD).length).toBe(layout.size);
  });
});
