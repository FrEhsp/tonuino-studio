/**
 * In "Fertig!" after a firmware update: reads the box's start and shows its
 * settings, with what needs doing (aftercheck.ts). Starts by itself; on
 * boards where Play/Pause is held during the upload, only after a click, once
 * the key is let go.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleAlert, CircleCheck, Info, ScanSearch } from 'lucide-preact';
import type { BoardInfo } from '../../core/firmware/variants';
import type { SerialAccess, SerialPortInfo } from '../../platform/types';
import { Button, Spinner } from '../../ui/components/controls';
import { errorText } from '../../ui/components/Hints';
import { routeToHash } from '../../app/router';
import { judgeSettings, readStartSettings, type SettingsVerdict } from './aftercheck';
import { Facts } from './common';
import '../../ui/styles/aftercheck.css';

type State = { step: 'wait' } | { step: 'reading' } | { step: 'done'; verdict: SettingsVerdict } | { step: 'error'; message: string };

export function SettingsCheck({ serial, port, board, auto }: { serial: SerialAccess; port: SerialPortInfo; board: BoardInfo; auto: boolean }) {
  const [state, setState] = useState<State>({ step: 'wait' });
  const abort = useRef<AbortController | null>(null);
  const run = async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ step: 'reading' });
    try {
      const read = await readStartSettings(serial, port, { signal: ctrl.signal });
      if (!ctrl.signal.aborted) setState({ step: 'done', verdict: judgeSettings(read, board.id) });
    } catch (e) {
      if (!ctrl.signal.aborted) setState({ step: 'error', message: errorText(e) });
    }
  };
  useEffect(() => {
    // A moment for the box to start with the new firmware.
    const t = auto ? setTimeout(() => void run(), 600) : undefined;
    return () => {
      if (t) clearTimeout(t);
      abort.current?.abort();
    };
  }, []);

  return (
    <section class="card pad stack" aria-labelledby="ws-check-title" aria-live="polite">
      <h2 id="ws-check-title" class="ws-set-title">
        Einstellungen der Box
      </h2>
      {state.step === 'wait' ? (
        <div class="row wrap">
          <p class="soft grow">{auto ? 'Gleich lese ich, was die Box beim Start meldet.' : 'Lasse Play/Pause los. Dann lese ich, was die Box beim Start meldet.'}</p>
          <Button icon={ScanSearch} onClick={run}>
            Einstellungen prüfen
          </Button>
        </div>
      ) : null}
      {state.step === 'reading' ? (
        <p class="row tight soft">
          <Spinner size={16} /> Die Box startet neu. Ich lese ihre Einstellungen …
        </p>
      ) : null}
      {state.step === 'error' ? (
        <div class="row wrap">
          <p class="grow">Das ging nicht: {state.message}</p>
          <Button icon={ScanSearch} onClick={run}>
            Noch einmal
          </Button>
        </div>
      ) : null}
      {state.step === 'done' ? (
        <>
          {state.verdict.facts.length ? <Facts facts={state.verdict.facts} /> : null}
          <ul class="ws-check-findings">
            {state.verdict.findings.map((f) => {
              const Icon = f.tone === 'ok' ? CircleCheck : f.tone === 'warning' ? CircleAlert : Info;
              return (
                <li key={f.text} class={`ws-check-${f.tone}`}>
                  <Icon size={16} aria-hidden="true" /> <span>{f.text}</span>
                </li>
              );
            })}
          </ul>
          <div class="row wrap">
            {state.verdict.findings.some((f) => f.tone !== 'ok') && !state.verdict.silent ? (
              <a class="btn" href={routeToHash({ page: 'workshop', tool: 'einstellen' })}>
                Box einstellen
              </a>
            ) : null}
            <Button variant="ghost" size="sm" icon={ScanSearch} onClick={run}>
              Noch einmal lesen
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
