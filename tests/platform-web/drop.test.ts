/**
 * Files dropped onto the page. The browser empties the DataTransfer as soon
 * as the drop handler returns, so everything has to be taken out before the
 * first await. These fakes empty themselves the same way.
 */
import { describe, expect, it } from 'vitest';
import { captureDrop, sourcesFromCapture, sourcesFromDrop } from '../../src/platform/web/drop';
import type { EntryLike } from '../../src/platform/snapshot';
import { handleDrop } from '../../src/ui/useFileDrop';

interface FakeItem {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?(): unknown;
  getAsFileSystemHandle?(): Promise<unknown>;
}

/** A DataTransfer that is empty once `end()` ran, as after the drop event. */
function dropOf(items: FakeItem[]) {
  let during = true;
  const dt = {
    get items() {
      return during ? items : [];
    },
    get files() {
      return during ? items.map((i) => i.getAsFile()) : [];
    },
  } as unknown as DataTransfer;
  return { dt, end: () => (during = false) };
}

function fileItem(name: string, text: string): FakeItem {
  const f = new File([text], name);
  return { kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => null };
}

function folderEntry(name: string, files: Record<string, string>): EntryLike {
  const kids: EntryLike[] = Object.entries(files).map(
    ([n, text]) =>
      ({
        name: n,
        isFile: true,
        isDirectory: false,
        file: (ok: (f: File) => void) => ok(new File([text], n)),
      }) as unknown as EntryLike,
  );
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let given = false;
      return {
        readEntries: (ok: (e: EntryLike[]) => void) => {
          ok(given ? [] : kids);
          given = true;
        },
      };
    },
  } as unknown as EntryLike;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a drop', () => {
  it('keeps its files when they are taken out during the event', async () => {
    const { dt, end } = dropOf([fileItem('cover.jpg', 'bild'), fileItem('001.mp3', 'ton')]);
    const captured = captureDrop(dt);
    end();
    const sources = await sourcesFromCapture(captured);
    expect(sources.map((s) => s.name)).toEqual(['cover.jpg', '001.mp3']);
  });

  it('is empty when the files are only looked at after an await (the old way)', async () => {
    const { dt, end } = dropOf([fileItem('cover.jpg', 'bild')]);
    const late = (async () => {
      await Promise.resolve();
      return sourcesFromDrop(dt);
    })();
    end();
    expect(await late).toEqual([]);
  });

  it('reads a dropped folder through its entry', async () => {
    const entry = folderEntry('Hörspiel', { '01.mp3': 'a', '02.mp3': 'b', '.DS_Store': 'x' });
    const item: FakeItem = { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => entry };
    const { dt, end } = dropOf([item]);
    const captured = captureDrop(dt);
    end();
    const sources = await sourcesFromCapture(captured);
    expect(sources.map((s) => s.relativePath)).toEqual(['Hörspiel/01.mp3', 'Hörspiel/02.mp3']);
  });

  it('falls back to the entry or the file when the folder handle is refused', async () => {
    const f = new File(['ton'], '001.mp3');
    const item: FakeItem = { kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => null, getAsFileSystemHandle: () => Promise.reject(new DOMException('no', 'NotAllowedError')) };
    const { dt, end } = dropOf([item]);
    const captured = captureDrop(dt);
    end();
    expect((await sourcesFromCapture(captured)).map((s) => s.name)).toEqual(['001.mp3']);
  });

  it('reaches the page through the hook’s handler, taken before the event ends', async () => {
    const { dt, end } = dropOf([fileItem('foto.png', 'png')]);
    const got: string[][] = [];
    const errors: unknown[] = [];
    handleDrop(
      dt,
      (sources) => got.push(sources.map((s) => s.name)),
      (e) => errors.push(e),
    );
    // The drop event is over: the browser has emptied the DataTransfer.
    end();
    await tick();
    expect(errors).toEqual([]);
    expect(got).toEqual([['foto.png']]);
  });
});
