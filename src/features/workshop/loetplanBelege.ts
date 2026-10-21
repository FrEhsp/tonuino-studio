/**
 * Where every wire of the Lötplan comes from, and how sure it is.
 *
 * Each wire names one or more Belege (proofs) by id. Most ids are the ids
 * of the checked notes of the build assistant (bauassistent/geprueft/*.json:
 * cl-…, oas-…, aio-…, ap-…), which cite the TNG source, data sheets, the
 * official guides and forum posts word for word. A few are our own: the
 * print on Frank's Classic v1.7 board (photos of 09.10.2026) and plain
 * physics (Ohm's law).
 *
 * Levels, as the app shows them:
 * - geprueft: from the firmware source, a data sheet, the maker's guide or
 *   the print on the board (notes: "belegt").
 * - nachsehen: very likely, but only from forum reports or derived; the
 *   wire list says "vor dem Löten nachsehen" (notes: "wahrscheinlich").
 * - ungeprueft: not proven (notes: "unsicher"). Never drawn; the extras
 *   say instead what is missing and what would prove it.
 *
 * `gegenprobe` is the second, independent pass of 0.3 (13.10.2026): every
 * proof checked again, trying to refute it. For pins: the line in TNG's
 * constants.hpp read again (tests/workshop/tngpins.test.ts does that on
 * every test run). For the notes: confidence and check result read again
 * from the JSON (script in the hand-over of 0.3), plus a look at what the
 * proof really covers. Where the pass found a gap, the level went down.
 */

export type Stufe = 'geprueft' | 'nachsehen' | 'ungeprueft';

export interface Beleg {
  /** Short citation for the wire list. */
  quelle: string;
  stufe: Stufe;
  /** What the second pass found. */
  gegenprobe: string;
  /**
   * The ids in bauassistent/geprueft/*.json this proof stands for (when they
   * differ from its own id); empty: not from the notes (our own photo, physics).
   * The level may be weaker than the notes, never stronger
   * (tests/workshop/loetplan-belege.test.ts).
   */
  json?: readonly string[];
}

const TNG = 'Zeile in TNG constants.hpp nachgelesen, im richtigen #if-Zweig (Test tngpins)';
const JSON_OK = (c: string) => `geprueft-Notiz: ${c}, Prüfung bestätigt`;

