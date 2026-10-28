import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BaukastenManifest } from '../../src/core/firmware/baukasten';
import { FirmwareDownloadError, type FetchFn, type FlashProblem, type FlashStatus, type FlashSuccess } from '../../src/core/firmware/flash';
import { parseIntelHex, toIntelHex } from '../../src/core/firmware/intelhex';
import { getBoard, type BoardId, type ButtonVariant, type Esp32Board, type ShutdownKind } from '../../src/core/firmware/variants';
import type { ByteSource } from '../../src/platform/types';
import type { BoxInfo } from '../../src/core/firmware/bootlog';
import {
  acceptUnchecked,
  applyGuess,
  baukastenChoice,
  chooseExtras,
  loadBaukasten,
  wantedBuildId,
  wantsBaukasten,
  backupChoice,
  backupFileName,
  boxVersion,
  canEnter,
  chooseBoard,
  chooseFirmware,
  chooseShutdown,
  chooseVariant,
  esp32Guide,
  flashHints,
  firmwareLabel,
  firmwareVersion,
  flashPhases,
  goTo,
  guessFromInfo,
  guessText,
  boxMayBeChanged,
  holdAgainFits,
  initialWizard,
  keepsText,
  loadReadyMade,
  nextStep,
  nextSteps,
  percent,
  phaseIndex,
  previousStep,
  pickReadyMade,
  readOwnFirmware,
  readyMadeAllowed,
  shutdownAdvice,
  SHUTDOWN_CHOICES,
  sourceBlocker,
  RESET_GUIDE,
  SETTINGS_LINK,
  sizeProblem,
  stepsFor,
  successFacts,
  successTechnical,
  variantAdvice,
  variantsFor,
  versionFacts,
  uncheckedText,
  type FirmwareChoice,
  type WizardState,
} from '../../src/features/workshop/wizard';
import { CHECKED_TNG, isChecked, standTitle } from '../../src/core/firmware/tngstands';
import { firmwareBytes } from '../firmware/simulator';

const classic = getBoard('classic');
const aioplus = getBoard('aioplus');

function source(name: string, bytes: Uint8Array | string): ByteSource {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return { name, size: data.length, read: async (start, length) => data.slice(start, start + length) };
}

type Download = Extract<FirmwareChoice, { kind: 'download' }>;

/** The ready-made build as the page gets it: Classic and AiO from the Baukasten (the checked state, no extras), others downloaded. */
function download(board: BoardId = 'classic', variant: ButtonVariant = '3'): Download {
  const fw: Download = { kind: 'download', board, variant, fileName: `TonUINO_Classic_${variant}.hex`, url: 'https://example.invalid/x.hex', fileBytes: 100, image: parseIntelHex(toIntelHex(firmwareBytes(64))) };
  if (board === 'classic' || board === 'aio') fw.baukasten = { id: `${board}-${variant}`, summary: '', stand: 'TonUINO TNG 3.3.3 vom 17.09.2026', source: '', needsNewBootloader: false };
  return fw;
}

/** Firmware bytes with a text inside, as the compiler leaves strings in flash. */
function textBytes(text: string): Uint8Array {
  const out = firmwareBytes(600, 5);
  const at = 300;
  out[at - 1] = 0;
  out.set(new TextEncoder().encode(text), at);
  out[at + text.length] = 0;
  return out;
}

const hexWithText = (text: string) => parseIntelHex(toIntelHex(textBytes(text)));

function boxInfo(info: Partial<BoxInfo>): BoxInfo {
  return { settings: {}, folderTracks: {}, ...info };
}

