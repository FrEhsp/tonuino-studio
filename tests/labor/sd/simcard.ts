/**
 * SD card readers for the test bench (TODO #69): card images written by
 * mtools (a real FAT implementation, no mount, no root) and read with
 * fat.ts, behind the desktop app's own commands (fs_*, volume_*). The app's
 * TauriVolumes and TauriDir talk to them through a fake IPC exactly as they
 * talk to src-tauri/src/fsops.rs and volumes.rs, so the app code from the
 * bridge up runs unchanged.
 *
 * What the reader can do to a card, like a real one: mount it read-only
 * (lock slider), mount it for root (fstab, `sudo mount`), answer slowly,
 * lose it in the middle of a write, run out of space. Writes follow
 * fsops.rs: a new file is written in place, an existing one goes to
 * "<name>.tonuino-tmp" first and takes the old file's place only when it
 * is complete (as Linux's vfat keeps the old directory slot); a new file
 * has the empty marker "<name>.tonuino-open" next to it until it is complete.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeIpc } from '../../platform-tauri/fake-ipc';
import { Bridge } from '../../../src/platform/tauri/bridge';
import { TauriVolumes, type VolumeDto } from '../../../src/platform/tauri/volumes';
import { FatError, geometry, listDir, parts, readFile, statPath } from './fat';

const PARTIAL = '.tonuino-tmp';
const OPEN = '.tonuino-open';
const MT_ENV = { ...process.env, MTOOLS_SKIP_CHECK: '1', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' };

export class CmdErr {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {}
}

/** Runs an mtools program on the image; its complaints become the error codes of fsops.rs. */
function mtools(program: string, args: string[]): void {
  try {
    execFileSync(program, args, { env: MT_ENV, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  } catch (e) {
    const said = String((e as { stderr?: Buffer }).stderr ?? e).trim();
    const code = /disk full|no free clusters/i.test(said)
      ? 'no-space'
      : /not found/i.test(said)
        ? 'not-found'
        : /already exists/i.test(said)
          ? 'exists'
          : /non empty|not empty/i.test(said)
            ? 'not-empty'
            : 'io';
    throw new CmdErr(code, `${program}: ${said}`);
  }
}

export interface CardSpec {
  /** Where the system mounts it, e.g. /media/ben/TONUINO. */
  mountPath: string;
  image: string;
  label?: string;
  /** What the system names the file system; the image's own type otherwise (vfat, exfat). */
  fsType?: string;
  /** What the system reports as the size; the image's own otherwise (a big disk with a small image behind it). */
  totalBytes?: number;
  removable?: boolean;
  device?: string;
}

export interface FormatOptions {
  /** Size of the image in MiB (sparse). */
  mib: number;
  label?: string;
  /** Sectors per cluster (FAT32: at least 65525 clusters, so small images take small clusters). */
  clusterSectors?: number;
  /** 'fat32' (mformat -F) or 'exfat' (mkfs.exfat). */
  fs?: 'fat32' | 'exfat';
}

/** A card image: what is on it and what the reader does with it. */
export class SimCard {
  readOnly = false;
  /** Mounted for root: this user may read, not write ("Schreibrechte holen" fixes it). */
  foreignOwner = false;
  /** Out of the reader: every command fails. */
  pulled = false;
  /** The reader pulls it out after this many more written chunks. */
  pullAfterChunks: number | undefined;
  /** A slow reader: every command waits this long. */
  delayMs = 0;
  /** Command names in the order the app sent them. */
  readonly log: string[] = [];
  private readonly scratch: string;
  private uploads = new Map<string, { parts: Buffer[]; written: string }>();

  constructor(readonly spec: CardSpec) {
    this.scratch = mkdtempSync(join(tmpdir(), 'labor-simcard-'));
  }

  /** Makes an empty image. */
  static format(image: string, o: FormatOptions): void {
    rmSync(image, { force: true });
    execFileSync('truncate', ['-s', `${o.mib}M`, image]);
    if (o.fs === 'exfat') {
      execFileSync('mkfs.exfat', ['-L', o.label ?? 'SD', image], { stdio: 'ignore' });
      return;
    }
    // 32 sectors per track, 64 heads: one "cylinder" is 1 MiB.
    mtools('mformat', ['-C', '-i', image, '-T', String(o.mib * 2048), '-h', '64', '-s', '32', '-F', '-c', String(o.clusterSectors ?? 1), '-v', o.label ?? 'TONUINO', '::']);
  }

  get image(): string {
    return this.spec.image;
  }

  dispose(): void {
    rmSync(this.scratch, { recursive: true, force: true });
  }

  /* ------------------------------------------ preparing the card (the test's side) */

  /** Puts a file on the card, as another computer would (mtime: when given, else now). */
  put(path: string, data: Uint8Array | string, mtime?: Date): void {
    const ps = parts(path);
    for (let i = 1; i < ps.length; i++) this.mkdirp(ps.slice(0, i).join('/'));
    const host = this.hostFile(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
    if (mtime) utimesSync(host, mtime, mtime);
    mtools('mcopy', ['-o', ...(mtime ? ['-m'] : []), '-i', this.image, host, `::/${ps.join('/')}`]);
  }

  mkdirp(path: string): void {
    const ps = parts(path);
    for (let i = 1; i <= ps.length; i++) {
      const p = ps.slice(0, i).join('/');
      const e = statPath(this.image, p);
      if (!e) mtools('mmd', ['-i', this.image, `::/${p}`]);
    }
  }

  /** Sets (true) or clears the FAT read-only attribute. */
  setReadOnly(path: string, on: boolean): void {
    mtools('mattrib', ['-i', this.image, on ? '+r' : '-r', `::/${parts(path).join('/')}`]);
  }

  /** Names in a folder, in their order on the card. */
  names(path = ''): string[] {
    return listDir(this.image, path).map((e) => e.name);
  }

  /** What fsck.fat finds wrong with the image (empty: nothing). FAT only. */
  fsck(): string {
    try {
      execFileSync('fsck.fat', ['-n', this.image], { stdio: ['ignore', 'pipe', 'pipe'] });
      return '';
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? '') + String((e as { stderr?: Buffer }).stderr ?? '');
    }
  }

  /* --------------------------------------------------- the reader (the app's side) */

  dto(): VolumeDto {
    const g = geometry(this.image);
    const writable = !this.readOnly && !this.foreignOwner;
    return {
      id: this.spec.mountPath,
      label: this.spec.label ?? (g.label || 'SD'),
      mountPath: this.spec.mountPath,
      fsType: this.spec.fsType ?? (g.type === 'exFAT' ? 'exfat' : 'vfat'),
      clusterSize: g.clusterSize,
      totalBytes: this.spec.totalBytes ?? g.totalBytes,
      freeBytes: this.spec.totalBytes ? Math.max(0, this.spec.totalBytes - (g.totalBytes - g.freeBytes)) : g.freeBytes,
      removable: this.spec.removable ?? true,
      device: this.spec.device ?? '/dev/sdb1',
      canEject: this.spec.removable ?? true,
      writable,
      readOnly: this.readOnly,
      foreignOwner: this.foreignOwner,
      canFixAccess: this.foreignOwner && !this.readOnly,
    };
  }

  private hostFile(data: Buffer): string {
    const p = join(this.scratch, `f${Math.random().toString(36).slice(2)}`);
    writeFileSync(p, data);
    return p;
  }

  private gate(write: boolean): void {
    if (this.pulled) throw new CmdErr('not-found', `${this.spec.mountPath}: no such file or directory (card pulled)`);
    if (!write) return;
    if (this.readOnly) throw new CmdErr('read-only', 'Read-only file system (os error 30)');
    if (this.foreignOwner) throw new CmdErr('permission', 'Permission denied (os error 13)');
  }

  private fatCall<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof FatError) throw new CmdErr(e.code === 'unsupported' ? 'other' : e.code, e.message);
      throw e;
    }
  }

  private mt(p: string): string {
    return `::/${parts(p).join('/')}`;
  }

  /** One command of fsops.rs, with `inner` the path below the mount point. */
  async command(cmd: string, inner: string, args: Record<string, unknown>, body?: Uint8Array, headers: Record<string, string> = {}): Promise<unknown> {
    this.log.push(cmd);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const exfat = geometryType(this) === 'exFAT';
    switch (cmd) {
      case 'fs_list':
        this.gate(false);
        return this.fatCall(() =>
          listDir(this.image, inner).map((e) => ({ name: e.name, kind: e.kind, ...(e.kind === 'file' ? { size: e.size } : {}), ...(e.modified ? { modified: e.modified } : {}), ...(e.readOnly ? { readOnly: true } : {}) })),
        );
      case 'fs_stat': {
        this.gate(false);
        const e = this.fatCall(() => statPath(this.image, inner));
        if (!e) throw new CmdErr('not-found', `${inner}: No such file or directory (os error 2)`);
        return { kind: e.kind, size: e.size, modified: e.modified || null, readOnly: e.readOnly };
      }
      case 'fs_exists':
        this.gate(false);
        return !!this.fatCall(() => statPath(this.image, inner));
      case 'fs_read':
        this.gate(false);
        return this.fatCall(() => readFile(this.image, inner));
      case 'fs_read_range': {
        this.gate(false);
        const all = this.fatCall(() => readFile(this.image, inner));
        const start = Number(args.start);
        return all.slice(start, start + Number(args.length));
      }
    }
    this.gate(true);
    if (exfat) throw new CmdErr('other', 'labor: no writer for exFAT images');
    switch (cmd) {
      case 'fs_write':
        this.writeWhole(inner, Buffer.from(body ?? new Uint8Array()));
        return null;
      case 'fs_write_chunk':
        return this.chunk(inner, Number(headers['x-offset'] ?? 0), Buffer.from(body ?? new Uint8Array()));
      case 'fs_write_finish': {
        const up = this.uploads.get(inner);
        if (!up) throw new CmdErr('io', `${inner}: the upload was interrupted`);
        this.uploads.delete(inner);
        const data = Buffer.concat(up.parts);
        if (up.written !== inner) {
          // The complete copy is there: it takes the old file's place (and slot).
          mtools('mdel', ['-i', this.image, this.mt(up.written)]);
          mtools('mcopy', ['-o', '-i', this.image, this.hostFile(data), this.mt(inner)]);
        }
        this.dropMarker(inner);
        return null;
      }
      case 'fs_write_abort': {
        const up = this.uploads.get(inner);
        this.uploads.delete(inner);
        if (up && statPath(this.image, up.written)) mtools('mdel', ['-i', this.image, this.mt(up.written)]);
        if (up?.written === inner) this.dropMarker(inner);
        return null;
      }
      case 'fs_mkdir': {
        const e = statPath(this.image, inner);
        if (e?.kind === 'directory') return null;
        if (e) throw new CmdErr('not-a-directory', `${inner} is a file`);
        if (args.recursive) this.mkdirp(inner);
        else {
          const parent = parts(inner).slice(0, -1).join('/');
          if (!statPath(this.image, parent)) throw new CmdErr('not-found', `${parent}: No such file or directory (os error 2)`);
          mtools('mmd', ['-i', this.image, this.mt(inner)]);
        }
        return null;
      }
      case 'fs_remove': {
        if (!parts(inner).length) throw new CmdErr('not-allowed', 'the card itself');
        const up = this.uploads.get(inner);
        if (up) {
          this.uploads.delete(inner);
          if (up.written !== inner && statPath(this.image, up.written)) mtools('mdel', ['-i', this.image, this.mt(up.written)]);
          else this.dropMarker(inner);
        }
        const e = statPath(this.image, inner);
        if (!e) {
          if (up) return null;
          throw new CmdErr('not-found', `${inner}: No such file or directory (os error 2)`);
        }
        if (e.kind === 'file') mtools('mdel', ['-i', this.image, this.mt(inner)]);
        else if (args.recursive) mtools('mdeltree', ['-i', this.image, this.mt(inner)]);
        else {
          if (listDir(this.image, inner).length) throw new CmdErr('not-empty', `${inner}: Directory not empty (os error 39)`);
          mtools('mrd', ['-i', this.image, this.mt(inner)]);
        }
        return null;
      }
      case 'fs_rename': {
        const to = String(args.toInner);
        if (!parts(inner).length) throw new CmdErr('not-allowed', 'the card itself');
        const from = statPath(this.image, inner);
        if (!from) throw new CmdErr('not-found', `${inner}: No such file or directory (os error 2)`);
        const target = statPath(this.image, to);
        const caseOnly = inner.toLowerCase() === to.toLowerCase();
        if (target && !caseOnly) throw new CmdErr('exists', `${to} already exists`);
        if (caseOnly) {
          // mtools refuses a rename onto the same short name: go through a helper name, as the FAT driver does in one step.
          const tmp = `${parts(inner).slice(0, -1).join('/')}/__labor_rename__`;
          mtools('mren', ['-i', this.image, this.mt(inner), this.mt(tmp)]);
          mtools('mren', ['-i', this.image, this.mt(tmp), this.mt(to)]);
        } else mtools('mren', ['-i', this.image, this.mt(inner), this.mt(to)]);
        return null;
      }
      case 'fs_make_writable': {
        const list = (args.paths as string[]) ?? [];
        let changed = 0;
        const clear = (p: string) => {
          const e = statPath(this.image, p);
          if (e?.readOnly) {
            this.setReadOnly(p, false);
            changed++;
          }
          if (e?.kind === 'directory' || !parts(p).length) for (const c of listDir(this.image, p)) clear(`${p}/${c.name}`);
        };
        if (list.length) for (const p of list) clear(`${inner}/${p}`);
        else clear(inner);
        return changed;
      }
    }
    throw new CmdErr('other', `labor: ${cmd} not simulated`);
  }

  /** fs_write: Upload::create + write_all + finish of fsops.rs. */
  private writeWhole(inner: string, data: Buffer): void {
    const old = statPath(this.image, inner);
    if (old?.kind === 'directory') throw new CmdErr('not-a-file', `${inner} is a folder`);
    if (old?.readOnly) throw new CmdErr('permission', `${inner}: Permission denied (os error 13)`);
    const host = this.hostFile(data);
    if (!old) {
      // A failed write leaves nothing (mtools removes what it began, as Upload::abort does); the marker comes and goes.
      mtools('mcopy', ['-o', '-i', this.image, host, this.mt(inner)]);
      return;
    }
    const partial = inner + PARTIAL;
    try {
      mtools('mcopy', ['-o', '-i', this.image, host, this.mt(partial)]);
    } catch (e) {
      if (statPath(this.image, partial)) mtools('mdel', ['-i', this.image, this.mt(partial)]);
      throw e;
    }
    mtools('mdel', ['-i', this.image, this.mt(partial)]);
    mtools('mcopy', ['-o', '-i', this.image, host, this.mt(inner)]);
    this.dropMarker(inner);
  }

  /** Upload::finish and abort: the marker of an unfinished write goes (also one a cut-off earlier write left). */
  private dropMarker(inner: string): void {
    if (statPath(this.image, inner + OPEN)) mtools('mdel', ['-i', this.image, this.mt(inner + OPEN)]);
  }

  /** fs_write_chunk: what is written so far lands on the card at once, so a pulled card keeps it. */
  private chunk(inner: string, offset: number, data: Buffer): null {
    if (offset === 0) {
      const old = statPath(this.image, inner);
      if (old?.kind === 'directory') throw new CmdErr('not-a-file', `${inner} is a folder`);
      this.uploads.set(inner, { parts: [], written: old ? inner + PARTIAL : inner });
    }
    const up = this.uploads.get(inner);
    if (!up) throw new CmdErr('io', `${inner}: the upload was interrupted`);
    if (this.pullAfterChunks !== undefined && this.pullAfterChunks-- <= 0) {
      this.pulled = true;
      this.pullAfterChunks = undefined;
      this.uploads.delete(inner);
      throw new CmdErr('io', `${inner}: Input/output error (os error 5)`);
    }
    up.parts.push(data);
    try {
      mtools('mcopy', ['-o', '-i', this.image, this.hostFile(Buffer.concat(up.parts)), this.mt(up.written)]);
      // A new file, written in place: its marker comes right after it (Upload::create).
      if (up.written === inner && !statPath(this.image, inner + OPEN)) mtools('mcopy', ['-o', '-i', this.image, this.hostFile(Buffer.alloc(0)), this.mt(inner + OPEN)]);
    } catch (e) {
      this.uploads.delete(inner);
      if (statPath(this.image, up.written)) mtools('mdel', ['-i', this.image, this.mt(up.written)]);
      if (up.written === inner) this.dropMarker(inner);
      throw e;
    }
    return null;
  }
}

