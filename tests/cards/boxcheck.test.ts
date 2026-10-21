import { describe, expect, it } from 'vitest';
import { parseHash, routeToHash } from '../../src/app/router';
import { checkHealth, type HealthReport, type Issue } from '../../src/core/tonuino/health';
import { scanSd } from '../../src/core/tonuino/sd';
import { TNG_SYSTEM_SOUNDS } from '../../src/core/tonuino/systemsounds';
import { boxTrouble, SOUNDS_PENDING, soundsNotice, soundsWarning } from '../../src/features/cards/boxcheck';
import { searchHelp } from '../../src/features/help/search';
import { resolveHelp } from '../../src/features/help/topics';
import { memDir, type MemTree } from '../../src/platform/memory';

/** mp3/ and advert/ with every announcement TNG 3.3.3 expects. */
function systemSounds(): { mp3: MemTree; advert: MemTree } {
  const mp3: MemTree = {};
  for (const n of TNG_SYSTEM_SOUNDS.mp3) mp3[`${String(n).padStart(4, '0')}.mp3`] = 10;
  const advert: MemTree = {};
  for (const n of TNG_SYSTEM_SOUNDS.advert) advert[`${String(n).padStart(4, '0')}.mp3`] = 10;
  return { mp3, advert };
}

async function reportFor(tree: MemTree, profile: 'tng' | 'classic21' = 'tng'): Promise<HealthReport> {
  return checkHealth(await scanSd(memDir(tree)), { profile, trustsDirectoryOrder: true });
}

const folder = { '01': { '001.mp3': 1, '002.mp3': 2 } };

function report(...issues: Issue[]): HealthReport {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return { status: counts.error ? 'error' : counts.warning ? 'warning' : 'ok', issues, counts };
}

function issue(id: string, severity: Issue['severity'], title = 'Etwas stimmt nicht'): Issue {
  return { id, severity, title, detail: 'Mehr dazu.' };
}