export const BELEGE = {
  /* ------------------------------------------------ our own: the Classic v1.7 board */
  'v17-foto-rfid': {
    quelle: 'Aufdruck der Classic-Platine v1.7 neben der Kartenleser-Leiste: 3V3 RST GND IRQ SO SI SCK SDA (Fotos von Franks Platine)',
    stufe: 'geprueft',
    gegenprobe: 'Foto classic-v17-oben-1 selbst angesehen: Aufdruck und Reihenfolge stimmen, 3V3 liegt außen wie bei voss.earth.',
    json: [],
  },
  'v17-so-si': {
    quelle: 'SO und SI sind die SPI-Namen aus Sicht des Lesers: SO = Ausgang des Lesers = MISO, SI = MOSI. Die Leiste ist die gespiegelte Reihenfolge des RC522-Moduls (SDA SCK MOSI MISO IRQ GND RST 3.3V), voss.earth: „1:1“ verbinden',
    stufe: 'nachsehen',
    gegenprobe:
      'Gegen die Modul-Reihenfolge der AiO-FAQ (aio-rc522-sda) gelegt: SO fällt auf MISO, SI auf MOSI. Aber: Die 1:1-Anleitung (cp-v04) ist in den Notizen auf „unsicher“ herabgestuft, und die Leiterbahnen sind auf dem Foto der Unterseite nicht zu sehen (Massefläche). Darum nur „vor dem Löten nachsehen“. Beweis: Durchgang messen, SO zum Nano-Sockel D12 (MISO), SI zu D11 (MOSI).',
    json: [],
  },
  'v17-foto-links': {
    quelle: 'Aufdruck der Classic-Platine v1.7, linke Leiste: A0 … A7, GND, GND, D8, D7, D6, D5, GND und eine GND-Spalte neben A0–A5 (Fotos); Forum 2463 #147',
    stufe: 'geprueft',
    gegenprobe: 'Foto selbst angesehen; 2463 #147 („A0 - A7 | GND | GND | D8 - D5“) laut geprueft-Notiz wörtlich.',
    json: [],
  },
  'v17-foto-audio': {
    quelle: 'Aufdruck der Classic-Platine v1.7, Audio-Leiste: 5V GND GND R L + − (Fotos)',
    stufe: 'geprueft',
    gegenprobe: 'Foto selbst angesehen, 7 Lötaugen wie in den 3D-Daten (TU_CLASSIC_V1.7).',
    json: [],
  },
  'v17-5v': {
    quelle: '5V der Audio-Leiste als Einspeisepunkt für 5 V: nur im Schaltplanbild der Platine (Forum 14305 #54), nicht als Text belegt',
    stufe: 'nachsehen',
    gegenprobe: 'Nicht widerlegt, aber auch nicht selbst nachgemessen: mit dem Messgerät Durchgang zum Pin 5V am Nano prüfen.',
    json: [],
  },
  'v17-r7': {
    quelle: 'R7 (1 kΩ in der Leitung D3 → RX) sitzt als SMD-Widerstand auf der Platine (Foto; cp-v03; Forum 8624, 13973)',
    stufe: 'geprueft',
    gegenprobe: 'Aufdruck R7 auf dem Foto gesehen.',
    json: [],
  },
  usb: {
    quelle: 'voss.earth/tonuino: „Stromversorgung per USB Kabel mit Netzteil oder Powerbank“ (cl-v23, cp-v07)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
    json: ['cl-v23', 'cp-v07'],
  },

  /* ------------------------------------------------ Classic, wired by hand (classic.json) */
  'cl-v01': {
    quelle: 'TNG constants.hpp:585 (dfPlayer_receivePin = 2), TNG-Schaltplan',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v02': {
    quelle: 'TNG constants.hpp:586 (dfPlayer_transmitPin = 3), Schaltplan: 1 kΩ zu RX; Datenblatt FN-M16P S. 20',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v03': {
    quelle: 'TNG constants.hpp:590 (dfPlayer_busyPin = 4); Datenblatt FN-M16P S. 4',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v04': {
    quelle: 'TNG-Schaltplan: Nano +5V → DFPlayer VCC; Datenblatt FN-M16P S. 3',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v05': {
    quelle: 'TNG-Schaltplan: Nano GND → DFPlayer GND (Pin 10)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v06': {
    quelle: 'TNG-Schaltplan: DFPlayer SPK_1 → Lautsprecher; Datenblatt Fig. 5-4',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v07': {
    quelle: 'TNG-Schaltplan: DFPlayer SPK_2 → Lautsprecher; Datenblatt Fig. 5-4',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v08': {
    quelle: 'TNG-Schaltplan: Nano 3V3 → RC522 3.3V; NXP-Datenblatt MFRC522: 2,5–3,6 V',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v09': {
    quelle: 'TNG-Schaltplan: Nano GND → RC522 GND',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v10': {
    quelle: 'TNG constants.hpp:576 (mfrc522_RSTPin = 9)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v11': {
    quelle: 'TNG constants.hpp:577 (mfrc522_SSPin = 10)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v12': {
    quelle: 'Hardware-SPI des Nano: D11 = MOSI (Arduino-Datenblatt A000005), TNG-Schaltplan',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v13': {
    quelle: 'Hardware-SPI des Nano: D12 = MISO (Arduino-Datenblatt A000005), TNG-Schaltplan',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v14': {
    quelle: 'Hardware-SPI des Nano: D13 = SCK (Arduino-Datenblatt A000005), TNG-Schaltplan',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v15': {
    quelle: 'TNG-Schaltplan: IRQ des Lesers unbeschaltet; TNG nutzt nur RST und SS (constants.hpp:576–577)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v16': {
    quelle: 'TNG constants.hpp:552 (buttonPausePin = A0), :569 activeLow',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v17': {
    quelle: 'TNG constants.hpp:565 (buttonUpPin = A1, 3 Tasten)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v18': {
    quelle: 'TNG constants.hpp:566 (buttonDownPin = A2, 3 Tasten)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v19': {
    quelle: 'TNG-Schaltplan: zweiter Kontakt aller Tasten an GND; Tasten schalten gegen Masse (activeLow)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'cl-v20a': {
    quelle: 'TNG constants.hpp:562 (buttonFourPin = A1 = Lauter, 5 Tasten)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v20b': {
    quelle: 'TNG constants.hpp:563 (buttonFivePin = A2 = Leiser, 5 Tasten)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v20c': {
    quelle: 'TNG constants.hpp:560 (buttonUpPin = A3 = Vor, 5 Tasten)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v20d': {
    quelle: 'TNG constants.hpp:561 (buttonDownPin = A4 = Zurück, 5 Tasten)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-v21': {
    quelle: 'Forum 14260 #2, 6179 #23: Elko am DFPlayer zwischen VCC und GND',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },

  /* ------------------------------------------------ sound and power (optionen-audio-strom.json) */
  'oas-v03': {
    quelle: 'voss.earth: Lautsprecher an + und − der Audio-Leiste; Forum 2463 #147',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (Funktionsnamen aus dem Forum, Aufdruck + − jetzt durch Foto belegt)',
  },
  'oas-v10': {
    quelle: 'Forum 2463 #149: „Du schließt die 5 Kabel 1:1 von rechts an die TonUINO Platine an“ (G DR DL SK SK, #138)',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich; Reihenfolge der Audio-Leiste jetzt durch Foto belegt, die der Kopfhörerplatine nur durch das Forum',
  },
  'oas-v14': {
    quelle: 'Forum 2463 #15, #149: Lautsprecher an „Speaker“ der Kopfhörerplatine',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (korrigiert)',
  },
  'oas-v15': {
    quelle: 'Forum 2463 #105, #107: GND des DFPlayer (Pin 7, zwischen SPK_1 und SPK_2) an G',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (korrigiert)',
  },
  'oas-v16': {
    quelle: 'Forum 2463 #107, #172: DAC_R (Pin 4) an DR',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },
  'oas-v17': {
    quelle: 'Forum 2463 #107, #172: DAC_L (Pin 5) an DL',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },
  'oas-v18': {
    quelle: 'Forum 2463 #107: SPK_1 und SPK_2 an die beiden SK',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },
  'oas-v30': {
    quelle: 'Pololu Nr. 2808: VIN = Eingang; Forum 6179 #106 (rot = Plus, 1-A-Sicherung)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt (korrigiert)'),
  },
  'oas-v31': {
    quelle: 'Pololu-Produktbild: GND neben VIN',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: herabgestuft auf wahrscheinlich (nur im Bild)',
  },
  'oas-v32': {
    quelle: 'Forum 2099 #8: „VOUT → 5V“ (VIN durchgestrichen)',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (Zitat korrigiert)',
  },
  'oas-v33': {
    quelle: 'Pololu-Produktseite: gemeinsame Masse',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },
  'oas-v34': {
    quelle: 'TNG constants.hpp:602 (shutdownPin = 7, beim Abschalten HIGH); Forum 14305 #54',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'oas-v35': {
    quelle: 'Forum 14305 #54: „Den GND von der Pause-Taste legst Du an Anschluss A vom Pololu“',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },
  'oas-v60': {
    quelle: 'Forum 96 #146: SPK_1 an Pin 5 der Buchse FC68129',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (ein Erfahrungsbericht)',
  },
  'oas-v61': {
    quelle: 'Forum 96 #146: Pin 7 der Buchse weiter zum Lautsprecher',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (ein Erfahrungsbericht)',
  },
  'oas-v62': {
    quelle: 'Forum 96 #146: DAC_L an Pin 3',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },
  'oas-v63': {
    quelle: 'Forum 96 #146: DAC_R an Pin 4',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },
  'oas-v64': {
    quelle: 'Forum 96 #146: GND (Pin 7 des DFPlayer) an Pin 1',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
  },

  /* ------------------------------------------------ extras on the Classic and Every (optionen-bedienung.json) */
  'cl-enc-clk': {
    quelle: 'TNG constants.hpp:209 (rotaryEncoderClkPin = A3); Pull-ups sitzen auf dem Modul',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['cl-enc-clk', 'ev-enc-clk'],
  },
  'cl-enc-dt': {
    quelle: 'TNG constants.hpp:210 (rotaryEncoderDtPin = A4)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['cl-enc-dt', 'ev-enc-dt'],
  },
  'cl-enc-gnd': {
    quelle: 'KY-040: GND an Masse',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
    json: ['cl-enc-gnd', 'ev-enc-gnd'],
  },
  'cl-enc-plus': {
    quelle: 'KY-040: + versorgt die Pull-up-Widerstände des Moduls; TNG schaltet keine eigenen ein (constants.hpp:214, rotaryEncoderPullUp = false)',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich; Zeile 214 nachgelesen: ohne + am Modul hängen CLK und DT in der Luft',
    json: ['cl-enc-plus', 'ev-enc-plus'],
  },
  'cl-enc-sw': {
    quelle: 'Forum: der Druckknopf (SW) des Drehknopfs parallel zur Play/Pause-Taste an A0; TNG wertet SW nicht eigens aus',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (Forenempfehlung)',
    json: ['cl-enc-sw', 'ev-enc-sw'],
  },
  'cl-poti-s': {
    quelle: 'TNG constants.hpp:232 (potiPin = A3)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'cl-poti-gnd': {
    quelle: 'Forum 1732 #59: eine Seite an GND, die andere an 5V; welche, bestimmt die Drehrichtung',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (korrigiert)',
  },
  'cl-poti-vcc': {
    quelle: 'Forum 1732 #59; der Nano misst 0–5 V (poti.cpp: maxLevel 1023)',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich; beim Nano Every unsicher (ev-poti-vcc), dort nicht gezeichnet',
  },
  'cl-neo-din': {
    quelle: 'TNG constants.hpp:255 (neoPixelRingPin = D5); Adafruit: 300–500 Ω in die Datenleitung, nah am Ring',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['cl-neo-din', 'ev-neo-din'],
  },
  'cl-neo-5v': {
    quelle: 'Ring an 5 V (Forum, Adafruit-Leitfaden)',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich',
    json: ['cl-neo-5v', 'ev-neo-5v'],
  },
  'cl-neo-gnd': {
    quelle: 'Ring an GND, gemeinsame Masse (Adafruit-Leitfaden)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt (korrigiert)'),
    json: ['cl-neo-gnd', 'ev-neo-gnd'],
  },
  'cl-neo-elko': {
    quelle: 'Adafruit: 500–1000 µF ab 6,3 V über + und − des Rings',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
    json: ['cl-neo-elko', 'ev-neo-elko'],
  },
  'cl-led-play': {
    quelle: 'TNG constants.hpp:508 (led_play_pin = A5); :488 „Use a series resistor (e.g. 1KΩ) per LED“',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['cl-led-play', 'ev-led-play'],
  },
  'cl-led-vor': {
    quelle: 'TNG constants.hpp:509 (led_up_pin = D6); 1 kΩ je LED',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['cl-led-vor', 'ev-led-vor'],
  },
  'cl-led-zurueck': {
    quelle: 'TNG constants.hpp:510 (led_down_pin = D5); 1 kΩ je LED',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['cl-led-zurueck', 'ev-led-zurueck'],
  },
  'cl-led-gnd': {
    quelle: 'TNG led_manager.cpp: LED an = Pin HIGH, darum Minus der LEDs an GND',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (aus dem Code abgeleitet)',
    json: ['cl-led-gnd', 'ev-led-gnd'],
  },

  /* ------------------------------------------------ AiO (aio.json) */
  'aio-nfc-kabel': {
    quelle: 'LKP Quick-Start AiO: 8-poliges Kabel in den NFC-Anschluss (Nr. 13)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'aio-rc522': {
    quelle: 'LKP-FAQ AiO: gleich beschriftete Pins 1:1 (SDA SCK MOSI MISO IRQ GND RST 3.3V); TNG constants.hpp:716–717',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
    json: ['aio-rc522-sda', 'aio-rc522-sck', 'aio-rc522-mosi', 'aio-rc522-miso', 'aio-rc522-irq', 'aio-rc522-gnd', 'aio-rc522-rst', 'aio-rc522-33v'],
  },
  'aio-button-kabel': {
    quelle: 'LKP Quick-Start AiO: Button-Adapter mit 10-adrigem Kabel (Nr. 10)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'aio-taster-play': {
    quelle: 'Forum 7946 #7, #8; 8263 #3: Play/Pause an PBP und PBN, nicht an GND; TNG constants.hpp:692',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['aio-taster-play-p', 'aio-taster-play-n', 'aio-t5-play'],
  },
  'aio-taster-signal': {
    quelle: 'LKP Quick-Start: V- < PBP/PBN > V+; TNG constants.hpp:700–706 (A2 Vor, A1 Zurück, A4 Lauter, A3 Leiser)',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['aio-taster-weiter-signal', 'aio-taster-zurueck-signal', 'aio-taster-lauter-signal', 'aio-taster-leiser-signal', 'aio-t5'],
  },
  'aio-taster-gnd': {
    quelle: 'LKP Quick-Start: GND-Pins am Button-Adapter; Forum 14166 #9, 7946 #11',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (Lage der GND-Pins nur im Foto)',
    json: ['aio-taster-weiter-gnd', 'aio-taster-zurueck-gnd', 'aio-taster-lauter-gnd', 'aio-taster-leiser-gnd'],
  },
  'aio-lautsprecher': {
    quelle: 'LKP Quick-Start AiO: beiliegendes Kabel in SPEAKER, Lautsprecher 4–8 Ω',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
    json: ['aio-lautsprecher-plus', 'aio-lautsprecher-minus'],
  },
  'aio-usb': {
    quelle: 'LKP-Anleitung AiO S. 8: Strom über USB-C (Nr. 1)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'aio-akku': {
    quelle: 'LKP Quick-Start AiO: Akku-Stecker in BATTERY (Nr. 11), Buchse mit + markiert',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt (korrigiert)'),
  },
  'aio-kopfhoerer': {
    quelle: 'LKP-Anleitung AiO S. 9: Kopfhörerbuchse eingebaut (Nr. 4)',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'aio-neo-d5': {
    quelle: 'TNG constants.hpp:255 (D5 on AiO/Classic); LKP-FAQ: Leiste „Diverse“ GND A7 A6 D5 RX TX 3V3 5V (Forum 7829 #1); Forum 11634 #8',
    stufe: 'nachsehen',
    gegenprobe: `${TNG}; geprueft-Notiz: wahrscheinlich (Versorgung des Rings an dieser Leiste übertragen, 3,3-V-Datensignal knapp unter dem WS2812B-Wert)`,
    json: ['aio-neo-d5-di', 'aio-neo-d5-5v', 'aio-neo-d5-gnd', 'aio-neo-din', 'aio-neo-pwr'],
  },

  /* ------------------------------------------------ AiO+ (aioplus.json) */
  'ap-nfc-adapter': {
    quelle: 'LKP Quick-Start AiO+: Leser 1:1 nach Aufdruck an den NFC-Adapter; TNG constants.hpp:650–651',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'ap-nfc-kabel': {
    quelle: 'LKP Quick-Start AiO+: 8-adriges Kabel in Anschluss 13',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'ap-button-kabel': {
    quelle: 'LKP Quick-Start AiO+: 10-adriges Kabel in Anschluss 10',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt (korrigiert)'),
  },
  'ap-taster-play': {
    quelle: 'LKP Quick-Start AiO+: PBP/PBN für Play/Pause und Einschalten; TNG constants.hpp:626',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt (korrigiert)')}`,
  },
  'ap-taster': {
    quelle: 'LKP-Pintabelle AiO+ (PD1 <, PD2 >, PD3 V-, PD4 V+) und Quick-Start: Taste an Zeichen und GND daneben; TNG constants.hpp:634–640',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
    json: ['ap-taster-zurueck', 'ap-taster-vor', 'ap-taster-leiser', 'ap-taster-lauter'],
  },
  'ap-lautsprecher': {
    quelle: 'LKP Quick-Start AiO+: Stecker in SPEAKER (Nr. 8), offenes Ende an einen Lautsprecher 4–8 Ω',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
    json: ['ap-lautsprecher-loeten', 'ap-lautsprecher-stecken'],
  },
  'ap-usb': {
    quelle: 'LKP Quick-Start AiO+: USB-C (Nr. 1); Netzteil 5 V, 2–3 A, höchstens 5,1 V, keine Schnelllader',
    stufe: 'geprueft',
    gegenprobe: 'Keine eigene Verbindungs-Notiz: in aioplus.json als Bauteil „1 USB-C“ und „netzteil“ (belegt, Anleitung S. 3–4 wörtlich bestätigt) nachgelesen.',
    json: [],
  },
  'ap-akku': {
    quelle: 'LKP Quick-Start AiO+: Akku-Stecker in BATTERY (Nr. 11), + markiert',
    stufe: 'geprueft',
    gegenprobe: JSON_OK('belegt'),
  },
  'ap-kopfhoerer': {
    quelle: 'LKP-Anleitung AiO+ S. 8: Kopfhörerbuchse mit Erkennung (Nr. 4); TNG constants.hpp:663',
    stufe: 'geprueft',
    gegenprobe: `${TNG}; ${JSON_OK('belegt')}`,
  },
  'ap-ring-din': {
    quelle: 'TNG constants.hpp:249 (neoPixelRingPin = 10, PB2, Erweiterungsleiste Female); LKP-Pintabelle: PB2 = Pin 10',
    stufe: 'nachsehen',
    gegenprobe: `${TNG}; Pin belegt, aber wo PB2 auf der Leiste sitzt, ist nirgends beschrieben: darum nachsehen statt geprüft`,
    json: ['ap-ring-din', 'ap-neo-din'],
  },
  'ap-ring-pwr': {
    quelle: 'Forum 12453 #2: Ring an 5V und GND des LED-Anschlusses (WS/5V/GND) am Button-Adapter',
    stufe: 'nachsehen',
    gegenprobe: 'geprueft-Notiz: wahrscheinlich (korrigiert); dort mit anderer Firmware berichtet, Belastbarkeit des 5-V-Pins unbekannt',
    json: ['ap-ring-5v', 'ap-ring-gnd', 'ap-neo-pwr'],
  },

  /* ------------------------------------------------ physics and the forum audit of 0.3 */
  'ohm-led': {
    quelle: 'Ohmsches Gesetz: weiße oder blaue LED (etwa 3 V) mit 120 Ω an 5 V: (5 V − 3 V) / 120 Ω ≈ 17 mA, unter den üblichen 20 mA einer 5-mm-LED',
    stufe: 'geprueft',
    gegenprobe: 'Nachgerechnet; 120 Ω × (17 mA)² ≈ 0,03 W, ein normaler ¼-W-Widerstand reicht. Eine rote oder gelbe LED (etwa 2 V) bekäme 25 mA: zu viel, darum nur weiß oder blau.',
    json: [],
  },
  'powerbank-last': {
    quelle: 'Forum 6179 #1: gegen das Abschalten der Powerbank half über 30 mA Zusatzlast, z. B. „eine LED mit 120 Ω“; 14305 #11: die LED im beleuchteten Schalter zieht etwa 15 mA (Forum-Audit 0.3)',
    stufe: 'nachsehen',
    gegenprobe: 'Nur aus dem Forum-Audit vom 13.10.2026, Beiträge hier nicht selbst geöffnet (Forum vom Arbeitsrechner aus nicht erreichbar). Ob 17 mA für deine Powerbank reichen, hängt vom Modell ab.',
    json: [],
  },
  'neo-widerstand': {
    quelle: 'Adafruit NeoPixel-Überguide (Best Practices): 300–500 Ω zwischen Daten-Pin und erstem Pixel, nah am Ring',
    stufe: 'geprueft',
    gegenprobe: 'In der geprueft-Notiz cl-neo-din wörtlich zitiert; schadet auch an 3,3-V-Ausgängen (AiO, AiO+) nicht.',
    json: ['cl-neo-din'],
  },
} as const satisfies Record<string, Beleg>;

export type BelegId = keyof typeof BELEGE;

const RANG: Record<Stufe, number> = {
  geprueft: 0,
  nachsehen: 1,
  ungeprueft: 2,
};

/** The level of a wire: its weakest proof. */
export function stufeVon(ids: readonly BelegId[]): Stufe {
  let s: Stufe = 'geprueft';
  for (const id of ids) if (RANG[BELEGE[id].stufe] > RANG[s]) s = BELEGE[id].stufe;
  return ids.length ? s : 'ungeprueft';
}

/** The sources of a wire, for the list. */
export function quelleVon(ids: readonly BelegId[]): string {
  return ids.map((id) => BELEGE[id].quelle).join(' · ');
}

export const STUFE_TEXT: Record<Stufe, string> = {
  geprueft: 'geprüft',
  nachsehen: 'vor dem Löten nachsehen',
  ungeprueft: 'ungeprüft',
};
