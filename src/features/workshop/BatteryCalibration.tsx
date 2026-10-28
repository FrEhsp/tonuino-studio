/**
 * In the Box-Logbuch, next to the Steckbrief: the guided calibration of the
 * battery measurement (core/firmware/batcalib.ts). Shown only while a box is
 * connected whose firmware logs millivolts, a TNG build for calibration.
 */
import { BatteryMedium, Send } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BoxInfo } from '../../core/firmware/bootlog';
import { AFTER_CALIBRATION, BatCalibration, batNote, calibrationOffered, gapWarning, readMeter, readingProblem, statusText, voltsText } from '../../core/firmware/batcalib';
import { parseLogLine } from '../../core/firmware/logline';
import { Button, Callout, Field } from '../../ui/components/controls';
import { logSession } from './logsession';

export function BatteryCalibration({ info, live }: { info: BoxInfo; live: boolean }) {
  if (!live || !calibrationOffered(info)) return null;
  return <CalibrationCard info={info} />;
}

function CalibrationCard({ info }: { info: BoxInfo }) {
  const correction = info.settings.voltMeasCorrection;
  const cal = useRef(new BatCalibration()).current;
  const [, setTick] = useState(0);
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const [checked, setChecked] = useState<string | undefined>();
  const rerender = () => setTick((n) => n + 1);

  useEffect(() => {
    const off = logSession.onLine((line) => {
      if (cal.feed(parseLogLine(line))) rerender();
    });
    const timer = setInterval(() => {
      if (cal.tick(Date.now())) rerender();
    }, 250);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  const send = async () => {
    const r = readMeter(input);
    if (!r.ok) {
      setProblem(r.problem);
      return;
    }
    // A big gap is said once; sending the same value again goes through.
    const gap = gapWarning(r.millivolts, cal.boxMillivolts);
    if (gap && checked !== input) {
      setProblem(gap);
      setChecked(input);
      return;
    }
    setProblem(undefined);
    try {
      await logSession.send(cal.send(r.millivolts, Date.now()), batNote(r.millivolts));
    } catch (e) {
      cal.status = { kind: 'idle' };
      setProblem(e instanceof Error ? e.message : String(e));
    }
    rerender();
  };

  const status = statusText(cal.status);
  const waiting = cal.status.kind === 'waiting';
  const wrong = readingProblem(cal.boxMillivolts, info);
  return (
    <section class="card" aria-labelledby="ws-batcal-title">
      <div class="card-header">
        <h2 id="ws-batcal-title" class="row tight">
          <BatteryMedium size={18} aria-hidden="true" /> Akku-Messung abgleichen
        </h2>
      </div>
      <div class="card-body stack tight">
        <p>Auf der Box läuft eine Firmware zum Abgleichen. Miss die Spannung direkt am Akku mit einem Messgerät und trage den Wert hier ein.</p>
        <p class="small">
          Die Box misst gerade: <strong>{cal.boxMillivolts !== undefined ? voltsText(cal.boxMillivolts) : 'noch nichts'}</strong>
          {correction !== undefined ? <span class="soft"> · Korrekturwert {correction}</span> : null}
        </p>
        {wrong ? <Callout tone="warning">{wrong}</Callout> : null}
        <Field label="Dein Messgerät zeigt (Volt)" id="ws-batcal-volts" hint="Halte vorher die Musik an. Während die Box spielt, nimmt sie den Wert nicht an.">
          <div class="row tight">
            <input
              id="ws-batcal-volts"
              class="input grow"
              type="text"
              inputMode="decimal"
              // The whole example in view (Prüfrunde 2, bastler 11).
              style={{ minWidth: 'calc(10ch + 32px)' }}
              placeholder="z. B. 3,71"
              value={input}
              onInput={(e) => {
                setInput((e.target as HTMLInputElement).value);
                setProblem(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send();
              }}
            />
            <Button icon={Send} disabled={waiting || !!wrong || cal.boxMillivolts === undefined} onClick={() => void send()}>
              An die Box schicken
            </Button>
          </div>
        </Field>
        {problem ? <Callout tone="warning">{problem}</Callout> : null}
        {status ? <Callout tone={status.tone === 'ok' ? 'success' : status.tone}>{status.text}</Callout> : null}
        {cal.status.kind === 'done' ? <p class="small">{AFTER_CALIBRATION}</p> : null}
      </div>
    </section>
  );
}
