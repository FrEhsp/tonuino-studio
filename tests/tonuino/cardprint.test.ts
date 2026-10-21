/**
 * The fingerprint that tells a card without a catalog from another one, so
 * a remembered Paket only waits on its own card.
 */
import { describe, expect, it } from 'vitest';
import { cardPrint, fitsWaitingPrint, type WaitingPrint } from '../../src/core/tonuino/cardprint';
import type { BlobFolder, BlobNode } from '../../src/platform/blobtree';

function tree(spec: Record<string, string>): BlobFolder {
  const root: BlobFolder = { kind: 'directory', name: 'TONUINO', children: [] };
  for (const [path, text] of Object.entries(spec)) {
    const parts = path.split('/');
    let at = root;
    for (const p of parts.slice(0, -1)) {
      let next = at.children.find((c): c is BlobFolder => c.kind === 'directory' && c.name === p);
      if (!next) {
        next = { kind: 'directory', name: p, children: [] };
        at.children.push(next);
      }
      at = next;
    }
    const name = parts[parts.length - 1];
    const node: BlobNode = { kind: 'file', name, blob: new Blob([text]) };
    at.children.push(node);
  }
  return root;
}

describe('cardPrint', () => {
  it('names every entry of the root with its bytes and files, in a fixed order', () => {
    const p = cardPrint(tree({ '02/001.mp3': 'abc', '01/001.mp3': 'a', '01/002.mp3': 'bb', 'tonuino-studio.json': '{}' }));
    expect(p).toEqual([
      ['01/', 3, 2],
      ['02/', 3, 1],
      ['tonuino-studio.json', 2, 1],
    ]);
  });

  it('leaves out what computers add on their own and a Paket saved onto the card', () => {
    const clean = cardPrint(tree({ '01/001.mp3': 'a' }));
    const messy = cardPrint(
      tree({
        '01/001.mp3': 'a',
        '01/._001.mp3': 'mac',
        '.Trashes/501/x': 'müll',
        'System Volume Information/IndexerVolumeGuid': 'win',
        'TonUINO-Paket-2026-10-06-1402.zip': 'zip',
      }),
    );
    expect(messy).toEqual(clean);
  });

  it('ignores the case of names, like the card does', () => {
    expect(cardPrint(tree({ 'MP3/0001.mp3': 'x' }))).toEqual(cardPrint(tree({ 'mp3/0001.mp3': 'x' })));
  });
});

describe('fitsWaitingPrint', () => {
  const before = cardPrint(tree({ 'mp3/0001.mp3': 'ton', '01/001.mp3': 'eins', '02/001.mp3': 'zwei' }));
  // The Paket adds 03 and replaces 02.
  const after = cardPrint(tree({ 'mp3/0001.mp3': 'ton', '01/001.mp3': 'eins', '02/001.mp3': 'zwei, länger', '03/001.mp3': 'drei' }));
  const w: WaitingPrint = { before, after, mayBeGone: ['02'], formatted: false };

  it('fits the card as read, as the Paket makes it, and every step in between', () => {
    expect(fitsWaitingPrint(before, w)).toBe(true);
    expect(fitsWaitingPrint(after, w)).toBe(true);
    // 03 unpacked, 02 still old.
    expect(fitsWaitingPrint(cardPrint(tree({ 'mp3/0001.mp3': 'ton', '01/001.mp3': 'eins', '02/001.mp3': 'zwei', '03/001.mp3': 'drei' })), w)).toBe(true);
    // 02 deleted before unpacking, as the guide says.
    expect(fitsWaitingPrint(cardPrint(tree({ 'mp3/0001.mp3': 'ton', '01/001.mp3': 'eins' })), w)).toBe(true);
  });

  it('does not fit a card with other content', () => {
    // Another box: its own folders.
    expect(fitsWaitingPrint(cardPrint(tree({ 'mp3/0001.mp3': 'ton', '01/001.mp3': 'pauls hörspiel' })), w)).toBe(false);
    // A folder more that neither the card nor the Paket has.
    expect(fitsWaitingPrint(cardPrint(tree({ 'mp3/0001.mp3': 'ton', '01/001.mp3': 'eins', '02/001.mp3': 'zwei', '07/001.mp3': 'x' })), w)).toBe(false);
    // 01 gone, though the Paket does not touch it.
    expect(fitsWaitingPrint(cardPrint(tree({ 'mp3/0001.mp3': 'ton', '02/001.mp3': 'zwei' })), w)).toBe(false);
    // An empty card.
    expect(fitsWaitingPrint([], w)).toBe(false);
  });

  it('lets any entry be gone for a whole-card Paket, which starts on a formatted card', () => {
    const full: WaitingPrint = { ...w, mayBeGone: [], formatted: true };
    expect(fitsWaitingPrint([], full)).toBe(true);
    expect(fitsWaitingPrint(cardPrint(tree({ 'mp3/0001.mp3': 'ton', '03/001.mp3': 'drei' })), full)).toBe(true);
    expect(fitsWaitingPrint(cardPrint(tree({ '05/001.mp3': 'fremd' })), full)).toBe(false);
  });
});
