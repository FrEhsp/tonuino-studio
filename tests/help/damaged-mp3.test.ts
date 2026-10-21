/**
 * Parents look for the symptom ("bleibt hängen"), not for "beschädigte
 * MP3": the help they land on leads to what the import does about damaged
 * and joined MP3s.
 */
import { describe, expect, it } from 'vitest';
import { searchHelp } from '../../src/features/help/search';
import { findSection, type HelpBlock } from '../../src/features/help/topics';

const ids = (query: string) => searchHelp(query).hits.map((h) => h.id);

function textOf(id: string): string {
  const found = findSection(id);
  if (!found) throw new Error(id);
  return found.section.blocks.map((b: HelpBlock) => ('text' in b ? b.text : 'items' in b ? b.items.join(' ') : '')).join(' ');
}

describe('help on damaged and joined MP3s', () => {
  it('is reached from the symptom, while the symptom keeps its own page first', () => {
    expect(ids('box bleibt hängen')[0]).toBe('box-spielt-nicht-richtig');
    expect(ids('Box hängt immer am selben Titel')[0]).toBe('box-spielt-nicht-richtig');
    expect(ids('Box hängt immer am selben Titel').slice(0, 3)).toContain('dateiformate');
    expect(textOf('box-spielt-nicht-richtig')).toContain('(#/hilfe/dateiformate)');
  });

  it('promises only what the check finds', () => {
    const text = textOf('dateiformate');
    expect(text).not.toContain('jede MP3-Datei ganz an');
    expect(text).toContain('prüfe ich, ob eine MP3-Datei kaputte Stellen hat oder aus mehreren Dateien zusammengesetzt ist');
    expect(text).toContain('Nicht jeden Schaden finde ich so.');
  });

  it('keeps the closing words about "Gleiche Lautstärke" apart from the new switch', () => {
    const blocks = findSection('lautstaerke')!.section.blocks;
    const more = blocks.findIndex((b) => b.kind === 'mehr');
    const closing = blocks.findIndex((b) => 'text' in b && b.text.includes('„Gleiche Lautstärke“ schaltest du unter'));
    expect(closing).toBeGreaterThan(-1);
    expect(closing).toBeLessThan(more);
  });
});
