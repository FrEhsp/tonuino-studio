import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKED_TNG } from '../../src/core/firmware/tngstands';
import { describe, expect, it } from 'vitest';
import { CHIP_DEFINES, OTHER_CHIPS, chipFromDefines } from '../../src/core/firmware/mp3chip';
import {
  ALARM_TEXT,
  D6_WARNING,
  alarmBlocker,
  allowedChoices,
  chipBlocker,
  buildId,
  choiceOf,
  choiceStatus,
  choiceSummary,
  findBuild,
  gunzip,
  identifyBuild,
  headphonesBlocker,
  isPlain,
  knobBlocker,
  lightBlocker,
  loadBuildImage,
  loadManifest,
  normalizeChoice,
  sourceText,
  speakerOffBlocker,
  traegerBlocker,
  offerWriteCardPreview,
  writeCardBlocker,
  WRITE_CARD_TEXT,
  type BaukastenBoard,
  type BaukastenButtons,
  type BaukastenManifest,
} from '../../src/core/firmware/baukasten';

const PUBLIC = join(__dirname, '../../public/');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'firmware/baukasten/manifest.json'), 'utf8')) as BaukastenManifest;

/** fetch over the files in public/, like the app does next to its index.html. */
const fileFetch = async (url: string) => {
  const path = join(PUBLIC, url.replace(/^\.\//, ''));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

const BOARDS: [BaukastenBoard, BaukastenButtons][] = [
  ['classic', '3'],
  ['classic', '5'],
  ['classic', '3x3'],
  ['aio', '3'],
  ['aio', '5'],
  ['aio', '3x3'],
];

describe('Baukasten rules (pins of TNG constants.hpp)', () => {
  it('a knob needs A3/A4, so only with 3 buttons', () => {
    expect(knobBlocker('classic', '3')).toBeUndefined();
    expect(knobBlocker('aio', '3')).toBeUndefined();
    expect(knobBlocker('classic', '5')).toMatch(/A3 und A4/);
    expect(knobBlocker('aio', '5')).toMatch(/A3 und A4/);
    expect(knobBlocker('classic', '3x3')).toMatch(/Tastenfeld hängt schon an A3/);
    expect(knobBlocker('aio', '3x3')).toMatch(/A3 und A4/);
  });

  it('LED buttons and speaker switch-off share D6', () => {
    expect(lightBlocker('classic', 'ledButtons', { speakerOff: true })).toMatch(/D6/);
    expect(speakerOffBlocker('classic', { light: 'ledButtons' })).toMatch(/D6/);
    expect(lightBlocker('classic', 'ring', { speakerOff: true })).toBeUndefined();
    expect(speakerOffBlocker('classic', { light: 'ring' })).toBeUndefined();
  });

  it('the AiO has its own amplifier switch, shutdown and USB pin', () => {
    expect(lightBlocker('aio', 'ring', {})).toMatch(/Speicher/);
    expect(lightBlocker('aio', 'ledButtons', {})).toMatch(/A5/);
    expect(speakerOffBlocker('aio', {})).toBeDefined();
    expect(headphonesBlocker('aio')).toMatch(/D8/);
    expect(traegerBlocker('aio')).toBeDefined();
    expect(headphonesBlocker('classic')).toBeUndefined();
    expect(traegerBlocker('classic')).toBeUndefined();
  });

  it('normalizeChoice drops what the board cannot have', () => {
    expect(normalizeChoice('classic', '5', { knob: 'encoder', light: 'ring' })).toEqual({ light: 'ring' });
    expect(normalizeChoice('aio', '3', { knob: 'poti', light: 'ring', headphones: true, speakerOff: true, traeger: true, preset: 'weiter' })).toEqual({ knob: 'poti', preset: 'weiter' });
    // The speaker switch-off was there first: the LED buttons go.
    expect(normalizeChoice('classic', '3', { speakerOff: true, light: 'ledButtons' })).toEqual({ speakerOff: true });
    expect(normalizeChoice('classic', '3', { preset: 'standard' })).toEqual({});
  });

  it('another MP3 chip only for the common builds (knob, carrier board, Weitermachen)', () => {
    expect(chipBlocker({ knob: 'encoder', traeger: true, preset: 'weiter' })).toBeUndefined();
    expect(chipBlocker({ light: 'ring' })).toMatch(/ohne Licht/);
    expect(chipBlocker({ speakerOff: true })).toBeDefined();
    expect(chipBlocker({ headphones: true })).toBeDefined();
    expect(lightBlocker('classic', 'ring', { chip: 'mh2024k24ss' })).toMatch(/MP3-Player-Chip/);
    expect(speakerOffBlocker('classic', { chip: 'gd3200b' })).toMatch(/MP3-Player-Chip/);
    expect(headphonesBlocker('classic', { chip: 'lisp3' })).toMatch(/MP3-Player-Chip/);
    expect(headphonesBlocker('classic', { chip: 'standard' })).toBeUndefined();
    // Ticked first wins: the ring stays, the chip goes.
    expect(normalizeChoice('classic', '3', { light: 'ring', chip: 'mh2024k24ss' })).toEqual({ light: 'ring' });
    expect(normalizeChoice('aio', '5', { chip: 'gd3200b', preset: 'weiter' })).toEqual({ preset: 'weiter', chip: 'gd3200b' });
    expect(normalizeChoice('classic', '3', { chip: 'standard' })).toEqual({});
    expect(isPlain({ chip: 'lisp3' })).toBe(false);
    expect(isPlain({ chip: 'standard' })).toBe(true);
    expect(buildId('classic', '3', { knob: 'poti', traeger: true, preset: 'weiter', chip: 'mh2024k24ss' })).toBe('classic-3-poti-traeger-weiter-mh2024k24ss');
    expect(choiceSummary({ knob: 'encoder', chip: 'mh2024k24ss' })).toBe('Drehregler, Anderer MP3-Player-Chip (MH2024K-24SS)');
  });

  it('the alarm start (SPECIAL_START_SHORTCUT, A6) only on the Classic, like the chip only for the common builds', () => {
    expect(alarmBlocker('classic', { knob: 'poti', traeger: true, preset: 'weiter' })).toBeUndefined();
    expect(alarmBlocker('aio', {})).toBeDefined();
    expect(alarmBlocker('classic', { light: 'ring' })).toMatch(/ohne Licht/);
    expect(alarmBlocker('classic', { headphones: true })).toBeDefined();
    expect(alarmBlocker('classic', { chip: 'gd3200b' })).toMatch(/MP3-Player-Chip/);
    expect(chipBlocker({ alarm: true })).toMatch(/Wecker-Start/);
    expect(lightBlocker('classic', 'ring', { alarm: true })).toMatch(/Wecker-Start/);
    expect(speakerOffBlocker('classic', { alarm: true })).toMatch(/Wecker-Start/);
    expect(headphonesBlocker('classic', { alarm: true })).toMatch(/Wecker-Start/);
    expect(normalizeChoice('aio', '3', { alarm: true })).toEqual({});
    expect(normalizeChoice('classic', '3', { light: 'ring', alarm: true })).toEqual({ light: 'ring' });
    expect(normalizeChoice('classic', '3', { chip: 'lisp3', alarm: true })).toEqual({ chip: 'lisp3' });
    expect(buildId('classic', '3', { knob: 'encoder', preset: 'weiter', alarm: true })).toBe('classic-3-encoder-weiter-alarm');
    expect(isPlain({ alarm: true })).toBe(false);
    expect(choiceSummary({ knob: 'encoder', alarm: true })).toBe('Drehregler, Wecker-Start');
    expect(ALARM_TEXT.parts).toMatch(/A6/);
  });

  it('the write-card preview only for the common builds, not with another chip or the alarm start', () => {
    expect(writeCardBlocker({ knob: 'encoder', traeger: true, preset: 'weiter' })).toBeUndefined();
    expect(writeCardBlocker({ light: 'ring' })).toMatch(/ohne Licht/);
    expect(writeCardBlocker({ chip: 'lisp3' })).toMatch(/MP3-Player-Chip/);
    expect(writeCardBlocker({ alarm: true })).toMatch(/Wecker-Start/);
    expect(chipBlocker({ writeCard: true })).toMatch(/Vorschau/);
    expect(alarmBlocker('classic', { writeCard: true })).toMatch(/Vorschau/);
    expect(lightBlocker('classic', 'ring', { writeCard: true })).toMatch(/Vorschau/);
    expect(headphonesBlocker('classic', { writeCard: true })).toMatch(/Vorschau/);
    expect(normalizeChoice('classic', '3', { light: 'ring', writeCard: true })).toEqual({ light: 'ring' });
    expect(normalizeChoice('classic', '3', { knob: 'poti', writeCard: true })).toEqual({ knob: 'poti', writeCard: true });
    expect(buildId('classic', '3', { knob: 'poti', preset: 'weiter', writeCard: true })).toBe('classic-3-poti-weiter-writeCard');
    expect(isPlain({ writeCard: true })).toBe(false);
    expect(choiceSummary({ writeCard: true })).toBe('Vorschau: Karten über die Box beschreiben');
    // Said honestly: a preview until the official firmware can do it.
    expect(WRITE_CARD_TEXT.text).toMatch(/Vorschau, bis die offizielle Firmware das kann/);
    expect(allowedChoices('classic', '3').some((c) => c.writeCard)).toBe(false);
    expect(allowedChoices('classic', '3', { writeCard: true }).filter((c) => c.writeCard)).toHaveLength(16);
  });

  it('says that D6 can do one thing only', () => {
    expect(D6_WARNING).toMatch(/^D6 kann nur eins: /);
    expect(D6_WARNING).toMatch(/SPKONOFF.*Vor-Taste.*Bluetooth/);
  });

  it('names builds like the build script', () => {
    expect(buildId('classic', '3', {})).toBe('classic-3');
    expect(buildId('classic', '3', { knob: 'encoder' })).toBe('classic-3-encoder');
    expect(buildId('classic', '3', { preset: 'weiter', traeger: true, headphones: true, speakerOff: true, light: 'ringVolume', knob: 'encoderSkip' })).toBe(
      'classic-3-encoderSkip-ringVolume-speakerOff-headphones-traeger-weiter',
    );
    expect(buildId('aio', '3x3', { preset: 'standard' })).toBe('aio-3x3');
  });

  it('plain means the official build', () => {
    expect(isPlain({})).toBe(true);
    expect(isPlain({ preset: 'standard' })).toBe(true);
    expect(isPlain({ traeger: true })).toBe(false);
    expect(isPlain({ knob: 'poti' })).toBe(false);
  });

  it('never allows a combination twice or a blocked one', () => {
    for (const [board, buttons] of BOARDS) {
      const ids = allowedChoices(board, buttons).map((c) => buildId(board, buttons, c));
      expect(new Set(ids).size).toBe(ids.length);
      for (const c of allowedChoices(board, buttons)) expect(normalizeChoice(board, buttons, c)).toEqual(c);
    }
  });

  it('summarizes in plain words', () => {
    expect(choiceSummary({ knob: 'encoder', light: 'ring', preset: 'weiter' })).toBe('Drehregler, Leuchtring, Weitermachen');
    expect(choiceSummary({})).toBe('');
  });
});

describe('Baukasten manifest', () => {
  const preview = offerWriteCardPreview(manifest);
  const allowed = new Set(BOARDS.flatMap(([board, buttons]) => allowedChoices(board, buttons, { writeCard: preview }).map((c) => buildId(board, buttons, c))));
  const built = new Set(manifest.builds.map((b) => b.id));

  it('pins the TNG version the official builds come from', () => {
    expect(manifest.format).toBe(1);
    expect(manifest.tng.commit).toBe('d527ca5f3c5090a74ccdf5505202db352d7531c8');
    expect(manifest.tng.versionString).toContain('V3.3.3');
    expect(manifest.tng.license).toBe('GPL-3.0');
    // The app calls this state checked: both must move together (docs/FIRMWARE-BAUKASTEN.md, „Geprüfter Stand“).
    expect(manifest.tng.versionString).toBe(CHECKED_TNG.versionString);
    expect(manifest.tng.commit).toBe(CHECKED_TNG.commit);
    expect(manifest.tng.date).toBe(CHECKED_TNG.date);
  });

  it('has a build or a "does not fit" for every allowed choice, and nothing else', () => {
    for (const id of allowed) expect(built.has(id) || manifest.notFitting.includes(id), id).toBe(true);
    for (const id of built) expect(allowed.has(id), id).toBe(true);
    for (const id of manifest.notFitting) expect(allowed.has(id), id).toBe(true);
    expect(built.size).toBe(manifest.builds.length);
  });

  it('every build fits its board and has exactly the flags of its extras', () => {
    for (const b of manifest.builds) {
      expect(buildId(b.board, b.buttons, choiceOf(b))).toBe(b.id);
      expect(b.fits).toBe(true);
      expect(b.bytes).toBeLessThanOrEqual(b.board === 'classic' ? 32256 : 29696);
      expect(b.needsNewBootloader).toBe(b.board === 'classic' && b.bytes > 30720);
      expect(b.ram).toBeLessThan(2048 - 300);
      const d = new Set(b.defines);
      expect(d.has(b.board === 'classic' ? 'TonUINO_Classic=1' : 'ALLinONE=1'), b.id).toBe(true);
      expect(d.has('ROTARY_ENCODER'), b.id).toBe(b.knob === 'encoder' || b.knob === 'encoderSkip');
      expect(d.has('ROTARY_ENCODER_LONGPRESS'), b.id).toBe(b.knob === 'encoderSkip');
      expect(d.has('POTI'), b.id).toBe(b.knob === 'poti');
      expect(d.has('NEO_RING'), b.id).toBe(b.light === 'ring' || b.light === 'ringVolume');
      expect(d.has('NEO_RING_EXT'), b.id).toBe(b.light === 'ringVolume');
      expect(d.has('USE_LED_BUTTONS'), b.id).toBe(b.light === 'ledButtons');
      expect(d.has('SPKONOFF'), b.id).toBe(b.speakerOff);
      expect(d.has('HPJACKDETECT'), b.id).toBe(b.headphones);
      expect(d.has('USE_TRAEGER_PLATINE_SHUTDOWN'), b.id).toBe(b.traeger);
      expect(d.has('STORE_LAST_CARD'), b.id).toBe(b.preset === 'weiter');
      // As the official environments: the AiO has 5 buttons when nothing else is set.
      expect(d.has('FIVEBUTTONS=1'), b.id).toBe(b.board === 'classic' && b.buttons === '5');
      expect(d.has('THREEBUTTONS'), b.id).toBe(b.board === 'aio' && b.buttons === '3');
      expect(d.has('BUTTONS3X3=1'), b.id).toBe(b.buttons === '3x3');
      // At most one chip define, the one of the build; the official chip setting otherwise.
      expect(b.chip, b.id).toBeDefined();
      expect(chipFromDefines(b.defines), b.id).toBe(b.chip);
      expect(OTHER_CHIPS.filter((c) => d.has(CHIP_DEFINES[c]!)).length, b.id).toBe(b.chip === 'standard' ? 0 : 1);
      if (b.chip !== 'standard') expect(chipBlocker(choiceOf(b)), b.id).toBeUndefined();
      expect(d.has('SPECIAL_START_SHORTCUT'), b.id).toBe(!!b.alarm);
      expect(d.has('SerialWriteCard'), b.id).toBe(!!b.writeCard);
      // Never the other serial switch: the preview only writes cards.
      expect(d.has('SerialInputAsCommand'), b.id).toBe(false);
    }
  });

  it('offers the write-card preview from TNG issue_345 (abfa307) for the Classic; the AiO has no room', () => {
    expect(preview).toBe(true);
    expect(manifest.tng.writeCard).toBe(false);
    expect(manifest.writeCardPreview).toMatchObject({
      repository: 'https://github.com/tonuino/TonUINO-TNG',
      commit: 'abfa3075f8dea929a943943eb8059d2b362ed160',
      branch: 'issue_345',
      author: 'donschoof',
      license: 'GPL-3.0',
      defines: ['SerialWriteCard'],
    });
    expect(manifest.sources['tng-writecard'].commit).toBe(manifest.writeCardPreview!.commit);
    const wc = manifest.builds.filter((b) => b.writeCard);
    expect(wc).toHaveLength(24);
    for (const b of wc) expect(b.board, b.id).toBe('classic');
    // Measured: the plain Classic fits the old bootloader (30684 of 30720 bytes), with more it needs the new one.
    expect(findBuild(manifest, 'classic-3-writeCard')!.needsNewBootloader).toBe(false);
    for (const buttons of ['3', '5', '3x3'] as const) expect(choiceStatus(manifest, 'aio', buttons, { writeCard: true }).kind).toBe('too-big');
    // The one place that decides: once official TNG has the command, the choice goes.
    expect(offerWriteCardPreview({ ...manifest, tng: { ...manifest.tng, writeCard: true } })).toBe(false);
    expect(offerWriteCardPreview({ ...manifest, writeCardPreview: undefined })).toBe(false);
  });

  it('has what Frank needs: the Classic with 3 buttons and each knob, on the old bootloader too', () => {
    for (const knob of ['encoder', 'encoderSkip', 'poti'] as const) {
      const s = choiceStatus(manifest, 'classic', '3', { knob });
      expect(s.kind).toBe('ok');
      if (s.kind === 'ok') expect(s.build.needsNewBootloader).toBe(false);
    }
    expect(choiceStatus(manifest, 'aio', '3', { knob: 'encoder' }).kind).toBe('ok');
  });

  it('has the MH2024K-24SS fix for every common build that fits, and the old ones unchanged', () => {
    const chipBuilds = manifest.builds.filter((b) => b.chip !== 'standard');
    for (const chip of OTHER_CHIPS) {
      for (const [board, buttons] of BOARDS) {
        const s = choiceStatus(manifest, board, buttons, { chip });
        // The AiO with 3x3 buttons is nearly full already (29666 of 29696 bytes): only LISP3 still fits.
        expect(s.kind, `${board}-${buttons}-${chip}`).toBe(board === 'aio' && buttons === '3x3' && chip !== 'lisp3' ? 'too-big' : 'ok');
        if (s.kind === 'ok') expect(s.build.needsNewBootloader).toBe(false);
      }
    }
    expect(choiceStatus(manifest, 'classic', '3', { knob: 'encoder', traeger: true, chip: 'mh2024k24ss' }).kind).toBe('ok');
    expect(chipBuilds.length).toBeGreaterThan(90);
    // Same define as the forum fix (15006#6).
    expect(findBuild(manifest, 'classic-3-mh2024k24ss')!.defines).toContain('DFMiniMp3_T_CHIP_MH2024K24SS_MP3_TF_16P_V3_0');
  });

  it('has the alarm start for every common Classic build, on the old bootloader too, and for nothing else', () => {
    for (const buttons of ['3', '5', '3x3'] as const) {
      for (const c of [{}, { traeger: true }, { preset: 'weiter' as const }]) {
        const s = choiceStatus(manifest, 'classic', buttons, { ...c, alarm: true });
        expect(s.kind, `${buttons} ${JSON.stringify(c)}`).toBe('ok');
        if (s.kind === 'ok') expect(s.build.needsNewBootloader).toBe(false);
      }
    }
    const alarm = manifest.builds.filter((b) => b.alarm);
    expect(alarm.length).toBe(24);
    for (const b of alarm) {
      expect(b.board, b.id).toBe('classic');
      expect(b.chip, b.id).toBe('standard');
      expect(!!b.light || b.speakerOff || b.headphones, b.id).toBe(false);
    }
  });

  it('tells "too big" apart from "not there"', () => {
    const big = manifest.notFitting[0];
    expect(big).toBeDefined();
    expect(findBuild(manifest, big)).toBeUndefined();
    const fake: BaukastenManifest = { ...manifest, builds: [], notFitting: [] };
    expect(choiceStatus(fake, 'classic', '3', { knob: 'poti' }).kind).toBe('missing');
    const tooBig: BaukastenManifest = { ...manifest, builds: [], notFitting: ['classic-3-poti'] };
    expect(choiceStatus(tooBig, 'classic', '3', { knob: 'poti' }).kind).toBe('too-big');
  });

  it('says where the firmware comes from (GPL)', () => {
    const b = findBuild(manifest, 'classic-3-encoder')!;
    expect(sourceText(manifest, b)).toBe('TonUINO TNG 3.3.3 (https://github.com/tonuino/TonUINO-TNG, Commit d527ca5, freie Software unter der GPL-3.0), gebaut mit -D TonUINO_Classic=1 -D ROTARY_ENCODER');
    const wc = findBuild(manifest, 'classic-3-encoder-writeCard')!;
    expect(sourceText(manifest, wc)).toBe(
      'TonUINO TNG 3.3.3 (https://github.com/tonuino/TonUINO-TNG, Branch issue_345, Commit abfa307, Kartenschreiben von donschoof, freie Software unter der GPL-3.0), gebaut mit -D TonUINO_Classic=1 -D ROTARY_ENCODER -D SerialWriteCard',
    );
  });
});

describe('loading a build', () => {
  it('unpacks the image from its pack and checks it', async () => {
    const b = findBuild(manifest, 'classic-3-encoder')!;
    const img = await loadBuildImage(fileFetch, './', b);
    expect(img.byteCount).toBe(b.bytes);
    expect(img.startAddress).toBe(0);
    // An AVR image starts with the reset vector: a jmp (0x0c 0x94).
    expect([img.data[0], img.data[1]]).toEqual([0x0c, 0x94]);
    // The version string of TNG is in the image.
    expect(new TextDecoder('latin1').decode(img.data)).toContain('V3.3.3');
  });

  it('every pack is there and every build in it checks out', async () => {
    for (const b of manifest.builds) {
      const img = await loadBuildImage(fileFetch, './', b);
      expect(img.byteCount, b.id).toBe(b.bytes);
    }
  });

  it('refuses a broken image', async () => {
    const b = findBuild(manifest, 'classic-3-poti')!;
    await expect(loadBuildImage(fileFetch, './', { ...b, sha256: '0'.repeat(64) })).rejects.toThrow(/checksum/);
    await expect(loadBuildImage(fileFetch, './', { ...b, pack: 'gibtsnicht.pack.gz' })).rejects.toThrow(/404/);
  });

  it('recognizes a build in flash read back from a box, with erased bytes after it', async () => {
    const b = findBuild(manifest, 'classic-3-poti-headphones')!;
    const img = await loadBuildImage(fileFetch, './', b);
    const flash = new Uint8Array(32256).fill(0xff);
    flash.set(img.data);
    expect((await identifyBuild(manifest, flash))?.id).toBe(b.id);
    expect((await identifyBuild(manifest, img.data))?.id).toBe(b.id);
    flash[100] ^= 1;
    expect(await identifyBuild(manifest, flash)).toBeUndefined();
    expect(await identifyBuild(manifest, new Uint8Array(1000).fill(0xff))).toBeUndefined();
  });

  it('takes a pack the web server already unpacked', async () => {
    const b = findBuild(manifest, 'aio-3-encoder')!;
    const packed = new Uint8Array(readFileSync(join(PUBLIC, 'firmware/baukasten', b.pack)));
    const plain = await gunzip(packed);
    expect(await gunzip(plain)).toBe(plain);
    const unpackingServer = async (url: string) => (url.endsWith(b.pack) ? new Response(plain as BlobPart) : fileFetch(url));
    expect((await loadBuildImage(unpackingServer, './', b)).byteCount).toBe(b.bytes);
  });

  it('loads the manifest from next to the app', async () => {
    expect((await loadManifest(fileFetch, './')).builds.length).toBe(manifest.builds.length);
    await expect(loadManifest(async () => new Response(null, { status: 404 }), './')).rejects.toThrow(/404/);
  });
});
