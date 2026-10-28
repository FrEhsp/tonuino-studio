import { describe, expect, it } from 'vitest';
import { problemWords, type HealthReport, type Issue } from '../../src/core/tonuino/health';

const issue = (id: string, severity: Issue['severity'], title: string, sounds = false): Issue => ({ id, severity, title, detail: '', fix: sounds ? { kind: 'install-system-sounds' } : undefined });
const report = (status: HealthReport['status'], issues: Issue[]) => ({ status, issues });

describe('the words at the red mark in the bar on top (Prüfrunde 1 B1)', () => {
  it('says nothing for a card without problems', () => {
    expect(problemWords(undefined)).toBeNull();
    expect(problemWords(report('ok', [issue('x', 'info', 'Nur ein Hinweis')]))).toBeNull();
  });

  it('names missing announcements, the reason a new box stays silent', () => {
    const w = problemWords(report('error', [issue('system-missing', 'error', 'Die Systemansagen fehlen (Ordner mp3 und advert)', true)]));
    expect(w).toEqual({ short: 'Ansagen fehlen', long: 'Auf der Karte fehlen die Ansagen der Box. Ohne sie sagt die Box nichts.', sounds: true });
  });

  it('counts the other problems behind the announcements', () => {
    const w = problemWords(report('error', [issue('gap:01', 'error', 'Lücke in Ordner 01'), issue('system-outdated', 'error', 'Wichtige Systemansagen fehlen', true), issue('w', 'warning', 'Leise')]));
    expect(w?.short).toBe('Ansagen fehlen');
    expect(w?.long).toBe('Auf der Karte fehlen manche Ansagen der Box. Dazu ein weiteres Problem, siehe „Meine Box“.');
  });

  it('counts problems and hints without announcements', () => {
    expect(problemWords(report('error', [issue('a', 'error', 'Lücke in Ordner 01'), issue('b', 'error', 'Lücke in Ordner 02')]))).toEqual({
      short: '2 Probleme',
      long: 'Lücke in Ordner 01, und 1 mehr. Alles unter „Meine Box“.',
      sounds: false,
    });
    expect(problemWords(report('warning', [issue('a', 'warning', 'Ein Titel ist sehr leise')]))?.short).toBe('1 Hinweis');
  });
});