function geometryType(card: SimCard): string {
  return geometry(card.image).type;
}

/**
 * The computer with its card reader(s): the volume commands of volumes.rs
 * and the file commands of fsops.rs for the cards in it, behind a FakeIpc.
 */
export class SimReader {
  readonly ipc = new FakeIpc();
  readonly bridge = new Bridge(this.ipc, 'linux');
  readonly volumes = new TauriVolumes(this.bridge);
  private cards: SimCard[] = [];

  constructor() {
    const list = () => this.cards.filter((c) => !c.pulled).map((c) => c.dto());
    this.ipc.on('volumes_list', list);
    this.ipc.on('volumes_refresh', list);
    this.ipc.on('volume_info', (args) => {
      const { card } = this.at(String((args as { path: string }).path));
      const { id: _id, label: _label, ...info } = card.dto();
      return info;
    });
    this.ipc.on('volume_eject', (args) => {
      const { card } = this.at(String((args as { mountPath: string }).mountPath));
      this.remove(card);
      return null;
    });
    this.ipc.on('volume_fix_access', (args) => {
      const { card } = this.at(String((args as { mountPath: string }).mountPath));
      card.foreignOwner = false;
      this.changed();
      return card.dto();
    });
    for (const cmd of ['fs_list', 'fs_stat', 'fs_exists', 'fs_read', 'fs_read_range', 'fs_mkdir', 'fs_remove', 'fs_make_writable', 'fs_write_finish', 'fs_write_abort']) {
      this.ipc.on(cmd, (args) => this.fs(cmd, args as Record<string, unknown>));
    }
    this.ipc.on('fs_rename', (args) => {
      const a = args as { from: string; to: string };
      const from = this.at(a.from);
      const to = this.at(a.to);
      if (from.card !== to.card) throw new CmdErr('cross-device', 'Invalid cross-device link (os error 18)');
      return from.card.command('fs_rename', from.inner, { toInner: to.inner });
    });
    for (const cmd of ['fs_write', 'fs_write_chunk']) {
      this.ipc.on(cmd, (body, headers) => {
        const { card, inner } = this.at(decodeURIComponent(headers['x-path']));
        return card.command(cmd, inner, {}, body as Uint8Array, headers);
      });
    }
  }

  private fs(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const path = String(args.path ?? args.root);
    const { card, inner } = this.at(path);
    return card.command(cmd, inner, args);
  }

  private at(path: string): { card: SimCard; inner: string } {
    const card = this.cards.find((c) => path === c.spec.mountPath || path.startsWith(c.spec.mountPath + '/'));
    if (!card) throw new CmdErr('not-found', `${path}: No such file or directory (os error 2)`);
    if (card.pulled) throw new CmdErr('not-found', `${path}: No such file or directory (os error 2)`);
    return { card, inner: path.slice(card.spec.mountPath.length) };
  }

  /** Plugs a card in: the backend's watcher reports the new list. */
  insert(card: SimCard): void {
    card.pulled = false;
    if (!this.cards.includes(card)) this.cards.push(card);
    this.changed();
  }

  /** Takes a card out (without ejecting). */
  remove(card: SimCard): void {
    card.pulled = true;
    this.cards = this.cards.filter((c) => c !== card);
    this.changed();
  }

  /** What volumes.rs emits when the set of cards changed. */
  changed(): void {
    this.ipc.emit('volumes-changed', this.cards.filter((c) => !c.pulled).map((c) => c.dto()));
  }
}
