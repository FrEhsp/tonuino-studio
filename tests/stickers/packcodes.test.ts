/** "Nummer auf der Packung" (TODO #120): the number from the pack finds the paper. */
import { describe, expect, it } from 'vitest';
import { findPaperByCode, normalizePackCode, PACK_CODES } from '../../src/core/stickers/packcodes';
import { getTemplate } from '../../src/core/stickers/templates';

describe('normalizePackCode', () => {
  it('reads the number however it is typed', () => {
    expect(normalizePackCode('Avery Zweckform L4775-20')).toBe('L4775');
    expect(normalizePackCode(' l 4775 ')).toBe('L4775');
    expect(normalizePackCode('HERMA Nr. 5028')).toBe('5028');
    expect(normalizePackCode('herma5028')).toBe('5028');
    expect(normalizePackCode('5028-100')).toBe('5028');
    expect(normalizePackCode('Canon KC-18IF')).toBe('KC-18IF');
  });
});

describe('findPaperByCode', () => {
  const id = (code: string) => {
    const m = findPaperByCode(code);
    return m.kind === 'found' ? m.templateId : m.kind;
  };

  it('finds the papers of the forum classics', () => {
    expect(id('5028')).toBe('herma-5028');
    expect(id('J4775')).toBe('film-a4');
    expect(id('L4775-8')).toBe('film-a4');
    expect(id('L7917')).toBe('film-a4');
    expect(id('5065')).toBe('card-a4');
    expect(id('KC18IF')).toBe('selphy-card');
  });

  it('says what it knows of a number without a paper, and leads to an own size for any other', () => {
    const m = findPaperByCode('Zweckform 3490');
    expect(m.kind).toBe('known');
    if (m.kind === 'known') expect(m.entry.note).toContain('Eigene Größe');
    expect(id('4610')).toBe('unknown');
    expect(id('')).toBe('empty');
    // Half typed: no "kenne ich nicht" yet.
    expect(id('50')).toBe('partial');
    expect(id('L47')).toBe('partial');
  });

  it('only points to papers the app has, and lists every number once', () => {
    for (const e of PACK_CODES) if (e.templateId) expect(getTemplate(e.templateId), e.templateId).toBeDefined();
    const all = PACK_CODES.flatMap((e) => e.codes.map(normalizePackCode));
    expect(new Set(all).size).toBe(all.length);
  });
});
