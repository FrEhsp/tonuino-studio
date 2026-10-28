/**
 * Opening the big dialogs of Meine Box („Karte neu aufbauen“, „Auf eine
 * neue Karte kopieren“) from anywhere, without their code: it comes when
 * one opens (App.tsx), not with the start (0.6, #121).
 */
import { signal } from '@preact/signals';
import type { RebuildStart } from './rebuildTexts';

export type { RebuildStart };

/** The rebuild dialog asked for, and a number so opening it again starts it afresh. */
export const rebuildDialog = signal<{ start: RebuildStart; seq: number } | null>(null);
/** „Auf eine neue Karte kopieren“ asked for (a number for the same reason). */
export const copyToCardDialog = signal<number | null>(null);
let seq = 0;

export function openRebuildDialog(start: RebuildStart = 'rebuild'): void {
  rebuildDialog.value = { start, seq: ++seq };
}

export function openCopyToCardDialog(): void {
  copyToCardDialog.value = ++seq;
}
