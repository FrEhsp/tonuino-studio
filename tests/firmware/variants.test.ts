import { describe, expect, it } from 'vitest';
import {
  BOARDS,
  SD_CARD_ZIP_URL,
  askShutdown,
  boardSupportsVariant,
  boardsForUsb,
  firmwareBuilds,
  firmwareFileName,
  firmwareUrl,
  getBoard,
  readyMadeShutdownFits,
  signatureToChip,
  usbFiltersFor,
  type ShutdownKind,
} from '../../src/core/firmware/variants';

/**
 * All [env:…] sections of TonUINO-TNG platformio.ini (V3.3.3). The GitHub
 * workflow builds each of them and publishes <env>/firmware.hex, or
 * <env>/firmware.bin for the espressif32 platform.
 */
const PLATFORMIO_ENVS: [env: string, platform: 'atmelavr' | 'atmelmegaavr' | 'lgt8f' | 'espressif32'][] = [
  ['TonUINO_Classic_3', 'atmelavr'],
  ['TonUINO_Classic_5', 'atmelavr'],
  ['TonUINO_Classic_3x3', 'atmelavr'],
  ['TonUINO_Every_3', 'atmelmegaavr'],
  ['TonUINO_Every_5', 'atmelmegaavr'],
  ['TonUINO_Every_3x3', 'atmelmegaavr'],
  ['TonUINO_Every_5f', 'atmelmegaavr'],
  ['TonUINO_Every4808_3', 'atmelmegaavr'],
  ['TonUINO_Every4808_5', 'atmelmegaavr'],
  ['TonUINO_Every4808_3x3', 'atmelmegaavr'],
  ['TonUINO_Every4808_5f', 'atmelmegaavr'],
  ['ALLinONE_3', 'lgt8f'],
  ['ALLinONE_5', 'lgt8f'],
  ['ALLinONE_3x3', 'lgt8f'],
  ['ALLinONE_Plus_3', 'atmelmegaavr'],
  ['ALLinONE_Plus_5', 'atmelmegaavr'],
  ['ALLinONE_Plus_3x3', 'atmelmegaavr'],
  ['ALLinONE_Plus_5f', 'atmelmegaavr'],
  ['TonUINO_Esp32_3', 'espressif32'],
  ['TonUINO_Esp32_5', 'espressif32'],
  ['TonUINO_Esp32_3x3', 'espressif32'],
  ['TonUINO_Esp32_5f', 'espressif32'],
  ['TonUINO_Esp32_W_3', 'espressif32'],
  ['TonUINO_Esp32_W_5', 'espressif32'],
  ['TonUINO_Esp32_W_3x3', 'espressif32'],
  ['TonUINO_Esp32_W_5f', 'espressif32'],
];

