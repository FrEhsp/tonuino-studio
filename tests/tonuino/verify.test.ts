import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPackageBlob, manifestOf, packageContent, type PackageManifest, type PackageMode } from '../../src/core/tonuino/package';
import { CATALOG_FILE } from '../../src/core/tonuino/sd';
import { checkCard, checkCardContent, checkDownloadedPackage, checkThoroughly, QUICK_CRC_MAX, replacedByPackage } from '../../src/core/tonuino/verify';
import { crc32 } from '../../src/core/zip/crc32';
import { diffForPackage } from '../../src/core/tonuino/writeplan';
import { cloneTree, nodeAt, type BlobFile, type BlobFolder } from '../../src/platform/blobtree';
import type { MemTree } from '../../src/platform/memory';
import { createOverlay, memoryScratch } from '../../src/platform/overlay';
import { blobTree } from '../platform/blobfixtures';
import { unpack } from './unpack';

const enc = new TextEncoder();

const CARD: MemTree = {
  mp3: { '0001.mp3': 'sound' },
  '05': { '001.mp3': 'eins', '002.mp3': 'zwei', '003.mp3': 'drei' },
  '09': { '001.mp3': 'alt' },
  Alt: { 'x.txt': 'x' },
  [CATALOG_FILE]: '{}',
};

const NAME = 'TonUINO-Paket-0610-1432-AS9.zip';

/** The card, the changes the app made on it, and the Paket for them. */
async function made(mode: PackageMode = 'changes', tree: MemTree = CARD) {
  const base = blobTree(tree, 'TONUINO');
  const ov = createOverlay(base, memoryScratch(), 'TONUINO');
  if (tree === CARD) {
    const five = await ov.root.dir('05');
    await five.remove('003.mp3');
    await five.write('004.mp3', enc.encode('vier!'));
    await (await ov.root.dir('07', { create: true })).write('001.mp3', enc.encode('sieben'));
    await ov.root.remove('09', { recursive: true });
    await ov.root.write(CATALOG_FILE, enc.encode('{"a":1}'));
  }
  const content = packageContent(diffForPackage(base, ov.tree), ov.tree, mode);
  const { blob, layout } = await buildPackageBlob(content);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const m = manifestOf(content, layout, mode === 'full' ? NAME.replace('Paket', 'Karte-komplett') : NAME, 1);
  return { base, bytes, m };
}

/** The card read again: a copy of what was there, with some entries deleted. */
function cardWithout(base: BlobFolder, ...names: string[]): BlobFolder {
  const c = cloneTree(base);
  c.children = c.children.filter((n) => !names.includes(n.name));
  return c;
}

