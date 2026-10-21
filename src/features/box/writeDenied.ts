/**
 * A write the app may not do: told by the desktop as an error with the code
 * "permission" and the message of platform/tauri/errors.ts ('fs:permission'),
 * often wrapped (a CopyError, a repair step) or only kept as text. Pure, so
 * texts and tests can use it without the app's state.
 */
import { ACCESS_LOST_MARK } from '../../platform/web/fsa';

/** The sentence of that message that sends the user to "Meine Box"; dropped where the button is right there. */
export const WRITE_DENIED_HINT = 'Unter „Meine Box“ steht, wie du sie bekommst.';

/** The words of that message that say what is missing. */
const DENIED_MARK = 'fehlen die Schreibrechte';

/** Whether an error, its causes or a text say that the app may not write there. */
export function isWriteDenied(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 4; depth++) {
    if (typeof x === 'string') return x.includes(DENIED_MARK);
    if ((x as { code?: unknown }).code === 'permission') return true;
    if (x instanceof Error && x.message.includes(DENIED_MARK)) return true;
    x = x instanceof Error ? x.cause : undefined;
  }
  return false;
}

/** The text without the pointer to "Meine Box", for a place that offers "Schreibrechte holen" itself. */
export function withoutBoxHint(text: string): string {
  return text.replace(` ${WRITE_DENIED_HINT}`, '').replace(WRITE_DENIED_HINT, '').trim();
}

/** Whether an error, its causes or a text say that the browser took back the access to the card (Chrome, Edge). */
export function isAccessLost(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 4; depth++) {
    if (typeof x === 'string') return x.includes(ACCESS_LOST_MARK);
    if (x instanceof Error && x.message.includes(ACCESS_LOST_MARK)) return true;
    x = x instanceof Error ? x.cause : undefined;
  }
  return false;
}
