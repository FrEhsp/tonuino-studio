/**
 * Before a firmware update: which extras the firmware on the box has, read
 * back from its flash, and whether the new firmware keeps them. A box with a
 * knob or a light that gets a plain build afterwards does not use them any
 * more, and nobody knows why.
 *
 * What can be told:
 * - A build of the Firmware-Baukasten is known exactly (identifyBuild): knob,
 *   light, amplifier switch, headphones, carrier board shutdown, "weiter",
 *   alarm start, the write-card preview.
 * - Any other TNG firmware gives away two extras by the texts it logs
 *   (checked against all 264 Baukasten builds): "hpJackDetect: " only with
 *   the headphone detection, "LEDs(D/P/U): " only with the LED buttons. Knob
 *   and ring leave no text. "WRITECARD: " is in every firmware built with
 *   SerialWriteCard (state_machine.cpp str_WRITECARD), official or not.
 *
 * The check runs between reading the old firmware and writing the new one,
 * while the bootloader waits (it gives up after about a second), so it uses
 * only what is loaded already.
 */
import { ALARM_TEXT, WRITE_CARD_TEXT, choiceSummary, HEADPHONES_TEXT, identifyBuild, KNOB_TEXTS, LIGHT_TEXTS, PRESET_TEXTS, SPEAKER_OFF_TEXT, type BaukastenBuild, type BaukastenManifest } from './baukasten';
import type { FlashProblem } from './flash';

export type ExtraId = 'knob' | 'light' | 'ledButtons' | 'speakerOff' | 'headphones' | 'traeger' | 'preset' | 'alarm' | 'writeCard';

export interface FirmwareExtras {
  /** The Baukasten build, when the image is one. */
  build?: BaukastenBuild;
  /** What it has, by name; for a build every extra, else what the texts show. */
  has: Set<ExtraId>;
}

const encoder = new TextEncoder();

/** True when the bytes contain this ASCII text. */
export function containsText(data: Uint8Array, text: string): boolean {
  const needle = encoder.encode(text);
  const first = needle[0];
  outer: for (let i = data.indexOf(first); i >= 0 && i <= data.length - needle.length; i = data.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The extras of a build of the Baukasten. */
export function extrasOfBuild(build: BaukastenBuild): Set<ExtraId> {
  const has = new Set<ExtraId>();
  if (build.knob) has.add('knob');
  if (build.light === 'ledButtons') has.add('ledButtons');
  else if (build.light) has.add('light');
  if (build.speakerOff) has.add('speakerOff');
  if (build.headphones) has.add('headphones');
  if (build.traeger) has.add('traeger');
  if (build.preset !== 'standard') has.add('preset');
  if (build.alarm) has.add('alarm');
  if (build.writeCard) has.add('writeCard');
  return has;
}

/** The extras of a firmware image (read off the box, or about to be written). */
export async function firmwareExtras(manifest: BaukastenManifest | undefined, data: Uint8Array): Promise<FirmwareExtras> {
  // A backup comes without the erased flash at its end; a build may end in 0xff bytes too.
  const padded = new Uint8Array(data.length + 1024).fill(0xff);
  padded.set(data);
  const build = manifest ? await identifyBuild(manifest, padded) : undefined;
  if (build) return { build, has: extrasOfBuild(build) };
  const has = new Set<ExtraId>();
  if (containsText(data, 'hpJackDetect: ')) has.add('headphones');
  if (containsText(data, 'LEDs(D/P/U): ')) has.add('ledButtons');
  if (containsText(data, 'WRITECARD: ')) has.add('writeCard');
  return { has };
}

/**
 * What the box has now and the new firmware does not. An extra that cannot
 * be seen in the new image (knob, ring) counts as lost only when the new
 * image is known: a Baukasten build, or a firmware the app knows to be plain
 * (the ready-made official builds).
 */
export function lostExtras(before: FirmwareExtras, after: FirmwareExtras, afterKnown: boolean): ExtraId[] {
  const out: ExtraId[] = [];
  for (const e of before.has) {
    if (after.has.has(e)) continue;
    const visible = e === 'headphones' || e === 'ledButtons' || e === 'writeCard';
    if (visible || after.build || afterKnown) out.push(e);
  }
  return out;
}

/** The extra's name, as the wizard calls it. */
export function extraName(e: ExtraId, before: FirmwareExtras): string {
  const b = before.build;
  switch (e) {
    case 'knob':
      return b?.knob ? KNOB_TEXTS[b.knob].label : 'Drehregler';
    case 'light':
      return b?.light ? LIGHT_TEXTS[b.light].label : 'Leuchtring';
    case 'ledButtons':
      return LIGHT_TEXTS.ledButtons.label;
    case 'speakerOff':
      return SPEAKER_OFF_TEXT.label;
    case 'headphones':
      return HEADPHONES_TEXT.label;
    case 'traeger':
      return 'Abschaltung für CubieKid- oder Trägerplatine';
    case 'preset':
      return b ? PRESET_TEXTS[b.preset].label : 'Weitermachen';
    case 'alarm':
      return ALARM_TEXT.label;
    case 'writeCard':
      return WRITE_CARD_TEXT.label;
  }
}

/** The stop before writing, when the new firmware drops extras of the box. Nothing is written then. */
export function extrasLostProblem(lost: ExtraId[], before: FirmwareExtras): FlashProblem {
  const names = lost.map((e) => extraName(e, before));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
  return {
    code: 'extras-lost',
    title: names.length === 1 ? `Der neuen Firmware fehlt „${list}“` : 'Der neuen Firmware fehlen Extras deiner Box',
    explanation: `Die Firmware auf deiner Box hat ${list}, die neue nicht. Nach dem Update ginge ${names.length === 1 ? 'das' : 'das alles'} nicht mehr. Ich hab noch nichts geschrieben, die Box ist wie vorher.`,
    steps: [
      before.build ? 'Nimm „Extras übernehmen“, dann wähle ich dieselben Extras für die neue Firmware.' : 'Wähle unter „Extras“ dieselben Extras für die neue Firmware.',
      'Weißt du, dass die Box die Extras nicht braucht? Dann nimm „Trotzdem aufspielen“.',
    ],
    technical: before.build ? `on box: Baukasten build ${before.build.id} (${choiceSummary(extrasChoiceOf(before.build))})` : `on box: texts for ${[...before.has].join(', ')}`,
  };
}

function extrasChoiceOf(b: BaukastenBuild) {
  return { knob: b.knob ?? undefined, light: b.light ?? undefined, speakerOff: b.speakerOff, headphones: b.headphones, traeger: b.traeger, preset: b.preset, alarm: b.alarm, writeCard: b.writeCard };
}

/**
 * The whole check: undefined when the update keeps every extra. `newKnown`
 * says the new image is a firmware the app knows (a ready-made build or a
 * Baukasten build), not a file of unknown content.
 */
export async function checkExtrasKept(manifest: BaukastenManifest | undefined, old: Uint8Array, next: Uint8Array, newKnown: boolean): Promise<{ before: FirmwareExtras; problem?: FlashProblem }> {
  const before = await firmwareExtras(manifest, old);
  if (!before.has.size) return { before };
  const after = await firmwareExtras(manifest, next);
  const lost = lostExtras(before, after, newKnown);
  return lost.length ? { before, problem: extrasLostProblem(lost, before) } : { before };
}
