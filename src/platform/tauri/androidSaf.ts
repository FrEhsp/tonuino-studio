/**
 * The SD card in the Android app: a folder the user granted once through
 * Android's own folder chooser (Storage Access Framework), usually the card
 * in a USB card reader at the phone (USB-OTG). Kotlin does the file work
 * (src-tauri/android/TonuinoFiles.kt); this side turns it into the app's Dir.
 *
 * Android names files and folders by document ids, not by paths. A SafDir
 * keeps the id of its folder and finds a child by its name in the folder's
 * list. The lists are kept for a short while and shared by every SafDir of
 * the same folder, so writing a whole album asks for the list once, not for
 * every title. Android's own card provider builds the ids from the path
 * ("1234-ABCD:05/001.mp3"), so after renaming or moving a folder the ids
 * below it change: then every list of that card is read again.
 *
 * FAT does not tell "A" from "a". Asking Android to create or rename to a
 * name that is taken gives "001 (1).mp3" instead of an error, so every new
 * name is checked first and the answer compared with what was asked for.
 */
import type { ByteSource, Dir, DirEntry, WriteOptions } from '../types';
import { AndroidBridgeError, type AndroidCalls, fromBase64, NO_TIMEOUT, toBase64 } from './androidBridge';

/** What MainActivity adds to the page as window.TonuinoFiles (src-tauri/android/TonuinoFiles.kt). */
export interface FilesBridge {
  /** Folders granted for good (persisted permissions): JSON [{uri, doc, name}]. */
  trees(): string;
  /** Gives a granted folder back (forget). */
  release(uri: string): void;
  /** Android's folder chooser; done: {uri, doc, name} or code 'cancelled'. `persist`: keep the grant after a restart. */
  pickTree(id: string, persist: boolean): void;
  /** done: {entry}. */
  stat(id: string, tree: string, doc: string): void;
  /** done: payload = JSON [entry]. */
  list(id: string, tree: string, doc: string): void;
  /** done: payload = base64 of at most `length` bytes from `start`. */
  read(id: string, tree: string, doc: string, start: number, length: number): void;
  /** done: {entry} of the new file or folder; its name may differ when the name was taken. */
  create(id: string, tree: string, parent: string, name: string, dir: boolean): void;
  /** Deletes a file, or a folder with everything in it. done: {}. */
  remove(id: string, tree: string, doc: string): void;
  /** done: {entry} with the new id and name. */
  rename(id: string, tree: string, doc: string, name: string): void;
  /** done: {entry} with the new id; code 'unsupported' where Android cannot move. */
  move(id: string, tree: string, doc: string, fromParent: string, toParent: string): void;
  /** Opens a file for writing, emptied. done: {token}. */
  openWrite(id: string, tree: string, doc: string): void;
  /** A file of the app's own, for saveAs and print. done: {token}. */
  openTemp(id: string): void;
  writeChunk(id: string, token: string, base64: string): void;
  /** Writes everything out to the card (fsync) and closes. done: {}. */
  closeWrite(id: string, token: string): void;
  /** Closes without finishing; never answers. */
  abortWrite(token: string): void;
  /** Free and total bytes of the drive the folder is on, where Android tells. done: {free?, total?}. */
  space(id: string, tree: string): void;
  /** Android's "save as" with a finished temp file. done: {} or code 'cancelled'. */
  saveAs(id: string, token: string, name: string, mime: string): void;
  /** Android's print dialog for a finished temp file holding a PDF. done: {} once the dialog is up. */
  print(id: string, token: string, name: string): void;
  /** The payload of a finished call (see AndroidCalls). */
  take(id: string): string;
  /** The phone or tablet has a microphone. */
  hasMicrophone(): boolean;
  /** The app's page in the system settings (permissions). */
  openAppSettings(): void;
}

/** One file or folder as Kotlin describes it (DocumentsContract.Document columns). */
export interface SafEntry {
  /** Document id. */
  id: string;
  name: string;
  /** MIME type; folders have DIR_MIME. */
  mime: string;
  size?: number;
  /** Last change, ms since 1970. */
  modified?: number;
  /** DocumentsContract.Document.COLUMN_FLAGS. */
  flags?: number;
}

/** A folder the user granted. */
export interface SafTree {
  /** The tree URI (content://…/tree/…). */
  uri: string;
  /** Document id of the folder itself. */
  doc: string;
  name: string;
}

