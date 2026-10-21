import { describe, expect, it } from 'vitest';
import { cardEntryFromDrop } from '../../src/platform/web/carddrop';

type Item = { kind: string; webkitGetAsEntry?: () => unknown };

function drop(...items: Item[]): DataTransfer {
  return { items } as unknown as DataTransfer;
}

const folder = { isFile: false, isDirectory: true, name: 'TONUINO' };
const file = { isFile: true, isDirectory: false, name: '001.mp3' };

describe('a card dropped onto the page', () => {
  it('is the dropped folder', () => {
    expect(cardEntryFromDrop(drop({ kind: 'file', webkitGetAsEntry: () => folder }))).toEqual({ entry: folder });
  });

  it('is nothing when no files were dragged (text, a link)', () => {
    expect(cardEntryFromDrop(drop())).toBeNull();
    expect(cardEntryFromDrop(drop({ kind: 'string' }))).toBeNull();
  });

  it('is one thing only', () => {
    expect(cardEntryFromDrop(drop({ kind: 'file', webkitGetAsEntry: () => folder }, { kind: 'file', webkitGetAsEntry: () => file }))).toEqual({
      problem: 'several-items',
    });
  });

  it('is a folder, not a file', () => {
    expect(cardEntryFromDrop(drop({ kind: 'file', webkitGetAsEntry: () => file }))).toEqual({ problem: 'not-a-folder' });
    expect(cardEntryFromDrop(drop({ kind: 'file', webkitGetAsEntry: () => null }))).toEqual({ problem: 'not-a-folder' });
    expect(cardEntryFromDrop(drop({ kind: 'file' }))).toEqual({ problem: 'not-a-folder' });
  });
});
