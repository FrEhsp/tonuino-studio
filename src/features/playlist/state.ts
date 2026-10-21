/**
 * "Nach einer Playlist zusammenstellen" on the add page: the steps from a
 * track list the user brings (a Spotify data export, CSV, M3U, text) and the
 * user's own audio files to files in the import, in the order of the list.
 * Only the list's names are read; the sound comes from the user's files. The
 * file picker, the tag reader and the import are passed in, so this runs in
 * tests without a platform or a card.
 */
import { computed, signal } from '@preact/signals';
import { mapLimit, throttle } from '../../core/async';
import { MAX_LIST_FILE_BYTES, parseTrackListFile, parseTrackListText } from '../../core/library/playlist/parse';
import { matchTrackListAsync } from '../../core/library/playlist/match';
import type { EntryMatch, LibraryFile, ListEntry, ParseResult, TrackList } from '../../core/library/playlist/types';
import { AUDIO_EXTENSIONS, extensionOf, isAudioFile, type TrackInfo } from '../../core/library/tags';
import { readZipDirectory } from '../../core/zip/zipreader';
import type { ByteSource, PickFilesOptions } from '../../platform/types';
import type { AddOptions, AddResult } from '../add/session';

/** What the file picker offers for the list. */
export const LIST_EXTENSIONS = ['zip', 'json', 'csv', 'tsv', 'm3u', 'm3u8', 'txt'];

/** Album artist of the folder: the files keep their own artists. */
export const VARIOUS_ARTISTS = 'Verschiedene Interpreten';

/** How many files have their tags read at once. */
const READ_PARALLEL = 4;

/** Most list files read from one drop (an unpacked Spotify export has a few dozen). */
const MAX_LIST_FILES = 100;

const NOT_READABLE = 'Mit dieser Datei kann ich nichts anfangen. Wähle die ZIP-Datei von Spotify oder eine CSV-, M3U- oder Textdatei.';

/** A track list by its name: not audio, one of the list types. */
export function isListFile(name: string): boolean {
  return !isAudioFile(name) && LIST_EXTENSIONS.includes(extensionOf(name));
}

/**
 * True when the ZIP looks like a Spotify data export: JSON files and no
 * audio. Only its table of contents is read, so a big album ZIP costs
 * nothing. One that cannot be read is no export either.
 */
export async function isSpotifyZip(source: ByteSource): Promise<boolean> {
  try {
    const { entries } = await readZipDirectory((start, length) => source.read(start, length), source.size);
    const files = entries.filter((e) => !e.isDir && !e.path.includes('__MACOSX/'));
    return !files.some((e) => isAudioFile(e.path)) && files.some((e) => extensionOf(e.path) === 'json');
  } catch {
    return false;
  }
}

/**
 * The message of a failed pick. The desktop app's errors carry a code and say
 * in words what to do (a folder with too many files); the browser's are
 * technical, so a general sentence stands for them.
 */
function pickFailed(e: unknown): string {
  const said = e instanceof Error && typeof (e as { code?: unknown }).code === 'string' ? e.message.trim() : '';
  return said || 'Auswählen hat nicht geklappt. Versuche es noch einmal.';
}

export interface PlaylistDeps {
  /** Lets the user choose files or a folder; [] when cancelled. */
  pickFiles(opts: PickFilesOptions): Promise<ByteSource[]>;
  /** Tags of one of the user's audio files (no cover needed). */
  readTrackInfo(source: ByteSource, opts: { cover: false; signal: AbortSignal }): Promise<TrackInfo>;
  /** Hands the files to the import, with album and order per file. */
  addSources(sources: ByteSource[], opts: AddOptions): Promise<AddResult>;
}

export type ListLoad = { status: 'idle' } | { status: 'loading' } | { status: 'failed'; message: string };

export interface Note {
  tone: 'info' | 'warning' | 'danger' | 'neutral';
  text: string;
}

/**
 * How an entry of the list stands, as the panel shows it:
 * gefunden (sure, or chosen by the user), pruefen (a guess), fehlt (no file),
 * weggelassen (the user chose "Nicht verwenden"), doppelt (the list repeats a song).
 */
export type RowStatus = 'gefunden' | 'pruefen' | 'fehlt' | 'weggelassen' | 'doppelt';

export interface Row {
  match: EntryMatch;
  status: RowStatus;
  /** The file that goes into the folder for this entry. */
  chosen?: LibraryFile;
  /** Files the user can choose from: the candidates, and the current choice. */
  options: LibraryFile[];
}