describe('wizard steps', () => {
  it('has four steps for USB boards, five with the Baukasten, three for ESP32 and one for boards it cannot flash', () => {
    // Classic and AiO: the Firmware-Baukasten with „Extras“ and „Verhalten“ (0.6).
    expect(stepsFor(classic).map((s) => s.label)).toEqual(['Platine', 'Tasten', 'Extras', 'Verhalten', 'Aufspielen']);
    expect(stepsFor(getBoard('aio')).map((s) => s.id)).toEqual(['board', 'variant', 'source', 'verhalten', 'flash']);
    expect(stepsFor(aioplus).map((s) => s.label)).toEqual(['Platine', 'Tasten', 'Firmware', 'Aufspielen']);
    expect(stepsFor(undefined)).toHaveLength(5);
    expect(stepsFor(getBoard('esp32wroom')).map((s) => s.label)).toEqual(['Platine', 'Tasten', 'Update über WLAN']);
    expect(stepsFor(getBoard('every')).map((s) => s.id)).toEqual(['board']);
  });

  it('opens a step only when everything before it is chosen', () => {
    let s: WizardState = initialWizard();
    expect(canEnter(s, 'variant')).toBe(false);
    expect(nextStep(s)).toBeNull();

    s = chooseBoard(s, 'every');
    expect(canEnter(s, 'variant')).toBe(false);

    s = chooseBoard(s, 'classic');
    expect(nextStep(s)).toBe('variant');
    s = goTo(s, 'variant');
    expect(s.step).toBe('variant');
    expect(goTo(s, 'flash').step).toBe('variant');

    s = chooseVariant(s, '5');
    s = goTo(s, 'source');
    expect(canEnter(s, 'flash')).toBe(false);
    s = chooseFirmware(s, download('classic', '5'));
    // The Classic is asked how it switches off before the ready-made build may go on.
    expect(nextStep(s)).toBeNull();
    s = chooseShutdown(s, 'switch');
    // The Baukasten goes through „Verhalten“ before the upload.
    expect(nextStep(s)).toBe('verhalten');
    s = goTo(s, 'verhalten');
    expect(s.step).toBe('verhalten');
    expect(nextStep(s)).toBe('flash');
    expect(previousStep(s)).toBe('source');
    expect(previousStep(goTo(s, 'flash'))).toBe('verhalten');
    expect(previousStep(initialWizard())).toBeNull();
  });

  it('takes a file of your own past „Verhalten“ straight to the upload, and back', () => {
    const own: FirmwareChoice = { kind: 'file', board: 'classic', fileName: 'mine.hex', fileBytes: 10, image: parseIntelHex(toIntelHex(firmwareBytes(8))) };
    let s: WizardState = { ...chooseFirmware(chooseVariant(chooseBoard(initialWizard(), 'classic'), '3'), own), step: 'source' };
    expect(canEnter(s, 'verhalten')).toBe(false);
    expect(nextStep(s)).toBe('flash');
    s = goTo(s, 'flash');
    expect(previousStep(s)).toBe('source');
    // The other boards keep their four steps.
    let p = chooseVariant(chooseBoard(initialWizard(), 'aioplus'), '5');
    p = goTo(goTo(p, 'variant'), 'source');
    expect(canEnter(p, 'verhalten')).toBe(false);
    expect(nextStep(chooseFirmware(p, download('aioplus', '5')))).toBe('flash');
  });

  it('never offers USB flashing for ESP32 boxes', () => {
    let s = chooseVariant(chooseBoard(initialWizard(), 'esp32nano'), '5f');
    s = goTo(goTo(s, 'variant'), 'source');
    expect(s.step).toBe('source');
    expect(nextStep(s)).toBeNull();
    expect(canEnter(chooseFirmware(s, { ...download(), board: 'esp32nano' }), 'flash')).toBe(false);
  });

  it('keeps what still fits when the board or the buttons change', () => {
    let s = chooseFirmware(chooseVariant(chooseBoard(initialWizard(), 'aioplus'), '5f'), { ...download(), board: 'aioplus', variant: '5f' });
    // The Classic has no "5f" build: the variant and the download go.
    s = chooseBoard(s, 'classic');
    expect(s.variant).toBeUndefined();
    expect(s.firmware).toBeUndefined();

    s = chooseFirmware(chooseVariant(s, '3'), download('classic', '3'));
    expect(chooseVariant(s, '5').firmware).toBeUndefined();
    expect(chooseBoard(s, 'classic').firmware).toBe(s.firmware);
    expect(chooseBoard(s, 'aioplus')).toMatchObject({ variant: '3', firmware: undefined });

    const own: FirmwareChoice = { kind: 'file', board: 'classic', fileName: 'mine.hex', fileBytes: 10, image: parseIntelHex(toIntelHex(firmwareBytes(8))) };
    s = chooseFirmware(s, own);
    expect(chooseVariant(s, '5').firmware).toBe(own);
    expect(chooseBoard(s, 'aio').firmware).toBeUndefined();
  });

  it('lets a ready-made build go on only when it switches the box off the right way', () => {
    const at = (board: BoardId, variant: ButtonVariant = '3'): WizardState => ({
      ...chooseFirmware(chooseVariant(chooseBoard(initialWizard(), board), variant), download(board, variant)),
      step: 'source',
    });
    // No answer yet on a board that is asked.
    expect(canEnter(at('classic'), 'flash')).toBe(false);
    expect(canEnter(chooseShutdown(at('classic'), 'switch'), 'flash')).toBe(true);
    expect(canEnter(chooseShutdown(at('classic'), 'pololu'), 'flash')).toBe(true);
    expect(canEnter(chooseShutdown(at('classic'), 'unknown'), 'flash')).toBe(true);
    // The ready-made Classic build drives the pin high; a CubieKid or carrier board would switch off at once.
    const traeger = chooseShutdown(at('classic'), 'traeger');
    expect(canEnter(traeger, 'flash')).toBe(false);
    expect(traeger.firmware).toBeUndefined();
    expect(canEnter({ ...traeger, firmware: download('classic', '3') }, 'flash')).toBe(false);
    // A file of your own is always allowed: it may be built for that box.
    const own: FirmwareChoice = { kind: 'file', board: 'classic', fileName: 'mine.hex', fileBytes: 10, image: parseIntelHex(toIntelHex(firmwareBytes(8))) };
    expect(canEnter(chooseFirmware(traeger, own), 'flash')).toBe(true);
    expect(canEnter(chooseFirmware(at('classic'), own), 'flash')).toBe(true);
    expect(chooseShutdown(chooseFirmware(at('classic'), own), 'traeger').firmware).toBe(own);
    // AiO and AiO+ are not asked.
    expect(canEnter(at('aioplus', '5'), 'flash')).toBe(true);
    expect(canEnter(at('aio'), 'flash')).toBe(true);

    expect(readyMadeAllowed('esp32wroom', 'pololu')).toBe(false);
    expect(readyMadeAllowed('esp32wroom', 'traeger')).toBe(true);
    expect(readyMadeAllowed('esp32nano', 'traeger')).toBe(false);
    expect(readyMadeAllowed('esp32nano', undefined)).toBe(false);
    expect(readyMadeAllowed('aio', undefined)).toBe(true);
  });

  it('drops a file of your own when „Fertige Firmware“ is chosen, so it cannot slip past the question', () => {
    const own: FirmwareChoice = { kind: 'file', board: 'classic', fileName: 'mine.hex', fileBytes: 10, image: parseIntelHex(toIntelHex(firmwareBytes(8))) };
    let s: WizardState = { ...chooseFirmware(chooseVariant(chooseBoard(initialWizard(), 'classic'), '3'), own), step: 'source' };
    expect(nextStep(s)).toBe('flash');
    // File, then „Fertige Firmware“ without an answer: nothing may be uploaded.
    s = pickReadyMade(s);
    expect(s.firmware).toBeUndefined();
    expect(nextStep(s)).toBeNull();
    // Answering „Mit CubieKid- oder Trägerplatine“ does not bring the old file back either: on to „Verhalten“, but no upload yet.
    expect(nextStep(chooseShutdown(s, 'traeger'))).toBe('verhalten');
    expect(chooseShutdown(s, 'traeger').firmware).toBeUndefined();
    expect(canEnter(goTo(chooseShutdown(s, 'traeger'), 'verhalten'), 'flash')).toBe(false);
    // A ready-made build already loaded stays.
    const ready = chooseFirmware(s, download('classic', '3'));
    expect(pickReadyMade(ready)).toBe(ready);
  });

  it('says why „Weiter“ stays off while the shutdown question is open', () => {
    expect(sourceBlocker(classic, 'download', undefined)).toBe('Sage zuerst oben, wie deine Box ausgeht.');
    // Classic with a carrier board: the Firmware-Baukasten has a build for it.
    expect(sourceBlocker(classic, 'download', 'traeger')).toBeUndefined();
    expect(sourceBlocker(getBoard('esp32nano'), 'download', 'traeger')).toBe('Nimm für deine Box „Eigene Datei“.');
    expect(sourceBlocker(classic, 'download', 'pololu')).toBeUndefined();
    expect(sourceBlocker(classic, 'download', 'unknown')).toBeUndefined();
    expect(sourceBlocker(classic, 'file', undefined)).toBeUndefined();
    expect(sourceBlocker(classic, null, undefined)).toBeUndefined();
    expect(sourceBlocker(getBoard('aio'), 'download', undefined)).toBeUndefined();
  });

  it('forgets how the box switches off when another board is chosen', () => {
    const s = chooseShutdown(chooseBoard(initialWizard(), 'classic'), 'pololu');
    expect(chooseBoard(s, 'classic').shutdown).toBe('pololu');
    expect(chooseBoard(s, 'aio').shutdown).toBeUndefined();
    expect(chooseBoard(s, 'esp32nano').shutdown).toBeUndefined();
    expect(chooseVariant(s, '5').shutdown).toBe('pololu');
  });

  it('asks in plain words and warns before a build that would switch the box off the wrong way', () => {
    expect(SHUTDOWN_CHOICES.map((c) => c.id)).toEqual(['switch', 'pololu', 'traeger', 'unknown']);
    expect(SHUTDOWN_CHOICES.map((c) => c.label)).toEqual(['Mit Schalter oder Powerbank', 'Mit Pololu-Schalter', 'Mit CubieKid- oder Trägerplatine', 'Weiß ich nicht']);

    const wroom = getBoard('esp32wroom');
    expect(shutdownAdvice(classic, undefined)).toBeUndefined();
    expect(shutdownAdvice(classic, 'switch')).toBeUndefined();
    expect(shutdownAdvice(classic, 'pololu')).toBeUndefined();
    expect(shutdownAdvice(getBoard('aio'), 'traeger')).toBeUndefined();

    // The Classic gets a build of the Firmware-Baukasten with the shutdown the other way round.
    const baukasten = shutdownAdvice(classic, 'traeger')!;
    expect(baukasten.tone).toBe('neutral');
    expect(baukasten.text).toContain('Abschaltung andersherum');
    const wrong = shutdownAdvice(getBoard('esp32nano'), 'traeger')!;
    expect(wrong.tone).toBe('warning');
    expect(wrong.text).toMatch(/^Für deine Box gibt es keine fertige Firmware\./);
    expect(wrong.text).toContain('gleich nach dem Einschalten wieder aus');
    expect(wrong.text).toContain('nach der passenden Datei');
    const esp = shutdownAdvice(wroom, 'pololu')!;
    expect(esp.tone).toBe('warning');
    // ESP32 boxes have no „Eigene Datei“ in the app.
    expect(esp.text).not.toContain('Eigene Datei');

    const unsure = shutdownAdvice(classic, 'unknown')!;
    expect(unsure).toMatchObject({ tone: 'neutral' });
    expect(unsure.text).toContain('„Alte Firmware vorher sichern“');
    // The wrong shutdown only shows once the USB cable is out: the cable keeps the box on.
    expect(unsure.text).toContain('ohne USB-Kabel');
    const unsureEsp = shutdownAdvice(wroom, 'unknown')!;
    expect(unsureEsp.text).toContain('passt die Abschaltung nicht. Dann brauchst du eine passende Datei von dem, der die Box gebaut hat.');
    expect(unsureEsp.text).not.toContain('Sicherung');

    // Nothing says Pololu boxes need a file of their own: the ready-made build switches a Pololu.
    for (const c of SHUTDOWN_CHOICES) {
      for (const b of [classic, getBoard('esp32nano'), wroom]) {
        const advice = shutdownAdvice(b, c.id);
        if (c.id === 'pololu' && b.id !== 'esp32wroom') expect(advice).toBeUndefined();
      }
    }
  });

  it('lists the variants of a board', () => {
    expect(variantsFor(classic).map((v) => v.id)).toEqual(['3', '5', '3x3']);
    expect(variantsFor(aioplus).map((v) => v.label)).toEqual(['3 Tasten', '5 Tasten', '3×3-Tastenfeld', '5 Tasten mit allen Extras']);
  });
});

