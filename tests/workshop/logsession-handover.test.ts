import { describe, expect, it } from 'vitest';
import { keepsLogConnection } from '../../src/features/workshop/logsession';

describe('connection between Box-Logbuch and reader test', () => {
  it('keeps the port between the two pages that read the box', () => {
    expect(keepsLogConnection({ page: 'workshop', tool: 'kartenleser' })).toBe(true);
    expect(keepsLogConnection({ page: 'workshop', tool: 'logbuch' })).toBe(true);
    expect(keepsLogConnection({ page: 'workshop', tool: 'tasten' })).toBe(true);
    // The guided Box testen, and the Lötplan it shows a joint in.
    expect(keepsLogConnection({ page: 'workshop', tool: 'testen' })).toBe(true);
    expect(keepsLogConnection({ page: 'workshop', tool: 'loetplan' })).toBe(true);
  });

  it('frees it for every other page, above all the firmware wizard', () => {
    expect(keepsLogConnection({ page: 'workshop', tool: 'firmware' })).toBe(false);
    expect(keepsLogConnection({ page: 'workshop' })).toBe(false);
    expect(keepsLogConnection({ page: 'help', topic: 'kartenleser-testen' })).toBe(false);
    expect(keepsLogConnection({ page: 'box' })).toBe(false);
  });
});
