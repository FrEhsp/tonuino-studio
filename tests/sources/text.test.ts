import { describe, expect, it } from 'vitest';
import { cleanTitle, dropCounter, fileNameOf, holdReasons, normalizeSearch, parseAges, parseDuration, plainText, prefixWords, stripPrefix, withoutPhrases } from '../../src/core/sources/text';

describe('parseDuration', () => {
  it('reads mm:ss, h:mm:ss, seconds and decimal seconds', () => {
    expect(parseDuration('52:59')).toBe(3179);
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('2653')).toBe(2653);
    expect(parseDuration('530.74')).toBe(531);
    expect(parseDuration(2653)).toBe(2653);
  });

  it('gives nothing for empty, zero or unreadable values', () => {
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration(0)).toBeUndefined();
    expect(parseDuration('0:00')).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration(null)).toBeUndefined();
    expect(parseDuration('etwa eine Stunde')).toBeUndefined();
    expect(parseDuration('1:2:3:4')).toBeUndefined();
  });
});

describe('parseAges', () => {
  it('reads the usual publisher wordings', () => {
    expect(parseAges('(Ab 8 Jahren)')).toEqual({ min: 8 });
    expect(parseAges('Für Kinder zwischen 4 und 8 Jahren')).toEqual({ min: 4, max: 8 });
    expect(parseAges('4-8 Jahre')).toEqual({ min: 4, max: 8 });
    expect(parseAges('Tolle Hörspiele für Kinder ab 8 bis 12 Jahren')).toEqual({ min: 8, max: 12 });
    expect(parseAges('Geeignet für Kinder ab 8 Jahre')).toEqual({ min: 8 });
  });

  it('ignores times, prices, dates and other numbers', () => {
    expect(parseAges('ab 10 Uhr im Radio')).toBeUndefined();
    expect(parseAges('ab 5 Minuten')).toBeUndefined();
    expect(parseAges('ab 20 Euro')).toBeUndefined();
    expect(parseAges('Folge 12')).toBeUndefined();
    expect(parseAges('Neue Folgen ab 16. Oktober')).toBeUndefined();
    expect(parseAges('ab 16.10. online')).toBeUndefined();
    expect(parseAges('ab 12:30 im Programm')).toBeUndefined();
    expect(parseAges('1+1 macht 2, Teil 2 + 3')).toBeUndefined();
    expect(parseAges(undefined)).toBeUndefined();
  });

  it('reads age marks, recommendations and adult wordings', () => {
    expect(parseAges('Wer hat Angst? (16+)')).toEqual({ min: 16 });
    expect(parseAges('18+')).toEqual({ min: 18 });
    expect(parseAges('Party Ü18')).toEqual({ min: 18 });
    expect(parseAges('FSK 16')).toEqual({ min: 16 });
    expect(parseAges('USK 18')).toEqual({ min: 18 });
    expect(parseAges('Altersempfehlung: 14 Jahre')).toEqual({ min: 14 });
    expect(parseAges('für 8- bis 12-Jährige')).toEqual({ min: 8, max: 12 });
    expect(parseAges('nicht für Kinder unter 10')).toEqual({ min: 10 });
    expect(parseAges('Hörspiel für Erwachsene')).toEqual({ min: 18 });
    expect(parseAges('Nur für Erwachsene')).toEqual({ min: 18 });
    expect(parseAges('Ein Erwachsenenhörspiel')).toEqual({ min: 18 });
    // "for children and adults" says nothing about a minimum age.
    expect(parseAges('Für Kinder und Erwachsene')).toBeUndefined();
  });

  it('takes the highest of several statements', () => {
    expect(parseAges('Für Kinder ab 6 Jahren. Die Langfassung erst ab 16.')).toEqual({ min: 16 });
    expect(parseAges('Ab 8 Jahren. Für Kinder von 8 bis 12 Jahren.')).toEqual({ min: 8, max: 12 });
  });
});

