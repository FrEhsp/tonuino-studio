/**
 * Turns one line of the TonUINO serial log (115200 baud) into a typed record.
 *
 * Formats come from the LOG(...) calls of TonUINO-TNG V3.3.3:
 * TonUINO-TNG.ino (banner, version, board), settings.cpp (Ver/Vol/EQ/ST/IB/
 * AL/AP/PCR), chip_card.cpp (MFRC522, card data and errors), mp3.cpp
 * (DfPl Err, track_count, missing OnPlayFinished, play …), tonuino.cpp
 * ("tr in folder", standby), commands.cpp (btn/cmd), batVoltage.cpp,
 * state_machine.cpp and webservice.cpp (ESP32). Lines of TonUINO 2.1 are
 * recognised on a best-effort basis (banner, settings, "Com Error").
 */
import type { BoardId } from './variants';

export type FirmwareFamily = 'tng' | 'classic21';
export type BoxButtons = '3' | '5' | '3x3';

export interface VolumeLevels {
  max: number;
  min: number;
  init: number;
}

/** none = open, card = only with the admin card, pin = four-key PIN, calc = arithmetic task (TonUINO 2.1). */
export type AdminLockKind = 'none' | 'card' | 'pin' | 'calc' | 'unknown';

export interface BoxSettings {
  /** Layout version of the settings block in EEPROM ("Ver:", TNG: 2). */
  version?: number;
  speakerVolume?: VolumeLevels;
  /** Separate headphone volumes (TNG 3.1.7 and later). */
  headphoneVolume?: VolumeLevels;
  /** 1..6 as stored by the firmware. */
  eq?: number;
  eqName?: string;
  /** Minutes until the box switches itself off when nothing plays; 0 = never. */
  standbyTimerMinutes?: number;
  /** 3 buttons: short press changes the volume, long press skips (TNG default). No effect with 5 buttons. */
  invertVolumeButtons?: boolean;
  adminLock?: { kind: AdminLockKind; raw: number };
  /** Key codes: 1 = Play/Pause, 2 = Vor, 3 = Zurück. null when the logged digits cannot be split. */
  adminPin?: number[] | null;
  pauseWhenCardRemoved?: boolean;
}

export type LogRecord =
  | { kind: 'banner'; firmware: FirmwareFamily }
  | { kind: 'version'; version: string; date?: string }
  | { kind: 'hardware'; board: BoardId; buttons: BoxButtons }
  | SettingRecord
  | { kind: 'rfid-version'; version: number }
  | { kind: 'rfid-broken' }
  | { kind: 'mp3-broken' }
  | { kind: 'track-count'; count: number }
  | { kind: 'mp3-error'; code: number }
  | { kind: 'folder-tracks'; folder: number; count: number }
  | { kind: 'missing-finished' }
  | { kind: 'play'; folder: number; track: number }
  | { kind: 'play-mp3'; track: number }
  | { kind: 'play-advert'; track: number }
  | { kind: 'card'; event: 'inserted' | 'removed' }
  | { kind: 'card-data'; bytes: number[] }
  | { kind: 'card-bad-version'; version: number }
  | { kind: 'card-error'; op: 'auth' | 'read' | 'write'; status: number }
  | { kind: 'card-type'; type: string }
  | { kind: 'card-written' }
  | { kind: 'batch-card'; index: number }
  | { kind: 'modifier'; action: 'on' | 'off' | 'toggle'; name: string }
  | { kind: 'button'; raw: string; command: string }
  | { kind: 'button3x3'; index: number }
  | { kind: 'state'; state: string }
  | { kind: 'abort' }
  | { kind: 'volume'; volume: number }
  | { kind: 'headphones'; plugged: boolean }
  | { kind: 'standby'; event: 'started' | 'stopped' | 'power-off' }
  | { kind: 'battery-empty' }
  /** batVoltage.cpp logs the measured voltage every 2 s ("BatVoltage: 2.86"); some builds write "BatVoltage low 2.86". */
  | { kind: 'battery-voltage'; volts: number; low: boolean }
  | { kind: 'settings-cleared' }
  | { kind: 'eeprom-failed'; op: 'begin' | 'commit' }
  | { kind: 'quiz-error'; field: 'answers' | 'solution'; value: number }
  | { kind: 'wifi'; mode: 'station' | 'access-point'; ssid?: string; ip?: string }
  | { kind: 'wifi-static-ip-failed' }
  | { kind: 'ota-done' }
  | { kind: 'ota-error'; text: string }
  | { kind: 'garbled' };

