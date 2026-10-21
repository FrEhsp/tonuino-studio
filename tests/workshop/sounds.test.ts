import { describe, expect, it } from 'vitest';
import type { SdScan, SdSystemDir, SdTrack, SystemDirName } from '../../src/core/tonuino/sd';
import { TNG_SEPTEMBER_SOUNDS, TNG_SYSTEM_SOUNDS, checkSystemSounds } from '../../src/core/tonuino/systemsounds';
import { soundsOverviewNote, soundsSummary } from '../../src/features/workshop/sounds';

function dir(name: SystemDirName, numbers: number[]): SdSystemDir {
  const files = numbers.map((n, i) => ({ number: n, name: `${String(n).padStart(4, '0')}.mp3`, size: 1000, suffix: '', ext: 'mp3', order: i }) satisfies SdTrack);
  return { name, dirName: name, files, wrongDigits: [], others: [], junk: [], empty: [], totalBytes: files.length * 1000 };
}

function scan(system: SdScan['system']): SdScan {
  return { kind: 'tonuino', folders: [], system, rootJunk: [], rootOthers: [], invalidFolders: [], tempDirs: [], hasCatalog: false, hasCovers: false } as unknown as SdScan;
}

const full = () => scan({ mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3), advert: dir('advert', TNG_SYSTEM_SOUNDS.advert) });

