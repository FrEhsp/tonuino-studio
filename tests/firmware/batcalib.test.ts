import { describe, expect, it } from 'vitest';
import { analyzeBootLog, explainRecord, parseLogLine } from '../../src/core/firmware/bootlog';
import { AFTER_CALIBRATION, ANSWER_MS, BatCalibration, batLine, calibrationOffered, gapWarning, readMeter, readingProblem, statusText, voltsText } from '../../src/core/firmware/batcalib';
import { lineBytes } from '../../src/core/firmware/writecard';

/** The start of a Classic with TNG of 26.10.2026 built with BAT_VOLTAGE_MEASUREMENT_CALIBRATION, from the box simulator. */
const CALIBRATION_LOG = `TonUINO Version 3.x - refactored by Boerge1
V3.3.4 26.10.26
C 3
Ver:3
Vol:25 5 15 25 5 15
EQ:1
ST:0
IB:1
AL:0
AP:1111
PCR:0
BV:1960
MFRC522:146
Volume: 15
track_count: 708
enter Idle
BatVoltage: 2526
BatVoltage: 2027
`;

const ESP32_LOG = CALIBRATION_LOG.replace('C 3', 'ESP32 Nano 5').replace(/BatVoltage: \d+/g, 'BatVoltage: 3650');

describe('battery lines of TNG from 26.10.2026', () => {
  it('reads the correction factor, millivolts and the answer to "BAT"', () => {
    expect(parseLogLine('BV:2075')).toMatchObject({ kind: 'setting', key: 'BV', patch: { voltMeasCorrection: 2075 } });
    expect(parseLogLine('BV:0')).toMatchObject({ invalid: true, patch: {} });
    expect(parseLogLine('BatVoltage: 3712')).toEqual({ kind: 'battery-voltage', volts: 3.712, low: false, millivolts: 3712 });
    // The wrong reading of TNG of 26.10.2026 on a Classic is millivolts too, not 33 volts.
    expect(parseLogLine('BatVoltage: 33')).toEqual({ kind: 'battery-voltage', volts: 0.033, low: false, millivolts: 33 });
    // Older TNG: volts with decimals; no millivolts.
    expect(parseLogLine('BatVoltage: 2.86')).toEqual({ kind: 'battery-voltage', volts: 2.86, low: false });
    expect(parseLogLine('Bat Volt Corr set: 1987')).toEqual({ kind: 'battery-correction', value: 1987 });
    expect(explainRecord({ kind: 'battery-correction', value: 1987 })?.explanation).toContain('1987');
  });

  it('notes a calibration build once, and the new factor', () => {
    const { info } = analyzeBootLog(CALIBRATION_LOG + 'Bat Volt Corr set: 1987\n');
    expect(info.batteryCalibration).toBe(true);
    expect(info.settings.voltMeasCorrection).toBe(1987);
    expect(analyzeBootLog(CALIBRATION_LOG.replace(/BatVoltage: \d+\n/g, '')).info.batteryCalibration).toBeUndefined();
  });

  it('offers the calibration only for a box that logs millivolts on new enough firmware', () => {
    expect(calibrationOffered(analyzeBootLog(CALIBRATION_LOG).info)).toBe(true);
    expect(calibrationOffered(analyzeBootLog(CALIBRATION_LOG.replace(/BatVoltage: (\d)(\d+)/g, 'BatVoltage: $1.$2')).info)).toBe(false);
    expect(calibrationOffered({ settings: {}, folderTracks: {}, batteryCalibration: true, version: '3.3.3', versionDate: '2026-09-17' })).toBe(false);
    expect(calibrationOffered({ settings: {}, folderTracks: {}, batteryCalibration: true })).toBe(true);
  });

  it('says why an Arduino board with TNG of 26.10.2026 reads the battery wrong', () => {
    const { info, issues } = analyzeBootLog(CALIBRATION_LOG);
    expect(readingProblem(33, info)).toContain('rechnet die Akku-Messung auf dieser Platine falsch');
    expect(readingProblem(3650, info)).toBeUndefined();
    // As that box logs it: some 30 mV. The card still comes, with the reason.
    const wrong = analyzeBootLog(CALIBRATION_LOG.replace(/BatVoltage: \d+/g, 'BatVoltage: 33')).info;
    expect(calibrationOffered(wrong)).toBe(true);
    const esp32 = analyzeBootLog(ESP32_LOG).info;
    expect(readingProblem(800, esp32)).toContain('Widerstände');
    expect(issues.map((i) => i.explanation.id)).not.toContain('battery-empty');
    const empty = analyzeBootLog(CALIBRATION_LOG + 'BatVoltage empty\n').issues.find((i) => i.explanation.id === 'battery-empty');
    expect(empty?.explanation.explanation).toContain('26.10.2026');
    expect(analyzeBootLog(ESP32_LOG + 'BatVoltage empty\n').issues.find((i) => i.explanation.id === 'battery-empty')?.explanation.explanation).not.toContain('26.10.2026');
  });
});