describe('Firmware-Baukasten', () => {
  const PUBLIC = join(__dirname, '../../public/');
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'firmware/baukasten/manifest.json'), 'utf8')) as BaukastenManifest;
  const fileFetch = async (url: string) => {
    const path = join(PUBLIC, url.replace(/^\.\//, ''));
    return existsSync(path) ? new Response(readFileSync(path)) : new Response(null, { status: 404 });
  };
  const at = (board: BoardId, variant: ButtonVariant = '3'): WizardState => ({ ...chooseVariant(chooseBoard(initialWizard(), board), variant), step: 'source' });

  it('wants a build with extras only when something is ticked or the carrier board needs it', () => {
    const s = chooseShutdown(at('classic'), 'switch');
    expect(wantsBaukasten(s)).toBe(false);
    // Without extras the plain build of the checked state, not the newest from the server.
    expect(wantedBuildId(s)).toBe('classic-3');
    expect(wantedBuildId(at('aio', '5'))).toBe('aio-5');
    expect(wantedBuildId(at('aioplus', '5'))).toBeUndefined();
    expect(wantedBuildId(chooseExtras(s, { knob: 'encoder' }))).toBe('classic-3-encoder');
    expect(wantedBuildId(chooseShutdown(s, 'traeger'))).toBe('classic-3-traeger');
    expect(wantedBuildId(chooseExtras(chooseShutdown(s, 'traeger'), { knob: 'poti', preset: 'weiter' }))).toBe('classic-3-poti-traeger-weiter');
    // Another MP3 chip alone already needs a build of the Baukasten.
    expect(wantedBuildId(chooseExtras(s, { chip: 'mh2024k24ss' }))).toBe('classic-3-mh2024k24ss');
    expect(wantedBuildId(chooseExtras(at('aio', '5'), { chip: 'gd3200b' }))).toBe('aio-5-gd3200b');
    expect(wantedBuildId(chooseExtras(s, { chip: 'standard' }))).toBe('classic-3');
    // What the buttons cannot have is left out: with 5 buttons A3/A4 are taken.
    expect(baukastenChoice(chooseVariant(chooseExtras(s, { knob: 'encoder', light: 'ring' }), '5'))?.choice).toEqual({ light: 'ring' });
    // Boards without the Baukasten never want it.
    expect(wantsBaukasten(chooseExtras(at('aioplus', '5'), { knob: 'encoder' }))).toBe(false);
    expect(baukastenChoice(at('esp32nano'))).toBeUndefined();
  });

  it('keeps the extras when the buttons change, but drops a build that no longer matches', async () => {
    let s = chooseExtras(chooseShutdown(at('classic'), 'switch'), { knob: 'encoder' });
    const fw = await loadBaukasten(fileFetch, './', manifest, s);
    s = chooseFirmware(s, fw);
    expect(canEnter(s, 'flash')).toBe(true);
    expect(chooseExtras(s, { knob: 'encoder' }).firmware).toBe(fw);
    expect(chooseExtras(s, { knob: 'poti' }).firmware).toBeUndefined();
    expect(chooseExtras(s, {}).firmware).toBeUndefined();
    expect(chooseShutdown(s, 'traeger').firmware).toBeUndefined();
    expect(chooseVariant(s, '5').firmware).toBeUndefined();
    expect(chooseVariant(s, '5').extras).toEqual({ knob: 'encoder' });
    // The official build does not go on when extras are ticked.
    const official = chooseFirmware(s, download('classic', '3'));
    expect(canEnter(official, 'flash')).toBe(false);
  });

  it('loads the build with extras that came with the app, with its source', async () => {
    const s = chooseExtras(chooseShutdown(at('classic'), 'traeger'), { knob: 'encoderSkip' });
    const fw = await loadBaukasten(fileFetch, './', manifest, s);
    expect(fw).toMatchObject({ kind: 'download', board: 'classic', variant: '3', fileName: 'TonUINO-TNG_classic-3-encoderSkip-traeger.hex' });
    if (fw.kind !== 'download') throw new Error('download expected');
    expect(fw.baukasten).toMatchObject({ id: 'classic-3-encoderSkip-traeger', needsNewBootloader: false });
    expect(fw.baukasten?.summary).toBe('Drehregler mit Vor und Zurück, Abschaltung für CubieKid- oder Trägerplatine');
    expect(fw.baukasten?.source).toContain('-D ROTARY_ENCODER -D ROTARY_ENCODER_LONGPRESS -D USE_TRAEGER_PLATINE_SHUTDOWN');
    expect(fw.image.byteCount).toBe(fw.fileBytes);
    expect(canEnter(chooseFirmware(s, fw), 'flash')).toBe(true);
    expect(successFacts({ ok: true, baud: 57600, signature: [0x1e, 0x95, 0x0f], bootloaderVersion: '1.16', bytesWritten: fw.fileBytes, verified: true, durationMs: 20_000 }, classic, fw).find((f) => f.label === 'Extras')?.value).toBe(fw.baukasten?.summary);
  });

  it('gives Classic and AiO the checked state that came with the app as the ready-made firmware', async () => {
    for (const [board, variant] of [['classic', '3'], ['classic', '5'], ['aio', '3'], ['aio', '5']] as const) {
      const s = chooseShutdown(at(board, variant), 'switch');
      const fw = await loadBaukasten(fileFetch, './', manifest, s);
      expect(fw).toMatchObject({ kind: 'download', board, variant, fileName: `TonUINO-TNG_${board}-${variant}.hex` });
      if (fw.kind !== 'download') throw new Error('download expected');
      expect(fw.baukasten).toMatchObject({ id: `${board}-${variant}`, summary: '', stand: standTitle(CHECKED_TNG) });
      expect(fw.unchecked).toBeUndefined();
      // The image carries the version line of the checked state.
      expect(isChecked(firmwareVersion(fw.image))).toBe(true);
      expect(canEnter(chooseFirmware(s, fw), 'flash')).toBe(true);
      expect(successFacts({ ok: true, baud: 57600, signature: [0x1e, 0x95, 0x0f], bootloaderVersion: '1.16', bytesWritten: fw.fileBytes, verified: true, durationMs: 20_000 }, getBoard(board), fw).map((f) => f.label)).not.toContain('Extras');
    }
  });

  it('refuses what was not built', async () => {
    const s = chooseShutdown(at('classic'), 'switch');
    await expect(loadBaukasten(fileFetch, './', manifest, at('aioplus', '5'))).rejects.toThrow(RangeError);
    const big = chooseExtras(s, { light: 'ringVolume', knob: 'encoderSkip', headphones: true, speakerOff: true, preset: 'weiter' });
    expect(manifest.notFitting).toContain(wantedBuildId(big));
    await expect(loadBaukasten(fileFetch, './', manifest, big)).rejects.toThrow(/too-big/);
  });
});

