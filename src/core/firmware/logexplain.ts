/**
 * Explains TonUINO log lines in plain German: what happened and what to do.
 *
 * The texts are for parents and tinkerers, not for developers. Every
 * explanation has a stable `id`, so repeated lines with the same meaning
 * can be grouped (see BootLogParser).
 */
import { ADMIN_MODE, decodeCard } from '../tonuino/card';
import { tngStandOf } from '../tonuino/firmwaredetect';
import { describeCard, modifiersFor } from '../tonuino/modes';
import { EQ_NAMES, parseLogLine, splitPin, type BoxButtons, type BoxSettings, type FirmwareFamily, type LogRecord, type SettingRecord } from './logline';
import { getBoard, VARIANTS, type BoardId } from './variants';

export type ExplanationLevel = 'info' | 'warn' | 'error';

export interface LineExplanation {
  /** Same for lines that mean the same thing, e.g. "mp3-error-6:mp3/0340.mp3". */
  id: string;
  level: ExplanationLevel;
  title: string;
  explanation: string;
  fix?: string;
  /**
   * A tool of TonUINO Studio that carries out the fix (sounds: Systemansagen,
   * settings: Box einstellen, rebuild: Karte neu aufbauen); the Box-Logbuch
   * offers a button for it.
   */
  fixIn?: 'sounds' | 'settings' | 'rebuild';
}

export interface ExplainContext {
  /** Board from the boot log. Makes wiring hints fit the box. */
  board?: BoardId;
  firmware?: FirmwareFamily;
  /** Keys from the boot log ("A+ 5"): names the keys of the admin menu. */
  buttons?: BoxButtons;
  /** File the box asked the MP3 player for last, e.g. "mp3/0340.mp3". */
  lastFile?: string;
  /** Settings seen so far in this boot. */
  settings?: BoxSettings;
  /** Last battery voltage the box measured (only firmware built with battery measurement logs it). */
  batteryVolts?: number;
  /** The last voltage line said the battery is low ("BatVoltage low …"). */
  batteryLow?: boolean;
  /** The name of a folder on the card the app knows (its catalog), for cards the box reads. */
  folderTitle?: (folder: number) => string | undefined;
}

/**
 * Highest "low" threshold of TNG (constants.hpp: batVoltageLow 2.95 V, or
 * 3.40 V for the other battery type). Above it the box does not warn, so a
 * "play adv: 262" there is something else, e.g. a full Jukebox queue.
 */
export const BATTERY_LOW_MAX_VOLTS = 3.4;

/** True when the last voltage reading says the box is warning about its battery. */
export function batteryWarning(ctx: ExplainContext): boolean {
  return ctx.batteryVolts !== undefined && (ctx.batteryLow === true || ctx.batteryVolts <= BATTERY_LOW_MAX_VOLTS);
}

/** Explains one raw log line. Returns null for lines that need no comment. */
export function explainLine(line: string, ctx: ExplainContext = {}): LineExplanation | null {
  const record = parseLogLine(line);
  return record ? explainRecord(record, ctx) : null;
}

