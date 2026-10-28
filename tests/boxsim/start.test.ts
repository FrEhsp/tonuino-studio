/**
 * Box-Logbuch and Steckbrief against the real TNG firmware (TODO #66): what
 * the box prints at its start and while cards are laid on, read by the
 * app's log analysis. Runs with `npm run test:boxsim`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeBootLog, BootLogParser } from '../../src/core/firmware/bootlog';
import { invertKind, invertText } from '../../src/core/firmware/tngstands';
import { boxFacts } from '../../src/features/workshop/boxfacts';
import { BoxSim, SIM_TNG, canSimulate } from './boxsim';

let sim: BoxSim | undefined;
afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

async function boot(build: string, args: string[] = [], sd?: string): Promise<BoxSim> {
  sim = BoxSim.start({ build, args, sd });
  await sim.until('enter Idle', 60);
  return sim;
}

function analyze(s: BoxSim) {
  const a = analyzeBootLog(s.boxText());
  return { ...a, issueTitles: a.issues.map((i) => `${i.explanation.level}: ${i.explanation.title}`), facts: boxFacts(a.info) };
}

const fact = (facts: { box: { id: string; value: string }[]; settings: { id: string; value: string }[] }, id: string) =>
  [...facts.box, ...facts.settings].find((f) => f.id === id)?.value;

describe.skipIf(!canSimulate)('Steckbrief from the real start', () => {
  const tngDate = SIM_TNG.date.split('-').reverse().join('.');
  it.each([
    ['classic-3', 'classic', '3', 'Classic, 3 Tasten', SIM_TNG.version, tngDate],
    ['classic-5', 'classic', '5', 'Classic, 5 Tasten', SIM_TNG.version, tngDate],
    ['aio-5', 'aio', '5', 'AiO, 5 Tasten', SIM_TNG.version, tngDate],
    // The write-card preview comes from TNG's work branch issue_345, whatever state the others are.
    ['classic-3-writeCard', 'classic', '3', 'Classic, 3 Tasten', '3.3.3', '08.10.2026'],
  ])('%s', async (build, board, buttons, boardText, version, date) => {
    const a = analyze(await boot(build));
    expect(a.info).toMatchObject({ firmware: 'tng', version, board, buttons, volume: 15, mp3: { connected: true, trackCount: 708 } });
    expect(a.info.settings).toMatchObject({ speakerVolume: { min: 5, max: 25, init: 15 }, eq: 1, standbyTimerMinutes: 0, adminLock: { kind: 'none' } });
    expect(a.bootCount).toBe(1);
    expect(fact(a.facts, 'firmware')).toBe(`TonUINO TNG ${version} vom ${date}`);
    expect(fact(a.facts, 'board')).toBe(boardText);
    // The AiO prints no MFRC522 line, so the Steckbrief says nothing about its reader.
    if (board === 'aio') expect(a.info.rfid).toBeUndefined();
    else expect(fact(a.facts, 'rfid')).toBe('antwortet (MFRC522 v2.0)');
    // Only the timer hint on the AiO (it runs on a battery); nothing else to complain about.
    expect(a.issueTitles).toEqual(board === 'aio' ? ['warn: Ausschalt-Timer ist aus'] : []);
    // Short/long on 3 keys is a setting. With 5 keys it does nothing before TNG of 26.10.2026; since then it
    // swaps the keys and a new box has them as printed (IB:0).
    const kind = invertKind({ buttons: buttons as '3' | '5', version: SIM_TNG.version, date: SIM_TNG.date });
    if (buttons === '3') expect(fact(a.facts, 'buttons')).toBe('kurz drücken: Lautstärke, lang: Titel');
    else if (kind === 'five') expect(fact(a.facts, 'buttons')).toBe(invertText('five', false));
    else expect(fact(a.facts, 'buttons')).toBeUndefined();
  });

  it('headphone build: the jack shows in the Steckbrief', async () => {
    const s = await boot('classic-3-headphones');
    await s.script('hp in\nwait 1');
    const a = analyze(s);
    expect(a.info.headphones).toBe(true);
    expect(fact(a.facts, 'headphones')).toBe('eingesteckt');
  });
});

describe.skipIf(!canSimulate)('faults the Logbuch has to name', () => {
  it('no card reader', async () => {
    const a = analyze(await boot('classic-3', ['--no-rfid']));
    expect(a.info.rfid).toMatchObject({ ok: false });
    expect(fact(a.facts, 'rfid')).toBe('antwortet nicht');
    expect(a.issueTitles).toContain('error: Kartenleser antwortet nicht');
  });

  it.each([
    ['0x88', 'FM17522 (Nachbau)', []],
    // A hint in its line, no issue: most of these readers work (forum 7700#1).
    ['0x12', 'MFRC522 (Nachbau)', []],
  ])('reader chip %s', async (version, chip, issues) => {
    const a = analyze(await boot('classic-3', ['--rfid-version', version]));
    expect(a.info.rfid).toMatchObject({ ok: true, chip });
    expect(a.issueTitles).toEqual(issues);
  });

  it('no MP3 player: the box needs 40 s to start, the Logbuch says so', async () => {
    const a = analyze(await boot('classic-3', ['--no-mp3']));
    expect(a.info.mp3).toMatchObject({ connected: false, trackCount: 0 });
    expect(fact(a.facts, 'mp3')).toBe('antwortet nicht');
    expect(a.issues[0].explanation.level).toBe('error');
  });

  it('SD card missing at the start', async () => {
    const s = await boot('classic-3');
    await s.script('sd out\npower cycle\nuntil enter Idle 60');
    const a = analyze(s);
    expect(a.info.mp3?.trackCount).toBe(0);
    expect(fact(a.facts, 'mp3')).toBe('findet keine Dateien auf der SD-Karte');
    expect(a.issueTitles).toContain('error: Keine Dateien auf der SD-Karte');
  });

  it('a restart the app did not ask for counts as a reboot; one it asked for not', async () => {
    const s = await boot('classic-3');
    await s.script('power cycle\nuntil enter Idle 60');
    const a = analyze(s);
    expect(a.bootCount).toBe(2);
    expect(a.issueTitles).toContain('warn: Die Box ist neu gestartet');

    const parser = new BootLogParser();
    const lines = s.boxLines();
    const second = lines.lastIndexOf(lines.find((l) => l.startsWith('TonUINO Version'))!);
    parser.push(lines.slice(0, second).map((l) => `${l}\n`).join(''));
    parser.expectBoot();
    parser.push(lines.slice(second).map((l) => `${l}\n`).join(''));
    parser.flush();
    expect(parser.issues.map((i) => i.explanation.title)).not.toContain('Die Box ist neu gestartet');
  });

  it('empty folder, missing file, foreign and old cards, wrong key', async () => {
    const s = await boot('classic-3', [], '1:10,2:0,3:10');
    await s.script(`
      card classic uid=01010101 tonuino=2,2
      wait 4
      card off
      wait 1
      card classic uid=02020202 tonuino=1,2
      wait 3
      mp3 error 6
      wait 1
      card off
      wait 1
      card classic uid=03030303 key=a0a1a2a3a4a5 tonuino=1,2
      wait 3
      card off
      wait 1
      card classic uid=04040404 data=1337b347090102000000000000000000
      wait 3
      card off
      wait 1`);
    const a = analyze(s);
    expect(a.info.folderTracks).toMatchObject({ 1: 10, 2: 0 });
    expect(a.issueTitles).toEqual(
      expect.arrayContaining([
        'warn: Ordner 02 ist leer oder fehlt',
        'error: Datei fehlt auf der SD-Karte',
        'warn: Karte nicht lesbar',
        'warn: Karte von einer anderen TonUINO-Version',
      ]),
    );
  });
});
