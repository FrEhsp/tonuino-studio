/**
 * The faces the first screen is written in, loaded before it is drawn. The
 * style sheet shows text in a stand-in font until its own file is there
 * (font-display: swap); text that changes its font after the first frame
 * changes its width too, and the menu, the headings and the buttons jump
 * into place. The files come with the app, so this takes only a moment; a
 * face that does not arrive in time is not waited for.
 */
export const FIRST_SCREEN_FACES = ["400 16px Roboto", "500 16px Roboto", "700 16px Roboto"];

export function firstScreenFonts(maxMs = 1200, faces = FIRST_SCREEN_FACES): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return Promise.resolve();
  const all = Promise.all(faces.map((f) => fonts.load(f).catch(() => []))).then(() => undefined);
  return Promise.race([all, new Promise<void>((r) => setTimeout(r, maxMs))]);
}