export const DIR_MIME = 'vnd.android.document/directory';
/** Document.FLAG_DIR_SUPPORTS_CREATE: new files may be made in this folder. */
export const FLAG_DIR_SUPPORTS_CREATE = 0x8;

/** Marker of a file being written in place; core/tonuino/sd.ts OPEN_SUFFIX, src-tauri/src/fsops.rs. */
export const OPEN_SUFFIX = '.tonuino-open';

/** Bytes per write call (raw; base64 makes a third more). */
export const WRITE_CHUNK = 512 * 1024;
/** Bytes per read call. */
export const READ_CHUNK = 4 * 1024 * 1024;
/** How long a folder list is trusted before it is read again. */
export const LIST_TTL_MS = 10_000;
/** Most file calls are quick; a long folder delete on a slow card is not. */
const OP_TIMEOUT_MS = 120_000;

export const isDirEntry = (e: SafEntry): boolean => e.mime === DIR_MIME;

/** The messages of the card, in the words of the browser and desktop versions (web/fsa.ts). */
export function explainSafError(e: unknown, what: string): Error {
  if (e instanceof AndroidBridgeError) {
    const say = (text: string) => Object.assign(new Error(`${what}: ${text}`), { code: e.code, detail: e.detail });
    switch (e.code) {
      case 'not-found':
        return say('nicht gefunden. Steckt die SD-Karte noch?');
      case 'denied':
        return say('Das Handy erlaubt den Zugriff nicht mehr. Wähle die SD-Karte unter „Meine Box“ noch einmal aus.');
      case 'full':
        return say('Die SD-Karte ist voll.');
      case 'read-only':
        return say('Die SD-Karte ist schreibgeschützt. Steht der kleine Schalter an der Karte auf „Lock“?');
      case 'exists':
        return say('Das gibt es dort schon.');
      case 'timeout':
        return say('Das Handy hat nicht geantwortet. Steckt der SD-Kartenleser noch?');
      case 'io':
        return say('Die SD-Karte hat beim Lesen oder Schreiben gestreikt. Stecke den SD-Kartenleser noch einmal ein und versuche es wieder.');
      case 'unsupported':
        return say('Das kann der Speicher auf diesem Handy nicht.');
      case 'cancelled':
        return new DOMException('cancelled', 'AbortError');
    }
    return say(e.detail || e.message);
  }
  return e instanceof Error ? e : new Error(String(e));
}

function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

function parseEntry(raw: unknown): SafEntry {
  const r = raw as Partial<SafEntry> | null;
  if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') throw new AndroidBridgeError('other', 'Das Handy hat eine unverständliche Antwort geschickt.', JSON.stringify(raw));
  const e: SafEntry = { id: r.id, name: r.name, mime: typeof r.mime === 'string' ? r.mime : 'application/octet-stream' };
  if (typeof r.size === 'number' && r.size >= 0) e.size = r.size;
  if (typeof r.modified === 'number' && r.modified > 0) e.modified = r.modified;
  if (typeof r.flags === 'number') e.flags = r.flags;
  return e;
}

/** The typed calls of window.TonuinoFiles. */
export class SafFs {
  constructor(
    readonly bridge: FilesBridge,
    private readonly calls: AndroidCalls,
  ) {}

  private call<T extends Record<string, unknown>>(send: (id: string) => void, timeout = OP_TIMEOUT_MS): Promise<T> {
    return this.calls.call<T>(send, timeout, (id) => this.bridge.take(id));
  }

  trees(): SafTree[] {
    let raw: unknown;
    try {
      raw = JSON.parse(this.bridge.trees());
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is SafTree => !!t && typeof t.uri === 'string' && typeof t.doc === 'string').map((t) => ({ uri: t.uri, doc: t.doc, name: typeof t.name === 'string' && t.name ? t.name : 'SD-Karte' }));
  }

  release(uri: string): void {
    this.bridge.release(uri);
  }

  /** Null when the user closed the chooser. */
  async pickTree(persist: boolean): Promise<SafTree | null> {
    try {
      const r = await this.call<{ uri: string; doc: string; name?: string }>((id) => this.bridge.pickTree(id, persist), NO_TIMEOUT);
      return { uri: r.uri, doc: r.doc, name: r.name || 'SD-Karte' };
    } catch (e) {
      if (codeOf(e) === 'cancelled') return null;
      throw e;
    }
  }

