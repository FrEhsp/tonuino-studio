import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { BaukastenBuild, BaukastenManifest } from '../../src/core/firmware/baukasten';
import { checkExtrasKept, containsText, extrasLostProblem, firmwareExtras, lostExtras } from '../../src/core/firmware/extrascheck';

const DIR = join(__dirname, '../../public/firmware/baukasten/');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as BaukastenManifest;
const packs = new Map<string, Uint8Array>();
function image(b: BaukastenBuild): Uint8Array {
  if (!packs.has(b.pack)) packs.set(b.pack, new Uint8Array(gunzipSync(readFileSync(join(DIR, b.pack)))));
  return packs.get(b.pack)!.slice(b.offset, b.offset + b.bytes);
}
const find = (p: (b: BaukastenBuild) => boolean) => {
  const b = manifest.builds.find(p);
  if (!b) throw new Error('no such build');
  return b;
};
/** As read off the box: the image, then erased flash. */
const asRead = (data: Uint8Array) => {
  const out = new Uint8Array(data.length + 2048).fill(0xff);
  out.set(data);
  return out;
};

const knobRing = find((b) => b.board === 'classic' && b.buttons === '3' && b.knob === 'encoder' && b.light === 'ring' && !b.headphones && !b.speakerOff && !b.traeger && b.preset === 'standard');
const hpOnly = find((b) => b.board === 'classic' && b.buttons === '3' && !b.knob && !b.light && b.headphones && b.preset === 'standard' && !b.traeger);
const ledOnly = find((b) => b.board === 'classic' && b.buttons === '3' && !b.knob && b.light === 'ledButtons' && !b.headphones && b.preset === 'standard' && !b.traeger && !b.speakerOff);
const plainWeiter = find((b) => b.board === 'classic' && b.buttons === '3' && !b.knob && !b.light && !b.headphones && !b.speakerOff && !b.traeger && b.preset === 'weiter');

describe('extras before a firmware update', () => {
  it('finds a text in the bytes', () => {
    const data = new TextEncoder().encode('xxhpJackDetect: 1');
    expect(containsText(data, 'hpJackDetect: ')).toBe(true);
    expect(containsText(data, 'hpJackDetect: 2')).toBe(false);
    expect(containsText(new Uint8Array(0), 'a')).toBe(false);
  });

  it('knows a Baukasten build read off the box exactly', async () => {
    const x = await firmwareExtras(manifest, asRead(image(knobRing)));
    expect(x.build?.id).toBe(knobRing.id);
    expect([...x.has].sort()).toEqual(['knob', 'light']);
  });

  it('tells headphones and LED buttons from the texts of any other firmware', async () => {
    // A changed byte makes it "another firmware": no build, only texts.
    const hp = image(hpOnly);
    hp[100] ^= 0xff;
    expect(await firmwareExtras(manifest, hp)).toEqual({ has: new Set(['headphones']) });
    const led = image(ledOnly);
    led[100] ^= 0xff;
    expect(await firmwareExtras(manifest, led)).toEqual({ has: new Set(['ledButtons']) });
    expect(await firmwareExtras(undefined, image(plainWeiter))).toEqual({ has: new Set() });
  });

  it('the write-card preview: known as a build, seen by its text in any other firmware, lost on the way back to plain TNG', async () => {
    const wc = find((b) => b.id === 'classic-3-weiter-writeCard');
    expect([...(await firmwareExtras(manifest, asRead(image(wc)))).has]).toEqual(['preset', 'writeCard']);
    // An official TNG with WRITECARD one day: not a Baukasten build, but the text gives it away.
    const other = image(wc);
    other[100] ^= 0xff;
    expect(await firmwareExtras(manifest, other)).toEqual({ has: new Set(['writeCard']) });
    expect(containsText(image(plainWeiter), 'WRITECARD: ')).toBe(false);
    const { problem } = await checkExtrasKept(manifest, asRead(image(wc)), image(plainWeiter), true);
    expect(problem?.title).toBe('Der neuen Firmware fehlt „Vorschau: Karten über die Box beschreiben“');
  });

  it('stops an update from the knob-and-ring build to a plain one, and says what goes', async () => {
    const { before, problem } = await checkExtrasKept(manifest, asRead(image(knobRing)), image(plainWeiter), true);
    expect(before.build?.id).toBe(knobRing.id);
    expect(problem?.code).toBe('extras-lost');
    expect(problem?.title).toBe('Der neuen Firmware fehlen Extras deiner Box');
    expect(problem?.explanation).toContain('Drehregler und Leuchtring');
    expect(problem?.explanation).toContain('noch nichts geschrieben');
    expect(problem?.steps[0]).toContain('Extras übernehmen');
  });

  it('lets the same extras through, and a box without extras anyway', async () => {
    expect((await checkExtrasKept(manifest, asRead(image(knobRing)), image(knobRing), true)).problem).toBeUndefined();
    expect((await checkExtrasKept(manifest, asRead(new Uint8Array(4000).fill(0x11)), image(plainWeiter), true)).problem).toBeUndefined();
    // „Weitermachen“ is an extra too.
    expect((await checkExtrasKept(manifest, asRead(image(plainWeiter)), image(knobRing), true)).problem?.explanation).toContain('Weitermachen');
  });

  it('counts a knob as lost only when the new firmware is known', () => {
    const before = { build: knobRing, has: new Set(['knob', 'light'] as const) };
    expect(lostExtras(before, { has: new Set() }, false)).toEqual([]);
    expect(lostExtras(before, { has: new Set() }, true)).toEqual(['knob', 'light']);
    expect(lostExtras({ has: new Set(['headphones'] as const) }, { has: new Set() }, false)).toEqual(['headphones']);
  });

  it('names a single extra in the title', () => {
    const p = extrasLostProblem(['headphones'], { has: new Set(['headphones']) });
    expect(p.title).toBe('Der neuen Firmware fehlt „Kopfhörer-Erkennung“');
    expect(p.steps[0]).toContain('Wähle unter „Extras“');
  });
});