describe('plainText', () => {
  it('strips tags and decodes entities, also twice encoded ones', () => {
    expect(plainText('<p>Eine G&auml;nsehaut-Geschichte,<br/> nicht f&#252;r Kinder</p>')).toBe('Eine Gänsehaut-Geschichte, nicht für Kinder');
    expect(plainText('&lt;p&gt;Ein Grusel &amp;uuml;ber G&amp;auml;nsehaut&lt;/p&gt;')).toBe('Ein Grusel über Gänsehaut');
    expect(plainText('Kakadu <3 & Freunde')).toBe('Kakadu <3 & Freunde');
    expect(plainText(undefined)).toBe('');
  });
});

describe('cleanTitle', () => {
  const pattern = '^(?:Kinderhörspiel(?: und Geschichten)?|Kakadu(?: Spezial)?)(?:\\s*-?\\s*Ursendung)?\\s*[-–:]\\s*(?:Ursendung\\s*[-–:]\\s*)?';
  it('removes the series pattern first, else the first prefix, never everything', () => {
    expect(cleanTitle('Kakadu - Ich bin ein echtes Sommerkind', { pattern })).toBe('Ich bin ein echtes Sommerkind');
    expect(cleanTitle('Kinderhörspiel Ursendung - Jetzt probier doch wenigstens mal', { pattern })).toBe('Jetzt probier doch wenigstens mal');
    expect(cleanTitle('Kinderhörspiel - Ursendung - Der Wald steht schwarz und schweiget', { pattern })).toBe('Der Wald steht schwarz und schweiget');
    expect(cleanTitle('Kinderhörspiel - ', { pattern })).toBe('Kinderhörspiel -');
    expect(cleanTitle('Märchen: Rotkäppchen', { prefixes: ['Märchen: '] })).toBe('Rotkäppchen');
    expect(prefixWords(['Kinderhörspiel - ', 'Kinderhörspiel und Geschichten - ', 'Kakadu - '])).toEqual(['kinderhörspiel', 'kakadu']);
  });

  it('leaves out the episode counter at the end only when asked', () => {
    expect(dropCounter('Die verschwundene Münze (1/26)')).toBe('Die verschwundene Münze');
    expect(dropCounter('Verzockt ( 5 / 26 ) ')).toBe('Verzockt');
    expect(dropCounter('Die Öl-Mafia (9/26)')).toBe('Die Öl-Mafia');
    // Only at the end, and never the whole title.
    expect(dropCounter('Mumins lange Reise (1/2): Wo ist Muminpapa?')).toBe('Mumins lange Reise (1/2): Wo ist Muminpapa?');
    expect(dropCounter('(3/26)')).toBe('(3/26)');
    expect(dropCounter('Folge 2026')).toBe('Folge 2026');
    expect(cleanTitle('Kinderhörspiel - Blackout (12/26)', { prefixes: ['Kinderhörspiel - '], counter: true })).toBe('Blackout');
    expect(cleanTitle('Blackout (12/26)', {})).toBe('Blackout (12/26)');
  });
});

describe('stripPrefix', () => {
  it('removes the first matching prefix, case-insensitively', () => {
    expect(stripPrefix('Kinderhörspiel - Das Mammut in der Grube', ['Kinderhörspiel - '])).toBe('Das Mammut in der Grube');
    expect(stripPrefix('kinderhörspiel - Das Mammut', ['Kinderhörspiel - '])).toBe('Das Mammut');
    expect(stripPrefix('Kinderhörspiel - ', ['Kinderhörspiel - '])).toBe('Kinderhörspiel -');
    expect(stripPrefix('Das Mammut', undefined)).toBe('Das Mammut');
  });
});

describe('normalizeSearch', () => {
  it('folds umlauts, ß, accents, case and punctuation', () => {
    expect(normalizeSearch('Märchen')).toBe('maerchen');
    expect(normalizeSearch('Straße')).toBe('strasse');
    expect(normalizeSearch('Peterchens  Mondfahrt!')).toBe('peterchens mondfahrt');
    expect(normalizeSearch('Märchen'.normalize('NFD'))).toBe('maerchen');
    expect(normalizeSearch('Café-Geschichten')).toBe('cafe geschichten');
  });
});

