import { describe, expect, it } from 'vitest';
import { markText, queryTerms, resultStatus, searchForMissing, searchHelp, type MarkedPart } from '../../src/features/help/search';

const ids = (query: string) => searchHelp(query).hits.map((h) => h.id);
const marked = (parts: MarkedPart[]) => parts.filter((p) => p.mark).map((p) => p.text);

describe('searchHelp', () => {
  it('finds a section however the umlaut is typed', () => {
    for (const q of ['Lautstärke', 'lautstaerke', 'Lautstarke', 'LAUTSTÄRKE']) {
      expect(ids(q)[0], q).toBe('lautstaerke');
    }
  });

  it('finds parts of words, at the start and in the middle', () => {
    expect(ids('lautst')).toContain('lautstaerke');
    expect(ids('stärke')).toContain('lautstaerke');
    expect(ids('staerke')).toContain('lautstaerke');
    expect(ids('etiket')).toContain('papier');
  });

  it('ß, hyphens and spaces do not get in the way', () => {
    for (const q of ['Größe', 'groesse', 'grosse']) expect(ids(q), q).toContain('drucken');
    for (const q of ['SD-Karte', 'sd karte', 'sdkarte']) expect(ids(q).length, q).toBeGreaterThan(0);
    expect(ids('3x3')).toContain('firmware');
  });

  it('needs every word, and ranks a title match first', () => {
    expect(ids('Firmware aufspielen')[0]).toBe('firmware');
    expect(ids('karte prüfen')).toContain('kartenleser');
    expect(ids('Kartenleser Linux')).toEqual(expect.arrayContaining(['kartenleser']));
    expect(ids('Kartenleser Linux')).not.toContain('lautstaerke');
  });

  it('finds the rules for folder names and other files in the box folders', () => {
    for (const q of ['Ordnername', 'ordner heißt', 'advent', 'Bilder im Ordner', 'andere Dateien', 'fremde Dateien']) {
      expect(ids(q), q).toContain('dateinamen');
    }
  });

  it('finds how to change the track infos in the files', () => {
    for (const q of ['Titel-Infos', 'ID3 Tags bearbeiten', 'Interpret', 'Genre']) expect(ids(q), q).toContain('dateinamen');
  });

  it('finds where music can come from: CDs, streaming and bought audiobooks', () => {
    for (const q of ['Spotify', 'Streaming', 'CD', 'Audible', 'Hörbuch kaufen', 'hoerbuch kaufen']) expect(ids(q)[0], q).toBe('cd-und-streaming');
  });

  it('finds the help when the app may not write to the card', () => {
    for (const q of ['schreiben', 'Rechte', 'Berechtigung', 'Schreibschutz', 'Ordner anlegen', 'Schreibrechte', 'darf nicht schreiben']) {
      expect(ids(q), q).toContain('sd-karte-schreibrechte');
    }
    expect(ids('Schreibrechte')[0]).toBe('sd-karte-schreibrechte');
    expect(ids('SD-Karte Berechtigung')[0]).toBe('sd-karte-schreibrechte');
  });

  it('finds the rare extras of the firmware builder: alarm start, speaker switch-off, MP3 chip', () => {
    for (const q of ['Wecker', 'Wecker-Start', 'SPKONOFF', 'Lautsprecher stumm', 'MP3-Chip', 'MP3-Player-Chip']) expect(ids(q)[0], q).toBe('firmware-extras');
  });

  it('finds the solder plan and the settings of the app', () => {
    for (const q of ['Lötplan', 'loetplan', 'verkabeln', 'Schaltplan']) expect(ids(q)[0], q).toBe('loetplan');
    for (const q of ['dunkel', 'Dunkelmodus', 'Darstellung', 'Pling', 'Töne']) expect(ids(q), q).toContain('app-einstellen');
    expect(ids('dunkel')[0]).toBe('app-einstellen');
  });

  it('finds topics by their title and summary', () => {
    expect(ids('Werkstatt')[0]).toBe('werkstatt');
    expect(ids('SD-Karte und Musik')[0]).toBe('musik');
    // "Sticker drucken" is a page now, in "Karten und Sticker".
    const hit = searchHelp('Sticker drucken').hits[0];
    expect(hit.id).toBe('sticker');
    expect(hit.topic.id).toBe('karten');
  });

  it('a topic word and a section word together lead to the section, or to the part of a page', () => {
    expect(ids('Karten Handy')[0]).toBe('handy');
    const hit = searchHelp('Karten Handy').hits[0];
    expect([hit.section?.id, hit.part?.id]).toEqual(['vier-wege', 'handy']);
  });

  it('on equal scores the topics come before their pages', () => {
    // "Karten und Sticker" and "SD-Karte und Musik" both have the word in their title.
    const hits = searchHelp('Karte').hits;
    expect(hits.slice(0, 2).map((h) => h.id).sort()).toEqual(['karten', 'musik']);
    expect(hits.slice(0, 2).every((h) => !h.section)).toBe(true);
    expect(hits[0].score).toBe(hits[2].score);
  });

  it('finds the parts of a page as places of their own, and the page without their texts', () => {
    expect(ids('F-Droid')[0]).toBe('handy');
    expect(ids('Cover Art Archive')[0]).toBe('cover-finden');
    expect(ids('Cover Art Archive')).not.toContain('cover');
    const part = searchHelp('pcscd').hits[0];
    expect(part.id).toBe('kartenleser');
    expect(part.section?.id).toBe('vier-wege');
  });

  it('finds the new pages by the words parents and the forum use', () => {
    const first: Record<string, string[]> = {
      wackelkontakt: ['Wackelkontakt', 'kalte Lötstelle', 'Lötstelle', 'nachlöten', 'Wackeltest'],
      powerbank: ['Powerbank schaltet ab', 'Powerbank geht in der Pause aus', 'Dauer-LED'],
      kratzig: ['kratzig', 'verzerrt', 'übersteuert', 'scheppert'],
      'nachbau-chip': ['MH2024K', 'GD3200B', 'nachgebaut'],
      'zu-laut-beim-start': ['zu laut beim Einschalten', 'fängt laut an'],
      geschenkt: ['geschenkt', 'gebraucht übernommen'],
      woerterbuch: ['Wörterbuch', 'Glossar', 'Begriffe'],
    };
    for (const [id, queries] of Object.entries(first)) for (const q of queries) expect(ids(q)[0], q).toBe(id);
    // The words themselves lead to the Wörterbuch too.
    expect(ids('Modifikationskarte')).toContain('spezialkarten');
    expect(ids('DFPlayer')).toEqual(expect.arrayContaining(['nachbau-chip', 'woerterbuch']));
  });

  it('searches the generated lists too: modes, special cards, papers and notices', () => {
    expect(ids('Teekesselchen')).toContain('wiedergabearten');
    expect(ids('Krabbelmodus')).toContain('spezialkarten');
    expect(ids('Labelident')).toContain('papier');
    expect(ids('jspdf')).toContain('bausteine');
    expect(ids('Fredoka')).toContain('bausteine');
  });

  it('leaves out question words, but still finds pages with most words', () => {
    expect(ids('Wie mache ich die Lautstärke gleich?')[0]).toBe('lautstaerke');
    const question = searchHelp('Gibt es einen Krabbelmodus?');
    expect(question.terms).toEqual(['Krabbelmodus']);
    expect(question.partial).toBe(false);
    expect(question.hits[0].id).toBe('spezialkarten');
    const partly = searchHelp('Lautstärke Zebrastreifen');
    expect(partly.partial).toBe(true);
    expect(partly.hits.map((h) => h.id)).toContain('lautstaerke');
  });

  it('a "nicht" in the question puts the pages about problems first', () => {
    expect(ids('Karte geht nicht').slice(0, 2)).toEqual(['karte-geht-nicht', 'sd-karte-geht-nicht']);
    expect(ids('SD-Karte geht nicht')[0]).toBe('sd-karte-geht-nicht');
    expect(ids('USB geht nicht')[0]).toBe('box-nicht-gefunden');
    expect(ids('Firefox geht nicht')[0]).toBe('browser-kann-das-nicht');
    // It only decides between equally good pages and finds nothing by itself.
    expect(ids('Handy geht nicht')[0]).toBe('handy');
    const withNot = searchHelp('Karte geht nicht', 1000);
    expect(withNot.terms).toEqual(['Karte']);
    expect(new Set(withNot.hits.map((h) => h.id))).toEqual(new Set(searchHelp('Karte', 1000).hits.map((h) => h.id)));
  });

  it('a phone or tablet finds the page that says the app needs a computer', () => {
    // "Bitte am Computer öffnen" and the start page on a phone link to this section.
    for (const q of ['iPad', 'iPhone', 'Smartphone', 'Tablet', 'Android', 'geht das auf dem iPad']) expect(ids(q)[0], q).toBe('browser');
    expect(ids('Handy').slice(0, 2)).toContain('browser');
  });

  it('ranks a word above the start of a longer word', () => {
    // "Ton" is the sound in "Am Ton ändert sich nichts" and "hohe Töne", not the start of "TonUINO".
    const ton = ids('Ton');
    // "Ton" alone is mostly asked by a family whose box is silent; that page leads.
    expect(ton[0]).toBe('box-bleibt-stumm');
    for (const id of ['dateinamen', 'dateiformate']) expect(ton.indexOf(id), id).toBeLessThan(ton.indexOf('ueber'));
    expect(ton).toContain('ueber');
    // Endings and the last part of a compound are the word as well: "Karten", "SD-Karte", "Systemansagen".
    const karte = searchHelp('Karte', 1000).hits;
    const best = karte.filter((h) => h.score === karte[0].score).map((h) => h.id);
    expect(best).toEqual(expect.arrayContaining(['karten', 'musik', 'karte-geht-nicht', 'sd-karte-geht-nicht']));
    expect(best).not.toContain('kartenleser');
    expect(ids('Ansagen')[0]).toBe('keine-ansagen');
    // The start of a word still finds it, behind the pages with the whole word.
    // "Kartenleser" is the reader in the box (audit 0.4 #14); the one at the computer is the NFC-Leser.
    expect(ids('Kartenl')[0]).toBe('kartenleser-testen');
    expect(ids('NFC-Les')[0]).toBe('kartenleser');
    expect(ids('Über')[0]).toBe('ueber');
  });

  it('a silent box leads to "Die Box bleibt stumm", however it is asked', () => {
    for (const q of [
      'kein Ton',
      'keinen Ton',
      'Die Box macht keinen Ton',
      'Unsere Box macht plötzlich keinen Ton mehr',
      'stumm',
      'Box bleibt stumm',
      'Box sagt nichts',
      'nichts zu hören',
      'nichts zu horen',
      'man hört nichts',
      'keine Musik',
      'Box spielt nicht',
      'Box ist still',
      'Lautsprecher',
      'ohne Ton',
      'Box spielt ohne Ton',
      'Ton weg',
      'Ton ist weg',
      'kein Sound',
      'Box startet nicht',
      'Box geht nicht mehr an',
    ]) {
      expect(ids(q)[0], q).toBe('box-bleibt-stumm');
    }
    // A power bank that switches off has its own page now; the silent box is right behind it.
    expect(ids('Powerbank').slice(0, 2)).toEqual(['powerbank', 'box-bleibt-stumm']);
    // A box that sleeps and does not wake up has its own page; the silent box links to it.
    expect(ids('Box schläft')[0]).toBe('box-geht-aus');
    // The page about the announcements follows.
    expect(ids('Box sagt nichts').slice(0, 2)).toEqual(['box-bleibt-stumm', 'keine-ansagen']);
    expect(ids('stumm').slice(0, 2)).toEqual(['box-bleibt-stumm', 'keine-ansagen']);
    // A box that does not speak is first about the announcements.
    expect(ids('Box spricht nicht').slice(0, 2)).toEqual(['keine-ansagen', 'box-bleibt-stumm']);
    // A box that does not start: the silent box first, its logbook next.
    expect(ids('Box startet nicht').slice(0, 2)).toEqual(['box-bleibt-stumm', 'logbuch']);
    // The snippet shows the sound, not "TonUINO".
    const snippet = searchHelp('kein Ton').hits[0].snippet;
    expect(marked(snippet)).toEqual(['Ton']);
    expect(snippet.map((p) => p.text).join('')).toContain('Kein Ton');
  });

  it('next to other words, a short word counts only where it stands as a word', () => {
    // "Ton" only in "TonUINO" and "ohne" in "ohne Gewähr" do not make the licence a page about sound.
    expect(ids('ohne Ton')).not.toContain('lizenz');
    // "aus" in "Bausteine" is no "aus", and "Ton" in "TonUINO" is no sound.
    expect(ids('Ton aus')).not.toContain('bausteine');
    expect(ids('Ton aus')[0]).toBe('box-bleibt-stumm');
    // Nothing that does not count is marked.
    expect(marked(markText('Über TonUINO Studio', 'Ton Studio'))).toEqual(['Studio']);
    // Alone, a short word still finds the start of a longer one.
    expect(marked(markText('Über TonUINO Studio', 'Ton'))).toEqual(['Ton']);
    // Short words that stand as words still count: "SD" in "SD-Karte", "mp3" in "001.mp3".
    expect(ids('SD Karte formatieren')).toContain('sd-karte-geht-nicht');
    expect(ids('mp3 Ordner')).toContain('keine-ansagen');
    // A missing start tone (mp3/0262, forum 12980): the first card plays, then the box stops.
    for (const q of ['0262', 'reagiert nach der ersten Karte nicht', 'leere Ansage']) expect(ids(q)[0], q).toBe('keine-ansagen');
    // "Piepton" also means a beeping noise from the speaker (Störgeräusche): both pages come first.
    expect(ids('Piepton').slice(0, 2)).toEqual(expect.arrayContaining(['keine-ansagen', 'stoergeraeusche']));
    expect(ids('Fehler 6')).toContain('keine-ansagen');
  });

  it('the query as typed in a title or keyword comes first', () => {
    // "Box spielt" stands in the title "Die Box spielt falsche Titel …", the whole question in a keyword of the silent box.
    expect(ids('Box spielt nicht')[0]).toBe('box-bleibt-stumm');
    expect(ids('Box spielt falsche Titel')[0]).toBe('falsche-titel');
    // Without the small words, the words in a row count as well.
    expect(ids('Wie kann ich die Firmware aufspielen?')[0]).toBe('firmware');
  });

  it('leads each problem, as people describe it, to its own page', () => {
    const expected: Record<string, string[]> = {
      kartentypen: ['125 khz', '125 kHz', 'lego', 'metall', 'glaskapsel'],
      'karte-geht-nicht': ['keine reaktion'],
      'sd-karte-herausnehmen': ['usb sd-karte herausnehmen'],
      'box-spielt-nicht-richtig': ['spielt nur den ersten titel', 'leiert'],
      aussetzer: ['aussetzer', 'hält an', 'ton aber keine musik'],
      'box-geht-aus': ['geht aus', 'reagiert nicht'],
      tasten: ['tasten vertauscht'],
      stoergeraeusche: ['knackt', 'tackern'],
      kopfhoerer: ['kopfhörer zu laut'],
      'anlernen-klappt-nicht': ['abgebrochen', 'pin vergessen', 'auth failed'],
      'was-die-karte-speichert': ['zweite box', 'fortschritt'],
      firmware: ['stk500_getsync', '3020', 'receivedata timeout'],
      spezialkarten: ['schlummer'],
    };
    // Words families use for the same faults.
    const everyday: Record<string, string[]> = {
      kartentypen: ['125khz', 'ultralight c'],
      'sd-karte-herausnehmen': ['wie komme ich an die sd karte', 'box aufschrauben', 'sd karte wechseln', 'sd-karte rausnehmen'],
      'box-spielt-nicht-richtig': ['box bleibt hängen'],
      'zu-laut-beim-start': ['plötzlich sehr laut', 'fängt laut an', 'zu laut beim einschalten'],
      aussetzer: ['stottert', 'stottern', 'ruckelt', 'hakt', 'unterbricht'],
      'box-geht-aus': ['box geht einfach aus', 'schaltet sich aus', 'box geht nach kurzer zeit aus', 'geht von alleine an'],
      tasten: ['tasten funktionieren nicht', 'tasten gehen nicht'],
      stoergeraeusche: ['knistert', 'knistern', 'knackgeräusche', 'summt'],
      kopfhoerer: ['kopfhörer leiser', 'kopfhörer lautstärke'],
      'anlernen-klappt-nicht': ['reset', 'zurücksetzen', 'werkseinstellungen', 'einstellungen löschen'],
    };
    for (const [id, queries] of [...Object.entries(expected), ...Object.entries(everyday)]) {
      for (const q of queries) expect(ids(q)[0], q).toBe(id);
    }
  });

  it('finds the parts test by the words of people who just soldered', () => {
    for (const q of ['Taste testen', 'Tastentest', 'Tasten und Teile testen']) expect(ids(q)[0], q).toBe('tasten-testen');
    // A solder joint has its own page now, which leads to the test.
    expect(ids('Lötstelle')[0]).toBe('wackelkontakt');
  });

  it('finds the settings of the box by the words parents use', () => {
    for (const q of ['standby', 'Kindersicherung', 'Ausschalt-Timer', 'ausschalttimer', 'Lautstärke begrenzen', 'Kurzwahl']) {
      expect(ids(q)[0], q).toBe('box-einstellen');
    }
    // Everyday words for the same settings.
    for (const q of ['Box Einstellungen', 'Einstellungen ändern', 'Tastenbelegung', 'Startlautstärke', 'Equalizer', 'Schlaftimer']) {
      expect(ids(q)[0], q).toBe('box-einstellen');
    }
    // "Einstellungen" alone is also the reset that deletes them (anlernen-klappt-nicht).
    expect(ids('Einstellungen').slice(0, 2)).toContain('box-einstellen');
    // Swapped buttons are mostly the button board turned round; that page explains the setting and links here.
    for (const q of ['Tasten vertauscht', 'Tasten umdrehen', 'Tasten falsch herum']) expect(ids(q)[0], q).toBe('tasten');
    // Both ways of switching off are one page now.
    for (const q of ['geht nicht aus', 'Die Box geht nicht aus', 'Box schaltet sich nicht aus', 'schaltet nicht ab']) expect(ids(q)[0], q).toBe('box-geht-aus');
    // The loudness of albums keeps its place.
    expect(ids('Lautstärke')[0]).toBe('lautstaerke');
  });

  it('finds where to ask questions', () => {
    // "Kontakt" is also the end of "Wackelkontakt"; the page about the project is right there.
    expect(ids('Kontakt').slice(0, 2)).toContain('ueber');
    expect(ids('Support')[0]).toBe('ueber');
  });

  it('finds nothing for unknown words, empty or one-letter queries', () => {
    expect(searchHelp('xylophonzebra').hits).toEqual([]);
    expect(searchHelp('').hits).toEqual([]);
    expect(searchHelp('   ').terms).toEqual([]);
    expect(searchHelp('a').hits).toEqual([]);
  });

  it('a single umlaut or ß is one letter too, although it is also searched as "ue" or "ss"', () => {
    for (const q of ['Ü', 'ü', 'ä', 'Ä', 'ö', 'Ö', 'ß', ' Ü ']) {
      const r = searchHelp(q);
      expect(r.hits, q).toEqual([]);
      expect(resultStatus(r), q).toBe('');
    }
    // The second letter starts the search: "Üb" finds "Über TonUINO Studio".
    expect(ids('Üb')).toContain('ueber');
  });

  it('marks the found words in the title and in a short snippet', () => {
    const hit = searchHelp('lautstarke').hits[0];
    expect(marked(hit.title)).toEqual(['Lautstärke']);
    expect(hit.title.map((p) => p.text).join('')).toBe('Gleiche Lautstärke für alle Alben');
    const snippet = searchHelp('Sprechpausen').hits.find((h) => h.id === 'lange-dateien')!.snippet;
    expect(marked(snippet)).toContain('Sprechpausen');
    expect(snippet.map((p) => p.text).join('').length).toBeLessThan(220);
  });

  it('hits are unique and point to real pages', () => {
    const hits = searchHelp('Karte').hits;
    expect(hits.length).toBeGreaterThan(5);
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });

  it('counts every match, also those the limit leaves out', () => {
    const all = searchHelp('Karte', 1000);
    const few = searchHelp('Karte', 5);
    expect(few.hits.map((h) => h.id)).toEqual(all.hits.slice(0, 5).map((h) => h.id));
    expect(few.total).toBe(all.hits.length);
    expect(all.total).toBe(all.hits.length);
  });
});