  async stat(tree: string, doc: string): Promise<SafEntry> {
    const r = await this.call<{ entry: unknown }>((id) => this.bridge.stat(id, tree, doc));
    return parseEntry(r.entry);
  }

  async list(tree: string, doc: string): Promise<SafEntry[]> {
    const r = await this.call<{ payload: string }>((id) => this.bridge.list(id, tree, doc));
    const raw = JSON.parse(r.payload) as unknown;
    if (!Array.isArray(raw)) throw new AndroidBridgeError('other', 'Das Handy hat eine unverständliche Antwort geschickt.', 'list is no array');
    return raw.map(parseEntry);
  }

  async read(tree: string, doc: string, start: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const r = await this.call<{ payload: string }>((id) => this.bridge.read(id, tree, doc, start, length));
    return fromBase64(r.payload);
  }

  async create(tree: string, parent: string, name: string, dir: boolean): Promise<SafEntry> {
    const r = await this.call<{ entry: unknown }>((id) => this.bridge.create(id, tree, parent, name, dir));
    return parseEntry(r.entry);
  }

  async remove(tree: string, doc: string): Promise<void> {
    await this.call((id) => this.bridge.remove(id, tree, doc));
  }

  async rename(tree: string, doc: string, name: string): Promise<SafEntry> {
    const r = await this.call<{ entry: unknown }>((id) => this.bridge.rename(id, tree, doc, name));
    return parseEntry(r.entry);
  }

  async move(tree: string, doc: string, fromParent: string, toParent: string): Promise<SafEntry> {
    const r = await this.call<{ entry: unknown }>((id) => this.bridge.move(id, tree, doc, fromParent, toParent));
    return parseEntry(r.entry);
  }

  async openWrite(tree: string, doc: string): Promise<string> {
    return (await this.call<{ token: string }>((id) => this.bridge.openWrite(id, tree, doc))).token;
  }

  async openTemp(): Promise<string> {
    return (await this.call<{ token: string }>((id) => this.bridge.openTemp(id))).token;
  }

  async writeChunk(token: string, bytes: Uint8Array): Promise<void> {
    const b64 = toBase64(bytes);
    await this.call((id) => this.bridge.writeChunk(id, token, b64));
  }

  async closeWrite(token: string): Promise<void> {
    await this.call((id) => this.bridge.closeWrite(id, token));
  }

  abortWrite(token: string): void {
    try {
      this.bridge.abortWrite(token);
    } catch {
      // The file stays open until the app ends; nothing else to do.
    }
  }

  async space(tree: string): Promise<{ free?: number; total?: number }> {
    const r = await this.call<{ free?: unknown; total?: unknown }>((id) => this.bridge.space(id, tree));
    const out: { free?: number; total?: number } = {};
    if (typeof r.free === 'number' && r.free >= 0) out.free = r.free;
    if (typeof r.total === 'number' && r.total > 0) out.total = r.total;
    return out;
  }

  /** Writes `data` (bytes or a Blob) through an open token, in chunks, with progress and abort. */
  async writeAll(token: string, data: Uint8Array | Blob, opts: WriteOptions = {}): Promise<void> {
    const size = data instanceof Blob ? data.size : data.byteLength;
    for (let pos = 0; pos < size; pos += WRITE_CHUNK) {
      opts.signal?.throwIfAborted();
      const end = Math.min(size, pos + WRITE_CHUNK);
      const chunk = data instanceof Blob ? new Uint8Array(await data.slice(pos, end).arrayBuffer()) : data.subarray(pos, end);
      await this.writeChunk(token, chunk);
      opts.onProgress?.(end);
    }
    opts.signal?.throwIfAborted();
  }

  /** Hands a finished file to Android's "save as". False when the user cancelled. */
  async saveAs(name: string, data: Blob): Promise<boolean> {
    const token = await this.openTemp();
    try {
      await this.writeAll(token, data);
      await this.closeWrite(token);
    } catch (e) {
      this.abortWrite(token);
      throw e;
    }
    try {
      await this.call((id) => this.bridge.saveAs(id, token, name, data.type || mimeOfName(name)), NO_TIMEOUT);
      return true;
    } catch (e) {
      if (codeOf(e) === 'cancelled') return false;
      throw e;
    }
  }

