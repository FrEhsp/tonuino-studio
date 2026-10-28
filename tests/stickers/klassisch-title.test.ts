/**
 * TODO #116: switching to "Klassisch" turns the title off; a title switched on there again is kept for
 * Klassisch, and the other styles keep theirs.
 */
import { describe, expect, it } from 'vitest';
import { changedDesign, DEFAULT_DESIGN, titleDefault } from '../../src/features/stickers/design';

describe('the title by style', () => {
  it('is off when switching to Klassisch, on for the other styles', () => {
    expect(titleDefault('blur')).toBe(false);
    expect(titleDefault('tape')).toBe(true);
    const d = changedDesign(DEFAULT_DESIGN, { style: 'blur' });
    expect(d.showTitle).toBe(false);
    expect(changedDesign(d, { style: 'full' }).showTitle).toBe(true);
  });

  it('remembers the choice made in each style', () => {
    let d = changedDesign(DEFAULT_DESIGN, { style: 'blur' });
    d = changedDesign(d, { showTitle: true });
    d = changedDesign(d, { style: 'tape' });
    expect(d.showTitle).toBe(true);
    d = changedDesign(d, { showTitle: false });
    d = changedDesign(d, { style: 'blur' });
    expect(d.showTitle).toBe(true);
    d = changedDesign(d, { style: 'tape' });
    expect(d.showTitle).toBe(false);
  });

  it('leaves the title alone for any other change', () => {
    const d = changedDesign({ ...DEFAULT_DESIGN, style: 'blur', showTitle: true }, { font: 'clear' });
    expect(d.showTitle).toBe(true);
    expect(changedDesign(d, { style: 'blur' }).showTitle).toBe(true);
  });
});
