import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { memDir, memTreeNames } from '../../src/platform/memory';
import { downloadWithProgress, installSystemSounds, readSoundPackage } from '../../src/core/tonuino/soundsinstall';

async function zipOf(files: Record<string, number>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [name, size] of Object.entries(files)) z.file(name, new Uint8Array(size));
  return z.generateAsync({ type: 'uint8array' });
}

describe('system sounds installer', () => {
  it('replaces mp3 and advert, in order, with pure numbers', async () => {
    const pkg = await readSoundPackage(
      await zipOf({
        'sd-card/mp3/0300_new_tag.mp3': 3,
        'sd-card/mp3/0002.mp3': 2,
        'sd-card/mp3/0001.mp3': 1,
        'sd-card/advert/0001.mp3': 4,
        'sd-card/readme.txt': 1,
        '__MACOSX/sd-card/mp3/._0001.mp3': 1,
      }),
    );
    expect(pkg.files.map((f) => `${f.dir}/${f.original}`)).toEqual(['mp3/0001.mp3', 'mp3/0002.mp3', 'mp3/0300_new_tag.mp3', 'advert/0001.mp3']);
    const root = memDir({ MP3: { '0001.mp3': 9, 'eigene.mp3': 1 }, '01': { '001.mp3': 1 } });
    const progress: number[] = [];
    await installSystemSounds(root, pkg, { onProgress: (p) => progress.push(p.done) });
    expect(await memTreeNames(root)).toEqual({
      '01': { '001.mp3': 1 },
      mp3: { '0001.mp3': 1, '0002.mp3': 2, '0300.mp3': 3 },
      advert: { '0001.mp3': 4 },
    });
    expect(progress.at(-1)).toBe(4);
  });

  it('names announcements by their number alone, in ascending order', async () => {
    // The official download has "0300_new_tag.mp3"; the AiO board and the LKP player only find "0300.mp3".
    // The installer has no setting for this any more: "Nur Nummern als Dateinamen" is about tracks.
    const pkg = await readSoundPackage(await zipOf({ 'mp3/0300_new_tag.mp3': 1, 'mp3/0010_zehn.mp3': 2, 'mp3/0002.mp3': 3, 'advert/0001_x.mp3': 4 }));
    const root = memDir({});
    const written: string[] = [];
    await installSystemSounds(root, pkg, { onProgress: (p) => void (p.current && written.push(p.current)) });
    expect(written).toEqual(['mp3/0002.mp3', 'mp3/0010.mp3', 'mp3/0300.mp3', 'advert/0001.mp3']);
    const tree = (await memTreeNames(root)) as Record<string, Record<string, number>>;
    expect(tree).toEqual({ mp3: { '0002.mp3': 3, '0010.mp3': 2, '0300.mp3': 1 }, advert: { '0001.mp3': 4 } });
    expect(Object.keys(tree.mp3)).toEqual(['0002.mp3', '0010.mp3', '0300.mp3']);
  });

  it('writes a number only once when the package has it twice', async () => {
    // Without the text both would be 0300.mp3: the first one stays, nothing is overwritten.
    const pkg = await readSoundPackage(await zipOf({ 'mp3/0300.mp3': 5, 'mp3/0300_new_tag.mp3': 7, 'advert/0001.mp3': 1 }));
    const root = memDir({});
    expect((await installSystemSounds(root, pkg)).written).toBe(2);
    expect(await memTreeNames(root)).toEqual({ mp3: { '0300.mp3': 5 }, advert: { '0001.mp3': 1 } });
  });

  it('gives own announcements the four-digit number the player needs', async () => {
    const zip = await zipOf({ 'meine/mp3/300_neue_karte.mp3': 1, 'meine/mp3/0301.mp3': 2, 'meine/advert/1.MP3': 3, 'meine/advert/0002.wav': 4 });
    const root = memDir({});
    await installSystemSounds(root, await readSoundPackage(zip));
    expect(await memTreeNames(root)).toEqual({ mp3: { '0300.mp3': 1, '0301.mp3': 2 }, advert: { '0001.mp3': 3, '0002.wav': 4 } });
  });

  it('finds the announcements in a whole repository packed as ZIP, like the one for TonUINO 2.1', async () => {
    const pkg = await readSoundPackage(
      await zipOf({
        'TonUINO-DEV/Tonuino.ino': 1,
        'TonUINO-DEV/tools/create_audio_messages.py': 1,
        'TonUINO-DEV/sd-card/mp3/0300_new_tag.mp3': 2,
        'TonUINO-DEV/sd-card/advert/0001.mp3': 3,
      }),
    );
    expect(pkg.files.map((f) => `${f.dir}/${f.original}`)).toEqual(['mp3/0300_new_tag.mp3', 'advert/0001.mp3']);
  });

  it('rejects zips without system sounds', async () => {
    await expect(readSoundPackage(await zipOf({ 'foo/bar.mp3': 1 }))).rejects.toThrow(/keine Systemansagen/);
  });

  it('says in plain words when the download fails without a network', async () => {
    const fetchFn = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(downloadWithProgress(fetchFn, 'https://example.invalid/x.zip')).rejects.toThrow('Prüfe die Internetverbindung');
  });

  it('lets a cancelled download stay a cancel', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const fetchFn = () => Promise.reject(abort);
    await expect(downloadWithProgress(fetchFn, 'https://example.invalid/x.zip')).rejects.toBe(abort);
  });

  it('says in plain words when the connection drops halfway', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(new Uint8Array(3));
        } else c.error(new TypeError('network error'));
      },
    });
    const fetchFn = () => Promise.resolve(new Response(body));
    await expect(downloadWithProgress(fetchFn, 'https://example.invalid/x.zip')).rejects.toThrow('ließen sich nicht herunterladen');
  });
});
