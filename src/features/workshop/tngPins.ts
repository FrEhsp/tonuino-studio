/**
 * The pins TonUINO TNG uses, per board, read from its source
 * (src/constants.hpp of TonUINO-TNG 3.3.3, a copy is in
 * tests/fixtures/tng/constants.hpp). Every wire of the Lötplan that ends at
 * a pin of the microcontroller names its entry here, and the tests check
 * both: the wire against this table, and this table line by line against
 * the firmware source, inside the right #if branch.
 *
 * The Nano Every uses the same block as the Classic Nano (constants.hpp:549,
 * "TonUINO_Classic or TonUINO_Every or TonUINO_Every_4808"), so it shares
 * the Classic column.
 */

export type TngPlatine = 'classic' | 'aio' | 'aioplus';

export type TngFunktion =
  | 'pause'
  | 'up3'
  | 'down3'
  | 'up5'
  | 'down5'
  | 'four5'
  | 'five5'
  | 'rfidRst'
  | 'rfidSs'
  | 'dfRx'
  | 'dfTx'
  | 'busy'
  | 'shutdown'
  | 'encClk'
  | 'encDt'
  | 'poti'
  | 'ring'
  | 'spkOnOff'
  | 'hpDetect'
  | 'batVoltage'
  | 'ledPlay'
  | 'ledUp'
  | 'ledDown'
  | 'specialStart';

export interface TngPin {
  /** As the board prints it, e.g. "A0", "D5"; on the AiO+ the port name, e.g. "PB2". */
  pin: string;
  /** The value in constants.hpp, e.g. "A0", "D5", "36". */
  wert: string;
  /** The constant it is assigned to. */
  name: string;
  /** Line in constants.hpp. */
  zeile: number;
  /** The #if branches the line must sit in (text of the branch, "→ #else" for an else branch). */
  in: string[];
}

const CLASSIC = '#if defined(TonUINO_Classic) or defined(TonUINO_Every) or defined(TonUINO_Every_4808)';
const AIO = '#ifdef ALLinONE';
const AIOPLUS = '#ifdef ALLinONE_Plus';
const NOT_AIOPLUS = '#ifdef ALLinONE_Plus → #else';

const p = (pin: string, wert: string, name: string, zeile: number, ...inBranch: string[]): TngPin => ({ pin, wert, name, zeile, in: inBranch });

