/**
 * The desktop app's question when its window is to close while something is
 * written (see writeguard.ts). A browser asks with its own words instead.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../ui/components/Dialog';
import { Button, Callout } from '../ui/components/controls';
import { CLOSE_RISKS, writeGuard } from './writeguard';

export function CloseQuestion() {
  const [failed, setFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  if (!writeGuard.asking.value) return null;
  const running = writeGuard.running.value;
  // Finished while the question was open: closing does no harm any more.
  const done = running.length === 0;

  const keepOpen = () => {
    setFailed(false);
    writeGuard.keepOpen();
  };
  const close = async () => {
    setFailed(false);
    setClosing(true);
    try {
      await writeGuard.closeAnyway();
    } catch {
      setFailed(true);
    } finally {
      setClosing(false);
    }
  };

  return (
    <Dialog
      title={done ? 'Jetzt ist alles fertig' : 'Noch nicht fertig'}
      onClose={keepOpen}
      closeButton={false}
      footer={
        <>
          <Button autofocus onClick={keepOpen}>
            Offen lassen
          </Button>
          <Button variant={done ? 'primary' : 'danger'} loading={closing} onClick={close}>
            {done ? 'Schließen' : 'Trotzdem schließen'}
          </Button>
        </>
      }
    >
      <div class="stack">
        {done ? (
          <p>Du kannst TonUINO Studio jetzt schließen, ohne dass etwas kaputtgeht.</p>
        ) : (
          <>
            {running.map((kind) => (
              <p key={kind}>{CLOSE_RISKS[kind]}</p>
            ))}
            <p>
              <strong>Trotzdem schließen?</strong>
            </p>
          </>
        )}
        {failed ? <Callout tone="danger">Das Fenster ließ sich nicht schließen. Warte, bis alles fertig ist, und schließe es dann noch einmal.</Callout> : null}
      </div>
    </Dialog>
  );
}
