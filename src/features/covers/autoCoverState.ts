/**
 * The state of the background cover search (autoCovers.ts) on its own, so the
 * header, the sticker screen and the card page can show it without loading
 * the search itself (its code comes with the first run, after the start).
 */
import { signal } from '@preact/signals';
import type { CoverCandidate } from '../../core/stickers/coversearch';

export interface AutoCoverProposal {
  folder: number;
  title: string;
  /** Best first. */
  candidates: readonly CoverCandidate[];
}

export interface AutoCoverState {
  /** "idle": nothing to do or done; "running": looking; "off": switched off in the settings. */
  phase: 'idle' | 'running' | 'off';
  /** Folders looked at in this run, of `total`. */
  done: number;
  total: number;
  /** Folders that got a cover from this run (this session), in the order saved. */
  saved: readonly number[];
  /** Of those, how many from the folder's own files. */
  fromFiles: number;
  /** Hits to choose from, by folder. */
  proposals: ReadonlyMap<number, AutoCoverProposal>;
  /** No service answered at all: the rest waits for the next run. */
  unreachable: boolean;
  /** Services that did not answer while others did, and the addresses a web filter must let through; null when all answered. */
  webFilter: string | null;
}

export const IDLE: AutoCoverState = { phase: 'idle', done: 0, total: 0, saved: [], fromFiles: 0, proposals: new Map(), unreachable: false, webFilter: null };

export const autoCovers = signal<AutoCoverState>(IDLE);

/** The short line about a running search ("Suche Cover … 4 von 12": the folder it is at), or null when there is nothing to say. */
export function searchLine(s: AutoCoverState): string | null {
  if (s.phase !== 'running' || s.total <= 0) return null;
  return `Suche Cover … ${Math.min(s.done + 1, s.total)} von ${s.total}`;
}

/** The folders with hits to choose from, in folder order, leaving out those that have a cover by now. */
export function openProposals(s: AutoCoverState, hasCover: (folder: number) => boolean): AutoCoverProposal[] {
  return [...s.proposals.values()].filter((p) => p.candidates.length > 0 && !hasCover(p.folder)).sort((a, b) => a.folder - b.folder);
}

/** Takes a hit to choose from (loads the search the first time). */
export async function takeProposal(folder: number, candidateId: string): Promise<boolean> {
  const { acceptProposal } = await import('./autoCovers');
  return acceptProposal(folder, candidateId);
}

/** "Keins davon" (loads the search the first time). */
export async function dropProposal(folder: number): Promise<void> {
  const { declineProposal } = await import('./autoCovers');
  declineProposal(folder);
}
