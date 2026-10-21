import { describe, expect, it } from 'vitest';
import { LOG_BAUD_RATE, isConnectionLost, openMonitor, type MonitorEnd } from '../../src/features/workshop/monitor';
import { LogSession, linkProblem, type LinkState } from '../../src/features/workshop/logsession';
import { AIO_PORT, AIOPLUS_BROKEN_LOG, CH340_PORT, CLASSIC_LOG, FakeSerial, lostError, until } from './fakes';

const noSleep = async () => undefined;

function collector() {
  const chunks: string[] = [];
  const ends: MonitorEnd[] = [];
  return {
    chunks,
    ends,
    handlers: {
      onData: (b: Uint8Array) => chunks.push(new TextDecoder().decode(b)),
      onEnd: (e: MonitorEnd) => ends.push(e),
    },
  };
}

describe('serial monitor', () => {
  it('reads at 115200 baud until stopped, then closes the port', async () => {
    const serial = new FakeSerial();
    const c = collector();
    const m = await openMonitor(serial, CH340_PORT, c.handlers, { readSliceMs: 20 });
    expect(serial.last.baudRate).toBe(LOG_BAUD_RATE);
    serial.last.send('Volume: 3\r\n');
    await until(() => c.chunks.length === 1);
    expect(c.chunks).toEqual(['Volume: 3\r\n']);
    const started = Date.now();
    await m.stop();
    expect(Date.now() - started).toBeLessThan(100);
    expect(serial.last.closed).toBe(true);
    expect(c.ends).toEqual([{ reason: 'stopped' }]);
    await m.stop();
    expect(c.ends).toHaveLength(1);
  });

  it('tells a pulled cable from other failures and closes the port either way', async () => {
    const serial = new FakeSerial();
    const lost = collector();
    const m = await openMonitor(serial, CH340_PORT, lost.handlers, { readSliceMs: 20 });
    serial.last.unplug();
    await m.closed;
    expect(lost.ends.map((e) => e.reason)).toEqual(['lost']);
    expect(serial.last.closed).toBe(true);

    const other = collector();
    const m2 = await openMonitor(serial, CH340_PORT, other.handlers, { readSliceMs: 20 });
    serial.last.unplug(new Error('Etwas ist schiefgelaufen.'));
    await m2.closed;
    expect(other.ends.map((e) => e.reason)).toEqual(['error']);
    expect(serial.last.closed).toBe(true);

    expect(isConnectionLost(lostError())).toBe(true);
    expect(isConnectionLost(new DOMException('The device has been lost.', 'NetworkError'))).toBe(true);
    expect(isConnectionLost({ code: 'not-found' })).toBe(true);
    expect(isConnectionLost(new Error('x'))).toBe(false);
  });

  it('restarts the box with DTR and RTS in an order that suits Nano and ESP32', async () => {
    const serial = new FakeSerial();
    const m = await openMonitor(serial, CH340_PORT, collector().handlers, { readSliceMs: 20, sleep: noSleep });
    await m.restartBox();
    expect(serial.last.signals).toEqual([
      { dtr: false, rts: false },
      { dtr: false, rts: true },
      { dtr: true, rts: true },
    ]);
    await m.stop();
  });

  it('passes on why the port does not open', async () => {
    const serial = new FakeSerial();
    serial.openError = new Error('Der Anschluss ist schon geöffnet.');
    await expect(openMonitor(serial, CH340_PORT, collector().handlers)).rejects.toThrow('schon geöffnet');
  });
});

