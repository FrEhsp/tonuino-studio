/**
 * Box testen: the guided test (boxtest.ts), what log lines mean for the
 * soldering (boxbefund.ts) and where the joint to check sits (stellePunkt).
 */
import { describe, expect, it } from 'vitest';
import { parseLogLine } from '../../src/core/firmware/logline';
import { befundAus, LESER_STELLEN, MP3_STELLEN, stellenText, tastenPin, tastenStellen } from '../../src/features/workshop/boxbefund';
import { ausstattungAus, BoxTest, type Ausstattung } from '../../src/features/workshop/boxtest';
import { DEFAULT_WAHL, DFP_OBEN, dfp, linksGnd, linksInnen, nano, NANO_LINKS, NANO_RECHTS, rfid, stellePunkt } from '../../src/features/workshop/loetplan';
import { TNG_PINS } from '../../src/features/workshop/tngPins';
import { loetplanSzene } from '../../src/features/workshop/LoetplanSketch';

const CLASSIC: Ausstattung = { platine: 'classic', tasten: 3, kopfhoerer: true, ring: false, knopf: false, akku: false };
/** The start of a Classic box with 3 buttons, as TNG 3.3.3 prints it. */
const START = ['TonUINO Version 3.3.3', 'C 3', 'Ver:2', 'Vol:20 3 8 15 3 8', 'MFRC522: 146'];

function feed(t: BoxTest, lines: string[], at = 1000): number {
  let now = at;
  for (const l of lines) t.zeile(l, (now += 10));
  return now;
}

function connected(a: Ausstattung = CLASSIC): BoxTest {
  const t = new BoxTest(a);
  t.verbindet(0);
  feed(t, START);
  t.weiter();
  return t;
}

