/**
 * Parents look for the help of "Entdecken" with the words they know: the
 * Toniebox, a series they want, "gute Hörspiele". The help must say only
 * what the list really shows.
 */
import { describe, expect, it } from 'vitest';
import { searchHelp } from '../../src/features/help/search';
import { blockTexts, SOURCES_HELP } from '../../src/features/help/topics';

describe('help of "Entdecken"', () => {
  it('is found with the words parents use', () => {
    for (const q of ['tonie', 'toniebox', 'hörspielserie', 'benjamin blümchen', 'paw patrol', 'gute hörspiele', 'empfehlungen', 'drei fragezeichen']) {
      expect(searchHelp(q).hits.slice(0, 3).map((h) => h.id), q).toContain('entdecken');
    }
  });

  it('speaks of recommendations only as something that may be there, and never calls a series "not free"', () => {
    const text = SOURCES_HELP.blocks.flatMap(blockTexts).join('\n');
    expect(text).toContain('Wenn ich etwas besonders gut finde');
    expect(text).not.toMatch(/sind nicht kostenlos|gibt es nicht kostenlos/);
    expect(text).toContain('darf man nicht frei herunterladen');
  });
});
