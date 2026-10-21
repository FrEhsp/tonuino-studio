import { describe, expect, it } from 'vitest';
import { NO_CHOOSER_HINT_MS, noChooserHint } from '../../src/features/workshop/ports';

describe('hint when no chooser came', () => {
  it('speaks up only in a browser that asks for an add-on, and only after a while', () => {
    expect(NO_CHOOSER_HINT_MS).toBe(3000);
    expect(noChooserHint(0, true)).toBe(false);
    expect(noChooserHint(2999, true)).toBe(false);
    expect(noChooserHint(3000, true)).toBe(true);
    expect(noChooserHint(13_000, true)).toBe(true);
    // Chrome and Edge: an empty answer means the user closed the chooser.
    expect(noChooserHint(13_000, false)).toBe(false);
    expect(noChooserHint(13_000, undefined)).toBe(false);
  });
});