describe('Box testen: the steps', () => {
  it('goes from connecting through every part to the result', () => {
    const t = new BoxTest(CLASSIC);
    expect(t.schritt).toBe('verbinden');
    t.verbindet(0);
    feed(t, START);
    expect(t.gestartet).toBe(true);
    // The start after connecting is no problem.
    expect(t.befunde.size).toBe(0);
    expect(t.teilStatus('usb')).toBe('ok');
    t.weiter();
    expect(t.schritt).toBe('tasten');
    expect(t.wantTaste()?.key).toBe('pause');
    // A short press of every button in the idle box (commands.cpp: idle column).
    feed(t, ['btn/cmd: pause/pause', 'btn/cmd: up/bright_up', 'btn/cmd: down/bright_down']);
    expect(t.teilStatus('tasten')).toBe('ok');
    expect(t.schritt).toBe('karte');
    feed(t, ['Card Ins', 'CardData: 13 37 b3 47 02 01 02 00 00']);
    expect(t.teilStatus('leser')).toBe('ok');
    expect(t.schritt).toBe('ton');
    feed(t, ['play 1-1']);
    expect(t.teilStatus('mp3')).toBe('ok');
    expect(t.teilJetzt()).toBe('lautsprecher');
    t.antwort('lautsprecher', true, 2000);
    t.weiter();
    expect(t.schritt).toBe('kopfhoerer');
    t.antwort('kopfhoerer', true, 2100);
    t.weiter();
    expect(t.schritt).toBe('extras');
    t.weiter();
    expect(t.schritt).toBe('wackeln');
    t.starteWackeln(3000);
    feed(t, ['play 1-2', 'Volume: 15'], 3000);
    t.beendeWackeln(4000);
    expect(t.schritt).toBe('ergebnis');
    expect(t.teilStatus('strom')).toBe('ok');
    expect(t.ergebnis().ton).toBe('ok');
  });

  it('leaves out the headphone step without a socket, and takes buttons and extras from the Lötplan', () => {
    const a = ausstattungAus({ ...DEFAULT_WAHL, kh: 'keine', tasten: 5, extras: ['ring', 'drehgeber'] });
    expect(a).toMatchObject({ kopfhoerer: false, tasten: 5, ring: true, knopf: true, akku: false });
    const t = new BoxTest(a);
    expect(t.schritte()).not.toContain('kopfhoerer');
    expect(t.teile().map((x) => x.id)).toEqual(['usb', 'strom', 'tasten', 'leser', 'mp3', 'lautsprecher', 'ring', 'knopf']);
  });

  it('believes the start of the box over the Lötplan for the buttons', () => {
    const t = new BoxTest(CLASSIC);
    t.verbindet(0);
    feed(t, ['TonUINO Version 3.3.3', 'C 5']);
    expect(t.tasten().map((x) => x.key)).toEqual(['pause', 'up', 'down', 'four', 'five']);
  });

  it('says when another button came than asked, and which joints to check', () => {
    const t = connected();
    feed(t, ['btn/cmd: pause/pause', 'btn/cmd: down/bright_down']);
    const statt = t.tasten().find((x) => x.key === 'up')!;
    expect(statt.statt).toBe('Zurück');
    const b = t.befunde.list().find((x) => x.id === 'taste-statt-up')!;
    expect(b.titel).toBe('Statt „Vor“ kam „Zurück“');
    expect(b.stellen).toEqual(['leiste:A1', 'leiste:A2']);
    // The right one after all: the finding goes.
    feed(t, ['btn/cmd: up/bright_up'], 2000);
    expect(t.befunde.has('taste-statt-up')).toBe(false);
  });

  it('marks a dead button with its pin and the ground beside it, and goes on', () => {
    const t = connected();
    feed(t, ['btn/cmd: pause/pause']);
    t.passiertNichts(2000);
    expect(t.tasten()[1].status).toBe('fehler');
    expect(t.befunde.list()[0].stellen).toEqual(['leiste:A1', 'gnd:1']);
    expect(t.wantTaste()?.key).toBe('down');
    expect(t.teilStatus('tasten')).toBe('fehler');
  });

  it('asks the user on the AiO, whose firmware does not report buttons', () => {
    const t = new BoxTest(CLASSIC);
    t.verbindet(0);
    feed(t, ['TonUINO Version 3.3.3', 'A 3']);
    expect(t.liestTasten).toBe(false);
    expect(t.ausstattung.platine).toBe('aio');
    t.weiter();
    t.antwort('tasten', true, 100);
    expect(t.teilStatus('tasten')).toBe('ok');
    t.weiter();
    // A title from a card says the reader works.
    feed(t, ['play 3-1']);
    expect(t.teilStatus('leser')).toBe('ok');
    expect(t.schritt).toBe('ton');
  });

  it('counts a volume change as the knob while the test asks for it, and a poti any time (extraslog.ts)', () => {
    const t = connected({ ...CLASSIC, knopf: true });
    // Buttons while the box plays: no knob.
    feed(t, ['Volume: 15', 'btn/cmd: upLong/volume_up', 'Volume: 16']);
    expect(t.teilStatus('knopf')).toBe('offen');
    t.gehe('extras');
    expect(t.extraJetzt()).toBe('knopf');
    feed(t, ['btn/cmd: up/volume_up', 'Volume: 17'], 10_000);
    expect(t.teilStatus('knopf')).toBe('ok');
    expect(t.lautstaerke).toBe(17);
    // A poti sets the volume without a command, anywhere in the test.
    const p = connected({ ...CLASSIC, knopf: true, knopfArt: 'poti' });
    feed(p, ['Volume: 15', 'Volume: 12'], 20_000);
    expect(p.teilStatus('knopf')).toBe('ok');
  });

  it('a "Nein" marks the part and names the joints', () => {
    const t = connected({ ...CLASSIC, ring: true });
    t.antwort('lautsprecher', false, 100);
    t.antwort('ring', false, 110);
    expect(t.teilStatus('lautsprecher')).toBe('fehler');
    expect(t.befunde.list().find((b) => b.id === 'ls-still')?.stellen).toEqual(['audio:+', 'audio:−']);
    expect(t.befunde.list().find((b) => b.id === 'ring-dunkel')?.stellen[0]).toBe('leiste:D5');
    expect(t.ergebnis().ton).toBe('fehler');
  });
});

