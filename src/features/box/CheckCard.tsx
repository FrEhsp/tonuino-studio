import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleCheck, RotateCcw } from 'lucide-preact';
import { formatBytes } from '../../app/format';
import { checkReading, chooseCardFolder } from '../../app/pending';
import { plat } from '../../app/state';
import { fileSource } from '../../core/audio/source';
import type { PackageManifest } from '../../core/tonuino/package';
import { checkCardContent, checkThoroughly, type CheckResult } from '../../core/tonuino/verify';
import { isSnapshotProblem, type SnapshotProblem, type SnapshotResult } from '../../platform/snapshot';
import { Button, Callout, Progress } from '../../ui/components/controls';
import { CommandLine } from '../../ui/components/Hints';
import { toastError } from '../../ui/components/Toast';
import { useCardDrop } from '../../ui/useCardDrop';
import { CardReader, UPLOAD_HINT } from './CardReader';
import { CHECK_OK_TEXT, crcMismatchText, decodeFailedText, findingText, problemText, type FindingText } from './packageTexts';
import { playDoneSound } from '../../ui/sound';

/**
 * "Karte prüfen": the user reads the card once more after unpacking, and
 * the app compares it with the Paket. Returns the body and the buttons
 * separately, so a dialog and a page can place them.
 */

type Phase =
  | { kind: 'wait' }
  /** `quick`: the small files and the app's files are compared, as in every check. */
  | { kind: 'thorough'; done: number; total: number; quick?: boolean }
  | { kind: 'problem'; text: string }
  | { kind: 'result'; ok: boolean; findings: FindingText[]; reading: SnapshotResult }
  | { kind: 'confirm-accept'; reading: SnapshotResult; back: Phase };

/** Plays a track through once without sound: it fails when the file is broken. */
async function decodeOnce(blob: Blob, path: string, signal?: AbortSignal): Promise<void> {
  const pcm = await plat().audio.openPcm(fileSource(blob, path.split('/').pop()));
  try {
    while (await pcm.next(65536)) signal?.throwIfAborted();
  } finally {
    await pcm.close().catch(() => undefined);
  }
}

export interface CardCheckOptions {
  manifest: PackageManifest;
  /** Name of the card in the Finder, for the Mac command against "._" files. */
  cardName: string;
  /** The card is right: the app takes this reading as the new start. */
  onAccept?: (r: SnapshotResult) => Promise<void>;
  /** Offer to take the card as it is when the check finds something (default yes). */
  manualAccept?: boolean;
  onClose: () => void;
}