describe('resultStatus', () => {
  it('says how many pages match, and when only the best are shown', () => {
    expect(resultStatus(searchHelp(''))).toBe('');
    expect(resultStatus(searchHelp('xylophonzebra'))).toBe('Nichts gefunden.');
    const one = searchHelp('Teekesselchen');
    expect(resultStatus(one)).toBe(`${one.total} Treffer`);
    const total = searchHelp('Karte', 1000).total;
    expect(resultStatus(searchHelp('Karte', 5))).toBe(`${total} Treffer. Hier stehen die 5 besten.`);
    const partly = searchHelp('Lautstärke Zebrastreifen');
    expect(resultStatus(partly)).toBe(`Keine Seite enthält alle Wörter. ${partly.total} Treffer passen zum Teil.`);
  });
});

describe('searchForMissing', () => {
  it('searches for the words of an unknown id when a page is about them', () => {
    expect(searchForMissing('lautstaerke-regeln')).toBe('lautstaerke regeln');
    expect(searchHelp('lautstaerke regeln').hits[0].id).toBe('lautstaerke');
    expect(searchForMissing('firmware_update')).toBe('firmware update');
    expect(searchForMissing('box-macht-keinen-ton')).toBe('box macht keinen ton');
  });

  it('starts with all topics when the words only turn up somewhere in a text, or nowhere', () => {
    // "vorhanden" stands in a few texts, but no page is about it.
    expect(searchHelp('nicht vorhanden').hits.length).toBeGreaterThan(0);
    expect(searchForMissing('nicht-vorhanden')).toBeUndefined();
    expect(searchForMissing('gibt-es-nicht')).toBeUndefined();
    expect(searchForMissing('xyz')).toBeUndefined();
    expect(searchForMissing('-')).toBeUndefined();
  });
});