describe('Box testen: the Wackeltest', () => {
  function wackeln(): BoxTest {
    const t = connected();
    for (const s of ['tasten', 'karte', 'ton', 'kopfhoerer', 'extras', 'wackeln'] as const) if (t.schritt !== s) t.gehe(s);
    t.gehe('wackeln');
    t.starteWackeln(5000);
    return t;
  }

  it('lists restarts, a lost card, MP3 errors and a broken USB plug live', () => {
    const t = wackeln();
    feed(t, ['Card Rem', 'Card Ins', 'DfPl Err: 4', ...START], 16_000);
    const texts = t.wackelLog.map((e) => e.text);
    expect(texts).toEqual(['Der Kartenleser hat die Karte verloren', 'Karte wieder da', 'MP3-Player: Übertragungsfehler zum MP3-Player', 'Die Box ist neu gestartet']);
    expect(t.befunde.list().find((b) => b.id === 'neustart')?.text).toMatch(/Beim Klopfen/);
    t.getrennt(17_000, true);
    expect(t.wackelLog.at(-1)?.text).toBe('Die USB-Verbindung ist abgerissen');
    t.beendeWackeln(18_000);
    expect(t.teilStatus('strom')).toBe('fehler');
    expect(t.teilStatus('leser')).not.toBe('fehler'); // a warning, not an error
    expect(t.teilStatus('usb')).toBe('fehler');
  });

  it('the result does not call a part plainly "geht" when a hint below names it', () => {
    const t = connected();
    feed(t, ['Card Ins', 'CardData: 13 37 b3 47 02 01 02 00 00'], 2000);
    t.gehe('wackeln');
    t.starteWackeln(5000);
    feed(t, ['Card Rem', 'Card Ins'], 16_000);
    t.beendeWackeln(18_000);
    expect(t.teilStatus('leser')).toBe('ok');
    expect(t.teilWort('leser')).toEqual({ wort: 'geht, Hinweis unten', hinweis: true });
    expect(t.teilWort('usb')).toEqual({ wort: 'geht', hinweis: false });
    expect(t.teilWort('lautsprecher')).toEqual({ wort: 'nicht getestet', hinweis: false });
  });

  it('a restart the app asked for is no problem, outside the Wackeltest a lost card neither', () => {
    const t = connected();
    // Opening the port and "Box neu starten" right after: two starts, both expected.
    feed(t, START, 2000);
    expect(t.befunde.size).toBe(0);
    t.neustartAngestossen(20_000);
    feed(t, START, 21_000);
    feed(t, ['Card Rem'], 22_000);
    expect(t.befunde.size).toBe(0);
    feed(t, START, 40_000);
    expect(t.befunde.list().map((b) => b.id)).toEqual(['neustart']);
  });
});

describe('Box testen: what a line means', () => {
  const ctx = { platine: 'classic' as const, tasten: 3 as const };
  const of = (line: string, c: Parameters<typeof befundAus>[1] = ctx) => befundAus(parseLogLine(line)!, c);

  it('"Com to DFPlayer broken": the line D2/D3 to TX/RX of the MP3 player', () => {
    const b = of('Com to DFPlayer broken')!;
    expect(b.teil).toBe('mp3');
    expect(b.stellen).toEqual(MP3_STELLEN);
    expect(b.text).toMatch(/D2 und D3/);
    // TNG: dfPlayer_receivePin D2 hears the player's TX, transmitPin D3 talks to its RX.
    expect(TNG_PINS.classic.dfRx?.pin).toBe('D2');
    expect(TNG_PINS.classic.dfTx?.pin).toBe('D3');
    expect(MP3_STELLEN).toEqual(['nano:D3', 'dfp:RX', 'nano:D2', 'dfp:TX']);
    // On the AiO it is soldered in: nothing to check with the iron.
    expect(of('Com to DFPlayer broken', { platine: 'aio', tasten: 3 })!.stellen).toEqual([]);
  });

  it('"DfPl Err": transmission errors point at the line, card errors at the SD card', () => {
    expect(of('DfPl Err: 3')!.stellen).toEqual(MP3_STELLEN);
    const sd = of('DfPl Err: 8')!;
    expect(sd.stellen).toEqual([]);
    expect(sd.titel).toMatch(/SD-Karte/);
    expect(of('DfPl Err: 10')).toBeNull();
  });

  it('"Auth failed" and "MIFARE_Read failed": the card or the data lines of the reader', () => {
    for (const l of ['Auth failed: 3', 'MIFARE_Read failed: 3']) {
      const b = of(l)!;
      expect(b.teil).toBe('leser');
      expect(b.stellen).toEqual(['rfid:SO', 'rfid:SI', 'rfid:SCK']);
      expect(b.text).toMatch(/andere Karte/);
    }
    expect(of('com to mfrc broken')!.stellen).toEqual(LESER_STELLEN);
  });

  it('"hpJackDetect: 1" without headphones: D8 (Every_5f has the detection built in)', () => {
    const b = of('hpJackDetect: 1', { ...ctx, ohneKopfhoerer: true })!;
    expect(b.stellen).toEqual(['leiste:D8']);
    expect(TNG_PINS.classic.hpDetect?.pin).toBe('D8');
    expect(of('hpJackDetect: 1', ctx)).toBeNull();
    expect(of('hpJackDetect: 0', { ...ctx, ohneKopfhoerer: true })).toBeNull();
  });

  it('names the joints in plain words', () => {
    expect(stellenText(['rfid:SO', 'rfid:SI', 'rfid:SCK'])).toBe('SO an der Kartenleser-Leiste, SI an der Kartenleser-Leiste und SCK an der Kartenleser-Leiste');
    expect(stellenText(['leiste:A1'], 'frei')).toBe('A1 am Nano');
  });
});

