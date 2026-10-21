/**
 * The Kotlin side of the Android app, faked for tests: window.TonuinoFiles
 * (a card provider like Android's own, with ids built from paths and FAT's
 * names that ignore case) and the shared callback host.
 */
import type { AndroidCallbacks, BridgeResult } from '../../src/platform/tauri/androidBridge';
import { fromBase64, toBase64 } from '../../src/platform/tauri/androidBridge';
import { DIR_MIME, type FilesBridge, type SafEntry } from '../../src/platform/tauri/androidSaf';

export type Host = { __tonuinoAndroid?: AndroidCallbacks };

interface Node {
  name: string;
  kind: 'file' | 'dir';
  data: Uint8Array;
  modified: number;
  children: Node[];
}

export type FakeTree = { [name: string]: string | FakeTree };

const enc = new TextEncoder();

function build(tree: FakeTree): Node[] {
  return Object.entries(tree).map(([name, v]) =>
    typeof v === 'string' ? { name, kind: 'file', data: enc.encode(v), modified: 1_700_000_000_000, children: [] } : { name, kind: 'dir', data: new Uint8Array(0), modified: 1_700_000_000_000, children: build(v) },
  );
}

/** Android's card provider: "ROOT:path" ids, unique names " (1)" instead of errors, recursive delete. */
export class FakeFiles implements FilesBridge {
  readonly root: Node;
  /** Every call by name, for asserting how often the card was asked. */
  readonly calls: string[] = [];
  /** Granted trees (persisted). */
  persisted: { uri: string; doc: string; name: string }[] = [];
  /** The card is plugged in. */
  present = true;
  /** pickTree answers with this (null: cancelled). */
  nextPick: { uri: string; doc: string; name: string } | null = null;
  /** move answers 'unsupported' (an older Android or another provider). */
  noMove = false;
  /** The next call of this name fails with this code. */
  failNext: Record<string, string> = {};
  /** Root flags (FLAG_DIR_SUPPORTS_CREATE = 8). */
  rootFlags = 0x8 | 0x4;
  readonly payloads = new Map<string, string>();
  readonly writes = new Map<string, { node: Node; parts: Uint8Array[] }>();
  readonly temps = new Map<string, Uint8Array>();
  saved: { name: string; mime: string; data: Uint8Array }[] = [];
  printed: { name: string; data: Uint8Array }[] = [];
  released: string[] = [];
  appSettings = 0;
  private tokens = 0;

  constructor(
    readonly host: Host,
    tree: FakeTree,
    readonly rootId = '1234-ABCD',
    readonly treeUri = 'content://com.android.externalstorage.documents/tree/1234-ABCD%3A',
  ) {
    this.root = { name: 'TONUINO', kind: 'dir', data: new Uint8Array(0), modified: 0, children: build(tree) };
  }

  /* ---------------------------------------------------------------- paths */

  private idOf(path: string[]): string {
    return `${this.rootId}:${path.join('/')}`;
  }

  private resolve(doc: string): { node: Node; path: string[]; parent?: Node } | null {
    if (!this.present) return null;
    if (!doc.startsWith(`${this.rootId}:`)) return null;
    const rest = doc.slice(this.rootId.length + 1);
    const path = rest ? rest.split('/') : [];
    let node = this.root;
    let parent: Node | undefined;
    for (const part of path) {
      const next = node.children.find((c) => c.name === part);
      if (!next) return null;
      parent = node;
      node = next;
    }
    return { node, path, parent };
  }

  private entry(node: Node, path: string[]): SafEntry {
    return node.kind === 'dir'
      ? { id: this.idOf(path), name: node.name, mime: DIR_MIME, modified: node.modified, flags: path.length ? 0x8 | 0x4 | 0x40 : this.rootFlags }
      : { id: this.idOf(path), name: node.name, mime: 'application/octet-stream', size: node.data.length, modified: node.modified, flags: 0x2 | 0x4 | 0x40 };
  }