describe('Systemansagen summary', () => {
  it('does not call the card of a box from 25.02.2026 old, and says what the newer release adds', () => {
    const tag = scan({
      mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => !TNG_SEPTEMBER_SOUNDS.mp3.includes(n))),
      advert: dir('advert', TNG_SYSTEM_SOUNDS.advert.filter((n) => !TNG_SEPTEMBER_SOUNDS.advert.includes(n))),
    });
    const unknown = soundsSummary(tag, 'tng');
    expect(unknown.state).toBe('ok');
    expect(unknown.title).toBe('Die Ansagen sind da');
    expect(unknown.text).toBe(
      'Die Box findet alle Ansagen, die TonUINO TNG bis zur Version vom 25.02.2026 braucht. Für die Endlos-Karte und die Frage nach dem letzten Ordner bei Hörbuch-Karten fehlen 4 Ansagen. Die braucht erst TonUINO TNG 3.3.3 vom 17.09.2026.',
    );
    // Under "Mehr", marked as on top of what is missing, not as a second count (audit 0.4 #19).
    expect(unknown.facts).toContainEqual({ label: 'Für TNG ab 17.09.2026 zusätzlich', value: '4 Ansagen fehlen' });
    expect(unknown.action).toBe('Ansagen erneuern');

    // The box said it runs the older release: nothing to say about them.
    const older = soundsSummary(tag, 'tng', undefined, { release: 'older', detected: true });
    expect(older.title).toBe('Alle Ansagen sind da');
    expect(older.text).toBe('Die Box findet alle Ansagen, die sie braucht.');
    expect(older.facts[0]).toEqual({ label: 'Firmware', value: 'TonUINO TNG vor 17.09.2026 (automatisch erkannt)' });
    expect(older.facts.map((f) => f.label)).not.toContain('Für TNG ab 17.09.2026 zusätzlich');

    // The newer release needs them: older than the firmware, as before.
    const newer = soundsSummary(tag, 'tng', undefined, { release: 'newer', detected: false });
    expect(newer.state).toBe('outdated');
    expect(newer.facts[0]).toEqual({ label: 'Firmware', value: 'TonUINO TNG ab 17.09.2026' });
    expect(newer.facts).toContainEqual({ label: 'Es fehlen', value: '4 Ansagen', tone: 'warn' });
    expect(soundsOverviewNote(checkSystemSounds(tag, 'tng', 'newer')).tone).toBe('warn');
    expect(soundsOverviewNote(checkSystemSounds(tag, 'tng')).tone).toBe('ok');
  });

  it('names the missing folders', () => {
    const s = soundsSummary(scan({ mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3) }), 'tng');
    expect(s.state).toBe('missing');
    expect(s.text).toMatch(/^Der Ordner advert fehlt\./);
    expect(s.facts).toContainEqual({ label: 'Ordner advert', value: 'fehlt', tone: 'error' });
    expect(soundsSummary(scan({}), 'tng').text).toMatch(/^Die Ordner mp3 und advert fehlen\./);
    expect(soundsSummary(scan({}), 'tng').action).toBe('Ansagen installieren');
  });

  it('tells old announcements from broken ones', () => {
    const old = scan({ mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => n !== 340)), advert: dir('advert', TNG_SYSTEM_SOUNDS.advert) });
    const s = soundsSummary(old, 'tng');
    expect(s.state).toBe('outdated');
    // One number in one sentence, and what the button does (audit 0.4 #19).
    expect(s.text).toBe('Es fehlt eine Ansage, die neuere Versionen von TonUINO TNG brauchen. Der Knopf unten spielt sie auf.');
    expect(s.facts).toContainEqual({ label: 'Es fehlen', value: '1 Ansage', tone: 'warn' });
    expect(s.action).toBe('Ansagen erneuern');

    const broken = scan({ mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => n !== 300)), advert: dir('advert', TNG_SYSTEM_SOUNDS.advert) });
    expect(soundsSummary(broken, 'tng').state).toBe('incomplete');
  });

  it('is happy with a full card and says what was installed', () => {
    const s = soundsSummary(full(), 'tng', { version: '3.3.3', installedAt: new Date(2026, 9, 5).getTime() });
    expect(s.state).toBe('ok');
    expect(s.title).toBe('Alle Ansagen sind da');
    expect(s.facts).toEqual([
      { label: 'Firmware', value: 'TonUINO TNG' },
      { label: 'Ordner mp3', value: `${TNG_SYSTEM_SOUNDS.mp3.length} Ansagen` },
      { label: 'Ordner advert', value: `${TNG_SYSTEM_SOUNDS.advert.length} Ansagen` },
      { label: 'Installiert', value: 'Version 3.3.3, am 5.10.2026' },
    ]);
    expect(s.duplicates).toBeUndefined();
    expect(s.oversized).toBeUndefined();
    expect(soundsSummary(full(), 'classic21', { version: 'eigene', installedAt: 0 }).facts.at(-1)?.value).toMatch(/^eigene Ansagen, am /);
  });

  it('knows empty announcements, like the health check, and does not call them missing', () => {
    const card = full();
    card.system.mp3!.empty = ['0300.mp3'];
    card.system.advert!.empty = ['0001.mp3', '0002.mp3'];
    const s = soundsSummary(card, 'tng');
    expect(s.state).toBe('empty');
    expect(s.title).toBe('Manche Ansagen sind leer');
    expect(s.text).toBe('3 Ansagen haben 0 Byte, meist weil das Kopieren abgebrochen ist. An diesen Stellen bleibt die Box stumm. Neu installieren ersetzt sie.');
    expect(s.text).not.toMatch(/fehl/);
    expect(s.facts).toContainEqual({ label: 'Leer', value: '3 Ansagen', tone: 'error' });
    expect(s.action).toBe('Ansagen neu installieren');
    card.system.advert!.empty = [];
    expect(soundsSummary(card, 'tng').text).toMatch(/^Die Ansage mp3\/0300\.mp3 hat 0 Byte,/);
  });

  it('names an empty announcement next to a missing newer one, without "wichtige Ansagen fehlen"', () => {
    const card = scan({ mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => n !== 340)), advert: dir('advert', TNG_SYSTEM_SOUNDS.advert) });
    card.system.advert!.empty = ['0005.mp3'];
    const s = soundsSummary(card, 'tng');
    expect(s.state).toBe('empty');
    expect(s.title).toBe('Manche Ansagen sind leer');
    expect(s.text).toBe(
      'Die Ansage advert/0005.mp3 hat 0 Byte, meist weil das Kopieren abgebrochen ist. An diesen Stellen bleibt die Box stumm. Außerdem fehlt eine Ansage, die neuere Versionen von TonUINO TNG brauchen. Neu installieren ersetzt sie.',
    );
    // Important ones missing as well: that comes first, the empty one is named after it.
    card.system.mp3 = dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => n !== 900));
    const both = soundsSummary(card, 'tng');
    expect(both.title).toBe('Wichtige Ansagen fehlen');
    expect(both.text).toMatch(/ Außerdem: Die Ansage advert\/0005\.mp3 hat 0 Byte, /);
  });

  it('counts a missing start tone (mp3/0262) as important for TNG', () => {
    // An announcement package that ends at 0255 (forum 12980): the box hangs after the first card.
    const card = scan({ mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => n !== 262)), advert: dir('advert', TNG_SYSTEM_SOUNDS.advert) });
    const s = soundsSummary(card, 'tng');
    expect(s.state).toBe('incomplete');
    expect(s.title).toBe('Eine wichtige Ansage fehlt');
    expect(s.text).toBe(
      'Es fehlt mp3/0262.mp3, der kurze Ton, wenn du eine Karte auflegst. Ohne ihn spielt die erste Karte noch, danach reagiert die Box oft nicht mehr („Fehler 6“).',
    );
    // TonUINO 2.1 has no such tone.
    expect(soundsSummary(card, 'classic21').state).toBe('ok');
  });

  it('keeps the general text when more than the start tone is missing, and adds the tone to it', () => {
    const card = scan({ mp3: dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => n !== 262 && n !== 900)), advert: dir('advert', TNG_SYSTEM_SOUNDS.advert) });
    const s = soundsSummary(card, 'tng');
    expect(s.title).toBe('Wichtige Ansagen fehlen');
    expect(s.text).toMatch(/^Es fehlen 2 Ansagen, auch welche, die die Box oft braucht, zum Beispiel im Admin-Menü\. .* Darunter ist auch mp3\/0262\.mp3, der kurze Ton/);
    expect(s.facts).toContainEqual({ label: 'Es fehlen', value: '2 Ansagen', tone: 'warn' });
  });

  it('says on the Werkstatt overview that announcements are empty, not missing', () => {
    const card = full();
    expect(soundsOverviewNote(checkSystemSounds(card, 'tng'))).toEqual({ text: 'Alle Ansagen da', tone: 'ok' });
    card.system.mp3!.empty = ['0005.mp3'];
    expect(soundsOverviewNote(checkSystemSounds(card, 'tng'))).toEqual({ text: 'Manche Ansagen auf der SD-Karte sind leer', tone: 'warn' });
    card.system.mp3 = { ...dir('mp3', TNG_SYSTEM_SOUNDS.mp3.filter((n) => n !== 262)), empty: ['0005.mp3'] };
    expect(soundsOverviewNote(checkSystemSounds(card, 'tng')).text).toBe('Auf der SD-Karte fehlen wichtige Ansagen');
  });

  it('warns about numbers that exist twice', () => {
    const twice = scan({ mp3: dir('mp3', [...TNG_SYSTEM_SOUNDS.mp3, 300]), advert: dir('advert', TNG_SYSTEM_SOUNDS.advert) });
    expect(soundsSummary(twice, 'tng').duplicates).toBe(
      'Manche Nummern gibt es doppelt, zum Beispiel mp3/0300. Dann spielt die Box vielleicht die falsche Ansage. Neu installieren räumt das auf.',
    );
  });

  it('warns about an audio play stored as an announcement', () => {
    const card = full();
    card.system.mp3!.files[0] = { ...card.system.mp3!.files[0], size: 5 * 1024 * 1024 };
    expect(soundsSummary(card, 'tng').oversized).toBe(
      'Eine Ansage ist viel zu groß, zum Beispiel mp3/0001.mp3. Vermutlich liegt dort ein Hörspiel oder Lied, und die Box wirkt dort wie eingefroren. Brauchst du die Datei noch, kopiere sie zuerst auf deinen Computer. Neu installieren ersetzt sie.',
    );
  });
});