describe('Box testen: the joints on the Classic v1.7', () => {
  it('puts the buttons on the pins of TNG', () => {
    const fn = { pause: 'pause', up: 'up3', down: 'down3' } as const;
    for (const [key, f] of Object.entries(fn)) expect(tastenPin(key as 'pause', 3)).toBe(TNG_PINS.classic[f]!.pin);
    const fn5 = { pause: 'pause', up: 'up5', down: 'down5', four: 'four5', five: 'five5' } as const;
    for (const [key, f] of Object.entries(fn5)) expect(tastenPin(key as 'pause', 5)).toBe(TNG_PINS.classic[f]!.pin);
    expect(tastenStellen('down', { platine: 'classic', tasten: 5 })).toEqual(['leiste:A4', 'gnd:4']);
  });

  it('finds every joint a finding can name', () => {
    expect(stellePunkt('leiste:A1')).toEqual(linksInnen(1));
    expect(stellePunkt('leiste:D8')).toEqual(linksInnen(10));
    expect(stellePunkt('gnd:4')).toEqual(linksGnd(4));
    expect(stellePunkt('rfid:SO')).toEqual(rfid(4));
    // Nano pin-out from the USB end; D2/D3 on the column beside the card-reader row.
    expect(stellePunkt('nano:D2')).toEqual(nano(10, true));
    expect(stellePunkt('nano:D3')).toEqual(nano(9, true));
    expect(stellePunkt('nano:5V')).toEqual(nano(11, false));
    expect(NANO_RECHTS).toHaveLength(15);
    expect(NANO_LINKS).toHaveLength(15);
    // MP3 player: pin 1 at the print "1", RX pin 2, TX pin 3 (DFPlayer Mini manual).
    expect(DFP_OBEN.slice(0, 3)).toEqual(['VCC', 'RX', 'TX']);
    expect(stellePunkt('dfp:RX')).toEqual(dfp(1, false));
    expect(stellePunkt('dfp:BUSY')).toEqual(dfp(0, true));
    expect(stellePunkt('nirgends:X')).toBeUndefined();
    const all = [...MP3_STELLEN, ...LESER_STELLEN, 'audio:+', 'audio:−', 'audio:R', 'audio:L', 'audio:GND', 'audio:5V', 'leiste:D5', 'leiste:A3', 'leiste:A4', 'nano:GND'];
    for (const id of all) expect(stellePunkt(id), id).toBeDefined();
  });

  it('rings the joints in the Lötplan with a readable label, from above and below', () => {
    const sets = [MP3_STELLEN, LESER_STELLEN, ['leiste:A1', 'gnd:1'], ['leiste:A4', 'gnd:4'], ['nano:5V', 'nano:GND'], ['audio:+', 'audio:−'], ['audio:R', 'audio:L', 'audio:GND'], ['leiste:D8'], ['leiste:D5', 'audio:5V', 'audio:GND']];
    for (const ansicht of ['oben', 'unten'] as const)
      for (const kh of ['platine', 'buchse', 'keine'] as const)
        for (const st of sets) {
          const w = { ...DEFAULT_WAHL, ansicht, kh };
          const ohne = loetplanSzene(w).szene.konflikte;
          const mit = loetplanSzene(w, 0, st).szene;
          expect(mit.konflikte, `${ansicht} ${kh} ${st.join(' ')}`).toEqual(ohne);
          expect(mit.etiketten.some((e) => e.txt === 'Prüfe diese Stelle')).toBe(true);
        }
  });
});
