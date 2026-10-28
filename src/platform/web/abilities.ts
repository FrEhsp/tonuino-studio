/**
 * What the web app can do in this browser on this device, and what to take
 * instead for the rest (TODO #122, recherche/web-hardware-0.6.md). Decided
 * by what the browser offers, never by its name; only phones and tablets go
 * by the device (handheld.ts), because their browsers have a folder chooser
 * but cannot reach the SD card.
 *
 * - SD card: directly with File System Access (Chrome, Edge on a computer),
 *   as a Paket with a folder chooser (Firefox, Safari), not on a phone.
 * - The box over USB: Web Serial (Chrome, Edge, Firefox from 151 on a
 *   computer). Android's Chrome has Web Serial for Bluetooth only.
 * - NFC readers on USB (ACR122U): in no browser. WebUSB keeps smart card
 *   readers from web pages, only the desktop app reaches them.
 * - The phone's own NFC (Web NFC, Chrome on Android): NDEF only. It cannot
 *   write the 16 bytes at the place where the box reads them, and it would
 *   reformat a MIFARE Classic card. So never offered; the Android app can.
 * - iPhone and iPad: no browser there reaches card, USB or NFC.
 *
 * Pure: the sentences are tested for every kind of device.
 */
import type { Platform } from '../types';

export interface BrowserFacts {
  /** A phone or tablet (handheld.ts). */
  handheld: boolean;
  /** iPhone or iPad (also iPadOS asking as a Mac). */
  apple: boolean;
  /** showDirectoryPicker: write to a folder directly. */
  folderAccess: boolean;
  /** <input webkitdirectory>: read a whole folder once. */
  folderInput: boolean;
  /** Web Serial. */
  serial: boolean;
}

export type Device = 'computer' | 'android' | 'apple';

export interface WebAbilities {
  device: Device;
  /** direct: write to the card; package: read it once, changes as a ZIP; none: no card. */
  sd: 'direct' | 'package' | 'none';
  /** The box over USB, and with it writing cards through the box. */
  box: boolean;
}

/** iPhone, iPod, iPad; iPadOS asks as a Mac, which counts only on a phone or tablet (handheld). */
const APPLE = /\b(?:iPhone|iPod|iPad|Macintosh)\b/i;

/** The abilities of the web app as its platform found them (createWebPlatform). */
export function abilitiesOf(p: Pick<Platform, 'handheld' | 'capabilities'>, userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): WebAbilities {
  const c = p.capabilities;
  return webAbilities({ handheld: !!p.handheld, apple: APPLE.test(userAgent), folderAccess: c.sd, folderInput: c.sdPackage, serial: c.serial });
}

export function webAbilities(f: BrowserFacts): WebAbilities {
  const device: Device = !f.handheld ? 'computer' : f.apple ? 'apple' : 'android';
  if (device !== 'computer') return { device, sd: 'none', box: false };
  return { device, sd: f.folderAccess ? 'direct' : f.folderInput ? 'package' : 'none', box: f.serial };
}

/** One line of "Was hier geht": a thing, whether it works here, and a short note (how, or what to take instead). */
export interface AbilityLine {
  what: string;
  here: boolean;
  note?: string;
}

/** The overview for the settings: everything the app can do, and for this browser whether it works. */
export function abilityLines(a: WebAbilities): AbilityLine[] {
  const elsewhere = a.device === 'android' ? 'Mit der Android-App.' : a.device === 'apple' ? 'Nur am Computer.' : undefined;
  const sdNote =
    a.sd === 'package'
      ? 'Über ein Paket. Direkt auf die Karte geht in Chrome, Edge oder mit der Desktop-App.'
      : a.sd === 'none'
        ? a.device === 'android'
          ? 'Mit der Android-App und einem SD-Kartenleser am Handy.'
          : a.device === 'apple'
            ? 'Nur am Computer.'
            : 'In Chrome, Edge, Firefox oder Safari am Computer.'
        : undefined;
  return [
    { what: 'SD-Karte', here: a.sd !== 'none', note: sdNote },
    { what: 'Box per USB', here: a.box, note: a.box ? 'Firmware, Box testen, Logbuch und Karten über die Box.' : (elsewhere ?? 'In Chrome, Edge, Firefox ab Version 151 oder mit der Desktop-App.') },
    {
      what: 'Karten mit dem NFC des Handys',
      here: false,
      note:
        a.device === 'android'
          ? 'Mit der Android-App. Der Browser kann NFC-Karten nur als Web-Link beschreiben, nicht so, wie die Box sie liest.'
          : a.device === 'apple'
            ? 'Am iPhone und iPad geht das nicht.'
            : 'Mit der Android-App auf einem Android-Handy.',
    },
    { what: 'NFC-Leser am USB, z. B. ACR122U', here: false, note: 'In keinem Browser, nur mit der Desktop-App.' },
    { what: 'Sticker gestalten und drucken', here: true },
  ];
}

/**
 * The one sentence for the card ways the browser cannot offer (CardsPage):
 * instead of buttons that do nothing.
 */
export function cardWaysElsewhere(a: WebAbilities): string {
  return a.box
    ? 'NFC-Leser am USB und Boxen mit WLAN gehen in keinem Browser, nur mit der Desktop-App.'
    : 'NFC-Leser am USB und Boxen mit WLAN gehen nur mit der Desktop-App, Karten über die Box per USB auch in Chrome und Edge.';
}

/** The first sentence on a phone or tablet in the browser: why the card, the box and NFC are not here. */
export function handheldLead(device: Exclude<Device, 'computer'>): string {
  return device === 'apple'
    ? 'Am iPhone und iPad kommt kein Browser an die SD-Karte, an die Box oder an NFC-Karten. Eine App dafür gibt es nicht.'
    : 'Im Browser kommt dein Handy nicht an die SD-Karte, an die Box oder an NFC-Karten. Der Browser kann NFC-Karten nur als Web-Link beschreiben, nicht so, wie die Box sie liest. Das alles kann TonUINO Studio als Android-App.';
}