export interface Summary {
  /** Entries without the repeated ones. */
  total: number;
  found: number;
  check: number;
  missing: number;
  left: number;
  doubles: number;
  /** Files that go into the folder. */
  taken: number;
}

/** A file's key, to notice files that were chosen twice. */
function fileKey(s: ByteSource): string {
  return s.path ?? `${s.relativePath ?? s.name}|${s.size}`;
}

function isAbort(e: unknown): boolean {
  return (e instanceof Error || e instanceof DOMException) && e.name === 'AbortError';
}

/** "Künstler - Titel", the way a list names an entry (and the text reader reads it again). */
export function entryLine(e: ListEntry): string {
  return e.artists.length ? `${e.artists.join(', ')} - ${e.title}` : e.title;
}

/** The name of a file as the user knows it. */
export function fileLabel(f: LibraryFile): string {
  return f.source.relativePath ?? f.source.name;
}

/**
 * The rows of the result: the matcher's choice unless the user chose
 * otherwise. A file the user chose for one entry is taken from every other.
 */
export function rowsOf(matches: EntryMatch[], picks: ReadonlyMap<number, LibraryFile | null>): Row[] {
  const picked = new Set<ByteSource>();
  for (const f of picks.values()) if (f) picked.add(f.source);
  return matches.map((m): Row => {
    const options = m.candidates.map((c) => c.file);
    if (m.duplicateOf !== undefined) return { match: m, status: 'doppelt', options };
    // The matcher's choice and the user's stay choosable, also after "Nicht verwenden".
    const offer = (f: LibraryFile | undefined) => {
      if (f && !options.some((o) => o.source === f.source)) options.unshift(f);
    };
    offer(m.chosen);
    const pos = m.entry.position;
    if (picks.has(pos)) {
      const chosen = picks.get(pos) ?? undefined;
      offer(chosen);
      return { match: m, status: chosen ? 'gefunden' : 'weggelassen', chosen, options };
    }
    const chosen = m.chosen && !picked.has(m.chosen.source) ? m.chosen : undefined;
    const status: RowStatus = !chosen ? 'fehlt' : m.quality === 'sicher' ? 'gefunden' : 'pruefen';
    return { match: m, status, chosen, options };
  });
}

export function summaryOf(rows: Row[]): Summary {
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  const doubles = count('doppelt');
  return {
    total: rows.length - doubles,
    found: count('gefunden'),
    check: count('pruefen'),
    missing: count('fehlt'),
    left: count('weggelassen'),
    doubles,
    taken: rows.filter((r) => r.chosen).length,
  };
}

/** "18 von 20 Titeln gefunden, 1 bitte prüfen, 1 fehlt". */
export function summaryText(s: Summary): string {
  const parts = [`${s.found} von ${s.total} ${s.total === 1 ? 'Titel' : 'Titeln'} gefunden`];
  if (s.check) parts.push(`${s.check} bitte prüfen`);
  if (s.missing) parts.push(`${s.missing} ${s.missing === 1 ? 'fehlt' : 'fehlen'}`);
  if (s.left) parts.push(`${s.left} weggelassen`);
  return parts.join(', ');
}

/**
 * The files for the import in the order of the list, each with the facts
 * that keep them together: one album named after the list, numbered 1..N
 * over the files taken. Title and artist stay those of the file.
 */
export function handOverPlan(rows: Row[], listName: string): { sources: ByteSource[]; hints: Map<ByteSource, Partial<TrackInfo>> } {
  const taken = rows.filter((r): r is Row & { chosen: LibraryFile } => !!r.chosen);
  const hints = new Map<ByteSource, Partial<TrackInfo>>();
  const sources: ByteSource[] = [];
  for (const r of taken) {
    // The same file twice would get one number only: it goes in once.
    if (hints.has(r.chosen.source)) continue;
    sources.push(r.chosen.source);
    hints.set(r.chosen.source, { album: listName, albumArtist: VARIOUS_ARTISTS, trackNo: sources.length, discNo: 1, discOf: 1 });
  }
  for (const h of hints.values()) h.trackOf = sources.length;
  return { sources, hints };
}

/** The missing entries as text, one per line as "Künstler - Titel", so the app can read the file again later. */
export function missingListText(listName: string, rows: Row[]): string {
  const missing = rows.filter((r) => r.status === 'fehlt');
  const lines = [`# Fehlende Titel aus „${listName}“`, '', ...missing.map((r, i) => `${i + 1}. ${entryLine(r.match.entry)}`)];
  return `${lines.join('\n')}\n`;
}

