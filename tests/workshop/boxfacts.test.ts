import { describe, expect, it } from 'vitest';
import { analyzeBootLog, type BoxInfo } from '../../src/core/firmware/bootlog';
import { boxFacts, hasBootFacts, summaryLines } from '../../src/features/workshop/boxfacts';
import { AIOPLUS_BROKEN_LOG, CLASSIC_LOG } from './fakes';

const rows = (facts: { label: string; value: string; tone?: string }[]) => facts.map((f) => `${f.label}: ${f.value}${f.tone ? ` (${f.tone})` : ''}`);

describe('Steckbrief', () => {
  it('describes a healthy Classic box', () => {
    const { box, settings } = boxFacts(analyzeBootLog(CLASSIC_LOG).info);
    expect(rows(box)).toEqual([
      'Firmware: TonUINO TNG 3.3.3 vom 17.09.2026',
      'Platine: Classic, 3 Tasten',
      'Kartenleser: antwortet (MFRC522 v2.0) (ok)',
      'MP3-Player: 312 Dateien auf der SD-Karte (ok)',
      'Lautstärke: 16 von 30',
    ]);
    expect(rows(settings)).toEqual([
      'Lautsprecher: 5 bis 25, beim Einschalten 15',
      'Kopfhörer: 5 bis 25, beim Einschalten 15',
      'Klang: Normal',
      'Ausschalt-Timer: aus',
      'Admin-Menü: nicht gesperrt',
      'Karte wegnehmen: Box spielt weiter',
      'Tasten: kurz drücken: Lautstärke, lang: Titel',
    ]);
  });

  it('links every setting to the tool that changes it, but not the parts of the box', () => {
    const { box, settings } = boxFacts(analyzeBootLog(CLASSIC_LOG).info);
    expect(settings.length).toBeGreaterThan(0);
    for (const f of settings.filter((x) => x.id !== 'headphone')) expect(f.link).toEqual({ label: 'Ändern', href: '#/werkstatt/einstellen' });
    expect(box.some((f) => f.link)).toBe(false);
  });

  it('offers no „Ändern“ for the headphone volume, which „Box einstellen“ does not count from', () => {
    const info = analyzeBootLog(CLASSIC_LOG).info;
    info.settings.headphoneVolume = { max: 25, min: 5, init: 15 };
    const { settings } = boxFacts(info);
    expect(settings.find((f) => f.id === 'headphone')?.link).toBeUndefined();
    expect(settings.find((f) => f.id === 'speaker')?.link?.href).toBe('#/werkstatt/einstellen');
  });

  it('marks parts that do not answer', () => {
    const { box, settings } = boxFacts(analyzeBootLog(AIOPLUS_BROKEN_LOG).info);
    expect(rows(box)).toEqual([
      'Firmware: TonUINO TNG 3.3.3 vom 17.09.2026',
      'Platine: AiO+, 5 Tasten',
      'Kartenleser: antwortet nicht (error)',
      'MP3-Player: antwortet nicht (error)',
    ]);
    expect(rows(settings)).toContain('Admin-Menü: mit PIN gesperrt (Play/Pause, Vor, Zurück, Play/Pause)');
    expect(rows(settings)).toContain('Ausschalt-Timer: nach 10 Minuten ohne Musik');
    // The button layout setting only matters with 3 buttons.
    expect(settings.some((f) => f.id === 'buttons')).toBe(false);
  });

  it('tells Wi-Fi, headphones, an old firmware and an empty battery', () => {
    const info: BoxInfo = {
      firmware: 'classic21',
      settings: {},
      folderTracks: {},
      headphones: true,
      wifi: { mode: 'access-point', ssid: 'Zuhause', ip: '192.168.4.1' },
      batteryEmpty: true,
      mp3: { connected: true, trackCount: 0 },
    };
    expect(rows(boxFacts(info).box)).toEqual([
      'Firmware: TonUINO 2.1 (alte Version) (warn)',
      'MP3-Player: findet keine Dateien auf der SD-Karte (error)',
      'Kopfhörer: eingesteckt',
      'WLAN: eigenes WLAN „TonUINO“, http://192.168.4.1 (warn)',
      'Akku: leer (error)',
    ]);
    expect(rows(boxFacts({ ...info, wifi: { mode: 'station', ssid: 'Zuhause', ip: '192.168.1.20' } }).box)).toContain(
      'WLAN: verbunden mit „Zuhause“, http://192.168.1.20 (ok)',
    );
  });

  it('knows when the start of the box was not in the log', () => {
    const empty: BoxInfo = { settings: {}, folderTracks: {} };
    expect(boxFacts(empty)).toEqual({ box: [], settings: [] });
    expect(hasBootFacts(empty)).toBe(false);
    expect(hasBootFacts(analyzeBootLog(CLASSIC_LOG).info)).toBe(true);
  });

  it('writes a summary with the issues for a forum post', () => {
    const { info, issues } = analyzeBootLog(AIOPLUS_BROKEN_LOG);
    const text = summaryLines(info, issues).join('\n');
    expect(text).toContain('Steckbrief der Box\n- Firmware: TonUINO TNG 3.3.3 vom 17.09.2026');
    expect(text).toContain('Auffälligkeiten\n- [Fehler] Kartenleser antwortet nicht');
    expect(text).toContain('  Tipp: ');
    expect(summaryLines({ settings: {}, folderTracks: {} }, [])).toEqual([
      'Steckbrief der Box',
      '- noch nichts bekannt (die Box ist im Log nicht gestartet)',
      '',
      'Auffälligkeiten',
      '- keine',
    ]);
  });
});
