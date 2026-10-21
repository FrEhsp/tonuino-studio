import { describe, expect, it } from 'vitest';
import { esp32CardProblem, esp32WriteRequest, normalizeBoxAddress, parseEsp32InfoPage, parseEsp32MainPage, type Esp32Box } from '../../src/core/tonuino/esp32';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';

const body = (r: ReturnType<typeof esp32WriteRequest>): Record<string, string> => {
  if (!r.ok) throw new Error(r.reason);
  return { path: r.request.path, ...Object.fromEntries(r.request.body) };
};

describe('esp32WriteRequest', () => {
  it('folder cards use the German mode names of the web interface', () => {
    expect(body(esp32WriteRequest({ folder: 5, mode: 5, special: 0, special2: 2 }))).toEqual({
      path: '/card',
      folder: '5',
      mode: 'Hörbuch',
      special1: '0',
      special2: '2',
      card_action: 'write',
    });
    expect(body(esp32WriteRequest({ folder: 3, mode: 16, special: 4, special2: 9 })).mode).toBe('Hörbuch von bis');
  });

  it('sleep timer: end of track becomes a negative number', () => {
    expect(body(esp32WriteRequest(modifierCard(1, 15)))).toEqual({ path: '/modifier', mod_mode: 'Sleep-Timer', mod_special: '15', mod_action: 'write' });
    expect(body(esp32WriteRequest(modifierCard(1, 30 + 0x80))).mod_special).toBe('-30');
  });

  it('the toddler lock is called "Gesperrt" there', () => {
    expect(body(esp32WriteRequest(modifierCard(4))).mod_mode).toBe('Gesperrt');
  });

  it('refuses what the web interface cannot write', () => {
    expect(esp32WriteRequest(adminCard()).ok).toBe(false);
    expect(esp32WriteRequest(modifierCard(7)).ok).toBe(false);
    expect(esp32WriteRequest({ folder: 1, mode: 6, special: 0, special2: 0 }).ok).toBe(false);
  });
});

/** The modifier form of the main page of TNG 3.3.3 (17.09.2026), src/webservice_pages.cpp. */
const MAIN_PAGE = `<form class="service1" id="modifier">
<br><label for="mod_mode"    >Modifier:  </label><select size=1 name="mod_mode" id="mod_mode" onchange="mod_mode_changed(this)">
                                                   <option>Sleep-Timer           </option>
                                                   <option>Stopptanz             </option>
                                                   <option>Feuer-Wasser-Luft     </option>
                                                   <option>Gesperrt              </option>
                                                   <option>Kita Modus            </option>
                                                   <option>Wiederhole Track      </option>
                                                   <option>Jukebox               </option>
                                                   <option>Pause nach jedem Track</option>
                                                   <option>Standby Timer Off     </option>
                                                   <option>Endless switch        </option>
                                                 </select>`;
/** The release of 25.02.2026 has no Endlos card. */
const OLD_MAIN_PAGE = MAIN_PAGE.replace(/\s*<option>Endless switch\s*<\/option>/, '');

const infoPage = (config: string) => `<h3>About</h3><hr><dl>
<dt>TonUINO TNG Version</dt><dd>V3.3.3 17.09.26</dd>
<dt>TonUINO TNG Konfiguration</dt><dd>${config}</dd>
<dt>Arduino ESP Board Package</dt><dd>3.1.1</dd>
</dl>`;

describe('what the pages of the box tell', () => {
  it('reads the modifier choices of the main page', () => {
    const names = parseEsp32MainPage(MAIN_PAGE);
    expect(names).toHaveLength(10);
    expect(names).toContain('Endless switch');
    expect(parseEsp32MainPage(OLD_MAIN_PAGE)).not.toContain('Endless switch');
    expect(parseEsp32MainPage('<html>keine Box</html>')).toEqual([]);
  });

  it('reads version and compiled options of the info page', () => {
    const info = parseEsp32InfoPage(infoPage('ESP32 Nano, 5 Tasten<br>Neo-Pixel with 24 LED (extended)<br>Quiz Game<br>Memory Game<br>Jukebox<br>OTA possible: yes'));
    expect(info.version).toBe('V3.3.3 17.09.26');
    expect(info.options).toEqual(['ESP32 Nano, 5 Tasten', 'Neo-Pixel with 24 LED (extended)', 'Quiz Game', 'Memory Game', 'Jukebox', 'OTA possible: yes']);
  });

  it('refuses modifier cards the box would write empty', () => {
    const full: Esp32Box = { modifiers: parseEsp32MainPage(MAIN_PAGE), ...parseEsp32InfoPage(infoPage('ESP32 Nano, 5 Tasten<br>Jukebox<br>Pause nach jedem Track')) };
    const plain: Esp32Box = { modifiers: parseEsp32MainPage(MAIN_PAGE), ...parseEsp32InfoPage(infoPage('ESP32 Nano, 3 Tasten<br>OTA possible: yes')) };
    const old: Esp32Box = { modifiers: parseEsp32MainPage(OLD_MAIN_PAGE), ...parseEsp32InfoPage(infoPage('ESP32 Nano, 5 Tasten<br>Jukebox')) };
    expect(esp32CardProblem(modifierCard(8), full)).toBeUndefined();
    expect(esp32CardProblem(modifierCard(9), full)).toBeUndefined();
    expect(esp32CardProblem(modifierCard(8), plain)).toContain('Jukebox');
    expect(esp32CardProblem(modifierCard(9), plain)).toContain('Pause nach jedem Track');
    expect(esp32CardProblem(modifierCard(8), old)).toBeUndefined();
    expect(esp32CardProblem(modifierCard(11), full)).toBeUndefined();
    expect(esp32CardProblem(modifierCard(11), old)).toContain('17.09.2026');
    // Everything else is up to the box.
    expect(esp32CardProblem(modifierCard(5), plain)).toBeUndefined();
    expect(esp32CardProblem({ folder: 3, mode: 8, special: 1, special2: 4 }, plain)).toBeUndefined();
  });

  it('does not refuse on pages it could not read', () => {
    const unread: Esp32Box = { modifiers: [] };
    const garbled: Esp32Box = { modifiers: parseEsp32MainPage('<html></html>'), ...parseEsp32InfoPage('<html></html>') };
    for (const box of [unread, garbled]) {
      for (const code of [8, 9, 11]) expect(esp32CardProblem(modifierCard(code), box)).toBeUndefined();
    }
  });
});

describe('normalizeBoxAddress', () => {
  it('accepts IPs and host names, always plain http', () => {
    expect(normalizeBoxAddress('192.168.178.40')).toBe('http://192.168.178.40');
    expect(normalizeBoxAddress(' https://TonUINO.fritz.box/ ')).toBe('http://tonuino.fritz.box');
    expect(normalizeBoxAddress('tonuino:8080/info')).toBe('http://tonuino:8080');
  });

  it('rejects nonsense', () => {
    expect(normalizeBoxAddress('')).toBeNull();
    expect(normalizeBoxAddress('meine box')).toBeNull();
    expect(normalizeBoxAddress('.local')).toBeNull();
  });
});
