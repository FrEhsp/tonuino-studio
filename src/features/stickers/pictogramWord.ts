/**
 * The word the pictogram search starts with (PictogramPicker): the sticker's
 * title, and for the special cards what they do, since ARASAAC knows
 * „schlafen“ but not „Schlummerkarte“ (TODO 0.3 #103, „Wo Piktogramm“).
 */

const SPECIAL: readonly [RegExp, string][] = [
  [/schlummer/i, 'schlafen'],
  [/stopptanz/i, 'tanzen'],
  [/feuer, wasser/i, 'Feuer'],
  [/krabbel/i, 'Baby'],
  [/kita/i, 'Kindergarten'],
  [/wiederholen|nochmal/i, 'wiederholen'],
  [/jukebox/i, 'Musik'],
  [/pause/i, 'Pause'],
  [/ausschalt/i, 'ausschalten'],
  [/endlos/i, 'unendlich'],
  [/admin/i, 'Schlüssel'],
  [/gesperrt/i, 'Schloss'],
];

export function pictogramWord(title: string, special = false): string {
  if (special) for (const [re, word] of SPECIAL) if (re.test(title)) return word;
  return title.trim().split(/\s+/).slice(0, 3).join(' ');
}
