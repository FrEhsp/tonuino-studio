import { describe, expect, it } from 'vitest';
import { buildSmallId3, readTags } from '../../src/core/audio/id3';
import { memDir } from '../../src/platform/memory';
import { failedFileLine, readFolderTags, writeTagChanges } from '../../src/features/box/tagWrite';
import type { Dir } from '../../src/platform/types';

/** Stand-in for MPEG frames: what lies between the tags must come through unchanged. */
const AUDIO = Uint8Array.from({ length: 4000 }, (_, i) => (i * 7 + 3) & 0xff);

function id3v1(title: string): Uint8Array {
  const b = new Uint8Array(128);
  b.set([0x54, 0x41, 0x47]);
  for (let i = 0; i < title.length; i++) b[3 + i] = title.charCodeAt(i);
  b[127] = 255;
  return b;
}

function mp3(tag: Uint8Array, tail?: Uint8Array): Uint8Array {
  const out = new Uint8Array(tag.length + AUDIO.length + (tail?.length ?? 0));
  out.set(tag);
  out.set(AUDIO, tag.length);
  if (tail) out.set(tail, tag.length + AUDIO.length);
  return out;
}

async function bytesOf(dir: Dir, file: string): Promise<Uint8Array> {
  return dir.read(file);
}

describe('writing track infos to the card', () => {
  it('puts a small tag in front of the unchanged sound, under the same name', async () => {
    const root = memDir({ '05': { '001.mp3': mp3(buildSmallId3({ title: 'Alt', artist: 'SomeDownloader.com' }, { padding: 2048 }), id3v1('Alt')), '002.mp3': mp3(new Uint8Array(0)) } });
    const dir = await root.dir('05');
    const r = await writeTagChanges(dir, [{ file: '001.mp3', tags: { title: 'Neu', artist: 'Eva', album: 'Lieder', track: '1' } }]);
    expect(r.failed).toEqual([]);
    expect(r.written).toHaveLength(1);
    const data = await bytesOf(dir, '001.mp3');
    expect(r.written[0].size).toBe(data.length);
    const tag = buildSmallId3({ title: 'Neu', artist: 'Eva', album: 'Lieder', track: '1' });
    expect(data.length).toBe(tag.length + AUDIO.length);
    expect(data.subarray(tag.length)).toEqual(AUDIO);
    expect((await dir.list()).map((e) => e.name)).toEqual(['001.mp3', '002.mp3']);
    const read = await readFolderTags(dir, ['001.mp3', '002.mp3']);
    // The old ID3v1 tag at the end is gone too: it would bring back the old title.
    expect(read.get('001.mp3')).toEqual({ title: 'Neu', artist: 'Eva', album: 'Lieder', track: '1' });
    expect(read.get('002.mp3')).toEqual({});
    expect((await readTags(await dir.source('001.mp3'))).layout.id3v1).toBeUndefined();
  });

  it('goes on after a file that fails, and stops when the card says no', async () => {
    const root = memDir({ '01': { '001.mp3': mp3(new Uint8Array(0)), '002.mp3': mp3(new Uint8Array(0)), '003.mp3': mp3(new Uint8Array(0)), '004.mp3': mp3(new Uint8Array(0)) } });
    const real = await root.dir('01');
    let calls = 0;
    const dir: Dir = Object.create(real, {
      write: {
        value: async (name: string, data: Uint8Array | Blob) => {
          calls++;
          if (name === '001.mp3') throw new Error('Kurz nicht erreichbar.');
          if (name === '003.mp3') throw Object.assign(new Error('Für die SD-Karte fehlen die Schreibrechte.'), { code: 'permission' });
          return real.write(name, data);
        },
      },
    });
    const changes = ['001.mp3', '002.mp3', '003.mp3', '004.mp3'].map((file) => ({ file, tags: { title: file } }));
    const progress: number[] = [];
    const r = await writeTagChanges(dir, changes, { onProgress: (done) => progress.push(done) });
    expect(r.written.map((w) => w.file)).toEqual(['002.mp3']);
    expect(r.failed.map((f) => f.file)).toEqual(['001.mp3', '003.mp3']);
    expect(r.skipped).toEqual(['004.mp3']);
    expect(calls).toBe(3);
    expect(progress).toEqual([1, 2]);
    // The files that failed are as they were.
    expect(await bytesOf(real, '001.mp3')).toEqual(AUDIO);
  });

  it('stops before the next file when asked', async () => {
    const root = memDir({ '01': { '001.mp3': mp3(new Uint8Array(0)), '002.mp3': mp3(new Uint8Array(0)) } });
    const dir = await root.dir('01');
    let stop = false;
    const r = await writeTagChanges(
      dir,
      [
        { file: '001.mp3', tags: { title: 'A' } },
        { file: '002.mp3', tags: { title: 'B' } },
      ],
      {
        stop: () => stop,
        onProgress: () => (stop = true),
      },
    );
    expect(r.written.map((w) => w.file)).toEqual(['001.mp3']);
    expect(r.skipped).toEqual(['002.mp3']);
  });

  it('reads only MP3s', async () => {
    const root = memDir({ '01': { '001.mp3': mp3(buildSmallId3({ title: 'A' })), '002.wav': 'RIFF' } });
    const read = await readFolderTags(await root.dir('01'), ['001.mp3', '002.wav']);
    expect([...read.keys()]).toEqual(['001.mp3']);
  });
});

describe('what a failed file is told', () => {
  const web = '003.mp3 schreiben: Die Datei ist gesperrt oder schreibgeschützt. Ist der Schreibschutzschalter der SD-Karte auf „Lock“?';
  const desktop = 'Die SD-Karte ist schreibgeschützt. Schiebe den kleinen Schalter an der Seite der Karte nach oben und stecke sie neu ein.';

  it('asks about the lock switch only when no file could be written', () => {
    expect(failedFileLine(web, false)).toBe(web);
    expect(failedFileLine(desktop, false)).toBe(desktop);
  });

  it('points at the file itself once others were written: the card takes writes then', () => {
    const one = failedFileLine(web, true);
    expect(one).not.toMatch(/Lock|Schalter/);
    expect(one).toMatch(/^003\.mp3 schreiben: Die Datei ist gesperrt oder schreibgeschützt\. Vielleicht hat ein anderes Programm sie gerade offen\./);
    expect(failedFileLine(desktop, true)).not.toMatch(/Schalter/);
    // The file is named in front of it already.
    expect(failedFileLine(web, true, '003.mp3')).toMatch(/^Die Datei ist gesperrt/);
    expect(failedFileLine(web, false, '003.mp3')).toMatch(/^Die Datei ist gesperrt oder schreibgeschützt\. Ist der Schreibschutzschalter/);
    // Other reasons stay as they are, the missing rights too (their button fixes them).
    const denied = 'Ich darf hier nichts ändern, denn deinem Benutzerkonto fehlen die Schreibrechte für die SD-Karte oder den Ordner.';
    expect(failedFileLine(denied, true)).toBe(denied);
    expect(failedFileLine('Die SD-Karte ist voll.', true)).toBe('Die SD-Karte ist voll.');
  });
});
