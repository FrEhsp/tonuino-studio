import { describe, expect, it } from 'vitest';
import {
  BootLogParser,
  analyzeBootLog,
  explainDfPlayerError,
  explainLine,
  parseBootLog,
  parseLogLine,
  splitPin,
  stripLogPrefix,
  volumesValid,
  type BootLogEvent,
  type ExplainContext,
  type LineExplanation,
} from '../../src/core/firmware/bootlog';
import { describeCard } from '../../src/core/tonuino/modes';

/** Start of a Classic box with TonUINO TNG 3.3.3, as the firmware prints it (CR LF). */
const CLASSIC_LOG =
  [
    '',
    ' _____         _____ _____ _____ _____ ',
    '|_   _|___ ___|  |  |     |   | |     |',
    '  | | | . |   |  |  |-   -| | | |  |  |',
    '  |_| |___|_|_|_____|_____|_|___|_____|',
    'TonUINO Version 3.x - refactored by Boerge1',
    '',
    'created by Thorsten Voß and licensed under GNU/GPL.',
    'Information and contribution at https://tonuino.de.',
    '',
    'V3.3.3 17.09.26',
    'C 3',
    'Ver:2',
    'Vol:25 5 15 25 5 15',
    'EQ:1',
    'ST:0',
    'IB:1',
    'AL:0',
    'AP:1111',
    'PCR:0',
    'MFRC522:146',
    'track_count: 312',
    'enter Idle',
    'Card Ins',
    'CardData: 13 37 b3 47 02 05 02 00 00 ',
    '12 tr in folder 5',
    'play 5-1',
    'enter Play',
    'btn/cmd: up/volume_up',
    'Volume: 16',
    'Card Rem',
  ].join('\r\n') + '\r\n';

/** An AiO+ whose card reader and MP3 player do not answer. */
const AIOPLUS_BROKEN_LOG = [
  'TonUINO Version 3.x - refactored by Boerge1',
  'V3.3.3 17.09.26',
  'A+ 5',
  'Ver:2',
  'Vol:20 3 10 18 2 8',
  'EQ:3',
  'ST:10',
  'IB:0',
  'AL:2',
  'AP:1231',
  'PCR:1',
  'MFRC522:0',
  'com to mfrc broken',
  'Com to DFPlayer broken',
  'track_count: 0',
  'enter Idle',
].join('\n');

/** TonUINO 2.1 prints its settings with English labels. */
const CLASSIC21_LOG = [
  'TonUINO Version 2.1',
  'created by Thorsten Voß and licensed under GNU/GPL.',
  '=== loadSettingsFromFlash()',
  'Version: 2',
  'Maximal Volume: 25',
  'Minimal Volume: 5',
  'Initial Volume: 15',
  'EQ: 1',
  'Locked: 0',
  'Sleep Timer: 0',
  'Inverted Volume Buttons: 0',
  'Admin Menu locked: 3',
  'Admin Menu Pin: 1111',
  '',
  'Com Error 6',
].join('\r\n');

const nonEmptyLines = (log: string) => log.split(/\r\n|\n/).filter((l) => l.trim() !== '');