describe('pages only about the Paket', () => {
  const top = (q: string, packageMode?: boolean) => searchHelp(q, 30, { packageMode }).hits.map((h) => h.id);

  it('do not push the long-standing answers aside in Chrome, Edge and the desktop app', () => {
    // The first hits as before the Paket pages came (6c092be).
    const before: Record<string, string> = {
      formatieren: 'sd-karte-geht-nicht',
      'karte formatieren': 'sd-karte-geht-nicht',
      fat32: 'sd-karte-geht-nicht',
      // "neu" finds "Die Karte komplett neu aufbauen" first since it is no Paket page any more.
      'neue sd-karte': 'neue-sd-karte',
      download: 'cd-und-streaming',
      prüfen: 'kartenleser',
      'karte prüfen': 'kartenleser',
      terminal: 'box-nicht-gefunden',
    };
    for (const [q, id] of Object.entries(before)) {
      expect(top(q)[0], q).toBe(id);
      expect(top(q, false)[0], q).toBe(id);
    }
    expect(top('herunterladen')[0]).not.toBe('paket');
    // Still there, last: a Paket from somebody else can come to anyone.
    expect(top('entpacken')).toEqual(['paket']);
    // Rebuilding the card is no Paket page any more: it comes right after the page on formatting.
    expect(top('formatieren').slice(0, 2)).toEqual(['sd-karte-geht-nicht', 'karte-neu-aufbauen']);
    // "Sicherung" is the card's backup first (it has its own flow now), the box's settings right after.
    expect(top('sicherung').slice(0, 2)).toEqual(['karte-neu-aufbauen', 'box-einstellen']);
  });

  it('find the backup, the way back and the move to a new card with the words parents use', () => {
    for (const q of ['wiederherstellen', 'sd-karte sichern', 'sd karte tauschen', 'umziehen', 'zurückspielen']) expect(top(q)[0], q).toBe('karte-neu-aufbauen');
    // "Karte" alone is the card on the box: those answers stay first.
    expect(top('neue karte anlernen')[0]).not.toBe('karte-neu-aufbauen');
  });

  it('come first in Firefox and Safari, where they apply', () => {
    expect(top('formatieren', true).slice(0, 2)).toEqual(['sd-karte-geht-nicht', 'karte-neu-aufbauen']);
    expect(top('neu aufbauen', true)[0]).toBe('karte-neu-aufbauen');
    expect(top('zip', true)[0]).toBe('paket');
    expect(top('karte prüfen', true)[0]).toBe('paket');
  });
});

