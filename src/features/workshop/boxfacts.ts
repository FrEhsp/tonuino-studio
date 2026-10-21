/**
 * The "Steckbrief" of a box: what its log says about firmware, parts and
 * settings, as short label/value rows. Unknown facts are left out, because a
 * log often starts in the middle.
 */
import { EQ_NAMES, type BoxInfo, type LogIssue, type VolumeLevels } from '../../core/firmware/bootlog';
import { VARIANTS, getBoard } from '../../core/firmware/variants';
import { tngStandOf } from '../../core/tonuino/firmwaredetect';

export interface BoxFact {
  id: string;
  label: string;
  value: string;
  /** ok: works; warn: worth a look; error: broken. */
  tone?: 'ok' | 'warn' | 'error';
  /** A page of the app where this can be changed or fixed. */
  link?: { label: string; href: string };
}

/** The rows of the admin menu settings lead to the Werkstatt tool that walks through the menu. */
const CHANGE: BoxFact['link'] = { label: 'Ändern', href: '#/werkstatt/einstellen' };

export interface BoxFacts {
  /** Firmware, board and parts. */
  box: BoxFact[];
  /** What is set in the box's admin menu. */
  settings: BoxFact[];
}

const KEY_NAMES = ['?', 'Play/Pause', 'Vor', 'Zurück'];

function germanDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}.${m}.${y}` : iso;
}

function levels(v: VolumeLevels): string {
  return `${v.min} bis ${v.max}, beim Einschalten ${v.init}`;
}

export function boxFacts(info: BoxInfo): BoxFacts {
  const box: BoxFact[] = [];
  const settings: BoxFact[] = [];

  if (info.firmware === 'tng') {
    const version = info.version ? ` ${info.version}` : '';
    const date = info.versionDate ? ` vom ${germanDate(info.versionDate)}` : '';
    const stand = tngStandOf({ version: info.version, date: info.versionDate });
    box.push({ id: 'firmware', label: 'Firmware', value: `TonUINO TNG${version}${date}${stand?.preview ? ' (Testversion)' : ''}`, ...(stand?.preview ? { tone: 'warn' as const } : {}) });
  } else if (info.firmware === 'classic21') {
    box.push({ id: 'firmware', label: 'Firmware', value: 'TonUINO 2.1 (alte Version)', tone: 'warn' });
  }
  if (info.board) {
    const board = getBoard(info.board);
    const buttons = info.buttons ? `, ${VARIANTS[info.buttons].label}` : '';
    box.push({ id: 'board', label: 'Platine', value: `${board.shortName}${buttons}` });
  }
  if (info.rfid) {
    box.push(
      info.rfid.ok
        ? { id: 'rfid', label: 'Kartenleser', value: `antwortet (${info.rfid.chip})`, tone: 'ok' }
        : { id: 'rfid', label: 'Kartenleser', value: 'antwortet nicht', tone: 'error' },
    );
  }
  if (info.mp3) {
    const { connected, trackCount } = info.mp3;
    if (!connected) box.push({ id: 'mp3', label: 'MP3-Player', value: 'antwortet nicht', tone: 'error' });
    else if (trackCount === 0) box.push({ id: 'mp3', label: 'MP3-Player', value: 'findet keine Dateien auf der SD-Karte', tone: 'error' });
    else if (trackCount !== undefined) box.push({ id: 'mp3', label: 'MP3-Player', value: `${trackCount.toLocaleString('de-DE')} Dateien auf der SD-Karte`, tone: 'ok' });
    else box.push({ id: 'mp3', label: 'MP3-Player', value: 'antwortet', tone: 'ok' });
  }
  if (info.volume !== undefined) box.push({ id: 'volume', label: 'Lautstärke', value: `${info.volume} von 30` });
  if (info.headphones !== undefined) box.push({ id: 'headphones', label: 'Kopfhörer', value: info.headphones ? 'eingesteckt' : 'nicht eingesteckt' });
  if (info.wifi) {
    const w = info.wifi;
    const at = w.ip ? `, http://${w.ip}` : '';
    box.push(
      w.mode === 'station'
        ? { id: 'wifi', label: 'WLAN', value: `verbunden mit „${w.ssid ?? '?'}“${at}`, tone: 'ok' }
        : { id: 'wifi', label: 'WLAN', value: `eigenes WLAN „TonUINO“${at}`, tone: w.ssid ? 'warn' : undefined },
    );
  }
  if (info.batteryEmpty) box.push({ id: 'battery', label: 'Akku', value: 'leer', tone: 'error' });

  const s = info.settings;
  if (s.speakerVolume) settings.push({ id: 'speaker', label: 'Lautsprecher', value: levels(s.speakerVolume) });
  if (s.headphoneVolume) settings.push({ id: 'headphone', label: 'Kopfhörer', value: levels(s.headphoneVolume) });
  if (s.eq !== undefined) settings.push({ id: 'eq', label: 'Klang', value: s.eqName ?? EQ_NAMES[s.eq - 1] ?? String(s.eq) });
  if (s.standbyTimerMinutes !== undefined) {
    settings.push({ id: 'standby', label: 'Ausschalt-Timer', value: s.standbyTimerMinutes === 0 ? 'aus' : `nach ${s.standbyTimerMinutes} Minuten ohne Musik` });
  }
  if (s.adminLock) {
    const lock = { none: 'nicht gesperrt', card: 'nur mit Admin-Karte', pin: 'mit PIN gesperrt', calc: 'mit Rechenaufgabe gesperrt', unknown: 'unbekannte Sperre' }[s.adminLock.kind];
    const pin = s.adminLock.kind === 'pin' && s.adminPin ? ` (${s.adminPin.map((k) => KEY_NAMES[k] ?? String(k)).join(', ')})` : '';
    settings.push({ id: 'admin', label: 'Admin-Menü', value: `${lock}${pin}` });
  }
  if (s.pauseWhenCardRemoved !== undefined) {
    settings.push({ id: 'card-removed', label: 'Karte wegnehmen', value: s.pauseWhenCardRemoved ? 'Box hält an' : 'Box spielt weiter' });
  }
  if (s.invertVolumeButtons !== undefined && (info.buttons === undefined || info.buttons === '3')) {
    settings.push({
      id: 'buttons',
      label: 'Tasten',
      value: s.invertVolumeButtons ? 'kurz drücken: Lautstärke, lang: Titel' : 'kurz drücken: Titel, lang: Lautstärke',
    });
  }
  // „Box einstellen“ sets what the speaker plays; the headphone values it cannot count from.
  return { box, settings: settings.map((f) => (f.id === 'headphone' ? f : { ...f, link: CHANGE })) };
}

/** True once the log showed the start of the box; before that the Steckbrief is mostly empty. */
export function hasBootFacts(info: BoxInfo): boolean {
  return info.firmware !== undefined || info.board !== undefined || Object.keys(info.settings).length > 0;
}

const LEVEL_WORDS = { error: 'Fehler', warn: 'Hinweis', info: 'Info' } as const;

/** Plain-text summary for a file or a forum post. */
export function summaryLines(info: BoxInfo, issues: readonly LogIssue[]): string[] {
  const { box, settings } = boxFacts(info);
  const lines: string[] = ['Steckbrief der Box'];
  if (!box.length && !settings.length) lines.push('- noch nichts bekannt (die Box ist im Log nicht gestartet)');
  for (const f of [...box, ...settings]) lines.push(`- ${f.label}: ${f.value}`);
  lines.push('', 'Auffälligkeiten');
  if (!issues.length) lines.push('- keine');
  for (const i of issues) {
    const count = i.count > 1 ? ` (${i.count}×)` : '';
    lines.push(`- [${LEVEL_WORDS[i.explanation.level]}] ${i.explanation.title}${count}: ${i.explanation.explanation}`);
    if (i.explanation.fix) lines.push(`  Tipp: ${i.explanation.fix}`);
  }
  return lines;
}