export function explainRecord(record: LogRecord, ctx: ExplainContext = {}): LineExplanation | null {
  switch (record.kind) {
    case 'banner':
      return record.firmware === 'tng'
        ? info('boot', 'Die Box startet', 'TonUINO TNG meldet sich. Gleich folgen die Einstellungen und die Prüfung von Kartenleser und MP3-Player.')
        : info(
            'boot',
            'Die Box startet (TonUINO 2.1)',
            'Auf der Box läuft noch die alte Firmware TonUINO 2.1. Deine Musik-Karten funktionieren auch mit der neuen Firmware TonUINO TNG.',
            'Wenn du möchtest, spiele unter „Firmware“ die aktuelle Version auf.',
          );
    case 'version': {
      const title = `TonUINO TNG ${record.version}${record.date ? ` vom ${germanDate(record.date)}` : ''}`;
      // 3.3.3 came out more than once: the date tells which (V3.3.3 25.02.26, 17.09.26, the test build 16.10.26).
      const stand = tngStandOf(record);
      if (stand?.preview) return warn('version-preview', `${title} (Testversion)`, `Auf der Box läuft eine ${stand.label}. ${stand.note ?? ''}`.trim(), 'Bleibt die Box nach einer Ansage hängen, spiele unter „Firmware“ das Release vom 17.09.2026 auf.');
      return info('version', title, stand ? `Diese Firmware-Version läuft auf der Box: ${stand.label}.${stand.note ? ` ${stand.note}` : ''}` : 'Diese Firmware-Version läuft auf der Box.');
    }
    case 'hardware': {
      const board = getBoard(record.board);
      return info(
        'hardware',
        `Platine: ${board.shortName}, ${VARIANTS[record.buttons].label}`,
        `Die Firmware ist für „${board.name}“ mit ${VARIANTS[record.buttons].label} gebaut.`,
        'Passt das nicht zu deiner Box, spiele die passende Firmware auf. Sonst reagieren die Tasten falsch.',
      );
    }
    case 'setting':
      return explainSetting(record, ctx);
    case 'rfid-version':
      return explainRfidVersion(record.version, ctx.board);
    case 'rfid-broken':
      return rfidMissing(ctx.board);
    case 'mp3-broken':
      return error(
        'mp3-broken',
        'Keine Verbindung zum MP3-Player',
        'Der MP3-Player (DFPlayer) antwortet nicht. Ohne ihn spielt die Box nichts ab.',
        mp3ConnectionFix(ctx.board),
      );
    case 'track-count':
      return record.count === 0
        ? {
            ...error(
              'mp3-no-files',
              'Keine Dateien auf der SD-Karte',
              'Der MP3-Player findet keine Dateien. Die SD-Karte fehlt, ist leer oder falsch formatiert.',
              `Prüfe, ob die SD-Karte richtig in der Box steckt. Ist sie leer, spiele deine Ordner und die Ordner „mp3“ und „advert“ wieder drauf. Sind deine Ordner auf der Karte, ist sie vielleicht falsch formatiert: Sie braucht FAT32 und darf höchstens 32 GB haben. ${REBUILD}`,
            ),
            fixIn: 'rebuild',
          }
        : info('mp3-files', 'SD-Karte gelesen', `Der MP3-Player hat ${record.count} Dateien gefunden.`);
    case 'mp3-error':
      return explainDfPlayerError(record.code, ctx);
    case 'folder-tracks': {
      const folder = pad(record.folder, 2);
      return record.count === 0
        ? {
            ...warn(
              `folder-empty-${folder}`,
              `Ordner ${folder} ist leer oder fehlt`,
              `Eine Karte will Ordner ${folder} abspielen, aber der MP3-Player findet darin keine Titel.`,
              `Prüfe, ob es auf der SD-Karte den Ordner „${folder}“ gibt und ob darin Dateien wie „001.mp3“ liegen. Sind sie da und der MP3-Player findet sie trotzdem nicht: ${REBUILD}`,
            ),
            fixIn: 'rebuild',
          }
        : info('folder-tracks', `Ordner ${folder}: ${record.count} Titel`, `Der MP3-Player hat in Ordner ${folder} ${record.count} Titel gefunden.`);
    }
    case 'missing-finished':
      return {
        ...warn(
          'missing-finished',
          'Titelende nicht gemeldet',
          'Der MP3-Player hat das Ende eines Titels nicht gemeldet. TonUINO ist selbst zum nächsten Titel gesprungen. Ab und zu ist das harmlos.',
          missingFinishedFix(ctx.board),
        ),
        fixIn: 'rebuild',
      };
    case 'play':
      return info('play', `Spielt ${pad(record.folder, 2)}/${pad(record.track, 3)}.mp3`, `Die Box spielt Titel ${record.track} aus Ordner ${pad(record.folder, 2)}.`);
    case 'play-mp3':
      return info('play-mp3', `Ansage mp3/${pad(record.track, 4)}.mp3`, 'Die Box spielt eine Ansage aus dem Ordner „mp3“.');
    case 'play-advert':
      // batVoltage.cpp: a low battery plays advert 262 (the "pling") every 30 s (forum 14944). The Jukebox
      // modifier plays the same advert when its queue is full (modifier.cpp), so only a low reading counts.
      if (record.track === 262 && ctx.batteryVolts !== undefined && batteryWarning(ctx)) return batteryLow(ctx.batteryVolts);
      return info('play-advert', `Ansage advert/${pad(record.track, 4)}.mp3`, 'Die Box blendet eine Ansage aus dem Ordner „advert“ ein.');
    case 'card':
      return record.event === 'inserted'
        ? info('card-in', 'Karte aufgelegt', 'Die Box hat eine Karte erkannt.')
        : info('card-out', 'Karte weggenommen', 'Die Karte liegt nicht mehr auf der Box.');
    case 'card-data':
      return explainCardData(record.bytes, ctx);
    case 'card-bad-version':
      return warn(
        'card-bad-version',
        'Karte von einer anderen TonUINO-Version',
        `Die Karte hat das Format ${record.version}. Diese Firmware kann sie nicht lesen.`,
        'Beschreibe die Karte neu.',
      );
    case 'card-error':
      return explainCardError(record.op, record.status);
    case 'card-type':
      return record.type.startsWith('NTAG?')
        ? info('card-type', 'Unbekannter NTAG-Chip', 'Die Box kennt den Chip dieser Karte nicht genau. Sie funktioniert vielleicht trotzdem.')
        : info('card-type', `Kartentyp: ${record.type}`, 'Die Box hat den Chip der Karte erkannt.');
    case 'card-written':
      return info('card-written', 'Karte beschrieben', 'Die Karte ist fertig.');
    case 'batch-card':
      return info('batch-card', `Karte ${record.index} auflegen`, 'Die Box wartet auf die nächste Karte für den Ordner.');
    case 'modifier':
      return explainModifier(record.action, record.name);
    case 'button':
      return info(
        'button',
        `Taste: ${buttonLabel(record.raw, ctx.buttons)}`,
        `Die Box führt aus: ${COMMAND_LABELS[record.command] ?? record.command}.`,
      );
    case 'button3x3':
      return info('button3x3', `Taste ${record.index} am 3×3-Tastenfeld`, 'Die Box spielt, was auf dieser Taste gespeichert ist.');
    case 'state': {
      const s = STATES[record.state];
      return s ? info(`state-${record.state}`, s[0], s[1]) : null;
    }
    case 'abort':
      return info('abort', 'Abgebrochen', 'Der Vorgang wurde ohne Änderung beendet.');
    case 'volume':
      return info('volume', `Lautstärke ${record.volume}`, `Die Lautstärke ist jetzt ${record.volume} (von 30).`);
    case 'headphones':
      return record.plugged
        ? info('headphones', 'Kopfhörer eingesteckt', 'Die Box nutzt jetzt die Kopfhörer-Lautstärke.')
        : info('headphones', 'Kopfhörer ausgesteckt', 'Die Box spielt wieder über den Lautsprecher.');
    case 'standby':
      if (record.event === 'started') return info('standby', 'Ausschalt-Timer läuft', 'Spielt nichts mehr, schaltet sich die Box bald aus.');
      if (record.event === 'stopped') return info('standby', 'Ausschalt-Timer gestoppt', 'Die Box bleibt an.');
      return info('power-off', 'Die Box schaltet sich aus', 'Der Ausschalt-Timer ist abgelaufen, oder die Box wurde ausgeschaltet.');
    case 'battery-voltage':
      return record.low ? batteryLow(record.volts) : null;
    case 'battery-empty':
      return warn(
        'battery-empty',
        'Akku leer',
        'Die Spannung ist zu niedrig. Die Box schaltet sich gleich aus.',
        'Lade den Akku oder schließe ein Netzteil an.',
      );
    case 'settings-cleared':
      return warn(
        'settings-cleared',
        'Einstellungen gelöscht',
        'Die Box hat alle Einstellungen und gemerkten Hörbuch-Stellen gelöscht. Das passiert, wenn beim Einschalten Play/Pause, Vor und Zurück gleichzeitig gedrückt sind, oder über „alle Einstellungen löschen“ im Admin-Menü.',
        'Wolltest du das nicht und passiert es bei jedem Start, klemmt vielleicht eine Taste.',
      );
    case 'eeprom-failed':
      return error(
        'eeprom-failed',
        'Einstellungen nicht gespeichert',
        'Die Box konnte ihren Speicher für Einstellungen nicht benutzen.',
        `Spiele die Firmware neu auf. ${FORUM}`,
      );
    case 'quiz-error':
      return error(
        'quiz-error',
        'Quiz-Karte falsch eingestellt',
        record.field === 'answers'
          ? `Die Karte verlangt ${record.value} Antworten. Erlaubt sind 0, 2 oder 4.`
          : `Die Karte hat bei „Lösung“ den Wert ${record.value}. Erlaubt sind 0 oder 1.`,
        'Beschreibe die Quiz-Karte neu.',
      );
    case 'wifi':
      return explainWifi(record.mode, record.ssid, record.ip);
    case 'wifi-static-ip-failed':
      return warn(
        'wifi-static-ip',
        'Feste IP-Adresse passt nicht',
        'Die Box konnte die eingestellte feste IP-Adresse nicht übernehmen.',
        'Prüfe auf der WLAN-Seite der Box IP-Adresse, Gateway und Subnetz, oder schalte die feste IP-Adresse aus.',
      );
    case 'ota-done':
      return info('ota-done', 'Update fertig', 'Die neue Firmware ist gespeichert. Die Box startet gleich neu.');
    case 'ota-error':
      return error(
        'ota-error',
        'Update fehlgeschlagen',
        'Die neue Firmware konnte nicht gespeichert werden. Die alte Firmware läuft weiter.',
        'Versuche es noch einmal. Prüfe dabei, ob du die richtige Datei (firmware.bin für deine Platine) gewählt hast.',
      );
    case 'garbled':
      return warn(
        'garbled',
        'Unleserliche Zeichen',
        'Die Box sendet Zeichen, die keinen Sinn ergeben. Meist passt die Geschwindigkeit der Verbindung nicht.',
        'Stelle 115200 Baud ein. Bleibt es unleserlich, ist die Firmware vielleicht für eine andere Platine gebaut: Spiele die passende fertige Firmware auf.',
      );
  }
}

