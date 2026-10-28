import { describe, expect, it } from 'vitest';
import { IDLE, openProposals, searchLine, type AutoCoverProposal, type AutoCoverState } from '../../src/features/covers/autoCoverState';
import type { CoverCandidate } from '../../src/core/stickers/coversearch';

const hit = (id: string) => ({ id, source: 'itunes', title: 'T', artist: 'A', thumbUrl: `https://x/${id}`, fullUrl: `https://x/${id}` }) as unknown as CoverCandidate;
const proposal = (folder: number, n = 2): AutoCoverProposal => ({ folder, title: `Ordner ${folder}`, candidates: Array.from({ length: n }, (_, i) => hit(`${folder}-${i}`)) });
const state = (p: Partial<AutoCoverState>): AutoCoverState => ({ ...IDLE, ...p });

describe('the cover search as the header and the screens show it', () => {
  it('says at which folder a running search is, and nothing otherwise', () => {
    expect(searchLine(state({ phase: 'running', done: 0, total: 1 }))).toBe('Suche Cover … 1 von 1');
    expect(searchLine(state({ phase: 'running', done: 3, total: 12 }))).toBe('Suche Cover … 4 von 12');
    expect(searchLine(state({ phase: 'running', done: 12, total: 12 }))).toBe('Suche Cover … 12 von 12');
    expect(searchLine(state({ phase: 'running', done: 0, total: 0 }))).toBeNull();
    expect(searchLine(state({ phase: 'idle', done: 12, total: 12 }))).toBeNull();
    expect(searchLine(state({ phase: 'off' }))).toBeNull();
  });

  it('offers the hits in folder order, without folders that have a cover by now or no hit left', () => {
    const proposals = new Map([
      [12, proposal(12)],
      [3, proposal(3)],
      [7, proposal(7)],
      [9, proposal(9, 0)],
    ]);
    const open = openProposals(state({ proposals }), (n) => n === 7);
    expect(open.map((p) => p.folder)).toEqual([3, 12]);
  });
});
