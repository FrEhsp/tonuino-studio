import { describe, expect, it } from 'vitest';
import { FsaDir } from '../../src/platform/web/fsa';
import { fsaWithin, pickSaveFolder } from '../../src/platform/web/savefolder';
import { memDir } from '../../src/platform/memory';

/** Just enough of a folder handle: a name, a parent, and the two comparisons. */
class Handle {
  readonly kind = 'directory';
  constructor(
    readonly name: string,
    readonly parent?: Handle,
  ) {}
  async isSameEntry(other: Handle) {
    return other === this;
  }
  async resolve(other: Handle): Promise<string[] | null> {
    const path: string[] = [];
    for (let h: Handle | undefined = other; h; h = h.parent) {
      if (h === this) return path.reverse();
      path.push(h.name);
    }
    return null;
  }
}

const dir = (h: Handle) => new FsaDir(h as unknown as FileSystemDirectoryHandle);

describe('pickSaveFolder (browser)', () => {
  it('opens the folder chooser for writing, with its own start folder per purpose', async () => {
    const seen: unknown[] = [];
    const host = {
      showDirectoryPicker: async (o?: unknown) => {
        seen.push(o);
        return new Handle('Sicherungen') as unknown as FileSystemDirectoryHandle;
      },
    };
    const d = await pickSaveFolder({}, host);
    expect(d).toBeInstanceOf(FsaDir);
    expect(d?.name).toBe('Sicherungen');
    await pickSaveFolder({ purpose: 'copy' }, host);
    expect(seen).toEqual([
      { id: 'tonuino-backup', mode: 'readwrite' },
      { id: 'tonuino-copy', mode: 'readwrite' },
    ]);
  });

  it('is null when cancelled or when the browser has no folder access', async () => {
    expect(await pickSaveFolder({}, { showDirectoryPicker: async () => Promise.reject(new DOMException('x', 'AbortError')) })).toBeNull();
    expect(await pickSaveFolder({}, {})).toBeNull();
  });

  it('says what to do when the browser does not allow writing there', async () => {
    const err = await pickSaveFolder({}, { showDirectoryPicker: async () => Promise.reject(new DOMException('x', 'NotAllowedError')) }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/nicht erlaubt.*noch einmal/);
  });
});

describe('fsaWithin', () => {
  it('knows a folder on the card from one elsewhere', async () => {
    const card = new Handle('SD');
    const inside = new Handle('Sicherung', new Handle('Ordner', card));
    const other = new Handle('Sicherung', new Handle('Dokumente'));
    expect(await fsaWithin(dir(card), dir(card))).toBe(true);
    expect(await fsaWithin(dir(inside), dir(card))).toBe(true);
    expect(await fsaWithin(dir(other), dir(card))).toBe(false);
    expect(await fsaWithin(memDir({}), dir(card))).toBeNull();
  });
});
