import { signal } from '@preact/signals';

/**
 * The look of the app. Up to 0.1 there were three to pick from; since 0.2
 * there is one, "Holzwerkstatt". Its style sheets (tokens.css, stil-holz.css)
 * still hang their rules on data-stil='holz' on <html>, which index.html sets
 * before the first paint, so they did not have to be rewritten.
 */
export type Stil = 'holz';

export const STIL: Stil = 'holz';

/** Kept as a signal for the drawn frames (drawnFrames.ts, Sketch.tsx), which still ask for it. */
export const stil = signal<Stil>(STIL);