/** A file name for the list of missing entries, without characters a file system refuses. */
export function missingFileName(listName: string): string {
  const name = listName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `Fehlende Titel${name ? ` – ${name}` : ''}.txt`;
}

export type PlaylistImport = ReturnType<typeof createPlaylistImport>;

export function createPlaylistImport(deps: PlaylistDeps) {
  /** The panel is open (it opens by itself while something is in it). */
  const open = signal(false);
  const listLoad = signal<ListLoad>({ status: 'idle' });
  /** The lists in what the user loaded; several in a Spotify export. */
  const lists = signal<TrackList[]>([]);
  const listId = signal<string | undefined>(undefined);
  const list = computed(() => lists.value.find((l) => l.id === listId.value));
  /** Lists left out of what the user loaded, because there were too many. */
  const omittedLists = signal(0);
  /** The text in the field for pasted titles (kept until the files are taken or the user starts over). */
  const pasted = signal('');
  /** Counts list files dropped on the page: the panel shows itself for each. */
  const dropped = signal(0);

  const library = signal<LibraryFile[]>([]);
  /** Tags are read: how far. */
  const reading = signal<{ done: number; total: number } | undefined>(undefined);
  const libraryNote = signal<Note | undefined>(undefined);

  const matches = signal<EntryMatch[] | undefined>(undefined);
  const matching = signal<{ done: number; total: number } | undefined>(undefined);
  /** The user's choices per list position; null: "Nicht verwenden". */
  const picks = signal<ReadonlyMap<number, LibraryFile | null>>(new Map());
  const rows = computed(() => (matches.value ? rowsOf(matches.value, picks.value) : []));
  const summary = computed(() => summaryOf(rows.value));

  const adding = signal(false);
  const addError = signal<string | undefined>(undefined);
  /** Something runs: the panel cannot be closed or reset by accident. */
  const busy = computed(() => listLoad.value.status === 'loading' || !!reading.value || !!matching.value || adding.value);
  /** Something was loaded or chosen: worth keeping the panel open for. */
  const started = computed(() => !!lists.value.length || !!library.value.length || busy.value || listLoad.value.status === 'failed');

  let readCtrl: AbortController | null = null;
  let matchCtrl: AbortController | null = null;
  /** Counts loads of a list: a slow one never overwrites a newer one. */
  let listSeq = 0;

  function setLists(result: ParseResult) {
    if (!result.lists.length) {
      listLoad.value = { status: 'failed', message: result.problem ?? 'In der Datei steht kein Titel, den ich lesen kann.' };
      return;
    }
    lists.value = result.lists;
    omittedLists.value = result.omittedLists ?? 0;
    listLoad.value = { status: 'idle' };
    // One list: on to the music. Several: the user chooses.
    chooseList(result.lists.length === 1 ? result.lists[0].id : undefined);
  }

  /** Lets the user choose the list file and reads it. */
  async function pickList(): Promise<void> {
    if (busy.peek()) return;
    const seq = ++listSeq;
    let picked: ByteSource[];
    try {
      picked = await deps.pickFiles({ multiple: false, extensions: LIST_EXTENSIONS });
    } catch (e) {
      if (seq === listSeq && !isAbort(e)) listLoad.value = { status: 'failed', message: pickFailed(e) };
      return;
    }
    // Cancelled: everything stays as it was.
    if (!picked.length || seq !== listSeq) return;
    await loadListFiles(picked.slice(0, 1), seq);
  }

  /**
   * Track list files dropped on the page (a Spotify ZIP, a CSV, or the
   * unpacked export folder) belong here, not in the import. True when they
   * were taken: nothing in them is audio, and at least one is a list. A ZIP
   * counts only when it looks like a Spotify export: an album packed as a
   * ZIP goes to the import, which says to unpack it.
   */
  async function takeDrop(sources: ByteSource[]): Promise<boolean> {
    if (!sources.some((s) => isListFile(s.name)) || sources.some((s) => isAudioFile(s.name))) return false;
    const candidates = sources.filter((s) => isListFile(s.name));
    const fits = await Promise.all(candidates.map((s) => (extensionOf(s.name) === 'zip' ? isSpotifyZip(s) : true)));
    const lists = candidates.filter((_, i) => fits[i]);
    if (!lists.length) return false;
    open.value = true;
    dropped.value++;
    // While the files go to the import, a new list would only be lost.
    if (!adding.peek()) void loadListFiles(lists.slice(0, MAX_LIST_FILES), ++listSeq);
    return true;
  }

  /** Reads list files; the lists of all of them are offered (several files: an unpacked Spotify export). */
  async function loadListFiles(files: ByteSource[], seq: number): Promise<void> {
    // A track list is small: a bigger file is the wrong one, and reading it would only fill the memory.
    const fitting = files.filter((f) => f.size <= MAX_LIST_FILE_BYTES);
    if (!fitting.length) {
      listLoad.value = {
        status: 'failed',
        message: `„${files[0].name}“ ist größer als 50 MB. Eine Titelliste ist viel kleiner. Wähle die ZIP-Datei mit den Kontodaten von Spotify oder eine Liste als Text.`,
      };
      return;
    }
    listLoad.value = { status: 'loading' };
    try {
      const found: TrackList[] = [];
      let problem: string | undefined;
      let omitted = 0;
      let budget = MAX_LIST_FILE_BYTES * 4;
      for (const file of fitting) {
        if (file.size > budget) break;
        budget -= file.size;
        const result = await parseTrackListFile(file.name, await file.read(0, file.size));
        if (seq !== listSeq) return;
        problem ??= result.problem;
        omitted += result.omittedLists ?? 0;
        // Two files may name their lists alike ("Playlist1.json#1" in two folders): each id once.
        const ids = new Set(found.map((l) => l.id));
        for (const l of result.lists) found.push(ids.has(l.id) ? { ...l, id: `${file.relativePath ?? file.name}#${found.length}` } : l);
      }
      setLists(found.length ? { lists: found, omittedLists: omitted || undefined } : { lists: [], problem });
    } catch {
      if (seq === listSeq) listLoad.value = { status: 'failed', message: NOT_READABLE };
    }
  }

  /** Reads the pasted titles. Returns a message when there is nothing to read (the field keeps the text then). */
  function readPasted(text: string = pasted.peek()): string | undefined {
    if (busy.peek()) return 'Warte kurz, ich bin gerade noch beschäftigt.';
    if (!text.trim()) return 'Füge zuerst ein paar Titel ein, einen pro Zeile.';
    listSeq++;
    let result: ParseResult;
    try {
      result = parseTrackListText(text);
    } catch {
      result = { lists: [] };
    }
    if (!result.lists.length) return result.problem ?? 'In dem Text steht kein Titel, den ich lesen kann. Schreibe einen Titel pro Zeile, zum Beispiel „Künstler - Titel“.';
    // The text stays in the field: after "Andere Liste" a typo can be put right.
    setLists(result);
    return undefined;
  }

  /** Takes one of the loaded lists (undefined: back to the choice). */
  function chooseList(id: string | undefined) {
    listId.value = id;
    picks.value = new Map();
    addError.value = undefined;
    void rematch();
  }

  /** Back to the start for the list; the music stays. */
  function clearList() {
    if (busy.peek()) return;
    listSeq++;
    lists.value = [];
    listLoad.value = { status: 'idle' };
    chooseList(undefined);
  }

  /** Lets the user choose music files or a folder and reads their tags. Choosing again adds to what is there. */
  async function addLibrary(directory: boolean): Promise<void> {
    if (reading.peek() || adding.peek()) return;
    let picked: ByteSource[];
    try {
      // With the extensions the desktop app only collects audio files of a folder (and counts only those against its limit).
      picked = await deps.pickFiles({ multiple: true, directory, extensions: AUDIO_EXTENSIONS });
    } catch (e) {
      if (!isAbort(e)) libraryNote.value = { tone: 'danger', text: pickFailed(e) };
      return;
    }
    if (!picked.length) return;
    const known = new Set(library.peek().map((f) => fileKey(f.source)));
    const audio = picked.filter((s) => isAudioFile(s.name) && s.size > 0);
    const fresh = audio.filter((s) => {
      const key = fileKey(s);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    if (!audio.length) {
      libraryNote.value = {
        tone: 'warning',
        text: directory ? 'In dem Ordner ist keine Musikdatei. Wähle den Ordner, in dem deine Lieder liegen, zum Beispiel deine kopierten CDs.' : 'Unter den Dateien ist keine Musikdatei.',
      };
      return;
    }
    if (!fresh.length) {
      libraryNote.value = { tone: 'neutral', text: 'Diese Dateien hab ich schon.' };
      return;
    }
    libraryNote.value = undefined;
    const ac = new AbortController();
    readCtrl = ac;
    let done = 0;
    reading.value = { done, total: fresh.length };
    const report = throttle(() => {
      if (readCtrl === ac) reading.value = { done, total: fresh.length };
    }, 100);
    const read: (LibraryFile | undefined)[] = await mapLimit(fresh, READ_PARALLEL, async (source) => {
      if (ac.signal.aborted) return undefined;
      let file: LibraryFile;
      try {
        file = { source, info: await deps.readTrackInfo(source, { cover: false, signal: ac.signal }) };
      } catch {
        if (ac.signal.aborted) return undefined;
        // No tags to read: the file name still says what it is.
        file = { source };
      }
      done++;
      report();
      return file;
    });
    if (readCtrl !== ac) return;
    readCtrl = null;
    reading.value = undefined;
    const added = read.filter((f): f is LibraryFile => !!f);
    if (ac.signal.aborted) {
      libraryNote.value = added.length
        ? { tone: 'neutral', text: `Abgebrochen. Ich hab ${added.length} von ${fresh.length} Dateien angesehen und nehme diese.` }
        : { tone: 'neutral', text: 'Abgebrochen.' };
    }
    if (!added.length) return;
    library.value = [...library.peek(), ...added];
    await rematch();
  }

  /** Stops reading the tags; what was read so far is kept. */
  function cancelReading() {
    readCtrl?.abort();
  }

  /** Forgets the chosen music. */
  function clearLibrary() {
    if (busy.peek()) return;
    library.value = [];
    libraryNote.value = undefined;
    picks.value = new Map();
    void rematch();
  }

  /** Matches the chosen list with the music anew (after either changed). */
  async function rematch(): Promise<void> {
    matchCtrl?.abort();
    matchCtrl = null;
    const l = list.peek();
    const files = library.peek();
    if (!l || !files.length) {
      matches.value = undefined;
      matching.value = undefined;
      return;
    }
    const ac = new AbortController();
    matchCtrl = ac;
    matching.value = { done: 0, total: l.entries.length };
    try {
      const result = await matchTrackListAsync(l, files, {
        signal: ac.signal,
        onProgress: (done, total) => {
          if (matchCtrl === ac) matching.value = { done, total };
        },
      });
      if (matchCtrl !== ac) return;
      matches.value = result;
    } catch (e) {
      if (matchCtrl !== ac || isAbort(e)) return;
      matches.value = undefined;
      libraryNote.value = { tone: 'danger', text: 'Der Abgleich mit deiner Musik hat nicht geklappt. Versuche es noch einmal.' };
    } finally {
      if (matchCtrl === ac) {
        matchCtrl = null;
        matching.value = undefined;
      }
    }
  }

  /** The user's choice for an entry (null: leave it out). A file can only be in one place: it leaves any other entry. */
  function choose(position: number, file: LibraryFile | null) {
    const next = new Map(picks.peek());
    if (file) for (const [p, f] of next) if (p !== position && f?.source === file.source) next.delete(p);
    next.set(position, file);
    picks.value = next;
  }

  /** Hands the files to the import, in the order of the list. Resets the panel when they were taken. */
  async function take(): Promise<AddResult | undefined> {
    const l = list.peek();
    if (!l || busy.peek()) return undefined;
    const plan = handOverPlan(rows.peek(), l.name);
    if (!plan.sources.length) return undefined;
    adding.value = true;
    addError.value = undefined;
    try {
      const result = await deps.addSources(plan.sources, { hints: plan.hints });
      adding.value = false;
      if (result.cancelled) return result;
      if (!result.accepted) {
        addError.value = 'Ich konnte keine der Dateien lesen. Prüfe, ob sie noch da sind, und versuche es noch einmal.';
        return result;
      }
      reset();
      return result;
    } catch {
      adding.value = false;
      addError.value = 'Das Übernehmen hat nicht geklappt. Versuche es noch einmal.';
      return undefined;
    }
  }

  /** Starts over: list, music and choices are gone. */
  function reset() {
    listSeq++;
    readCtrl?.abort();
    readCtrl = null;
    matchCtrl?.abort();
    matchCtrl = null;
    lists.value = [];
    omittedLists.value = 0;
    listId.value = undefined;
    listLoad.value = { status: 'idle' };
    pasted.value = '';
    library.value = [];
    reading.value = undefined;
    libraryNote.value = undefined;
    matches.value = undefined;
    matching.value = undefined;
    picks.value = new Map();
    adding.value = false;
    addError.value = undefined;
  }

  return {
    open,
    listLoad,
    lists,
    omittedLists,
    listId,
    list,
    pasted,
    dropped,
    library,
    reading,
    libraryNote,
    matches,
    matching,
    picks,
    rows,
    summary,
    adding,
    addError,
    busy,
    started,
    pickList,
    takeDrop,
    readPasted,
    chooseList,
    clearList,
    addLibrary,
    cancelReading,
    clearLibrary,
    rematch,
    choose,
    take,
    reset,
  };
}