describe('queryTerms', () => {
  it('drops punctuation around words and doubled words', () => {
    expect(queryTerms('„Lautstärke“, lautstärke?').map((t) => t.raw)).toEqual(['Lautstärke']);
  });

  it('keeps question words when nothing else is left', () => {
    expect(queryTerms('wie').map((t) => t.raw)).toEqual(['wie']);
    expect(queryTerms('wie die Karte').map((t) => t.raw)).toEqual(['Karte']);
  });
});

describe('markText', () => {
  it('marks every place, whatever the spelling of the query', () => {
    expect(markText('Größe und Grösse', 'groesse')).toEqual([
      { text: 'Größe', mark: true },
      { text: ' und ', mark: false },
      { text: 'Grösse', mark: true },
    ]);
    expect(marked(markText('Die Lautstärke der Box', 'Lautstarke'))).toEqual(['Lautstärke']);
  });
});

describe('the extras of the settings page', () => {
  it('each can be found by its name and by what people call it', () => {
    expect(ids('Titel zusammenfügen')[0]).toBe('titel-zusammenfuegen');
    expect(ids('Kapitel verbinden')).toContain('titel-zusammenfuegen');
    expect(ids('Anfang abschneiden')[0]).toBe('anfang-abschneiden');
    expect(ids('Intro')).toContain('anfang-abschneiden');
    expect(ids('Mono')[0]).toBe('mono-speichern');
    expect(ids('Zusatzfunktionen')[0]).toBe('zusatzfunktionen');
  });

  it('finds spoken titles and recording by what parents look for', () => {
    expect(ids('Titelansagen')[0]).toBe('titelansagen');
    for (const q of ['Ansage vor jedem Titel', 'kann nicht lesen', 'Sprachausgabe', 'espeak', 'Titel ansagen']) expect(ids(q), q).toContain('titelansagen');
    expect(ids('Selbst aufnehmen')[0]).toBe('selbst-aufnehmen');
    for (const q of ['Mikrofon', 'Oma liest vor', 'eigene Stimme', 'Aufnahme']) expect(ids(q), q).toContain('selbst-aufnehmen');
  });
});

