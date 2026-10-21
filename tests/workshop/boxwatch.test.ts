/** Box-Meldungen: the problems of the connected box, collected in the background. */
import { describe, expect, it } from 'vitest';
import { BoxWaechter, eintragArt } from '../../src/features/workshop/boxwatch';
import { NOTES } from '../../src/features/workshop/logbook';

describe('Box-Meldungen', () => {
  it('tells a new connection and a requested restart from the lines of the box', () => {
    expect(eintragArt({ id: 1, kind: 'note', text: NOTES.connected('USB-Serial CH340 (ttyUSB0)') })).toBe('verbunden');
    expect(eintragArt({ id: 2, kind: 'note', text: NOTES.restartRequested })).toBe('neustart');
    expect(eintragArt({ id: 3, kind: 'line', text: 'C 3' })).toBe('zeile');
    expect(eintragArt({ id: 4, kind: 'note', text: NOTES.disconnected })).toBeUndefined();
  });

  it('collects what goes wrong, not the start after connecting', () => {
    const w = new BoxWaechter('classic', 3);
    w.verbunden(0);
    for (const l of ['TonUINO Version 3.3.3', 'C 3', 'com to mfrc broken', 'Com to DFPlayer broken', 'DfPl Err: 8', 'DfPl Err: 8']) w.zeile(l, 1000);
    expect(w.befunde.list().map((b) => `${b.id}×${b.anzahl}`)).toEqual(['leser-weg×1', 'mp3-weg×1', 'mp3-fehler-8×2']);
    w.zeile('TonUINO Version 3.3.3', 60_000);
    expect(w.befunde.has('neustart')).toBe(true);
    w.verbunden(70_000);
    expect(w.befunde.size).toBe(0);
  });

  it('names no solder joint on the AiO for its built-in MP3 player', () => {
    const w = new BoxWaechter('classic', 3);
    w.verbunden(0);
    w.zeile('A 3', 10);
    w.zeile('Com to DFPlayer broken', 20);
    expect(w.befunde.list()[0].stellen).toEqual([]);
  });
});
