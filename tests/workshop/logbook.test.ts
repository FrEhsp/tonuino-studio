import { describe, expect, it } from 'vitest';
import {
  Logbook,
  NOTES,
  clockTime,
  dateTime,
  emptyLogText,
  entryLevel,
  exportText,
  forumText,
  isNearBottom,
  logFileName,
  logText,
  MAX_LOG_FILE,
  pauseSnapshot,
  readLogFile,
  rebuildWay,
  splitSavedLog,
  visibleEntries,
  waitingLines,
  type LogEntry,
} from '../../src/features/workshop/logbook';
import type { ByteSource } from '../../src/platform/types';
import { AIOPLUS_BROKEN_LOG, CLASSIC_LOG } from './fakes';

const T0 = new Date(2026, 9, 5, 15, 40, 1, 123).getTime();

function clock(start = T0) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

/** Feeds text in pieces of `size` bytes, like a serial port does. */
function feed(book: Logbook, text: string, size = 7): void {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) book.push(bytes.subarray(i, i + size));
}

describe('Logbook', () => {
  it('turns bytes into explained lines and starts', () => {
    const book = new Logbook({ now: clock().now });
    feed(book, CLASSIC_LOG);
    const kinds = book.entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'line')).toHaveLength(20);
    // The start is marked right before the banner line.
    const boot = book.entries.findIndex((e) => e.kind === 'boot');
    expect(book.entries[boot]).toMatchObject({ kind: 'boot', text: 'Die Box startet', tone: 'info', time: T0 });
    expect(book.entries[boot + 1].text).toBe('TonUINO Version 3.x - refactored by Boerge1');
    expect(book.info).toMatchObject({ firmware: 'tng', board: 'classic', volume: 16 });
    expect(book.issues).toEqual([]);

    const important = visibleEntries(book.entries, 'important');
    expect(important.some((e) => e.text.startsWith(' _____'))).toBe(false);
    expect(important.find((e) => e.text === 'MFRC522:146')?.explanation?.title).toBe('Kartenleser bereit');
    expect(visibleEntries(book.entries, 'all')).toHaveLength(book.entries.length);
  });

  it('reports a restart nobody asked for, but not one the app asked for', () => {
    const book = new Logbook({ now: clock().now });
    book.push(CLASSIC_LOG);
    book.push(CLASSIC_LOG);
    const boots = book.entries.filter((e) => e.kind === 'boot');
    expect(boots.map((e) => [e.text, e.tone])).toEqual([
      ['Die Box startet', 'info'],
      ['Die Box ist neu gestartet', 'warn'],
    ]);
    expect(entryLevel(boots[1])).toBe('warn');
    expect(book.issues.map((i) => i.explanation.id)).toEqual(['reboot']);

    book.restartRequested();
    book.push(CLASSIC_LOG);
    expect(book.entries.filter((e) => e.kind === 'boot').at(-1)?.text).toBe('Die Box startet');
    expect(book.issues).toEqual([]);
  });

  it('keeps the Steckbrief until a requested start arrives, and expects it also after the box ignored the request', () => {
    const book = new Logbook({ now: clock().now });
    book.connected('USB-Serial CH340 (ttyUSB0)');
    book.push(AIOPLUS_BROKEN_LOG);
    book.restartRequested();
    // The box did not restart: what is known stays.
    expect(book.info.board).toBe('aioplus');
    expect(book.issues).toHaveLength(3);
    book.restartMissed();
    expect(book.entries.at(-1)).toMatchObject({ kind: 'note', text: NOTES.noRestart, tone: 'warn' });
    expect(book.info.board).toBe('aioplus');
    // Switched off and on as the note says: an ordinary start, no warning.
    book.push(CLASSIC_LOG);
    expect(book.entries.filter((e) => e.kind === 'boot').map((e) => e.text)).toEqual(['Die Box startet', 'Die Box startet']);
    expect(book.info.board).toBe('classic');
    expect(book.issues).toEqual([]);
    // Without a request, the next start is a surprise again.
    book.push(CLASSIC_LOG);
    expect(book.issues.map((i) => i.explanation.id)).toEqual(['reboot']);
  });

  it('forgets the expected start when the restart could not be sent', () => {
    const book = new Logbook({ now: clock().now });
    book.push(CLASSIC_LOG);
    book.restartRequested();
    book.restartFailed();
    book.push(CLASSIC_LOG);
    expect(book.issues.map((i) => i.explanation.id)).toEqual(['reboot']);
  });

  it('keeps a half line until it is complete, and ends it on flush', () => {
    const book = new Logbook({ now: clock().now });
    book.push('Volume: 1');
    expect(book.entries).toEqual([]);
    book.push('2\r\nVolu');
    expect(book.entries.map((e) => e.text)).toEqual(['Volume: 12']);
    expect(book.flush()).toBe(true);
    expect(book.entries.map((e) => e.text)).toEqual(['Volume: 12', 'Volu']);
    // A restart ends a half line first instead of losing it.
    book.push('Card');
    book.restartRequested();
    expect(book.entries.slice(-2).map((e) => e.text)).toEqual(['Card', 'Neustart angestoßen …']);
  });

  it('drops the oldest entries beyond the limit and counts them', () => {
    const book = new Logbook({ maxEntries: 10, now: clock().now });
    for (let i = 1; i <= 25; i++) book.push(`Volume: ${i}\n`);
    expect(book.entries).toHaveLength(10);
    expect(book.dropped).toBe(15);
    expect(book.entries[0]).toMatchObject({ id: 16, text: 'Volume: 16' });
    expect(book.lastId).toBe(25);
    book.clear();
    expect([book.entries.length, book.dropped, book.lastId]).toEqual([0, 0, 0]);
    // The Steckbrief survives clearing the list.
    expect(book.info.volume).toBe(25);
    book.push('Volume: 3\n');
    expect(book.entries[0].id).toBe(26);
  });

  it('adds notes of the app between the lines', () => {
    const c = clock();
    const book = new Logbook({ now: c.now });
    book.note('Verbunden mit USB-Serial CH340 (ttyUSB0).');
    c.tick(1500);
    book.note('Die Verbindung ist weg.', 'warn');
    expect(book.entries).toEqual([
      { id: 1, kind: 'note', text: 'Verbunden mit USB-Serial CH340 (ttyUSB0).', tone: 'info', time: T0 },
      { id: 2, kind: 'note', text: 'Die Verbindung ist weg.', tone: 'warn', time: T0 + 1500 },
    ]);
    expect(visibleEntries(book.entries, 'important')).toHaveLength(2);
    expect(visibleEntries(book.entries, 'all')).toHaveLength(2);
  });

  it('reads a log of another program with line numbers of the file', async () => {
    const book = new Logbook();
    expect(await book.loadText(`\n${AIOPLUS_BROKEN_LOG}`)).toBe(true);
    expect(book.entries[0]).toMatchObject({ kind: 'boot', lineNo: 2 });
    expect(book.entries[1]).toMatchObject({ kind: 'line', lineNo: 2, text: 'TonUINO Version 3.x - refactored by Boerge1' });
    expect(book.entries.every((e) => e.time === undefined)).toBe(true);
    expect(book.issues.map((i) => i.explanation.level)).toEqual(['error', 'error', 'error']);
  });

  it('reads times that terminal programs write in front of the lines', async () => {
    const book = new Logbook({ now: clock().now });
    await book.loadText('[09:15:00.250] TonUINO Version 3.x - refactored by Boerge1\n[09:15:00.300] A+ 5\n');
    expect(book.info.board).toBe('aioplus');
    expect(book.entries.map((e) => [e.kind, e.text, clockTime(e.time ?? 0, true)])).toEqual([
      ['boot', 'Die Box startet', '09:15:00.250'],
      ['line', 'TonUINO Version 3.x - refactored by Boerge1', '09:15:00.250'],
      ['line', 'A+ 5', '09:15:00.300'],
    ]);
  });
});