describe('the planner and sticker backs of the settings page', () => {
  it('each can be found by its name and by what people call it', () => {
    expect(ids('Mehr als 99 Hörspiele')[0]).toBe('mehr-als-99');
    expect(ids('Ordner voll')).toContain('mehr-als-99');
    expect(ids('mehrere Hörspiele in einem Ordner')[0]).toBe('mehr-als-99');
    expect(ids('von-bis')).toContain('mehr-als-99');
    expect(ids('Sticker Rückseite')[0]).toBe('sticker-rueckseite');
    expect(ids('beidseitig drucken')).toContain('sticker-rueckseite');
    expect(ids('Titelliste')).toContain('sticker-rueckseite');
  });
});

describe('figures instead of cards', () => {
  it('finds the page by the words of people who want a figure to start the box', () => {
    for (const q of ['Figur', 'Figuren', 'Sticker unter Figur', 'Figuren statt Karten', 'Sockel', 'Metall Figur']) {
      expect(ids(q)[0], q).toBe('figuren');
    }
    // "Holzfiguren" also heads the part on what figures are made of; both come first.
    expect(ids('Holzfigur').slice(0, 2)).toEqual(expect.arrayContaining(['figuren', 'figur-arten']));
    // The parts of the page for what people build from.
    for (const q of ['Schleich', 'Playmobil', '3D-Druck', 'Tonies', 'Tonie Figur']) expect(ids(q)[0], q).toBe('figur-arten');
    for (const q of ['Magnet', 'Figur Feder', 'Wackelfigur']) expect(ids(q)[0], q).toBe('figur-metall');
    expect(ids('NTAG213')[0]).toBe('figur-sticker');
    expect(ids('Mulde')[0]).toBe('figur-deckel');
    // Which cards to buy keeps its words; the figure page comes right after.
    for (const q of ['metall', 'glaskapsel']) expect(ids(q)[0], q).toBe('kartentypen');
    expect(ids('NFC-Sticker kaufen')[0]).toBe('kartentypen');
  });
});

describe('installing the app', () => {
  it('finds what stops the app before it runs (TODO 0.3 #59, #60)', () => {
    for (const q of ['SmartScreen', 'Trotzdem ausführen', 'Virenscanner', 'WebView2', 'weißes Fenster']) expect(ids(q)[0], q).toBe('installieren');
    for (const q of ['AppImage', 'libfuse2']) expect(ids(q).slice(0, 2), q).toContain('linux-installieren');
    for (const q of ['Play Protect', 'unbekannte Apps']) expect(ids(q)[0], q).toBe('android-installieren');
  });
});