describe('parseBootLog', () => {
  it('reads what a Classic box tells at start', () => {
    const { info, issues, bootCount } = analyzeBootLog(CLASSIC_LOG);
    expect(info).toEqual({
      firmware: 'tng',
      version: '3.3.3',
      versionDate: '2026-09-17',
      board: 'classic',
      buttons: '3',
      settings: {
        version: 2,
        speakerVolume: { max: 25, min: 5, init: 15 },
        headphoneVolume: { max: 25, min: 5, init: 15 },
        eq: 1,
        eqName: 'Normal',
        standbyTimerMinutes: 0,
        invertVolumeButtons: true,
        adminLock: { kind: 'none', raw: 0 },
        adminPin: [1, 1, 1, 1],
        pauseWhenCardRemoved: false,
      },
      rfid: { ok: true, version: 146, chip: 'MFRC522 v2.0' },
      mp3: { connected: true, trackCount: 312 },
      folderTracks: { 5: 12 },
      volume: 16,
    });
    expect(issues).toEqual([]);
    expect(bootCount).toBe(1);
  });

  it('collects the problems of an AiO+ whose parts do not answer', () => {
    const { info, issues } = analyzeBootLog(AIOPLUS_BROKEN_LOG);
    expect(info).toMatchObject({
      board: 'aioplus',
      buttons: '5',
      rfid: { ok: false, version: 0, chip: 'keine Antwort' },
      mp3: { connected: false, trackCount: 0 },
    });
    expect(info.settings).toMatchObject({
      headphoneVolume: { max: 18, min: 2, init: 8 },
      eqName: 'Rock',
      standbyTimerMinutes: 10,
      invertVolumeButtons: false,
      adminLock: { kind: 'pin', raw: 2 },
      adminPin: [1, 2, 3, 1],
      pauseWhenCardRemoved: true,
    });
    expect(issues.map((i) => [i.explanation.id, i.explanation.level, i.count])).toEqual([
      ['rfid-none', 'error', 2],
      ['mp3-broken', 'error', 1],
      ['mp3-no-files', 'error', 1],
    ]);
    expect(issues[0].line).toBe('MFRC522:0');
    expect(issues[0].explanation.fix).toContain('Stecker');
    // The AiO is no longer made and its support is not a reliable address: the forum is.
    expect(issues[1].explanation.fix).not.toContain('Leiterkartenpiraten');
    expect(issues[1].explanation.fix).toContain('TonUINO-Forum');
  });

  it('reads the settings of TonUINO 2.1', () => {
    const { info, issues } = analyzeBootLog(CLASSIC21_LOG);
    expect(info.firmware).toBe('classic21');
    expect(info.settings).toEqual({
      version: 2,
      speakerVolume: { max: 25, min: 5, init: 15 },
      eq: 1,
      eqName: 'Normal',
      standbyTimerMinutes: 0,
      invertVolumeButtons: false,
      adminLock: { kind: 'calc', raw: 3 },
      adminPin: [1, 1, 1, 1],
    });
    expect(issues.map((i) => i.explanation.id)).toEqual(['mp3-error-6']);
    expect(parseBootLog(CLASSIC21_LOG).settings.speakerVolume).toEqual({ max: 25, min: 5, init: 15 });
  });
});

