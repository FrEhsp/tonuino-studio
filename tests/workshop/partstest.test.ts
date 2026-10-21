import { describe, expect, it } from 'vitest';
import { PartsTest, allArrived, instruction, otherHint, rowHint, summary, type PartRow } from '../../src/features/workshop/partstest';
import { AIOPLUS_BROKEN_LOG, CLASSIC_LOG } from './fakes';

/* ------------------------------------------------------------------ fixtures */

/** Start of a Classic box with TNG 3.3.3, 3 buttons, IB:1 (from fakes.ts), without the lines after "enter Idle". */
const CLASSIC_START = CLASSIC_LOG.split('\r\n').filter((l) => l && !/^(Card Ins|play |Volume)/.test(l));

/** The same start with 5 buttons on an AiO+. */
const AIOPLUS5_START = CLASSIC_START.map((l) => (l === 'C 3' ? 'A+ 5' : l));

/** Start of an AiO (not AiO+): TNG logs no button presses and no card events there. */
const AIO_START = ['TonUINO Version 3.x - refactored by Boerge1', 'V3.3.3 17.09.26', 'A 3', 'Ver:2', 'Vol:25 5 15', 'IB:1', 'AL:0', 'enter Idle'];

/** A card that plays folder 5, as in the Box-Logbuch tests. */
const CARD = ['Card Ins', 'CardData: 13 37 b3 47 02 05 02 00 00 ', '12 tr in folder 5', 'play 5-1', 'enter Play'];

/** Every press of a 3-button box while it plays, with IB:1 (commands.cpp, column play_invert). */
const PRESSES_3_INVERTED = [
  'btn/cmd: up/volume_up',
  'Volume: 16',
  'btn/cmd: upLong/next',
  'play 5-2',
  'btn/cmd: down/volume_down',
  'Volume: 15',
  'btn/cmd: downLong/previous',
  'play 5-1',
  'btn/cmd: pauseLong/track',
  'btn/cmd: pause/pause',
  'enter Pause',
];

