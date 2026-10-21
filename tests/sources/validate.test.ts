import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../../src/core/sources/types';
import { parseIndex, pickProblems, validateCatalog, validateIndex, validateReleased } from '../../src/core/sources/validate';
import { ARD_EMBED } from '../../src/core/sources/providers';
import { withEditorial } from '../../src/core/sources/editorial';
import { ADDED_02, ADDED_03, ADDED_04, ARD_LINKS, buildSample, OWNER_PICKS, realCatalog } from './sample';

const NOW = new Date('2026-10-05T04:00:00Z');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const withEntry = (patch: (e: Record<string, unknown>) => void, id = 'radio-klops'): unknown => {
  const c = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
  patch(c.entries.find((e) => e.id === id)!);
  return c;
};

describe('editors\' notes (editorial.ts)', () => {
  it('stay out of the published catalogue', () => {
    const text = readFileSync(new URL('../../sources/catalog.json', import.meta.url), 'utf8');
    expect(text).not.toMatch(/"(internal|openChecks|permission|notUsed)"\s*:/);
    expect(realCatalog().entries.filter((e) => e.review?.by !== undefined).map((e) => e.id)).toEqual([]);
  });

  it('are mixed in by the scripts, and never publish an entry', () => {
    const errors: string[] = [];
    const notes = {
      format: 1,
      entries: {
        'kakadu-kinderhoerspiel': { reviewBy: 'Redaktion', internal: 'Notiz', permission: { needed: 'Zustimmung' }, openChecks: [] },
        'br-geschichten-fuer-kinder': { status: 'waiting-permission', permission: { needed: 'Zustimmung' } },
        'radio-klops': { status: 'active' },
        unbekannt: { internal: 'x' },
      },
      notUsed: [{ name: 'X', reason: 'Y' }],
    };
    const merged = withEditorial(realCatalog(), notes, errors);
    const catalog = merged as ReturnType<typeof realCatalog>;
    const entry = (id: string) => catalog.entries.find((e) => e.id === id)!;
    expect(entry('kakadu-kinderhoerspiel').review?.by).toBe('Redaktion');
    expect(entry('kakadu-kinderhoerspiel').internal).toBe('Notiz');
    expect(entry('br-geschichten-fuer-kinder').status).toBe('waiting-permission');
    expect(entry('radio-klops').status).toBe('review');
    expect(catalog.notUsed).toEqual([{ name: 'X', reason: 'Y' }]);
    expect(errors).toEqual(['Notizen der Redaktion: unbekannt gehört zu keinem Eintrag im Katalog']);
    expect(validateCatalog(merged, NOW).errors).toEqual([]);
    expect(withEditorial(realCatalog(), undefined)).toEqual(realCatalog());
  });
});