/** Explains an error code of the DFPlayer (DFMiniMp3 library 1.2). */
export function explainDfPlayerError(code: number, ctx: ExplainContext = {}): LineExplanation {
  const id = `mp3-error-${code}`;
  const transmission = mp3TransmissionFix(ctx.board);
  switch (code) {
    case 1:
      return warn(id, 'MP3-Player beschäftigt', 'Der MP3-Player war noch beschäftigt. Direkt nach dem Einschalten heißt das oft: Er findet keine SD-Karte.', `Prüfe, ob die SD-Karte richtig steckt. Hilft das nicht: ${SD_FORMAT}`);
    case 2:
      return warn(id, 'MP3-Player schläft', 'Der MP3-Player war im Ruhezustand und hat einen Befehl nicht ausgeführt.', 'Meist harmlos. Passiert es oft, schalte die Box aus und wieder ein.');
    case 3:
      return warn(id, 'Übertragungsfehler zum MP3-Player', 'Der MP3-Player hat einen Befehl nur unvollständig bekommen.', transmission);
    case 4:
      return warn(id, 'Übertragungsfehler zum MP3-Player', 'Ein Befehl kam beim MP3-Player verfälscht an.', transmission);
    case 5:
      return error(
        withFile(id, ctx.lastFile),
        'Titelnummer gibt es nicht',
        `Die Box wollte einen Titel abspielen, den es auf der SD-Karte nicht gibt.${requested(ctx.lastFile)}`,
        'Prüfe, ob die Karte auf den richtigen Ordner zeigt und ob alle Titel auf der SD-Karte sind.',
      );
    case 6: {
      const missing = error(
        withFile(id, ctx.lastFile),
        'Datei fehlt auf der SD-Karte',
        ctx.lastFile
          ? `Die Box wollte „${ctx.lastFile}“ abspielen, aber der MP3-Player findet die Datei nicht.`
          : 'Der MP3-Player findet eine Datei nicht, die er abspielen soll.',
        missingFileFix(ctx.lastFile),
      );
      if (!ctx.lastFile || /^(mp3|advert)\//.test(ctx.lastFile)) missing.fixIn = 'sounds';
      return missing;
    }
    case 7:
      // The DFPlayer inserts an advert only into a running track. When nothing
      // plays, TNG starts 01/001.mp3 first (mp3.cpp, playAdvertisement).
      return {
        ...warn(
          withFile(id, ctx.lastFile?.startsWith('advert/') ? ctx.lastFile : undefined),
          'Ansage nicht eingeblendet',
          `Der MP3-Player konnte eine Ansage nicht einblenden. Das geht nur, während ein Titel läuft.${ctx.lastFile?.startsWith('advert/') ? requested(ctx.lastFile) : ''}`,
          `Einzeln ist das harmlos. Passiert es öfter: ${RENEW_SOUNDS} Prüfe auch, ob es den Ordner „01“ mit „001.mp3“ gibt. Den braucht die Box, um Ansagen abzuspielen, wenn gerade nichts läuft.`,
        ),
        fixIn: 'sounds',
      };
    case 8:
      return error(id, 'SD-Karte nicht lesbar', 'Der MP3-Player kann die SD-Karte nicht lesen. Sie fehlt, sitzt locker oder ist beschädigt.', `Stecke die SD-Karte neu ein. Hilft das nicht: ${SD_FORMAT} Oder nimm eine andere Karte.`);
    case 9:
      return warn(id, 'Interner Speicher nicht lesbar', 'Der MP3-Player meldet einen Fehler mit seinem eingebauten Speicher. Mit SD-Karte ist das meist egal.');
    case 10:
      return info(id, 'MP3-Player im Ruhezustand', 'Der MP3-Player hat sich schlafen gelegt.');
    case 0x81:
      return warn(id, 'MP3-Player antwortet nicht', 'Der MP3-Player hat nicht rechtzeitig geantwortet. Einzelne Meldungen sind harmlos.', transmission);
    case 0x82:
    case 0x83:
    case 0x84:
      return warn(id, 'Gestörte Antwort vom MP3-Player', 'Eine Antwort des MP3-Players kam unvollständig oder verfälscht an. Einzelne Meldungen sind harmlos.', transmission);
    default:
      return warn(id, 'Fehler vom MP3-Player', `Der MP3-Player meldet Fehler ${code}. Einzelne Meldungen sind harmlos.`, transmission);
  }
}

/** For a box that restarts while the log is open. `count` is how often it happened. */
export function explainReboot(count = 1): LineExplanation {
  return warn(
    'reboot',
    count > 1 ? `Die Box ist ${count}-mal neu gestartet` : 'Die Box ist neu gestartet',
    'Hast du sie nicht selbst neu gestartet, ist kurz der Strom weggebrochen. Das passiert oft bei hoher Lautstärke oder schwachem Akku.',
    'Probiere ein stärkeres Netzteil oder einen vollen Akku. Hilft das nicht, senke die höchste Lautstärke.',
  );
}

/** Name of the card reader chip from the MFRC522 version register. */
export function rfidChip(version: number): { chip: string; ok: boolean } {
  switch (version) {
    case 0x00:
    case 0xff:
      return { chip: 'keine Antwort', ok: false };
    case 0x88:
    case 0xb2:
      return { chip: 'FM17522 (Nachbau)', ok: true };
    case 0x89:
      return { chip: 'FM17522E (Nachbau)', ok: true };
    case 0x90:
      return { chip: 'MFRC522 v0.0', ok: true };
    case 0x91:
      return { chip: 'MFRC522 v1.0', ok: true };
    case 0x92:
      return { chip: 'MFRC522 v2.0', ok: true };
    case 0x12:
      return { chip: 'MFRC522 (Nachbau)', ok: true };
    default:
      return { chip: `unbekannt (0x${version.toString(16).padStart(2, '0')})`, ok: true };
  }
}

// ---------------------------------------------------------------------------

const FORUM = 'Hilft das nicht, frage im TonUINO-Forum (discourse.voss.earth).';
/** The way out the app offers for a card the MP3 player reads badly; the Box-Logbuch shows a button for it (fixIn 'rebuild'). */
const REBUILD =
  'Baue die SD-Karte neu auf. Ich sichere alles, und nach dem Formatieren kommt alles in der richtigen Reihenfolge zurück auf die Karte. Ich führ dich durch die Schritte. Deine Ordnernummern bleiben gleich.';
const SD_FORMAT = 'Formatiere die SD-Karte mit FAT32 (höchstens 32 GB).';
const RESET_SETTINGS =
  'Setze die Einstellungen zurück: Halte beim Einschalten Play/Pause, Vor und Zurück gleichzeitig gedrückt. Danach stellst du alles unter „Box einstellen“ neu ein.';
const KEY_NAMES = ['?', 'Play/Pause', 'Vor', 'Zurück'];

function info(id: string, title: string, explanation: string, fix?: string): LineExplanation {
  return make(id, 'info', title, explanation, fix);
}
function warn(id: string, title: string, explanation: string, fix?: string): LineExplanation {
  return make(id, 'warn', title, explanation, fix);
}
function error(id: string, title: string, explanation: string, fix?: string): LineExplanation {
  return make(id, 'error', title, explanation, fix);
}
function make(id: string, level: ExplanationLevel, title: string, explanation: string, fix?: string): LineExplanation {
  const e: LineExplanation = { id, level, title, explanation };
  if (fix) e.fix = fix;
  return e;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function germanDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function isAio(board: BoardId | undefined): boolean {
  return board === 'aio' || board === 'aioplus';
}

function isEsp32(board: BoardId | undefined): boolean {
  return board === 'esp32nano' || board === 'esp32wroom';
}

/** Boards wired like the Classic (constants.hpp: DFPlayer on D2/D3, BUSY on D4, reader on D9 to D13). */
function classicWiring(board: BoardId | undefined): boolean {
  return board === 'classic' || board === 'every' || board === 'every4808' || board === 'esp32nano';
}

function mp3ConnectionFix(board: BoardId | undefined): string {
  if (classicWiring(board)) {
    return 'Prüfe die Kabel zum MP3-Player: D2 an TX, D3 über einen 1-kΩ-Widerstand an RX (nicht vertauschen), BUSY an D4, dazu 5 V und GND. Steckt die SD-Karte richtig? Hilft das nicht, probiere einen anderen MP3-Player.';
  }
  if (isAio(board)) {
    return `Der MP3-Player sitzt auf der Platine. Prüfe, ob die SD-Karte richtig steckt, und schalte die Box aus und wieder ein. ${FORUM}`;
  }
  return 'Prüfe die Kabel zwischen Mikrocontroller und MP3-Player und ob die SD-Karte richtig steckt.';
}

function mp3TransmissionFix(board: BoardId | undefined): string {
  if (classicWiring(board)) {
    return 'Häufen sich die Meldungen, prüfe die Kabel zum MP3-Player (D2 an TX, D3 über 1 kΩ an RX). Wackelige Steckverbindungen verursachen solche Fehler.';
  }
  return 'Häufen sich die Meldungen, prüfe die Stromversorgung und die SD-Karte.';
}

function withFile(id: string, file: string | undefined): string {
  return file ? `${id}:${file}` : id;
}

function requested(file: string | undefined): string {
  return file ? ` Zuletzt angefragt: „${file}“.` : '';
}

/** Where the app puts the announcements that fit the firmware onto the SD card. */
const RENEW_SOUNDS = 'Erneuere die Systemansagen: In TonUINO Studio unter „Werkstatt“ und „Systemansagen“ kommen die Ordner „mp3“ und „advert“ passend zur Firmware auf die SD-Karte.';

function missingFileFix(file: string | undefined): string {
  if (file && /^(mp3|advert)\//.test(file)) {
    return `Die Ansagen auf der SD-Karte passen nicht zur Firmware. Das passiert oft nach einem Firmware-Update. ${RENEW_SOUNDS}`;
  }
  const m = file?.match(/^(\d{2})\/(\d{3})\.mp3$/);
  if (m) {
    return `Prüfe Ordner ${m[1]}: Gibt es dort „${m[2]}.mp3“? Die Titel müssen ohne Lücke 001.mp3, 002.mp3 … heißen. Ist der Ordner leer oder fehlt er, kopiere die Titel neu drauf.`;
  }
  return `Prüfe die Dateinamen auf der SD-Karte. Nach einem Firmware-Update brauchst du meist auch neue Ansagen. ${RENEW_SOUNDS}`;
}

function missingFinishedFix(board: BoardId | undefined): string {
  const first = classicWiring(board)
    ? 'Brechen Titel mittendrin ab, prüfe das Kabel von BUSY (MP3-Player) zu D4.'
    : board === 'aioplus'
      ? 'Brechen Titel mittendrin ab, spiele die aktuelle Firmware auf (bei der AiO+ ab TNG 3.3.3 behoben).'
      : 'Brechen Titel mittendrin ab, spiele die aktuelle Firmware auf.';
  return `${first} Passiert es nur bei bestimmten Titeln, wandle diese Dateien neu um. Hilft das nicht: ${REBUILD}`;
}

/** Firmware built with battery measurement warns with advert 262 while the voltage is low (batVoltage.cpp, lowMessage). */
function batteryLow(volts: number): LineExplanation {
  return warn(
    'battery-low',
    'Akku fast leer',
    `Spielt die Box immer wieder einen kurzen Pling-Ton (Ansage 262), warnt sie: Ihr Akku ist fast leer. Zuletzt hat sie ${volts.toLocaleString('de-DE')} Volt gemessen. Ein Fehler beim Abspielen oder bei Bluetooth ist das nicht.`,
    'Lade den Akku oder schließe ein Netzteil an. Kommt die Warnung auch mit vollem Akku, misst die Box die Spannung zu niedrig: Miss mit einem Messgerät nach und vergleiche mit dem Wert hier. Den Messwert gleicht nur eine selbst gebaute Firmware aus. Frage dazu im TonUINO-Forum (discourse.voss.earth).',
  );
}

function rfidMissing(board: BoardId | undefined): LineExplanation {
  const fix =
    classicWiring(board)
      ? 'Prüfe die Kabel zum Kartenleser: 3,3 V (nicht 5 V), GND, RST an D9, SDA an D10, MOSI an D11, MISO an D12, SCK an D13. Manche Nano-Nachbauten liefern am 3V3-Pin zu wenig Spannung: Miss nach, ob dort wirklich 3,3 V anliegen.'
      : isAio(board)
        ? 'Prüfe das Kabel zwischen Platine und Kartenleser und ob der Stecker richtig herum steckt.'
        : 'Prüfe die Kabel zum Kartenleser. Er braucht 3,3 V, nicht 5 V.';
  return error('rfid-none', 'Kartenleser antwortet nicht', 'Die Box bekommt keine Antwort vom Kartenleser. Karten werden nicht erkannt.', fix);
}

function explainRfidVersion(version: number, board: BoardId | undefined): LineExplanation {
  const { chip, ok } = rfidChip(version);
  if (!ok) return rfidMissing(board);
  if (version === 0x12) {
    return warn(
      'rfid-counterfeit',
      'Kartenleser: Nachbau-Chip',
      'Der Kartenleser meldet sich als Nachbau. Viele davon funktionieren.',
      'Werden Karten nicht zuverlässig erkannt, tausche den Kartenleser testweise aus. Unter Werkstatt → Kartenleser testen siehst du, wie gut er liest.',
    );
  }
  if (chip.startsWith('unbekannt')) {
    return warn(
      'rfid-unknown',
      'Unbekannter Kartenleser',
      `Der Kartenleser meldet die Kennung ${version}. Diesen Chip kennt die Box nicht.`,
      'Werden Karten nicht erkannt, prüfe die Kabel oder tausche den Kartenleser aus.',
    );
  }
  if (chip.includes('Nachbau')) {
    return info('rfid-ok', 'Kartenleser bereit', `Der Kartenleser antwortet. Er hat einen nachgebauten Chip (${chip}), der normalerweise gut funktioniert.`);
  }
  return info('rfid-ok', 'Kartenleser bereit', `Der Kartenleser antwortet (${chip}).`);
}

const CARD_STATUS: Record<number, string> = {
  1: 'Übertragungsfehler',
  2: 'mehrere Karten gleichzeitig',
  3: 'Zeitüberschreitung',
  4: 'Puffer zu klein',
  5: 'interner Fehler',
  6: 'ungültiger Wert',
  7: 'Prüfsumme falsch',
  255: 'Karte hat abgelehnt',
};

function explainCardError(op: 'auth' | 'read' | 'write', status: number): LineExplanation {
  const reason = `${CARD_STATUS[status] ?? 'Fehler'}, Code ${status}`;
  if (op === 'write') {
    return error(
      'card-write',
      'Karte nicht beschrieben',
      `Die Box konnte die Karte nicht beschreiben (${reason}).`,
      'Lege die Karte ruhig auf und lasse sie liegen, bis die Box das Schreiben bestätigt. Manche Karten sind schreibgeschützt.',
    );
  }
  const collision = status === 2 ? ' Lag mehr als eine Karte auf der Box?' : ' Oft wurde sie zu schnell wieder weggenommen.';
  return warn(
    `card-${op}`,
    'Karte nicht lesbar',
    `Die Box konnte die Karte nicht ${op === 'auth' ? 'entsperren' : 'lesen'} (${reason}).${collision}`,
    'Lege die Karte ruhig auf. Passiert es bei einer Karte immer, ist es vielleicht kein passender Kartentyp (MIFARE Classic oder NTAG).',
  );
}

function explainCardData(bytes: number[], ctx: ExplainContext): LineExplanation | null {
  const card = decodeCard(Uint8Array.from(bytes));
  switch (card.kind) {
    case 'empty':
      return info('card-empty', 'Leere Karte', 'Die Karte ist noch nicht beschrieben. Du kannst sie an der Box oder hier in der App einrichten.');
    case 'foreign':
      return warn(
        'card-foreign',
        'Fremde Karte',
        'Auf der Karte stehen Daten, die nicht von TonUINO kommen.',
        'Beschreibe die Karte neu. Manche Karten anderer Systeme lassen sich nicht überschreiben.',
      );
    case 'bad-version':
      return null; // The firmware follows up with "bad ver".
    case 'tonuino': {
      const text = describeCard(card.data, ctx.firmware ?? 'tng');
      const title = card.data.folder ? ctx.folderTitle?.(card.data.folder) : undefined;
      // The folder's name inside the sentence, as "Karte prüfen" says it: "Hörbuch: Ordner 04 („Die Olchis“)."
      return info('card-tonuino', card.data.folder === 0 && card.data.mode === ADMIN_MODE ? 'Admin-Karte gelesen' : 'Karte gelesen', title ? `${text.replace(/\.$/, '')} („${title}“).` : text);
    }
  }
}

const MODIFIER_CODES: Record<string, number> = {
  sleepTimer: 1,
  freezeDance: 2,
  FeWaLu: 3,
  toddlerMode: 4,
  kindergarden: 5,
  repeatSingle: 6,
  'bt module': 7,
  jukebox: 8,
  pauseAftTr: 9,
  'std timer': 10,
  endless: 11,
};

function explainModifier(action: 'on' | 'off' | 'toggle', name: string): LineExplanation {
  if (action === 'off') return info('modifier-off', 'Spezialkarte aufgehoben', 'Die Box spielt wieder ganz normal.');
  const mod = modifiersFor('tng').find((m) => m.code === MODIFIER_CODES[name]);
  const label = mod?.name ?? name;
  if (action === 'toggle') return info(`modifier-${name}`, `Spezialkarte: ${label}`, `${label} wurde umgeschaltet.`);
  return info(`modifier-${name}`, `Spezialkarte: ${label}`, mod?.tagline ?? 'Die Spezialkarte ist jetzt aktiv.');
}

function explainWifi(mode: 'station' | 'access-point', ssid: string | undefined, ip: string | undefined): LineExplanation {
  if (mode === 'station') {
    return info('wifi', 'WLAN verbunden', `Die Box ist mit „${ssid ?? '?'}“ verbunden${ip ? ` und unter http://${ip} erreichbar` : ''}.`);
  }
  if (ssid === undefined) {
    return info('wifi-ap', 'Eigenes WLAN aktiv', `Verbinde dich mit dem WLAN „TonUINO“. Dann erreichst du die Box unter http://${ip ?? '192.168.4.1'}.`);
  }
  if (ssid === '') {
    return info('wifi-ap', 'Eigenes WLAN aktiv', 'Es ist noch kein WLAN eingerichtet. Die Box hat ihr eigenes WLAN „TonUINO“ geöffnet.');
  }
  return warn(
    'wifi-failed',
    'WLAN nicht gefunden',
    `Die Box konnte sich nicht mit „${ssid}“ verbinden und hat ihr eigenes WLAN „TonUINO“ geöffnet.`,
    'Verbinde dich mit dem WLAN „TonUINO“, öffne http://192.168.4.1 und prüfe Name und Passwort deines WLANs.',
  );
}

// ---- settings

const SETTING_LABELS: Record<string, string> = {
  Vol: 'Lautstärke',
  'Maximal Volume': 'höchste Lautstärke',
  'Minimal Volume': 'niedrigste Lautstärke',
  'Initial Volume': 'Lautstärke beim Start',
  EQ: 'Klang',
  ST: 'Ausschalt-Timer',
  'Sleep Timer': 'Ausschalt-Timer',
  IB: 'Tastenbelegung',
  'Inverted Volume Buttons': 'Tastenbelegung',
  AL: 'Admin-Menü',
  'Admin Menu locked': 'Admin-Menü',
  AP: 'Admin-PIN',
  'Admin Menu Pin': 'Admin-PIN',
  PCR: 'Karte wegnehmen',
};

function explainSetting(rec: SettingRecord, ctx: ExplainContext): LineExplanation | null {
  const label = SETTING_LABELS[rec.key];
  if (!label) return null; // "Ver", "Version": layout version, nothing to tell
  const id = `setting-${rec.key}`;
  const p = rec.patch;
  const isPin = rec.key === 'AP' || rec.key === 'Admin Menu Pin';

  if (rec.invalid) {
    if (isPin) {
      // Only a problem while the admin menu is locked with a PIN.
      if (ctx.settings?.adminLock && ctx.settings.adminLock.kind !== 'pin') {
        return info(id, 'Admin-PIN', 'Die gespeicherte PIN wird nicht benutzt, weil das Admin-Menü nicht mit PIN gesperrt ist.');
      }
      // No "Box einstellen" button: its steps would start with that very PIN. The reset at power-on gets in without it.
      return warn(
        id,
        'Admin-PIN lässt sich nicht eingeben',
        `Gespeichert ist „${rec.value}“. Eine PIN besteht aus vier Tastendrücken mit Play/Pause, Vor und Zurück.`,
        RESET_SETTINGS,
      );
    }
    return {
      ...warn(
        id,
        `Ungültige Einstellung: ${label}`,
        `Gespeichert ist „${rec.key}: ${rec.value}“. Das ist kein gültiger Wert, vielleicht ist der Speicher der Box durcheinander.`,
        RESET_SETTINGS,
      ),
      fixIn: 'settings',
    };
  }

  if (rec.volumePart) {
    return info(id, 'Lautstärke', `${capitalize(label)}: ${rec.volumePart.value} (von 30).`);
  }
  if (p.speakerVolume) {
    const v = p.speakerVolume;
    const h = p.headphoneVolume;
    const text =
      `Lautsprecher: höchstens ${v.max}, mindestens ${v.min}, beim Einschalten ${v.init}.` +
      (h ? ` Kopfhörer: höchstens ${h.max}, mindestens ${h.min}, beim Einschalten ${h.init}.` : '');
    return info(id, 'Lautstärke', text);
  }
  if (p.eq !== undefined) return info(id, 'Klang', `Klangeinstellung: ${p.eqName ?? EQ_NAMES[p.eq - 1] ?? p.eq}.`);
  if (p.standbyTimerMinutes !== undefined) {
    const off = p.standbyTimerMinutes === 0;
    // An AiO switches itself off only through the timer: without it the battery runs flat.
    if (off && isAio(ctx.board)) {
      return { ...warn(id, 'Ausschalt-Timer ist aus', 'Die Box schaltet sich nie selbst aus.', 'Stelle den Ausschalt-Timer unter „Box einstellen“ ein.'), fixIn: 'settings' };
    }
    const text = off ? 'Aus. Die Box schaltet sich nicht von selbst ab.' : `Die Box schaltet sich nach ${p.standbyTimerMinutes} Minuten ohne Musik von selbst ab.`;
    return info(id, 'Ausschalt-Timer', isEsp32(ctx.board) ? `${text} Ändern kannst du das unter „Box einstellen“. Das geht auch auf der Webseite der Box.` : text);
  }
  if (p.invertVolumeButtons !== undefined) {
    // commands.cpp: with FIVEBUTTONS there is no play_invert, the setting does nothing.
    if (ctx.buttons === '5') {
      return info(id, 'Tastenbelegung', 'Gilt nur bei 3 Tasten. Deine Box hat 5: Vor und Zurück wechseln den Titel, Lauter und Leiser ändern die Lautstärke.');
    }
    return info(
      id,
      'Tastenbelegung',
      p.invertVolumeButtons
        ? 'Bei 3 Tasten: kurz drücken ändert die Lautstärke, lang drücken wechselt den Titel.'
        : 'Bei 3 Tasten: kurz drücken wechselt den Titel, lang drücken ändert die Lautstärke.',
    );
  }
  if (p.adminLock) {
    const texts = {
      none: 'Das Admin-Menü ist nicht gesperrt.',
      card: 'Das Admin-Menü öffnet sich nur mit der Admin-Karte.',
      pin: 'Das Admin-Menü ist mit einer PIN gesperrt.',
      calc: 'Zum Öffnen des Admin-Menüs muss man eine Rechenaufgabe lösen.',
      unknown: 'Unbekannte Sperre.',
    };
    return info(id, 'Admin-Menü', texts[p.adminLock.kind]);
  }
  if (isPin) {
    const pin = p.adminPin ?? splitPin(rec.value);
    return info(id, 'Admin-PIN', pin ? `PIN: ${pin.map((k) => KEY_NAMES[k] ?? String(k)).join(', ')}.` : `PIN: ${rec.value}.`);
  }
  if (p.pauseWhenCardRemoved !== undefined) {
    return info(
      id,
      'Karte wegnehmen',
      p.pauseWhenCardRemoved
        ? 'Nimmt man die Karte weg, hält die Box an.'
        : 'Die Box spielt weiter, auch wenn man die Karte wegnimmt.',
    );
  }
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- buttons and states

/**
 * allLong in words (TNG src/buttons.cpp): Play/Pause, Vor and Zurück held,
 * with five keys also Play/Pause, Lauter and Leiser. The log does not say
 * which of the two it was.
 */
export function allLongLabel(buttons?: BoxButtons): string {
  if (buttons === '3' || buttons === '3x3') return 'Play/Pause + Vor + Zurück lang';
  if (buttons === '5') return 'Play/Pause + Vor + Zurück oder Play/Pause + Lauter + Leiser lang';
  return 'Play/Pause + Vor + Zurück lang (mit 5 Tasten auch Play/Pause + Lauter + Leiser)';
}

/** A raw button event in words, fitted to the keys of the box when they are known. */
export function buttonLabel(raw: string, buttons?: BoxButtons): string {
  return raw === 'allLong' ? allLongLabel(buttons) : (RAW_LABELS[raw] ?? raw);
}

/** Names of the raw button events TNG logs in "btn/cmd: <raw>/<command>" (commands.cpp getCommandRawStr). */
export const RAW_LABELS: Record<string, string> = {
  start: 'Start',
  allLong: allLongLabel(),
  pause: 'Play/Pause kurz',
  pauseLong: 'Play/Pause lang',
  up: 'Vor kurz',
  upLong: 'Vor lang',
  upLongRepeat: 'Vor gehalten',
  down: 'Zurück kurz',
  downLong: 'Zurück lang',
  downLongRepeat: 'Zurück gehalten',
  updownLong: 'Vor und Zurück lang',
  four: 'Lauter kurz',
  fourLong: 'Lauter lang',
  fourLongRepeat: 'Lauter gehalten',
  five: 'Leiser kurz',
  fiveLong: 'Leiser lang',
  fiveLongRepeat: 'Leiser gehalten',
  card_from_web: 'Karte aus der Weboberfläche',
  // "WRITECARD" over USB (SerialWriteCard build, TNG branch issue_345)
  w_c_c_ser: 'Karte schreiben über USB',
};

/** What the box does for a button, by the command name of "btn/cmd" (commands.cpp getCommandStr). */
export const COMMAND_LABELS: Record<string, string> = {
  admin: 'Admin-Menü öffnen',
  shutdown: 'ausschalten',
  shortcut1: 'Kurzwahl 1',
  shortcut2: 'Kurzwahl 2',
  shortcut3: 'Kurzwahl 3',
  start: 'Start',
  pause: 'Play/Pause',
  track: 'Titelnummer ansagen',
  volume_up: 'lauter',
  volume_down: 'leiser',
  bright_up: 'Licht heller',
  bright_down: 'Licht dunkler',
  to_first: 'zum ersten Titel',
  next: 'nächster Titel',
  next10: '10 Titel vor',
  previous: 'voriger Titel',
  previous10: '10 Titel zurück',
  select: 'auswählen',
  menu_jump: 'Menüsprung',
  adm_end: 'Admin-Menü verlassen',
  card_from_web: 'Karte aus der Weboberfläche abspielen',
  write_card_from_web: 'Karte aus der Weboberfläche schreiben',
  w_c_c_ser: 'Karte über USB schreiben (Befehl der App)',
};

const STATES: Record<string, [string, string]> = {
  Idle: ['Bereit', 'Die Box wartet auf eine Karte.'],
  StartPlay: ['Wiedergabe startet', 'Die Box beginnt zu spielen.'],
  Play: ['Wiedergabe', 'Die Box spielt.'],
  Pause: ['Pause', 'Die Wiedergabe ist angehalten.'],
  AdmEntry: ['Admin-Menü', 'Das Admin-Menü ist offen.'],
  AdmNCard: ['Neue Karte einrichten', 'Die Box führt per Ansage durch das Einrichten der Karte.'],
  AdmREeprom: ['Zurücksetzen', 'Die Einstellungen werden auf Werkseinstellung zurückgesetzt.'],
  Quiz: ['Quiz', 'Das Quiz-Spiel startet.'],
  Memory: ['Memory', 'Das Memory-Spiel startet.'],
  Teapot: ['Teekesselchen', 'Das Teekesselchen-Spiel startet.'],
};
