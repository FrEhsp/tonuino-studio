/**
 * The help of "Entdecken" lives in the help centre: the section "entdecken"
 * of the topic "musik" and its lines in "datenschutz". A build without
 * "Entdecken" (`__SOURCES_ENABLED__` false) has none of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeToHash } from '../../src/app/router';
import { blockTexts, findSection, parseInline, PRIVACY_LOCAL, PRIVACY_ONLINE, PRIVACY_ONLINE_LOCAL, resolveHelp, SOURCES_HELP, sourcesHelpBlocks } from '../../src/features/help/topics';

type Topics = typeof import('../../src/features/help/topics');
type Search = typeof import('../../src/features/help/search');

/** The help as a build with these build constants and settings has it. */
async function helpOf(globals: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ topics: Topics; search: Search }> {
  vi.resetModules();
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return { topics: await import('../../src/features/help/topics'), search: await import('../../src/features/help/search') };
}

function sectionText(t: Pick<Topics, 'findSection' | 'blockTexts'>, id: string): string {
  return t.findSection(id)?.section.blocks.flatMap(t.blockTexts).join('\n') ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('help for "Entdecken"', () => {
  it('splits bold text and links', () => {
    expect(parseInline('Öffne [Entdecken](#/entdecken) **jetzt**.')).toEqual([
      { kind: 'text', text: 'Öffne ' },
      { kind: 'link', text: 'Entdecken', href: '#/entdecken' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'jetzt' },
      { kind: 'text', text: '.' },
    ]);
    expect(parseInline('Nur Text')).toEqual([{ kind: 'text', text: 'Nur Text' }]);
  });

  it('leaves out the part about „Melden“ when the build has no contact address', () => {
    const all = sourcesHelpBlocks(true);
    const without = sourcesHelpBlocks(false);
    expect(all).toBe(SOURCES_HELP.blocks);
    expect(without).toHaveLength(all.length - 2);
    expect(JSON.stringify(without)).not.toContain('Melden');
    expect(JSON.stringify(all)).toContain('Melden');
  });

  it('uses only the allowed words about age and protection', () => {
    const text = JSON.stringify(SOURCES_HELP);
    expect(text).not.toMatch(/kindersicher|\bsicher\b|FSK|freigegeben|unbedenklich/i);
    expect(text).toContain('oder meine Schätzung');
    // There is no editorial team: the list is one person's choice.
    expect(text).not.toMatch(/Redaktion/);
  });

  it('promises nothing for a broadcaster whose terms need its consent first', () => {
    const text = JSON.stringify(SOURCES_HELP);
    // Deutschlandradio's terms need written consent for storing; no example names it.
    expect(text).not.toMatch(/Deutschlandradio|Kakadu/);
    expect(PRIVACY_ONLINE).not.toMatch(/Deutschlandradio/);
  });

  it('keeps private episodes out of the Kita and says where the credit stands', () => {
    const text = JSON.stringify(SOURCES_HELP);
    expect(text).toContain('Spiele sie nicht öffentlich ab, zum Beispiel nicht in der Kita');
    expect(text).not.toContain('etwa für die Kita');
    expect(text).toContain('Dann stehen die Angaben nur in der Liste.');
    expect(text).toContain('„Datei öffnen“');
  });

  it("tells about cookies when listening to files from a publisher's page", () => {
    expect(PRIVACY_ONLINE).toContain('IP-Adresse');
    expect(PRIVACY_ONLINE).toContain('Cookies');
    // ARD's player loads only after a click, and the text says what ARD then sees.
    expect(PRIVACY_ONLINE).toContain('lädt die App den Player von ARD Sounds. Erst dann sieht ARD Sounds deine IP-Adresse');
  });

  it('says that the covers on "Entdecken" come from the sources’ servers', () => {
    expect(PRIVACY_ONLINE).toContain('Auf Entdecken lädt sie außerdem die Coverbilder von den Servern der Quellen');
  });
});

describe('"Entdecken" in the help centre', () => {
  it('is the section "entdecken" of the topic "musik", where the page sends people', () => {
    const r = resolveHelp('entdecken');
    expect(r.kind === 'topic' && [r.topic.id, r.section?.id]).toEqual(['musik', 'entdecken']);
    // "Woher kommen die Inhalte?" on the Entdecken page.
    expect(routeToHash({ page: 'help', topic: 'entdecken' })).toBe('#/hilfe/entdecken');
  });

  it('puts its lines into the privacy section, where the section points to', () => {
    const privacy = findSection('datenschutz')!.section;
    const lists = privacy.blocks.flatMap((b) => (b.kind === 'list' ? [b.items] : []));
    const local = lists.find((items) => items.includes(PRIVACY_LOCAL))!;
    // A list of half sentences: the line of "Entdecken" is not the last one.
    expect(local.indexOf(PRIVACY_LOCAL)).toBeLessThan(local.length - 1);
    expect(local.at(-1)).toMatch(/\.$/);
    // The tests see the desktop app, which builds the list itself.
    expect(privacy.blocks.flatMap(blockTexts).some((t) => t.startsWith(PRIVACY_ONLINE_LOCAL))).toBe(true);
    expect(JSON.stringify(SOURCES_HELP)).toContain('(#/hilfe/datenschutz)');
  });

  it('says where the list comes from: this computer in the desktop app, else the web app', async () => {
    expect(PRIVACY_ONLINE).toContain('lädt die App die Liste von ihrer eigenen Webseite');
    expect(PRIVACY_ONLINE_LOCAL).not.toContain('eigenen Webseite');
    expect(PRIVACY_ONLINE_LOCAL).toContain('höchstens einmal am Tag selbst zusammen');
    expect(PRIVACY_ONLINE_LOCAL).toContain('die Seiten von OHRKA');
    expect(PRIVACY_ONLINE_LOCAL).not.toMatch(/LibriVox/);
    // The desktop app builds the list itself.
    const desktop = await helpOf({ __LOCAL_SOURCES__: true });
    expect(sectionText(desktop.topics, 'datenschutz')).toContain('höchstens einmal am Tag selbst zusammen');
    expect(sectionText(desktop.topics, 'entdecken')).toContain('Download-Ordner');
    // A desktop build pointed at a published list (VITE_SOURCES_INDEX_URL) loads that one.
    const published = await helpOf({ __LOCAL_SOURCES__: false });
    expect(sectionText(published.topics, 'datenschutz')).toContain('lädt die App die Liste von ihrer eigenen Webseite');
    expect(sectionText(published.topics, 'datenschutz')).not.toContain('selbst zusammen');
    const web = await helpOf({ __DESKTOP_BUILD__: false });
    expect(sectionText(web.topics, 'datenschutz')).not.toContain('selbst zusammen');
    expect(sectionText(web.topics, 'entdecken')).not.toContain('Download-Ordner');
  });

  it('tells about „Melden“ only when the build has a contact address', async () => {
    const without = await helpOf({}, { VITE_SOURCES_CONTACT: '' });
    expect(sectionText(without.topics, 'entdecken')).not.toContain('Melden');
    expect(sectionText(without.topics, 'datenschutz')).not.toContain('Melden');

    const withContact = await helpOf({}, { VITE_SOURCES_CONTACT: 'quellen@tonuino-studio.example' });
    expect(sectionText(withContact.topics, 'entdecken')).toContain('schreibe uns über „Melden“');
    expect(sectionText(withContact.topics, 'datenschutz')).toContain('„Melden“ öffnet dein E-Mail-Programm');
  });

  it('leaves "Entdecken" out of a build without it', async () => {
    const { topics, search } = await helpOf({ __SOURCES_ENABLED__: false });
    expect(topics.findSection('entdecken')).toBeUndefined();
    expect(topics.resolveHelp('entdecken')).toEqual({ kind: 'missing', id: 'entdecken' });
    expect(Object.values(topics.HELP_ALIASES)).not.toContain('entdecken');
    expect(JSON.stringify(topics.HELP_TOPICS)).not.toMatch(/Entdecken|#\/entdecken|OHRKA/);
    expect(topics.helpLinks().filter((l) => l.href.startsWith('#/entdecken'))).toEqual([]);
    expect(search.searchHelp('OHRKA').total).toBe(0);
    expect(search.searchHelp('Entdecken').hits.map((h) => h.id)).not.toContain('entdecken');
    // The rest of the privacy section stays.
    expect(sectionText(topics, 'datenschutz')).toContain('Wann die App ins Internet geht');
    expect(sectionText(topics, 'datenschutz')).toContain('Cover-Suche');
  });
});