describe('validateCatalog', () => {
  it('accepts the catalogue in the repository', () => {
    const r = validateCatalog(realCatalog(), NOW);
    expect(r.errors).toEqual([]);
    expect(r.catalog?.entries).toHaveLength(32);
  });

  it('requires "unchanged" for licences without derivatives (ND)', () => {
    const r = validateCatalog(
      withEntry((e) => {
        e.rights = { kind: 'cc', id: 'by-nd', version: '4.0', url: 'https://creativecommons.org/licenses/by-nd/4.0/' };
        e.editPolicy = 'normal';
      }, 'jamendo-139374-eckhardt'),
      NOW,
    );
    expect(r.errors).toContain('jamendo-139374-eckhardt: Lizenz ohne Bearbeitungen (ND) verlangt editPolicy "unchanged"');
    expect(r.catalog).toBeUndefined();
  });

  it('checks ids, URLs, hosts, licences, ages and statuses', () => {
    const errors = (raw: unknown) => validateCatalog(raw, NOW).errors;
    const c = clone(realCatalog());
    c.entries.push({ ...(c.entries[0] as CatalogEntry) });
    expect(errors(c)).toContain('kakadu-kinderhoerspiel: id doppelt');
    expect(errors(withEntry((e) => (e.id = 'Radio_Klops')))[0]).toMatch(/^Eintrag ohne gültige id/);
    expect(errors(withEntry((e) => (e.pageUrl = 'http://radioklops.podigee.io/')))).toContain('radio-klops: pageUrl ist keine https-Adresse');
    expect(errors(withEntry((e) => (e.mediaHosts = [])))).toContain('radio-klops: Podcasts brauchen mindestens einen mediaHost');
    expect(errors(withEntry((e) => (e.mediaHosts = ['dts.podtrac.com'])))).toContain('radio-klops: mediaHost dts.podtrac.com ist ein Messdienst');
    expect(errors(withEntry((e) => (e.ages = { min: 9, max: 4, source: 'editor' }))).some((m) => m.startsWith('radio-klops: Altersangabe ungültig'))).toBe(true);
    expect(errors(withEntry((e) => (e.ages = { min: 4, max: 19, source: 'editor' }))).some((m) => m.startsWith('radio-klops: Altersangabe ungültig'))).toBe(true);
    expect(errors(withEntry((e) => (e.status = 'live')))).toContain('radio-klops: unbekannter Status „live“');
    expect(errors(withEntry((e) => (e.rights = { kind: 'cc', id: 'by', version: '4.0', url: 'https://example.org/by/4.0/' }), 'jamendo-139374-eckhardt'))).toContain(
      'jamendo-139374-eckhardt: Lizenz-URL wird nicht verstanden',
    );
    expect(errors(withEntry((e) => (e.categoryRules = [{ pattern: '(', category: 'lied' }])))).toContain('radio-klops: categoryRules: Muster „(“ ist ungültig');
  });

  it('active entries need a review; an overdue one is a warning', () => {
    expect(validateCatalog(withEntry((e) => (e.status = 'active'))).errors).toContain('radio-klops: aktive Einträge brauchen review mit at und next');
    const r = validateCatalog(
      withEntry((e) => {
        e.status = 'active';
        e.review = { by: 'Redaktion', at: '2026-04-01', next: '2026-10-01' };
        e.openChecks = [];
        e.rights = { kind: 'podcast', holder: 'Domenik Schuster', termsUrl: 'https://radioklops.podigee.io/impressum' };
        e.permission = { needed: 'Erlaubnis des Produzenten', granted: { by: 'Domenik Schuster', at: '2026-09-20', filed: 'Postfach Redaktion, 2026-09-20' } };
      }),
      NOW,
      {
        termsHashes: {
          format: 1,
          hashes: {
            'https://radioklops.podigee.io/impressum': { sha256: 'ab', checkedAt: '2026-09-21' },
            // The ARD terms of the owner's picks (link only) and OHRKA's (link only).
            'https://www.ardsounds.de/nutzungsbedingungen/': { sha256: 'cd', checkedAt: '2026-10-06' },
            'https://www.ohrka.de/impressum': { sha256: 'ef', checkedAt: '2026-10-09' },
            // Deutschlandradio (Kakadu, link only since 0.3).
            'https://www.kakadu.de/nutzungsbedingungen-106.html': { sha256: '01', checkedAt: '2026-10-13' },
          },
        },
      },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(['radio-klops: Prüfung überfällig seit 2026-10-01']);
  });

  it('releases the owner’s ARD picks and the 0.2, 0.3 and 0.4 additions, the broadcasters and OHRKA only as links', () => {
    const c = realCatalog();
    const active = c.entries.filter((e) => e.status === 'active');
    expect(active.map((e) => e.id).sort()).toEqual([...OWNER_PICKS, ...ADDED_02, ...ADDED_03, ...ADDED_04].sort());
    // The owner's LibriVox picks (ranks 1, 5, 6, 8 and 9) left with LibriVox in 0.4; the new ARD shows took 5, 6, 8 and 9.
    expect(OWNER_PICKS.map((id) => c.entries.find((e) => e.id === id)?.featured?.rank)).toEqual([2, 3, 4, 7]);
    expect(ADDED_04.map((id) => c.entries.find((e) => e.id === id)?.featured?.rank)).toEqual([5, 6, 8, 9]);
    for (const e of active) {
      const wish = ADDED_04.includes(e.id) ? '0.4' : ADDED_03.includes(e.id) ? '0.3' : undefined;
      const added = ADDED_02.includes(e.id) || !!wish;
      // Who reviewed it is in the editors' notes, not in the published catalogue (editorial.ts).
      expect(e.review?.by, e.id).toBeUndefined();
      expect(e.review?.at, e.id).toBe(wish === '0.4' ? '2026-10-15' : wish ? '2026-10-13' : added ? '2026-10-09' : '2026-10-06');
      if (e.type === 'link') expect([e.delivery, e.permission?.granted], e.id).toEqual(['browser', undefined]);
      expect(Date.parse(e.review!.next) - Date.parse(e.review!.at), e.id).toBeLessThanOrEqual(183 * 86_400_000);
      expect(e.openChecks ?? [], e.id).toEqual([]);
      if (e.featured || !added) expect(pickProblems(e.featured), e.id).toEqual([]);
      if (e.type === 'podcast') {
        // No permission to save through the app yet: offered as links, the files stay unchanged.
        expect([e.delivery, e.editPolicy, e.permission?.granted], e.id).toEqual(['browser', 'unchanged', undefined]);
      }
    }
    // Every show on ARD Sounds is a list of links, each episode with ARD's own player; stories one by one.
    for (const id of ARD_LINKS) {
      const e = c.entries.find((x) => x.id === id)!;
      if (e.type !== 'link') throw new Error(`${id} ist kein Link-Eintrag`);
      expect([e.single, e.rights.kind, 'termsUrl' in e.rights && e.rights.termsUrl], id).toEqual([true, 'private-use', 'https://www.ardsounds.de/nutzungsbedingungen/']);
      expect(e.series?.urls, id).toEqual([e.pageUrl]);
      for (const it of e.items) expect(it.embed, it.pageUrl).toMatch(ARD_EMBED);
    }
    // With the stored terms, the build asks only for the terms a person still has to read (sources:check --update-hashes).
    const terms = JSON.parse(readFileSync(new URL('../../sources/terms-hashes.json', import.meta.url), 'utf8')) as unknown;
    const errors = validateCatalog(c, NOW, { termsHashes: terms }).errors;
    expect(errors.every((m) => /Nutzungsbedingungen nicht gelesen: kein Stand für https:\/\/www\.(?:ardsounds\.de\/nutzungsbedingungen\/|ohrka\.de\/impressum|kakadu\.de\/nutzungsbedingungen-106\.html) in sources\/terms-hashes\.json$/.test(m))).toBe(true);
  });

  it('keeps LibriVox out for good: no entry, noted why, and dropped from lists the app kept', () => {
    // Taken out by the owner on 2026-10-14 ("Librivox kannst du da rausschmeißen").
    const c = realCatalog();
    const { sample } = buildSample();
    expect(c.entries.some((e) => e.id.startsWith('librivox-') || JSON.stringify(e).includes('librivox'))).toBe(false);
    // Why it went is in the editors' notes, outside the repository (src/core/sources/editorial.ts).
    expect(c.notUsed).toBeUndefined();
    // A list from 0.3 kept on the device still holds LibriVox books: the app no longer knows the kind and leaves them out.
    const old = clone(sample) as unknown as { entries: Record<string, unknown>[] };
    old.entries.push({ ...clone(sample.entries[0]), id: 'librivox-peterchens-mondfahrt', type: 'librivox' } as unknown as Record<string, unknown>);
    const r = parseIndex(old);
    if (!r || r === 'needs-update') throw new Error('unreadable');
    expect(r.index.entries.map((e) => e.id)).toEqual(sample.entries.map((e) => e.id));
  });

  it('keeps an entry from going live while a rights question is open', () => {
    const review = { by: 'Redaktion', at: '2026-10-01', next: '2027-04-01' };
    const c = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
    for (const e of c.entries) if (['kakadu-kinderhoerspiel', 'rbb-ohrenbaer', 'radio-klops', 'ohrka'].includes(e.id as string)) Object.assign(e, { status: 'active', review });
    // Kakadu saved through the app (delivery direct) with its two open points: that needs the permission.
    // The permission still needed is in the editors' notes, which the scripts mix in (editorial.ts).
    Object.assign(c.entries.find((e) => e.id === 'kakadu-kinderhoerspiel')!, {
      delivery: 'direct',
      openChecks: ['CORS prüfen', 'Zustimmung einholen'],
      permission: { needed: 'Schriftliche Zustimmung von Deutschlandradio' },
    });
    const errors = validateCatalog(c, NOW, { termsHashes: { format: 1, hashes: {} } }).errors;
    expect(errors).toContain('kakadu-kinderhoerspiel: aktiv, aber noch 2 offene Punkte (openChecks)');
    expect(errors.some((m) => m.startsWith('kakadu-kinderhoerspiel: Zustimmung fehlt (permission.granted): Schriftliche Zustimmung von Deutschlandradio'))).toBe(true);
    expect(errors).toContain('kakadu-kinderhoerspiel: Nutzungsbedingungen nicht gelesen: kein Stand für https://www.kakadu.de/nutzungsbedingungen-106.html in sources/terms-hashes.json');
    // Ohrenbär is offered only as links to its episodes on ARD Sounds: no permission needed to show them.
    expect(errors.some((m) => m.startsWith('rbb-ohrenbaer: Zustimmung fehlt'))).toBe(false);
    expect(errors).toContain('radio-klops: aktive Einträge ohne freie Lizenz brauchen rights.termsUrl (die Nutzungsbedingungen)');
    // OHRKA is a link entry: only titles and links to its own pages, the family downloads there (owner's rule for providers without a free licence).
    expect(errors.some((m) => m.startsWith('ohrka: Zustimmung fehlt'))).toBe(false);
    const noAges = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
    const ohrka = noAges.entries.find((e) => e.id === 'ohrka')!;
    delete (ohrka.items as Record<string, unknown>[])[0].ages;
    expect(validateCatalog(noAges, NOW).errors).toContain('ohrka: Alice im Wunderland, gelesen von Katharina Thalbach: aktive Link-Einträge brauchen eine Altersangabe je Titel');
  });

  it('takes a link title’s own picture only on the host of the entry, of its page or a known cover host', () => {
    const cover = (url: string) => {
      const c = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
      ((c.entries.find((e) => e.id === 'ohrka')!.items as Record<string, unknown>[])[0]).cover = url;
      return validateCatalog(c, NOW).errors.filter((m) => m.includes('cover'));
    };
    expect(cover('https://www.ohrka.de/fileadmin/bilder/pl_wunderland.png')).toEqual([]);
    expect(cover('https://api.ardmediathek.de/image-service/images/urn:ard:image:0d88e0606cb1fdbc?w=448&ch=069892e33ee1a2ba')).toEqual([]);
    expect(cover('https://bilder.example/alice.png')).toEqual([
      'ohrka: Alice im Wunderland, gelesen von Katharina Thalbach: cover ist keine https-Adresse auf dem Host der Quelle oder einem bekannten Bilder-Host',
    ]);
    expect(cover('http://www.ohrka.de/fileadmin/bilder/pl_wunderland.png')).toHaveLength(1);
  });

  it('takes the day a link title goes offline only as YYYY-MM-DD', () => {
    const until = (v: unknown) => {
      const c = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
      ((c.entries.find((e) => e.id === 'br-pumuckl-folgen')!.items as Record<string, unknown>[])[0]).until = v;
      return validateCatalog(c, NOW).errors.filter((m) => m.includes('until'));
    };
    expect(until('2027-10-02')).toEqual([]);
    expect(until('02.10.2027')).toEqual(['br-pumuckl-folgen: Pumuckl und das Schlossgespenst: until ist kein Tag (JJJJ-MM-TT)']);
    expect(until('2027-10-02T10:00:00Z')).toHaveLength(1);
  });

  it('lets a podcast offered only as a link go live without the permission to save it through the app', () => {
    const live = (delivery: string) => (e: Record<string, unknown>) => Object.assign(e, { status: 'active', review: { by: 'R', at: '2026-10-01', next: '2027-04-01' }, openChecks: [], delivery });
    const needed = { permission: { needed: 'Schriftliche Zustimmung von Deutschlandradio' } };
    const missing = (delivery: string) =>
      validateCatalog(withEntry((e) => live(delivery)(Object.assign(e, needed)), 'kakadu-kinderhoerspiel'), NOW).errors.some((m) => m.includes('Zustimmung fehlt'));
    expect(missing('direct')).toBe(true);
    expect(missing('browser')).toBe(false);
  });

  it('asks a source waiting for permission to say which permission', () => {
    expect(validateCatalog(withEntry((e) => (e.status = 'waiting-permission'), 'br-geschichten-fuer-kinder'), NOW).errors).toContain('br-geschichten-fuer-kinder: waiting-permission braucht permission mit needed');
    expect(validateCatalog(withEntry((e) => (e.permission = { needed: 'Zustimmung des rbb', granted: { by: 'rbb' } }), 'rbb-ohrenbaer'), NOW).errors).toContain(
      'rbb-ohrenbaer: permission.granted braucht by, at (Datum) und filed (wo die schriftliche Antwort liegt)',
    );
  });

  it('pins what a person checked: a commit for Global Storybooks, the files with sha1 for albums', () => {
    const active = (e: Record<string, unknown>) => Object.assign(e, { status: 'active', openChecks: [], review: { by: 'R', at: '2026-10-01', next: '2027-04-01' } });
    expect(validateCatalog(withEntry((e) => active(Object.assign(e, { ref: 'master' })), 'global-storybooks-de'), NOW).errors).toEqual([
      'global-storybooks-de: aktive Einträge brauchen als ref einen Commit (40 Hex-Zeichen), keinen Branch',
    ]);
    expect(validateCatalog(withEntry((e) => active(e), 'global-storybooks-de'), NOW).errors).toEqual([]);
    expect(validateCatalog(withEntry((e) => active(e), 'jamendo-139374-eckhardt'), NOW).errors).toEqual(['jamendo-139374-eckhardt: aktive Alben brauchen files: die angehörten Dateien mit sha1']);
    expect(validateCatalog(withEntry((e) => active(Object.assign(e, { files: [{ name: 'a.mp3', sha1: 'kurz' }] })), 'jamendo-139374-eckhardt'), NOW).errors).toEqual([
      'jamendo-139374-eckhardt: files braucht je Datei name und sha1 (40 Hex-Zeichen)',
    ]);
    expect(validateCatalog(withEntry((e) => active(Object.assign(e, { files: [{ name: 'a.mp3', sha1: 'a'.repeat(40) }] })), 'jamendo-139374-eckhardt'), NOW).errors).toEqual([]);
  });

  it('checks titles, standing sentences and link hosts', () => {
    const errors = (patch: (e: Record<string, unknown>) => void) => validateCatalog(withEntry(patch), NOW).errors;
    expect(errors((e) => (e.titlePattern = 'Folge \\d+: '))).toContain('radio-klops: titlePattern ist kein Muster, das mit ^ beginnt');
    expect(errors((e) => (e.titlePattern = '^('))).toContain('radio-klops: titlePattern „^(“ ist ungültig');
    expect(errors((e) => (e.dropCounter = 'ja'))).toContain('radio-klops: dropCounter ist nicht true');
    expect(errors((e) => (e.titleOverrides = { 'ohrka/x': 'Titel' }))).toContain('radio-klops: titleOverrides braucht je Schlüssel dieses Eintrags einen Titel');
    expect(errors((e) => (e.ignorePhrases = ['Mord']))).toContain('radio-klops: ignorePhrases ist keine Liste von Sätzen (mindestens drei Wörter)');
    expect(errors((e) => (e.linkHosts = ['dts.podtrac.com']))).toContain('radio-klops: linkHost dts.podtrac.com ist ein Messdienst');
    expect(errors((e) => Object.assign(e, { titlePattern: '^Folge \\d+: ', titleOverrides: { 'radio-klops/1': 'Eins' }, ignorePhrases: ['Hört rein bei Radio Klops!'], linkHosts: ['radioklops.de'] }))).toEqual([]);
  });
});

describe('validateReleased', () => {
  it('reads the released list and its age overrides', () => {
    const r = validateReleased({ format: 1, released: [{ key: 'global-storybooks-de/0262', by: 'Redaktion', at: '2026-10-12', note: 'angehört, ab 6', ages: { min: 6, max: 9 } }] }, realCatalog());
    expect(r.errors).toEqual([]);
    expect(r.released[0].ages).toEqual({ min: 6, max: 9 });
  });

  it('refuses unknown entries, duplicates and bad ages', () => {
    const r = validateReleased(
      {
        format: 1,
        released: [
          { key: 'gibt-es-nicht/1', by: 'R', at: '2026-10-12' },
          { key: 'radio-klops/a', by: 'R', at: '2026-10-12' },
          { key: 'radio-klops/a', by: 'R', at: '2026-10-12', ages: { min: 20 } },
        ],
      },
      realCatalog(),
    );
    expect(r.errors).toEqual([
      'released.json: gibt-es-nicht/1 gehört zu keinem Eintrag im Katalog',
      'released.json: radio-klops/a doppelt',
      'released.json: radio-klops/a: Altersangabe ungültig',
    ]);
  });

  it('accepts the file in the repository', () => {
    const raw = JSON.parse(readFileSync(new URL('../../sources/released.json', import.meta.url), 'utf8'));
    expect(validateReleased(raw, realCatalog()).errors).toEqual([]);
  });
});

describe('validateIndex', () => {
  const { sample } = buildSample();

  it('reads the sample index unchanged', () => {
    const parsed = parseIndex(JSON.parse(JSON.stringify(sample)));
    expect(parsed).not.toBeNull();
    expect(parsed).not.toBe('needs-update');
    if (parsed && parsed !== 'needs-update') {
      expect(parsed.dropped).toEqual([]);
      expect(parsed.index).toEqual(JSON.parse(JSON.stringify(sample)));
    }
  });

  it('asks for an update for a newer format and refuses garbage', () => {
    expect(validateIndex({ ...sample, format: 2 })).toBe('needs-update');
    expect(validateIndex({ ...sample, format: '1' })).toBeNull();
    expect(validateIndex('<html>')).toBeNull();
    expect(validateIndex({ ...sample, generatedAt: 'gestern' })).toBeNull();
  });

  it('drops malformed entries and items but keeps the rest', () => {
    const raw = clone(sample) as unknown as { entries: Record<string, unknown>[] };
    (raw.entries[0].items as Record<string, unknown>[])[0].files = [{ url: 'http://plain.example/a.mp3', name: 'a.mp3' }];
    raw.entries[1].rights = { kind: 'cc', id: 'by', version: '3.0', url: 'https://example.org/' };
    raw.entries.push({ id: 'kaputt' });
    const r = parseIndex(raw);
    if (!r || r === 'needs-update') throw new Error('unreadable');
    expect(r.index.entries.map((e) => e.id)).not.toContain('srf-kids-hoerspiele');
    expect(r.index.entries.find((e) => e.id === 'kakadu-kinderhoerspiel')!.items).toHaveLength(2);
    expect(r.index.entries).toHaveLength(5);
    expect(r.dropped).toHaveLength(3);
  });

  it('keeps only known fields', () => {
    const raw = clone(sample) as unknown as { entries: Record<string, unknown>[] };
    raw.entries[0].internal = 'nur für uns';
    expect(JSON.stringify(validateIndex(raw))).not.toContain('internal');
  });

  it('keeps the day a title goes offline, and leaves out one that is not a day', () => {
    const raw = clone(sample) as unknown as { entries: { items: Record<string, unknown>[] }[] };
    raw.entries[0].items[0].until = '2027-01-07';
    raw.entries[0].items[1].until = 'bald';
    const r = validateIndex(raw);
    if (!r || r === 'needs-update') throw new Error('unreadable');
    expect(r.entries[0].items.map((i) => i.until)).toEqual(['2027-01-07', undefined, ...r.entries[0].items.slice(2).map(() => undefined)]);
  });
});