describe('BootLogParser', () => {
  it('handles chunks that cut lines and characters anywhere', () => {
    const bytes = new TextEncoder().encode(CLASSIC_LOG);
    const expected = parseBootLog(CLASSIC_LOG);
    for (const size of [1, 2, 3, 7, 64]) {
      const parser = new BootLogParser();
      const lines: string[] = [];
      for (let i = 0; i < bytes.length; i += size) {
        for (const e of parser.push(bytes.subarray(i, i + size))) if (e.type === 'line') lines.push(e.line);
      }
      for (const e of parser.flush()) if (e.type === 'line') lines.push(e.line);
      expect(lines).toEqual(nonEmptyLines(CLASSIC_LOG));
      expect(parser.info).toEqual(expected);
    }
  });

  it('keeps an unfinished line until it is complete', () => {
    const parser = new BootLogParser();
    expect(parser.push('DfPl Er')).toEqual([]);
    const events = parser.push('r: 8\r');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'line', line: 'DfPl Err: 8', record: { kind: 'mp3-error', code: 8 } });
    // The LF of CR LF in the next chunk is no extra line.
    expect(parser.push('\nCard Ins\n').map((e) => e.type)).toEqual(['line']);
  });

  it('reports events to the callback and info changes as snapshots', () => {
    const seen: BootLogEvent[] = [];
    const parser = new BootLogParser({ onEvent: (e) => seen.push(e) });
    const returned = parser.push(CLASSIC_LOG);
    expect(seen).toEqual(returned);
    expect(returned.filter((e) => e.type === 'boot')).toEqual([{ type: 'boot', firmware: 'tng', unexpected: false }]);
    const infos = returned.filter((e) => e.type === 'info');
    expect(infos.length).toBeGreaterThan(10);
    const last = infos.at(-1);
    expect(last?.type === 'info' && last.info).toEqual(parser.info);
    // Snapshots do not change afterwards.
    const first = infos[0];
    expect(first.type === 'info' && first.info.version).toBeUndefined();
  });

  it('names the missing file for DFPlayer error 6', () => {
    const parser = new BootLogParser();
    parser.push(['play 5-3', 'DfPl Err: 6', 'play mp3 340', 'DfPl Err: 6', 'DfPl Err: 6', ''].join('\r\n'));
    const issues = parser.issues;
    expect(issues.map((i) => [i.explanation.id, i.count])).toEqual([
      ['mp3-error-6:05/003.mp3', 1],
      ['mp3-error-6:mp3/0340.mp3', 2],
    ]);
    expect(issues[0].explanation.fix).toContain('Prüfe Ordner 05: Gibt es dort „003.mp3“? Die Titel müssen ohne Lücke 001.mp3, 002.mp3 … heißen.');
    expect(issues[1].explanation.explanation).toBe('Die Box wollte „mp3/0340.mp3“ abspielen, aber der MP3-Player findet die Datei nicht.');
    expect(issues[1].explanation.fix).toContain('unter „Werkstatt“ und „Systemansagen“');
    // Missing announcements are fixed in the Systemansagen tool; a missing title is not.
    expect(issues.map((i) => i.explanation.fixIn)).toEqual([undefined, 'sounds']);
    expect(explainLine('DfPl Err: 6')?.fixIn).toBe('sounds');
  });

  it('names the announcement that could not be inserted (DFPlayer error 7)', () => {
    const parser = new BootLogParser();
    // Nothing plays: TNG starts 01/001.mp3 as carrier, then inserts the advert (mp3.cpp).
    parser.push(['play adv: 262', 'playFolderTrack(1,1)', 'playAdvertisement: 262', 'DfPl Err: 7', ''].join('\r\n'));
    const [issue] = parser.issues;
    expect(issue.explanation).toMatchObject({ id: 'mp3-error-7:advert/0262.mp3', level: 'warn', title: 'Ansage nicht eingeblendet' });
    expect(issue.explanation.explanation).toContain('Zuletzt angefragt: „advert/0262.mp3“.');
    expect(issue.explanation.fix).toContain('„01“ mit „001.mp3“');
    expect(issue.explanation.fixIn).toBe('sounds');
    // A missing carrier track shows up as error 6 for 01/001.mp3.
    expect(explainLine('DfPl Err: 6', { lastFile: '01/001.mp3' })?.id).toBe('mp3-error-6:01/001.mp3');
  });

  it('notices a box that restarts by itself', () => {
    const parser = new BootLogParser();
    const events = parser.push(CLASSIC_LOG + 'DfPl Err: 3\r\n' + CLASSIC_LOG);
    expect(events.filter((e) => e.type === 'boot').map((e) => e.type === 'boot' && e.unexpected)).toEqual([false, true]);
    expect(parser.bootCount).toBe(2);
    expect(parser.issues.map((i) => i.explanation.id)).toEqual(['reboot']);
    expect(parser.issues[0].explanation.title).toBe('Die Box ist neu gestartet');
    expect(parser.info.version).toBe('3.3.3');

    parser.reset();
    const again = parser.push(CLASSIC_LOG);
    expect(again.find((e) => e.type === 'boot')).toEqual({ type: 'boot', firmware: 'tng', unexpected: false });
    expect(parser.issues).toEqual([]);
  });

  it('reports unreadable characters once per streak, not for a single line of noise', () => {
    const parser = new BootLogParser();
    const noise = Uint8Array.of(0xf0, 0x80, 0x1f, 0xfe, 0x83, 0x12, 0x99, 0x0a);
    const first = parser.push(noise);
    expect(first[0]).toMatchObject({ record: { kind: 'garbled' }, explanation: null });
    const second = parser.push(noise);
    expect(second[0]).toMatchObject({ explanation: { id: 'garbled', level: 'warn' } });
    expect(parser.push(noise)[0]).toMatchObject({ explanation: null });
    expect(parser.issues.map((i) => [i.explanation.id, i.count])).toEqual([['garbled', 1]]);
  });

  it('reads the ESP32 web console with its <pre> lines and timestamps', () => {
    const parser = new BootLogParser();
    const events = parser.push('<pre>[000 00.012] V3.3.3 17.09.26</pre><pre>[000 00.013] ESP32 Nano 5</pre>');
    expect(events.filter((e) => e.type === 'line').map((e) => e.type === 'line' && e.line)).toEqual([
      '[000 00.012] V3.3.3 17.09.26',
      '[000 00.013] ESP32 Nano 5',
    ]);
    expect(parser.info).toMatchObject({ version: '3.3.3', board: 'esp32nano', buttons: '5' });
    expect(explainLine('<pre>[000 01.234] DfPl Err: 8</pre>')?.id).toBe('mp3-error-8');
  });

  it('cuts endless lines', () => {
    const parser = new BootLogParser({ maxLineLength: 100 });
    const events = parser.push('x'.repeat(250));
    expect(events.map((e) => (e.type === 'line' ? e.line.length : 0))).toEqual([100, 100]);
    expect(parser.flush().map((e) => (e.type === 'line' ? e.line.length : 0))).toEqual([50]);
  });
});

