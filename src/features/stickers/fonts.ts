/**
 * Fonts for sticker text. They ship with the app (SIL Open Font License), so
 * stickers look the same on every computer and work offline. Each font is
 * loaded on first use and registered for canvas and CSS alike.
 */
import fredokaText from '@expo-google-fonts/fredoka/500Medium/Fredoka_500Medium.ttf?url';
import figtreeTitle from '@expo-google-fonts/figtree/800ExtraBold/Figtree_800ExtraBold.ttf?url';
import figtreeText from '@expo-google-fonts/figtree/600SemiBold/Figtree_600SemiBold.ttf?url';
import bitterTitle from '@expo-google-fonts/bitter/700Bold/Bitter_700Bold.ttf?url';
import bitterText from '@expo-google-fonts/bitter/500Medium/Bitter_500Medium.ttf?url';
import patrickHand from '@expo-google-fonts/patrick-hand/400Regular/PatrickHand_400Regular.ttf?url';
import nunitoTitle from '@expo-google-fonts/nunito/900Black/Nunito_900Black.ttf?url';
import nunitoText from '@expo-google-fonts/nunito/700Bold/Nunito_700Bold.ttf?url';
import anton from '../../assets/fonts/anton-latin.woff2?url';
import lilitaOne from '../../assets/fonts/lilita-one-latin.woff2?url';
import caprasimo from '../../assets/fonts/caprasimo-latin.woff2?url';

export type FontId = 'round' | 'detective' | 'comic' | 'storybook' | 'clear' | 'book' | 'hand';

interface Face {
  family: string;
  weight: number;
  url: string;
}

export interface StickerFont {
  id: FontId;
  name: string;
  title: Face;
  text: Face;
  /** Letter spacing for the wordmark logo, in em. */
  tracking: number;
}

/**
 * Chosen after the type on children's audio plays: always bold and with
 * presence, never thin. "Rund" for the round, friendly series, "Detektiv"
 * narrow and black as on detective series, "Comic" for the loud poster
 * look, "Bilderbuch" round and fat with serifs like old picture books, retro
 * cassettes and many audiobook covers (Cooper Black); then plainer ones and
 * a hand-written one.
 */
export const STICKER_FONTS: readonly StickerFont[] = [
  { id: 'round', name: 'Rund', title: { family: 'TS Nunito', weight: 900, url: nunitoTitle }, text: { family: 'TS Nunito', weight: 700, url: nunitoText }, tracking: 0.01 },
  { id: 'detective', name: 'Detektiv', title: { family: 'TS Anton', weight: 400, url: anton }, text: { family: 'TS Figtree', weight: 600, url: figtreeText }, tracking: 0.03 },
  { id: 'comic', name: 'Comic', title: { family: 'TS Lilita One', weight: 400, url: lilitaOne }, text: { family: 'TS Fredoka', weight: 500, url: fredokaText }, tracking: 0.01 },
  { id: 'storybook', name: 'Bilderbuch', title: { family: 'TS Caprasimo', weight: 400, url: caprasimo }, text: { family: 'TS Bitter', weight: 500, url: bitterText }, tracking: 0 },
  { id: 'clear', name: 'Klar', title: { family: 'TS Figtree', weight: 800, url: figtreeTitle }, text: { family: 'TS Figtree', weight: 600, url: figtreeText }, tracking: 0 },
  { id: 'book', name: 'Buch', title: { family: 'TS Bitter', weight: 700, url: bitterTitle }, text: { family: 'TS Bitter', weight: 500, url: bitterText }, tracking: 0 },
  { id: 'hand', name: 'Handschrift', title: { family: 'TS Patrick Hand', weight: 400, url: patrickHand }, text: { family: 'TS Patrick Hand', weight: 400, url: patrickHand }, tracking: 0.02 },
];

export function stickerFont(id: FontId): StickerFont {
  return STICKER_FONTS.find((f) => f.id === id) ?? STICKER_FONTS[0];
}

/** CSS font shorthand for canvas, e.g. "600 42.5px 'TS Fredoka'". */
export function fontCss(face: Face, sizePx: number): string {
  return `${face.weight} ${sizePx.toFixed(2)}px '${face.family}', sans-serif`;
}

/**
 * The wordmark on stickers: written straight in the sticker's own title font,
 * as before 0.3. The owner found the handwriting of 0.3 "fürchterlich"; the
 * bold title fonts come close to the real TonUINO lettering.
 */
export function wordmarkFont(sizePx: number, font: StickerFont): string {
  return fontCss(font.title, sizePx);
}

const loading = new Map<string, Promise<void>>();

function loadFace(face: Face): Promise<void> {
  const key = `${face.family}:${face.weight}`;
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
      const ff = new FontFace(face.family, `url(${face.url})`, { weight: String(face.weight), style: 'normal' });
      document.fonts.add(await ff.load());
    })().catch(() => {
      // Without the file the text falls back to the system font; the sticker still works.
      loading.delete(key);
    });
    loading.set(key, p);
  }
  return p;
}

/** Loads both faces of a font; resolves (never rejects) once they are usable or failed. */
export async function loadStickerFont(id: FontId): Promise<StickerFont> {
  const f = stickerFont(id);
  await Promise.all([loadFace(f.title), loadFace(f.text)]);
  return f;
}

/** Loads the title faces of all fonts, for the font picker. */
export function loadAllTitleFaces(): Promise<void> {
  return Promise.all(STICKER_FONTS.map((f) => loadFace(f.title))).then(() => undefined);
}