/** What a row shows, without the id, to compare a logbook with the one read back from its file. */
function shown(entries: readonly LogEntry[]) {
  return entries.map((e) => ({ kind: e.kind, text: e.text, time: e.time, tone: entryLevel(e), explained: e.explanation?.id }));
}

describe('saved Logbuch read back', () => {
  /** A live session: connect, a box with a broken reader and player that restarts by itself, then a requested restart. */
  function session() {
    const c = clock();
    const book = new Logbook({ now: c.now });
    book.connected('USB-Serial CH340 (ttyUSB0)');
    for (const part of [AIOPLUS_BROKEN_LOG, AIOPLUS_BROKEN_LOG]) {
      c.tick(1234);
      book.push(part);
    }
    c.tick(5000);
    book.restartRequested();
    c.tick(800);
    book.push(AIOPLUS_BROKEN_LOG);
    c.tick(60_000);
    book.connectionEnded({ reason: 'lost' });
    return { book, savedAt: c.now() };
  }

  it('gives the same Steckbrief, issues, times and notes', async () => {
    const { book, savedAt } = session();
    // The second start came unasked; the requested third start reset the count.
    expect(book.entries.filter((e) => e.kind === 'boot').map((e) => e.text)).toEqual(['Die Box startet', 'Die Box ist neu gestartet', 'Die Box startet']);
    const meta = { at: savedAt, source: 'USB-Serial CH340 (ttyUSB0), 115200 Baud' };
    const file = exportText(book.entries, book.info, book.issues, meta);

    const back = new Logbook({ now: () => savedAt + 86_400_000 });
    expect(await back.loadText(file)).toBe(true);
    expect(back.info).toEqual(book.info);
    expect(back.info.board).toBe('aioplus');
    expect(back.issues).toEqual(book.issues);
    expect(back.issues.map((i) => i.explanation.level)).toEqual(['error', 'error', 'error']);
    expect(shown(back.entries)).toEqual(shown(book.entries));
    // Saving it again gives the same log.
    expect(exportText(back.entries, back.info, back.issues, meta)).toBe(file);
  });

  it('reads a forum post back, also when copied from the rendered page without the code fences', async () => {
    const { book, savedAt } = session();
    const post = forumText(book.entries, book.info, book.issues, { at: savedAt, source: 'USB-Serial CH340 (ttyUSB0), 115200 Baud' });
    const back = new Logbook({ now: () => savedAt });
    await back.loadText(post);
    expect(back.info).toEqual(book.info);
    expect(back.issues).toEqual(book.issues);
    expect(shown(back.entries)).toEqual(shown(book.entries));

    const rendered = new Logbook({ now: () => savedAt });
    await rendered.loadText(post.replaceAll('```\n', ''));
    expect(rendered.issues).toEqual(book.issues);
  });

  it('writes the forum post as facts only: no tips and no sentences of the app (Prüfrunde 1, bastler 12)', () => {
    const { book, savedAt } = session();
    const post = forumText(book.entries, book.info, book.issues, { at: savedAt });
    expect(book.issues.length).toBeGreaterThan(0);
    expect(post).not.toMatch(/Tipp:|\b[Ii]ch\b/);
    for (const i of book.issues) expect(post).toContain(i.explanation.title);
  });

  it('keeps an unexpected restart in a saved file unexpected', async () => {
    const book = new Logbook({ now: clock().now });
    book.connected('COM4');
    book.push(CLASSIC_LOG);
    book.push(CLASSIC_LOG);
    const back = new Logbook();
    await back.loadText(exportText(book.entries, book.info, book.issues, { at: T0 }));
    expect(back.issues.map((i) => [i.explanation.id, i.count])).toEqual([['reboot', 1]]);
  });

  it('dates times of a log saved after midnight to the evening before', async () => {
    const evening = new Date(2026, 9, 4, 23, 59, 58, 0).getTime();
    const c = clock(evening);
    const book = new Logbook({ now: c.now });
    book.push('Volume: 7\n');
    c.tick(4000);
    book.push('Volume: 8\n');
    const back = new Logbook();
    await back.loadText(exportText(book.entries, book.info, book.issues, { at: c.now() }));
    expect(back.entries.map((e) => e.time)).toEqual([evening, evening + 4000]);
  });

  it('finds the log part of the files it wrote', () => {
    const at = new Date(2026, 9, 5, 15, 40).getTime();
    const file = splitSavedLog(['TonUINO Studio: Box-Logbuch', 'Gespeichert: 05.10.2026, 15:40', 'Ältere Zeilen ausgelassen: 12', '', 'Steckbrief der Box', '- keine', '', 'Log', '[15:39:00.000] Volume: 3', ''].join('\r\n'));
    expect(file).toEqual({ kind: 'export', lines: ['[15:39:00.000] Volume: 3', ''], firstLineNo: 9, savedAt: at, dropped: 12 });
    expect(splitSavedLog('Box-Logbuch aus TonUINO Studio\n\nSteckbrief der Box\n```\nVolume: 3\n```\n')).toEqual({ kind: 'forum', lines: ['Volume: 3'], firstLineNo: 5 });
    expect(splitSavedLog('Volume: 3\n')).toEqual({ kind: 'plain', lines: ['Volume: 3', ''], firstLineNo: 1 });
  });
});