describe('firmware variants', () => {
  it('builds the download URLs of the ready-made builds', () => {
    expect(firmwareUrl('classic', '3')).toBe('https://tonuino.github.io/TonUINO-TNG/TonUINO_Classic_3/firmware.hex');
    expect(firmwareUrl('aio', '3x3')).toBe('https://tonuino.github.io/TonUINO-TNG/ALLinONE_3x3/firmware.hex');
    expect(firmwareUrl('aioplus', '5f')).toBe('https://tonuino.github.io/TonUINO-TNG/ALLinONE_Plus_5f/firmware.hex');
    expect(firmwareUrl('esp32nano', '5')).toBe('https://tonuino.github.io/TonUINO-TNG/TonUINO_Esp32_5/firmware.bin');
    expect(firmwareFileName('every', '5')).toBe('TonUINO_Every_5.hex');
    expect(SD_CARD_ZIP_URL).toBe('https://tonuino.github.io/TonUINO-TNG/sd-card.zip');
  });

  it('offers exactly the builds that the TonUINO-TNG workflow publishes', () => {
    const published = PLATFORMIO_ENVS.map(
      ([env, platform]) => `https://tonuino.github.io/TonUINO-TNG/${env}/firmware.${platform === 'espressif32' ? 'bin' : 'hex'}`,
    );
    const builds = firmwareBuilds();
    expect(builds.map((b) => b.url).sort()).toEqual([...published].sort());
    expect(new Set(builds.map((b) => b.env)).size).toBe(26);
    expect(builds.find((b) => b.env === 'ALLinONE_Plus_5f')).toEqual({
      board: 'aioplus',
      variant: '5f',
      env: 'ALLinONE_Plus_5f',
      url: 'https://tonuino.github.io/TonUINO-TNG/ALLinONE_Plus_5f/firmware.hex',
    });
  });

  it('has no "all extras" build for Classic and AiO', () => {
    expect(boardSupportsVariant('classic', '5f')).toBe(false);
    expect(boardSupportsVariant('aio', '5f')).toBe(false);
    expect(boardSupportsVariant('aioplus', '5f')).toBe(true);
    expect(() => firmwareUrl('classic', '5f')).toThrow(RangeError);
  });

  it('knows the upload settings of the flashable boards', () => {
    const classic = getBoard('classic');
    const aioplus = getBoard('aioplus');
    if (classic.method !== 'stk500' || aioplus.method !== 'stk500') throw new Error('expected STK500 boards');
    expect(classic.flash.baudRates).toEqual([57600, 115200]);
    expect(classic.holdPlayPause).toBe(false);
    expect(aioplus.flash).toMatchObject({ byteAddressing: true, appStart: 0x200, signature: [0x1e, 0x96, 0x51] });
    expect(aioplus.holdPlayPause).toBe(true);
    expect(getBoard('every').method).toBe('unsupported');
    const esp = getBoard('esp32wroom');
    if (esp.method !== 'esp32') throw new Error('expected an ESP32 board');
    expect(esp.update).toMatchObject({ otaPath: '/upgrade', otaUser: 'admin', otaPassword: 'admin', apSsid: 'TonUINO', apUrl: 'http://192.168.4.1' });
    expect(esp.update.steps.join(' ')).toContain('http://192.168.4.1/upgrade');
    for (const b of BOARDS) {
      expect(b.name.length).toBeGreaterThan(0);
      if (b.method === 'stk500') {
        expect(b.flash.pageSize % 2).toBe(0);
        expect(b.flash.baudRates.length).toBeGreaterThan(0);
        expect(b.flash.maxBytes).toBeGreaterThan(20000);
      }
    }
  });

  it('guesses boards from the USB ids', () => {
    expect(boardsForUsb(0x04d9, 0xb534).map((b) => b.id)).toEqual(['aio']);
    expect(boardsForUsb(0x1a86, 0x7523).map((b) => b.id)).toEqual(['classic', 'aioplus', 'esp32wroom']);
    expect(boardsForUsb(0x2341, 0x0058).map((b) => b.id)).toEqual(['every']);
    // Other Arduino product ids only match the vendor-wide entry.
    expect(boardsForUsb(0x2341, 0x0043).map((b) => b.id)).toEqual(['classic']);
    expect(boardsForUsb(0x0000, 0x0000)).toEqual([]);
    expect(boardsForUsb(undefined)).toEqual([]);
    expect(usbFiltersFor('classic')).toContainEqual({ usbVendorId: 0x2341 });
  });

  it('names the chip behind a signature', () => {
    expect(signatureToChip([0x1e, 0x95, 0x0f])?.boards).toEqual(['classic', 'aio']);
    expect(signatureToChip([0x1e, 0x96, 0x51])).toMatchObject({ chip: 'ATmega4809', hint: 'Das sieht nach einer AiO+-Platine aus.' });
    expect(signatureToChip([0x1e, 0x94, 0x06])?.chip).toBe('ATmega168');
    expect(signatureToChip([0x12, 0x34, 0x56])).toBeNull();
  });
});

describe('how the box switches off', () => {
  const KINDS: ShutdownKind[] = ['switch', 'pololu', 'traeger', 'unknown'];

  it('asks only where the ready-made build drives a shutdown pin that boxes wire differently', () => {
    expect(BOARDS.filter((b) => askShutdown(b)).map((b) => b.id)).toEqual(['classic', 'esp32nano', 'esp32wroom']);
    // AiO and AiO+ switch off with their own circuit on the board.
    expect(askShutdown('aio')).toBe(false);
    expect(askShutdown('aioplus')).toBe(false);
  });

  it('knows which ready-made build switches which box off the right way', () => {
    // TNG 3.3.2 and later (constants.hpp): Classic, both Nano Every boards and the ESP32 Nano drive the pin high (Pololu),
    // the WROOM drives it low (CubieKid, Trägerplatine). AiO and AiO+ switch off with their own circuit.
    const unfitting = new Set(['classic/traeger', 'every/traeger', 'every4808/traeger', 'esp32nano/traeger', 'esp32wroom/pololu']);
    for (const b of BOARDS) {
      for (const kind of KINDS) {
        expect(readyMadeShutdownFits(b.id, kind), `${b.id}/${kind}`).toBe(!unfitting.has(`${b.id}/${kind}`));
      }
    }
    expect(readyMadeShutdownFits(getBoard('classic'), 'pololu')).toBe(true);
  });
});