describe('firmware sources', () => {
  it('downloads and reads the ready-made build', async () => {
    const hex = toIntelHex(firmwareBytes(3000));
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      return new Response(hex);
    };
    const choice = await loadReadyMade(fetchFn, classic, '5');
    expect(urls).toEqual(['https://tonuino.github.io/TonUINO-TNG/TonUINO_Classic_5/firmware.hex']);
    expect(choice).toMatchObject({ kind: 'download', board: 'classic', variant: '5', fileName: 'TonUINO_Classic_5.hex', fileBytes: hex.length });
    expect(choice.image.data).toEqual(firmwareBytes(3000));
    expect(firmwareLabel(choice)).toBe('TonUINO_Classic_5.hex · 3 KB');
  });

  it('marks a download that is not the checked state, and lets it go on only after a yes', async () => {
    const serve = (text?: string): FetchFn => async () => new Response(toIntelHex(text ? textBytes(text) : firmwareBytes(3000)));
    const newer = await loadReadyMade(serve('V3.3.4 26.10.26'), aioplus, '5');
    expect(newer.kind === 'download' && newer.unchecked).toEqual({ version: '3.3.4', date: '2026-10-26' });
    expect(await loadReadyMade(serve(CHECKED_TNG.versionString), aioplus, '5')).not.toHaveProperty('unchecked');
    const blank = await loadReadyMade(serve(), aioplus, '5');
    expect(blank.kind === 'download' && blank.unchecked).toEqual({});

    let s = chooseFirmware(chooseVariant(chooseBoard(initialWizard(), 'aioplus'), '5'), newer);
    expect(canEnter(s, 'flash')).toBe(false);
    s = acceptUnchecked(s, true);
    expect(canEnter(s, 'flash')).toBe(true);
    expect(canEnter(acceptUnchecked(s, false), 'flash')).toBe(false);
    // The yes is for that one download only.
    expect(canEnter(chooseFirmware(s, blank), 'flash')).toBe(false);

    const t = uncheckedText({ version: '3.3.4', date: '2026-10-26' });
    expect(t.text).toContain('TonUINO TNG 3.3.4 vom 26.10.2026');
    expect(t.text).toContain(standTitle(CHECKED_TNG));
    expect(t.text).toContain('Einstellungen in neuer Form');
    expect(uncheckedText({}).text).toContain('ohne Versionsangabe');
    expect(uncheckedText({}).text).not.toContain('neuer Form');
  });

  it('explains a broken download and a missing build', async () => {
    const broken: FetchFn = async () => new Response(':10000000FFFF\n');
    const e = await loadReadyMade(broken, classic, '3').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FirmwareDownloadError);
    expect((e as FirmwareDownloadError).problem.explanation).toMatch(/^Die heruntergeladene Datei ist beschädigt\. Zeile 1:/);
    expect((e as FirmwareDownloadError).problem.steps[1]).toContain('https://tonuino.github.io/TonUINO-TNG/TonUINO_Classic_3/firmware.hex');

    const missing: FetchFn = async () => new Response('nope', { status: 404 });
    const m = await loadReadyMade(missing, classic, '3').catch((x: unknown) => x);
    expect((m as FirmwareDownloadError).problem).toMatchObject({ code: 'download-failed', explanation: 'Diese Firmware liegt nicht (mehr) auf dem Server.' });
  });

  it('reads a .hex file of your own', async () => {
    const result = await readOwnFirmware(source('Meine Firmware.hex', toIntelHex(firmwareBytes(2000))), classic);
    expect(result).toMatchObject({ firmware: { kind: 'file', board: 'classic', fileName: 'Meine Firmware.hex' } });
  });

  it('says clearly what is wrong with a file of your own', async () => {
    const lines = toIntelHex(firmwareBytes(64)).split('\n');
    // Line 2 is the first data record (line 1 sets the upper address).
    const checksum = parseInt(lines[1].slice(-2), 16);
    lines[1] = lines[1].slice(0, -2) + (checksum ^ 0xff).toString(16).padStart(2, '0').toUpperCase();
    const bad = await readOwnFirmware(source('kaputt.hex', lines.join('\n')), classic);
    expect(bad).toMatchObject({ problem: { code: 'bad-image', title: 'Die Firmware-Datei passt nicht' } });
    if (!('problem' in bad)) throw new Error('expected a problem');
    expect(bad.problem.explanation).toBe('Mit „kaputt.hex“ stimmt etwas nicht. Zeile 2: Die Prüfsumme stimmt nicht. Die Datei ist beschädigt. Lade sie bitte neu herunter.');

    const bin = await readOwnFirmware(source('firmware.bin', firmwareBytes(500)), classic);
    expect('problem' in bin && bin.problem.explanation).toBe('„firmware.bin“ ist eine .bin-Datei. Für „Classic“ brauchst du die Firmware als .hex-Datei.');

    // Named .hex, but no HEX inside: no „Endung .hex“ for a file that has it (Prüfrunde 1, bastler 4).
    const garbage = await readOwnFirmware(source('kaputt.hex', 'PK\u0003\u0004 kein HEX'), classic);
    expect('problem' in garbage && garbage.problem.explanation).toBe('„kaputt.hex“ ist keine gültige Firmware im HEX-Format. Ist die Datei vollständig heruntergeladen?');

    const page = await readOwnFirmware(source('firmware.hex', '<!DOCTYPE html><html>'), classic);
    expect('problem' in page && page.problem.explanation).toContain('Das ist eine Webseite und keine Firmware-Datei');

    const huge: ByteSource = { name: 'film.hex', size: 50 * 1024 * 1024, read: async () => new Uint8Array(0) };
    expect(await readOwnFirmware(huge, classic)).toMatchObject({ problem: { code: 'bad-image' } });

    const unreadable: ByteSource = {
      name: 'weg.hex',
      size: 10,
      read: async () => {
        throw new Error('NotFoundError');
      },
    };
    expect(await readOwnFirmware(unreadable, classic)).toMatchObject({ problem: { title: 'Die Datei ließ sich nicht lesen' } });

    const tooBig = await readOwnFirmware(source('gross.hex', toIntelHex(firmwareBytes(32300))), classic);
    expect(tooBig).toMatchObject({ problem: { code: 'too-large', title: 'Die Firmware ist zu groß für diese Platine' } });
  });

  it('measures the room a firmware takes behind the AiO+ bootloader', () => {
    const fits = { data: new Uint8Array(48640), startAddress: 0x200, byteCount: 48640 };
    expect(sizeProblem(fits, aioplus)).toBeNull();
    expect(sizeProblem({ ...fits, data: new Uint8Array(48641) }, aioplus)?.code).toBe('too-large');
    expect(sizeProblem(fits, getBoard('esp32wroom'))).toBeNull();
  });
});

