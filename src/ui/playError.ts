/**
 * What "Anhören" says when a track does not play. Browsers reject play()
 * with English texts ("The operation is not supported.") and report broken
 * files only as a number: those never reach the screen. Each message says
 * what happened and what to do now.
 */

export interface PlayProblem {
  title: string;
  text: string;
}

/** MediaError codes (HTMLMediaElement.error.code). */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const TITLE = 'Abspielen geht nicht';

/** The error of play() that is worth one more try with a fresh player (WebKitGTK refuses now and then). */
export function isNotSupported(e: unknown): boolean {
  return errorName(e) === 'NotSupportedError';
}

/** A stop on purpose (another track, the page left): nothing to say. */
export function isAbort(e: unknown): boolean {
  return errorName(e) === 'AbortError';
}

/** The text of an error of the desktop player (TauriPlatformError, or NativeAudio's error), never a browser's English one. */
function germanText(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const { message, german } = e as { message?: unknown; german?: unknown };
  if (typeof message !== 'string' || !message) return undefined;
  return german === true || errorName(e) === 'TauriPlatformError' ? message : undefined;
}

function errorName(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'name' in e && typeof (e as { name: unknown }).name === 'string' ? (e as { name: string }).name : undefined;
}

/**
 * The message for a failed play() or a player that stopped with an error.
 * `mediaCode` is HTMLMediaElement.error?.code, when the player has one.
 */
export function playProblem(e: unknown, mediaCode?: number): PlayProblem {
  // The desktop app's own player says what happened in German already.
  const german = germanText(e);
  if (german) return { title: TITLE, text: german };
  if (mediaCode === MEDIA_ERR_DECODE) {
    return { title: TITLE, text: 'Die Datei ist beschädigt oder in einem Format, das dieser Computer nicht abspielen kann. Probiere einen anderen Titel.' };
  }
  if (mediaCode === MEDIA_ERR_NETWORK) {
    return { title: TITLE, text: 'Die Datei ließ sich nicht zu Ende lesen. Steckt die SD-Karte noch? Versuche es noch einmal.' };
  }
  if (errorName(e) === 'NotAllowedError') {
    return { title: TITLE, text: 'Der Computer hat das Abspielen gerade nicht erlaubt. Klicke noch einmal auf „Anhören“.' };
  }
  if (isNotSupported(e) || mediaCode === MEDIA_ERR_SRC_NOT_SUPPORTED || mediaCode === MEDIA_ERR_ABORTED) {
    return {
      title: TITLE,
      text: 'Der Abspieler kommt mit dieser Datei gerade nicht zurecht. Warte kurz und klicke noch einmal auf „Anhören“. Klappt es wieder nicht, schließe TonUINO Studio und öffne es neu.',
    };
  }
  return { title: TITLE, text: 'Etwas ist beim Abspielen schiefgegangen. Versuche es noch einmal. Klappt es wieder nicht, schließe TonUINO Studio und öffne es neu.' };
}
