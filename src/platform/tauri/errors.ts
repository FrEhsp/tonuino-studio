/**
 * Errors of the desktop bridge. Rust returns stable codes; here they become
 * Error objects with a `code` and a German message (Du-Form) that says what
 * happened and what to do now.
 */

/**
 * Where an error happened, which decides its wording: fs = SD card or a
 * folder used like one, save = exporting a generated file, dialog = picking
 * or dropping files, remount = "Schreibrechte holen" (mounting the card
 * again for this user), app = everything else.
 */
export type ErrorArea = 'fs' | 'volume' | 'remount' | 'serial' | 'nfc' | 'audio' | 'http' | 'dialog' | 'save' | 'speech' | 'print' | 'app';

export interface HintInfo {
  id: string;
  /** German explanation. */
  text: string;
  /** Extra facts, e.g. the device path. */
  detail?: string;
  /** Command to paste into a terminal. */
  command?: string;
}

export class TauriPlatformError extends Error {
  readonly code: string;
  /** Technical detail from the backend, for logs and support. */
  readonly detail?: string;
  /** Follow-up advice (ids with German text). */
  readonly hints: HintInfo[];

  constructor(code: string, message: string, detail?: string, hints: HintInfo[] = []) {
    super(message);
    this.name = code === 'cancelled' ? 'AbortError' : 'TauriPlatformError';
    this.code = code;
    this.detail = detail;
    this.hints = hints;
  }
}

