/**
 * "Computer findet die Box nicht": the usual reasons why a computer does not see
 * a TonUINO box over USB, ordered for the system the app runs on. Plain
 * data, so the page stays thin and the choice of sections is tested.
 * A browser without USB access gets that one answer first; the fixes for the
 * system wait folded until a browser with USB access or the desktop app is
 * in use.
 */
import { CH340_DRIVER_URLS } from '../../core/firmware/variants';
import type { Platform } from '../../platform/types';
import type { RankedPort } from './ports';

export interface HelpStep {
  text: string;
  /** A command to paste into a terminal. */
  command?: string;
}

export type HelpAction = { kind: 'setup-access'; label: string } | { kind: 'link'; label: string; url: string };

export interface HelpSection {
  id: string;
  title: string;
  /** When this applies, in one or two sentences. */
  intro: string;
  steps: HelpStep[];
  action?: HelpAction;
  /** Only with commands in a terminal (Linux): the page folds it away behind the simple steps (Prüfrunde 1 B6). */
  terminal?: boolean;
}

export interface HelpContext {
  os: Platform['os'];
  kind: Platform['kind'];
  /** The browser or app can talk to USB serial devices at all. */
  serialSupported: boolean;
  /** The desktop app can set up USB access itself (Linux). */
  canSetupAccess: boolean;
  /** The browser first asks whether it may add an add-on for USB access (Firefox). */
  mayAskForAddon?: boolean;
  /** The Android app: the box hangs at the phone (USB-OTG). */
  phone?: boolean;
}

const SETUP_ACCESS: HelpAction = { kind: 'setup-access', label: 'USB-Zugriff einrichten' };

function browserSection(): HelpSection {
  return {
    id: 'browser',
    title: 'Dieser Browser kann nicht mit der Box sprechen',
    intro: 'Safari und ältere Firefox-Versionen erlauben Webseiten keinen Zugriff auf USB-Geräte. Handys und Tablets können das auch nicht.',
    steps: [
      { text: 'Öffne TonUINO Studio in Firefox ab Version 151, Google Chrome oder Microsoft Edge auf einem Computer.' },
      { text: 'Oder nimm die Desktop-App für Windows und Linux.' },
    ],
  };
}

/** Firefox asks before the first USB access whether it may add an add-on of its own. */
function firefoxSection(ctx: HelpContext): HelpSection {
  const steps: HelpStep[] = [
    { text: 'Beim ersten Mal fragt Firefox, ob er ein Add-on hinzufügen darf. Dieses Add-on erzeugt Firefox selbst. Die Warnung dabei zeigt er bei jeder Seite mit USB-Zugriff.' },
    { text: 'Klicke auf „Installation fortsetzen“, dann auf „Hinzufügen“ und danach auf „Erlauben“. Dann zeigt Firefox die Geräte zur Auswahl.' },
    {
      text: 'Hast du einmal „Nie erlauben“ gewählt, kommt keine Frage mehr. Klicke dann links in der Adressleiste auf das Schloss, entferne bei den Berechtigungen die Sperre und lade die Seite neu.',
    },
    { text: 'Nach dem Neuladen der Seite vergisst Firefox die Box. Wähle sie dann einfach noch einmal aus.' },
  ];
  if (ctx.os === 'linux') {
    steps.push(
      { text: 'Unter Linux zeigt Firefox nur Anschlüsse, auf die du Zugriff hast. Fehlt die Box, richte den Zugriff ein, wie unter „Linux: Zugriff auf den USB-Anschluss fehlt“ beschrieben.' },
      { text: 'Firefox aus dem Snap-Paket (Ubuntu) sieht keine USB-Geräte. Nimm dort Chrome oder die Desktop-App.' },
    );
  }
  return {
    id: 'firefox',
    title: 'Fragt der Browser nach einem Add-on?',
    intro: 'Firefox kann ab Version 151 mit der Box sprechen. Vorher fragt er einmal, ob er das für diese Seite darf. Fragt dein Browser nicht, kannst du diesen Teil überspringen.',
    steps,
  };
}

