import { ADMIN_MODE, type CardData } from './card';
import { TNG_SEPTEMBER_2026 } from './modes';

/**
 * Writing cards through the web interface of a TonUINO-TNG box with ESP32
 * (src/webservice.cpp). The box takes the card settings as a form post and
 * then waits for a card to be placed on it, exactly like its own menu.
 *
 *   POST /card      folder, mode (name), special1, special2, card_action=write
 *   POST /modifier  mod_mode (name), mod_special, mod_action=write
 *
 * Answers 200 when it accepted the job, 400 with a German message otherwise.
 */

/** Mode names as the web interface expects them. */
export const ESP32_MODE_NAMES: Record<number, string> = {
  1: 'Hörspiel',
  2: 'Album',
  3: 'Party',
  4: 'Einzel',
  5: 'Hörbuch',
  7: 'Hörspiel von bis',
  8: 'Album von bis',
  9: 'Party von bis',
  10: 'Hörbuch einzel',
  11: 'Wiederhole',
  12: 'Quiz Spiel',
  13: 'Memory Spiel',
  14: 'Bluetooth ein/aus',
  15: 'Teekesselchen Spiel',
  16: 'Hörbuch von bis',
};

/** Modifier names of the web interface. "Gesperrt" is the toddler lock there. */
export const ESP32_MODIFIER_NAMES: Record<number, string> = {
  1: 'Sleep-Timer',
  2: 'Stopptanz',
  3: 'Feuer-Wasser-Luft',
  4: 'Gesperrt',
  5: 'Kita Modus',
  6: 'Wiederhole Track',
  8: 'Jukebox',
  9: 'Pause nach jedem Track',
  10: 'Standby Timer Off',
  11: 'Endless switch',
};

export interface BoxRequest {
  path: '/card' | '/modifier';
  body: URLSearchParams;
}

export type BoxRequestResult = { ok: true; request: BoxRequest } | { ok: false; reason: string };

/** The form post that makes the box write `card` onto the next card placed on it. */
export function esp32WriteRequest(card: CardData): BoxRequestResult {
  if (card.folder === 0) {
    if (card.mode === ADMIN_MODE) return { ok: false, reason: 'Die Admin-Karte geht über WLAN nicht. Nimm dafür die Anleitung an der Box.' };
    const name = ESP32_MODIFIER_NAMES[card.mode];
    if (!name) return { ok: false, reason: 'Diese Spezialkarte kennt die Web-Oberfläche der Box nicht.' };
    let special = card.special;
    // Sleep timer: a negative number means "stop at the end of the track".
    if (card.mode === 1 && special & 0x80) special = -(special & 0x7f);
    return {
      ok: true,
      request: { path: '/modifier', body: new URLSearchParams({ mod_mode: name, mod_special: String(special), mod_action: 'write' }) },
    };
  }
  const name = ESP32_MODE_NAMES[card.mode];
  if (!name) return { ok: false, reason: 'Diesen Modus kennt die Web-Oberfläche der Box nicht.' };
  return {
    ok: true,
    request: {
      path: '/card',
      body: new URLSearchParams({
        folder: String(card.folder),
        mode: name,
        special1: String(card.special),
        special2: String(card.special2),
        card_action: 'write',
      }),
    },
  };
}

/** What the web pages of a TNG box tell about its firmware. */
export interface Esp32Box {
  /** Firmware version from the info page, e.g. "V3.3.3 17.09.26". */
  version?: string;
  /** Options compiled into the firmware, from the info page; missing when the page could not be read. */
  options?: string[];
  /** Modifier names the main page offers. */
  modifiers: string[];
}

/** The choices of the modifier form on the box's main page (select "mod_mode"). */
export function parseEsp32MainPage(html: string): string[] {
  const select = /<select[^>]*name="mod_mode"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!select) return [];
  return [...select[1].matchAll(/<option[^>]*>([^<]*)<\/option>/gi)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Version and compiled options from the box's info page (/info): the
 * "TonUINO TNG Konfiguration" entry lists one option per line, e.g.
 * "ESP32 Nano, 5 Tasten<br>Quiz Game<br>Jukebox<br>OTA possible: yes".
 */
export function parseEsp32InfoPage(html: string): { version?: string; options: string[] } {
  const field = (label: string) => new RegExp(`<dt>\\s*${label}\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>`, 'i').exec(html)?.[1];
  const version = field('TonUINO TNG Version')?.trim() || undefined;
  const options = (field('TonUINO TNG Konfiguration') ?? '')
    .split(/<br\s*\/?>/i)
    .map((s) => s.replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
  return { version, options };
}

/**
 * Why this box cannot write the card, judged from its pages; undefined when
 * nothing speaks against it. Without the firmware option the web interface
 * turns "Jukebox" into an empty modifier and still answers 200, and boxes
 * before the release of 17.09.2026 do not know "Endless switch" at all
 * (webservice.cpp: unknown names become pmode_t::none). A page that could
 * not be read proves nothing, so only lists with entries count.
 */
export function esp32CardProblem(card: CardData, box: Esp32Box): string | undefined {
  if (card.folder !== 0) return undefined;
  const lacks = (list: string[] | undefined, name: string) => !!list?.length && !list.includes(name);
  if (card.mode === 8 && lacks(box.options, 'Jukebox')) {
    return 'Deine Box meldet keine Jukebox-Funktion. Ohne sie schreibt sie eine Karte, die nichts tut. Die Funktion hat nur die Firmware „5 Tasten mit allen Extras“.';
  }
  if (card.mode === 9 && lacks(box.options, 'Pause nach jedem Track')) {
    return 'Deine Box meldet keine Funktion „Pause nach jedem Track“. Ohne sie schreibt sie eine Karte, die nichts tut.';
  }
  if (card.mode === 11 && lacks(box.modifiers, ESP32_MODIFIER_NAMES[11])) {
    return `Deine Box kennt die Endlos-Karte noch nicht. Die gibt es erst ab TNG ${TNG_SEPTEMBER_2026}: Bringe zuerst die Firmware auf den neuesten Stand.`;
  }
  return undefined;
}

/**
 * Turns what the user typed ("192.168.178.40", "tonuino.fritz.box/",
 * "https://tonuino") into the base URL of the box. The box only speaks
 * plain http. Null when it is not an address.
 */
export function normalizeBoxAddress(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  text = text.replace(/^[a-z]+:\/\//i, '');
  const host = text.split(/[/?#]/)[0];
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) || host.startsWith('.') || host.startsWith('-')) return null;
  return `http://${host.toLowerCase()}`;
}