describe('holdReasons', () => {
  it('finds warning words', () => {
    expect(holdReasons('Der Gruselturm')).toEqual(['Grusel']);
    expect(holdReasons('Mit freundlicher Unterstützung unseres Sponsors')).toEqual(['Werbung']);
    expect(holdReasons('Ein Mord im Zoo')).toEqual(['Gewalt oder Tod']);
    expect(holdReasons('Achtung: nicht für Kinder geeignet')).toEqual(['Warnhinweis']);
  });

  it('finds them in other spellings and inside compound words', () => {
    const held = (t: string) => holdReasons(t).length > 0;
    for (const t of [
      'Der Mörder im Zug', 'Mörderische Ferien', 'Doppelmord', 'Raubmord', 'Vergewaltigung', 'Weltkrieg', 'Bürgerkrieg', 'Wasserleiche', 'Die Leiche im Keller',
      'Blutbad', 'getötet', 'erschossen', 'Amoklauf', 'Terroranschlag', 'Missbrauch', 'Entführung', 'Der Tod', 'Er stirbt', 'Waffen',
      'Zombie', 'Vampire', 'Dämonen', 'Drogenhandel', 'Drogensucht', 'Rauschgift', 'Kokain',
      'Anzeigen', 'Werbespot', 'Werbepause', 'unterstützt von', 'in Kooperation mit', 'Affiliate-Link', 'Werbung: Mit dem Rabattcode KIDS10',
      'Content Warning', 'CN: Tod', 'Für Erwachsene',
    ]) {
      expect(held(t), t).toBe(true);
    }
  });

  it('leaves ordinary episodes and look-alike words alone', () => {
    for (const t of [
      'Das Mammut in der Grube. Ein Hörspiel ab 7 Jahren über Freundschaft.', 'Folge 7: Der Sonnencreme-Roboter', 'Wir kriegen das hin!', 'Ein gewaltiger Sturm',
      'Waffeln backen', 'In der Drogerie', 'Ein Mordsspaß für alle', 'die gleiche Farbe', 'Vergleichen macht Spaß', 'Die Katze schleicht', 'Total lustig',
      'Der Totenkopf der Piraten', 'Das Meeresrauschen', 'Alkoholfreier Punsch', 'Malwettbewerbe', 'werbefrei', 'Für Kinder und Erwachsene',
      'Ein Spaß auch für Erwachsene', 'Die Wasserpistole', 'Die Feuerwehr', 'Der Kreisel', 'Die Nacktschnecke', 'Autodiebstahl',
    ]) {
      expect(holdReasons(t), t).toEqual([]);
    }
  });

  it('reads HTML show notes once they are plain text', () => {
    expect(holdReasons(plainText('<![CDATA[<p>Eine G&auml;nsehaut-Geschichte, nicht f&uuml;r Kinder</p>]]>'))).toEqual(['Grusel', 'Warnhinweis']);
    expect(holdReasons(plainText('Eine G&#228;nsehaut-Geschichte'))).toEqual(['Grusel']);
  });

  it('skips a show’s standing sentences, whatever their case and umlauts', () => {
    expect(holdReasons(withoutPhrases('Eine Geschichte. Bei uns gibt es keine Werbung.', ['bei uns gibt es keine werbung.']))).toEqual([]);
  });
});

describe('fileNameOf', () => {
  it('takes the decoded last path segment and ignores the query', () => {
    expect(fileNameOf('https://podcast-mp3.dradio.de/podcast/2026/10/04/a_b.mp3?refId=kinderhoerspiel-118')).toBe('a_b.mp3');
    expect(fileNameOf('https://archive.org/download/x/01%20Hansel.mp3')).toBe('01 Hansel.mp3');
    expect(fileNameOf('https://gitlab.com/api/v4/projects/1/repository/files/de%2F0001%2Fde-0001_tall.mp3/raw?ref=master')).toBe('raw');
    expect(fileNameOf('https://example.org/')).toBe('audio.mp3');
  });
});
