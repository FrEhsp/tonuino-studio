import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../src/core/sources/build';
import {
  checkQuality,
  estimatedKbps,
  MIN_KBPS,
  MIN_PLAUSIBLE_BYTES,
  lengthText,
  MIN_SECONDS,
  minSecondsFor,
  PROMO_TEXT_CHARS,
  promoWord,
} from '../../src/core/sources/quality';
import type { CatalogEntry, SourceCatalog } from '../../src/core/sources/types';
import { NOW, sampleCatalog, sampleInputs } from './sample';

const ABOUT = 'Eine Geschichte über Freundschaft und Mut.';

describe('quality thresholds', () => {
  it('MIN_SECONDS: Hörspiele and Hörbücher under 3 minutes are snippets', () => {
    expect(MIN_SECONDS.hoerspiel).toBe(180);
    expect(MIN_SECONDS.hoerbuch).toBe(180);
    expect(checkQuality({ title: 'Folge 1', about: ABOUT, category: 'hoerspiel', durationSec: 179 }).reject?.code).toBe('short');
    expect(checkQuality({ title: 'Folge 1', about: ABOUT, category: 'hoerbuch', durationSec: 180 }).reject).toBeUndefined();
    expect(checkQuality({ title: 'Folge 1', about: ABOUT, category: 'hoerbuch', durationSec: 95 }).reject?.reason).toBe('Zu kurz: 1:35 Minuten (mindestens 3 Minuten)');
  });

  it('a length just under the limit does not read like the limit', () => {
    expect(checkQuality({ title: 'Folge 1', about: ABOUT, category: 'hoerspiel', durationSec: 179 }).reject?.reason).toBe('Zu kurz: 2:59 Minuten (mindestens 3 Minuten)');
    expect(checkQuality({ title: 'Folge 1', about: ABOUT, category: 'hoerspiel', durationSec: 177.6 }).reject?.reason).toBe('Zu kurz: 2:57 Minuten (mindestens 3 Minuten)');
    expect(lengthText(59.9)).toBe('59 Sekunden');
    expect(lengthText(60)).toBe('1 Minute');
    expect(lengthText(65)).toBe('1:05 Minuten');
    expect(lengthText(180)).toBe('3 Minuten');
    expect(lengthText(750)).toBe('12,5 Minuten');
  });

  it('MIN_SECONDS: songs under 45 seconds are jingles', () => {
    expect(MIN_SECONDS.lied).toBe(45);
    expect(checkQuality({ title: 'Lied', about: ABOUT, category: 'lied', durationSec: 44 }).reject?.reason).toBe('Zu kurz: 44 Sekunden (mindestens 45 Sekunden)');
    expect(checkQuality({ title: 'Lied', about: ABOUT, category: 'lied', durationSec: 45 }).reject).toBeUndefined();
  });

  it('minSeconds of a source only lowers the limit', () => {
    expect(minSecondsFor('hoerbuch', 20)).toBe(20);
    expect(minSecondsFor('hoerbuch', 600)).toBe(180);
    expect(minSecondsFor('lied', undefined)).toBe(45);
    expect(checkQuality({ title: 'Gute Nacht', about: ABOUT, category: 'hoerbuch', durationSec: 60, minSeconds: 30 }).reject).toBeUndefined();
    // Unknown length: nothing to judge.
    expect(checkQuality({ title: 'Folge', about: ABOUT, category: 'hoerspiel' }).reject).toBeUndefined();
  });

  it('MIN_KBPS: below 48 kbit/s the title waits for a person', () => {
    expect(MIN_KBPS).toBe(48);
    // 10 minutes at 32 kbit/s: 2.4 MB.
    const low = checkQuality({ title: 'Folge', about: ABOUT, category: 'hoerspiel', durationSec: 600, size: 2_400_000 });
    expect(low.reject).toBeUndefined();
    expect(low.holds).toEqual([{ code: 'lowBitrate', reason: 'Geringe Tonqualität: etwa 32 kbit/s (Datei anhören)' }]);
    // 10 minutes at 48 kbit/s: 3.6 MB.
    expect(checkQuality({ title: 'Folge', about: ABOUT, category: 'hoerspiel', durationSec: 600, size: 3_600_000 }).holds).toEqual([]);
  });

  it('MIN_PLAUSIBLE_BYTES: a placeholder size in a feed is no bit rate', () => {
    expect(MIN_PLAUSIBLE_BYTES).toBe(100_000);
    expect(estimatedKbps(1, 1800)).toBeUndefined();
    expect(estimatedKbps(MIN_PLAUSIBLE_BYTES - 1, 1800)).toBeUndefined();
    expect(estimatedKbps(MIN_PLAUSIBLE_BYTES, 10)).toBe(80);
    expect(estimatedKbps(5_000_000, undefined)).toBeUndefined();
  });

  it('PROMO_TEXT_CHARS: only the start of a description counts', () => {
    expect(PROMO_TEXT_CHARS).toBe(160);
    const early = checkQuality({ title: 'Neue Staffel', about: 'Hörprobe: so klingt die neue Staffel.', category: 'hoerspiel', durationSec: 600 });
    expect(early.holds.map((h) => h.code)).toEqual(['promoText']);
    const late = checkQuality({ title: 'Folge 4', about: `${'Eine lange Geschichte über den Wald. '.repeat(6)} Vorschau auf die nächste Folge.`, category: 'hoerspiel', durationSec: 600 });
    expect(late.holds).toEqual([]);
  });
});