function linuxSections(ctx: HelpContext): HelpSection[] {
  const desktop = ctx.kind === 'desktop' && ctx.canSetupAccess;
  return [
    {
      id: 'linux-access',
      title: 'Linux: Zugriff auf den USB-Anschluss fehlt',
      intro: 'Unter Linux dürfen Programme erst auf USB-Seriell-Geräte zugreifen, wenn du es einmal erlaubst. Typisch ist die Meldung „Kein Zugriff“ oder „Permission denied“.',
      steps: desktop
        ? [
            { text: 'Klicke auf „USB-Zugriff einrichten“. Der Computer fragt nach deinem Passwort.' },
            { text: 'Stecke die Box danach neu ein.' },
            { text: 'Ohne Passwort-Abfrage geht es auch im Terminal. Melde dich danach einmal ab und wieder an:', command: 'sudo usermod -aG dialout $USER' },
          ]
        : [
            { text: 'Füge dein Benutzerkonto im Terminal der Gruppe „dialout“ hinzu:', command: 'sudo usermod -aG dialout $USER' },
            { text: 'Bei Arch Linux und Manjaro heißt die Gruppe „uucp“ statt „dialout“.' },
            { text: 'Melde dich danach einmal ab und wieder an, dann gilt es.' },
            // Snap confinement: Chromium has no serial-port plug (forum.snapcraft.io 31139); Firefox is covered in its own section.
            ...(ctx.kind === 'web' ? [{ text: 'Chromium aus dem Snap-Paket (Ubuntu) sieht keine USB-Geräte. Nimm dort Google Chrome von google.com oder die Desktop-App.' }] : []),
          ],
      action: desktop ? SETUP_ACCESS : undefined,
      terminal: !desktop,
    },
    {
      id: 'linux-brltty',
      title: 'Linux: Die Box taucht auf und ist gleich wieder weg',
      intro: 'Unter Ubuntu und Linux Mint schnappt sich das Programm „brltty“ (für Braillezeilen) den USB-Chip CH340 vieler Boxen.',
      steps: [
        { text: 'Brauchst du keine Braillezeile, entferne das Programm:', command: 'sudo apt remove brltty' },
        // Pop!_OS: the desktop package depends on brltty, so apt would take the desktop along (Arduino help center).
        { text: 'Bei Pop!_OS entfernst du es nicht, sonst verschwindet die Arbeitsoberfläche mit. Schalte es dort so ab:', command: BRLTTY_MASK },
        { text: 'Bei Fedora heißt der Befehl „sudo dnf remove brltty“.' },
        { text: 'Stecke die Box danach neu ein.' },
      ],
      terminal: true,
    },
    {
      id: 'linux-modemmanager',
      title: 'Linux: Es klappt erst beim zweiten Versuch',
      intro: 'Der ModemManager prüft jedes neue USB-Gerät, ob es ein Modem ist, und blockiert es dabei einige Sekunden.',
      steps: desktop
        ? [{ text: 'Die einmalige USB-Einrichtung der App verhindert das.' }, { text: 'Sonst: Warte nach dem Einstecken etwa zehn Sekunden.' }]
        : [
            { text: 'Warte nach dem Einstecken etwa zehn Sekunden.' },
            { text: 'Benutzt du kein Mobilfunk-Modem, kannst du den ModemManager abschalten:', command: 'sudo systemctl disable --now ModemManager' },
          ],
      action: desktop ? SETUP_ACCESS : undefined,
      terminal: !desktop,
    },
  ];
}

/** Keeps brltty's udev rules from running without removing the package (Pop!_OS); the same command as src-tauri/src/serial.rs. */
const BRLTTY_MASK = 'for f in /usr/lib/udev/rules.d/*brltty*.rules; do sudo ln -sf /dev/null "/etc/udev/rules.d/$(basename "$f")"; done; sudo udevadm control --reload-rules';

/** What to click on the WCH download page, which is in English. */
const WCH_PAGE = 'Die Seite des Herstellers WCH ist auf Englisch. Klicke dort auf den Knopf „Download“.';

