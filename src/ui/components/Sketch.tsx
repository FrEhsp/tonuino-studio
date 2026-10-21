import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { stil } from '../stil';
import { syncDrawnFrames } from '../drawnFrames';

/**
 * Speech bubbles with short notes belong to the Holz style. Lila speaks only
 * in the bubble of its welcome picture (Art.tsx), which does not ask here.
 * Callers that wrap a bubble in something of their own ask here first.
 */
export function bubblesShown(): boolean {
  return stil.value === 'holz';
}

/**
 * The filter that makes the illustrations look cut and drawn by hand in the
 * Holz style. Rendered once by the app; the illustrations refer to it by id.
 * It only shifts lines by a pixel or two: text is never filtered. Frames
 * are drawn without a filter (drawnFrames.ts).
 */
export function SketchDefs() {
  const holz = stil.value === 'holz';
  // The frames are pen strokes made in JS (drawnFrames.ts), not filtered.
  useEffect(syncDrawnFrames, [holz]);
  if (!holz) return null;
  return (
    <svg class="sketch-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        {/* Illustrations: lines and cut edges like paper cut with scissors. */}
        <filter id="ts-wobble-art" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}

/**
 * A comic speech bubble with a short, helpful note in handwriting, like the
 * notes on the founder's photos. Keep it short: one or two lines.
 * `tail` says where the bubble points to.
 */
export function Bubble({ children, tail = 'bottom', class: cls }: { children: ComponentChildren; tail?: 'bottom' | 'left' | 'top'; class?: string }) {
  if (!bubblesShown()) return null;
  return (
    <p class={['bubble', `tail-${tail}`, cls].filter(Boolean).join(' ')}>
      {children}
      <svg class="bubble-tail" viewBox="0 0 28 22" aria-hidden="true" focusable="false">
        <path d="M2 1 Q5.5 10.5 9 20 Q15.5 9.5 24 1" />
      </svg>
    </p>
  );
}
