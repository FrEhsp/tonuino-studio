import { describe, expect, it } from 'vitest';
import { HEADPHONE_PRESETS, hasHeadphoneDetection, headphoneGuide } from '../../src/features/workshop/headphones';

const info = (headphones?: boolean) => ({ settings: {}, folderTracks: {}, headphones });

describe('Kopfhörer-Grenzen', () => {
  it('are offered only when the box notices a headphone', () => {
    expect(hasHeadphoneDetection({ info: info(false) })).toBe(true);
    expect(hasHeadphoneDetection({ info: info(undefined) })).toBe(false);
    expect(hasHeadphoneDetection({ board: 'aioplus' })).toBe(true);
    expect(hasHeadphoneDetection({ board: 'classic' })).toBe(false);
    expect(hasHeadphoneDetection({ build: { id: 'x', board: 'classic', buttons: '3', headphones: true, from: 'read', at: 0 } })).toBe(true);
  });

  it('start with plugging in, and leave out the hint meant for the speaker', () => {
    const r = headphoneGuide('tng', HEADPHONE_PRESETS[0].volume, { max: 25, min: 5, init: 15 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.guide.steps[0].text).toMatch(/^Stecke einen Kopfhörer ein/);
    expect(r.guide.steps.length).toBeGreaterThan(3);
    expect(r.guide.notes.some((n) => n.includes('AiO+'))).toBe(false);
    expect(r.guide.notes.at(-1)).toContain('Kopfhörer abziehen');
  });

  it('need no step when the headphone has those limits already', () => {
    const r = headphoneGuide('tng', { max: 15, min: 1, init: 5 }, { max: 15, min: 1, init: 5 });
    expect(r.ok && r.guide.steps).toEqual([]);
    expect(r.ok && r.guide.unchanged).toEqual(['Lautstärke für Kopfhörer']);
  });

  it('refuse limits that do not fit together', () => {
    expect(headphoneGuide('tng', { max: 5, min: 10, init: 7 }, undefined).ok).toBe(false);
  });
});
