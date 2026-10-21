import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../src/app/state';
import {
  ADMIN_ACCESS,
  BITRATES,
  CARD_METHODS,
  PROFILES,
  SETTING_TEXTS,
  SETTINGS_SECTIONS,
  SPLIT_MINUTES,
  THEMES,
  changedSettings,
  checkBoxAddress,
  formatSettingValue,
  type SettingKey,
} from '../../src/features/settings/options';
import { resolveHelp } from '../../src/features/help/topics';
import { adminAccessFor } from '../../src/core/tonuino/boxguide';

const keys = Object.keys(DEFAULT_SETTINGS) as SettingKey[];
const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

describe('settings page content', () => {
  it('every setting has a label, a one-line hint and "Mehr erfahren"', () => {
    expect(Object.keys(SETTING_TEXTS).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const t = SETTING_TEXTS[k];
      expect(t.label.length, k).toBeGreaterThan(3);
      expect(t.hint.length, k).toBeGreaterThan(10);
      expect(t.hint, k).not.toContain('\n');
      expect(t.more.length, k).toBeGreaterThan(0);
      for (const p of t.more) expect(p.trim().length, k).toBeGreaterThan(10);
    }
  });

  it('numbers stay on one line with their unit', () => {
    // A plain space lets narrow screens break "128 kbit/s" after the number.
    const loose = /\d (?:kbit\/s|MB|GB|dB|%|Minuten|Pixel|MHz|cm)(?!\p{L})|\d ×|× \d/u;
    const texts = [
      ...Object.values(SETTING_TEXTS).flatMap((t) => [t.label, t.hint, ...t.more]),
      ...[...THEMES, ...PROFILES, ...ADMIN_ACCESS, ...BITRATES, ...CARD_METHODS].flatMap((c) => [c.label, c.text ?? '']),
      ...SETTINGS_SECTIONS.flatMap((s) => [s.title, s.intro]),
    ];
    for (const text of texts) expect(text).not.toMatch(loose);
  });

  it('every setting appears exactly once on the page', () => {
    const shown = SETTINGS_SECTIONS.flatMap((s) => s.keys);
    expect([...shown].sort()).toEqual([...keys].sort());
    expect(new Set(shown).size).toBe(shown.length);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length);
  });

  it('help links lead to a section of the help', () => {
    for (const k of keys) {
      const help = SETTING_TEXTS[k].help;
      if (!help) continue;
      const target = resolveHelp(help);
      expect(target.kind === 'topic' && (target.part?.id ?? target.section?.id), `${k} → ${help}`).toBe(help);
    }
  });

  it('the choices contain every value the setting can have, and the default', () => {
    const values = <T>(list: { value: T }[]) => list.map((c) => c.value);
    // Typed lists: a value missing here, or one the setting cannot have, fails the type check.
    const themes: Settings['theme'][] = ['auto', 'light', 'dark'];
    const bitrates: Settings['bitrateKbps'][] = [96, 128, 160, 192];
    expect(values(THEMES)).toEqual(themes);
    expect(values(PROFILES)).toEqual(['tng', 'classic21']);
    expect(values(BITRATES)).toEqual(bitrates);
    expect(values(CARD_METHODS)).toEqual(['box', 'qr', 'reader', 'wifi']);
    for (const [list, value] of [
      [THEMES, DEFAULT_SETTINGS.theme],
      [PROFILES, DEFAULT_SETTINGS.profile],
      [ADMIN_ACCESS, DEFAULT_SETTINGS.adminAccess],
      [BITRATES, DEFAULT_SETTINGS.bitrateKbps],
      [CARD_METHODS, DEFAULT_SETTINGS.cardMethod],
    ] as const) {
      expect(values<unknown>([...list]), String(value)).toContain(value);
    }
    expect(SPLIT_MINUTES).toContain(DEFAULT_SETTINGS.splitMinutes);
  });

  it('offers every way to open the admin menu, the sum to solve only for TonUINO 2.1', () => {
    const values = ADMIN_ACCESS.map((c) => c.value);
    expect(values).toEqual(adminAccessFor('classic21'));
    for (const p of PROFILES) for (const a of adminAccessFor(p.value)) expect(values, `${p.value}: ${a}`).toContain(a);
    expect(adminAccessFor('tng')).not.toContain('calc');
  });

  it('offers the same lengths as the add page and the same ways as the cards page', () => {
    const add = source('features/add/AddPage.tsx').match(/const SPLIT_MINUTES = \[([^\]]+)\]/)?.[1];
    expect(add?.split(',').map((n) => Number(n.trim()))).toEqual([...SPLIT_MINUTES]);
    const cards = source('features/cards/CardsPage.tsx');
    for (const m of CARD_METHODS) expect(cards, m.value).toContain(`title: '${m.label}', text: '${m.text}'`);
  });
});