export const TNG_PINS: Record<TngPlatine, Partial<Record<TngFunktion, TngPin>>> = {
  classic: {
    pause: p('A0', 'A0', 'buttonPausePin', 552, CLASSIC),
    up3: p('A1', 'A1', 'buttonUpPin', 565, CLASSIC, '#if defined(BUTTONS3X3) → #else'),
    down3: p('A2', 'A2', 'buttonDownPin', 566, CLASSIC, '#if defined(BUTTONS3X3) → #else'),
    up5: p('A3', 'A3', 'buttonUpPin', 560, CLASSIC, '#elif defined(FIVEBUTTONS)'),
    down5: p('A4', 'A4', 'buttonDownPin', 561, CLASSIC, '#elif defined(FIVEBUTTONS)'),
    four5: p('A1', 'A1', 'buttonFourPin', 562, CLASSIC, '#elif defined(FIVEBUTTONS)'),
    five5: p('A2', 'A2', 'buttonFivePin', 563, CLASSIC, '#elif defined(FIVEBUTTONS)'),
    rfidRst: p('D9', '9', 'mfrc522_RSTPin', 576, CLASSIC),
    rfidSs: p('D10', '10', 'mfrc522_SSPin', 577, CLASSIC),
    dfRx: p('D2', '2', 'dfPlayer_receivePin', 585, CLASSIC, '#ifdef DFPlayerUsesHardwareSerial → #else'),
    dfTx: p('D3', '3', 'dfPlayer_transmitPin', 586, CLASSIC, '#ifdef DFPlayerUsesHardwareSerial → #else'),
    busy: p('D4', '4', 'dfPlayer_busyPin', 590, CLASSIC),
    shutdown: p('D7', '7', 'shutdownPin', 602, CLASSIC),
    encClk: p('A3', 'A3', 'rotaryEncoderClkPin', 209, '#ifdef ROTARY_ENCODER', NOT_AIOPLUS),
    encDt: p('A4', 'A4', 'rotaryEncoderDtPin', 210, '#ifdef ROTARY_ENCODER', NOT_AIOPLUS),
    poti: p('A3', 'A3', 'potiPin', 232, '#ifdef POTI', NOT_AIOPLUS),
    ring: p('D5', 'D5', 'neoPixelRingPin', 255, '#ifdef NEO_RING', NOT_AIOPLUS),
    spkOnOff: p('D6', 'D6', 'ampEnablePin', 284, '#ifdef SPKONOFF', '#if not defined(ALLinONE_Plus) and not defined(ALLinONE) and not (TonUINO_Esp32 == 200)'),
    hpDetect: p('D8', 'D8', 'dfPlayer_noHeadphoneJackDetect', 303, '#ifdef HPJACKDETECT', '#if not defined(ALLinONE_Plus)  and not (TonUINO_Esp32 == 200)'),
    batVoltage: p('A5', 'A5', 'voltageMeasurementPin', 405, '#ifdef BAT_VOLTAGE_MEASUREMENT', '#if not defined(ALLinONE_Plus) and not defined(ALLinONE) and not (TonUINO_Esp32 == 200)'),
    ledPlay: p('A5', 'A5', 'led_play_pin', 508, '#ifdef USE_LED_BUTTONS'),
    ledUp: p('D6', 'D6', 'led_up_pin', 509, '#ifdef USE_LED_BUTTONS'),
    ledDown: p('D5', 'D5', 'led_down_pin', 510, '#ifdef USE_LED_BUTTONS'),
    specialStart: p('A6', 'A6', 'specialStartShortcutPin', 365, '#ifdef SPECIAL_START_SHORTCUT', NOT_AIOPLUS),
  },
  aio: {
    pause: p('A0', 'A0', 'buttonPausePin', 692, AIO),
    up3: p('A2', 'A2', 'buttonUpPin', 700, AIO, '#ifdef BUTTONS3X3 → #else'),
    down3: p('A1', 'A1', 'buttonDownPin', 701, AIO, '#ifdef BUTTONS3X3 → #else'),
    up5: p('A2', 'A2', 'buttonUpPin', 700, AIO, '#ifdef BUTTONS3X3 → #else'),
    down5: p('A1', 'A1', 'buttonDownPin', 701, AIO, '#ifdef BUTTONS3X3 → #else'),
    four5: p('A4', 'A4', 'buttonFourPin', 705, AIO, '#ifdef FIVEBUTTONS'),
    five5: p('A3', 'A3', 'buttonFivePin', 706, AIO, '#ifdef FIVEBUTTONS'),
    rfidRst: p('D9', '9', 'mfrc522_RSTPin', 716, AIO),
    rfidSs: p('D10', '10', 'mfrc522_SSPin', 717, AIO),
    busy: p('D4', '4', 'dfPlayer_busyPin', 726, AIO),
    shutdown: p('D7', '7', 'shutdownPin', 732, AIO),
    spkOnOff: p('D8', '8', 'ampEnablePin', 734, AIO),
    // The knob and the poti take the pins of the 4th and 5th button: V+ (A4) and V− (A3) of the button adapter.
    encClk: p('A3', 'A3', 'rotaryEncoderClkPin', 209, '#ifdef ROTARY_ENCODER', NOT_AIOPLUS),
    encDt: p('A4', 'A4', 'rotaryEncoderDtPin', 210, '#ifdef ROTARY_ENCODER', NOT_AIOPLUS),
    poti: p('A3', 'A3', 'potiPin', 232, '#ifdef POTI', NOT_AIOPLUS),
    ring: p('D5', 'D5', 'neoPixelRingPin', 255, '#ifdef NEO_RING', NOT_AIOPLUS),
    specialStart: p('A6', 'A6', 'specialStartShortcutPin', 365, '#ifdef SPECIAL_START_SHORTCUT', NOT_AIOPLUS),
  },
  aioplus: {
    pause: p('A0', 'A0', 'buttonPausePin', 626, AIOPLUS),
    up3: p('A2', 'A2', 'buttonUpPin', 634, AIOPLUS, '#ifdef BUTTONS3X3 → #else'),
    down3: p('A1', 'A1', 'buttonDownPin', 635, AIOPLUS, '#ifdef BUTTONS3X3 → #else'),
    up5: p('A2', 'A2', 'buttonUpPin', 634, AIOPLUS, '#ifdef BUTTONS3X3 → #else'),
    down5: p('A1', 'A1', 'buttonDownPin', 635, AIOPLUS, '#ifdef BUTTONS3X3 → #else'),
    four5: p('A4', 'A4', 'buttonFourPin', 639, AIOPLUS, '#ifdef FIVEBUTTONS'),
    five5: p('A3', 'A3', 'buttonFivePin', 640, AIOPLUS, '#ifdef FIVEBUTTONS'),
    rfidRst: p('11', '11', 'mfrc522_RSTPin', 650, AIOPLUS),
    rfidSs: p('7', '7', 'mfrc522_SSPin', 651, AIOPLUS),
    busy: p('13', '13', 'dfPlayer_busyPin', 660, AIOPLUS),
    hpDetect: p('PC7', '21', 'dfPlayer_noHeadphoneJackDetect', 663, AIOPLUS),
    shutdown: p('27', '27', 'shutdownPin', 668, AIOPLUS),
    spkOnOff: p('19', '19', 'ampEnablePin', 670, AIOPLUS),
    batVoltage: p('A6', 'A6', 'voltageMeasurementPin', 674, AIOPLUS),
    encClk: p('PF2', '36', 'rotaryEncoderClkPin', 201, '#ifdef ROTARY_ENCODER', AIOPLUS),
    encDt: p('PF3', '37', 'rotaryEncoderDtPin', 202, '#ifdef ROTARY_ENCODER', AIOPLUS),
    poti: p('PF4', 'A14', 'potiPin', 226, '#ifdef POTI', AIOPLUS),
    ring: p('PB2', '10', 'neoPixelRingPin', 249, '#ifdef NEO_RING', AIOPLUS),
    specialStart: p('PE3', '33', 'specialStartShortcutPin', 359, '#ifdef SPECIAL_START_SHORTCUT', AIOPLUS),
  },
};