describe('big log files', () => {
  const big = Array.from({ length: 40 }, () => CLASSIC_LOG).join('');

  it('reads in slices, says how far it is, and drops old entries in bulk', async () => {
    const book = new Logbook({ maxEntries: 50 });
    const progress: number[] = [];
    let turns = 0;
    const done = await book.loadText(big, {
      sliceMs: 0,
      checkLines: 100,
      onProgress: (p) => progress.push(p),
      yieldTurn: async () => {
        turns++;
        // The page gets the list trimmed to the limit.
        expect(book.entries.length).toBeLessThanOrEqual(50);
      },
    });
    expect(done).toBe(true);
    expect(turns).toBe(8);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(book.entries).toHaveLength(50);
    // 40 starts and 800 lines went in; 50 entries are left.
    expect(book.dropped).toBe(40 * 21 - 50);
    expect(book.totalLines).toBe(800);
    expect(book.entries.at(-1)?.lineNo).toBe(800);
  });

  it('stops when cancelled', async () => {
    const book = new Logbook();
    const ctl = new AbortController();
    const done = await book.loadText(big, { sliceMs: 0, checkLines: 100, signal: ctl.signal, yieldTurn: async () => ctl.abort() });
    expect(done).toBe(false);
    expect(book.totalLines).toBe(100);
  });
});