  /** Opens Android's print dialog for a PDF. */
  async print(name: string, pdf: Blob): Promise<void> {
    const token = await this.openTemp();
    try {
      await this.writeAll(token, pdf);
      await this.closeWrite(token);
    } catch (e) {
      this.abortWrite(token);
      throw e;
    }
    await this.call((id) => this.bridge.print(id, token, name), NO_TIMEOUT);
  }
}

/** The MIME type Android's "save as" suggests a place by. */
export function mimeOfName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    hex: 'application/octet-stream',
    bin: 'application/octet-stream',
  };
  return known[ext] ?? 'application/octet-stream';
}

/* ------------------------------------------------------------- the lists */

interface CachedList {
  at: number;
  entries: SafEntry[];
}

/**
 * The folder lists of one card, shared by all its SafDirs. Kept by document
 * id; dropped as a whole when a folder is renamed, moved or removed, because
 * then ids below it change.
 */
export class ListCache {
  private readonly lists = new Map<string, CachedList>();

  constructor(private readonly now: () => number = Date.now) {}

  get(doc: string): SafEntry[] | undefined {
    const c = this.lists.get(doc);
    if (!c) return undefined;
    if (this.now() - c.at > LIST_TTL_MS) {
      this.lists.delete(doc);
      return undefined;
    }
    return c.entries;
  }

  set(doc: string, entries: SafEntry[]): void {
    this.lists.set(doc, { at: this.now(), entries });
  }

  /** A change made by the app itself: the list stays as fresh as it was. */
  update(doc: string, change: (entries: SafEntry[]) => SafEntry[]): void {
    const c = this.lists.get(doc);
    if (c) c.entries = change(c.entries);
  }

  forget(doc: string): void {
    this.lists.delete(doc);
  }

  clear(): void {
    this.lists.clear();
  }
}