export interface SettingRecord {
  kind: 'setting';
  /** Label as printed: "Vol", "AL", … (TNG) or "Maximal Volume", … (TonUINO 2.1). */
  key: string;
  value: string;
  /** What this line says about the settings. Empty when the value cannot be used. */
  patch: BoxSettings;
  /** The value is out of range or cannot be read. */
  invalid?: boolean;
  /** TonUINO 2.1 prints the three speaker volumes on separate lines. */
  volumePart?: { field: keyof VolumeLevels; value: number };
}

export const EQ_NAMES = ['Normal', 'Pop', 'Rock', 'Jazz', 'Klassik', 'Bass'] as const;

/** Control characters and U+FFFD that a reset leaves in front of the first line. */
const LEADING_NOISE = /^[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufffd]+\s*/;

const HARDWARE: Record<string, BoardId> = {
  C: 'classic',
  E: 'every',
  EC: 'every4808',
  A: 'aio',
  'A+': 'aioplus',
  'ESP32 Nano': 'esp32nano',
  'ESP32 Wroom 32': 'esp32wroom',
};

/**
 * Removes what terminals put around a line: the <pre> wrapper and the
 * timestamp of the ESP32 web console ("[000 01.234] "), the time of the
 * Box-Logbuch and of terminal programs ("[12:34:56.789] ") and the timestamp
 * of the Arduino IDE serial monitor ("12:34:56.789 -> "). Also trims.
 */
export function stripLogPrefix(line: string): string {
  return line
    .replace(/^\s*<pre>/, '')
    .replace(/<\/pre>\s*$/, '')
    .replace(/^\s*\[\d{2,3} \d{2}\.\d{3}\]\s?/, '')
    .replace(/^\s*\[\d{2}:\d{2}:\d{2}(?:\.\d{3})?\]\s?/, '')
    .replace(/^\s*\d{1,2}:\d{2}:\d{2}\.\d{3}\s*-?>\s?/, '')
    .trim();
}

/** True for lines that look like noise, typically a wrong baud rate. */
export function isGarbled(line: string): boolean {
  if (line.length < 4) return false;
  let bad = 0;
  let total = 0;
  for (const ch of line) {
    const c = ch.codePointAt(0) ?? 0;
    total++;
    if (c === 0xfffd || (c < 0x20 && c !== 0x09) || (c >= 0x7f && c < 0xa0)) bad++;
  }
  return bad / total > 0.25;
}