describe('after flashing', () => {
  const result: FlashSuccess = { ok: true, baud: 115200, signature: [0x1e, 0x95, 0x0f], bootloaderVersion: '8.0', bytesWritten: 22528, verified: true, durationMs: 11_600 };

  it('lists plain facts and keeps the technical ones apart', () => {
    // 22000 bytes of firmware; the flasher wrote whole pages (22016 bytes).
    const firmware: FirmwareChoice = { ...download('classic', '5'), image: { data: new Uint8Array(22000), startAddress: 0, byteCount: 22000 } };
    expect(successFacts({ ...result, bytesWritten: 22016 }, classic, firmware)).toEqual([
      { label: 'Platine', value: 'TonUINO Classic (Arduino Nano)' },
      { label: 'Tasten', value: '5 Tasten' },
      { label: 'Firmware', value: 'TonUINO TNG, TonUINO_Classic_5.hex' },
      { label: 'Aufgespielt', value: '21 KB' },
      { label: 'Geprüft', value: 'Ja, alles stimmt' },
      { label: 'Dauer', value: '12 Sek.' },
    ]);
    // The same size as the firmware step showed.
    expect(firmwareLabel(firmware)).toBe('TonUINO_Classic_5.hex · 21 KB');
    const own: FirmwareChoice = { kind: 'file', board: 'classic', fileName: 'mine.hex', fileBytes: 10, image: parseIntelHex(toIntelHex(firmwareBytes(8))) };
    expect(successFacts({ ...result, verified: false }, classic, own).map((f) => f.value)).toContain('eigene Datei, mine.hex');
    expect(successTechnical(result)).toBe('115200 Baud · Bootloader 8.0 · Signatur 1e 95 0f · 22528 Bytes geschrieben');
  });

  it('suggests what to do next', () => {
    expect(nextSteps(classic, download(), 'tng').map((s) => s.id)).toEqual(['power', 'sounds', 'logbook', 'einstellen', 'reset']);
    expect(nextSteps(aioplus, download(), 'tng').map((s) => s.id).slice(0, 2)).toEqual(['release', 'power']);
    expect(nextSteps(classic, download(), 'classic21').map((s) => s.id)).toEqual(['power', 'sounds', 'profile', 'logbook', 'einstellen', 'reset']);
    const own: FirmwareChoice = { kind: 'file', board: 'classic', fileName: 'mine.hex', fileBytes: 10, image: parseIntelHex(toIntelHex(firmwareBytes(8))) };
    const steps = nextSteps(classic, own, 'classic21');
    expect(steps.map((s) => s.id)).toEqual(['power', 'sounds', 'logbook', 'einstellen', 'reset']);
    expect(steps[1].text).toMatch(/^Passen die Ansagen/);
    // Resetting is for a box that misbehaves, and keeps cards and SD card.
    const reset = steps.at(-1)!;
    expect(reset.title).toMatch(/^Nur wenn die Box spinnt/);
    expect(reset.text).toContain('„alle Einstellungen löschen“');
    expect(reset.text).toContain('Karten und SD-Karte bleiben');
    // It also forgets where audiobooks stopped; parents should know before they try it.
    expect(reset.text).toContain('Hörbücher fangen wieder vorn an');
    // Afterwards everything is set anew in the Werkstatt tool.
    expect(RESET_GUIDE).toContain('„Box einstellen“');
    expect(reset.link?.href).toBe('#/werkstatt/einstellen');
  });

  it('puts what was chosen under „Verhalten“ for the box first, right after the upload', () => {
    const steps = nextSteps(classic, download(), 'tng', { einstellen: ['Karte wegnehmen = Pause', 'Lautstärke 20 / 1 / 8'] });
    expect(steps.map((s) => s.id)).toEqual(['power', 'sounds', 'einstellen', 'logbook', 'reset']);
    const step = steps.find((s) => s.id === 'einstellen')!;
    expect(step.title).toBe('Jetzt an der Box einstellen');
    expect(step.text).toContain('Karte wegnehmen = Pause, Lautstärke 20 / 1 / 8');
    expect(step.link).toEqual({ label: 'Jetzt an der Box einstellen', href: '#/werkstatt/einstellen' });
    // Nothing chosen: the general hint stays.
    expect(nextSteps(classic, download(), 'tng', { einstellen: [] }).find((s) => s.id === 'einstellen')!.title).toBe('Box einstellen');
  });

  it('points to the settings tool after a download, because the timer is off from the factory', () => {
    for (const board of [classic, aioplus]) {
      const step = nextSteps(board, download(), 'tng').find((s) => s.id === 'einstellen');
      expect(step).toBeDefined();
      expect(`${step!.title}: ${step!.text}`).toMatch(/^Box einstellen: Bei einer neuen Box ist der Ausschalt-Timer aus\./);
      // An update keeps the settings (keepsText): the step asks to check, it does not claim the timer is off now.
      expect(step!.text).toContain('Ob er bei deiner Box an ist, siehst du im Box-Logbuch.');
      expect(step!.text).not.toMatch(/ist ab Werk aus\. Stelle ihn ein/);
      expect(step!.link).toEqual(SETTINGS_LINK);
    }
    expect(SETTINGS_LINK.href).toBe('#/werkstatt/einstellen');
  });

  it('asks to power the box off and on once, and says what Play/Pause does now', () => {
    const power = (board = classic, firmware: FirmwareChoice = download(), shutdown?: ShutdownKind, backup = false) =>
      nextSteps(board, firmware, 'tng', { shutdown, backup }).find((s) => s.id === 'power')!;
    // Right after letting go of Play/Pause, before anything else.
    expect(nextSteps(aioplus, { ...download(), board: 'aioplus' }, 'tng').map((s) => s.id).slice(0, 2)).toEqual(['release', 'power']);
    expect(nextSteps(classic, download(), 'tng', { shutdown: 'pololu' })[0].id).toBe('power');

    for (const shutdown of [undefined, 'switch', 'pololu', 'traeger', 'unknown'] as const) {
      expect(power(classic, download(), shutdown).text).toMatch(/^Schalte die Box einmal ganz aus und wieder ein/);
      expect(power(classic, download(), shutdown).text).toContain('MP3-Player');
    }
    expect(power().note).toBeUndefined();

    for (const shutdown of ['pololu', 'traeger'] as const) {
      const note = power(classic, download(), shutdown).note!;
      expect(note).toContain('ohne USB-Kabel');
      expect(note).toContain('Ausschalt-Timer');
    }
    // Without a shutdown board the long press only puts the box to sleep; that comes first.
    const sleeps = power(classic, download(), 'switch').note!;
    expect(sleeps).toMatch(/^Ein langer Druck auf Play\/Pause in der Pause legt deine Box schlafen\./);
    expect(sleeps).not.toContain('schaltet ein langer Druck');
    expect(sleeps).toContain('Ausschalt-Timer');

    // „Weiß ich nicht“: what to do when the box goes straight off without the cable.
    const unsureSaved = power(classic, download(), 'unknown', true).note!;
    expect(unsureSaved).toMatch(/^Geht die Box ohne USB-Kabel gleich nach dem Einschalten wieder aus, passt die Abschaltung nicht\./);
    expect(unsureSaved).toContain('„Alte Firmware wieder aufspielen“');
    expect(unsureSaved).toContain('Ohne Abschalt-Platine legt sie sich dann nur schlafen');
    const unsureNoBackup = power(classic, download(), 'unknown', false).note!;
    expect(unsureNoBackup).not.toContain('Alte Firmware wieder aufspielen');
    // The Classic has a build for the carrier board in the app.
    expect(unsureNoBackup).toContain('„Mit CubieKid- oder Trägerplatine“');
    expect(unsureNoBackup).not.toContain('Eigene Datei');

    // A file of your own may be any firmware: only the power cycle, no words about TNG's Play/Pause.
    const own: FirmwareChoice = { kind: 'file', board: 'classic', fileName: 'mine.hex', fileBytes: 10, image: parseIntelHex(toIntelHex(firmwareBytes(8))) };
    expect(power(classic, own, 'switch').text).toMatch(/^Schalte die Box einmal ganz aus/);
    expect(power(classic, own, 'switch').note).toBeUndefined();
  });

  it('suggests only the log after the old firmware went back', () => {
    const old = backupChoice({ data: firmwareBytes(100), startAddress: 0x200 }, 'aioplus', 'alt.hex');
    expect(nextSteps(aioplus, old, 'tng').map((s) => s.id)).toEqual(['release', 'logbook']);
    expect(nextSteps(classic, { ...old, board: 'classic' }, 'classic21').map((s) => s.id)).toEqual(['logbook']);
  });

  it('names the version of the firmware that went on the box', () => {
    const tng = { ...download('classic', '5'), image: hexWithText('V3.3.3 17.09.26') };
    expect(successFacts(result, classic, tng).find((f) => f.label === 'Firmware')?.value).toBe('TonUINO TNG 3.3.3 vom 17.09.2026, TonUINO_Classic_5.hex');
    const old = backupChoice({ data: textBytes('TonUINO Version 2.1'), startAddress: 0 }, 'classic', 'alt.hex');
    expect(successFacts(result, classic, old).find((f) => f.label === 'Firmware')?.value).toBe('die alte Firmware aus der Sicherung (TonUINO 2.1)');
  });
});