function windowsSections(ctx: HelpContext): HelpSection[] {
  return [
    {
      id: 'windows-driver',
      title: 'Windows: Treiber für den USB-Chip CH340',
      intro: 'Viele Nano-Nachbauten und die AiO+ haben den USB-Chip CH340. Windows erkennt ihn oft erst mit dem Treiber des Herstellers WCH. Die AiO (Version 1) braucht keinen Treiber.',
      steps: [
        { text: `Klicke unten auf „CH340-Treiber herunterladen“. ${WCH_PAGE}` },
        { text: 'Starte die heruntergeladene Datei „CH341SER.EXE“ und klicke im Fenster auf „INSTALL“.' },
        { text: 'Stecke die Box danach neu ein.' },
      ],
      action: { kind: 'link', label: 'CH340-Treiber herunterladen', url: CH340_DRIVER_URLS.windows },
    },
    {
      id: 'windows-device-manager',
      title: 'Windows: Im Geräte-Manager nachsehen',
      intro: 'Der Geräte-Manager zeigt, ob Windows die Box überhaupt sieht.',
      steps: [
        { text: 'Drücke die Windows-Taste, tippe „Geräte-Manager“ und öffne ihn.' },
        { text: 'Klappe „Anschlüsse (COM & LPT)“ auf. Beim Einstecken der Box erscheint dort ein Eintrag wie „USB-SERIAL CH340 (COM3)“.' },
        { text: 'Steht die Box unter „Andere Geräte“ mit gelbem Warnzeichen, fehlt der Treiber.' },
        { text: 'Erscheint gar nichts, liegt es meist am USB-Kabel.' },
      ],
    },
    {
      // The fix from the FAQ of the TonUINO forum (thread 13551): the newest CH340 driver needs SerEnum switched on.
      id: 'windows-open',
      title: 'Windows: Die Box ist da, lässt sich aber nicht öffnen',
      intro:
        'Der Geräte-Manager zeigt die Box unter „Anschlüsse (COM & LPT)“, aber TonUINO Studio meldet, dass sich der Anschluss nicht öffnen lässt. Andere Seiten melden dann „Failed to open serial port“.',
      steps: [
        { text: 'Schließe die Arduino IDE, andere Programme mit seriellem Monitor (auch Cura) und andere Browser-Tabs mit TonUINO-Seiten.' },
        { text: 'Öffne den Geräte-Manager und klappe „Anschlüsse (COM & LPT)“ auf. Steht dort „USB-SERIAL CH340“, klicke doppelt darauf.' },
        {
          text: 'Wähle den Reiter „Anschlusseinstellungen“ und klicke auf „Erweitert …“. Setze den Haken bei „Enabling the Serial Port Enumerator (SerEnum)“ und bestätige mit „OK“. Diese Einstellung braucht der neueste CH340-Treiber.',
        },
        { text: 'Ziehe die Box ab, stecke sie wieder ein und versuche es noch einmal.' },
        { text: 'Fehlt der Haken, installiere zuerst den aktuellen CH340-Treiber (siehe oben) und starte Windows danach neu.' },
        ...(ctx.kind === 'web' ? [{ text: 'Klappt es im Browser weiter nicht, nimm die Desktop-App von TonUINO Studio. Sie öffnet den Anschluss ohne den Browser.' }] : []),
      ],
    },
  ];
}

function macSections(): HelpSection[] {
  return [
    {
      id: 'macos-driver',
      title: 'Mac: Treiber auf älteren macOS-Versionen',
      intro: 'Neuere Macs erkennen den USB-Chip CH340 von selbst. Ältere macOS-Versionen brauchen einmalig den Treiber des Herstellers WCH.',
      steps: [
        { text: `Klicke unten auf „CH340-Treiber für Mac herunterladen“. ${WCH_PAGE}` },
        { text: 'Öffne die heruntergeladene ZIP-Datei und installiere den Treiber darin.' },
        { text: 'Erlaube ihn, wenn macOS in den Systemeinstellungen danach fragt („Datenschutz & Sicherheit“).' },
        { text: 'Starte den Mac neu und stecke die Box ein.' },
      ],
      action: { kind: 'link', label: 'CH340-Treiber für Mac herunterladen', url: CH340_DRIVER_URLS.macos },
    },
  ];
}

function commonSections(ctx: HelpContext): HelpSection[] {
  const sections: HelpSection[] = [
    {
      id: 'cable',
      title: 'Nur ein Ladekabel?',
      intro: 'Viele USB-Kabel laden nur und übertragen keine Daten. Dann passiert beim Einstecken gar nichts.',
      steps: [
        { text: 'Nimm ein anderes Kabel, am besten eins, mit dem schon Daten übertragen wurden, zum Beispiel Fotos vom Handy.' },
        { text: 'Stecke das Kabel an beiden Enden fest ein.' },
      ],
    },
    {
      id: 'hub',
      title: 'USB-Hub oder Dockingstation',
      intro: 'Hubs und Dockingstationen liefern manchmal zu wenig Strom oder stören die Verbindung.',
      steps: [{ text: 'Stecke die Box direkt am Computer ein.' }, { text: 'Probiere einen anderen USB-Anschluss am Computer.' }],
    },
    {
      id: 'busy',
      title: 'Ein anderes Programm benutzt die Box',
      intro: 'Die Box kann immer nur mit einem Programm sprechen.',
      steps: [
        { text: 'Schließe die Arduino IDE und andere Programme mit seriellem Monitor, auch 3D-Drucker-Programme wie Cura.' },
        { text: 'Schließe andere Browser-Tabs und Fenster mit TonUINO-Seiten.' },
      ],
    },
  ];
  if (ctx.kind === 'web' && ctx.serialSupported) {
    sections.push({
      id: 'chooser',
      title: 'Die Box fehlt im Auswahlfenster des Browsers',
      intro: 'Der Browser zeigt nur Geräte, die er gerade sieht. Manche USB-Chips vergisst er nach dem Abziehen.',
      steps: [
        { text: 'Stecke die Box ein, bevor du auf „Box verbinden …“ klickst.' },
        { text: 'Hast du die Box neu eingesteckt, wähle sie einfach noch einmal aus.' },
        { text: 'Fehlt sie weiter, klicke auf „Alle USB-Geräte zeigen“. Prüfe sonst Kabel und Treiber.' },
      ],
    });
  }
  return sections;
}