describe('soundsWarning', () => {
  it('says nothing for a healthy card', async () => {
    const r = await reportFor({ ...systemSounds(), ...folder });
    expect(r.issues).toEqual([]);
    expect(soundsWarning(r)).toBeNull();
    expect(soundsWarning(undefined)).toBeNull();
  });

  it('a card without mp3/ cannot speak at all and gets the sounds installed', async () => {
    const { advert } = systemSounds();
    const w = soundsWarning(await reportFor({ advert, ...folder }))!;
    expect(w.problem).toBe('missing');
    expect(w.tone).toBe('danger');
    expect(w.text).toContain('fehlen');
    expect(w.text).toContain('Oh, eine neue Karte!');
    expect(w.action).toEqual({ kind: 'link', href: '#/werkstatt/ansagen', label: 'Systemansagen installieren' });
  });

  it('a card with mp3/ but without advert/ still speaks in the menus', async () => {
    const { mp3 } = systemSounds();
    const w = soundsWarning(await reportFor({ mp3, ...folder }))!;
    expect(w.problem).toBe('missing');
    expect(w.text).toContain('Ordner advert');
    expect(w.text).not.toContain('beim Anlernen nichts');
  });

  it('an older set of announcements is older than the firmware', async () => {
    const old = systemSounds();
    delete old.mp3['0340.mp3'];
    const w = soundsWarning(await reportFor({ ...old, ...folder }))!;
    expect(w.problem).toBe('outdated');
    expect(w.tone).toBe('warning');
    expect(w.text).toContain('älter als die Firmware');
    expect(w.action).toEqual({ kind: 'link', href: '#/werkstatt/ansagen', label: 'Systemansagen aktualisieren' });
    // TonUINO 2.1 does not ask for that announcement.
    expect(soundsWarning(await reportFor({ ...old, ...folder }, 'classic21'))).toBeNull();
  });

  it('0300.mp3 next to 0300_new_tag.mp3 is a duplicate to repair', async () => {
    const s = systemSounds();
    s.mp3['0300_new_tag.mp3'] = 10;
    const w = soundsWarning(await reportFor({ ...s, ...folder }))!;
    expect(w.issue.id).toBe('system-dup:mp3');
    expect(w.problem).toBe('broken');
    expect(w.tone).toBe('warning');
    expect(w.text).toContain('fehlen oder heißen falsch');
    expect(w.action).toEqual({ kind: 'health', label: 'Ansehen und reparieren' });
  });

  it('missing announcements every box needs are an error with the same text', async () => {
    const s = systemSounds();
    delete s.mp3['0300.mp3'];
    const w = soundsWarning(await reportFor({ ...s, ...folder }))!;
    expect(w.issue.id).toBe('system-outdated');
    expect(w.problem).toBe('broken');
    expect(w.tone).toBe('danger');
    expect(w.text).toContain('fehlen oder heißen falsch');
  });

  it('wrongly numbered and empty announcements are broken', async () => {
    const s = systemSounds();
    delete s.mp3['0300.mp3'];
    s.mp3['300.mp3'] = 10;
    s.advert['0001.mp3'] = 0;
    const r = await reportFor({ ...s, ...folder });
    expect(r.issues.map((i) => i.id)).toEqual(expect.arrayContaining(['system-digits:mp3', 'system-empty:advert']));
    const w = soundsWarning(r)!;
    expect(w.problem).toBe('broken');
    expect(w.tone).toBe('danger');
  });

  it('an unknown system- issue still gives a warning', () => {
    const w = soundsWarning(report(issue('system-xyz', 'warning')))!;
    expect(w.problem).toBe('other');
    expect(w.tone).toBe('warning');
    expect(w.text).toContain('Systemansagen');
    expect(w.action.kind).toBe('health');
    expect(soundsWarning(report(issue('system-xyz:mp3', 'error')))?.tone).toBe('danger');
  });

  it('knows the checks of the coming health rules', () => {
    expect(soundsWarning(report(issue('system-suffix:mp3', 'warning')))?.problem).toBe('broken');
    expect(soundsWarning(report(issue('system-typo:advent', 'error')))?.problem).toBe('broken');
    const big = soundsWarning(report(issue('system-oversized:mp3', 'warning')))!;
    expect(big.problem).toBe('oversized');
    expect(big.text).toContain('Im Ordner mp3');
    expect(big.action.kind).toBe('health');
  });

  it('picks errors first, then what silences the most', () => {
    const dup = issue('system-dup:mp3', 'warning');
    const digits = issue('system-digits:mp3', 'error');
    const missing = issue('system-missing', 'error', 'Die Systemansagen fehlen (Ordner mp3)');
    expect(soundsWarning(report(dup, digits))?.issue).toBe(digits);
    expect(soundsWarning(report(digits, missing))?.issue).toBe(missing);
    expect(soundsWarning(report(issue('system-oversized:mp3', 'warning'), issue('system-outdated', 'warning')))?.problem).toBe('outdated');
  });

  it('ignores hints and the other issues of the card', () => {
    expect(soundsWarning(report(issue('system-xyz', 'info')))).toBeNull();
    expect(soundsWarning(report(issue('gap:01', 'error'), issue('junk', 'warning')))).toBeNull();
  });
});

describe('soundsNotice', () => {
  it('warns about a card without mp3/', async () => {
    const { advert } = systemSounds();
    const tree = { advert, ...folder };
    const scan = await scanSd(memDir(tree));
    const notice = soundsNotice({ status: 'ready', scan, report: await reportFor(tree) });
    expect(notice?.kind).toBe('warning');
    expect(notice?.kind === 'warning' && notice.warning.text).toContain('fehlen');
  });

  it('points to Meine Box without an open card, an unreadable or an empty one', async () => {
    expect(soundsNotice(null)).toEqual({ kind: 'hint' });
    expect(soundsNotice({ status: 'error' })).toEqual({ kind: 'hint' });
    const empty = await scanSd(memDir({}));
    expect(soundsNotice({ status: 'ready', scan: empty, report: checkHealth(empty, { profile: 'tng' }) })).toEqual({ kind: 'hint' });
  });

  it('says the announcements are only in the Paket while they wait for it', async () => {
    // The report shows the copy with the new announcements, so it finds nothing to warn about.
    const tree = { ...systemSounds(), ...folder };
    const report = await reportFor(tree);
    const notice = soundsNotice({ status: 'ready', scan: await scanSd(memDir(tree)), report, soundsPending: true });
    expect(notice).toEqual({ kind: 'pending', text: SOUNDS_PENDING });
    expect(SOUNDS_PENDING).toContain('noch nicht auf der Karte');
    expect(SOUNDS_PENDING).toContain('stumm');
    expect(soundsNotice({ status: 'ready', scan: await scanSd(memDir(tree)), report, soundsPending: false })).toBeNull();
    expect(soundsNotice({ status: 'scanning', soundsPending: true })).toBeNull();
  });

  it('says nothing while the card is read or when all is fine', async () => {
    expect(soundsNotice({ status: 'scanning' })).toBeNull();
    const tree = { ...systemSounds(), ...folder };
    expect(soundsNotice({ status: 'ready', scan: await scanSd(memDir(tree)), report: await reportFor(tree) })).toBeNull();
  });
});

