import { effect } from '@preact/signals';
import { quietMoment } from './quiet';

/**
 * Small copies of the covers for the tiny pictures in lists (Cover small: 40–56 px, „Viele Karten
 * auf einmal“, the stickers to pick, the shelf as a list). The covers on the card are 600 px and more;
 * for 52 of them at 40 px WebKitGTK decoded every one in full in the first frame of „Viele Karten auf
 * einmal“: 350 ms instead of 150 in 0.5.1. There the pictures were still decoded from the shelf of
 * the start page; in 0.6 WebKit has thrown them away by then (its memory cache under pressure), and
 * in the web app a service worker taking over the page makes them load anew (Prüfrunde 2, Tempo).
 * Made one by one in quiet moments after the card is read, kept until the card's covers go.
 */

/** The shorter side of a small copy: a 56 px picture on a phone with three pixels to one. */
export const SMALL_SIDE = 168;

export interface SmallCovers {
  /** The small copy of a cover, or the cover itself while there is none. */
  get(url: string): string;
  /** Makes small copies of these covers in quiet moments; drops those of covers no longer in the list. */
  want(urls: Iterable<string>): void;
  /** Resolved once every cover wanted so far has its copy (or none could be made). */
  idle(): Promise<void>;
}

export interface SmallCoverParts {
  /** The small copy of the picture at `url` as a new address, null when it needs none or none can be made. */
  shrink(url: string): Promise<string | null>;
  /** Frees an address made by shrink. */
  revoke(url: string): void;
  /** Waits for a quiet moment. */
  calm(): Promise<void>;
}

export function createSmallCovers(parts: SmallCoverParts): SmallCovers {
  const made = new Map<string, string>();
  const tried = new Set<string>();
  let wanted = new Set<string>();
  let running: Promise<void> | null = null;

  const run = async () => {
    for (;;) {
      const next = [...wanted].find((u) => !tried.has(u));
      if (next === undefined) return;
      await parts.calm();
      // Gone meanwhile (another card), or done by now.
      if (!wanted.has(next) || tried.has(next)) continue;
      tried.add(next);
      const small = await parts.shrink(next).catch(() => null);
      if (small === null) continue;
      if (wanted.has(next)) made.set(next, small);
      else parts.revoke(small);
    }
  };

  const api: SmallCovers = {
    get: (url) => made.get(url) ?? url,
    want(urls) {
      wanted = new Set(urls);
      for (const [url, small] of made) {
        if (wanted.has(url)) continue;
        made.delete(url);
        parts.revoke(small);
      }
      for (const url of tried) if (!wanted.has(url)) tried.delete(url);
      running ??= run().finally(() => {
        running = null;
        // Wanted while the last one was made.
        if ([...wanted].some((u) => !tried.has(u))) api.want(wanted);
      });
    },
    async idle() {
      while (running) await running;
    },
  };
  return api;
}

/** The picture at `url` as a PNG whose shorter side is SMALL_SIDE; null if it is that small already. */
async function shrinkInBrowser(url: string): Promise<string | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const blob = await (await fetch(url)).blob();
  const picture = await createImageBitmap(blob);
  try {
    const scale = SMALL_SIDE / Math.min(picture.width, picture.height);
    if (!(scale < 0.8)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.width * scale));
    canvas.height = Math.max(1, Math.round(picture.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return png ? URL.createObjectURL(png) : null;
  } finally {
    picture.close();
  }
}

export const smallCovers: SmallCovers = createSmallCovers({ shrink: shrinkInBrowser, revoke: (u) => URL.revokeObjectURL(u), calm: () => quietMoment(600) });

/** The small copy of a cover for a tiny picture, or the cover itself. */
export function smallCover(url: string | undefined): string | undefined {
  return url === undefined ? undefined : smallCovers.get(url);
}

/** Keeps small copies of the covers `covers` names, made in quiet moments. */
export function installSmallCovers(covers: () => Iterable<string>): void {
  effect(() => smallCovers.want(covers()));
}
