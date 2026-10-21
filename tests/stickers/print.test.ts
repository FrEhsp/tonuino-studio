import { describe, expect, it } from 'vitest';
import { printCss } from '../../src/features/stickers/print';

describe('printing the sheets', () => {
  it('sets the paper size without margins and shows only the sheets, each exactly one page', () => {
    const css = printCss({ widthMm: 210, heightMm: 297 });
    expect(css).toContain('@page { size: 210mm 297mm; margin: 0; }');
    expect(css).toMatch(/body > \*:not\(#sticker-print-root\) \{ display: none !important; \}/);
    // A pixel less than the page, cut and not squeezed: WebKit put an empty page after every sheet (Testlabor #69).
    expect(css).toMatch(/img \{ display: block; width: 210mm; height: calc\(297mm - 1px\); object-fit: cover; object-position: left top;/);
    // Outside the print the sheets stay invisible.
    expect(css.split('@media print')[0]).toContain('#sticker-print-root { display: none; }');
  });
});