describe('Klappt es nicht?', () => {
  const WORKSHOP_TOOLS = ['firmware', 'logbuch', 'ansagen', 'usb'];

  it('has the six cases for both firmwares', () => {
    for (const p of ['tng', 'classic21'] as const) {
      const cases = boxTrouble(p);
      expect(cases).toHaveLength(6);
      for (const c of cases) {
        expect(c.title.length).toBeGreaterThan(5);
        expect(c.text.length).toBeGreaterThan(40);
      }
    }
  });

  it('every link resolves to a help section or a page of the app', () => {
    for (const p of ['tng', 'classic21'] as const) {
      for (const { link } of boxTrouble(p)) {
        const route = parseHash(link.href);
        expect(routeToHash(route), link.href).toBe(link.href);
        if (route.page === 'help') expect(resolveHelp(route.topic).kind, link.href).toBe('topic');
        else expect(route.page === 'workshop' && WORKSHOP_TOOLS.includes(route.tool ?? ''), link.href).toBe(true);
      }
    }
  });

  it('links the help on teaching cards, unknown cards and the Box-Logbuch', () => {
    const hrefs = new Set(boxTrouble('tng').map((c) => c.link.href));
    expect(hrefs).toEqual(new Set(['#/hilfe/anlernen-klappt-nicht', '#/hilfe/karte-geht-nicht', '#/werkstatt/logbuch']));
  });

  it('quotes the log line each firmware writes', () => {
    expect(boxTrouble('tng').map((c) => c.title)).toContain('Im Box-Logbuch steht „Auth failed“');
    expect(boxTrouble('classic21').map((c) => c.title)).toContain('Im Box-Logbuch steht „PCD_Authenticate() failed“');
  });

  it('does not promise a ready-made firmware for the MH2024K-24SS chip', () => {
    const chip = boxTrouble('tng').find((c) => c.text.includes('MH2024K-24SS'))!;
    expect(chip.text).toContain('TonUINO-Forum');
    expect(chip.text).not.toMatch(/Werkstatt|aufspielen|fertige/);
  });

  it('points at the reader in the box when every card fails to unlock', () => {
    for (const p of ['tng', 'classic21'] as const) {
      const auth = boxTrouble(p).find((c) => c.title.startsWith('Im Box-Logbuch steht'))!;
      expect(auth.text).toContain('Kartenleser in der Box defekt oder falsch angeschlossen');
    }
  });
});

describe('the help on teaching cards', () => {
  it('comes first for the words parents use', () => {
    for (const q of ['karte anlernen geht nicht', 'Karte lässt sich nicht anlernen', 'anlernen geht nicht', 'Box bricht ab', 'auth failed', 'PIN vergessen']) {
      expect(searchHelp(q).hits[0]?.id, q).toBe('anlernen-klappt-nicht');
    }
    // "Box hängt" is first a box that hangs while playing; teaching cards comes close behind.
    expect(searchHelp('Box hängt').hits.slice(0, 3).map((h) => h.id)).toContain('anlernen-klappt-nicht');
  });

  it('leaves other problems to their own pages', () => {
    // A box that says nothing is first the silent box, then the announcements (see tests/help/search.test.ts).
    expect(searchHelp('Box sagt nichts').hits.slice(0, 2).map((h) => h.id)).toEqual(['box-bleibt-stumm', 'keine-ansagen']);
    expect(searchHelp('Karte geht nicht').hits[0]?.id).toBe('karte-geht-nicht');
    expect(searchHelp('Karte reagiert nicht').hits[0]?.id).toBe('karte-geht-nicht');
  });
});