describe('versions', () => {
  it('reads the version a firmware carries', () => {
    expect(firmwareVersion(hexWithText('V3.3.3 17.09.26'))).toEqual({ family: 'tng', version: '3.3.3', date: '2026-09-17' });
    // TNG main of 26.10.2026 (the README calls it 3.4.0, the firmware says 3.3.4).
    expect(firmwareVersion(hexWithText('V3.3.4 26.10.26'))).toEqual({ family: 'tng', version: '3.3.4', date: '2026-10-26' });
    expect(firmwareVersion(hexWithText('V3.2.1 3.1.2025'))).toEqual({ family: 'tng', version: '3.2.1', date: '2025-01-03' });
    expect(firmwareVersion(hexWithText('TonUINO Version 2.1'))).toEqual({ family: 'classic21', version: '2.1' });
    expect(firmwareVersion(hexWithText('TonUINO Version 3.x - refactored by Boerge1'))).toEqual({ family: 'tng' });
    expect(firmwareVersion({ data: firmwareBytes(600, 5) })).toBeUndefined();
  });

  it('compares the new version with the one on the box', () => {
    const v = (version: string, date?: string) => ({ family: 'tng' as const, version, date });
    expect(versionFacts(v('3.3.3', '2026-09-17'), v('3.3.3', '2026-09-17')).note).toContain('schon auf der Box');
    expect(versionFacts(v('3.3.2'), v('3.3.3')).note).toBe('Diese Version ist älter als die auf der Box.');
    expect(versionFacts(v('3.3.3', '2026-01-28'), v('3.3.3', '2026-09-17')).note).toContain('älter');
    expect(versionFacts(v('3.3.3'), { family: 'classic21', version: '2.1' }).note).toBeUndefined();
    expect(versionFacts({ family: 'classic21', version: '2.1' }, v('3.3.3')).note).toContain('älter');
    // Back from the test build of 16.10.2026 to the release: older, but the way out of its hang.
    const back = versionFacts(v('3.3.3', '2026-09-17'), v('3.3.3', '2026-10-16'));
    expect(back.note).toBe('Auf der Box läuft eine Testversion. Diese hier ist älter, aber erprobt.');
    expect(back.facts[1].value).toBe('TonUINO TNG 3.3.3 vom 16.10.2026 (Testversion)');

    const both = versionFacts(v('3.4.0', '2026-10-01'), v('3.3.3', '2026-09-17'));
    expect(both).toEqual({
      facts: [
        { label: 'Diese Firmware', value: 'TonUINO TNG 3.4.0 vom 01.10.2026' },
        { label: 'Jetzt auf der Box', value: 'TonUINO TNG 3.3.3 vom 17.09.2026' },
      ],
    });
    expect(versionFacts(undefined, undefined)).toEqual({ facts: [] });
  });

  it('takes the version on the box from its start', () => {
    expect(boxVersion(boxInfo({ firmware: 'tng', version: '3.3.3', versionDate: '2026-09-17' }))).toEqual({ family: 'tng', version: '3.3.3', date: '2026-09-17' });
    expect(boxVersion(boxInfo({ firmware: 'classic21' }))).toEqual({ family: 'classic21', version: '2.1' });
    expect(boxVersion(boxInfo({}))).toBeUndefined();
    expect(boxVersion(undefined)).toBeUndefined();
  });

  it('says that cards and settings stay', () => {
    expect(keepsText()).toContain('Deine Karten funktionieren weiter');
    expect(keepsText()).toContain('Einstellungen aus dem Admin-Menü bleiben erhalten');
    expect(keepsText('tng')).toBe(keepsText());
    expect(keepsText('classic21')).toContain('Kommt die Box von TonUINO 2.1');
  });
});

