import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHash, routeToHash } from '../../src/app/router';
import { checkHealth } from '../../src/core/tonuino/health';
import { describeCard, modifierCard, modifiersFor } from '../../src/core/tonuino/modes';
import { nextFolderNumber, scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import { SETTING_TEXTS } from '../../src/features/settings/options';
import { readyMadeShutdownFits } from '../../src/core/firmware/variants';
import { searchHelp } from '../../src/features/help/search';
import {
  HELP_ALIASES,
  HELP_TOPICS,
  blockTexts,
  findSection,
  findTopic,
  helpHref,
  helpLinks,
  HELP_PHOTOS,
  isExternal,
  normalizeHelpId,
  pageBlocks,
  parseInline,
  plainText,
  resolveHelp,
  sectionParts,
  termText,
} from '../../src/features/help/topics';
import { FORUM_LINKS } from '../../src/features/help/forum';
import { GLOSSARY, glossaryEntry } from '../../src/features/help/glossary';
import { HELP_ART_IDS } from '../../src/features/help/HelpArt';

/** The tools of the workshop (#/werkstatt/<tool>) the help may link to. */
const WORKSHOP_TOOLS = ['firmware', 'logbuch', 'kartenleser', 'tasten', 'testen', 'loetplan', 'ansagen', 'einstellen', 'usb', 'paket', 'bedienkarte', 'tastensticker'];

const partIds = (s: (typeof HELP_TOPICS)[number]['sections'][number]) => sectionParts(s).parts.flatMap((p) => (p.id ? [p.id] : []));
const allIds = HELP_TOPICS.flatMap((t) => [t.id, ...t.sections.flatMap((s) => [s.id, ...partIds(s)])]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('help ids', () => {
  it('every topic and section id is unique across the whole help', () => {
    const seen = new Set<string>();
    const doubles = allIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(doubles).toEqual([]);
  });

  it('ids can stand in a link as they are', () => {
    for (const id of allIds) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(normalizeHelpId(id)).toBe(id);
      expect(helpHref(id)).toBe(`#/hilfe/${id}`);
    }
  });

  it('every topic has a summary and sections with content', () => {
    for (const t of HELP_TOPICS) {
      expect(t.summary.length, t.id).toBeGreaterThan(20);
      expect(t.sections.length, t.id).toBeGreaterThan(0);
      for (const s of t.sections) expect(s.blocks.length, s.id).toBeGreaterThan(0);
    }
  });

  it('every page says in one sentence what it is about, and opens with something before "Mehr"', () => {
    for (const t of HELP_TOPICS) {
      for (const s of t.sections) {
        expect(s.summary?.length ?? 0, s.id).toBeGreaterThan(20);
        expect(sectionParts(s).main.length, s.id).toBeGreaterThan(0);
        for (const p of sectionParts(s).parts) expect(p.blocks.length, `${s.id}: ${p.title}`).toBeGreaterThan(0);
      }
    }
  });

  it('five categories, as the start page shows them', () => {
    expect(HELP_TOPICS.map((t) => t.id)).toEqual(['probleme', 'musik', 'karten', 'werkstatt', 'app']);
    for (const t of HELP_TOPICS) expect(HELP_ART_IDS, t.id).toContain(t.art);
  });

  it('aliases lead to existing pages and never hide a real id', () => {
    for (const [alias, target] of Object.entries(HELP_ALIASES)) {
      expect(allIds, alias).not.toContain(alias);
      expect(normalizeHelpId(alias), alias).toBe(alias);
      expect(findTopic(target) ?? findSection(target), `${alias} → ${target}`).toBeDefined();
    }
  });
});

describe('links in the help', () => {
  const links = helpLinks();

  it('finds the links of texts and link blocks', () => {
    expect(links.some((l) => l.href === '#/hilfe/ueber')).toBe(true);
    expect(links.some((l) => l.href === '#/werkstatt/firmware' && l.label === 'Firmware aufspielen')).toBe(true);
    expect(links.some((l) => isExternal(l.href))).toBe(true);
  });

  it('every link inside the app leads to a real page, and help links to a real topic or section', () => {
    for (const l of links.filter((x) => !isExternal(x.href))) {
      const where = `${l.section || l.topic}: ${l.href}`;
      expect(l.href, where).toMatch(/^#\//);
      const route = parseHash(l.href);
      // Unknown pages fall back to the start page; the round trip catches typos.
      expect(routeToHash(route), where).toBe(l.href);
      if (route.page === 'help' && route.topic) expect(resolveHelp(route.topic).kind, where).toBe('topic');
      if (route.page === 'workshop' && route.tool) expect(WORKSHOP_TOOLS, where).toContain(route.tool);
    }
  });

  it('a silent box is led to the health check, the announcements and the workshop', () => {
    const hrefs = links.filter((l) => l.section === 'box-bleibt-stumm').map((l) => l.href);
    expect(hrefs).toEqual(expect.arrayContaining(['#/', '#/werkstatt/ansagen', '#/werkstatt/logbuch', '#/werkstatt/firmware']));
    // The page about the announcements leads back for a box that plays no music either.
    expect(links.some((l) => l.section === 'keine-ansagen' && l.href === '#/hilfe/box-bleibt-stumm')).toBe(true);
    for (const raw of ['stumm', 'kein Ton']) {
      const r = resolveHelp(raw);
      expect(r.kind === 'topic' && r.section?.id, raw).toBe('box-bleibt-stumm');
    }
  });

  it('the pages about problems sit where other pages link to them', () => {
    const order = (topic: string) => findTopic(topic)?.sections.map((s) => s.id) ?? [];
    const after = (topic: string, before: string, ...next: string[]) => {
      const list = order(topic);
      const at = list.indexOf(before);
      expect(at, before).toBeGreaterThanOrEqual(0);
      expect(list.slice(at + 1, at + 1 + next.length), `${topic}: after ${before}`).toEqual(next);
    };
    // The most common problems first; the new pages on power and soldering right behind the dropouts they cause.
    after('probleme', 'box-bleibt-stumm', 'box-spielt-nicht-richtig', 'aussetzer', 'box-geht-aus', 'powerbank', 'wackelkontakt', 'stoergeraeusche', 'kratzig');
    after('probleme', 'karte-geht-nicht', 'anlernen-klappt-nicht');
    // Both tests of the box after the Lötplan that leads to them.
    after('werkstatt', 'loetplan', 'logbuch', 'kartenleser-testen');
  });

  it('every page about a problem starts with a short checklist, the most common cause first', () => {
    // The pattern of a problem page: a sentence how you notice it, then at most six points to check.
    const without = ['geschenkt', 'keine-ansagen'];
    for (const s of findTopic('probleme')!.sections) {
      if (without.includes(s.id)) continue;
      const checks = sectionParts(s).main.filter((b) => b.kind === 'checks');
      expect(checks.length, s.id).toBeGreaterThan(0);
      for (const c of checks) expect(c.kind === 'checks' && c.items.length, s.id).toBeLessThanOrEqual(6);
    }
    // The way into the box is linked from where people pick or set up their SD card.
    expect(links.some((l) => l.section === 'album-hinzufuegen' && l.href === '#/hilfe/sd-karte-herausnehmen')).toBe(true);
    expect(links.some((l) => l.part === 'neue-sd-karte' && l.href === '#/hilfe/album-hinzufuegen')).toBe(true);
  });

  it('loose contacts and bad solder joints have their page, and the pages on their symptoms lead there (TODO 0.3 #28)', () => {
    for (const from of ['box-bleibt-stumm', 'box-spielt-nicht-richtig', 'aussetzer', 'tasten', 'stoergeraeusche', 'kratzig', 'zu-laut-beim-start', 'loetplan', 'logbuch']) {
      expect(links.some((l) => l.section === from && l.href === '#/hilfe/wackelkontakt'), from).toBe(true);
    }
    const page = findSection('wackelkontakt')!.section;
    expect(page.blocks.some((b) => b.kind === 'bild' && b.art === 'loetstelle')).toBe(true);
    expect(blockTexts(page.blocks.find((b) => b.kind === 'checks')!).join(' ')).toContain('Holzstäbchen');
    for (const raw of ['Lötstelle', 'kalte Lötstelle', 'Wackler']) expect(resolveHelp(raw).kind === 'topic' && (resolveHelp(raw) as { section?: { id: string } }).section?.id, raw).toBe('wackelkontakt');
  });

  it('the power bank page names causes and fixes and only links to the safe loudness elsewhere (TODO 0.3 #27, #31)', () => {
    const text = pageBlocks('powerbank').flatMap(blockTexts).join(' ');
    // TNG has no keep-alive: the page must not promise one.
    expect(text).toContain('Eine Funktion, die die Powerbank wach hält, hat sie nicht.');
    expect(text).toMatch(/Knopf an der Powerbank/);
    expect(text).toMatch(/LED/);
    expect(text).toContain('Pololu');
    for (const from of ['box-bleibt-stumm', 'aussetzer', 'box-geht-aus']) expect(links.some((l) => l.section === from && l.href === '#/hilfe/powerbank'), from).toBe(true);
    // The crackling page sends to the setting in the workshop; it does not set anything itself.
    expect(links.filter((l) => l.section === 'kratzig').map((l) => l.href)).toContain('#/werkstatt/einstellen');
    expect(links.some((l) => l.section === 'box-einstellen' && l.href === '#/hilfe/kratzig')).toBe(true);
  });

  it('names no tool the app does not have yet', () => {
    // Links into the workshop are checked against WORKSHOP_TOOLS above; a tool that comes later adds itself there.
    const all = HELP_TOPICS.flatMap((t) => t.sections.flatMap((s) => s.blocks.flatMap(blockTexts))).map(plainText).join('\n');
    for (const name of ['Neu umwandeln', 'Karte gründlich prüfen', 'Tasten prüfen']) expect(all, name).not.toContain(name);
  });

  it('sends a box that needs pure numbers to the announcements tool, not to the health check', () => {
    // The health check renames system files with the wrong number of digits, not ones with text after the number.
    const hrefs = links.filter((l) => l.section === 'anlernen-klappt-nicht').map((l) => l.href);
    expect(hrefs).toContain('#/werkstatt/ansagen');
    const text = findSection('anlernen-klappt-nicht')!.section.blocks.flatMap(blockTexts).map(plainText).join('\n');
    expect(text).toContain('Nur Nummern als Dateinamen');
    expect(text).not.toMatch(/korrigiert der Gesundheitscheck/);
  });

  it('noises lead to their own page', () => {
    for (const raw of ['knacken', 'Knattern', 'tackern', 'Rauschen', 'brummen']) {
      const r = resolveHelp(raw);
      expect(r.kind === 'topic' && r.section?.id, raw).toBe('stoergeraeusche');
    }
  });

  it('links that leave the app use https', () => {
    for (const l of links.filter((x) => isExternal(x.href))) expect(l.href, l.label).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]+(\/|$)/);
  });

  it('forum links lead to threads of the TonUINO forum, at most one per page, with the title checked (TODO 0.3 #44)', () => {
    expect(FORUM_LINKS.length).toBeGreaterThan(10);
    const ids = new Set<number>();
    for (const f of FORUM_LINKS) {
      expect(f.url, f.title).toMatch(/^https:\/\/discourse\.voss\.earth\/t\/\d+$/);
      expect(f.url).toBe(`https://discourse.voss.earth/t/${f.id}`);
      expect(f.title.trim().length, String(f.id)).toBeGreaterThan(5);
      expect(f.checked, String(f.id)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(ids.has(f.id), String(f.id)).toBe(false);
      ids.add(f.id);
    }
    for (const t of HELP_TOPICS) for (const s of t.sections) if (s.forum !== undefined) expect(ids.has(s.forum), `${s.id}: ${s.forum}`).toBe(true);
    const threads = links.filter((l) => l.href.startsWith('https://discourse.voss.earth/t/'));
    // The texts link no thread themselves: one at the end of a page, others as buttons in a part (#94: TNG, Tonertransfer).
    expect(threads.filter((l) => l.from === 'text')).toEqual([]);
    const atEnd = threads.filter((l) => l.from === 'forum');
    expect(atEnd.length).toBe(HELP_TOPICS.flatMap((t) => t.sections).filter((s) => s.forum !== undefined).length);
    expect(new Set(atEnd.map((l) => l.section)).size).toBe(atEnd.length);
    // Every thread, wherever it is linked, is in forumLinks.json, so the check script compares its title.
    const known = new Set(FORUM_LINKS.map((f) => f.url));
    for (const l of threads) expect(known.has(l.href), `${l.section}: ${l.href}`).toBe(true);
  });

  it('links out to the build guide, the Kompendium and the TNG threads (TODO 0.3 #94)', () => {
    const at = (href: string) => links.filter((l) => l.href === href).map((l) => l.part ?? (l.section || l.topic));
    expect(at('https://www.voss.earth/tonuino/')).toEqual(['loetplan']);
    expect(at('https://bluetchen.de/FSU/TonUINO_FSU.html')).toEqual(['probleme']);
    expect(at('https://discourse.voss.earth/t/13923')).toEqual(['an-der-box', 'tng-nachlesen']);
    expect(at('https://discourse.voss.earth/t/13947')).toEqual(['tng-nachlesen']);
    expect(at('https://discourse.voss.earth/t/5972')).toEqual(['dank']);
    expect(at('https://discourse.voss.earth/t/13564')).toEqual(['karten-bedrucken']);
    expect(at('#/werkstatt/tastensticker')).toEqual(['tasten-sticker']);
    expect(HELP_TOPICS.find((t) => t.id === 'probleme')?.footnote).toContain('Kompendium');
  });

  it('Tonertransfer: laser, not mirrored; fatsort with a backup; ARASAAC with its licence (TODO 0.3 #94)', () => {
    const text = (id: string) => pageBlocks(id).flatMap(blockTexts).join(' ');
    expect(text('karten-bedrucken')).toContain('Laserdrucker');
    expect(text('karten-bedrucken')).toContain('Nicht gespiegelt');
    expect(text('karten-bedrucken')).toContain('Ganze Karten zum Ausschneiden (A4)');
    expect(text('ohne-formatieren')).toMatch(/FAT Sorter.*fatsort.*Sichere die Karte/);
    expect(text('piktogramme')).toContain('CC BY-NC-SA 4.0');
    expect(text('piktogramme')).toContain('Piktogramm: Sergio Palao, ARASAAC (arasaac.org), CC BY-NC-SA');
    expect(text('piktogramme')).toContain('Regierung von Aragón');
    expect(searchHelp('Tonertransfer').hits[0]?.id).toBe('karten-bedrucken');
    expect(searchHelp('FAT Sorter').hits[0]?.id).toBe('ohne-formatieren');
    expect(searchHelp('ARASAAC').hits[0]?.id).toBe('piktogramme');
  });

  it('links from the rest of the app into the help resolve', () => {
    const src = fileURLToPath(new URL('../../src/', import.meta.url));
    const found = new Set<string>();
    for (const file of sourceFiles(src)) {
      if (file.includes(`${join('features', 'help')}`)) continue;
      const text = readFileSync(file, 'utf8');
      // Literal ids only; the router's own template (`#/hilfe/${r.topic}`) is no link.
      for (const m of text.matchAll(/#\/hilfe\/([A-Za-z0-9][\w%-]*)/g)) found.add(decodeURIComponent(m[1]));
      for (const m of text.matchAll(/page: 'help', topic: '([^']+)'/g)) found.add(m[1]);
    }
    for (const t of Object.values(SETTING_TEXTS)) if (t.help) found.add(t.help);
    // BoxPage sends people here when the browser cannot open the SD card.
    expect(found).toContain('browser');
    expect(found).toContain('ueber');
    // The cards page explains which cards to buy.
    expect(found).toContain('kartentypen');
    for (const id of found) expect(resolveHelp(id).kind, id).toBe('topic');
  });
});

describe('texts', () => {
  it('every word marked for the Wörterbuch is in it, and every entry has a short text', () => {
    for (const t of HELP_TOPICS) {
      for (const s of t.sections) {
        for (const text of s.blocks.flatMap(blockTexts)) {
          for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) expect(glossaryEntry(m[2] ?? m[1]), `${s.id}: ${m[0]}`).toBeDefined();
        }
      }
    }
    for (const e of GLOSSARY) {
      expect(e.text.length, e.id).toBeLessThan(320);
      expect(e.text, e.id).not.toContain('[[');
    }
    for (const word of ['TNG', 'DFPlayer', 'AiO', 'Admin-Menü', 'Modifikationskarte', 'Standby-Timer', 'kalte Lötstelle']) expect(glossaryEntry(word), word).toBeDefined();
  });

  it('every drawn picture exists and says in words what it shows', () => {
    for (const t of HELP_TOPICS) {
      for (const s of t.sections) {
        for (const b of s.blocks) {
          if (b.kind !== 'bild') continue;
          expect(HELP_ART_IDS, s.id).toContain(b.art);
          expect(b.caption.length, s.id).toBeGreaterThan(30);
        }
      }
    }
  });

  it('every screenshot is in public/hilfe, small, with its real size, and says in words what it shows', () => {
    // Width and height of a WebP file, from the header of its first chunk.
    const webpSize = (buf: Buffer) => {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
      }
      return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
    };
    const used = new Set<string>();
    for (const t of HELP_TOPICS) {
      for (const s of t.sections) {
        for (const b of s.blocks) {
          if (b.kind !== 'foto') continue;
          used.add(b.photo);
          expect(b.caption.length, s.id).toBeGreaterThan(30);
        }
      }
    }
    for (const [id, photo] of Object.entries(HELP_PHOTOS)) {
      expect(used.has(id), id).toBe(true);
      const buf = readFileSync(fileURLToPath(new URL(`../../public/${photo.file}`, import.meta.url)));
      expect(buf.toString('ascii', 0, 4) + buf.toString('ascii', 8, 12), id).toBe('RIFFWEBP');
      expect(webpSize(buf), id).toEqual([photo.width, photo.height]);
      expect(buf.length, id).toBeLessThan(60_000);
    }
  });

  it('markup is complete: no stray ** or half links', () => {
    for (const t of HELP_TOPICS) {
      for (const s of t.sections) {
        for (const b of s.blocks) {
          for (const text of blockTexts(b)) {
            const plain = plainText(text);
            expect(plain, s.id).not.toContain('**');
            expect(plain, s.id).not.toMatch(/\]\(|\[[^\]]*\]$/);
            expect(plain.trim().length, s.id).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('numbers stay on one line with their unit', () => {
    // A plain space lets narrow screens break "100 %" after the number.
    const loose = /\d (?:kbit\/s|MB|GB|dB|%|Minuten|Pixel|MHz|cm)(?!\p{L})|\d ×|× \d/u;
    for (const t of HELP_TOPICS) {
      expect(t.summary, t.id).not.toMatch(loose);
      for (const s of t.sections) for (const b of s.blocks) for (const text of blockTexts(b)) expect(text, s.id).not.toMatch(loose);
    }
  });

  it('says that TonUINO Studio is independent', () => {
    const about = findSection('ueber');
    const text = about?.section.blocks.flatMap(blockTexts).join(' ') ?? '';
    expect(text).toContain('unabhängiges Projekt');
    expect(text).toContain('nicht das offizielle TonUINO-Projekt');
  });

  it('names the licence of the app as in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { license: string };
    const text = findSection('lizenz')?.section.blocks.flatMap(blockTexts).join(' ') ?? '';
    expect(text).toContain(`(${pkg.license})`);
  });
});

describe('statements that follow the code', () => {
  const sectionText = (id: string) => findSection(id)?.section.blocks.flatMap(blockTexts).join(' ') ?? '';

  it('the settings of the box and the box that does not switch off have their sections', () => {
    expect(findSection('box-einstellen')?.topic.id).toBe('werkstatt');
    expect(findSection('box-geht-aus')?.topic.id).toBe('probleme');
    // The page about a box that does not switch off went into the one about switching off.
    expect(resolveHelp('box-geht-nicht-aus')).toMatchObject({ kind: 'topic', section: { id: 'box-geht-aus' } });
    for (const id of ['box-einstellen', 'box-geht-aus']) expect(sectionText(id), id).toContain('](#/werkstatt/einstellen)');
    // Factory values of both firmwares (TNG settings.cpp, 2.1 Tonuino.ino).
    expect(sectionText('box-einstellen')).toContain('Ab Werk sind es 25, 5 und 15.');
    expect(sectionText('box-geht-aus')).toContain('Ab Werk ist er aus');
    // TNG switches off when Pause is held while nothing plays (commands.cpp: pauseLong in idle/pause is shutdown); 2.1 does not.
    // The key is called Play/Pause on every other page (tasten, box-einstellen), so here too.
    expect(sectionText('box-geht-aus')).toContain('**Lang auf Play/Pause gedrückt:** Mit TonUINO TNG schaltet das die Box aus, solange nichts läuft.');
    expect(sectionText('box-geht-aus')).not.toContain('Play/Pause-Taste');
    expect(sectionText('box-geht-aus')).toContain('TonUINO 2.1 kann das nicht.');
  });

  it('a deleted folder number goes to the next album, and the help says so', async () => {
    // Folder 03 was deleted.
    const scan = await scanSd(memDir({ '01': { '001.mp3': 1 }, '02': { '001.mp3': 1 }, '04': { '001.mp3': 1 } }));
    expect(nextFolderNumber(scan)).toBe(3);
    expect(pageBlocks('grenzen').flatMap(blockTexts).join(' ')).toContain('spielen die alten Karten das neue Album');
    expect(sectionText('album-hinzufuegen')).toContain('auch in die Nummer eines Ordners, den du gelöscht hast');
  });

  it('a box that finds no titles after copying by hand is sent to the repairs of the health check first', async () => {
    // Copied one by one: 002.mp3 landed before 001.mp3, and a Mac left a hidden file.
    const scan = await scanSd(memDir({ mp3: { '0001.mp3': 1 }, advert: { '0001.mp3': 1 }, '01': { '002.mp3': 2, '001.mp3': 1, '._001.mp3': 1 } }));
    const issues = checkHealth(scan, { profile: 'tng', trustsDirectoryOrder: true }).issues;
    const order = issues.find((i) => i.fix?.kind === 'rebuild-order')?.fixLabel;
    const junk = issues.find((i) => i.fix?.kind === 'clean-junk')?.fixLabel;
    expect(order).toBeDefined();
    expect(junk).toBeDefined();
    const text = sectionText('box-bleibt-stumm');
    expect(text).toContain(`„${order}“`);
    expect(text).toContain(`„${junk}“`);
    // Formatting the card by hand only comes after the app's own repair.
    expect(text.indexOf(`„${order}“`)).toBeLessThan(text.indexOf('formatierst du die Karte'));
  });

  it('the ready-made firmware switches a Pololu switch, not a CubieKid or carrier board', () => {
    const text = sectionText('firmware');
    expect(text).toContain('Pololu');
    expect(text).toContain('Trägerplatine');
    // Since TNG 3.3.2 the ready-made Classic build drives the shutdown pin for a Pololu switch.
    expect(readyMadeShutdownFits('classic', 'pololu')).toBe(true);
    expect(readyMadeShutdownFits('classic', 'traeger')).toBe(false);
    // No help text sends Pololu owners to a firmware file of their own any more.
    const all = HELP_TOPICS.flatMap((t) => t.sections.flatMap((s) => s.blocks.flatMap(blockTexts))).join('\n');
    expect(all).not.toMatch(/Pololu[^.\n]*(eigene|passende) (Datei|Firmware)/);
    // Each board is named as the app names it, and both cases are spelled out.
    expect(text).toContain('**TonUINO Classic (Arduino Nano):** Mit Pololu-Schalter passt sie. Für die CubieKid- oder Trägerplatine nehme ich eine eigene Fassung');
    expect(text).toContain('**ESP32 Nano:** Mit Pololu-Schalter passt sie. Mit CubieKid- oder Trägerplatine passt sie nicht.');
    expect(text).toContain('**ESP32 WROOM:** Mit CubieKid- oder Trägerplatine passt sie. Mit Pololu-Schalter passt sie nicht.');
    expect(text).not.toContain('umgekehrt');
    expect(readyMadeShutdownFits('esp32wroom', 'traeger')).toBe(true);
    expect(readyMadeShutdownFits('esp32wroom', 'pololu')).toBe(false);
    expect(readyMadeShutdownFits('esp32nano', 'traeger')).toBe(false);
  });

  it('the pages about switching off agree and lead to each other', () => {
    const links = (id: string) => [...sectionText(id).matchAll(/\]\(#\/hilfe\/([^)]+)\)/g)].map((m) => m[1]);
    expect(links('box-geht-aus')).toEqual(expect.arrayContaining(['powerbank', 'box-einstellen', 'firmware', 'spezialkarten']));
    expect(links('firmware')).toContain('box-geht-aus');
    expect(links('powerbank')).toContain('box-geht-aus');
    expect(links('box-einstellen')).toEqual(expect.arrayContaining(['box-geht-aus', 'anlernen-klappt-nicht']));
    expect(links('tasten')).toContain('anlernen-klappt-nicht');
    // Holding Pause switches off with TNG only while nothing plays (commands.cpp: pauseLong is shutdown in idle/pause, track while playing).
    expect(sectionText('box-geht-aus')).toContain('solange nichts läuft. TonUINO 2.1 kann das nicht.');
    // The sleep card: TNG shuts down (modifier.cpp SleepTimer -> shutdown), 2.1 only pauses; every page says the same.
    for (const id of ['box-geht-aus', 'spezialkarten']) expect(sectionText(id), id).toMatch(/2\.1[^.]* (hält|hält sie die Box)[^.]* nur an/);
    // The generated list of special cards on the same page, and the card's description, say no different.
    const sleep = modifiersFor('classic21').find((m) => m.params === 'sleep');
    expect(sleep?.tagline).toBe('Hört nach einer gewählten Zeit auf zu spielen.');
    expect(modifiersFor('tng').find((m) => m.params === 'sleep')?.tagline).toBe(sleep?.tagline);
    expect(describeCard(modifierCard(1, 15), 'classic21')).toBe('Schlummerkarte: hält nach 15 Minuten an.');
    expect(describeCard(modifierCard(1, 15 | 0x80), 'tng')).toBe('Schlummerkarte: schaltet nach 15 Minuten ab, aber erst am Ende des Titels.');
    // A shutdown board is not only the carrier board, and the firmware decides, not the board alone.
    expect(sectionText('box-geht-aus')).not.toContain('Für die Trägerplatine muss die Firmware passend gebaut sein');
    expect(sectionText('box-geht-aus')).toContain('Pololu-Schalter oder eine Abschalt-Platine');
    // The TNG card that stops the timer is the first thing to check when the box stays on (modes.ts code 10, TNG 3.3.2).
    expect(sectionText('box-geht-aus')).toContain('Spezialkarte „Ausschalt-Timer aus“ den Timer ab, bis du sie noch einmal auflegst');
    expect(modifiersFor('tng').find((m) => m.name === 'Ausschalt-Timer aus')?.since).toBe('3.3.2');
  });

  it('end check: the pages about switching off and the buttons say each thing once and agree', () => {
    const count = (id: string, re: RegExp) => (sectionText(id).match(re) ?? []).length;
    // The sleep card on TonUINO 2.1 only pauses: once per page, not twice on the page about the box that stays on.
    expect(count('box-geht-aus', /2\.1[^.]* nur an/g)).toBe(1);
    // The 30 mA of a sleeping box are said under "Sie geht nicht von selbst aus", once.
    expect(count('box-geht-aus', /30\u00a0mA/g)).toBe(1);
    expect(sectionText('box-geht-aus')).not.toContain('geht nie ganz aus');
    // The light of the reader tells sleeping from no power (forum 13833#2, 9949#2).
    expect(plainText(sectionText('box-geht-aus'))).toContain('Licht am Kartenleser');
    // An AiO or a box with a shut-off board that switched itself off with the timer also has the light off.
    expect(sectionText('box-geht-aus')).toContain('oder die Box hat sich mit dem Ausschalt-Timer ganz ausgeschaltet');
    // A long press on Play/Pause switches a TNG box off, so the shortcuts of TNG are on Vor and Zurück (commands.cpp idle column).
    expect(sectionText('box-einstellen')).toContain('Bei TonUINO TNG sind das Vor, Zurück oder beide zusammen, denn Play/Pause lang schaltet dort aus.');
    // TonUINO 2.1 starts shortcut 0 with a long press on Play/Pause (Tonuino.ino, playShortCut(0)).
    expect(sectionText('box-einstellen')).toContain('Bei TonUINO 2.1 sind es Play/Pause, Vor und Zurück.');
    // No advice without a source: the old "spiel die Firmware noch einmal auf" without a reason is gone, the 2.x timer bug (forum 10620) is named.
    expect(sectionText('box-geht-aus')).not.toContain('Spiele die Firmware noch einmal auf:');
    expect(sectionText('box-geht-aus')).toContain('Party-Karte für einen Ordner mit nur einem Titel');
  });

  it('end check: forum facts in the Werkstatt help', () => {
    // Compiler errors of the old sketch (forum 14794, 11809#18): take the ready-made firmware.
    expect(sectionText('firmware')).toContain('„no matching function“ mit Mp3Notify oder OnPlayFinished');
    // A reader at 3.3 V that fails now and then: less gain, not more (forum 14681#14; TNG constants.hpp MRFC522_RX_GAIN).
    expect(sectionText('kartenleser-testen')).toContain('die Verstärkung des Kartenlesers zu senken, nicht zu erhöhen');
    // SPECIAL_START_SHORTCUT plays 01/001 when A6 is high at start (forum 13947#1-2; constants.hpp: off by default).
    expect(sectionText('box-spielt-nicht-richtig')).toContain('100\u00a0kΩ von A6 nach GND');
  });

  it('end check review: no claims beyond the forum and the app', () => {
    // A lit reader does not prove the timer ran out: an AiO or a box without timer may hang after a playback error (forum 10620#1/#6).
    expect(sectionText('box-geht-aus')).not.toContain('dann schläft sie');
    expect(sectionText('box-geht-aus')).toContain('hängt sie vielleicht nach einem Fehler beim Abspielen');
    // The one-title Party stop is no playback error (forum 10620#9/#10): its own item, pointing to the cards page that warns.
    expect(sectionText('box-geht-aus')).toContain('Party-Karte für einen Ordner mit nur einem Titel stehen');
    expect(sectionText('box-geht-aus')).toContain('[Karten beschreiben](#/karten) warnt dich');
    // The LED that keeps a powerbank on in a pause also keeps it on after the timer: one sentence links both pages.
    expect(sectionText('box-geht-aus')).toContain('Hast du eine LED eingebaut, damit die Powerbank in der Pause anbleibt');
    expect(sectionText('box-geht-aus')).not.toContain('Schalter-LED');
    // The heat link of forum 14681 was only a guess ("Vielleicht Zufall", #12).
    expect(sectionText('kartenleser-testen')).toContain('die Wärme vermutet, sicher ist das nicht');
    expect(sectionText('kartenleser-testen')).not.toContain('kamen und gingen mit der Wärme');
    // The app does not read the start shortcut, so the item does not say "Das prüft die App".
    expect(sectionText('box-spielt-nicht-richtig')).toContain('**Das ist so eingestellt:** Hat die Box eine Kurzwahl „Beim Einschalten“');
    expect(sectionText('box-spielt-nicht-richtig')).not.toMatch(/Das prüft die App:\*\* Mit einer Kurzwahl/);
  });

  it('keeps the shutdown pages for "akku leer obwohl aus" and finds the battery pling', () => {
    expect(searchHelp('akku leer obwohl aus').hits.slice(0, 3).map((h) => h.id)).toContain('box-geht-aus');
    expect(searchHelp('powerbank ist leer obwohl box aus').hits.slice(0, 3).map((h) => h.id)).toContain('box-geht-aus');
    for (const q of ['pling', 'ping', 'piept immer wieder']) {
      expect(searchHelp(q).hits.slice(0, 3).map((h) => h.id), q).toContain('stoergeraeusche');
    }
    expect(sectionText('stoergeraeusche')).toContain('**Ein kurzer Pling, immer wieder:**');
  });

  it('finds the shutdown help with the words a parent types', () => {
    for (const q of ['ausschalten', 'abschalten', 'abschaltung', 'box geht sofort wieder aus', 'box geht gleich wieder aus', 'box schaltet sich nicht aus']) {
      expect(searchHelp(q).hits.slice(0, 3).map((h) => h.id), q).toContain('firmware');
    }
  });
});

describe('parseInline', () => {
  it('splits bold text and links', () => {
    expect(parseInline('Öffne [Hinzufügen](#/hinzufuegen) **jetzt**.')).toEqual([
      { kind: 'text', text: 'Öffne ' },
      { kind: 'link', text: 'Hinzufügen', href: '#/hinzufuegen' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'jetzt' },
      { kind: 'text', text: '.' },
    ]);
    expect(plainText('Mehr unter [Cover](#/hilfe/cover).')).toBe('Mehr unter Cover.');
  });

  it('reads words of the Wörterbuch and links inside bold text', () => {
    const [bold, rest] = parseInline('**Der [[Ausschalt-Timer]]** schaltet aus.');
    expect(bold).toEqual({ kind: 'strong', text: 'Der Ausschalt-Timer', inner: 'Der [[Ausschalt-Timer]]' });
    expect(rest).toEqual({ kind: 'text', text: ' schaltet aus.' });
    expect(plainText('**Mehr unter [Cover](#/hilfe/cover)**')).toBe('Mehr unter Cover');
  });

  it('leaves no markup in any text of the help as people read it', () => {
    for (const t of HELP_TOPICS) {
      for (const s of t.sections) {
        for (const text of s.blocks.flatMap(blockTexts)) expect(plainText(text), s.id).not.toMatch(/\*\*|\[\[|\]\]|\]\(/);
      }
    }
  });
});

describe('resolveHelp', () => {
  it('shows the overview without an id', () => {
    expect(resolveHelp(undefined)).toEqual({ kind: 'index' });
    expect(resolveHelp('  ')).toEqual({ kind: 'index' });
  });

  it('opens a topic, or the topic of a section scrolled to the section', () => {
    const topic = resolveHelp('musik');
    expect(topic.kind === 'topic' && topic.topic.id).toBe('musik');
    expect(topic.kind === 'topic' && topic.section).toBeUndefined();
    const section = resolveHelp('lautstaerke');
    expect(section.kind === 'topic' && [section.topic.id, section.section?.id]).toEqual(['musik', 'lautstaerke']);
  });

  it('understands umlauts, capitals, spaces and other words for a page', () => {
    for (const raw of ['Lautstärke', 'LAUTSTAERKE', ' lautstärke ']) {
      const r = resolveHelp(raw);
      expect(r.kind === 'topic' && r.section?.id, raw).toBe('lautstaerke');
    }
    const faq = resolveHelp('FAQ');
    expect(faq.kind === 'topic' && faq.topic.id).toBe('probleme');
    // A part of a page: the page opens there.
    const reader = resolveHelp('acr122u');
    expect(reader.kind === 'topic' && [reader.section?.id, reader.part?.id]).toEqual(['vier-wege', 'kartenleser']);
    const about = resolveHelp('Über');
    expect(about.kind === 'topic' && about.section?.id).toBe('ueber');
    // Firefox and Safari: the Paket.
    for (const raw of ['paket', 'ZIP', 'entpacken']) {
      const r = resolveHelp(raw);
      expect(r.kind === 'topic' && r.section?.id, raw).toBe('paket');
    }
    const firefox = resolveHelp('firefox');
    expect(firefox.kind === 'topic' && firefox.part?.id).toBe('browser-kann-das-nicht');
  });

  it('reports unknown pages with the id as given', () => {
    expect(resolveHelp('gibt-es-nicht')).toEqual({ kind: 'missing', id: 'gibt-es-nicht' });
  });

  it('works with the ids the router hands over', () => {
    const route = parseHash('#/hilfe/Lautst%C3%A4rke');
    expect(route).toEqual({ page: 'help', topic: 'Lautstärke' });
    const r = resolveHelp(route.page === 'help' ? route.topic : undefined);
    expect(r.kind === 'topic' && r.section?.id).toBe('lautstaerke');
  });
});

describe('normalizeHelpId', () => {
  it('folds case, umlauts, accents and spaces', () => {
    expect(normalizeHelpId('Lautstärke')).toBe('lautstaerke');
    expect(normalizeHelpId(' SD Karte ')).toBe('sd-karte');
    expect(normalizeHelpId('Über')).toBe('ueber');
    expect(normalizeHelpId('Größe')).toBe('groesse');
    expect(normalizeHelpId('Café_Musik')).toBe('cafe-musik');
  });
});

describe('help for Firefox and Safari', () => {
  const textOf = (id: string) => findSection(id)!.section.blocks.flatMap(blockTexts).join(' ');

  it('names the buttons they see where the steps name a button', () => {
    expect(textOf('album-hinzufuegen')).toContain('„Ins Paket für die Karte“');
    expect(textOf('album-hinzufuegen')).toContain('(#/hilfe/paket)');
    expect(textOf('keine-ansagen')).toContain('„Herunterladen und ins Paket legen“');
    expect(textOf('keine-ansagen')).toContain('(#/hilfe/paket)');
  });

  it('do not promise them an order check the app cannot do there', () => {
    for (const id of ['box-bleibt-stumm', 'falsche-titel']) {
      const text = textOf(id);
      expect(text, id).toContain('In Firefox und Safari sehe ich die Reihenfolge auf der Karte nicht.');
      expect(text, id).toContain('(#/hilfe/karte-neu-aufbauen)');
    }
    expect(textOf('falsche-titel')).toContain('In Chrome, Edge und der Desktop-App prüfe ich das nach dem Übertragen');
  });
});

describe('rebuilding the card', () => {
  const textOf = (id: string) => findSection(id)!.section.blocks.flatMap(blockTexts).join(' ');

  it('is offered everywhere, not only for the Paket', () => {
    const section = findSection('karte-neu-aufbauen')!.section;
    expect(section.packageOnly).toBeFalsy();
    const text = textOf('karte-neu-aufbauen');
    expect(text).toContain('„Karte neu aufbauen …“');
    expect(text).toContain('„Auf eine neue Karte umziehen …“');
    expect(text).toContain('„Sicherung zurückspielen …“');
    expect(text).toContain('In Firefox und Safari');
  });

  it('no longer has families back up and add every album again by hand', () => {
    for (const id of ['sd-karte-geht-nicht', 'box-bleibt-stumm']) {
      const text = textOf(id);
      expect(text, id).toContain('(#/hilfe/karte-neu-aufbauen)');
      expect(text, id).not.toMatch(/Kopiere alles|kopiere alles in einem Rutsch|spiel deine Hörspiele wieder auf|wieder in denselben Ordner/);
    }
    expect(textOf('box-spielt-nicht-richtig')).toContain('(#/hilfe/karte-neu-aufbauen)');
  });

  it('tells families with more than one box what works where', () => {
    const text = textOf('mehrere-boxen');
    expect(text).toContain('Karten laufen auf jeder Box, deren SD-Karte den Ordner mit derselben Nummer hat.');
    expect(text).toContain('Wo ein Hörbuch steht, merkt sich jede Box selbst.');
    expect(text).toContain('Handy oder iPad reichen dafür nicht');
    expect(text).toContain('„Auf eine andere SD-Karte kopieren …“');
    expect(textOf('was-die-karte-speichert')).toContain('(#/hilfe/mehrere-boxen)');
  });

  it('only promises what the app checks and saves', () => {
    const text = textOf('karte-neu-aufbauen');
    // The browser cannot see a card's format.
    expect(text).toContain('Ich prüfe, ob die Karte leer ist. In der Desktop-App prüfe ich auch, ob die Karte mit FAT32 formatiert ist');
    // The system tools of Mac and Linux do not give 32 KB.
    expect(text).not.toContain('FAT32, Zuordnungseinheit 32 KB, keine Schnellformatierung');
    expect(text).toContain('„Overwrite format“');
    // The button label the forum names, not a translation nobody checked.
    expect(textOf('sd-karte-geht-nicht')).not.toContain('„Überschreiben“');
    for (const id of ['sd-karte-geht-nicht', 'box-bleibt-stumm', 'box-spielt-nicht-richtig']) expect(textOf(id), id).not.toMatch(/sichert alles(?!, was die Box abspielt)/);
  });

  it('copies to a folder and the announcements the way the box needs them', () => {
    const text = textOf('mehrere-boxen');
    expect(text).toContain('Kopiere danach den Inhalt dieses Ordners, nicht den Ordner selbst');
    expect(text).toContain('zuerst die Ordner mp3 und advert');
    expect(text).toContain('nur, wenn die andere Box dieselbe Firmware hat');
    expect(text).toContain('(#/werkstatt/ansagen)');
  });

  it('sends a new card that replaces an old one to the move, not to starting over', () => {
    const text = textOf('neue-sd-karte');
    expect(text).toContain('„Auf eine neue Karte umziehen …“');
    expect(text).toContain('„Sicherung zurückspielen …“');
    expect(text).toContain('(#/hilfe/karte-neu-aufbauen)');
  });
});

describe('words of the Wörterbuch', () => {
  it('do not send you to the page you are on', () => {
    const entry = glossaryEntry('kalte Lötstelle')!;
    expect(entry.text).toContain('(#/hilfe/wackelkontakt)');
    expect(termText(entry, 'wackelkontakt')).toBe('Eine Lötstelle, bei der das Zinn nicht richtig geflossen ist. Sie sieht matt und kugelig aus und hat nur manchmal Kontakt.');
    expect(termText(entry, 'box-bleibt-stumm')).toBe(entry.text);
    expect(termText(entry)).toBe(entry.text);
    // On every page, no marked word links to that page itself.
    for (const t of HELP_TOPICS) {
      for (const s of t.sections) {
        for (const text of s.blocks.flatMap(blockTexts)) {
          for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
            const shown = termText(glossaryEntry(m[2] ?? m[1])!, s.id);
            for (const l of shown.matchAll(/\]\(#\/hilfe\/([^)]+)\)/g)) {
              const to = resolveHelp(l[1]);
              expect(to.kind === 'topic' && to.section?.id === s.id && !to.part, `${s.id}: ${m[0]}`).toBe(false);
            }
            expect(shown.trim().length, `${s.id}: ${m[0]}`).toBeGreaterThan(20);
          }
        }
      }
    }
  });
});

describe('things of 0.3 the help names', () => {
  const textOf = (id: string) => pageBlocks(id).flatMap(blockTexts).join(' ');
  const first = (q: string) => searchHelp(q).hits.slice(0, 3).map((h) => h.id);

  it('the sounds of the app, and when they come', () => {
    const t = textOf('app-einstellen');
    expect(t).toContain('In Firefox und Safari erst, wenn du das Paket auf der Karte geprüft hast.');
    expect(t).toContain('Ich spiele ihn direkt von deiner Karte und bringe ihn nicht mit.');
    expect(t).toContain('**Klack:**');
    expect(t).toContain('**Zweimal Klopfen:**');
    expect(first('Klack')).toContain('app-einstellen');
  });

  it('the Bedienkarte, the reader tools, "Mehr Karten", free minutes and the thorough check', () => {
    expect(textOf('geschenkt')).toContain('(#/werkstatt/bedienkarte)');
    expect(first('Bedienkarte')).toContain('geschenkt');
    expect(textOf('kartenleser')).toContain('„Mehr zum NFC-Leser“');
    expect(first('Karte löschen')).toContain('kartenleser');
    for (const words of ['freier Ordnernummer', 'Zahlen und Bytes', 'Kartenformat für TonUINO 2.0']) expect(textOf('mehr-karten')).toContain(words);
    expect(first('Zahlen und Bytes')).toContain('mehr-karten');
    expect(textOf('spezialkarten')).toContain('mit TNG 1 bis 127');
    expect(textOf('box-spielt-nicht-richtig')).toContain('„Gründlich prüfen“');
    expect(textOf('kopfhoerer')).toContain('„Lautstärke für Kopfhörer“');
    expect(textOf('firmware')).toContain('Nach dem Aufspielen lese ich ihren Start');
    expect(textOf('firmware-extras')).toContain('„Alte Firmware vorher sichern“');
  });

  it('the app gets missing covers by itself, and the privacy text says so', () => {
    const privacy = textOf('datenschutz');
    expect(privacy).toContain('**Fehlende Cover:**');
    expect(privacy).toContain('bis auf fehlende Cover immer erst');
    expect(privacy).toContain('Deezer');
    expect(privacy).not.toContain('Nur bei der Cover-Suche geht der Suchbegriff hinaus, den du im Suchfeld siehst');
    expect(textOf('cover-finden')).toContain('Ein Cover, das schon da ist, ersetze ich nie.');
  });
});

describe('changing or swapping the number of a folder', () => {
  const textOf = (id: string) => pageBlocks(id).flatMap(blockTexts).join(' ');
  const first = (q: string) => searchHelp(q).hits.slice(0, 3).map((h) => h.id);

  it('names the menu entry as the folder page has it, and is found by the words people use', () => {
    const t = textOf('nummer-tauschen');
    // FolderPage.tsx, menu of a folder.
    expect(t).toContain('„Nummer ändern oder tauschen …“');
    expect(t).toContain('auch, wenn alle 99 Nummern belegt sind');
    expect(t).toContain('„Dateien zurücklegen“');
    for (const q of ['Ordner tauschen', 'tauschen', 'Reihenfolge der Ordner', 'Nummer ändern', 'umnummerieren']) expect(first(q), q).toContain('nummer-tauschen');
  });
});

describe('figures instead of cards', () => {
  const text = () => findSection('figuren')?.section.blocks.flatMap(blockTexts).join(' ') ?? '';

  it('is linked from the cards to buy and leads to the ways of writing a card', () => {
    const buy = findSection('kartentypen')?.section.blocks.flatMap(blockTexts).join(' ') ?? '';
    expect(buy).toContain('(#/hilfe/figuren)');
    for (const href of ['#/hilfe/vier-wege', '#/hilfe/kartentypen', '#/hilfe/an-der-box', '#/werkstatt/kartenleser', '#/hilfe/box-einstellen']) {
      expect(text(), href).toContain(`(${href})`);
    }
  });

  it('names what the box reads, as the cards page and the card code do', () => {
    // card.ts and nfc.rs: NTAG21x on pages 8–11; NTAG215 only from TNG 3.2.1, so the page asks for NTAG213.
    expect(text()).toContain('NTAG213');
    expect(text()).not.toContain('NTAG215');
    // Tonies carry an ISO 15693 chip (ICODE SLIX-L), which the MFRC522 of the box does not read.
    expect(text()).toContain('**Tonies** liest die Box nicht');
    // "Karte wegnehmen" is a TNG setting of the box (BoxSettingsTool, box-einstellen).
    expect(text()).toContain('mit TNG unter [Box einstellen](#/hilfe/box-einstellen) ein: „Karte wegnehmen“');
  });
});

describe('NFC reader on Linux', () => {
  it('locks the driver with the same command the desktop app offers, and says how to undo it', async () => {
    const { hintInfo } = await import('../../src/platform/tauri/errors');
    const { LINUX_NFC_BLACKLIST } = await import('../../src/features/help/topics');
    expect(LINUX_NFC_BLACKLIST).toBe(hintInfo({ id: 'linux-blacklist-pn533' }).command);
    const file = /tee (\S+)/.exec(LINUX_NFC_BLACKLIST)![1];
    const topic = HELP_TOPICS.find((t) => t.sections.some((s) => s.blocks.some((b) => b.kind === 'mehr' && b.id === 'nfc-linux')))!;
    const commands = topic.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === 'command' ? [b.command] : []));
    expect(commands).toContain('pcsc_scan');
    expect(commands).toContain(`sudo rm ${file}`);
  });
});