const AREA_MESSAGES: Record<string, string> = {
  'fs:not-found': 'Die Datei oder der Ordner wurde nicht gefunden. Prüfe, ob die SD-Karte noch steckt, und versuche es noch einmal.',
  'fs:permission':
    'Ich darf hier nichts ändern, denn deinem Benutzerkonto fehlen die Schreibrechte für die SD-Karte oder den Ordner. Unter „Meine Box“ steht, wie du sie bekommst.',
  'fs:busy': 'Die Datei wird gerade von einem anderen Programm benutzt. Schließe andere Programme und versuche es noch einmal.',
  'fs:no-space': 'Auf der SD-Karte ist kein Platz mehr frei. Lösche etwas oder nimm eine größere Karte.',
  'fs:read-only': 'Die SD-Karte ist schreibgeschützt. Schiebe den kleinen Schalter an der Seite der Karte nach oben und stecke sie neu ein.',
  'fs:exists': 'Es gibt schon eine Datei mit diesem Namen. Wähle einen anderen Namen.',
  'fs:not-empty': 'Der Ordner ist nicht leer. Lösche zuerst seinen Inhalt.',
  'fs:invalid-name': 'Der Name enthält Zeichen, die auf der SD-Karte nicht erlaubt sind. Wähle einen einfacheren Namen.',
  'fs:io': 'Die SD-Karte antwortet nicht. Wurde sie herausgezogen? Stecke sie neu ein und versuche es noch einmal.',
  'fs:not-a-file': 'Hier liegt ein Ordner statt einer Datei. Prüfe den Namen.',
  'fs:not-a-directory': 'Hier liegt eine Datei statt eines Ordners. Prüfe den Namen.',
  'fs:cross-device': 'Verschieben geht nur innerhalb derselben SD-Karte.',
  'fs:not-allowed': 'Auf diesen Ort darf TonUINO Studio nicht zugreifen. Wähle die SD-Karte oder den Ordner über „Auswählen“ aus.',
  'fs:too-many-files': 'Der Ordner enthält zu viele Dateien. Wähle einen kleineren Ordner.',
  'fs:source-changed': 'Die Quelldatei hat sich während des Kopierens verändert. Versuche es noch einmal.',
  'volume:busy': 'Die SD-Karte wird noch benutzt. Schließe Fenster und Programme, die auf die Karte zugreifen, und versuche es noch einmal.',
  'volume:unsupported': 'Diese Karte kann ich nicht auswerfen. Wirf sie über den Dateimanager aus.',
  'volume:permission': 'Zum Auswerfen fehlt die Berechtigung. Wirf die Karte über den Dateimanager aus.',
  'volume:not-found': 'Die SD-Karte ist nicht mehr da. Vielleicht wurde sie schon entfernt.',
  'remount:busy':
    'Die Karte wird gerade benutzt. Schließe Fenster und Programme, die auf die Karte zugreifen, zum Beispiel den Dateimanager, und versuche es noch einmal.',
  'remount:permission': 'Das System hat es nicht erlaubt. Wirf die Karte im Dateimanager aus, ziehe sie heraus und stecke sie neu ein.',
  'remount:unsupported': 'Das kann ich auf diesem Computer nicht. Wirf die Karte im Dateimanager aus, ziehe sie heraus und stecke sie neu ein.',
  'remount:unchanged':
    'Die Karte ist neu eingebunden, aber ich darf immer noch nichts ändern. Wirf die Karte im Dateimanager aus, ziehe sie heraus und stecke sie neu ein. Hilft das nicht, steht in der Hilfe, was du noch tun kannst.',
  'remount:read-only': 'Die SD-Karte ist schreibgeschützt. Schiebe den kleinen Schalter an der Seite der Karte nach oben und stecke sie neu ein.',
  'remount:not-found': 'Die SD-Karte ist nicht mehr da. Stecke sie neu ein.',
  'remount:other': 'Das hat nicht geklappt. Wirf die Karte im Dateimanager aus, ziehe sie heraus und stecke sie neu ein.',
  'volume:not-allowed': 'Auf diesen Ort darf TonUINO Studio nicht zugreifen. Wähle die SD-Karte oder den Ordner über „Auswählen“ aus.',
  'serial:permission': 'Ich darf noch nicht auf die Box zugreifen. Richte den USB-Zugriff einmalig ein, dann klappt es.',
  'serial:busy': 'Die Box wird gerade von einem anderen Programm benutzt, zum Beispiel von der Arduino-IDE. Schließe es und versuche es noch einmal.',
  'serial:not-found': 'Die Box wurde nicht gefunden. Prüfe das USB-Kabel und stecke die Box neu ein.',
  'serial:disconnected': 'Die Verbindung zur Box ist abgebrochen. Prüfe das USB-Kabel und stecke die Box neu ein.',
  'serial:closed': 'Die Verbindung zur Box ist schon geschlossen. Verbinde dich neu.',
  'serial:cancelled': 'Die Einrichtung wurde abgebrochen. Du kannst sie jederzeit wiederholen.',
  'serial:unsupported': 'Das ist auf diesem System nicht nötig.',
  'nfc:pcsc-unavailable': 'Der Dienst für NFC-Leser läuft nicht. Installiere ihn und den Treiber für deinen Leser, die Hinweise zeigen wie.',
  'nfc:no-reader': 'Kein NFC-Leser gefunden. Stecke den Leser ein und warte einen Moment.',
  'nfc:no-card': 'Keine Karte auf dem Leser. Lege die Karte mittig auf den Leser und lasse sie liegen.',
  'nfc:auth-failed': 'Die Karte ist gesperrt: Ihr Schlüssel wurde geändert, zum Beispiel von einer Handy-App. Nimm eine andere Karte.',
  'nfc:unsupported-card': 'Diese Karte passt nicht zur TonUINO-Box. Nimm eine MIFARE-Classic- oder NTAG-Karte.',
  'nfc:write-failed': 'Die Karte konnte nicht beschrieben werden. Lasse sie ruhig liegen und versuche es noch einmal.',
  'nfc:verify-failed': 'Beim Prüfen stand etwas anderes auf der Karte. Lasse sie ruhig liegen und schreibe sie noch einmal.',
  'nfc:read-failed': 'Die Karte konnte nicht gelesen werden. Lasse sie ruhig liegen und versuche es noch einmal.',
  'nfc:busy': 'Der NFC-Leser wird gerade von einem anderen Programm benutzt. Schließe es und versuche es noch einmal.',
  'audio:unsupported-format': 'Dieses Audioformat kann ich nicht lesen. Wandle die Datei zum Beispiel in MP3 um.',
  'audio:decode-failed': 'Die Audiodatei ist beschädigt oder unvollständig. Versuche es mit einer anderen Datei.',
  'audio:not-found': 'Die Audiodatei wurde nicht gefunden. Wurde sie verschoben oder gelöscht?',
  'audio:closed': 'Die Audiodatei ist schon geschlossen.',
  'audio:no-audio': 'In dieser Datei ist kein Ton. Wähle eine andere Datei.',
  'audio:drm-protected':
    'Diese Datei ist kopiergeschützt (zum Beispiel von Audible oder iTunes). Solche Dateien kann ich nicht öffnen. Nimm eine Datei ohne Kopierschutz.',
  'audio:io': 'Die Audiodatei konnte nicht gelesen werden. Prüfe, ob sie noch da ist, und versuche es noch einmal.',
  'audio:permission': 'Die Audiodatei darf nicht gelesen werden. Prüfe ihre Berechtigungen oder kopiere sie an einen anderen Ort.',
  'http:timeout': 'Die Box antwortet nicht. Prüfe, ob sie eingeschaltet und im selben WLAN ist.',
  'http:unreachable': 'Die Box ist nicht erreichbar. Prüfe, ob sie eingeschaltet und im selben WLAN ist.',
  'http:not-allowed': 'Diese Adresse liegt nicht im Heimnetz. Ich spreche nur mit Boxen im eigenen WLAN.',
  'http:bad-response': 'Die Box hat unverständlich geantwortet. Starte sie neu und versuche es noch einmal.',
  'http:invalid-argument': 'Die Adresse ist ungültig. Prüfe die Schreibweise.',
  'audio:no-space': 'Auf dem Computer ist nicht genug Platz frei, um die Audiodatei zu bearbeiten. Gib Platz frei und versuche es noch einmal.',
  'audio:source-changed': 'Die Audiodatei hat sich während des Lesens verändert. Versuche es noch einmal.',
  'audio:no-device': 'Am Computer ist gerade kein Lautsprecher und kein Kopfhörer zu finden. Schließe einen an und klicke noch einmal auf Abspielen.',
  'audio:output-failed': 'Der Ton kommt gerade nicht beim Lautsprecher an. Schaue, ob Lautsprecher oder Kopfhörer richtig dran sind, und klicke noch einmal auf Abspielen.',
  'audio:device-lost': 'Der Kopfhörer oder Lautsprecher ist weg, darum hab ich angehalten. Klicke wieder auf Abspielen, dann geht es an derselben Stelle weiter.',
  'save:permission': 'Hier darf die Datei nicht gespeichert werden. Wähle einen anderen Ordner.',
  'save:read-only': 'Dieser Ort ist schreibgeschützt. Wähle einen anderen Ordner.',
  'save:no-space': 'Auf dem Laufwerk ist kein Platz mehr frei. Wähle einen anderen Ort oder gib Platz frei.',
  'save:busy': 'Die Datei ist gerade in einem anderen Programm geöffnet. Schließe sie dort und versuche es noch einmal.',
  'save:not-found': 'Der Ordner wurde nicht gefunden. Wähle einen anderen Ort.',
  'save:invalid-name': 'Der Dateiname enthält Zeichen, die hier nicht erlaubt sind. Wähle einen einfacheren Namen.',
  'save:not-a-file': 'Unter diesem Namen gibt es schon einen Ordner. Wähle einen anderen Namen.',
  'save:io': 'Das Laufwerk antwortet nicht. Prüfe, ob es noch angeschlossen ist, und versuche es noch einmal.',
  'app:not-allowed': 'Diese Adresse kann ich nicht öffnen.',
  'speech:no-voice': 'Auf diesem Computer ist keine Stimme für die Sprachausgabe eingerichtet.',
  'speech:failed': 'Die Stimme des Computers hat nichts gesagt. Versuche es noch einmal.',
  'speech:timeout': 'Die Stimme des Computers hat zu lange gebraucht. Versuche es noch einmal.',
  'speech:invalid-argument': 'Da ist nichts zum Ansagen. Gib dem Titel zuerst einen Namen.',
  'print:no-printer': 'An diesem Computer ist kein Drucker eingerichtet. Richte ihn in den Einstellungen des Computers ein, oder speichere das PDF.',
  'print:failed': 'Der Drucker hat den Auftrag nicht angenommen. Schaue, ob er eingeschaltet ist, und versuche es noch einmal.',
  'print:timeout': 'Der Drucker hat zu lange nicht geantwortet. Schaue, ob er eingeschaltet ist, und versuche es noch einmal.',
  'print:no-space': 'Auf dem Computer ist nicht genug Platz frei für den Druck. Gib Platz frei und versuche es noch einmal.',
  'dialog:other': 'Das Auswahlfenster ließ sich nicht öffnen. Versuche es noch einmal.',
  'dialog:not-allowed': 'Diese Datei darf TonUINO Studio nicht öffnen. Wähle sie über „Auswählen“ aus.',
  'dialog:not-found': 'Die gewählte Datei oder der Ordner ist nicht mehr da. Wähle sie noch einmal aus.',
  'dialog:permission': 'Die gewählte Datei darf nicht gelesen werden. Prüfe ihre Berechtigungen oder kopiere sie an einen anderen Ort.',
  'dialog:too-many-files': 'Der Ordner enthält zu viele Dateien. Wähle einen kleineren Ordner.',
};