describe('checkCard', () => {
  it('is happy when the Paket was unpacked as the guide says', async () => {
    const { base, bytes, m } = await made();
    expect(m.deleteFirst).toEqual(['05', '09']);
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    expect(checkCard(card, 'TONUINO', m)).toEqual({ ok: true, findings: [] });
  });

  it('notices a folder of the card chosen instead of the card', async () => {
    const { m } = await made();
    const r = checkCard(blobTree({ '001.mp3': 'eins', '002.mp3': 'zwei' }, '05'), '05', m);
    expect(r).toEqual({ ok: false, findings: [{ kind: 'picked-subfolder', name: '05' }] });
  });

  it('notices a Paket unpacked into a folder of its own', async () => {
    const { base, bytes, m } = await made();
    const named = await unpack(cardWithout(base, '05', '09'), bytes, 'TonUINO-Paket-0610-1432-AS9');
    expect(checkCard(named, 'TONUINO', m).findings).toEqual([{ kind: 'nested', folder: 'TonUINO-Paket-0610-1432-AS9' }]);
    const other = await unpack(cardWithout(base, '05', '09'), bytes, 'Neuer Ordner');
    expect(checkCard(other, 'TONUINO', m).findings).toEqual([{ kind: 'nested', folder: 'Neuer Ordner' }]);
  });

  it('notices something that is not the card', async () => {
    const { m } = await made();
    expect(checkCard(blobTree({ Fotos: { 'a.jpg': 'x' } }, 'Bilder'), 'Bilder', m).findings).toEqual([{ kind: 'not-a-card' }]);
  });

  it('notices when nothing of the Paket is on the card', async () => {
    const { base, m } = await made();
    expect(checkCard(cardWithout(base, '05', '09'), 'TONUINO', m).findings).toEqual([{ kind: 'nothing-arrived' }]);
  });

  it('lists missing and incomplete files', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    (nodeAt(card, '07') as BlobFolder).children = [];
    const four = nodeAt(card, '05/004.mp3') as BlobFile;
    four.blob = new File(['vie'], '004.mp3');
    const r = checkCard(card, 'TONUINO', m);
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([
      { kind: 'missing', paths: ['07/001.mp3'] },
      { kind: 'incomplete', paths: ['05/004.mp3'] },
    ]);
  });

  it('notices a folder that was not deleted before unpacking', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '09'), bytes);
    expect(checkCard(card, 'TONUINO', m).findings).toEqual([{ kind: 'leftovers', folder: '05', paths: ['003.mp3'], added: false }]);
  });

  it('notices a folder that should have gone', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05'), bytes);
    expect(checkCard(card, 'TONUINO', m).findings).toEqual([{ kind: 'not-deleted', names: ['09'] }]);
  });

  it('notices the Mac files and the Paket itself on the card', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    (nodeAt(card, '05') as BlobFolder).children.push({ kind: 'file', name: '._004.mp3', blob: new File(['m'], '._004.mp3') });
    card.children.push({ kind: 'file', name: '._07', blob: new File(['m'], '._07') });
    card.children.push({ kind: 'file', name: `${NAME.slice(0, -4)} (1).zip`, blob: new File([bytes as BlobPart], NAME) });
    const r = checkCard(card, 'TONUINO', m);
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([
      { kind: 'appledouble', count: 2 },
      { kind: 'package-on-card', name: 'TonUINO-Paket-0610-1432-AS9 (1).zip' },
    ]);
  });

  it('a whole card on a card that was not formatted: a note, not an error', async () => {
    const { bytes, m } = await made('full', { '01': { '001.mp3': 'eins' }, Musik: { 'a.mp3': 'a' } });
    expect(m.mode).toBe('full');
    const clean = await unpack(blobTree({}, 'TONUINO'), bytes);
    expect(checkCard(clean, 'TONUINO', m)).toEqual({ ok: true, findings: [] });
    const old = await unpack(blobTree({ Alt: { 'x.txt': 'x' }, '.Trashes': {} }, 'TONUINO'), bytes);
    expect(checkCard(old, 'TONUINO', m)).toEqual({ ok: true, findings: [{ kind: 'not-formatted', names: ['Alt'] }] });
  });
});

describe('checkCard and the family’s own folders', () => {
  const file = (path: string, text: string, isNew: boolean) => ({ path, size: enc.encode(text).length, crc32: crc32(enc.encode(text)), isNew });
  /** A Paket that replaces folder 01 (two old tracks, one new) and brings new names. */
  const m: PackageManifest = {
    name: NAME,
    mode: 'changes',
    createdAt: 1,
    size: 1,
    files: [file('01/001.mp3', 'eins', false), file('01/002.mp3', 'zwei', false), file('01/003.mp3', 'drei', true), file(CATALOG_FILE, '{"a":2}', true)],
    topLevel: ['01', CATALOG_FILE],
    deleteFirst: ['01'],
    removeOnly: [],
  };

  it('does not take a backup folder for a mis-unpacked Paket, and never offers to delete it', () => {
    // 01 was deleted as the guide said, then unpacking failed. The family's backup has two of the same tracks.
    const card = blobTree({ mp3: { '0001.mp3': 's' }, Sicherung: { '01': { '001.mp3': 'eins', '002.mp3': 'zwei' } }, [CATALOG_FILE]: '{"a":1}' }, 'TONUINO');
    const r = checkCard(card, 'TONUINO', m);
    expect(r.findings.map((f) => f.kind)).not.toContain('nested');
    expect(r.ok).toBe(false);
  });

  it('does not take a folder with other files in it for the Paket', () => {
    const card = blobTree({ mp3: { '0001.mp3': 's' }, Neu: { '01': { '001.mp3': 'eins', '002.mp3': 'zwei', '003.mp3': 'drei' }, 'urlaub.jpg': 'foto' } }, 'TONUINO');
    expect(checkCard(card, 'TONUINO', m).findings.map((f) => f.kind)).not.toContain('nested');
  });

  it('still finds the Paket in a folder of its own when only part of it arrived there', () => {
    const card = blobTree({ mp3: { '0001.mp3': 's' }, 'Neuer Ordner': { '01': { '003.mp3': 'drei' } } }, 'TONUINO');
    expect(checkCard(card, 'TONUINO', m).findings).toEqual([{ kind: 'nested', folder: 'Neuer Ordner' }]);
  });

  it('says when a folder that was new in the Paket held something before', () => {
    const added: PackageManifest = { ...m, files: [file('07/001.mp3', 'neu', true)], topLevel: ['07'], deleteFirst: [] };
    // Another Paket brought 07 first (four tracks); this one has only one.
    const card = blobTree({ '07': { '001.mp3': 'neu', '002.mp3': 'a', '003.mp3': 'b', '004.mp3': 'c' } }, 'TONUINO');
    expect(checkCard(card, 'TONUINO', added).findings).toEqual([{ kind: 'leftovers', folder: '07', paths: ['002.mp3', '003.mp3', '004.mp3'], added: true }]);
  });
});