export function useCardCheck(o: CardCheckOptions): { body: ComponentChildren; footer: ComponentChildren; busy: boolean } {
  const [phase, setPhase] = useState<Phase>({ kind: 'wait' });
  const [thorough, setThorough] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const since = useRef(Date.now());
  const ctrl = useRef<AbortController | null>(null);
  const drop = useCardDrop('check');
  const opts = useRef(o);
  opts.current = o;
  const thoroughRef = useRef(thorough);
  thoroughRef.current = thorough;

  const reading = checkReading.value;
  useEffect(() => {
    if (!reading || reading.at < since.current) return;
    since.current = reading.at + 1;
    void run(reading.result);
  }, [reading]);

  useEffect(() => () => ctrl.current?.abort(), []);

  async function run(result: SnapshotResult | SnapshotProblem) {
    const { manifest, cardName, onAccept } = opts.current;
    let card: SnapshotResult;
    if (isSnapshotProblem(result)) {
      if (result.kind !== 'empty') {
        setPhase({ kind: 'problem', text: problemText(result, checkReading.peek()?.source ?? 'chooser') });
        return;
      }
      card = { root: { kind: 'directory', name: result.label ?? '', children: [] }, label: result.label ?? '', takenAt: Date.now(), files: 0, bytes: 0, source: 'chooser' };
    } else {
      card = result;
    }
    const c = new AbortController();
    ctrl.current = c;
    let res: CheckResult;
    setPhase({ kind: 'thorough', done: 0, total: 0, quick: true });
    try {
      // Sizes alone would pass a card where nothing was unpacked when only names changed: small files are compared by content.
      res = await checkCardContent(card.root, card.label, manifest, {
        signal: c.signal,
        onProgress: (done, total) => setPhase({ kind: 'thorough', done, total, quick: true }),
      });
    } catch (e) {
      ctrl.current = null;
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPhase({ kind: 'wait' });
        return;
      }
      throw e;
    }
    ctrl.current = null;
    const findings = res.findings.map((f) => findingText(f, cardName));
    let ok = res.ok;
    if (ok && thoroughRef.current) {
      ctrl.current = c;
      setPhase({ kind: 'thorough', done: 0, total: 0 });
      try {
        const t = await checkThoroughly(card.root, manifest, {
          decode: decodeOnce,
          signal: c.signal,
          onProgress: (done, total) => setPhase({ kind: 'thorough', done, total }),
        });
        if (t.crcMismatch.length) findings.unshift({ text: crcMismatchText(t.crcMismatch) });
        if (t.decodeFailed.length) findings.unshift({ text: decodeFailedText(t.decodeFailed) });
        ok = !t.crcMismatch.length && !t.decodeFailed.length;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          setPhase({ kind: 'wait' });
          return;
        }
        throw e;
      } finally {
        ctrl.current = null;
      }
    }
    if (ok && onAccept) {
      try {
        await onAccept(card);
      } catch (e) {
        toastError('Die Karte ließ sich nicht übernehmen', e);
      }
    }
    setPhase({ kind: 'result', ok, findings, reading: card });
    // The Paket is on the card, as it should be.
    if (ok) void playDoneSound('package');
  }

  const again = () => {
    since.current = Date.now();
    setPhase({ kind: 'wait' });
    chooseCardFolder('check');
  };

  const accept = async (r: SnapshotResult) => {
    if (!o.onAccept) return;
    setAccepting(true);
    try {
      await o.onAccept(r);
      o.onClose();
    } catch (e) {
      toastError('Die Karte ließ sich nicht übernehmen', e);
    } finally {
      setAccepting(false);
    }
  };

  let body: ComponentChildren;
  let footer: ComponentChildren;
  switch (phase.kind) {
    case 'wait':
    case 'problem':
      body = (
        <div class="stack">
          <p>Wähle die SD-Karte noch einmal aus. Ich schau nach, ob alles richtig angekommen ist.</p>
          {phase.kind === 'problem' ? <Callout tone="danger">{phase.text}</Callout> : null}
          <div class={`dropzone card-drop compact ${drop.over ? 'over' : ''}`} {...drop.handlers}>
            <CardReader purpose="check" over={drop.over} size="md" />
          </div>
          <label class="check-option">
            <input type="checkbox" checked={thorough} onChange={(e) => setThorough(e.currentTarget.checked)} />
            <span>Gründlich prüfen (liest alles noch einmal und spielt neue Titel testweise ab, dauert länger)</span>
          </label>
          <p class="small muted">{UPLOAD_HINT}</p>
        </div>
      );
      footer = <Button onClick={o.onClose}>Schließen</Button>;
      break;
    case 'thorough':
      body = (
        <div class="stack" role="status">
          <p>
            {phase.quick ? 'Prüft die Karte …' : 'Prüft gründlich …'} {phase.total ? `${formatBytes(phase.done)} von ${formatBytes(phase.total)}` : ''}
          </p>
          <Progress value={phase.done} max={phase.total || 1} indeterminate={!phase.total} label={phase.quick ? 'Prüfung' : 'Gründliche Prüfung'} />
          <p class="small muted">Lasse die Karte stecken, bis die Prüfung fertig ist.</p>
        </div>
      );
      footer = <Button onClick={() => ctrl.current?.abort()}>Abbrechen</Button>;
      break;
    case 'result': {
      const warnings = phase.findings.filter((f) => f.warning);
      const errors = phase.findings.filter((f) => !f.warning);
      const r = phase.reading;
      body = (
        <div class="stack">
          {phase.ok ? (
            <Callout tone="success" icon={CircleCheck}>
              {CHECK_OK_TEXT}
            </Callout>
          ) : (
            <Callout tone="danger">
              <div class="stack">
                <b>Auf der Karte stimmt noch etwas nicht.</b>
                <ul class="check-findings">
                  {errors.map((f) => (
                    <li key={f.text}>
                      <span>{f.text}</span>
                      {f.command ? <CommandLine command={f.command} /> : null}
                    </li>
                  ))}
                </ul>
              </div>
            </Callout>
          )}
          {warnings.map((f) => (
            <Callout tone="warning" key={f.text}>
              {f.text}
            </Callout>
          ))}
          {!phase.ok && o.onAccept && o.manualAccept !== false ? (
            <button type="button" class="link-button" onClick={() => setPhase({ kind: 'confirm-accept', reading: r, back: phase })}>
              Karte so übernehmen, wie sie ist
            </button>
          ) : null}
        </div>
      );
      footer = phase.ok ? (
        <Button variant="primary" onClick={o.onClose}>
          Fertig
        </Button>
      ) : (
        <>
          <Button onClick={o.onClose}>Schließen</Button>
          <Button variant="primary" icon={RotateCcw} onClick={again}>
            Noch einmal prüfen
          </Button>
        </>
      );
      break;
    }
    case 'confirm-accept':
      body = (
        <div class="stack">
          <b>Karte so übernehmen, wie sie ist?</b>
          <p>Die Änderungen, die nicht auf der Karte angekommen sind, gehen dann verloren.</p>
        </div>
      );
      footer = (
        <>
          <Button onClick={() => setPhase(phase.back)} disabled={accepting}>
            Abbrechen
          </Button>
          <Button variant="danger" loading={accepting} onClick={() => accept(phase.reading)}>
            So übernehmen
          </Button>
        </>
      );
      break;
  }
  return { body, footer, busy: phase.kind === 'thorough' };
}
