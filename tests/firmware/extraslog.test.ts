import { describe, expect, it } from 'vitest';
import { ExtrasLogWatcher, type ExtrasEvent } from '../../src/core/firmware/extraslog';

function feed(w: ExtrasLogWatcher, lines: [number, string][]): ExtrasEvent[] {
  return lines.map(([at, l]) => w.push(l, at)).filter((e): e is ExtrasEvent => !!e);
}

describe('ExtrasLogWatcher', () => {
  it('marks the first volume after the start', () => {
    const w = new ExtrasLogWatcher({ knob: 'poti' });
    const ev = feed(w, [
      [0, 'TonUINO Version 3.3.3'],
      [10, 'Volume: 15'],
    ]);
    expect(ev).toEqual([{ kind: 'restart' }, { kind: 'volume', volume: 15, cause: 'start' }]);
    expect(w.volume).toBe(15);
  });

  it('a volume without a command comes from the poti', () => {
    const w = new ExtrasLogWatcher({ knob: 'poti' });
    feed(w, [
      [0, 'TonUINO Version 3.3.3'],
      [10, 'Volume: 15'],
    ]);
    expect(w.push('Volume: 17', 5000)).toEqual({ kind: 'volume', volume: 17, previous: 15, cause: 'knob' });
    expect(w.push('Volume: 12', 5100)).toEqual({ kind: 'volume', volume: 12, previous: 17, cause: 'knob' });
  });

  it('without a known knob such a line stays unclear', () => {
    const w = new ExtrasLogWatcher();
    w.push('Volume: 10', 0);
    expect(w.push('Volume: 11', 3000)).toMatchObject({ cause: 'unknown' });
  });

  it('an encoder turn is one upLong/downLong without repeats', () => {
    const w = new ExtrasLogWatcher({ knob: 'encoder' });
    feed(w, [
      [0, 'TonUINO Version 3.3.3'],
      [10, 'Volume: 15'],
    ]);
    const ev = feed(w, [
      [2000, 'btn/cmd: upLong/volume_up'],
      [2001, 'Volume: 16'],
      [2300, 'btn/cmd: downLong/volume_down'],
      [2301, 'Volume: 15'],
    ]);
    expect(ev).toEqual([
      { kind: 'volume', volume: 16, previous: 15, cause: 'knob' },
      { kind: 'volume', volume: 15, previous: 16, cause: 'knob' },
    ]);
  });

  it('a held button sends repeats: those are the button', () => {
    const w = new ExtrasLogWatcher({ knob: 'encoder' });
    w.push('Volume: 15', 0);
    const ev = feed(w, [
      [3000, 'btn/cmd: upLong/volume_up'],
      [3001, 'Volume: 16'],
      [3200, 'btn/cmd: upLongRepeat/volume_up'],
      [3201, 'Volume: 17'],
      [3400, 'btn/cmd: upLongRepeat/volume_up'],
      [3401, 'Volume: 18'],
    ]);
    // The first step cannot be told apart from a turn; the repeats can.
    expect(ev.map((e) => e.kind === 'volume' && e.cause)).toEqual(['knob', 'button', 'button']);
  });

  it('with 5 buttons Lauter/Leiser are buttons', () => {
    const w = new ExtrasLogWatcher();
    w.push('Volume: 15', 0);
    w.push('btn/cmd: four/volume_up', 1000);
    expect(w.push('Volume: 16', 1001)).toMatchObject({ cause: 'button', volume: 16 });
  });

  it('a headphone change brings its own volume', () => {
    const w = new ExtrasLogWatcher({ knob: 'poti' });
    w.push('Volume: 15', 0);
    expect(w.push('hpJackDetect: 1', 1000)).toEqual({ kind: 'headphones', plugged: true });
    expect(w.push('Volume: 8', 1001)).toEqual({ kind: 'volume', volume: 8, previous: 15, cause: 'headphones' });
    expect(w.headphones).toBe(true);
  });

  it('reads lines with the time prefix of the Box-Logbuch', () => {
    const w = new ExtrasLogWatcher({ knob: 'poti' });
    w.push('[12:00:00.000] Volume: 3', 0);
    expect(w.push('[12:00:05.120] Volume: 4', 5000)).toMatchObject({ volume: 4, previous: 3, cause: 'knob' });
  });

  it('a command long before the volume line is not its cause', () => {
    const w = new ExtrasLogWatcher({ knob: 'poti' });
    w.push('Volume: 15', 0);
    w.push('btn/cmd: upLong/volume_up', 1000);
    expect(w.push('Volume: 14', 5000)).toMatchObject({ cause: 'knob' });
  });

  it('tells which extras the log proves, once per start', () => {
    const w = new ExtrasLogWatcher();
    expect(w.push('[12:00:00.000] LEDs(D/P/U): 5 19 6', 0)).toEqual({ kind: 'extra', extra: 'ledButtons' });
    expect(w.push('LEDs(D/P/U): 5 19 6', 10)).toBeUndefined();
    w.push('hpJackDetect: 1', 20);
    expect([...w.seen].sort()).toEqual(['headphones', 'ledButtons']);
    expect(w.push('TonUINO Version 3.x - refactored by Boerge1', 30)).toEqual({ kind: 'restart' });
    expect(w.seen.size).toBe(0);
  });
});