describe('pause', () => {
  it('keeps the rows of the moment and counts what arrives', () => {
    const book = new Logbook({ maxEntries: 10, now: clock().now });
    for (let i = 1; i <= 10; i++) book.push(`Volume: ${i}\n`);
    const pause = pauseSnapshot(book);
    for (let i = 11; i <= 30; i++) book.push(`Volume: ${i}\n`);
    // The limit dropped every row the pause shows; the pause still shows them.
    expect(book.entries[0].text).toBe('Volume: 21');
    expect(pause.entries.map((e) => e.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Volume: ${i + 1}`));
    expect(waitingLines(pause)).toBe(20);
  });

  it('says why the list is empty', () => {
    const line: LogEntry = { id: 1, kind: 'line', text: 'enter Idle', explanation: null };
    const base = { shown: [] as LogEntry[], filter: 'important' as const, paused: false, live: false, canConnect: true };
    expect(emptyLogText({ ...base, shown: [line] })).toBe('Noch nichts Wichtiges dabei. Unter „Alles“ siehst du jede Zeile.');
    expect(emptyLogText({ ...base, paused: true, live: true })).toBe('Angehalten, bevor eine Meldung kam. Klicke auf „Weiter“, dann siehst du die neuen Meldungen.');
    expect(emptyLogText({ ...base, filter: 'all', live: true })).toContain('Warte auf Meldungen der Box');
    expect(emptyLogText(base)).toBe('Noch keine Meldungen. Verbinde die Box, dann erscheinen hier ihre Meldungen.');
    expect(emptyLogText({ ...base, canConnect: false })).toBe('Noch keine Meldungen. Öffne eine gespeicherte Logbuch-Datei, dann siehst du sie hier.');
  });
});

describe('Logbook text', () => {
  it('writes the log with times and marks notes', () => {
    const c = clock();
    const book = new Logbook({ now: c.now });
    book.note('Verbunden.');
    c.tick(250);
    book.push('Volume: 7\n');
    expect(logText(book.entries)).toBe('[15:40:01.123] ## Verbunden.\n[15:40:01.373] Volume: 7');
  });

  it('exports a file and a forum post with the Steckbrief', () => {
    const book = new Logbook({ now: clock().now });
    book.push(CLASSIC_LOG);
    const meta = { at: T0, source: 'USB-Serial CH340 (ttyUSB0), 115200 Baud', dropped: 3 };
    const file = exportText(book.entries, book.info, book.issues, meta);
    expect(file.split('\n').slice(0, 6)).toEqual([
      'TonUINO Studio: Box-Logbuch',
      'Gespeichert: 05.10.2026, 15:40',
      'Quelle: USB-Serial CH340 (ttyUSB0), 115200 Baud',
      'Ältere Zeilen ausgelassen: 3',
      '',
      'Steckbrief der Box',
    ]);
    expect(file).toContain('\nLog\n[15:40:01.123]  _____');
    expect(file).toContain('\n[15:40:01.123] ## Die Box startet\n[15:40:01.123] TonUINO Version 3.x - refactored by Boerge1\n');
    const post = forumText(book.entries, book.info, book.issues, meta);
    expect(post.startsWith('Box-Logbuch aus TonUINO Studio (USB-Serial CH340 (ttyUSB0), 115200 Baud)\n\nSteckbrief der Box')).toBe(true);
    expect(post).toContain('\n```\n[15:40:01.123]  _____');
    expect(post.trimEnd().endsWith('Volume: 16\n```')).toBe(true);
  });

  it('formats times and file names', () => {
    expect(clockTime(T0)).toBe('15:40:01');
    expect(clockTime(T0, true)).toBe('15:40:01.123');
    expect(dateTime(T0)).toBe('05.10.2026, 15:40');
    expect(logFileName(T0)).toBe('TonUINO-Logbuch-2026-10-05-1540.txt');
  });

  it('knows when the list shows its end', () => {
    expect(isNearBottom(600, 400, 1000)).toBe(true);
    expect(isNearBottom(580, 400, 1000)).toBe(true);
    expect(isNearBottom(500, 400, 1000)).toBe(false);
  });
});

describe('saved log files', () => {
  const file = (name: string, data: Uint8Array | string, failing = false): ByteSource => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return {
      name,
      size: bytes.length,
      read: async (start, length) => {
        if (failing) throw new Error('gone');
        return bytes.slice(start, start + length);
      },
    };
  };

  it('reads text', async () => {
    expect(await readLogFile(file('box.txt', 'Volume: 3\nÄnderung\n'))).toEqual({ text: 'Volume: 3\nÄnderung\n' });
  });

  it('says what is wrong with other files', async () => {
    const zip = new Uint8Array(2000);
    zip.set([0x50, 0x4b, 3, 4]);
    expect(await readLogFile(file('Ansagen.zip', zip))).toEqual({ error: '„Ansagen.zip“ ist keine Textdatei. Wähle eine Logbuch-Datei (.txt oder .log).' });
    expect(await readLogFile(file('weg.txt', 'x', true))).toEqual({
      error: '„weg.txt“ ließ sich nicht lesen. Vielleicht wurde die Datei verschoben oder gelöscht. Wähle sie noch einmal aus.',
    });
    const huge: ByteSource = { name: 'film.txt', size: MAX_LOG_FILE + 1, read: async () => new Uint8Array() };
    expect(await readLogFile(huge)).toEqual({ error: '„film.txt“ ist mit 8 MB zu groß für ein Logbuch. Wähle die .txt-Datei, die du gespeichert hast.' });
  });
});

describe('rebuild button of the Box-Logbuch', () => {
  it('rebuilds a read card in place, builds a Paket for a snapshot and asks for the card otherwise', () => {
    expect(rebuildWay({ status: 'ready', volume: { access: 'direct' } })).toBe('rebuild');
    expect(rebuildWay({ status: 'ready', volume: {} })).toBe('rebuild');
    expect(rebuildWay({ status: 'ready', volume: { access: 'snapshot' } })).toBe('package');
    expect(rebuildWay({ status: 'scanning', volume: { access: 'direct' } })).toBe('open-card');
    expect(rebuildWay({ status: 'error', volume: {} })).toBe('open-card');
    expect(rebuildWay(null)).toBe('open-card');
  });
});
