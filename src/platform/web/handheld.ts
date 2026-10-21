/**
 * Phones and tablets: the web app needs a computer with the SD card in it
 * (see the help on browsers). Android Chrome and iOS Safari have a folder
 * chooser too, so feature detection alone would offer them the Paket mode,
 * which does not work there. This decides by the device instead.
 *
 * What the browser can do still decides between direct access and Pakete on
 * a computer (see createWebPlatform); this only keeps phones and tablets
 * out of both.
 */

export interface DeviceHints {
  userAgent: string;
  /** navigator.userAgentData.mobile, only in Chromium browsers. */
  mobileHint?: boolean;
  maxTouchPoints: number;
  /** The main pointer is a finger and there is no mouse or trackpad at all. */
  touchOnly: boolean;
  /** Longer side of the screen (not the window) in CSS pixels. */
  screenLongSide: number;
}

/** Up to this size a touch-only screen is a phone or tablet (iPad Pro: 1366). */
const TABLET_LONG_SIDE = 1366;

export function isHandheld(h: DeviceHints): boolean {
  if (h.mobileHint === true) return true;
  const ua = h.userAgent;
  if (/\b(?:iPhone|iPod|iPad|Android)\b/i.test(ua)) return true;
  // iPadOS Safari says "Macintosh" like a Mac; a Mac has no touch screen.
  if (/Macintosh/i.test(ua)) return h.maxTouchPoints > 1;
  // Windows and ChromeOS run on computers, also as tablets with a card reader.
  if (/Windows|CrOS/i.test(ua)) return false;
  // Anything else (an Android tablet asking for the desktop site says "Linux"): judged by its screen.
  return h.touchOnly && h.screenLongSide > 0 && h.screenLongSide <= TABLET_LONG_SIDE;
}

/** The hints of this browser. */
export function deviceHints(): DeviceHints {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { userAgentData?: { mobile?: boolean } }) : undefined;
  const media = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
  const scr = typeof screen !== 'undefined' ? screen : undefined;
  return {
    userAgent: nav?.userAgent ?? '',
    mobileHint: nav?.userAgentData?.mobile,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    touchOnly: media('(pointer: coarse)') && !media('(any-pointer: fine)'),
    screenLongSide: scr ? Math.max(scr.width, scr.height) : 0,
  };
}
