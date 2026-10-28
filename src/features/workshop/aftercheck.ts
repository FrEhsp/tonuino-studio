/**
 * Right after a firmware update: the box starts with the new firmware and
 * prints its settings (Vol, ST, IB, AL, PCR, …). The app reads that start and
 * says whether the settings came through: the same as before, values the box
 * cannot use, the factory state, or a timer that is off on a box with a
 * battery. Nothing is written; the box only restarts once when the port opens.
 */
import { BootLogParser, type BoxInfo } from '../../core/firmware/bootlog';
import type { BoardId } from '../../core/firmware/variants';
import { factoryInvert, invertKind } from '../../core/firmware/tngstands';
import { FACTORY_SETTINGS, volumeProblem } from '../../core/tonuino/settingsguide';
import type { SerialAccess, SerialPortInfo } from '../../platform/types';
import { openMonitor, type MonitorOptions } from './monitor';

export interface StartRead {
  info: BoxInfo;
  /** Labels of setting lines the box printed with values it cannot use. */
  invalid: string[];
  /** Something came over the cable. */
  heard: boolean;
}

export interface ReadStartOptions {
  /** Longest wait (default 10 s). */
  timeoutMs?: number;
  /** Quiet after the last setting line that ends the reading (default 1 s). */
  settledMs?: number;
  signal?: AbortSignal;
  monitor?: MonitorOptions;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Opens the port (that restarts the box) and reads its start until the settings are through. Rejects only when the port does not open. */
export async function readStartSettings(serial: SerialAccess, port: SerialPortInfo, opts: ReadStartOptions = {}): Promise<StartRead> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const settledMs = opts.settledMs ?? 1000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? pause;
  const parser = new BootLogParser({ infoEvents: false });
  const invalid: string[] = [];
  let heard = false;
  let ended = false;
  let lastSetting = 0;
  let after = false;
  const monitor = await openMonitor(
    serial,
    port,
    {
      onData: (bytes) => {
        heard = true;
        for (const e of parser.push(bytes)) {
          if (e.type !== 'line' || !e.record) continue;
          if (e.record.kind === 'setting') {
            lastSetting = now();
            if (e.record.invalid && !invalid.includes(e.record.key)) invalid.push(e.record.key);
          } else if (lastSetting && (e.record.kind === 'rfid-version' || e.record.kind === 'track-count')) after = true;
        }
      },
      onEnd: () => {
        ended = true;
      },
    },
    opts.monitor,
  );
  const started = now();
  try {
    while (!ended && !after && !opts.signal?.aborted && now() - started < timeoutMs) {
      if (lastSetting && now() - lastSetting >= settledMs) break;
      await sleep(20);
    }
  } finally {
    await monitor.stop();
  }
  parser.flush();
  return { info: parser.info, invalid, heard };
}

export type FindingTone = 'ok' | 'info' | 'warning';

export interface SettingsFinding {
  tone: FindingTone;
  text: string;
}

export interface SettingsVerdict {
  /** The settings in short, e.g. "Lautstärke 5 bis 25, Start 15". */
  facts: { label: string; value: string }[];
  findings: SettingsFinding[];
  /** The box printed no settings. */
  silent: boolean;
}

const LOCK_NAMES = { none: 'keine', card: 'Admin-Karte', pin: 'PIN', calc: 'Rechenaufgabe', unknown: 'unbekannt' } as const;

/** Boards with a battery: a timer that is off empties it. */
const BATTERY_BOARDS: readonly BoardId[] = ['aio', 'aioplus'];