describe('promo words', () => {
  it('finds trailers, teasers, previews and announcements, also inside words and with umlauts', () => {
    expect(promoWord('Trailer: Die neue Staffel')).toBe('trailer');
    expect(promoWord('Staffeltrailer')).toBe('trailer');
    expect(promoWord('Teaser – bald geht es los')).toBe('teaser');
    expect(promoWord('Wochenvorschau')).toBe('vorschau');
    expect(promoWord('Ankündigung')).toBe('ankuendigung');
    expect(promoWord('HÖRPROBE')).toBe('hoerprobe');
    expect(promoWord('Programmhinweis für Sonntag')).toBe('programmhinweis');
    expect(promoWord('In eigener Sache: wir machen Pause')).toBe('in eigener sache');
    // A feed written on a Mac may spell "ü" as "u" and a combining mark (NFD).
    expect(promoWord('Ankündigung'.normalize('NFD'))).toBe('ankuendigung');
    expect(promoWord('Hörprobe aus Folge 3'.normalize('NFD'))).toBe('hoerprobe');
    expect(checkQuality({ title: 'Ankündigung'.normalize('NFD'), about: ABOUT, category: 'hoerspiel', durationSec: 600 }).reject?.code).toBe('promo');
    expect(promoWord('Der Mann im Mond')).toBeUndefined();
    expect(promoWord('Eigene Sachen packen')).toBeUndefined();
  });

  it('rejects promo titles and episodes the publisher marks as trailer', () => {
    expect(checkQuality({ title: 'Trailer: Staffel 2', about: ABOUT, category: 'hoerspiel', durationSec: 90 }).reject?.code).toBe('promo');
    expect(checkQuality({ title: 'Willkommen', about: ABOUT, episodeType: 'trailer', category: 'hoerspiel', durationSec: 600 }).reject?.reason).toBe('Der Anbieter markiert die Folge als Trailer');
    expect(checkQuality({ title: 'Folge 1', about: ABOUT, episodeType: 'full', category: 'hoerspiel', durationSec: 600 }).reject).toBeUndefined();
  });

  it('a title without any description is sparse, not removed', () => {
    const q = checkQuality({ title: 'Folge 3', category: 'hoerspiel', durationSec: 600 });
    expect(q).toEqual({ reject: undefined, holds: [], sparse: true });
    expect(checkQuality({ title: 'Folge 3', about: 'Folge 3', category: 'hoerspiel', durationSec: 600 }).sparse).toBe(true);
    expect(checkQuality({ title: 'Folge 3', about: ABOUT, category: 'hoerspiel', durationSec: 600 }).sparse).toBe(false);
  });
});