describe('checkCardContent', () => {
  it('notices names that kept their size when nothing was unpacked', async () => {
    const { base } = await made('changes', { '01': { '001.mp3': 'eins' }, [CATALOG_FILE]: '{"name":"Annas Box"}' });
    const ov = createOverlay(base, memoryScratch(), 'TONUINO');
    await ov.root.write(CATALOG_FILE, enc.encode('{"name":"Annas Boy"}'));
    const content = packageContent(diffForPackage(base, ov.tree), ov.tree, 'changes');
    const { layout } = await buildPackageBlob(content);
    const m = manifestOf(content, layout, NAME, 1);
    expect(m.files.map((f) => f.path)).toEqual([CATALOG_FILE]);
    // The card as it was: the sizes match, so sizes alone say all is well.
    const untouched = cloneTree(base);
    expect(checkCard(untouched, 'TONUINO', m).ok).toBe(true);
    expect(await checkCardContent(untouched, 'TONUINO', m)).toEqual({ ok: false, findings: [{ kind: 'outdated', paths: [CATALOG_FILE] }] });
  });

  it('is happy with a card where the Paket was unpacked', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    const seen: number[] = [];
    expect(await checkCardContent(card, 'TONUINO', m, { onProgress: (d) => seen.push(d) })).toEqual({ ok: true, findings: [] });
    expect(seen.at(-1)).toBe(m.files.reduce((n, f) => n + f.size, 0));
  });

  it('compares the app’s files of any size, other files only when small', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    const big = { ...m, files: m.files.map((f) => (f.path === '07/001.mp3' ? { ...f, size: QUICK_CRC_MAX + 1 } : f)) };
    (nodeAt(card, '07/001.mp3') as BlobFile).blob = new File([new Uint8Array(QUICK_CRC_MAX + 1)], '001.mp3');
    // A big track of the same size is left to the thorough check.
    expect((await checkCardContent(card, 'TONUINO', big)).ok).toBe(true);
    (nodeAt(card, '05/004.mp3') as BlobFile).blob = new File(['VIER!'], '004.mp3');
    expect(await checkCardContent(card, 'TONUINO', big)).toEqual({ ok: false, findings: [{ kind: 'outdated', paths: ['05/004.mp3'] }] });
  });

  it('counts a file it cannot read as different', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    const gone = new File(['{"a":1}'], CATALOG_FILE);
    Object.defineProperty(gone, 'stream', {
      value: () => {
        throw new DOMException('weg', 'NotFoundError');
      },
    });
    (nodeAt(card, CATALOG_FILE) as BlobFile).blob = gone;
    expect((await checkCardContent(card, 'TONUINO', m)).findings).toEqual([{ kind: 'outdated', paths: [CATALOG_FILE] }]);
  });
});