const GENERIC_MESSAGES: Record<string, string> = {
  cancelled: 'Abgebrochen.',
  'not-allowed': 'Das darf TonUINO Studio nicht. Wähle den Ort über „Auswählen“ aus.',
  'not-found': 'Das wurde nicht gefunden. Prüfe, ob alles eingesteckt ist, und versuche es noch einmal.',
  permission: 'Dafür fehlt die Berechtigung. Prüfe die Einstellungen und versuche es noch einmal.',
  busy: 'Das wird gerade von einem anderen Programm benutzt. Schließe es und versuche es noch einmal.',
  unsupported: 'Das geht auf diesem System leider nicht.',
  'invalid-argument': 'Interner Fehler: ungültige Angabe. Bitte melde das Problem.',
  'no-space': 'Der Speicher ist voll. Gib Platz frei und versuche es noch einmal.',
  'read-only': 'Dieser Ort ist schreibgeschützt. Wähle einen anderen Ort.',
  io: 'Das Gerät antwortet nicht. Prüfe, ob es noch angeschlossen ist, und versuche es noch einmal.',
  timeout: 'Es kam keine Antwort. Versuche es noch einmal.',
  other: 'Etwas ist schiefgelaufen. Versuche es noch einmal.',
};

const HINT_TEXTS: Record<string, string> = {
  'linux-brltty':
    'Das Programm „brltty“ (für Braillezeilen) belegt den USB-Anschluss der Box. Wenn du keine Braillezeile benutzt, schalte es mit diesem Befehl ab und stecke die Box neu ein:',
  'linux-serial-permission':
    'Dein Benutzerkonto darf nicht auf USB-Seriell-Geräte zugreifen. Richte den USB-Zugriff einmalig in der App ein oder füge dich mit diesem Befehl der passenden Gruppe hinzu und melde dich neu an:',
  'linux-modemmanager':
    'Der ModemManager prüft neue USB-Geräte und blockiert die Box dabei einige Sekunden. Die einmalige USB-Einrichtung der App verhindert das.',
  'linux-install-pcscd': 'Für den NFC-Leser fehlt der Dienst „pcscd“. Installiere ihn mit diesem Befehl:',
  'linux-blacklist-pn533':
    'Ein Linux-Treiber (pn533) belegt den ACR122U-Leser. Sperre ihn mit diesem Befehl, dann kann ich den Leser benutzen:',
  'linux-install-ccid': 'Für den NFC-Leser fehlt der Treiber. Installiere ihn mit diesem Befehl:',
  'linux-start-pcscd': 'Der Dienst für NFC-Leser ist nicht gestartet. Starte ihn mit diesem Befehl:',
  'card-ndef-formatted':
    'Eine Handy-App hat die Karte „formatiert“ und dabei ihren Schlüssel geändert. Die TonUINO-Box kann sie so nicht lesen. Nimm eine neue Karte.',
  'card-keys-changed': 'Der Schlüssel der Karte wurde geändert. Die TonUINO-Box kann sie so nicht lesen. Nimm eine neue Karte.',
};