export interface UsbHelp {
  /** What helps here and now, most likely cause first. */
  sections: HelpSection[];
  /**
   * Fixes that matter only once the browser can talk to USB devices
   * (Chrome, Edge, Firefox from 151 or the desktop app). The page folds them away, so a
   * Firefox user does not start with Linux commands that cannot help.
   */
  later: HelpSection[];
}

/** The Android app: the box at the phone's USB socket (src/platform/tauri/androidUsb.ts). */
function phoneSections(): HelpSection[] {
  return [
    {
      id: 'otg',
      title: 'Box und Handy richtig verbinden',
      intro: 'Das Handy braucht ein Kabel oder einen Adapter, bei dem es selbst das USB-Gerät steuert (USB-OTG).',
      steps: [
        { text: 'Nimm ein Kabel von USB-C auf Micro-USB, oder einen kleinen Adapter von USB-C auf USB-A und das Kabel der Box.' },
        { text: 'Ein Kabel, mit dem du sonst das Handy am Computer lädst, geht dafür meist nicht.' },
        // OxygenOS/ColorOS switch OTG off after ten idle minutes (XDA, OnePlus); Xiaomi has the switch under Weitere Einstellungen (techbone.de).
        { text: 'Manche Handys, etwa von OnePlus, Oppo, Realme und Xiaomi, brauchen dafür den Schalter „OTG“ in den Einstellungen. Bei manchen schaltet er sich nach einer Weile ohne Gerät von selbst wieder aus.' },
      ],
    },
    {
      id: 'allow',
      title: 'Das Handy fragt, ob es die Box benutzen darf',
      intro: 'Beim ersten Verbinden fragt Android, ob TonUINO Studio auf das USB-Gerät zugreifen darf.',
      steps: [
        { text: 'Tipp bei der Frage auf „Zulassen“.' },
        { text: 'Hast du „Abbrechen“ getippt, stecke die Box aus und wieder ein und verbinde sie noch einmal.' },
      ],
    },
    {
      id: 'chip',
      title: 'Welche Boxen das Handy kennt',
      intro: 'Am Handy spreche ich selbst mit dem USB-Chip der Box. Ich kenne die Chips CH340 und CH341, FTDI FT232R, CP2102 und Boxen mit eigenem USB.',
      steps: [{ text: 'Hat deine Box einen anderen Chip, geht es am Computer mit der Desktop-App oder in Chrome und Edge.' }],
    },
    {
      id: 'power',
      title: 'Zu wenig Strom',
      intro: 'Manche Handys geben über USB nur wenig Strom ab. Eine Box mit Lautsprecher und Lichtern startet dann immer wieder neu.',
      steps: [{ text: 'Schalte die Box über ihren eigenen Akku oder ihr Netzteil ein, dann braucht sie vom Handy nur die Daten.' }],
    },
  ];
}

/** The sections for this system. */
export function usbHelp(ctx: HelpContext): UsbHelp {
  if (ctx.phone) {
    const cable = commonSections(ctx).filter((s) => s.id === 'cable');
    const all = [...phoneSections(), ...cable];
    return ctx.serialSupported ? { sections: all, later: [] } : { sections: [browserSection()], later: all };
  }
  const system: HelpSection[] = [];
  if (ctx.os === 'linux') system.push(...linuxSections(ctx));
  else if (ctx.os === 'windows') system.push(...windowsSections(ctx));
  else if (ctx.os === 'macos') system.push(...macSections());
  else system.push(...windowsSections(ctx), ...macSections());
  // The simple things first (cable, hub, another program), then the system's own; terminal commands last (Prüfrunde 1 B6).
  const all = [...(ctx.mayAskForAddon && ctx.serialSupported ? [firefoxSection(ctx)] : []), ...commonSections(ctx), ...system.filter((x) => !x.terminal), ...system.filter((x) => x.terminal)];
  return ctx.serialSupported ? { sections: all, later: [] } : { sections: [browserSection()], later: all };
}