/** Drives a PartsTest with a clock: each line 1 s after the one before. */
class Run {
  now = 1_000_000;
  constructor(readonly t: PartsTest = new PartsTest()) {}
  lines(lines: string[], stepMs = 1000): this {
    for (const l of lines) {
      this.now += stepMs;
      this.t.observe(l, this.now);
    }
    return this;
  }
  row(id: string): PartRow {
    const r = this.t.rows().find((x) => x.id === id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  }
}

const ids = (t: PartsTest) => t.rows().map((r) => r.id);

/* ------------------------------------------------------------------ tests */

describe('PartsTest rows', () => {
  it('expects 3 buttons, short and long, for a box built with 3 buttons', () => {
    const r = new Run().lines(CLASSIC_START);
    expect(r.t.variantKnown).toBe(true);
    expect(ids(r.t)).toEqual(['card', 'sound', 'up:short', 'up:long', 'down:short', 'down:long', 'pause:long', 'pause:short', 'volume']);
    expect(r.t.rows().every((x) => x.at === undefined)).toBe(true);
  });

  it('adds Lauter and Leiser for a box built with 5 buttons', () => {
    const r = new Run().lines(AIOPLUS5_START);
    expect(ids(r.t)).toEqual([
      'card',
      'sound',
      'up:short',
      'up:long',
      'down:short',
      'down:long',
      'four:short',
      'four:long',
      'five:short',
      'five:long',
      'pause:long',
      'pause:short',
      'volume',
    ]);
  });

  it('ticks every row of a 3-button box, live and with the time', () => {
    const r = new Run().lines(CLASSIC_START).lines(CARD).lines(PRESSES_3_INVERTED);
    const rows = r.t.rows();
    expect(rows.filter((x) => x.at === undefined)).toEqual([]);
    expect(r.t.progress()).toEqual({ done: 9, total: 9 });
    expect(allArrived(r.t)).toBe(true);
    expect(allArrived(new Run().lines(CLASSIC_START).lines(CARD).t)).toBe(false);
    expect(allArrived(new PartsTest())).toBe(false);
    expect(r.row('card').detail).toBe('Karte gelesen');
    expect(r.row('sound').detail).toBe('Titel 5-1');
    expect(r.row('up:short').detail).toBe('lauter');
    expect(r.row('up:long').detail).toBe('nächster Titel');
    expect(r.row('pause:long').detail).toBe('Titelnummer ansagen');
    expect(r.row('volume').detail).toBe('Lautstärke 16');
    expect(r.t.current()).toBeUndefined();
    expect(r.t.lastHit?.id).toBe('pause:short');
    r.t.finish();
    expect(summary(r.t).tone).toBe('ok');
  });

  it('takes the first press as the time of a row', () => {
    const r = new Run().lines(CLASSIC_START).lines(['btn/cmd: up/bright_up']);
    const first = r.row('up:short').at;
    r.lines(['btn/cmd: up/bright_up']);
    expect(r.row('up:short').at).toBe(first);
  });

  it('names the change when the volume before is known', () => {
    const r = new Run().lines(CLASSIC_START).lines(['Volume: 15', 'Volume: 18']);
    expect(r.row('volume').detail).toBe('von 15 auf 18');
  });

  it('does not count the volume set at the start as a change', () => {
    const r = new Run().lines(CLASSIC_LOG.split('\r\n').filter(Boolean));
    // CLASSIC_LOG ends with "Volume: 16" after the start, the first volume line the test sees.
    expect(r.row('volume').at).toBeUndefined();
    r.lines(['btn/cmd: up/volume_up', 'Volume: 17']);
    expect(r.row('volume').at).toBeDefined();
  });

  it('counts a volume line after a volume command even at the top (the box logs the same value again)', () => {
    const r = new Run().lines(CLASSIC_START).lines(['Volume: 25', 'btn/cmd: up/volume_up', 'Volume: 25']);
    expect(r.row('volume').detail).toBe('Lautstärke 25');
  });

  it('shows the 3×3 board once a key of it reports', () => {
    const r = new Run().lines(CLASSIC_START);
    expect(r.t.hasKeypad).toBe(false);
    r.lines(['btn3x3: 4', 'btn3x3: 7']);
    expect(r.row('keypad').detail).toBe('Taste 4, 7');
  });

  it('shows the 3×3 board as open when the box is built for it', () => {
    const r = new Run().lines(CLASSIC_START.map((l) => (l === 'C 3' ? 'C 3x3' : l)));
    expect(ids(r.t)).toContain('keypad');
    r.t.finish();
    expect(rowHint(r.t, r.row('keypad'))?.text).toContain('Tastenfeld');
  });

  it('works without the start of the box and grows to 5 buttons when Lauter reports', () => {
    const r = new Run().lines(['btn/cmd: up/next']);
    expect(r.t.variantKnown).toBe(false);
    expect(r.t.buttonCount).toBe(3);
    r.lines(['btn/cmd: four/volume_up']);
    expect(r.t.buttonCount).toBe(5);
    expect(r.row('four:short').at).toBeDefined();
  });

  it('ignores the repeats of a held button', () => {
    const r = new Run().lines(CLASSIC_START).lines(['btn/cmd: upLong/volume_up', 'btn/cmd: upLongRepeat/volume_up', 'btn/cmd: upLongRepeat/volume_up'], 200);
    expect(r.t.others).toEqual([]);
    expect(r.row('up:long').at).toBeDefined();
  });
});

describe('PartsTest guide', () => {
  it('asks for a card first, then each button, Play/Pause last', () => {
    const r = new Run().lines(CLASSIC_START);
    expect(instruction(r.t, r.t.current()!).say).toBe('Lege eine Karte auf die Box.');
    r.lines(CARD);
    expect(instruction(r.t, r.t.current()!).say).toBe('Drücke kurz auf Vor.');
    r.lines(['btn/cmd: up/volume_up']);
    expect(instruction(r.t, r.t.current()!).say).toBe('Halte Vor gedrückt.');
  });

  it('says how to change the volume as the firmware maps it', () => {
    const r = new Run().lines(CLASSIC_START);
    const volume = r.row('volume');
    expect(instruction(r.t, volume).sub).toContain('Drücke kurz auf Vor oder Zurück');
    r.lines(['IB:0']);
    expect(instruction(r.t, volume).sub).toContain('Halte Vor oder Zurück lang');
    const five = new Run().lines(AIOPLUS5_START);
    expect(instruction(five.t, five.row('volume')).sub).toContain('Lauter oder Leiser');
  });

  it('notes the wrong button at the one the guide asked for (forum 14326: Lauter reported as Vor)', () => {
    const r = new Run().lines(AIOPLUS5_START).lines(CARD).lines(['btn/cmd: up/next', 'btn/cmd: upLong/next10', 'btn/cmd: down/previous', 'btn/cmd: downLong/previous10']);
    expect(r.t.current()?.id).toBe('four:short');
    r.lines(['btn/cmd: up/next']);
    expect(r.t.lastMismatch).toMatchObject({ want: 'four:short', got: 'Vor kurz' });
    expect(r.row('four:short').reportedInstead).toBe('Vor kurz');
    r.t.finish();
    const hint = rowHint(r.t, r.row('four:short'))!.text;
    expect(hint).toContain('Prüfe Lötstelle und Kabel an dieser Taste.');
    expect(hint).toContain('Neu aufspielen musst du die Firmware dafür nicht.');
  });

  it('does not call the wires swapped when the other press of that button came through', () => {
    const r = new Run().lines(AIOPLUS5_START).lines(CARD).lines(['btn/cmd: up/next', 'btn/cmd: upLong/next10', 'btn/cmd: down/previous', 'btn/cmd: downLong/previous10', 'btn/cmd: four/volume_up', 'btn/cmd: up/next']);
    r.t.finish();
    const hint = rowHint(r.t, r.row('four:long'))!.text;
    expect(hint).toContain('Wackelkontakt');
    expect(hint).not.toContain('Kabel vertauscht');
  });

  it('forgets the mismatch once the right button reports', () => {
    const r = new Run().lines(CLASSIC_START).lines(CARD).lines(['btn/cmd: down/volume_down', 'btn/cmd: up/volume_up']);
    expect(r.row('up:short').reportedInstead).toBeUndefined();
    expect(r.row('up:short').at).toBeDefined();
  });

  it('points at the button board when Vor and Zurück are swapped (forum 11571)', () => {
    const r = new Run().lines(CLASSIC_START).lines(CARD).lines(['btn/cmd: down/volume_down']);
    r.t.finish();
    expect(rowHint(r.t, r.row('up:short'))!.text).toContain('Tastenplatine verkehrt herum');
  });

  it('says to hold longer when a short press came instead of a long one', () => {
    const r = new Run().lines(CLASSIC_START).lines(CARD).lines(['btn/cmd: up/volume_up', 'btn/cmd: up/volume_up'], 2000);
    r.t.finish();
    expect(rowHint(r.t, r.row('up:long'))!.text).toContain('Halte die Taste länger');
  });

  it('flags a press that arrives twice at once as a loose contact', () => {
    const r = new Run().lines(CLASSIC_START).lines(['btn/cmd: up/bright_up']).lines(['btn/cmd: up/bright_up'], 80);
    expect(r.row('up:short').doubled).toBe(true);
    expect(rowHint(r.t, r.row('up:short'))!.text).toContain('Wackelkontakt');
    r.t.finish();
    expect(summary(r.t).tone).toBe('warn');
  });
});

describe('PartsTest hints after "Fertig"', () => {
  it('says nothing about open rows before "Fertig"', () => {
    const r = new Run().lines(CLASSIC_START);
    expect(rowHint(r.t, r.row('up:short'))).toBeUndefined();
    expect(rowHint(r.t, r.row('card'))).toBeUndefined();
  });

  it('gives each open row a plain hint', () => {
    const r = new Run().lines(CLASSIC_START).lines(['btn/cmd: up/bright_up']);
    r.t.finish();
    expect(rowHint(r.t, r.row('down:short'))!.text).toContain('kalte Lötstelle');
    expect(rowHint(r.t, r.row('card'))).toMatchObject({ readerTest: true });
    expect(rowHint(r.t, r.row('sound'))!.text).toContain('SD-Karte');
    expect(rowHint(r.t, r.row('up:long'))!.text).toContain('Kurz drücken kam an, lang nicht.');
    expect(summary(r.t).title).toBe('8 Punkte fehlen noch');
  });

  it('explains that Lauter and Leiser held long only report while the box plays', () => {
    const r = new Run().lines(AIOPLUS5_START).lines(['btn/cmd: four/bright_up']);
    r.t.finish();
    expect(rowHint(r.t, r.row('four:long'))!.text).toContain('nur, während sie spielt');
  });

  it('uses what the start said about the reader and the MP3 player', () => {
    const r = new Run().lines(AIOPLUS_BROKEN_LOG.split(/\r?\n/).filter(Boolean));
    expect(r.t.rfidBroken).toBe(true);
    expect(r.t.mp3Broken).toBe(true);
    expect(rowHint(r.t, r.row('card'))!.text).toContain('Kartenleser nicht geantwortet');
    expect(rowHint(r.t, r.row('sound'))!.text).toContain('MP3-Player nicht geantwortet');
  });

  it('notices a card the reader could not read', () => {
    const r = new Run().lines(CLASSIC_START).lines(['Card Ins', 'Auth failed: 2']);
    expect(r.row('card').unreadable).toBe(true);
    expect(rowHint(r.t, r.row('card'))).toMatchObject({ readerTest: true });
    r.lines(['Card Rem', 'Card Ins', 'CardData: 13 37 b3 47 02 05 02 00 00']);
    expect(r.row('card').unreadable).toBe(false);
  });

  it('says that a started title is not proof of sound', () => {
    const r = new Run().lines(CLASSIC_START).lines(CARD);
    expect(rowHint(r.t, r.row('sound'))!.text).toContain('Hörst du nichts');
  });
});

describe('PartsTest other reports and boards', () => {
  it('lists two buttons at once as another report, with the solder bridge in mind', () => {
    const r = new Run().lines(CLASSIC_START).lines(['btn/cmd: updownLong/shortcut1']);
    expect(r.t.others).toHaveLength(1);
    expect(r.t.others[0]).toMatchObject({ label: 'Vor und Zurück lang', text: 'updownLong/shortcut1', combo: true });
    expect(otherHint(r.t.others[0])).toContain('berühren sich vielleicht zwei Lötstellen');
  });

  it('lists Lauter on a box built for 3 buttons and unknown names as other reports', () => {
    const r = new Run().lines(CLASSIC_START).lines(['btn/cmd: four/volume_up', 'btn/cmd: 5/2']);
    expect(r.t.others.map((o) => o.label)).toEqual(['Lauter kurz', '5']);
    expect(ids(r.t)).not.toContain('four:short');
  });

  it('cannot test the AiO: its firmware logs no presses', () => {
    const r = new Run().lines(AIO_START);
    expect(r.t.support).toBe('aio');
    expect(r.t.rows()).toEqual([]);
  });

  it('runs on the AiO+', () => {
    const r = new Run().lines(AIOPLUS5_START);
    expect(r.t.support).toBe('ok');
  });

  it('cannot test TonUINO 2.1', () => {
    const r = new Run().lines(['TonUINO Version 2.1', 'Version: 2']);
    expect(r.t.support).toBe('classic21');
    expect(r.t.rows()).toEqual([]);
  });

  it('takes the facts of the Box-Logbuch when it opens on a running box', () => {
    const t = new PartsTest();
    t.seed({ firmware: 'tng', board: 'aioplus', buttons: '5', settings: { invertVolumeButtons: false } });
    expect(t.variantKnown).toBe(true);
    expect(t.buttonCount).toBe(5);
    expect(t.invertVolumeButtons).toBe(false);
  });
});