/* ------------------------------------------------------------------ the build run */

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Testsendung</title><link>https://example.org/</link>
${[
  ['g1', 'Der Bär im Glück', ABOUT, '00:20:00', '19200000', ''],
  ['g2', 'Trailer: Neue Staffel', 'Bald geht es los.', '00:01:30', '1440000', ''],
  ['g3', 'Willkommen beim Podcast', 'Wer wir sind.', '00:05:00', '4800000', 'trailer'],
  ['g4', 'Kurzer Gruß', 'Ein Gruß aus dem Studio.', '00:00:50', '800000', ''],
  ['g5', 'Die leise Folge', ABOUT, '00:30:00', '5400000', ''],
  ['g6', 'Neue Abenteuer', 'Hörprobe aus dem neuen Hörbuch.', '00:10:00', '9600000', ''],
  ['g7', 'Folge ohne Text', '', '00:15:00', '14400000', ''],
]
  .map(
    ([guid, title, desc, dur, len, type], i) =>
      `<item><guid>${guid}</guid><title>${title}</title>${desc ? `<description>${desc}</description>` : ''}<pubDate>Mon, 0${7 - i} Sep 2026 06:00:00 GMT</pubDate><itunes:duration>${dur}</itunes:duration>${type ? `<itunes:episodeType>${type}</itunes:episodeType>` : ''}<enclosure url="https://media.example.org/${guid}.mp3" length="${len}" type="audio/mpeg"/></item>`,
  )
  .join('\n')}
</channel></rss>`;

const TEST_FEED: CatalogEntry = {
  id: 'test-quality',
  type: 'podcast',
  status: 'active',
  title: 'Testsendung',
  publisher: 'Test',
  pageUrl: 'https://example.org/',
  feedUrl: 'https://example.org/feed.xml',
  mediaHosts: ['media.example.org'],
  category: 'hoerspiel',
  ages: { min: 6, source: 'editor' },
  language: 'de',
  rights: { kind: 'podcast', holder: 'Test' },
  delivery: 'direct',
  editPolicy: 'normal',
  review: { by: 'Test', at: '2026-10-01', next: '2027-04-01' },
};

function run(released: string[] = []) {
  const base = sampleCatalog();
  const catalog: SourceCatalog = { ...base, entries: [...base.entries, TEST_FEED] };
  const inputs = sampleInputs();
  return buildIndex(catalog, {
    ...inputs,
    now: NOW,
    feeds: { ...inputs.feeds, 'test-quality': FEED },
    released: [...inputs.released, ...released.map((key) => ({ key, by: 'Redaktion', at: '2026-10-05' }))],
  });
}

describe('quality filter in the build run', () => {
  const { index, report } = run();
  const items = index.entries.find((e) => e.id === 'test-quality')!.items;

  it('keeps good episodes, lists the one without text and sorts it down later', () => {
    expect(items.map((i) => i.key)).toEqual(['test-quality/g1', 'test-quality/g7']);
    expect(items[0].sparse).toBeUndefined();
    expect(items[1].sparse).toBe(true);
  });

  it('rejects trailers and snippets, holds low quality and promo descriptions', () => {
    const rejected = report.rejected.filter((r) => r.entry === 'test-quality');
    expect(rejected.map((r) => r.key)).toEqual(['test-quality/g2', 'test-quality/g3', 'test-quality/g4']);
    const held = report.holds.filter((h) => h.entry === 'test-quality');
    expect(held.map((h) => [h.key, h.reasons])).toEqual([
      ['test-quality/g5', ['Geringe Tonqualität: etwa 24 kbit/s (Datei anhören)']],
      ['test-quality/g6', ['Vielleicht Trailer oder Ankündigung („hoerprobe“ in der Beschreibung)']],
    ]);
  });

  it('counts each reason for the run report', () => {
    expect(report.quality).toEqual({ promo: 2, promoText: 1, short: 1, lowBitrate: 1, sparse: 7 + 1 });
  });

  it('a title a person released always passes', () => {
    const r = run(['test-quality/g2', 'test-quality/g5']);
    expect(r.index.entries.find((e) => e.id === 'test-quality')!.items.map((i) => i.key)).toEqual(['test-quality/g1', 'test-quality/g2', 'test-quality/g5', 'test-quality/g7']);
  });

  it('books, stories and links: a too short story is left out unless the source allows it', () => {
    // Global Storybooks sets minSeconds 20 in the catalogue: its stories of 28 and 49 seconds stay.
    expect(index.entries.find((e) => e.id === 'global-storybooks-de')!.items.some((i) => i.key === 'global-storybooks-de/0002')).toBe(true);
    const base = sampleCatalog();
    const strict: SourceCatalog = { ...base, entries: base.entries.map((e) => (e.id === 'global-storybooks-de' ? { ...e, minSeconds: undefined } : e)) };
    const r = buildIndex(strict, sampleInputs());
    expect(r.report.rejected).toContainEqual({ entry: 'global-storybooks-de', key: 'global-storybooks-de/0002', reason: 'Zu kurz: 28 Sekunden (mindestens 3 Minuten)' });
  });
});