/* ------------------------------------------------- empty port chooser */

export interface ChooserMissContext {
  os: Platform['os'];
  /** The chooser showed only devices with the USB ids of the selected board. */
  filtered: boolean;
  /** The box may have a CH340 (the selected board has one, or no board is selected). */
  ch340: boolean;
  /** Desktop app: there is no chooser, the list of ports stayed empty. */
  desktop?: boolean;
  /** The Android app: the box hangs at the phone. */
  phone?: boolean;
}

export interface ChooserMissHint {
  title: string;
  /** Short sentences, most likely cause first. */
  lines: string[];
  /** Point to „Alle USB-Geräte zeigen“: the box may have another USB chip than the board usually has. */
  showAll: boolean;
  more: { label: string; href: string };
}

/**
 * What the port picker says when the browser's chooser closed without a
 * box, or when the desktop app found no port for a while. Charge-only
 * cables are the usual cause (8107); the rest depends on the system.
 */
export function chooserMissHint(ctx: ChooserMissContext): ChooserMissHint {
  const lines = ctx.phone
    ? ['Meist liegt es am Kabel. Das Handy braucht ein OTG-Kabel oder einen OTG-Adapter, und viele USB-Kabel laden nur. Tippe bei der Frage des Handys auf „Zulassen“.']
    : ['Meist liegt es am Kabel: Viele USB-Kabel laden nur und übertragen keine Daten. Nimm ein anderes Kabel und stecke die Box direkt am Computer ein.'];
  if (ctx.ch340 && ctx.os === 'windows') lines.push('Hat die Box den Chip CH340, braucht Windows einmalig einen Treiber.');
  if (ctx.ch340 && ctx.os === 'linux') lines.push('Unter Ubuntu und Linux Mint schnappt sich manchmal das Programm „brltty“ den Chip CH340. Unter „Mehr Hilfe“ steht, was dann hilft.');
  const showAll = !ctx.desktop && ctx.filtered;
  if (showAll) lines.push('Vielleicht hat deine Box einen anderen USB-Chip. Klicke dann auf „Alle USB-Geräte zeigen“ und wähle deine Box dort aus.');
  return {
    title: ctx.desktop ? 'Die Box taucht nicht auf?' : 'Keine Box im Auswahlfenster?',
    lines,
    showAll,
    more: { label: 'Mehr Hilfe', href: '#/werkstatt/usb' },
  };
}

/**
 * Ports that may be the box: USB devices and ports that fit the board. The
 * desktop app lists every port on Windows, also built-in COM ports and
 * Bluetooth links, which are never a box; counting them would hide the hint
 * on exactly the PCs where a missing CH340 driver keeps the box away.
 */
export function boxCandidates(ranked: readonly RankedPort[]): number {
  return ranked.filter((r) => r.fits || r.port.usbVendorId !== undefined).length;
}

/** How long the desktop app waits without a port that may be the box before it offers help. */
export const EMPTY_PORTS_HINT_MS = 15_000;

/** Whether the picker shows the hint, and whether the chooser it follows was filtered. */
export type ChooserMiss = { filtered: boolean } | null;

export type ChooserEvent =
  /** The browser's chooser closed; `chosen` when the user picked a port there. */
  | { kind: 'chooser-closed'; chosen: boolean; filtered: boolean }
  /** A port was chosen in the list, or the picker chose the obvious one. */
  | { kind: 'port-chosen' }
  /** Desktop app: the list has been empty this long. */
  | { kind: 'empty-for'; ms: number }
  /** The list of ports changed. */
  | { kind: 'ports'; count: number; desktop: boolean };

/** The hint comes after a chooser that closed without a box, or after a long empty list, and goes once a box is chosen or found. */
export function nextChooserMiss(state: ChooserMiss, event: ChooserEvent): ChooserMiss {
  switch (event.kind) {
    case 'chooser-closed':
      return event.chosen ? null : { filtered: event.filtered };
    case 'port-chosen':
      return null;
    case 'empty-for':
      return state ?? (event.ms >= EMPTY_PORTS_HINT_MS ? { filtered: false } : null);
    case 'ports':
      return event.desktop && event.count > 0 ? null : state;
  }
}