describe('explainLine', () => {
  const cases: [string, ExplainContext, Partial<LineExplanation> | null][] = [
    ['Com to DFPlayer broken', { board: 'classic' }, { id: 'mp3-broken', level: 'error', title: 'Keine Verbindung zum MP3-Player' }],
    ['missing OnPlayFinished', { board: 'classic' }, { id: 'missing-finished', level: 'warn' }],
    ['0 tr in folder 7', {}, { level: 'warn', title: 'Ordner 07 ist leer oder fehlt' }],
    ['12 tr in folder 7', {}, { level: 'info', title: 'Ordner 07: 12 Titel' }],
    ['bad ver 3', {}, { id: 'card-bad-version', level: 'warn' }],
    ['BatVoltage empty', {}, { level: 'warn', title: 'Akku leer' }],
    ['clEEPROM', {}, { level: 'warn', title: 'Einstellungen gelöscht' }],
    ['MFRC522:18', {}, { id: 'rfid-counterfeit', level: 'warn' }],
    ['MFRC522:136', {}, { id: 'rfid-ok', level: 'info' }],
    ['MFRC522:255', {}, { id: 'rfid-none', level: 'error' }],
    ['MFRC522:42', {}, { id: 'rfid-unknown', level: 'warn' }],
    ['Auth  failed: 3', {}, { id: 'card-auth', level: 'warn' }],
    ['MIFARE_Read  failed: 2', {}, { id: 'card-read', level: 'warn' }],
    ['MIFARE_Read 3 failed: 3', {}, null],
    ['MIFARE_Write  failed: 255', {}, { id: 'card-write', level: 'error' }],
    ['numA: 3', {}, { id: 'quiz-error', level: 'error', explanation: 'Die Karte verlangt 3 Antworten. Erlaubt sind 0, 2 oder 4.' }],
    ['Connected to WiFi Zuhause with IP: 192.168.1.50', {}, { id: 'wifi', level: 'info' }],
    ['Not connected to WiFi Zuhause, starting AP TonUINO', {}, { id: 'wifi-failed', level: 'warn' }],
    ['Failed to write chunked data to free space', {}, { id: 'ota-error', level: 'error' }],
    ['OTA finished, Rebooting ESP32...', {}, { id: 'ota-done', level: 'info', title: 'Update fertig' }],
    ['static ip failed to configure', {}, { id: 'wifi-static-ip', level: 'warn' }],
    ['Not connected to WiFi , starting AP TonUINO', {}, { id: 'wifi-ap', level: 'info' }],
    ['AP IP address: 192.168.4.1', {}, { id: 'wifi-ap', explanation: 'Verbinde dich mit dem WLAN „TonUINO“. Dann erreichst du die Box unter http://192.168.4.1.' }],
    ['[000 12.345] DfPl Err: 8', {}, { id: 'mp3-error-8', level: 'error', title: 'SD-Karte nicht lesbar' }],
    ['12:34:56.789 -> MFRC522:146', {}, { id: 'rfid-ok', explanation: 'Der Kartenleser antwortet (MFRC522 v2.0).' }],
    ['DfPl Err: 129', {}, { level: 'warn', title: 'MP3-Player antwortet nicht' }],
    ['btn/cmd: up/next', {}, { title: 'Taste: Vor kurz', explanation: 'Die Box führt aus: nächster Titel.' }],
    ['enter Idle', {}, { title: 'Bereit' }],
    ['enter ChMode', {}, null],
    ['act. sleepTimer', {}, { title: 'Spezialkarte: Schlummerkarte' }],
    ['modifier removed', {}, { title: 'Spezialkarte aufgehoben' }],
    ['Ver:2', {}, null],
    ['Hallo Welt', {}, null],
    ['', {}, null],
    ['AP:0255255255', { settings: { adminLock: { kind: 'none', raw: 0 } } }, { level: 'info' }],
    ['AP:0255255255', {}, { level: 'warn', title: 'Admin-PIN lässt sich nicht eingeben' }],
    ['AP:1231', {}, { level: 'info', explanation: 'PIN: Play/Pause, Vor, Zurück, Play/Pause.' }],
    ['AL:2', {}, { level: 'info', explanation: 'Das Admin-Menü ist mit einer PIN gesperrt.' }],
    ['Vol:25 30 15 25 5 15', {}, { id: 'setting-Vol', level: 'warn', title: 'Ungültige Einstellung: Lautstärke' }],
    ['EQ:9', {}, { level: 'warn' }],
    ['ST:30', {}, { explanation: 'Die Box schaltet sich nach 30 Minuten ohne Musik von selbst ab.' }],
    ['V3.3.3 17.09.26', {}, { id: 'version', title: 'TonUINO TNG 3.3.3 vom 17.09.2026' }],
    ['A+ 5', {}, { id: 'hardware', title: 'Platine: AiO+, 5 Tasten' }],
    ['TonUINO Version 2.1', {}, { id: 'boot', title: 'Die Box startet (TonUINO 2.1)' }],
    ['CardData: 00 00 00 00 00 00 00 00 00 ', {}, { id: 'card-empty', title: 'Leere Karte' }],
    ['CardData: de ad be ef 01 02 03 04 05 ', {}, { id: 'card-foreign', level: 'warn' }],
    ['CardData: 13 37 b3 47 05 01 01 00 00 ', {}, null],
  ];

  it.each(cases)('%s', (line, ctx, expected) => {
    const result = explainLine(line, ctx);
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatchObject(expected);
  });

  it('gives wiring hints that fit the board', () => {
    expect(explainLine('Com to DFPlayer broken', { board: 'classic' })?.fix).toContain('D3 über einen 1-kΩ-Widerstand an RX');
    expect(explainLine('Com to DFPlayer broken', { board: 'aio' })?.fix).toContain('sitzt auf der Platine');
    expect(explainLine('missing OnPlayFinished', { board: 'classic' })?.fix).toContain('BUSY');
    expect(explainLine('com to mfrc broken', { board: 'classic' })?.fix).toContain('RST an D9, SDA an D10');
    expect(explainLine('com to mfrc broken', { board: 'classic' })?.fix).toContain('3V3-Pin');
    // Nano Every and Nano ESP32 use the Classic pins (constants.hpp).
    expect(explainLine('Com to DFPlayer broken', { board: 'every' })?.fix).toContain('D2 an TX');
    expect(explainLine('com to mfrc broken', { board: 'esp32nano' })?.fix).toContain('SCK an D13');
    expect(explainLine('missing OnPlayFinished', { board: 'every4808' })?.fix).toContain('BUSY');
    expect(explainLine('missing OnPlayFinished', { board: 'aioplus' })?.fix).toContain('3.3.3');
    expect(explainLine('Auth  failed: 3')?.explanation).toContain('Zeitüberschreitung, Code 3');
  });

  it('warns an AiO whose Ausschalt-Timer is off and points to „Box einstellen“', () => {
    const sentence = 'Die Box schaltet sich nie selbst aus. Stelle den Ausschalt-Timer unter „Box einstellen“ ein.';
    for (const board of ['aio', 'aioplus'] as const) {
      const x = explainLine('ST:0', { board })!;
      expect(x).toMatchObject({ level: 'warn', fixIn: 'settings' });
      expect(`${x.explanation} ${x.fix}`).toBe(sentence);
    }
    // A Classic sleeps or hangs on its switch: the timer being off is no problem there.
    const classic = explainLine('ST:0', { board: 'classic' })!;
    expect(classic.level).toBe('info');
    expect(`${classic.explanation} ${classic.fix ?? ''}`).not.toContain('„Box einstellen“');
    expect(explainLine('ST:30', { board: 'aio' })?.level).toBe('info');
    // The whole log of an AiO+ with the factory timer shows it as an issue with the way to fix it.
    const aioLog = CLASSIC_LOG.replace('C 3', 'A+ 5');
    const issue = analyzeBootLog(aioLog).issues.find((i) => i.explanation.id === 'setting-ST');
    expect(issue?.explanation.fixIn).toBe('settings');
    expect(analyzeBootLog(CLASSIC_LOG).issues).toEqual([]);
  });

  it('mentions the web page of ESP32 boxes and links a reset to „Box einstellen“', () => {
    expect(explainLine('ST:15', { board: 'esp32nano' })?.explanation).toContain('Das geht auch auf der Webseite der Box.');
    expect(explainLine('ST:0', { board: 'esp32wroom' })?.explanation).toContain('„Box einstellen“');
    expect(explainLine('ST:15', { board: 'classic' })?.explanation).not.toContain('Webseite');
    const invalid = explainLine('EQ:9')!;
    expect(invalid.fix).toContain('unter „Box einstellen“ neu ein');
    expect(invalid.fixIn).toBe('settings');
    // „Box einstellen“ would start by asking for that very PIN: the reset at power-on is the way in.
    const pin = explainLine('AP:0255255255')!;
    expect(pin.title).toBe('Admin-PIN lässt sich nicht eingeben');
    expect(pin.fixIn).toBeUndefined();
    expect(pin.fix).toContain('beim Einschalten');
  });

  it('reads the date in the TNG version line and warns about the test build of 16.10.2026', () => {
    expect(explainLine('V3.3.3 25.02.26')?.explanation).toContain('Release vom 25.02.2026');
    expect(explainLine('V3.3.3 17.09.26')).toMatchObject({ id: 'version', level: 'info', explanation: 'Diese Firmware-Version läuft auf der Box: Release vom 17.09.2026.' });
    const preview = explainLine('V3.3.3 16.10.26')!;
    expect(preview).toMatchObject({ id: 'version-preview', level: 'warn', title: 'TonUINO TNG 3.3.3 vom 16.10.2026 (Testversion)' });
    expect(preview.fix).toContain('Release vom 17.09.2026');
    expect(analyzeBootLog('TonUINO Version 3.3.3\nV3.3.3 16.10.26\n').info.versionDate).toBe('2026-10-16');
  });

  it('describes a TonUINO card in plain German', () => {
    const result = explainLine('CardData: 13 37 b3 47 02 05 02 00 00 ');
    expect(result).toMatchObject({ id: 'card-tonuino', level: 'info', title: 'Karte gelesen' });
    expect(result?.explanation).toBe(describeCard({ version: 2, folder: 5, mode: 2, special: 0, special2: 0 }));
  });

  it('names the folder of a card the box reads, and says plainly when a card is empty or the admin card', () => {
    const titles = (n: number) => (n === 5 ? 'Die Olchis' : undefined);
    expect(explainLine('CardData: 13 37 b3 47 02 05 05 00 00 ', { folderTitle: titles })?.explanation).toBe('Hörbuch: Ordner 05 („Die Olchis“).');
    expect(explainLine('CardData: 13 37 b3 47 02 06 05 00 00 ', { folderTitle: titles })?.explanation).toBe('Hörbuch: Ordner 06.');
    expect(explainLine('CardData: 00 00 00 00 00 00 00 00 00 ')).toMatchObject({ id: 'card-empty', title: 'Leere Karte' });
    expect(explainLine('CardData: 13 37 b3 47 02 00 ff 00 00 ')).toMatchObject({ title: 'Admin-Karte gelesen', explanation: 'Admin-Karte: öffnet das Admin-Menü der Box.' });
  });

  it('explains every DFPlayer error code', () => {
    const levels = new Map([
      [5, 'error'],
      [6, 'error'],
      [8, 'error'],
      [10, 'info'],
    ]);
    for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 129, 130, 131, 132, 255, 42]) {
      const e = explainDfPlayerError(code);
      expect(e.id).toBe(`mp3-error-${code}`);
      expect(e.level).toBe(levels.get(code) ?? 'warn');
      expect(e.title.length).toBeGreaterThan(5);
    }
    expect(explainDfPlayerError(42).explanation).toContain('Fehler 42');
    expect(explainDfPlayerError(6).explanation).toBe('Der MP3-Player findet eine Datei nicht, die er abspielen soll.');
  });
});

