import { describe, expect, it } from 'vitest';
import { ccFromUrl, copyrightFrame, creditLine, rightsBadge, rightsSentence, rightsUrl } from '../../src/core/sources/licence';
import type { IndexEntry, IndexItem } from '../../src/core/sources/types';

describe('Creative Commons', () => {
  it('understands licence URLs', () => {
    expect(ccFromUrl('https://creativecommons.org/licenses/by/3.0/')).toEqual({ id: 'by', version: '3.0', port: undefined, url: 'https://creativecommons.org/licenses/by/3.0/' });
    expect(ccFromUrl('http://creativecommons.org/licenses/by-sa/2.0/de/')).toEqual({ id: 'by-sa', version: '2.0', port: 'de', url: 'http://creativecommons.org/licenses/by-sa/2.0/de/' });
    expect(ccFromUrl('https://creativecommons.org/licenses/by-nc-nd/4.0/deed.de')?.id).toBe('by-nc-nd');
    expect(ccFromUrl('https://creativecommons.org/publicdomain/zero/1.0/')?.id).toBe('cc0');
    expect(ccFromUrl('https://creativecommons.org/publicdomain/mark/1.0/')?.id).toBe('pdm');
  });

  it('refuses everything else', () => {
    expect(ccFromUrl('https://creativecommons.org/licenses/by-xx/3.0/')).toBeUndefined();
    expect(ccFromUrl('https://example.org/licenses/by/3.0/')).toBeUndefined();
    expect(ccFromUrl('ftp://creativecommons.org/licenses/by/3.0/')).toBeUndefined();
    expect(ccFromUrl('kein Link')).toBeUndefined();
    expect(ccFromUrl(undefined)).toBeUndefined();
  });

  it('writes badges and sentences', () => {
    expect(rightsBadge({ kind: 'cc', id: 'by-sa', version: '2.0', port: 'de', url: 'x' })).toBe('CC BY-SA 2.0 DE');
    expect(rightsBadge({ kind: 'podcast', holder: 'SRF' })).toBe('Podcast · nur privat');
    expect(rightsBadge({ kind: 'public-domain', basis: 'commons', latestDeath: 1923 })).toBe('Gemeinfrei');
    expect(rightsBadge({ kind: 'private-use', holder: 'OHRKA e.V.', termsUrl: 'https://www.ohrka.de/impressum' })).toBe('Nur privat');
    expect(rightsSentence({ kind: 'public-domain', basis: 'commons', latestDeath: 1923 }, 'Wikimedia Commons')).toContain('zuletzt 1923');
    expect(rightsSentence({ kind: 'cc', id: 'by-nc', version: '3.0', url: 'x' }, 'Global Storybooks')).toContain('Nicht für kommerzielle Zwecke.');
    expect(rightsUrl({ kind: 'private-use', holder: 'OHRKA e.V.', termsUrl: 'https://www.ohrka.de/impressum' })).toBe('https://www.ohrka.de/impressum');
  });
});

describe('credit line', () => {
  const entry: Pick<IndexEntry, 'title' | 'publisher' | 'pageUrl' | 'rights'> = {
    title: 'Stefan Eckhardt – Kleine ganz groß',
    publisher: 'Stefan Eckhardt (über Jamendo)',
    pageUrl: 'https://archive.org/details/jamendo-139374',
    rights: { kind: 'cc', id: 'by-sa', version: '2.0', port: 'de', url: 'http://creativecommons.org/licenses/by-sa/2.0/de/' },
  };
  const item: Pick<IndexItem, 'title' | 'creators' | 'pageUrl' | 'rights' | 'published'> = {
    title: 'Hänsel und Gretel',
    creators: [{ name: 'Stefan Eckhardt', role: 'performer' }],
  };

  it('names title, people, source, licence with an https link and the changes', () => {
    expect(creditLine(entry, item, ['converted', 'loudness'])).toBe(
      '„Hänsel und Gretel“. Stefan Eckhardt – Kleine ganz groß. Gesungen von Stefan Eckhardt. Quelle: Stefan Eckhardt (über Jamendo), https://archive.org/details/jamendo-139374. Lizenz: CC BY-SA 2.0 DE (https://creativecommons.org/licenses/by-sa/2.0/de/). Geändert: in MP3 umgewandelt, Lautstärke angeglichen.',
    );
  });

  it('groups several people with the same role', () => {
    const line = creditLine(
      { title: 'Global Storybooks', publisher: 'Global Storybooks / African Storybook', pageUrl: 'https://gitlab.com/global-asp/gsn-audio', rights: entry.rights },
      {
        title: 'Schulkleidung',
        creators: [
          { name: 'Clare Verbeek', role: 'author' },
          { name: 'Thembani Dladla', role: 'author' },
          { name: 'Zanele Buthelezi', role: 'author' },
          { name: 'Victor Pedrero', role: 'translator' },
          { name: 'Jula Eberth', role: 'reader' },
          { name: 'Jula Eberth', role: 'reader' },
        ],
      },
      [],
    );
    expect(line).toContain('. Text Clare Verbeek, Thembani Dladla und Zanele Buthelezi, Übersetzung Victor Pedrero, gelesen von Jula Eberth. Quelle:');
  });

  it('marks public-domain authors with their death year and podcasts as private', () => {
    const pd = creditLine(
      { title: 'Gesprochene Wikisource', publisher: 'Wikimedia Commons', pageUrl: 'https://commons.wikimedia.org/wiki/File:Rapunzel.ogg', rights: { kind: 'public-domain', basis: 'commons' } },
      { title: 'Rapunzel', creators: [{ name: 'Jacob Grimm', role: 'author', died: 1863 }, { name: 'Anna Beispiel', role: 'reader' }], rights: { kind: 'public-domain', basis: 'commons', latestDeath: 1863 } },
      [],
    );
    expect(pd).toBe('„Rapunzel“. Gesprochene Wikisource. Text Jacob Grimm (gest. 1863), gelesen von Anna Beispiel. Quelle: Wikimedia Commons, https://commons.wikimedia.org/wiki/File:Rapunzel.ogg. Gemeinfrei.');
    const pod = creditLine({ title: 'Kakadu', publisher: 'Deutschlandradio', pageUrl: 'https://www.deutschlandfunkkultur.de/kakadu', rights: { kind: 'podcast', holder: 'Deutschlandradio' } }, { title: 'Das Mammut' }, ['tags']);
    expect(pod).toBe('„Das Mammut“. Kakadu. Quelle: Deutschlandradio, https://www.deutschlandfunkkultur.de/kakadu. Podcast, nur privat. Geändert: Titelangaben ersetzt.');
  });

  it('writes TCOP with a year first', () => {
    expect(copyrightFrame(entry, { ...item, published: '2014' }, 2026)).toBe(
      '2014 Stefan Eckhardt (über Jamendo). Licensed to the public under https://creativecommons.org/licenses/by-sa/2.0/de/ verify at https://archive.org/details/jamendo-139374',
    );
    expect(copyrightFrame({ publisher: 'P', pageUrl: 'https://p.example', rights: { kind: 'podcast', holder: 'SRF' } }, { published: '2026-10-04T06:05:39.000Z' }, 2020)).toBe('2026 SRF');
    expect(copyrightFrame({ publisher: 'P', pageUrl: 'https://p.example', rights: { kind: 'public-domain', basis: 'commons' } }, {}, 2026)).toBeUndefined();
  });
});