describe('replacedByPackage', () => {
  it('names the folders and the names a Paket from elsewhere would replace', async () => {
    const { bytes } = await made();
    const dir = await checkDownloadedPackage({ name: NAME, size: bytes.length, read: async (st, l) => bytes.slice(st, st + l) });
    const foreign = (dir as { manifest: PackageManifest }).manifest;
    expect(foreign.deleteFirst).toEqual(['05', '07']);
    const card = blobTree({ '05': { '001.mp3': 'x' }, '07': {}, [CATALOG_FILE]: '{}' }, 'TONUINO');
    // 07 is there, but empty: nothing of the family's is lost there.
    expect(replacedByPackage(card, foreign)).toEqual({ folders: ['05'], appFiles: true });
    expect(replacedByPackage(blobTree({ '01': { '001.mp3': 'x' } }, 'TONUINO'), foreign)).toEqual({ folders: [], appFiles: false });
  });
});

describe('checkThoroughly', () => {
  it('reads every file back and plays the new tracks through', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    const decoded: string[] = [];
    const seen: [number, number][] = [];
    const r = await checkThoroughly(card, m, {
      decode: async (_blob, path) => {
        decoded.push(path);
      },
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(r).toEqual({ crcMismatch: [], decodeFailed: [] });
    expect(decoded).toEqual(['05/004.mp3', '07/001.mp3']);
    const total = m.files.reduce((n, f) => n + f.size, 0) + 5 + 6;
    expect(seen.at(-1)).toEqual([total, total]);
  });

  it('reports files that differ and tracks that do not play', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    (nodeAt(card, '05/001.mp3') as BlobFile).blob = new File(['eint'], '001.mp3');
    const r = await checkThoroughly(card, m, {
      decode: async (_blob, path) => {
        if (path === '07/001.mp3') throw new Error('kaputt');
      },
    });
    expect(r).toEqual({ crcMismatch: ['05/001.mp3'], decodeFailed: ['07/001.mp3'] });
  });

  it('stops when aborted', async () => {
    const { base, bytes, m } = await made();
    const card = await unpack(cardWithout(base, '05', '09'), bytes);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(checkThoroughly(card, m, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('checkDownloadedPackage', () => {
  const asFile = (bytes: Uint8Array, name: string) => ({ name, size: bytes.length, read: async (s: number, l: number) => bytes.slice(s, s + l) });

  it('recognises the Paket, also under another name', async () => {
    const { bytes, m } = await made();
    expect(await checkDownloadedPackage(asFile(bytes, NAME), m)).toEqual({ ok: true, name: NAME, manifest: m });
    const renamed = await checkDownloadedPackage(asFile(bytes, 'TonUINO-Paket-0610-1432-AS9 (1).zip'), m);
    expect(renamed).toMatchObject({ ok: true, name: 'TonUINO-Paket-0610-1432-AS9 (1).zip' });
    expect(renamed.ok && renamed.manifest.name).toBe('TonUINO-Paket-0610-1432-AS9 (1).zip');
  });

  it('says when the download is not finished, not a ZIP, or another Paket', async () => {
    const { bytes, m } = await made();
    expect(await checkDownloadedPackage(asFile(bytes.subarray(0, bytes.length - 30), NAME), m)).toEqual({ ok: false, reason: 'not-finished' });
    expect(await checkDownloadedPackage(asFile(enc.encode('ID3 eine mp3'), 'lied.mp3'), m)).toEqual({ ok: false, reason: 'not-zip' });
    const other = await made('full');
    expect(await checkDownloadedPackage(asFile(other.bytes, NAME), m)).toEqual({ ok: false, reason: 'other-package' });
  });

  it('without a manifest, takes any Paket for a TonUINO card', async () => {
    const { bytes, m } = await made();
    const r = await checkDownloadedPackage(asFile(bytes, NAME));
    expect(r.ok).toBe(true);
    const got = (r as { manifest: PackageManifest }).manifest;
    expect(got.files.map((f) => [f.path, f.size, f.crc32])).toEqual(m.files.map((f) => [f.path, f.size, f.crc32]));
    expect(got.deleteFirst).toEqual(['05', '07']);
    const photos = new JSZip();
    photos.file('Fotos/a.jpg', 'x');
    const zip = await photos.generateAsync({ type: 'uint8array' });
    expect(await checkDownloadedPackage(asFile(zip, 'Fotos.zip'))).toEqual({ ok: false, reason: 'other-package' });
  });
});