describe('quiet MP3 albums', () => {
  it('has a switch, on from the start, right after "Gleiche Lautstärke"', () => {
    expect(DEFAULT_SETTINGS.boostQuietMp3).toBe(true);
    const t = SETTING_TEXTS.boostQuietMp3;
    expect(t.label).toBe('Leise MP3s lauter machen');
    expect(t.hint).toBe('Dafür wandle ich leise MP3-Alben neu um. Sonst bleiben sie leiser als der Rest.');
    expect(t.help).toBe('lautstaerke');
    const target = resolveHelp(t.help!);
    expect(target.kind === 'topic' && target.section?.id).toBe('lautstaerke');
    const section = SETTINGS_SECTIONS.find((x) => x.id === 'hinzufuegen')!;
    expect(section.keys.slice(0, 2)).toEqual(['normalizeLoudness', 'boostQuietMp3']);
    expect(formatSettingValue('boostQuietMp3', false)).toBe('Aus');
  });

  it('says when MP3 files are converted, wherever it talks about converting', () => {
    const texts = [...SETTING_TEXTS.normalizeLoudness.more, ...SETTING_TEXTS.bitrateKbps.more].join(' ');
    expect(texts).not.toContain('MP3-Dateien wandelt sie nicht um');
    expect(texts).toContain('wenn ein leises Album sonst nicht laut genug würde');
    expect(SETTING_TEXTS.normalizeLoudness.more.join(' ')).toContain('und „Leise MP3s lauter machen“ an ist');
  });

  it('turns the switch off while "Gleiche Lautstärke" is off, and says why', () => {
    const page = source('features/settings/SettingsPage.tsx');
    const block = page.slice(page.indexOf("case 'boostQuietMp3':"), page.indexOf("case 'normalizeLoudness':"));
    expect(block).toContain('const off = !s.normalizeLoudness;');
    expect(block).toContain('disabled={off}');
    expect(block).toContain('checked={s.boostQuietMp3 && !off}');
    expect(block).toContain('Geht nur mit „Gleiche Lautstärke“.');
  });
});

describe('checkBoxAddress', () => {
  it('accepts an empty field, IP addresses and names', () => {
    expect(checkBoxAddress('')).toEqual({ ok: true, value: '' });
    expect(checkBoxAddress('   ')).toEqual({ ok: true, value: '' });
    expect(checkBoxAddress('192.168.178.40')).toEqual({ ok: true, value: '192.168.178.40' });
    expect(checkBoxAddress(' http://TonUINO.fritz.box/ ')).toEqual({ ok: true, value: 'http://TonUINO.fritz.box/' });
  });

  it('explains what to type when the address cannot work', () => {
    const r = checkBoxAddress('meine box');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/192\.168\.178\.40/);
  });

  it('an IP address needs four numbers up to 255, without leading zeros', () => {
    const message = (input: string) => {
      const r = checkBoxAddress(input);
      return r.ok ? null : r.message;
    };
    // A browser would turn these into other addresses: 192.168.0.178, 0.0.1.2, 192.168.178.32.
    expect(message('192.168.178')).toMatch(/vier Zahlen/);
    expect(message('1.2')).toMatch(/vier Zahlen/);
    expect(message('192')).toMatch(/vier Zahlen/);
    expect(message('192.168.178.40.')).toMatch(/vier Zahlen/);
    expect(message('192.168..40')).toMatch(/vier Zahlen/);
    expect(message('300.1.2.3')).toMatch(/bis 255/);
    expect(message('192.168.178.256')).toMatch(/bis 255/);
    expect(message('192.168.178.040')).toMatch(/Nullen/);
    expect(message('192.168.178.40:99999')).toMatch(/Doppelpunkt/);
    for (const ok of ['192.168.178.40', '192.168.4.1', 'http://192.168.178.40/', '10.0.0.255', '192.168.178.40:80', 'tonuino', 'tonuino-1.local', 'box2.fritz.box']) {
      expect(checkBoxAddress(ok), ok).toEqual({ ok: true, value: ok });
    }
  });
});

describe('values in words', () => {
  it('formats every kind of setting', () => {
    expect(formatSettingValue('theme', 'dark')).toBe('Dunkel');
    expect(formatSettingValue('profile', 'classic21')).toBe('TonUINO 2.1');
    expect(formatSettingValue('adminAccess', 'pin')).toBe('PIN');
    expect(formatSettingValue('bitrateKbps', 160)).toBe('160\u00a0kbit/s');
    expect(formatSettingValue('splitMinutes', 8)).toBe('8\u00a0Minuten');
    expect(formatSettingValue('cardMethod', 'qr')).toBe('Mit dem Handy');
    expect(formatSettingValue('boxAddress', '')).toBe('keine');
    expect(formatSettingValue('stripTags', false)).toBe('Aus');
  });

  it('lists only changed settings, in page order, with old and new value', () => {
    expect(changedSettings({ ...DEFAULT_SETTINGS }, DEFAULT_SETTINGS)).toEqual([]);
    const changed: Settings = { ...DEFAULT_SETTINGS, cardMethod: 'reader', theme: 'dark', boxAddress: ' ' };
    expect(changedSettings(changed, DEFAULT_SETTINGS)).toEqual([
      { key: 'theme', label: 'Darstellung', from: 'Dunkel', to: 'Automatisch' },
      { key: 'cardMethod', label: 'Karten beschreiben', from: 'Mit dem NFC-Leser', to: 'An der Box' },
    ]);
  });
});
