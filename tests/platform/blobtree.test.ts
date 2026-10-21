import { describe, expect, it } from 'vitest';
import { childOf, cloneTree, files, nodeAt, sameContent, treeBytes, type BlobFile, type BlobFolder } from '../../src/platform/blobtree';
import { blobTree } from './blobfixtures';

const tree = () => blobTree({ '01': { '001.mp3': 'one', '002.mp3': 'two', Bonus: { 'a.txt': 'abc' } }, mp3: { '0001.mp3': 'sound' }, 'x.json': '{}' });

describe('blobtree', () => {
  it('cloneTree makes new nodes around the same Blobs', () => {
    const a = tree();
    const b = cloneTree(a);
    expect(b).not.toBe(a);
    expect(b.children[0]).not.toBe(a.children[0]);
    const fa = nodeAt(a, '01/001.mp3') as BlobFile;
    const fb = nodeAt(b, '01/001.mp3') as BlobFile;
    expect(fb).not.toBe(fa);
    expect(fb.blob).toBe(fa.blob);
    // Changing the clone leaves the original alone.
    (b.children[0] as BlobFolder).children.pop();
    fb.name = '009.mp3';
    expect(nodeAt(a, '01/Bonus')).toBeDefined();
    expect(fa.name).toBe('001.mp3');
  });

  it('sameContent wants the same names in the same order and the same Blobs', () => {
    const a = tree();
    expect(sameContent(a, cloneTree(a))).toBe(true);
    const renamed = cloneTree(a);
    (nodeAt(renamed, '01/002.mp3') as BlobFile).name = '003.mp3';
    expect(sameContent(a, renamed)).toBe(false);
    const reordered = cloneTree(a);
    (reordered.children[0] as BlobFolder).children.reverse();
    expect(sameContent(a, reordered)).toBe(false);
    const rewritten = cloneTree(a);
    (nodeAt(rewritten, '01/001.mp3') as BlobFile).blob = new Blob(['one']);
    expect(sameContent(a, rewritten)).toBe(false);
    expect(sameContent(a.children[1], rewritten.children[1])).toBe(true);
    const fewer = cloneTree(a);
    fewer.children.pop();
    expect(sameContent(a, fewer)).toBe(false);
    expect(sameContent(a.children[0], a.children[1])).toBe(false);
  });

  it('files() walks depth first in tree order', () => {
    expect([...files(tree())].map((f) => f.path)).toEqual(['01/001.mp3', '01/002.mp3', '01/Bonus/a.txt', 'mp3/0001.mp3', 'x.json']);
    expect([...files(tree().children[0] as BlobFolder, '01')].map((f) => f.path)).toEqual(['01/001.mp3', '01/002.mp3', '01/Bonus/a.txt']);
  });

  it('finds nodes ignoring case', () => {
    const t = tree();
    expect(childOf(t, 'MP3')?.name).toBe('mp3');
    expect(nodeAt(t, '01/bonus/A.TXT')?.name).toBe('a.txt');
    expect(nodeAt(t, '')).toBe(t);
    expect(nodeAt(t, '01/001.mp3/x')).toBeUndefined();
    expect(nodeAt(t, '02')).toBeUndefined();
  });

  it('adds up the sizes', () => {
    expect(treeBytes(tree())).toBe(3 + 3 + 3 + 5 + 2);
    expect(treeBytes(blobTree({}))).toBe(0);
  });
});
