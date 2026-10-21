/**
 * Real SD cards on macOS (.github/workflows/mac-test.yml): disk images
 * formatted by macOS (FAT32, exFAT), attached with hdiutil so they mount
 * under /Volumes, with the hidden files macOS leaves (TODO #95c). Runs only
 * there, in two phases the workflow starts:
 *
 * - MAC_CARDS_PHASE=tidy, MAC_CARDS=/Volumes/A:rw,/Volumes/B:ro: the app's
 *   card scan reads the layout and sees the junk, then the tidying the app
 *   does right before ejecting (state.ts ejectVolume) runs on the mounted card.
 * - MAC_CARDS_PHASE=after, MAC_CARD_IMAGES=a.cdr,b.cdr: after the app ejected
 *   the cards (mac_card_tests.rs), the raw images are read without macOS
 *   (fat.ts): nothing of macOS may be left, the app's writes must be there.
 */
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMacJunk, tidyMacJunk } from '../../src/core/tonuino/macjunk';
import { scanSd } from '../../src/core/tonuino/sd';
import type { ByteSource, Dir, DirEntry } from '../../src/platform/types';
import { listDir, readFile } from './sd/fat';

const phase = process.platform === 'darwin' ? process.env.MAC_CARDS_PHASE : undefined;

/** A folder on a mounted volume, through Node's file functions (as fsops.rs does it through Rust's). */
class NodeDir implements Dir {
  constructor(readonly path: string) {}
  get name(): string {
    return this.path.split('/').pop() ?? this.path;
  }
  async list(): Promise<DirEntry[]> {
    return readdirSync(this.path, { withFileTypes: true }).flatMap((e): DirEntry[] => {
      if (!e.isFile() && !e.isDirectory()) return [];
      const st = statSync(join(this.path, e.name));
      return [{ name: e.name, kind: e.isDirectory() ? 'directory' : 'file', size: e.isFile() ? st.size : undefined, modified: st.mtimeMs }];
    });
  }
  async dir(name: string, opts?: { create?: boolean }): Promise<Dir> {
    if (opts?.create) await mkdir(join(this.path, name), { recursive: true });
    return new NodeDir(join(this.path, name));
  }
  async exists(name: string): Promise<boolean> {
    return existsSync(join(this.path, name));
  }
  async read(name: string): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(join(this.path, name)));
  }
  async readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    return (await this.read(name)).subarray(start, start + length);
  }
  async source(name: string): Promise<ByteSource> {
    const data = await this.read(name);
    return { name, size: data.length, path: join(this.path, name), read: async (s, l) => data.subarray(s, s + l) };
  }
  async write(name: string, data: Uint8Array | Blob): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    const fd = openSync(join(this.path, name), 'w');
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  async remove(name: string, opts?: { recursive?: boolean }): Promise<void> {
    rmSync(join(this.path, name), { recursive: !!opts?.recursive });
  }
  async rename(from: string, to: string): Promise<void> {
    renameSync(join(this.path, from), join(this.path, to));
  }
  async move(name: string, target: Dir, newName?: string): Promise<void> {
    renameSync(join(this.path, name), join((target as NodeDir).path, newName ?? name));
  }
}

function cards(): { mount: string; readOnly: boolean }[] {
  return (process.env.MAC_CARDS ?? '')
    .split(',')
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(':');
      return { mount: s.slice(0, i), readOnly: s.slice(i + 1) === 'ro' };
    });
}

describe.skipIf(phase !== 'tidy')('Mac: SD-Karte eingesteckt, aufräumen vor dem Auswerfen', () => {
  for (const card of cards()) {
    it(`${card.mount}${card.readOnly ? ' (schreibgeschützt)' : ''}`, async () => {
      const root = new NodeDir(card.mount);
      const scan = await scanSd(root);
      console.log(`${card.mount}: oben ${(await root.list()).map((e) => e.name).join(' ')}`);
      expect(scan.kind).toBe('tonuino');
      expect(scan.folders.map((f) => f.number)).toEqual(expect.arrayContaining([1, 2]));
      const f1 = scan.folders.find((f) => f.number === 1)!;
      expect(f1.tracks.map((t) => t.name)).toEqual(expect.arrayContaining(['001.mp3', '003.mp3']));
      // The Finder-like copy of 003.mp3 (with an extended attribute) left its "._" twin; the scan counts it as junk, not as a track.
      expect(f1.junk.map((e) => e.name)).toEqual(expect.arrayContaining(['._003.mp3', '.DS_Store']));
      expect(f1.tracks.some((t) => t.name.startsWith('._'))).toBe(false);
      expect(scan.system.mp3?.files.length).toBe(1);
      expect(scan.system.advert?.files.length).toBe(1);

      // The app tidies only cards it may write to (ejectVolume).
      if (card.readOnly) return;
      const tidy = await tidyMacJunk(root);
      console.log(`${card.mount}: weggeräumt ${tidy.removed.join(' ') || '–'}; geblieben ${tidy.left.join(' ') || '–'}`);
      // "._.Trashes" goes with ".Trashes": macOS deletes a file's "._" twin along with it.
      expect(tidy.removed).toEqual(expect.arrayContaining(['01/._003.mp3', '01/.DS_Store', '.Trashes']));
      expect((await root.list()).map((e) => e.name)).not.toContain('._.Trashes');
      expect(tidy.left.filter((p) => p.includes('/'))).toEqual([]);
      const again = await scanSd(root);
      expect(again.folders.find((f) => f.number === 1)!.junk).toEqual([]);
    });
  }
});

/** Every entry of the image's top level and of its box folders, as paths. */
function allPaths(image: string): string[] {
  const out: string[] = [];
  for (const e of listDir(image, '')) {
    out.push(e.name);
    if (e.kind === 'directory' && !isMacJunk(e.name) && /^(\d\d|mp3|advert)$/i.test(e.name)) for (const f of listDir(image, e.name)) out.push(`${e.name}/${f.name}`);
  }
  return out;
}

describe.skipIf(phase !== 'after')('Mac: SD-Karte ausgeworfen, was ist noch drauf', () => {
  for (const image of (process.env.MAC_CARD_IMAGES ?? '').split(',').filter(Boolean)) {
    it(image, () => {
      const paths = allPaths(image);
      console.log(`${image}: ${paths.join(' ')}`);
      expect(paths.filter((p) => isMacJunk(p.split('/').pop()!))).toEqual([]);
      expect(paths.filter((p) => /\.tonuino-(tmp|open)$/.test(p))).toEqual([]);
      expect(paths).toEqual(expect.arrayContaining(['01/001.mp3', '01/002.mp3', '01/003.mp3', '03/001.mp3', 'tonuino-studio.json']));
      // FAT: what the app wrote through fsops.rs is on the card (exFAT files are not read by fat.ts).
      if (!/exfat/i.test(image)) {
        expect(new TextDecoder().decode(readFile(image, 'tonuino-studio.json'))).toBe('{"version":2}');
        expect(readFile(image, '01/002.mp3').length).toBe(200_000);
        expect(readFile(image, '01/001.mp3').length).toBe(150_000);
      }
    });
  }
});