/** Parses one log line. Returns null for lines without diagnostic value. */
export function parseLogLine(rawLine: string): LogRecord | null {
  const line = stripLogPrefix(rawLine);
  if (line === '') return null;
  if (isGarbled(line)) return { kind: 'garbled' };
  const s = line.replace(LEADING_NOISE, '');
  let m: RegExpMatchArray | null;

  // ---- boot
  if ((m = s.match(/^TonUINO Version (\d+)/))) return { kind: 'banner', firmware: Number(m[1]) >= 3 ? 'tng' : 'classic21' };
  if ((m = s.match(/^V(\d+\.\d+(?:\.\d+)?)(?:\s+(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4}))?$/))) {
    const rec: LogRecord = { kind: 'version', version: m[1] };
    if (m[2]) {
      const year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
      rec.date = `${year}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    return rec;
  }
  if ((m = s.match(/^(ESP32 Wroom 32|ESP32 Nano|A\+|EC|A|C|E) (3x3|3|5)$/))) {
    return { kind: 'hardware', board: HARDWARE[m[1]], buttons: m[2] as BoxButtons };
  }

  // ---- settings
  if ((m = s.match(/^(Ver|Vol|EQ|ST|IB|AL|AP|PCR):\s*(.*)$/))) return tngSetting(m[1], m[2].trim());
  if ((m = s.match(/^(Version|Maximal Volume|Minimal Volume|Initial Volume|Sleep Timer|Inverted Volume Buttons|Admin Menu locked|Admin Menu Pin):\s*(.*)$/))) {
    return classicSetting(m[1], m[2].trim());
  }

  // ---- hardware diagnostics
  if ((m = s.match(/^MFRC522:\s*(\d+)$/))) return { kind: 'rfid-version', version: Number(m[1]) };
  if (/^com to mfrc broken$/i.test(s)) return { kind: 'rfid-broken' };
  if (/^com to dfplayer broken$/i.test(s)) return { kind: 'mp3-broken' };
  if ((m = s.match(/^track_count:\s*(\d+)$/))) return { kind: 'track-count', count: Number(m[1]) };
  if ((m = s.match(/^(?:DfPl Err|Com Error):?\s*(\d+)$/))) return { kind: 'mp3-error', code: Number(m[1]) };
  if ((m = s.match(/^(\d+) tr in folder (\d+)$/))) return { kind: 'folder-tracks', count: Number(m[1]), folder: Number(m[2]) };
  if (/^missing OnPlayFinished$/.test(s)) return { kind: 'missing-finished' };
  if (/^BatVoltage empty$/.test(s)) return { kind: 'battery-empty' };
  if ((m = s.match(/^BatVoltage(:|\s+low:?)\s*(\d+(?:[.,]\d+)?)$/))) {
    return { kind: 'battery-voltage', volts: Number(m[2].replace(',', '.')), low: m[1] !== ':' };
  }
  if (/^clEEPROM$/.test(s)) return { kind: 'settings-cleared' };
  if ((m = s.match(/^EEPROM (begin|commit):\s*0$/))) return { kind: 'eeprom-failed', op: m[1] as 'begin' | 'commit' };

  // ---- playback
  if ((m = s.match(/^play mp3 (\d+)$/))) return { kind: 'play-mp3', track: Number(m[1]) };
  if ((m = s.match(/^(?:play adv:|playAdvertisement:)\s*(\d+)$/))) return { kind: 'play-advert', track: Number(m[1]) };
  if ((m = s.match(/^play (\d+)-(\d+)$/))) return { kind: 'play', folder: Number(m[1]), track: Number(m[2]) };
  if (/^playFolderTrack\(1,1\)$/.test(s)) return { kind: 'play', folder: 1, track: 1 };
  if ((m = s.match(/^Volume:\s*(\d+)$/))) return { kind: 'volume', volume: Number(m[1]) };
  if ((m = s.match(/^hpJackDetect:\s*([01])$/))) return { kind: 'headphones', plugged: m[1] === '1' };
  if (/^timer started$/.test(s)) return { kind: 'standby', event: 'started' };
  if (/^timer stopped$/.test(s)) return { kind: 'standby', event: 'stopped' };
  if (/^power off!$/.test(s)) return { kind: 'standby', event: 'power-off' };

  // ---- cards
  if (/^Card Ins$/.test(s)) return { kind: 'card', event: 'inserted' };
  if (/^Card Rem$/.test(s)) return { kind: 'card', event: 'removed' };
  if ((m = s.match(/^CardData:\s*((?:[0-9a-fA-F]{2}\s*)+)$/))) {
    return { kind: 'card-data', bytes: m[1].trim().split(/\s+/).map((h) => parseInt(h, 16)) };
  }
  if ((m = s.match(/^bad ver (\d+)$/))) return { kind: 'card-bad-version', version: Number(m[1]) };
  if ((m = s.match(/^Auth\s+failed:\s*(\d+)$/))) return { kind: 'card-error', op: 'auth', status: Number(m[1]) };
  // With a block number it is one of the probing reads (NTAG type check), not the final failure.
  if (/^MIFARE_Read\s+\d+\s+failed:/.test(s)) return null;
  if ((m = s.match(/^MIFARE_Read\s+failed:\s*(\d+)$/))) return { kind: 'card-error', op: 'read', status: Number(m[1]) };
  if ((m = s.match(/^MIFARE_Write\s+(?:\d+\s+)?failed:\s*(\d+)$/))) return { kind: 'card-error', op: 'write', status: Number(m[1]) };
  if ((m = s.match(/^NTAG(213|215|216)$/))) return { kind: 'card-type', type: `NTAG${m[1]}` };
  if ((m = s.match(/^NTAG\?-(\d+)$/))) return { kind: 'card-type', type: `NTAG? (${m[1]})` };
  if (/^WriteC -> finished$/.test(s)) return { kind: 'card-written' };
  if ((m = s.match(/^(\d+)-te Karte auflegen$/))) return { kind: 'batch-card', index: Number(m[1]) };
  if ((m = s.match(/^act\. (\w+)$/))) return { kind: 'modifier', action: 'on', name: m[1] };
  if (/^modifier removed$/.test(s)) return { kind: 'modifier', action: 'off', name: '' };
  if ((m = s.match(/^toggle (bt module|std timer|endless) from [01]$/))) return { kind: 'modifier', action: 'toggle', name: m[1] };

  // ---- buttons and states
  if ((m = s.match(/^btn\/cmd:\s*(\w+)\/(\w+)$/))) return { kind: 'button', raw: m[1], command: m[2] };
  if ((m = s.match(/^btn3x3:\s*(\d+)$/))) return { kind: 'button3x3', index: Number(m[1]) };
  if ((m = s.match(/^enter ([A-Za-z]+)\d*$/))) return { kind: 'state', state: m[1] };
  if (/^\w+ abort$/.test(s)) return { kind: 'abort' };
  if ((m = s.match(/^num([AS]):\s*(\d+)$/))) return { kind: 'quiz-error', field: m[1] === 'A' ? 'answers' : 'solution', value: Number(m[2]) };

  // ---- ESP32 web service
  if ((m = s.match(/^Connected to WiFi (.*) with IP: ([\d.]+)$/))) return { kind: 'wifi', mode: 'station', ssid: m[1], ip: m[2] };
  if ((m = s.match(/^Not connected to WiFi (.*), starting AP TonUINO$/))) return { kind: 'wifi', mode: 'access-point', ssid: m[1] };
  if ((m = s.match(/^AP IP address: ([\d.]+)$/))) return { kind: 'wifi', mode: 'access-point', ip: m[1] };
  if (/^static ip failed to configure$/.test(s)) return { kind: 'wifi-static-ip-failed' };
  if (/^OTA finished, Rebooting ESP32/.test(s)) return { kind: 'ota-done' };
  if (/^Failed to (start update process|write chunked data|end update process)/.test(s)) return { kind: 'ota-error', text: s };

  return null;
}

function int(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function setting(key: string, value: string, patch: BoxSettings, invalid = false): SettingRecord {
  const rec: SettingRecord = { kind: 'setting', key, value, patch };
  if (invalid) rec.invalid = true;
  return rec;
}

function tngSetting(key: string, value: string): SettingRecord {
  const n = int(value);
  switch (key) {
    case 'Ver':
      return setting(key, value, n === undefined ? {} : { version: n }, n === undefined);
    case 'Vol': {
      const v = value.split(/\s+/).map(Number);
      if ((v.length !== 3 && v.length !== 6) || v.some((x) => !Number.isInteger(x))) return setting(key, value, {}, true);
      const patch: BoxSettings = { speakerVolume: { max: v[0], min: v[1], init: v[2] } };
      if (v.length === 6) patch.headphoneVolume = { max: v[3], min: v[4], init: v[5] };
      const bad = [patch.speakerVolume, patch.headphoneVolume].some((l) => l && !volumesValid(l));
      return setting(key, value, patch, bad);
    }
    case 'EQ':
      return eqSetting(key, value, n);
    case 'ST':
      return setting(key, value, n === undefined ? {} : { standbyTimerMinutes: n }, n === undefined);
    case 'IB':
      return setting(key, value, n === 0 || n === 1 ? { invertVolumeButtons: n === 1 } : {}, n !== 0 && n !== 1);
    case 'AL':
      return lockSetting(key, value, n, false);
    case 'AP': {
      const pin = /^\d+$/.test(value) ? splitPin(value) : null;
      return setting(key, value, { adminPin: pin }, !pin || pin.some((d) => d < 1 || d > 3));
    }
    case 'PCR':
      return setting(key, value, n === 0 || n === 1 ? { pauseWhenCardRemoved: n === 1 } : {}, n !== 0 && n !== 1);
  }
  return setting(key, value, {}, true);
}

/** TonUINO 2.1 prints one setting per line with English labels. */
function classicSetting(key: string, value: string): SettingRecord {
  const n = int(value);
  if (n === undefined) return key === 'Admin Menu Pin' ? setting(key, value, { adminPin: null }, true) : setting(key, value, {}, true);
  switch (key) {
    case 'Version':
      return setting(key, value, { version: n });
    case 'Maximal Volume':
    case 'Minimal Volume':
    case 'Initial Volume': {
      // BootLogParser combines the three lines into settings.speakerVolume.
      const rec = setting(key, value, {}, n > 30);
      rec.volumePart = { field: key.startsWith('Max') ? 'max' : key.startsWith('Min') ? 'min' : 'init', value: n };
      return rec;
    }
    case 'Sleep Timer':
      return setting(key, value, { standbyTimerMinutes: n });
    case 'Inverted Volume Buttons':
      return setting(key, value, { invertVolumeButtons: n === 1 }, n !== 0 && n !== 1);
    case 'Admin Menu locked':
      return lockSetting(key, value, n, true);
    case 'Admin Menu Pin': {
      const pin = splitPin(value);
      return setting(key, value, { adminPin: pin }, !pin || pin.some((d) => d < 1 || d > 3));
    }
  }
  return setting(key, value, {}, true);
}

function eqSetting(key: string, value: string, n: number | undefined): SettingRecord {
  if (n === undefined || n < 1 || n > EQ_NAMES.length) return setting(key, value, n === undefined ? {} : { eq: n }, true);
  return setting(key, value, { eq: n, eqName: EQ_NAMES[n - 1] });
}

function lockSetting(key: string, value: string, n: number | undefined, classic: boolean): SettingRecord {
  if (n === undefined) return setting(key, value, {}, true);
  const kinds: AdminLockKind[] = classic ? ['none', 'card', 'pin', 'calc'] : ['none', 'card', 'pin'];
  const kind = kinds[n] ?? 'unknown';
  return setting(key, value, { adminLock: { kind, raw: n } }, kind === 'unknown');
}

export function volumesValid(v: VolumeLevels): boolean {
  const inRange = (x: number) => Number.isInteger(x) && x >= 0 && x <= 30;
  return inRange(v.max) && inRange(v.min) && inRange(v.init) && v.min <= v.max && v.init >= v.min && v.init <= v.max;
}

/**
 * The firmware prints the four PIN bytes as decimals without separator
 * ("AP:1213", or "AP:0255255255" for an erased EEPROM). Returns the only
 * possible split into four values 0..255, or null when it is ambiguous.
 */
export function splitPin(digits: string): number[] | null {
  const found: number[][] = [];
  const walk = (rest: string, acc: number[]) => {
    if (found.length > 1) return;
    if (acc.length === 4) {
      if (rest === '') found.push(acc);
      return;
    }
    for (let len = 1; len <= 3 && len <= rest.length; len++) {
      const token = rest.slice(0, len);
      if (len > 1 && token[0] === '0') break;
      const value = Number(token);
      if (value > 255) break;
      walk(rest.slice(len), [...acc, value]);
    }
  };
  walk(digits, []);
  return found.length === 1 ? found[0] : null;
}