/** The entry called `name`: the exact spelling first, else one that differs only in case (FAT). */
export function findEntry(entries: readonly SafEntry[], name: string): SafEntry | undefined {
  const exact = entries.find((e) => e.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return entries.find((e) => e.name.toLowerCase() === lower);
}

/** One card (a granted tree) as the SafDirs share it. */
export interface SafCard {
  readonly fs: SafFs;
  readonly tree: string;
  readonly cache: ListCache;
}

export function newSafCard(fs: SafFs, tree: string): SafCard {
  return { fs, tree, cache: new ListCache() };
}

/** A file on the card as random-access bytes. */
export function safSource(card: SafCard, entry: SafEntry, relativePath?: string): ByteSource {
  return {
    name: entry.name,
    size: entry.size ?? 0,
    ...(relativePath ? { relativePath } : {}),
    read: async (start, length) => {
      const size = entry.size ?? Number.MAX_SAFE_INTEGER;
      const want = Math.max(0, Math.min(length, size - start));
      const out = new Uint8Array(want);
      let got = 0;
      while (got < want) {
        const part = await card.fs.read(card.tree, entry.id, start + got, Math.min(READ_CHUNK, want - got));
        if (!part.length) break;
        out.set(part.subarray(0, want - got), got);
        got += part.length;
      }
      return got === want ? out : out.slice(0, got);
    },
  };
}

/** A folder on the card. */
export class SafDir implements Dir {
  constructor(
    readonly card: SafCard,
    /** Document id of this folder. */
    readonly doc: string,
    readonly name: string,
    /** Path below the granted folder for messages, e.g. "05"; "" for the granted folder itself. */
    private readonly at = '',
  ) {}

  private get fs(): SafFs {
    return this.card.fs;
  }

  private get tree(): string {
    return this.card.tree;
  }

  private sub(name: string): string {
    return this.at ? `${this.at}/${name}` : name;
  }

  /** The list of this folder, from the cache while it is fresh. */
  private async entries(fresh = false): Promise<SafEntry[]> {
    if (!fresh) {
      const cached = this.card.cache.get(this.doc);
      if (cached) return cached;
    }
    let list: SafEntry[];
    try {
      list = await this.fs.list(this.tree, this.doc);
    } catch (e) {
      throw explainSafError(e, `Ordner ${this.name || 'SD-Karte'} lesen`);
    }
    this.card.cache.set(this.doc, list);
    return list;
  }

  private async lookup(name: string, fresh = false): Promise<SafEntry | undefined> {
    return findEntry(await this.entries(fresh), name);
  }

  /** Runs `op` with the entry called `name`; after a "not found" once more with a fresh list (the cache was old). */
  private async withEntry<T>(name: string, what: string, op: (e: SafEntry) => Promise<T>): Promise<T> {
    let entry = await this.lookup(name);
    if (!entry) entry = await this.lookup(name, true);
    if (!entry) throw explainSafError(new AndroidBridgeError('not-found', 'not found'), what);
    try {
      return await op(entry);
    } catch (e) {
      if (codeOf(e) !== 'not-found') throw explainSafError(e, what);
    }
    const again = await this.lookup(name, true);
    if (!again) throw explainSafError(new AndroidBridgeError('not-found', 'not found'), what);
    try {
      return await op(again);
    } catch (e) {
      throw explainSafError(e, what);
    }
  }

  async list(): Promise<DirEntry[]> {
    const list = await this.entries(true);
    return list.map((e) =>
      isDirEntry(e)
        ? { name: e.name, kind: 'directory' as const, ...(e.modified ? { modified: e.modified } : {}) }
        : { name: e.name, kind: 'file' as const, ...(e.size !== undefined ? { size: e.size } : {}), ...(e.modified ? { modified: e.modified } : {}) },
    );
  }

  async dir(name: string, opts: { create?: boolean } = {}): Promise<Dir> {
    // A new folder is made at once: createEntry notices one that came meanwhile.
    let entry = (await this.lookup(name)) ?? (opts.create ? undefined : await this.lookup(name, true));
    if (entry && !isDirEntry(entry)) throw new Error(`Ordner ${this.sub(name)}: Hier liegt eine Datei mit diesem Namen.`);
    if (!entry) {
      if (!opts.create) throw explainSafError(new AndroidBridgeError('not-found', 'not found'), `Ordner ${this.sub(name)}`);
      entry = await this.createEntry(name, true, `Ordner ${this.sub(name)} anlegen`);
    }
    return new SafDir(this.card, entry.id, entry.name, this.sub(entry.name));
  }

  async exists(name: string): Promise<boolean> {
    return !!(await this.lookup(name));
  }

  async read(name: string): Promise<Uint8Array> {
    const src = await this.source(name);
    return src.read(0, src.size);
  }

  async readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    return this.withEntry(name, this.sub(name), async (e) => {
      if (isDirEntry(e)) throw new Error(`${this.sub(name)} ist ein Ordner.`);
      return safSource(this.card, e).read(start, length);
    });
  }

  async source(name: string): Promise<ByteSource> {
    // A fresh size: the file may have just been written through another SafDir of this folder.
    const entry = await this.lookup(name, true);
    if (!entry) throw explainSafError(new AndroidBridgeError('not-found', 'not found'), this.sub(name));
    if (isDirEntry(entry)) throw new Error(`${this.sub(name)} ist ein Ordner.`);
    return safSource(this.card, entry);
  }

  /**
   * Makes a new file or folder. Android gives a taken name a number
   * ("001 (1).mp3") instead of failing; such a twin is removed again and
   * the list read anew, so the caller sees the entry that was there.
   */
  private async createEntry(name: string, dir: boolean, what: string): Promise<SafEntry> {
    let made: SafEntry;
    try {
      made = await this.fs.create(this.tree, this.doc, name, dir);
    } catch (e) {
      throw explainSafError(e, what);
    }
    if (made.name !== name) {
      await this.fs.remove(this.tree, made.id).catch(() => undefined);
      const there = await this.lookup(name, true);
      if (there && isDirEntry(there) === dir) return there;
      throw explainSafError(new AndroidBridgeError('exists', `asked for ${name}, got ${made.name}`), what);
    }
    this.card.cache.update(this.doc, (list) => [...list.filter((e) => e.id !== made.id), made]);
    return made;
  }

  async write(name: string, data: Uint8Array | Blob, opts: WriteOptions = {}): Promise<void> {
    const what = `${this.sub(name)} schreiben`;
    // Not in the list: made anew, and createEntry notices one that came meanwhile.
    let entry = await this.lookup(name);
    if (entry && isDirEntry(entry)) throw new Error(`${what}: Hier liegt ein Ordner mit diesem Namen.`);
    const created = !entry;
    if (!entry) entry = await this.createEntry(name, false, what);
    const marker = await this.markOpen(name, what);
    let token: string;
    try {
      token = await this.fs.openWrite(this.tree, entry.id);
    } catch (e) {
      if (codeOf(e) !== 'not-found' || created) throw explainSafError(e, what);
      // The list was old: the file is gone meanwhile. Make it anew.
      this.card.cache.forget(this.doc);
      return this.write(name, data, opts);
    }
    try {
      await this.fs.writeAll(token, data, opts);
      await this.fs.closeWrite(token);
    } catch (e) {
      this.fs.abortWrite(token);
      // A file that was not there before must not stay behind empty or half written.
      if (created) {
        await this.dropEntry(entry).catch(() => undefined);
        if (marker) await this.dropEntry(marker).catch(() => undefined);
      }
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw explainSafError(e, what);
    }
    if (marker) await this.dropEntry(marker).catch(() => undefined);
    const size = data instanceof Blob ? data.size : data.byteLength;
    const done: SafEntry = { ...entry, size, modified: Date.now() };
    this.card.cache.update(this.doc, (list) => list.map((e) => (e.id === done.id ? done : e)));
  }

  /**
   * Android writes a file in place ("wt" cuts an old one short at once), so
   * an audio file gets an empty marker next to it, made after it so it comes
   * later in the FAT order, until it is complete. A card pulled meanwhile
   * leaves the marker: the scan then calls the file half copied
   * (core/tonuino/sd.ts OPEN_SUFFIX, same as fsops.rs on the desktop).
   * Best effort: without a marker the write still goes ahead.
   */
  private async markOpen(name: string, what: string): Promise<SafEntry | null> {
    if (!/\.(mp3|wav)$/i.test(name)) return null;
    const marker = `${name}${OPEN_SUFFIX}`;
    try {
      return (await this.lookup(marker)) ?? (await this.createEntry(marker, false, what));
    } catch {
      return null;
    }
  }

  private async dropEntry(entry: SafEntry): Promise<void> {
    await this.fs.remove(this.tree, entry.id);
    if (isDirEntry(entry)) this.card.cache.clear();
    else this.card.cache.update(this.doc, (list) => list.filter((e) => e.id !== entry.id));
  }

  async remove(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await this.withEntry(name, `${this.sub(name)} löschen`, async (entry) => {
      if (isDirEntry(entry) && !opts.recursive) {
        const inside = await this.fs.list(this.tree, entry.id);
        if (inside.length) throw new Error(`${this.sub(name)} löschen: Der Ordner ist nicht leer.`);
      }
      await this.dropEntry(entry);
    });
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const what = `${this.sub(from)} umbenennen`;
    if (from.toLowerCase() === to.toLowerCase()) {
      // Only the case changes. On FAT both spellings are one entry; a detour gives it the new one.
      const taken = (await this.entries(true)).some((e) => e.name === to);
      if (taken) throw new Error(`${to} gibt es schon.`);
      const detour = `${to}.tmp-${Date.now()}`;
      await this.rename(from, detour);
      await this.rename(detour, to);
      return;
    }
    if (await this.lookup(to, true)) throw new Error(`${to} gibt es schon.`);
    await this.withEntry(from, what, async (entry) => {
      const renamed = await this.fs.rename(this.tree, entry.id, to);
      if (renamed.name !== to) {
        // Android found the name taken after all and chose another: put it back.
        await this.fs.rename(this.tree, renamed.id, entry.name).catch(() => undefined);
        this.card.cache.clear();
        throw new AndroidBridgeError('exists', `asked for ${to}, got ${renamed.name}`);
      }
      if (isDirEntry(entry)) this.card.cache.clear();
      else this.card.cache.update(this.doc, (list) => list.map((e) => (e.id === entry.id ? { ...entry, ...renamed } : e)));
    });
  }

  async move(name: string, target: Dir, newName?: string): Promise<void> {
    if (!(target instanceof SafDir) || target.card.tree !== this.card.tree) throw new Error('Verschieben ist nur innerhalb der SD-Karte möglich.');
    const to = newName ?? name;
    if (target.doc === this.doc) return this.rename(name, to);
    const what = `${this.sub(name)} verschieben`;
    if (await target.lookup(to, true)) throw new Error(`${to} gibt es dort schon.`);
    const entry = await this.lookup(name, true);
    if (!entry) throw explainSafError(new AndroidBridgeError('not-found', 'not found'), what);
    // Android moves under the old name: give it the new one first, here, where nothing else is called that.
    let moving = entry.name;
    if (to !== entry.name) {
      moving = (await this.lookup(to, true)) ? `${to}.tmp-${Date.now()}` : to;
      await this.rename(entry.name, moving);
    }
    const current = await this.lookup(moving, true);
    if (!current) throw explainSafError(new AndroidBridgeError('not-found', 'not found'), what);
    try {
      await this.fs.move(this.tree, current.id, this.doc, target.doc);
    } catch (e) {
      if (codeOf(e) !== 'unsupported') {
        if (moving !== entry.name) await this.rename(moving, entry.name).catch(() => undefined);
        throw explainSafError(e, what);
      }
      await this.copyOver(current, target, moving, what);
    }
    this.card.cache.clear();
    if (moving !== to) await target.rename(moving, to);
  }

  /** Where Android cannot move: copy, and only then remove the original. */
  private async copyOver(entry: SafEntry, target: SafDir, name: string, what: string): Promise<void> {
    try {
      if (isDirEntry(entry)) {
        const from = new SafDir(this.card, entry.id, entry.name, this.sub(entry.name));
        const dest = (await target.dir(name, { create: true })) as SafDir;
        for (const child of await from.entries(true)) await from.copyOver(child, dest, child.name, what);
      } else {
        await target.write(name, await safSource(this.card, entry).read(0, entry.size ?? 0));
      }
    } catch (e) {
      throw explainSafError(e, what);
    }
    await this.dropEntry(entry);
  }
}