/** What the start says about the settings after an update. */
export function judgeSettings(read: StartRead, board: BoardId): SettingsVerdict {
  const s = read.info.settings;
  const facts: SettingsVerdict['facts'] = [];
  const findings: SettingsFinding[] = [];
  const v = s.speakerVolume;
  if (v) facts.push({ label: 'Lautstärke', value: `${v.min} bis ${v.max}, beim Einschalten ${v.init}` });
  if (s.headphoneVolume) facts.push({ label: 'Kopfhörer', value: `${s.headphoneVolume.min} bis ${s.headphoneVolume.max}, beim Einschalten ${s.headphoneVolume.init}` });
  if (s.standbyTimerMinutes !== undefined) facts.push({ label: 'Ausschalt-Timer', value: s.standbyTimerMinutes ? `${s.standbyTimerMinutes} Minuten` : 'aus' });
  // What „Tasten umdrehen“ does depends on the buttons and, with 5, on the firmware (tngstands.ts invertKind).
  const invert = invertKind({ buttons: read.info.buttons ?? '3', version: read.info.version, date: read.info.versionDate });
  if (s.invertVolumeButtons !== undefined && invert === 'three') facts.push({ label: 'Kurz drücken', value: s.invertVolumeButtons ? 'lauter und leiser' : 'nächster Titel' });
  if (s.invertVolumeButtons !== undefined && invert === 'five') facts.push({ label: 'Tasten', value: s.invertVolumeButtons ? 'Vor/Zurück und Lauter/Leiser getauscht' : 'wie beschriftet' });
  if (s.adminLock) facts.push({ label: 'Sperre des Admin-Menüs', value: LOCK_NAMES[s.adminLock.kind] });
  if (s.pauseWhenCardRemoved !== undefined) facts.push({ label: 'Karte abnehmen', value: s.pauseWhenCardRemoved ? 'Musik hält an' : 'Musik läuft weiter' });

  const silent = facts.length === 0;
  if (silent) {
    findings.push({
      tone: 'info',
      text: read.heard ? 'Die Box hat beim Start keine Einstellungen gemeldet. Das ist bei manchen Firmwares so.' : 'Die Box hat nichts gemeldet. Läuft sie? Im Box-Logbuch kannst du ihren Start ansehen.',
    });
    return { facts, findings, silent };
  }

  if (read.invalid.length) findings.push({ tone: 'warning', text: `Die Box meldet Werte, die sie nicht nutzen kann (${read.invalid.join(', ')}). Stelle sie unter „Box einstellen“ neu ein.` });
  const vp = v ? volumeProblem(v) : undefined;
  if (vp) findings.push({ tone: 'warning', text: `Die Lautstärke passt nicht: ${vp}` });
  if (pinUntypable(read.info)) findings.push({ tone: 'warning', text: 'Die PIN der Admin-Sperre lässt sich an der Box nicht eingeben. Das Admin-Menü öffnet dann nur die Admin-Karte.' });
  if (s.standbyTimerMinutes === 0 && BATTERY_BOARDS.includes(board)) {
    findings.push({ tone: 'warning', text: 'Der Ausschalt-Timer ist aus. Mit Akku läuft die Box dann, bis er leer ist.' });
  }
  const factory =
    v?.max === FACTORY_SETTINGS.volume.max &&
    v.min === FACTORY_SETTINGS.volume.min &&
    v.init === FACTORY_SETTINGS.volume.init &&
    (s.standbyTimerMinutes ?? 0) === 0 &&
    (s.invertVolumeButtons ?? factoryInvert(invert)) === factoryInvert(invert) &&
    (s.adminLock?.kind ?? 'none') === 'none' &&
    !s.pauseWhenCardRemoved;
  if (factory) findings.push({ tone: 'info', text: 'Die Box hat die Einstellungen ab Werk. Hattest du vorher eigene, zum Beispiel eine Lautstärke-Grenze? Dann stelle sie neu ein.' });
  if (!findings.length) findings.push({ tone: 'ok', text: 'Die Einstellungen sind da und passen.' });
  return { facts, findings, silent };
}

/** The lock is a PIN the box cannot take from its keys (only 1 to 3: Play/Pause, Vor, Zurück). As pinUnusable() in BoxSettingsTool. */
function pinUntypable(info: BoxInfo): boolean {
  const s = info.settings;
  if (s.adminLock?.kind !== 'pin' || s.adminPin === undefined) return false;
  return !(s.adminPin && s.adminPin.length === 4 && s.adminPin.every((k) => k >= 1 && k <= 3));
}