describe('what the box tells about itself', () => {
  it('takes the board, and the buttons when they decide the choice', () => {
    const aio = guessFromInfo(boxInfo({ board: 'aioplus', buttons: '5', firmware: 'tng', version: '3.3.3', versionDate: '2026-09-17' }));
    // "5" can also be "5 Tasten mit allen Extras" on the AiO+.
    expect(aio).toEqual({ board: 'aioplus', buttons: '5', version: { family: 'tng', version: '3.3.3', date: '2026-09-17' } });
    expect(guessText(aio)).toBe('AiO+ mit 5 Tasten, TonUINO TNG 3.3.3 vom 17.09.2026');
    expect(guessFromInfo(boxInfo({ board: 'aioplus', buttons: '3' }))).toEqual({ board: 'aioplus', buttons: '3', variant: '3' });
    // The Classic has no build with extras, so its "5" is plain 5 buttons.
    expect(guessFromInfo(boxInfo({ board: 'classic', buttons: '5' }))).toEqual({ board: 'classic', buttons: '5', variant: '5' });
    expect(guessFromInfo(boxInfo({ firmware: 'classic21' }))).toEqual({ version: { family: 'classic21', version: '2.1' } });
    expect(guessText(guessFromInfo(boxInfo({ firmware: 'classic21' })))).toBe('TonUINO 2.1');
  });

  it('fills in the wizard and leaves open what the box cannot tell', () => {
    const s = applyGuess(initialWizard(), { board: 'aioplus', buttons: '5' });
    expect(s).toMatchObject({ step: 'board', board: 'aioplus', variant: undefined });
    expect(applyGuess(initialWizard(), { board: 'classic', buttons: '3x3', variant: '3x3' })).toMatchObject({ board: 'classic', variant: '3x3' });
    // Without a board the wizard stays as it is.
    const chosen = chooseVariant(chooseBoard(initialWizard(), 'aio'), '3');
    expect(applyGuess(chosen, { buttons: '5' })).toBe(chosen);
    // Another board drops a download for the old one.
    const withFirmware = chooseFirmware(chosen, { ...download('aio', '3') });
    expect(applyGuess(withFirmware, { board: 'aioplus', variant: '3' })).toMatchObject({ board: 'aioplus', variant: '3', firmware: undefined });
  });

  it('helps to tell 5 buttons from 5 buttons with extras', () => {
    expect(variantAdvice(classic)).toBeUndefined();
    expect(variantAdvice(aioplus)).toMatch(/^Hat deine Box einen LED-Ring/);
    expect(variantAdvice(aioplus)).toContain('„5 Tasten mit allen Extras“');
    expect(variantAdvice(aioplus, '5')).toMatch(/^Die Box meldet 5 Tasten, aber nicht, ob die Extras dabei sind\./);
  });
});

describe('the old firmware', () => {
  it('names the saved file after the board and the time', () => {
    const at = new Date(2026, 9, 5, 15, 40).getTime();
    expect(backupFileName(aioplus, at)).toBe('TonUINO-Sicherung-AiO+-2026-10-05-1540.hex');
    expect(backupFileName(getBoard('every'), at)).toBe('TonUINO-Sicherung-Nano-Every-2026-10-05-1540.hex');
  });

  it('becomes a firmware choice that can go back on the box', () => {
    const data = firmwareBytes(700);
    const choice = backupChoice({ data, startAddress: 0x200 }, 'aioplus', 'alt.hex');
    expect(choice).toEqual({ kind: 'backup', board: 'aioplus', fileName: 'alt.hex', fileBytes: 700, image: { data, startAddress: 0x200, byteCount: 700 } });
    // It belongs to its board, like a file of your own, whatever buttons are chosen.
    const s = chooseFirmware(chooseVariant(chooseBoard(initialWizard(), 'aioplus'), '5'), choice);
    expect(chooseVariant(s, '3').firmware).toBe(choice);
    expect(chooseBoard(s, 'classic').firmware).toBeUndefined();
  });
});