describe('log line helpers', () => {
  it('parses lines into records', () => {
    expect(parseLogLine('play 5-12')).toEqual({ kind: 'play', folder: 5, track: 12 });
    expect(parseLogLine('Com Error 3')).toEqual({ kind: 'mp3-error', code: 3 });
    expect(parseLogLine('hpJackDetect: 1')).toEqual({ kind: 'headphones', plugged: true });
    expect(parseLogLine('ESP32 Wroom 32 3x3')).toEqual({ kind: 'hardware', board: 'esp32wroom', buttons: '3x3' });
    expect(parseLogLine('\u0000�TonUINO Version 3.x - refactored by Boerge1')).toEqual({ kind: 'banner', firmware: 'tng' });
    expect(parseLogLine('Minimal Volume: 5')).toMatchObject({ kind: 'setting', patch: {}, volumePart: { field: 'min', value: 5 } });
  });

  it('removes timestamps of terminals', () => {
    expect(stripLogPrefix('[000 01.234] Card Ins')).toBe('Card Ins');
    expect(stripLogPrefix('12:34:56.789 -> Card Ins')).toBe('Card Ins');
    expect(stripLogPrefix('[12:34:56.789] Card Ins')).toBe('Card Ins');
    expect(stripLogPrefix('[12:34:56] Card Ins')).toBe('Card Ins');
    expect(stripLogPrefix('  Card Ins \r')).toBe('Card Ins');
  });

  it('splits the PIN digits only when the split is unique', () => {
    expect(splitPin('1111')).toEqual([1, 1, 1, 1]);
    expect(splitPin('1213')).toEqual([1, 2, 1, 3]);
    expect(splitPin('0255255255')).toEqual([0, 255, 255, 255]);
    expect(splitPin('12311')).toBeNull();
    expect(splitPin('123')).toBeNull();
  });

  it('checks volume levels', () => {
    expect(volumesValid({ max: 25, min: 5, init: 15 })).toBe(true);
    expect(volumesValid({ max: 25, min: 30, init: 15 })).toBe(false);
    expect(volumesValid({ max: 31, min: 0, init: 0 })).toBe(false);
  });
});