/** The entry of a board and function; throws when the firmware has no such pin there. */
export function tngPin(platine: TngPlatine, funktion: TngFunktion): TngPin {
  const e = TNG_PINS[platine][funktion];
  if (!e) throw new Error(`TNG kennt ${funktion} auf ${platine} nicht`);
  return e;
}

/** "TNG src/constants.hpp:552 (buttonPausePin = A0)": the source line of a pin, for the wire list. */
export function tngQuelle(platine: TngPlatine, funktion: TngFunktion): string {
  const e = tngPin(platine, funktion);
  return `TNG src/constants.hpp:${e.zeile} (${e.name} = ${e.wert})`;
}

/**
 * The SPI pins of the card reader are not in constants.hpp: the MFRC522
 * library uses the hardware SPI of the chip, which on the ATmega328P of the
 * Nano is D11 (MOSI), D12 (MISO) and D13 (SCK) (Arduino Nano data sheet
 * A000005, pin table; same on the Nano Every).
 */
export const NANO_SPI = { MOSI: 'D11', MISO: 'D12', SCK: 'D13' } as const;
export const NANO_SPI_QUELLE = 'Arduino-Nano-Datenblatt A000005 (SPI: D11 MOSI, D12 MISO, D13 SCK); MFRC522-Bibliothek nutzt die Hardware-SPI';