describe('before flashing', () => {
  it('leaves out the Play/Pause hint (it has its own block) and driver hints on Linux', () => {
    const aio = getBoard('aio');
    expect(flashHints(aio, 'windows')).toEqual([]);
    expect(flashHints(aioplus, 'windows')).toHaveLength(1);
    expect(flashHints(aioplus, 'windows')[0]).toContain('Treiber');
    expect(flashHints(aioplus, 'linux')).toEqual([]);
    expect(flashHints(classic, 'linux')).toHaveLength(1);
    expect(flashHints(classic, 'macos')).toHaveLength(2);
    expect(flashHints(getBoard('esp32nano'), 'windows')).toEqual([]);
  });

  it('names the CH340 driver only when the port has a CH340 or is not known', () => {
    const ftdi = { id: 'COM4', label: 'USB Serial Port (COM4)', usbVendorId: 0x0403, usbProductId: 0x6001 };
    const cp2102 = { id: 'COM5', label: 'CP2102 (COM5)', usbVendorId: 0x10c4, usbProductId: 0xea60 };
    const ch340 = { id: 'COM3', label: 'USB-SERIAL CH340 (COM3)', usbVendorId: 0x1a86, usbProductId: 0x7523 };
    for (const port of [ftdi, cp2102]) {
      expect(flashHints(classic, 'windows', port).join(' ')).not.toContain('CH340');
      expect(flashHints(aioplus, 'macos', port)).toEqual([]);
    }
    expect(flashHints(classic, 'windows', ftdi)).toHaveLength(1);
    expect(flashHints(classic, 'windows', ch340).join(' ')).toContain('CH340');
    expect(flashHints(classic, 'windows', { id: 'COM9', label: 'COM9' }).join(' ')).toContain('CH340');
  });
});

describe('after a failed upload', () => {
  const problem = (code: FlashProblem['code'], extra: Partial<FlashProblem> = {}): FlashProblem => ({ code, title: 't', explanation: 'e', steps: [], ...extra });

  it('reminds of Play/Pause only before talking to the box again', () => {
    for (const code of ['no-answer', 'connection-lost', 'backup-failed', 'verify-failed', 'port-missing', 'aborted'] as const) {
      expect(holdAgainFits(aioplus, problem(code)), code).toBe(true);
    }
    // A firmware that does not fit, or another board: back to an earlier step first.
    for (const code of ['too-large', 'bad-image', 'wrong-board'] as const) {
      expect(holdAgainFits(aioplus, problem(code)), code).toBe(false);
    }
    expect(holdAgainFits(aioplus, problem('wrong-board', { action: { kind: 'flash-anyway', label: 'Trotzdem aufspielen' } }))).toBe(true);
    // Boards without the key never get it.
    expect(holdAgainFits(classic, problem('no-answer'))).toBe(false);
  });

  it('offers to put the old firmware back only when writing may have started', () => {
    for (const code of ['connection-lost', 'verify-failed', 'aborted', 'no-answer', 'unknown'] as const) {
      expect(boxMayBeChanged(problem(code)), code).toBe(true);
    }
    // Stopped before the first page: the old firmware is still on the box.
    for (const code of ['extras-lost', 'too-large', 'wrong-board', 'bad-image'] as const) {
      expect(boxMayBeChanged(problem(code)), code).toBe(false);
    }
  });
});

describe('progress', () => {
  const status = (step: FlashStatus['step'], progress: number): FlashStatus => ({ step, progress, baud: 57600, message: '' });

  it('groups syncing with connecting', () => {
    expect(['connect', 'sync', 'write', 'verify', 'done'].map((s) => phaseIndex(s as FlashStatus['step']))).toEqual([0, 0, 1, 2, 3]);
    expect(flashPhases(false).map((p) => p.label)).toEqual(['Verbinden', 'Schreiben', 'Prüfen']);
  });

  it('shows saving the old firmware as its own part', () => {
    const steps = ['connect', 'sync', 'backup', 'write', 'verify', 'done'] as FlashStatus['step'][];
    expect(steps.map((s) => phaseIndex(s, true))).toEqual([0, 0, 1, 2, 3, 4]);
    expect(flashPhases(true).map((p) => p.label)).toEqual(['Verbinden', 'Sichern', 'Schreiben', 'Prüfen']);
    // "done" is past the last part either way.
    expect(phaseIndex('done', true)).toBe(flashPhases(true).length);
    expect(phaseIndex('done')).toBe(flashPhases(false).length);
  });

  it('shows 100 percent only when done', () => {
    expect(percent(status('write', 0.424))).toBe(42);
    expect(percent(status('verify', 0.999))).toBe(99);
    expect(percent(status('verify', 1))).toBe(99);
    expect(percent(status('done', 1))).toBe(100);
    expect(percent(status('connect', -1))).toBe(0);
  });
});

describe('ESP32 guide', () => {
  const nano = getBoard('esp32nano') as Esp32Board;
  const wroom = getBoard('esp32wroom') as Esp32Board;

  it('names the file as it was saved', () => {
    const guide = esp32Guide(wroom, 'TonUINO_Esp32_W_5.bin');
    expect(guide.steps[0].text).toContain('„TonUINO_Esp32_W_5.bin“');
    expect(guide.steps.at(-1)!.text).toContain('„TonUINO_Esp32_W_5.bin“');
    expect(guide.steps.some((s) => s.text.includes('firmware.bin'))).toBe(false);
  });

  it('links the update page when the box address is known', () => {
    const known = esp32Guide(wroom, 'x.bin', 'http://tonuino.local');
    expect(known.steps[1].link).toEqual({ label: 'Update-Seite öffnen', url: 'http://tonuino.local/upgrade' });
    expect(known.steps[2].text).toContain('http://192.168.4.1/upgrade');
    const unknown = esp32Guide(wroom, 'x.bin', null);
    expect(unknown.steps.some((s) => s.link)).toBe(false);
    expect(unknown.steps[2].text).toContain('http://192.168.4.1/upgrade');
    expect(unknown.steps[3].text).toContain('„admin“');
  });

  it('says why the browser calls the box page „Nicht sicher“', () => {
    for (const b of [nano, wroom]) {
      expect(esp32Guide(b, 'x.bin').notes.map((n) => n.text).join(' ')).toContain('„Nicht sicher“, weil die Box kein HTTPS kann. Das ist hier in Ordnung.');
    }
  });

  it('speaks of the file from whoever built the box when the ready-made build does not fit', () => {
    const own = esp32Guide(wroom, null);
    expect(own.steps[0].text).toBe('Hole dir die passende Firmware-Datei von dem, der die Box gebaut hat.');
    expect(own.steps.at(-1)!.text).toMatch(/^Wähle die Datei aus, die du bekommen hast/);
    expect(own.steps.some((s) => s.text.includes('.bin'))).toBe(false);
    const dfu = esp32Guide(nano, null).notes.at(-1)!;
    expect(dfu.command).toBe('dfu-util --device 2341:0070 -D deine-datei.bin');
    expect(dfu.text).toContain('Setze statt „deine-datei.bin“ den Namen deiner Datei ein');
  });

  it('offers USB (DFU) only for the Nano ESP32', () => {
    expect(esp32Guide(nano, 'TonUINO_Esp32_3.bin').notes.at(-1)!.command).toBe('dfu-util --device 2341:0070 -D TonUINO_Esp32_3.bin');
    expect(esp32Guide(wroom, 'x.bin').notes.some((n) => n.command)).toBe(false);
  });
});
