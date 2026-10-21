import { describe, expect, it, vi } from 'vitest';
import { search } from '../../src/core/sources/filter';
import { DownloadError } from '../../src/core/sources/download';
import type { IndexEntry } from '../../src/core/sources/types';
import {
  blockerText,
  canAddUnmatched,
  checkedLine,
  clockLabel,
  countLabel,
  creatorsLine,
  dayLabel,
  deliveryOf,
  loadsInPage,
  setOwnLoading,
  eachLabel,
  entryRightsBadge,
  hiddenText,
  hitsSummary,
  itemMeta,
  lengthLabel,
  listHeading,
  failedMessage,
  missingLine,
  missingName,
  opensFile,
  originLine,
  originsIntro,
  partWord,
  progressLine,
  rightsBox,
  saveHeading,
  saveSteps,
  seedOf,
  selectionLine,
  noneLabel,
  nothingToAddText,
  previewFailedText,
  unchangedNote,
  waitingText,
  whichQuestion,
  whichText,
} from '../../src/features/sources/labels';
import { trackOrigin } from '../../src/core/sources/origin';
import { loadSample } from './sample';

const entry = (id: string): IndexEntry => loadSample().entries.find((e) => e.id === id)!;

describe('labels', () => {
  it('rounds lengths to minutes', () => {
    expect(lengthLabel(3179)).toBe('53 Min.');
    expect(lengthLabel(10008)).toBe('2 Std. 47 Min.');
    expect(lengthLabel(3600)).toBe('1 Std.');
    expect(lengthLabel(49)).toBe('49 Sek.');
    expect(lengthLabel(undefined)).toBe('');
    expect(dayLabel('2026-10-04T06:05:39.000Z')).toBe('04.10.2026');
    expect(dayLabel('2017')).toBe('2017');
    expect(dayLabel(undefined)).toBe('');
  });

  it('says what a source holds', () => {
    expect(countLabel(entry('kakadu-kinderhoerspiel'), entry('kakadu-kinderhoerspiel').items)).toBe('3 Folgen');
    const album = entry('jamendo-139374-eckhardt');
    expect(countLabel(album, album.items)).toBe(`${album.items[0].files.length} Lieder · 13 Min.`);
    expect(countLabel(entry('global-storybooks-de'), entry('global-storybooks-de').items.slice(0, 1))).toBe('1 Geschichte');
    expect(countLabel(entry('ohrka'), entry('ohrka').items.slice(0, 1))).toBe('1 Titel');
    expect(countLabel(entry('ohrka'), entry('ohrka').items)).toBe('11 Titel');
    // ARD Sounds pages kept as links hold episodes.
    expect(countLabel({ type: 'link', editPolicy: 'unchanged' }, entry('ohrka').items.slice(0, 3))).toBe('3 Folgen');
  });

  it('describes items, results and the selection', () => {
    const kakadu = entry('kakadu-kinderhoerspiel');
    expect(itemMeta(kakadu, kakadu.items[0])).toBe('04.10.2026 · 53 Min. · 48,6 MB');
    const gsb = entry('global-storybooks-de');
    expect(itemMeta(gsb, gsb.items[0])).toBe('49 Sek. · 441 KB');
    expect(hitsSummary(search(loadSample(), {}))).toBe('62 Titel in 6 Quellen');
    expect(hitsSummary(search(loadSample(), { text: 'Mammut' }))).toBe('1 Titel in 1 Quelle');
    expect(selectionLine(3, 4000, 64 * 1024 * 1024)).toBe('3 ausgewählt · 1 Std. 7 Min. · 64 MB');
    expect(selectionLine(1, undefined, 0)).toBe('1 ausgewählt');
    expect(progressLine({ fileIndex: 1, files: 14, bytes: 13_000_000, totalBytes: 84_000_000 })).toBe('Lädt 2 von 14 · 12,4 MB von 80,1 MB');
    expect(progressLine({ fileIndex: 0, files: 1, bytes: 2048 })).toBe('Lädt · 2 KB');
  });

  it('names lists, cards and what is missing by the kind of source', () => {
    expect(listHeading(entry('radio-klops'))).toBe('Folgen');
    expect(listHeading(entry('global-storybooks-de'))).toBe('Geschichten');
    expect(listHeading(entry('jamendo-139374-eckhardt'))).toBe('Lieder');
    expect(listHeading(entry('ohrka'))).toBe('Titel');
    // ARD pages kept as links: the card says "21 Folgen", so does the page.
    const ard = { ...entry('ohrka'), editPolicy: 'unchanged' as const };
    expect(listHeading(ard)).toBe('Folgen');
    expect(hiddenText(ard, 18, 3)).toBe('18 weitere Folgen passen nicht zu deiner Auswahl von Art und Alter.');
    expect(eachLabel(entry('radio-klops'))).toBe('Eine Karte je Folge');
    expect(eachLabel(entry('global-storybooks-de'))).toBe('Eine Karte je Geschichte');
    expect(eachLabel(entry('jamendo-139374-eckhardt'))).toBe('Eine Karte je Lied');
    expect(missingLine(2, 4, entry('jamendo-139374-eckhardt'))).toBe('2 von 4 Liedern ließen sich nicht laden.');
    expect(missingLine(1, 3, entry('radio-klops'))).toBe('1 von 3 Folgen ließ sich nicht laden.');
    expect(missingLine(1, 1, entry('radio-klops'))).toBe('1 von 1 Folge ließ sich nicht laden.');
    const album = entry('jamendo-139374-eckhardt');
    expect(missingName(album, album.items[0], { track: 2, title: 'Weisst Du wieviel Sternlein stehen' })).toBe('2. Weisst Du wieviel Sternlein stehen');
    expect(missingName(entry('radio-klops'), entry('radio-klops').items[0], { title: entry('radio-klops').items[0].title })).toBe(entry('radio-klops').items[0].title);
    // A song without a number goes by its own name: the album's stands above it already.
    expect(missingName(album, album.items[0], { title: 'Weisst Du wieviel Sternlein stehen' })).toBe('Weisst Du wieviel Sternlein stehen');
  });

  it('says which songs are still missing, without repeating the album', () => {
    const book = { ...entry('jamendo-139374-eckhardt') };
    const item = { ...book.items[0], title: 'Kleine ganz groß' };
    const pick = (title: string, error?: DownloadError) => ({ pick: { item, file: { url: `https://x/${title}.mp3`, name: `${title}.mp3`, title } }, error });
    // The one that failed was added by hand: the one left is named.
    expect(failedMessage(book, [pick('Die Nachtfee')], 5)).toBe('„Die Nachtfee“ fehlt noch. Tippe auf „Fehlende erneut laden“ oder füge die Datei selbst hinzu.');
    expect(failedMessage(book, [pick('A'), pick('B')], 5)).toBe('Es fehlen noch „A“ und „B“. Tippe auf „Fehlende erneut laden“ oder füge die Dateien selbst hinzu.');
    // All missing: the reason only, the line above says how many.
    const all = failedMessage(book, [pick('A', new DownloadError('incomplete', '')), pick('B'), pick('C')], 3);
    expect(all).toBe('Die Datei kam nicht vollständig an. Versuche es noch einmal.');
    // Some missing: which ones, once each, without the album's title.
    const some = failedMessage(book, [pick('A', new DownloadError('incomplete', '')), pick('B')], 10);
    expect(some).toBe('Die Datei kam nicht vollständig an. Versuche es noch einmal. Es fehlen noch „A“ und „B“.');
    expect(some).not.toContain('Kleine ganz groß');
    // One missing and the reason names it already.
    expect(failedMessage(book, [pick('A', new DownloadError('gone', ''))], 10)).toBe('„A“ ist beim Anbieter nicht mehr online.');
    expect(failedMessage(book, [pick('A', new DownloadError('busy', ''))], 10)).toMatch(/noch einmal\. Es fehlt noch „A“\.$/);
    expect(failedMessage(book, ['A', 'B', 'C', 'D', 'E'].map((x) => pick(x)), 9)).toBe('Es fehlen noch „A“, „B“, „C“ und 2 weitere. Tippe auf „Fehlende erneut laden“ oder füge die Dateien selbst hinzu.');
  });

  it('shows the player clock and stable cover colours', () => {
    expect(clockLabel(42.7)).toBe('0:42');
    expect(clockLabel(3180)).toBe('53:00');
    expect(clockLabel(3723)).toBe('1:02:03');
    expect(clockLabel(undefined)).toBe('0:00');
    expect(clockLabel(Number.NaN)).toBe('0:00');
    expect(seedOf('radio-klops')).toBe(seedOf('radio-klops'));
    expect(seedOf('radio-klops')).not.toBe(seedOf('global-storybooks-de'));
    expect(seedOf('x'.repeat(500))).toBeGreaterThanOrEqual(0);
  });

  it('names the people behind a story or a song', () => {
    expect(creatorsLine(entry('global-storybooks-de').items[0].creators)).toBe('Von Cornelius Gulere · übersetzt von Lisa Birkner · gelesen von Jula Eberth');
    expect(creatorsLine(entry('ohrka').items[0].creators)).toBe('Gelesen von Katharina Thalbach');
    expect(creatorsLine([{ name: 'Gerdt von Bassewitz', role: 'author' }, { name: 'Franziska Nelson', role: 'reader' }])).toBe('Von Gerdt von Bassewitz · gelesen von Franziska Nelson');
    expect(creatorsLine(entry('jamendo-139374-eckhardt').items[0].creators)).toBe('Gesungen von Stefan Eckhardt');
    expect(
      creatorsLine([
        { name: 'A', role: 'reader' },
        { name: 'B', role: 'reader' },
        { name: 'C', role: 'reader' },
      ]),
    ).toBe('Gelesen von A, B und C');
    expect(creatorsLine(undefined)).toBe('');
    expect(creatorsLine([{ name: 'Anna Westpfahl', role: 'translator' }, { name: 'Jula Eberth', role: 'reader' }], 'Volksmärchen aus Ghana')).toBe(
      'Volksmärchen aus Ghana · übersetzt von Anna Westpfahl · gelesen von Jula Eberth',
    );
  });

  it('describes the rights of a source, also when every story has its own licence', () => {
    const srf = rightsBox(entry('srf-kids-hoerspiele'));
    expect(srf.perItem).toBe(false);
    expect(srf.sentence).toBe('Podcast von SRG SSR. Du darfst die Folgen für eure Familie speichern. Gib die Dateien nicht weiter und spiele sie nicht öffentlich ab, zum Beispiel in der Kita.');
    expect(srf.links).toEqual([{ label: 'Nutzungsbedingungen von SRG SSR', href: 'https://www.srgssr.ch/de/nutzungsbedingungen' }]);

    const album = rightsBox(entry('jamendo-139374-eckhardt'));
    expect(album.sentence).toBe(
      'Freie Lizenz CC BY-SA 2.0 DE von Stefan Eckhardt. Wir speichern die Angaben zu Urheber und Lizenz mit auf der SD-Karte. Wenn du die Dateien weitergibst, gib die Angaben mit.',
    );
    expect(album.links).toEqual([{ label: 'Lizenztext CC BY-SA 2.0 DE', href: 'https://creativecommons.org/licenses/by-sa/2.0/de/' }]);

    const gsb = rightsBox(entry('global-storybooks-de'));
    expect(gsb.perItem).toBe(true);
    expect(gsb.sentence).toContain('Die Lizenz steht bei jeder Geschichte.');
    expect(gsb.sentence).toContain('nicht für kommerzielle Zwecke');
    expect(gsb.links.map((l) => l.label).sort()).toEqual(['Lizenztext CC BY 3.0', 'Lizenztext CC BY 4.0', 'Lizenztext CC BY-NC 3.0']);
    expect(entryRightsBadge(entry('global-storybooks-de'))).toBe('CC BY / BY-NC');
    expect(entryRightsBadge(entry('radio-klops'))).toBe('Podcast · nur privat');
  });

  it('tells how items get to the box', () => {
    const ohrka = entry('ohrka');
    expect(deliveryOf(ohrka, ohrka.items[0])).toBe('browser');
    expect(deliveryOf(entry('radio-klops'), entry('radio-klops').items[0])).toBe('direct');
    expect(deliveryOf({ delivery: 'direct' }, { files: [] })).toBe('browser');
    expect(deliveryOf({ delivery: 'direct' }, { files: [{ url: 'https://a.example/x.mp3', name: 'x.mp3' }], delivery: 'browser' })).toBe('browser');
  });

  it('loads OHRKA files in the desktop app itself, and plays them in preview without a CORS request', () => {
    const ohrka = entry('ohrka');
    const withFile = ohrka.items.find((it) => it.files.length)!;
    const withoutFile = { ...withFile, files: [] };
    try {
      setOwnLoading(() => true);
      expect(deliveryOf(ohrka, withFile)).toBe('direct');
      // No file address from the title page: the page stays the way.
      expect(deliveryOf(ohrka, withoutFile)).toBe('browser');
      // A file elsewhere than on OHRKA's own host is never loaded.
      expect(deliveryOf(ohrka, { ...withFile, files: [{ url: 'https://cdn.example/a.mp3', name: 'a.mp3' }] })).toBe('browser');
      // Other publishers without CORS stay with their page.
      expect(deliveryOf({ ...ohrka, rights: entry('radio-klops').rights }, withFile)).toBe('browser');
      expect(loadsInPage(ohrka, withFile)).toBe(false);
    } finally {
      setOwnLoading(() => false);
    }
    expect(deliveryOf(ohrka, withFile)).toBe('browser');
  });

  it('asks which title a file is that it does not know by name, and explains filtered items', () => {
    expect(whichQuestion(entry('radio-klops'))).toBe('Welche Folge ist das?');
    expect(whichQuestion(entry('global-storybooks-de'), 3)).toBe('Welche Geschichten sind das?');
    expect(whichQuestion(entry('ohrka'))).toBe('Welcher Titel ist das?');
    // ARD pages kept as links hold episodes as well.
    expect(whichQuestion({ type: 'link', editPolicy: 'unchanged' })).toBe('Welche Folge ist das?');
    expect(whichText(entry('global-storybooks-de'), { files: 1, known: 0, guessed: 0 })).toBe('Diese Datei erkennen wir nicht am Namen. Wähle aus, was es ist.');
    expect(whichText(entry('global-storybooks-de'), { files: 2, known: 1, guessed: 2 })).toBe(
      'Diese Dateien erkennen wir nicht am Namen. Wir haben nach Länge und Name vorausgewählt. Prüfe kurz, ob es stimmt. Die andere Datei haben wir erkannt.',
    );
    // One of three guessed: not "vorausgewählt" for all of them.
    expect(whichText(entry('global-storybooks-de'), { files: 3, known: 0, guessed: 1 })).toBe(
      'Diese Dateien erkennen wir nicht am Namen. Eine davon haben wir nach Länge und Name erkannt, bei den anderen wähle bitte aus.',
    );
    // One left to choose: "bei der anderen", not "bei den anderen".
    expect(whichText(entry('global-storybooks-de'), { files: 2, known: 0, guessed: 1 })).toBe(
      'Diese Dateien erkennen wir nicht am Namen. Eine davon haben wir nach Länge und Name erkannt, bei der anderen wähle bitte aus.',
    );
    expect(whichText(entry('global-storybooks-de'), { files: 5, known: 0, guessed: 4 })).toBe(
      'Diese Dateien erkennen wir nicht am Namen. 4 davon haben wir nach Länge und Name erkannt, bei der anderen wähle bitte aus.',
    );
    expect(noneLabel(entry('global-storybooks-de'))).toBe('Keine davon (ohne Angaben zur Herkunft hinzufügen)');
    const ohrka = entry('ohrka');
    expect(hiddenText(ohrka, 1, 4)).toBe('1 weiterer Titel passt nicht zu deiner Auswahl von Art und Alter.');
    expect(hiddenText(ohrka, 3, 4)).toBe('3 weitere Titel passen nicht zu deiner Auswahl von Art und Alter.');
    expect(hiddenText(ohrka, 3, 0)).toBe('Nichts davon passt zu deiner Auswahl von Art und Alter.');
    // Named like the list names them.
    expect(hiddenText(entry('radio-klops'), 1, 4)).toBe('1 weitere Folge passt nicht zu deiner Auswahl von Art und Alter.');
    expect(hiddenText(entry('global-storybooks-de'), 2, 4)).toBe('2 weitere Geschichten passen nicht zu deiner Auswahl von Art und Alter.');
    expect(hiddenText(entry('jamendo-139374-eckhardt'), 1, 1)).toBe('1 weiteres Album passt nicht zu deiner Auswahl von Art und Alter.');
  });

  it('adds no file without its title for a publisher that allows no changes, and says why', () => {
    const srf = entry('srf-kids-hoerspiele');
    expect(srf.editPolicy).toBe('unchanged');
    expect(canAddUnmatched(srf)).toBe(false);
    expect(canAddUnmatched(entry('global-storybooks-de'))).toBe(true);
    expect(whichText(srf, { files: 1, known: 0, guessed: 1 })).toBe(
      'Diese Datei erkennen wir nicht am Namen. Wir haben nach Länge und Name vorausgewählt. Prüfe kurz, ob es stimmt. SRG SSR erlaubt keine Änderungen. Darum kommt die Datei genau so auf die Karte, wie du sie gespeichert hast.',
    );
    expect(noneLabel(srf)).toBe('Keine davon (nicht hinzufügen)');
    expect(nothingToAddText(srf)).toBe('Ohne Zuordnung fügen wir nichts hinzu, weil SRG SSR keine Änderungen erlaubt.');
  });

  it('opens the file itself where a publisher only allows saving on its page', () => {
    const srf = entry('srf-kids-hoerspiele');
    expect(srf.items.every((it) => opensFile(srf, it))).toBe(true);
    expect(saveSteps(srf)).toEqual([
      'Klicke bei der Folge auf „Datei öffnen“. Sie öffnet sich in einem neuen Tab.',
      'Speichere die Datei dort auf deinem Computer.',
      'Ziehe die Datei hierher oder wähle sie aus.',
    ]);
    // OHRKA has the file of the titles whose page names it; for the others it is the publisher's page.
    const ohrka = entry('ohrka');
    expect(ohrka.items.filter((it) => opensFile(ohrka, it)).map((it) => it.title)).toEqual(['Alice im Wunderland, gelesen von Katharina Thalbach', 'Der Zauberer von Oz']);
    expect(saveSteps(ohrka)[0]).toBe('Klicke beim Titel auf „Datei öffnen“ oder „Auf der Webseite öffnen“.');
    // Link entries without files in the list: the publisher's page it is.
    const links = { ...ohrka, items: ohrka.items.map((it) => ({ ...it, files: [] })) };
    expect(saveSteps(links)[0]).toBe('Klicke beim Titel auf „Auf der Webseite öffnen“.');
    expect(saveSteps({ ...links, editPolicy: 'unchanged' })[0]).toBe('Klicke bei der Folge auf „Auf der Webseite öffnen“.');
    // Files the app loads itself, and whole albums, are never opened one by one.
    const gsb = entry('global-storybooks-de');
    expect(gsb.items.some((it) => opensFile(gsb, it))).toBe(false);
    const mixed: IndexEntry = { ...srf, items: [srf.items[0], { ...srf.items[1], files: [] }] };
    expect(saveSteps(mixed)[0]).toBe('Klicke bei der Folge auf „Datei öffnen“ oder „Auf der Webseite öffnen“.');
    // An album: its link is by the whole album (in the menu when the app loads it itself), not by a song.
    const album = entry('jamendo-139374-eckhardt');
    expect(saveSteps({ ...album, delivery: 'direct' })[0]).toBe('Klicke oben beim Album auf „…“ und dann auf „Auf der Webseite öffnen“.');
    expect(saveSteps({ ...album, delivery: 'browser', items: album.items.map((it) => ({ ...it, delivery: undefined })) })[0]).toBe('Klicke oben beim Album auf „Auf der Webseite öffnen“.');
    // The heading names what the source holds; albums only get here after a failed download.
    expect(saveHeading(srf)).toBe('So kommt die Folge auf die Box');
    expect(saveHeading(gsb)).toBe('So kommt die Geschichte auf die Box');
    expect(saveHeading(ohrka)).toBe('So kommt der Titel auf die Box');
    expect(saveHeading({ type: 'link', editPolicy: 'unchanged' })).toBe('So kommt die Folge auf die Box');
    expect(saveHeading(album)).toBe('Lieder von Hand hinzufügen');
    expect(partWord(entry('jamendo-139374-eckhardt'))).toBe('Lied');
    // "Reinhören" failed: names the item and the publisher, in the accusative.
    expect(previewFailedText('Lied', 'Internet Archive')).toBe('Reinhören klappt gerade nicht. Öffne das Lied auf der Webseite von Internet Archive.');
    expect(previewFailedText('Titel', 'OHRKA')).toBe('Reinhören klappt gerade nicht. Öffne den Titel auf der Webseite von OHRKA.');
  });

  it('dates the people\'s check and the list apart', () => {
    expect(checkedLine({ checkedAt: '2026-10-05T04:00:00.000Z', reviewedAt: '2026-09-28' })).toBe('Rechte und Inhalte zuletzt geprüft am 28.09.2026 · Liste aktualisiert am 05.10.2026');
    expect(checkedLine({ checkedAt: '2026-10-05T04:00:00.000Z' })).toBe('Liste aktualisiert am 05.10.2026');
    // No person has checked the sample's sources yet: only the list's date, never shown as a check.
    expect(checkedLine(entry('srf-kids-hoerspiele'))).toBe('Liste aktualisiert am 05.10.2026');
  });

  it('says where the origin details are on a folder page', () => {
    const tagged = { changes: ['loudness', 'tags'] };
    const unchanged = { changes: [] };
    expect(originsIntro([tagged])).toBe('Titel aus „Entdecken“, mit den Angaben, die auch in den Dateien stehen.');
    expect(originsIntro([unchanged])).toContain('darum stehen diese Angaben nur hier und in der Liste auf der SD-Karte');
    expect(originsIntro([tagged, unchanged])).toContain('außer bei Titeln, die unverändert auf die Karte kamen');
  });

  it('does not name "Entdecken" in a build without it, for a card filled in one with it', () => {
    vi.stubGlobal('__SOURCES_ENABLED__', false);
    try {
      expect(originsIntro([{ changes: ['tags'] }])).toBe('Kostenlose Titel aus dem Internet, mit den Angaben, die auch in den Dateien stehen.');
      expect(originsIntro([{ changes: [] }])).not.toContain('Entdecken');
      const srf = entry('srf-kids-hoerspiele');
      expect(originLine([trackOrigin(srf, srf.items[0], 0)])).toBe('Herkunft: Schweizer Radio und Fernsehen (SRF) · Podcast · nur privat');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('explains why adding waits', () => {
    expect(blockerText({ kind: 'result' })).toBe('Schaue dir zuerst das Ergebnis der Übertragung an.');
    expect(waitingText({ kind: 'result' })).toBe('Geladen. Schaue dir zuerst das Ergebnis der Übertragung an. Danach geht es von selbst weiter.');
    expect(blockerText({ kind: 'card' })).toBe('Stecke zuerst die SD-Karte ein.');
    // Paket mode: the card is read in, not plugged in.
    expect(blockerText({ kind: 'card' }, true)).toBe('Lies zuerst die SD-Karte ein.');
    expect(waitingText({ kind: 'card' }, true)).toBe('Die SD-Karte ist nicht mehr eingelesen. Lies sie wieder ein und klicke auf „Weiter“.');
    expect(blockerText({ kind: 'folder', folder: 5 })).toBe('Du fügst gerade Titel zu Ordner 05 hinzu. Schließe das zuerst ab oder verwirf die Auswahl.');
    expect(blockerText({ kind: 'writing' })).toBe('Gerade wird auf die SD-Karte geschrieben. Warte, bis das fertig ist.');
    expect(blockerText({ kind: 'reading' })).toBe('Gerade werden Dateien gelesen. Einen Moment.');
    expect(waitingText({ kind: 'card' })).toBe('Die SD-Karte ist nicht mehr da. Stecke sie wieder ein und klicke auf „Weiter“.');
    expect(waitingText({ kind: 'writing' })).toContain('Danach geht es von selbst weiter.');
    expect(blockerText({ kind: 'rest', folder: 5 })).toBe('Die letzte Übertragung ist nicht fertig. Übertrage zuerst den Rest oder verwirf ihn.');
    expect(waitingText({ kind: 'rest' })).toContain('danach geht es von selbst weiter.');
  });

  it('marks albums from "Entdecken" in the review step', () => {
    const srf = entry('srf-kids-hoerspiele');
    const gsb = entry('global-storybooks-de');
    const o = trackOrigin(srf, srf.items[0], 0);
    expect(originLine([o, trackOrigin(srf, srf.items[1], 0)])).toBe('Aus Entdecken: Schweizer Radio und Fernsehen (SRF) · Podcast · nur privat');
    expect(unchangedNote([o])).toBe('Bleibt unverändert: SRG SSR erlaubt keine Änderungen. Lautstärke und Länge bleiben, wie sie sind.');
    const stories = [trackOrigin(gsb, gsb.items[0], 0), trackOrigin(gsb, gsb.items[1], 0)];
    expect(originLine(stories)).toMatch(/^Aus Entdecken: Global Storybooks \/ African Storybook · CC BY/);
    expect(unchangedNote(stories)).toBeUndefined();
    expect(originLine([])).toBeUndefined();
  });
});