describe('end check: rebuild and battery warning', () => {
  it('offers the rebuild for an empty card, an empty folder and a missing end of track', () => {
    for (const line of ['track_count: 0', '0 tr in folder 5', 'missing OnPlayFinished']) {
      const x = explainLine(line);
      expect(x?.fixIn, line).toBe('rebuild');
      expect(x?.fix, line).toContain('neu auf');
      expect(x?.fix, line).toContain('Ordnernummern bleiben gleich');
    }
    // An empty card: put the folders back; a card with folders: format it right (FAT32, at most 32 GB).
    expect(explainLine('track_count: 0')?.fix).toContain('Ist sie leer, spiele deine Ordner');
    expect(explainLine('track_count: 0')?.fix).toContain('FAT32');
    // The rebuild text holds for the Paket route too: it does not say the app writes the card itself.
    expect(explainLine('track_count: 0')?.fix).not.toContain('die App spielt alles');
    // A folder with tracks and other lines get no button.
    expect(explainLine('12 tr in folder 5')?.fixIn).toBeUndefined();
    expect(explainLine('DfPl Err: 6')?.fixIn).toBe('sounds');
  });

  it('the rebuild issue keeps its button in the issue list', () => {
    const { issues } = analyzeBootLog(['TonUINO Version 3.x - refactored by Boerge1', 'track_count: 0', 'missing OnPlayFinished'].join('\n'));
    expect(issues.map((i) => [i.explanation.id, i.explanation.fixIn])).toEqual([
      ['mp3-no-files', 'rebuild'],
      ['missing-finished', 'rebuild'],
    ]);
  });

  it('reads the battery voltage lines', () => {
    expect(parseLogLine('BatVoltage: 2.86')).toEqual({ kind: 'battery-voltage', volts: 2.86, low: false });
    expect(parseLogLine('BatVoltage low 2.86')).toEqual({ kind: 'battery-voltage', volts: 2.86, low: true });
    expect(parseLogLine('BatVoltage empty')).toEqual({ kind: 'battery-empty' });
    // A plain measurement needs no comment.
    expect(explainLine('BatVoltage: 3.9')).toBeNull();
  });

  it('"play adv: 262" after a battery reading is the low battery warning (forum 14944)', () => {
    const { issues } = analyzeBootLog(['TonUINO Version 3.x - refactored by Boerge1', 'BatVoltage: 2.86', 'play adv: 262', 'BatVoltage: 2.87', 'play adv: 262'].join('\n'));
    expect(issues).toHaveLength(1);
    expect(issues[0].count).toBe(2);
    expect(issues[0].explanation).toMatchObject({ id: 'battery-low', level: 'warn', title: 'Akku fast leer' });
    // The merged issue names the last voltage, not the first one.
    expect(issues[0].explanation.explanation).toContain('2,87 Volt');
    expect(issues[0].explanation.fix).toContain('Lade den Akku');
    expect(explainLine('BatVoltage low 2.86')?.id).toBe('battery-low');
  });

  it('"play adv: 262" with a healthy voltage is no battery warning (Jukebox queue full, modifier.cpp)', () => {
    for (const volts of ['4.10', '4.12', '3.70', '3.41']) {
      const { issues } = analyzeBootLog(['TonUINO Version 3.x - refactored by Boerge1', `BatVoltage: ${volts}`, 'play adv: 262'].join('\n'));
      expect(issues.map((i) => i.explanation.id), volts).not.toContain('battery-low');
    }
    // A "low" line counts whatever the number; at or below the highest TNG threshold the box is warning.
    for (const line of ['BatVoltage low 3.60', 'BatVoltage: 3.40', 'BatVoltage: 2.95']) {
      const { issues } = analyzeBootLog(['TonUINO Version 3.x - refactored by Boerge1', line, 'play adv: 262'].join('\n'));
      expect(issues.map((i) => i.explanation.id), line).toContain('battery-low');
    }
    // A full battery after a low one: the pling is no longer the warning.
    const { issues } = analyzeBootLog(['TonUINO Version 3.x - refactored by Boerge1', 'BatVoltage low 2.86', 'BatVoltage: 4.10', 'play adv: 262'].join('\n'));
    expect(issues.find((i) => i.explanation.id === 'battery-low')?.count).toBe(1);
  });

  it('"play adv: 262" without battery readings stays a plain announcement (Jukebox full, Spezialkarten)', () => {
    const { issues } = analyzeBootLog(['TonUINO Version 3.x - refactored by Boerge1', 'play adv: 262'].join('\n'));
    expect(issues).toHaveLength(0);
    expect(explainLine('play adv: 262')).toMatchObject({ id: 'play-advert', level: 'info' });
  });

  it('a new start forgets the voltage of the last one', () => {
    const p = new BootLogParser();
    p.push('TonUINO Version 3.x - refactored by Boerge1\nBatVoltage: 2.86\nTonUINO Version 3.x - refactored by Boerge1\nplay adv: 262\n');
    expect(p.issues.map((i) => i.explanation.id)).not.toContain('battery-low');
  });
});