describe('live Box-Logbuch', () => {
  const fast = { throttleMs: 1, restartWatchMs: 40, monitor: { readSliceMs: 10, sleep: noSleep } };

  it('connects, shows the start of the box and disconnects', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    expect(s.link.value).toEqual({ kind: 'connected', port: CH340_PORT, baudRate: 115200 });
    expect(s.book.entries.at(-1)?.text).toBe('Verbunden mit USB-Serial CH340 (ttyUSB0).');
    const before = s.revision.value;
    serial.last.send(CLASSIC_LOG);
    await until(() => s.book.info.volume === 16);
    await until(() => s.revision.value > before);
    expect(s.book.bootCount).toBe(1);
    expect(s.book.issues).toEqual([]);

    await s.disconnect();
    expect(s.link.value).toEqual({ kind: 'idle' });
    expect(serial.last.closed).toBe(true);
    expect(s.book.entries.at(-1)?.text).toBe('Verbindung getrennt.');
    // The lines stay for a later look.
    expect(s.book.info.board).toBe('classic');
  });

  it('says so when the cable is pulled and connects again', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    serial.last.send('Volume: 9\n');
    serial.last.unplug();
    await until(() => s.link.value.kind === 'lost');
    expect(s.link.value).toEqual({ kind: 'lost', port: CH340_PORT });
    expect(serial.last.closed).toBe(true);
    expect(s.book.entries.map((e) => e.text).slice(-2)).toEqual(['Volume: 9', 'Die Verbindung ist weg. Wurde das USB-Kabel abgezogen oder die Box ausgeschaltet?']);
    expect(s.lastPort).toBe(CH340_PORT);

    await s.connect(serial, CH340_PORT);
    expect(s.link.value.kind).toBe('connected');
    expect(serial.connections).toHaveLength(2);
    await s.disconnect();
  });

  it('explains why the port did not open like the firmware wizard, with the hints and the setup button of the desktop app', async () => {
    const serial = new FakeSerial();
    const error = Object.assign(new Error('Ich darf noch nicht auf die Box zugreifen.'), {
      code: 'permission',
      hints: [{ id: 'linux-serial-permission', text: 'Füge dich der Gruppe hinzu:', command: 'sudo usermod -aG dialout anna' }, { bogus: true }],
    });
    serial.openError = error;
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    const link = s.link.value as Extract<LinkState, { kind: 'error' }>;
    expect(link).toEqual({ kind: 'error', phase: 'open', port: CH340_PORT, error });
    const problem = linkProblem(link, 'linux');
    expect(problem).toMatchObject({ code: 'port-permission', title: 'Kein Zugriff auf den USB-Anschluss', action: { kind: 'usb-access-setup', label: 'USB-Zugriff einrichten' } });
    expect(problem.steps[0]).toBe('Füge dich der Gruppe hinzu: sudo usermod -aG dialout anna');
  });

  it('names the driver only for boxes whose USB chip needs it', () => {
    const failed = (port: typeof CH340_PORT): Extract<LinkState, { kind: 'error' }> => ({
      kind: 'error',
      phase: 'open',
      port,
      error: new Error('Der Anschluss lässt sich nicht öffnen. Meist benutzt ihn gerade ein anderes Programm, oder es fehlt ein Treiber oder die Berechtigung.'),
    });
    const ch340 = linkProblem(failed(CH340_PORT), 'windows');
    expect(ch340.steps.join(' ')).toContain('CH340');
    expect(ch340.action?.kind).toBe('link');
    const aio = linkProblem(failed(AIO_PORT), 'windows');
    expect(aio.steps.join(' ')).not.toContain('CH340');
    expect(aio.action).toBeUndefined();
  });

  it('keeps the Steckbrief, the issues and the lines when connecting again fails', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    serial.last.send(AIOPLUS_BROKEN_LOG);
    await until(() => s.book.issues.length === 3);
    serial.last.unplug();
    await until(() => s.link.value.kind === 'lost');
    const lines = s.book.entries.length;

    serial.openError = Object.assign(new Error('Der Anschluss ist nicht mehr da.'), { code: 'not-found' });
    await s.connect(serial, CH340_PORT);
    expect(s.link.value).toMatchObject({ kind: 'error', phase: 'open' });
    expect(s.book.info.board).toBe('aioplus');
    expect(s.book.issues).toHaveLength(3);
    expect(s.book.entries).toHaveLength(lines);

    // Once the port opens, the Steckbrief starts over for the box behind it.
    serial.openError = undefined;
    await s.connect(serial, CH340_PORT);
    expect(s.book.info.board).toBeUndefined();
    expect(s.book.entries.at(-1)?.text).toBe('Verbunden mit USB-Serial CH340 (ttyUSB0).');
    await s.disconnect();
  });

  it('shows a broken connection with advice', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    serial.last.unplug(new Error('Etwas ist schiefgelaufen.'));
    await until(() => s.link.value.kind === 'error');
    const link = s.link.value as Extract<LinkState, { kind: 'error' }>;
    expect(link.phase).toBe('read');
    expect(s.book.entries.at(-1)).toMatchObject({ kind: 'note', text: 'Die Verbindung ist abgebrochen: Etwas ist schiefgelaufen.', tone: 'error' });
    expect(linkProblem(link, 'windows')).toMatchObject({ code: 'connection-lost', title: 'Die Verbindung ist abgebrochen', technical: 'Etwas ist schiefgelaufen.' });
  });

  it('restarts the box on request and says when it did not restart', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    await s.restartBox();
    expect(serial.last.signals).toHaveLength(3);
    expect(s.book.entries.at(-1)?.text).toBe('Neustart angestoßen …');
    await until(() => s.book.entries.at(-1)?.tone === 'warn');
    expect(s.book.entries.at(-1)?.text).toBe('Die Box hat nicht neu gestartet. Schalte sie aus und wieder ein, dann siehst du ihren Start.');

    await s.restartBox();
    serial.last.send(CLASSIC_LOG);
    await until(() => s.book.bootCount === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.book.entries.filter((e) => e.tone === 'warn')).toHaveLength(1);
    expect(s.book.entries.filter((e) => e.kind === 'boot').map((e) => e.text)).toEqual(['Die Box startet']);
    await s.disconnect();
  });

  it('keeps the Steckbrief when the box ignores "Box neu starten"', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    serial.last.send(AIOPLUS_BROKEN_LOG);
    await until(() => s.book.issues.length === 3);
    await s.restartBox();
    await until(() => s.book.entries.at(-1)?.tone === 'warn');
    expect(s.book.info.board).toBe('aioplus');
    expect(s.book.issues).toHaveLength(3);
    // Switched off and on by hand: an ordinary start.
    serial.last.send(CLASSIC_LOG);
    await until(() => s.book.bootCount === 2);
    expect(s.book.entries.filter((e) => e.kind === 'boot').map((e) => e.text)).toEqual(['Die Box startet', 'Die Box startet']);
    expect(s.book.issues).toEqual([]);
    await s.disconnect();
  });

  it('says so when the restart cannot be sent', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    serial.last.send(CLASSIC_LOG);
    await until(() => s.book.bootCount === 1);
    serial.last.unplug();
    await expect(s.restartBox()).rejects.toThrow('Die Verbindung zur Box ist abgebrochen');
    await until(() => s.link.value.kind === 'lost');
    expect(s.book.info.board).toBe('classic');
  });

  it('ignores a connection that was cancelled while the port opened', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    const pending = s.connect(serial, CH340_PORT);
    await s.disconnect();
    await pending;
    expect(s.link.value).toEqual({ kind: 'idle' });
    expect(serial.last.closed).toBe(true);
  });

  it('shows a saved file instead of the live lines, and starts fresh when connecting again', async () => {
    const serial = new FakeSerial();
    const s = new LogSession(fast);
    await s.connect(serial, CH340_PORT);
    expect(s.sourceText()).toBe('USB-Serial CH340 (ttyUSB0), 115200 Baud');
    serial.last.send('Volume: 9\n');
    await until(() => s.book.entries.some((e) => e.text === 'Volume: 9'));

    expect(await s.openFile('box.txt', CLASSIC_LOG)).toBe(true);
    expect(serial.last.closed).toBe(true);
    expect(s.link.value).toEqual({ kind: 'idle' });
    expect(s.source).toEqual({ kind: 'file', name: 'box.txt' });
    expect(s.sourceText()).toBe('Datei „box.txt“');
    expect(s.book.entries.some((e) => e.text === 'Volume: 9')).toBe(false);
    expect(s.book.entries[0].lineNo).toBe(1);
    expect(s.book.info.board).toBe('classic');

    // A connection that fails leaves the file on screen.
    serial.openError = new Error('Der Anschluss ist schon geöffnet.');
    await s.connect(serial, CH340_PORT);
    expect(s.source).toEqual({ kind: 'file', name: 'box.txt' });
    expect(s.book.info.board).toBe('classic');

    serial.openError = undefined;
    await s.connect(serial, CH340_PORT);
    expect(s.source).toEqual({ kind: 'live' });
    expect(s.book.info.board).toBeUndefined();
    expect(s.book.entries.map((e) => e.text)).toEqual(['Verbunden mit USB-Serial CH340 (ttyUSB0).']);
    await s.disconnect();
  });

  it('reads a big file in slices, keeps the live lines when cancelled, and saves nothing twice', async () => {
    const serial = new FakeSerial();
    const turns: (() => void)[] = [];
    const s = new LogSession({ ...fast, load: { sliceMs: 0, checkLines: 50, yieldTurn: () => new Promise<void>((r) => turns.push(r)) } });
    await s.connect(serial, CH340_PORT);
    const big = Array.from({ length: 20 }, () => CLASSIC_LOG).join('');

    const first = s.openFile('gross.txt', big);
    await until(() => turns.length === 1);
    expect(s.loading.value).toEqual({ name: 'gross.txt', progress: 50 / 401 });
    // Still connected while the file is read.
    expect(s.connected).toBe(true);
    s.cancelLoad();
    turns.shift()?.();
    expect(await first).toBe(false);
    expect(s.loading.value).toBeNull();
    expect(s.connected).toBe(true);
    expect(s.source).toEqual({ kind: 'live' });

    const second = s.openFile('gross.txt', big);
    while (s.loading.value) {
      await until(() => turns.length > 0 || !s.loading.value);
      turns.shift()?.();
    }
    expect(await second).toBe(true);
    expect(s.connected).toBe(false);
    expect(s.source).toEqual({ kind: 'file', name: 'gross.txt' });
    expect(s.book.bootCount).toBe(20);
  });
});