describe('Akku-Messung abgleichen', () => {
  it('reads what the meter shows', () => {
    expect(readMeter('3,71')).toEqual({ ok: true, millivolts: 3710 });
    expect(readMeter(' 3.705 V ')).toEqual({ ok: true, millivolts: 3705 });
    expect(readMeter('3710')).toEqual({ ok: true, millivolts: 3710 });
    expect(readMeter('3710 mV')).toEqual({ ok: true, millivolts: 3710 });
    expect(readMeter('')).toMatchObject({ ok: false });
    expect(readMeter('drei')).toMatchObject({ ok: false, problem: expect.stringContaining('keine Zahl') });
    expect(readMeter('0,4')).toMatchObject({ ok: false });
    expect(readMeter('12')).toMatchObject({ ok: false });
    expect(voltsText(3710)).toBe('3,71 V');
  });

  it('sends the word with a NUL, so the firmware reads "BAT" whatever its stack holds', () => {
    expect([...lineBytes(batLine(3700))]).toEqual([0x42, 0x41, 0x54, 0x00, 0x20, 0x33, 0x37, 0x30, 0x30, 0x0a]);
  });

  it('warns about a big gap between meter and box', () => {
    expect(gapWarning(3700, 3650)).toBeUndefined();
    expect(gapWarning(3700, undefined)).toBeUndefined();
    expect(gapWarning(3700, 2500)).toContain('großer Unterschied');
  });

  it('follows the answer of the box', () => {
    const cal = new BatCalibration();
    expect(cal.feed(parseLogLine('BatVoltage: 3650'))).toBe(true);
    expect(cal.boxMillivolts).toBe(3650);
    expect(cal.send(3700, 1000)).toBe(batLine(3700));
    expect(statusText(cal.status)?.tone).toBe('info');
    expect(cal.tick(1000 + ANSWER_MS - 1)).toBe(false);
    expect(cal.feed(parseLogLine('Bat Volt Corr set: 1987'))).toBe(true);
    expect(cal.status).toEqual({ kind: 'done', correction: 1987, millivolts: 3700 });
    expect(statusText(cal.status)).toMatchObject({ tone: 'ok', text: expect.stringContaining('1987') });
    expect(cal.settled()).toBe(false);
    cal.feed(parseLogLine('BatVoltage: 3690'));
    expect(cal.settled()).toBe(true);
    expect(AFTER_CALIBRATION).toContain('normale Firmware');

    // Playing, or the old method: no answer.
    const silent = new BatCalibration();
    silent.send(3700, 0);
    expect(silent.tick(ANSWER_MS)).toBe(true);
    expect(statusText(silent.status)).toMatchObject({ tone: 'warning', text: expect.stringContaining('Halte die Musik an') });
    // A restart while waiting ends the wait.
    const restarted = new BatCalibration();
    restarted.send(3700, 0);
    restarted.feed(parseLogLine('TonUINO Version 3.x - refactored by Boerge1'));
    expect(restarted.status.kind).toBe('no-answer');
  });
});
