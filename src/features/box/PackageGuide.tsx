import type { ComponentChildren } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { CircleCheck, Download, FileCheck, TriangleAlert } from 'lucide-preact';
import { formatBytes } from '../../app/format';
import { plat, platform } from '../../app/state';
import { defaultGuideOs, guideSteps, type GuideOs, type GuideStep } from '../../core/tonuino/guide';
import type { PackageManifest } from '../../core/tonuino/package';
import { checkDownloadedPackage } from '../../core/tonuino/verify';
import type { StartedDownload } from '../../platform/types';
import { Button, Callout } from '../../ui/components/controls';
import { CommandLine } from '../../ui/components/Hints';
import { toastError } from '../../ui/components/Toast';
import { arrowKeyHandler } from '../../ui/arrowKeys';
import { packageCheckText } from './packageTexts';

/**
 * How the Paket gets onto the card, step by step, for the system the user
 * picks. Before anything is deleted or formatted, the downloaded Paket can
 * be shown to the app, which then knows it arrived whole.
 */

const OS_TABS: { os: GuideOs; label: string }[] = [
  { os: 'windows', label: 'Windows' },
  { os: 'macos', label: 'Mac' },
  { os: 'linux', label: 'Linux' },
  { os: 'chromebook', label: 'Chromebook' },
];

export interface PackageGuideProps {
  manifest: PackageManifest;
  /** The download this app started; missing for a Paket the user picked (Werkstatt). */
  download?: StartedDownload;
  /** The card had nothing on it before. */
  fresh: boolean;
  /** Name of the card as the Finder shows it (Mac commands). */
  cardName: string;
  onCardName: (name: string) => void;
  /** An earlier Paket was thrown away. */
  replacesOlder?: boolean;
  /** A Paket the app did not make for this card. */
  foreign?: boolean;
  /** The Paket file was read already and is whole (Werkstatt). */
  verified?: boolean;
  /** Nothing to unpack: only folders to delete on the card. */
  removeOnly?: boolean;
  onCheck: () => void;
  /** Whether the steps after "Paket prüfen" show (the card can be checked then). */
  onStepsOpen?: (open: boolean) => void;
}

export function PackageGuide(props: PackageGuideProps) {
  const { manifest, download } = props;
  const [os, setOs] = useState<GuideOs>(() => defaultGuideOs(platform.peek()?.os ?? 'other'));
  // The name the downloaded file really has (browsers number a second download).
  const [zipName, setZipName] = useState(manifest.name);
  const [verified, setVerified] = useState(!!props.verified);
  const [skipped, setSkipped] = useState(false);
  const tabsId = useId();
  const tabId = (o: GuideOs) => `${tabsId}-tab-${o}`;
  const panelId = `${tabsId}-panel`;

  const steps = useMemo(() => {
    const all = guideSteps({
      os,
      mode: manifest.mode,
      fresh: props.fresh,
      zipName,
      cardLabel: props.cardName.trim() || 'NO NAME',
      deleteFirst: manifest.deleteFirst,
      deleteJunk: manifest.deleteJunk,
      replacesOlder: props.replacesOlder,
      foreign: props.foreign,
    });
    if (props.removeOnly) return all.filter((s) => s.kind === 'delete' || s.kind === 'check' || s.kind === 'eject' || os === 'chromebook');
    // No download running in this visit: nothing to wait for. A Paket the user picked was read already: nothing to show again.
    if (!download) return all.filter((s) => s.kind !== 'wait' && !(props.verified && s.kind === 'verify-package'));
    return all;
  }, [os, manifest, props.fresh, zipName, props.cardName, props.replacesOlder, props.foreign, props.removeOnly, download, props.verified]);

  const gateAt = steps.findIndex((s) => s.kind === 'verify-package');
  const open = verified || skipped || gateAt < 0;
  const shown = open ? steps : steps.slice(0, gateAt + 1);
  // Told again when it changes, or for another Paket; the latest callback is used.
  const onStepsOpen = useRef(props.onStepsOpen);
  onStepsOpen.current = props.onStepsOpen;
  useEffect(() => onStepsOpen.current?.(open), [open, manifest.name]);

  return (
    <div class="stack package-guide">
      {props.removeOnly ? (
        <p>Dafür brauchst du kein Paket. Lösche nur auf der Karte, was weg soll, dann seh ich nach.</p>
      ) : download ? (
        <div class="package-download stack tight">
          <p>
            Das Paket ist in deinem Download-Ordner: <b class="break">{zipName}</b> ({formatBytes(manifest.size)}). Es ist eine ZIP-Datei.
          </p>
          <div class="row wrap">
            <span class="small muted grow">Dein Browser zeigt, wann der Download fertig ist (meist oben rechts).</span>
            <Button size="sm" variant="ghost" icon={Download} onClick={() => download.again()}>
              Noch einmal herunterladen
            </Button>
          </div>
        </div>
      ) : (
        <p>
          Das Paket: <b class="break">{zipName}</b> ({formatBytes(manifest.size)}).{props.verified ? ' Es ist vollständig.' : ''}
        </p>
      )}

      <div
        class="tabs guide-tabs"
        role="tablist"
        aria-label="Dein Computer"
        onKeyDown={arrowKeyHandler(
          OS_TABS.findIndex((t) => t.os === os),
          (i) => setOs(OS_TABS[i].os),
        )}
      >
        {OS_TABS.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.os}
            id={tabId(t.os)}
            aria-selected={os === t.os}
            aria-controls={panelId}
            tabIndex={os === t.os ? 0 : -1}
            onClick={() => setOs(t.os)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(os)}>
      <ol class="guide-steps os-steps">
        {shown.map((s, i) => (
          <GuideStepItem
            key={`${os}-${i}`}
            step={s}
            os={os}
            cardName={props.cardName}
            onCardName={props.onCardName}
            gate={
              s.kind === 'verify-package' ? (
                <VerifyPackage
                  manifest={props.foreign ? undefined : manifest}
                  expected={zipName}
                  verified={verified}
                  skipped={skipped}
                  onVerified={(name) => {
                    setZipName(name);
                    setVerified(true);
                  }}
                  onSkip={() => setSkipped(true)}
                />
              ) : null
            }
            onCheck={props.onCheck}
          />
        ))}
      </ol>
      </div>

      {download ? (
        <p class="small muted">Du kannst die App auch schließen. Prüfen kannst du die Karte später unter Werkstatt &gt; Paket auf die Karte bringen.</p>
      ) : null}
    </div>
  );
}