/**
 * Terminal commands for hints that arrive with an error (the diagnose
 * commands send their own, which take precedence). Same text as the backend.
 */
const HINT_COMMANDS: Record<string, string> = {
  'linux-brltty': 'sudo apt remove brltty',
  'linux-serial-permission': 'sudo usermod -aG dialout $USER',
  'linux-install-pcscd': 'sudo apt install pcscd libacsccid1',
  'linux-blacklist-pn533':
    "printf 'blacklist pn533_usb\\nblacklist pn533\\nblacklist nfc\\n' | sudo tee /etc/modprobe.d/blacklist-acr122u.conf && sudo modprobe -r pn533_usb pn533 nfc; sudo systemctl restart pcscd",
  'linux-install-ccid': 'sudo apt install libacsccid1',
  'linux-start-pcscd': 'sudo systemctl enable --now pcscd.socket',
};

export function messageFor(code: string, area: ErrorArea): string {
  const key = `${area}:${code}`;
  return AREA_MESSAGES[key] ?? GENERIC_MESSAGES[code] ?? GENERIC_MESSAGES.other;
}

export function hintText(id: string): string {
  return HINT_TEXTS[id] ?? id;
}

export function hintInfo(raw: { id: string; detail?: string | null; command?: string | null }): HintInfo {
  const command = raw.command ?? HINT_COMMANDS[raw.id];
  return {
    id: raw.id,
    text: hintText(raw.id),
    ...(raw.detail ? { detail: raw.detail } : {}),
    ...(command ? { command } : {}),
  };
}

export function platformError(code: string, area: ErrorArea, detail?: string, hintIds: string[] = []): TauriPlatformError {
  return new TauriPlatformError(code, messageFor(code, area), detail, hintIds.map((id) => hintInfo({ id })));
}

export function abortError(): TauriPlatformError {
  return platformError('cancelled', 'app', 'aborted');
}

/** What to throw for an aborted signal: its reason, like `signal.throwIfAborted()`. */
export function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? abortError();
}

interface BackendError {
  code: string;
  detail?: string;
  hints?: string[];
}

function isBackendError(e: unknown): e is BackendError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}

/** Turns whatever `invoke` rejected with into a TauriPlatformError. */
export function toPlatformError(e: unknown, area: ErrorArea): TauriPlatformError {
  if (e instanceof TauriPlatformError) return e;
  if (isBackendError(e)) {
    return platformError(e.code, area, e.detail, Array.isArray(e.hints) ? e.hints : []);
  }
  const detail = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  return platformError('other', area, detail);
}