/** Every file below a folder (a picked folder of audio), with paths below the folder's name. Hidden files are left out. */
export async function collectSafFiles(card: SafCard, doc: string, prefix: string): Promise<ByteSource[]> {
  const out: ByteSource[] = [];
  for (const e of await card.fs.list(card.tree, doc)) {
    if (e.name.startsWith('.')) continue;
    if (isDirEntry(e)) out.push(...(await collectSafFiles(card, e.id, `${prefix}/${e.name}`)));
    else out.push(safSource(card, e, `${prefix}/${e.name}`));
  }
  return out;
}

/** "content://AUTHORITY/tree/…" → AUTHORITY. */
export function authorityOf(uri: string): string | undefined {
  return /^content:\/\/([^/]+)\//.exec(uri)?.[1];
}

/** Android's own card provider (com.android.externalstorage.documents) names documents "ROOT:path". */
export const EXTERNAL_STORAGE = 'com.android.externalstorage.documents';

/** Splits "1234-ABCD:Musik/05" into root and path, for the card provider's ids. */
export function splitStorageId(doc: string): { root: string; path: string } | undefined {
  const at = doc.indexOf(':');
  if (at <= 0) return undefined;
  return { root: doc.slice(0, at), path: doc.slice(at + 1).replace(/\/+$/, '') };
}

/**
 * Whether `inner` is `outer` or lies inside it. Only Android's own card
 * provider has ids that tell; other providers: null (unknown).
 */
export function safWithin(inner: { tree: string; doc: string }, outer: { tree: string; doc: string }): boolean | null {
  const a = authorityOf(inner.tree);
  const b = authorityOf(outer.tree);
  if (!a || !b) return null;
  if (a !== b) return false;
  if (inner.doc === outer.doc) return true;
  if (a !== EXTERNAL_STORAGE) return null;
  const i = splitStorageId(inner.doc);
  const o = splitStorageId(outer.doc);
  if (!i || !o) return null;
  if (i.root !== o.root) return false;
  return o.path === '' || i.path === o.path || i.path.startsWith(`${o.path}/`);
}

/** A card in a reader (not the phone's own storage, which Android calls "primary"). */
export function isRemovableStorage(tree: SafTree): boolean | undefined {
  if (authorityOf(tree.uri) !== EXTERNAL_STORAGE) return undefined;
  const id = splitStorageId(tree.doc);
  if (!id) return undefined;
  return id.root !== 'primary' && id.root !== 'home';
}