function GuideStepItem({
  step,
  os,
  cardName,
  onCardName,
  gate,
  onCheck,
}: {
  step: GuideStep;
  os: GuideOs;
  cardName: string;
  onCardName: (n: string) => void;
  gate: ComponentChildren;
  onCheck: () => void;
}) {
  return (
    <li class={`guide-step ${step.kind}`}>
      <div class="guide-text">{step.text}</div>
      {os === 'macos' && step.command ? (
        <label class="guide-name">
          <span class="small soft">Name der Karte im Finder</span>
          <input class="input" value={cardName} onInput={(e) => onCardName(e.currentTarget.value)} spellcheck={false} autocomplete="off" />
        </label>
      ) : null}
      {step.command ? <CommandLine command={step.command} /> : null}
      {step.altCommands?.map((a) => (
        <div class="stack tight" key={a.command}>
          <span class="small soft">{a.label}</span>
          <CommandLine command={a.command} />
        </div>
      ))}
      {gate}
      {step.kind === 'check' ? (
        <div>
          <Button size="sm" icon={CircleCheck} onClick={onCheck}>
            Karte prüfen
          </Button>
        </div>
      ) : null}
      {step.warnings?.map((w) => (
        <p class="guide-warning" key={w}>
          <TriangleAlert size={16} aria-hidden="true" />
          <span>{w}</span>
        </p>
      ))}
      {step.troubleshoot?.length ? (
        <details class="guide-more">
          <summary>Klappt das nicht?</summary>
          <div class="stack">
            {step.troubleshoot.map((t) => (
              <div class="stack tight" key={t.text}>
                <span>{t.text}</span>
                {t.command ? <CommandLine command={t.command} /> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </li>
  );
}

/** "Paket prüfen": the user shows the app the downloaded file. */
function VerifyPackage({
  manifest,
  expected,
  verified,
  skipped,
  onVerified,
  onSkip,
}: {
  manifest?: PackageManifest;
  expected: string;
  verified: boolean;
  skipped: boolean;
  onVerified: (name: string) => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pick = async () => {
    setProblem(null);
    try {
      const [file] = await plat().pickFiles({ extensions: ['zip'] });
      if (!file) return;
      setBusy(true);
      const r = await checkDownloadedPackage(file, manifest);
      if (r.ok) onVerified(r.name);
      else setProblem(packageCheckText(r, expected));
    } catch (e) {
      toastError('Das Paket ließ sich nicht lesen', e);
    } finally {
      setBusy(false);
    }
  };
  if (verified) {
    return (
      <Callout tone="success">
        {packageCheckText({ ok: true }, expected)}
      </Callout>
    );
  }
  return (
    <div class="stack tight">
      <div class="row wrap">
        <Button size="sm" variant="primary" icon={FileCheck} loading={busy} onClick={pick}>
          Paket prüfen
        </Button>
        {!skipped ? (
          <button type="button" class="link-button" onClick={onSkip}>
            Ohne Prüfung weiter
          </button>
        ) : null}
      </div>
      {problem ? <Callout tone="warning">{problem}</Callout> : null}
    </div>
  );
}