  /** A name FAT does not have yet, the way Android's FileUtils.buildUniqueFile makes it. */
  private unique(parent: Node, name: string): string {
    const taken = (n: string) => parent.children.some((c) => c.name.toLowerCase() === n.toLowerCase());
    if (!taken(name)) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) if (!taken(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  }

  /* ---------------------------------------------------------------- answers */

  private answer(id: string, result: BridgeResult) {
    setTimeout(() => this.host.__tonuinoAndroid!.done(id, result), 0);
  }

  private run(name: string, id: string, op: () => Record<string, unknown>) {
    this.calls.push(name);
    const fail = this.failNext[name];
    if (fail) {
      delete this.failNext[name];
      return this.answer(id, { ok: false, code: fail, message: `failed: ${fail}` });
    }
    let r: Record<string, unknown>;
    try {
      r = op();
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'other';
      return this.answer(id, { ok: false, code, message: (e as Error).message });
    }
    this.answer(id, { ok: true, ...r });
  }

  private notFound(): never {
    throw Object.assign(new Error('not found'), { code: 'not-found' });
  }

  /* ---------------------------------------------------------------- bridge */

  trees() {
    return JSON.stringify(this.persisted);
  }
  release(uri: string) {
    this.released.push(uri);
    this.persisted = this.persisted.filter((t) => t.uri !== uri);
  }
  pickTree(id: string, persist: boolean) {
    this.calls.push('pickTree');
    const pick = this.nextPick;
    if (!pick) return this.answer(id, { ok: false, code: 'cancelled' });
    if (persist && !this.persisted.some((t) => t.uri === pick.uri)) this.persisted.push(pick);
    this.answer(id, { ok: true, ...pick });
  }
  stat(id: string, _tree: string, doc: string) {
    this.run('stat', id, () => {
      const r = this.resolve(doc) ?? this.notFound();
      return { entry: this.entry(r.node, r.path) };
    });
  }
  list(id: string, _tree: string, doc: string) {
    this.run('list', id, () => {
      const r = this.resolve(doc) ?? this.notFound();
      this.payloads.set(id, JSON.stringify(r.node.children.map((c) => this.entry(c, [...r.path, c.name]))));
      return { payload: true };
    });
  }
  read(id: string, _tree: string, doc: string, start: number, length: number) {
    this.run('read', id, () => {
      const r = this.resolve(doc) ?? this.notFound();
      this.payloads.set(id, toBase64(r.node.data.subarray(start, start + length)));
      return { payload: true };
    });
  }
  create(id: string, _tree: string, parent: string, name: string, dir: boolean) {
    this.run('create', id, () => {
      const r = this.resolve(parent) ?? this.notFound();
      const node: Node = { name: this.unique(r.node, name), kind: dir ? 'dir' : 'file', data: new Uint8Array(0), modified: Date.now(), children: [] };
      r.node.children.push(node);
      return { entry: this.entry(node, [...r.path, node.name]) };
    });
  }
  remove(id: string, _tree: string, doc: string) {
    this.run('remove', id, () => {
      const r = this.resolve(doc) ?? this.notFound();
      r.parent!.children = r.parent!.children.filter((c) => c !== r.node);
      return {};
    });
  }
  rename(id: string, _tree: string, doc: string, name: string) {
    this.run('rename', id, () => {
      const r = this.resolve(doc) ?? this.notFound();
      const others = { ...r.parent!, children: r.parent!.children.filter((c) => c !== r.node) };
      r.node.name = this.unique(others, name);
      return { entry: this.entry(r.node, [...r.path.slice(0, -1), r.node.name]) };
    });
  }
  move(id: string, _tree: string, doc: string, fromParent: string, toParent: string) {
    this.run('move', id, () => {
      if (this.noMove) throw Object.assign(new Error('no move'), { code: 'unsupported' });
      const r = this.resolve(doc) ?? this.notFound();
      const from = this.resolve(fromParent) ?? this.notFound();
      const to = this.resolve(toParent) ?? this.notFound();
      if (to.node.children.some((c) => c.name.toLowerCase() === r.node.name.toLowerCase())) throw Object.assign(new Error('Already exists'), { code: 'exists' });
      from.node.children = from.node.children.filter((c) => c !== r.node);
      to.node.children.push(r.node);
      return { entry: this.entry(r.node, [...to.path, r.node.name]) };
    });
  }
  openWrite(id: string, _tree: string, doc: string) {
    this.run('openWrite', id, () => {
      const r = this.resolve(doc) ?? this.notFound();
      const token = `w${++this.tokens}`;
      this.writes.set(token, { node: r.node, parts: [] });
      return { token };
    });
  }
  openTemp(id: string) {
    this.run('openTemp', id, () => {
      const token = `t${++this.tokens}`;
      this.writes.set(token, { node: { name: token, kind: 'file', data: new Uint8Array(0), modified: 0, children: [] }, parts: [] });
      return { token };
    });
  }
  writeChunk(id: string, token: string, base64: string) {
    this.run('writeChunk', id, () => {
      const w = this.writes.get(token) ?? this.notFound();
      w.parts.push(fromBase64(base64));
      return {};
    });
  }
  closeWrite(id: string, token: string) {
    this.run('closeWrite', id, () => {
      const w = this.writes.get(token) ?? this.notFound();
      this.writes.delete(token);
      const size = w.parts.reduce((n, p) => n + p.length, 0);
      const data = new Uint8Array(size);
      let at = 0;
      for (const p of w.parts) {
        data.set(p, at);
        at += p.length;
      }
      w.node.data = data;
      w.node.modified = Date.now();
      if (token.startsWith('t')) this.temps.set(token, data);
      return {};
    });
  }
  abortWrite(token: string) {
    this.writes.delete(token);
  }
  space(id: string) {
    this.run('space', id, () => ({ free: 1000, total: 4000 }));
  }
  saveAs(id: string, token: string, name: string, mime: string) {
    this.run('saveAs', id, () => {
      this.saved.push({ name, mime, data: this.temps.get(token)! });
      return {};
    });
  }
  print(id: string, token: string, name: string) {
    this.run('print', id, () => {
      this.printed.push({ name, data: this.temps.get(token)! });
      return {};
    });
  }
  take(id: string) {
    const p = this.payloads.get(id);
    this.payloads.delete(id);
    if (p === undefined) throw new Error(`nothing to take for ${id}`);
    return p;
  }
  hasMicrophone() {
    return true;
  }
  openAppSettings() {
    this.appSettings++;
  }

  /** The names in a folder, by path. */
  names(path = ''): string[] {
    const r = this.resolve(this.idOf(path ? path.split('/') : []));
    return r ? r.node.children.map((c) => c.name) : [];
  }

  text(path: string): string {
    const r = this.resolve(this.idOf(path.split('/')));
    return r ? new TextDecoder().decode(r.node.data) : '';
  }

  /** The granted folder of the whole card. */
  get tree() {
    return { uri: this.treeUri, doc: `${this.rootId}:`, name: 'TONUINO' };
  }
}
