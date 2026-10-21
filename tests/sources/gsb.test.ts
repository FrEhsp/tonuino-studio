import { describe, expect, it } from 'vitest';
import { GSB_HEAD_BYTES, gsbStoryPath, parseGsbCredit, parseGsbHead, traditionOf } from '../../src/core/sources/gsb';
import { fxBytes, fxJson } from './sample';

describe('Global Storybooks file heads', () => {
  it('reads title, reader, year, credit and the playing time from the first 16 KB', () => {
    const head = parseGsbHead(fxBytes('gitlab/gsb_de-0001_tall.mp3').subarray(0, GSB_HEAD_BYTES));
    expect(head).toEqual({
      title: 'Ein sehr großer Mann',
      reader: 'Jula Eberth',
      year: '2017',
      comment: { textBy: 'Cornelius Gulere', translatedBy: 'Lisa Birkner', language: 'German', level: '2', license: 'CC-BY' },
      durationSec: 49,
    });
    const second = parseGsbHead(fxBytes('gitlab/gsb_de-0002_animals.mp3'));
    expect(second.title).toBe('Sieh Dir die Tiere an!');
    expect(second.comment?.license).toBe('CC-BY-NC');
    expect(second.durationSec).toBe(28);
  });

  it('gives what it can when the head is cut short', () => {
    const head = parseGsbHead(fxBytes('gitlab/gsb_de-0001_tall.mp3').subarray(0, 4000));
    expect(head.durationSec).toBeUndefined();
    expect(parseGsbHead(new Uint8Array(100))).toEqual({});
  });

  it('parses the credit lines', () => {
    expect(parseGsbCredit('Text by: A, B\r\nTranslated by: C\nLicense: CC-BY-NC\n\nFrom Storybooks Canada')).toEqual({ textBy: 'A, B', translatedBy: 'C', license: 'CC-BY-NC' });
  });

  it('knows whole-story paths from page files and folders', () => {
    expect(gsbStoryPath('de/0001/de-0001_tall.mp3', 'de')).toEqual({ id: '0001', name: 'de-0001_tall.mp3' });
    expect(gsbStoryPath('de/0001/mp3/01.mp3', 'de')).toBeUndefined();
    expect(gsbStoryPath('de/0001', 'de')).toBeUndefined();
    expect(gsbStoryPath('en/0001/en-0001_tall.mp3', 'de')).toBeUndefined();
    const tree = fxJson<{ path: string; type: string }[]>('gitlab/gsb_tree_de_0002.json');
    expect(tree.filter((t) => t.type === 'blob').map((t) => gsbStoryPath(t.path, 'de')?.id)).toEqual(['0002']);
  });
});

describe('traditionOf', () => {
  it('turns "<people> folktale" into an origin in German and leaves people alone', () => {
    expect(traditionOf('Ghanaian folktale')).toBe('Volksmärchen aus Ghana');
    expect(traditionOf('Zulu folktale')).toBe('Volksmärchen der Zulu');
    expect(traditionOf('Southern African Folktale')).toBe('Volksmärchen aus dem südlichen Afrika');
    expect(traditionOf('Traditional')).toBe('Überliefert');
    expect(traditionOf('Kikuyu folk tale')).toBe('Volksmärchen der Kikuyu');
    expect(traditionOf('Lozi folktale')).toBe('Überliefert („Lozi folktale“)');
    expect(traditionOf('Cornelius Gulere')).toBeUndefined();
    expect(traditionOf(undefined)).toBeUndefined();
  });
});
