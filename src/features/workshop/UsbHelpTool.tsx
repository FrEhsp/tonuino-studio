/**
 * "Computer findet die Box am USB-Kabel nicht": what the computer sees right now, and the usual
 * reasons why it does not see the box, for the system the app runs on.
 */
import { useEffect, useState } from 'preact/hooks';
import { CircleCheck, ExternalLink, RefreshCw, ShieldCheck, Usb } from 'lucide-preact';
import type { HintInfo } from '../../platform/tauri/errors';
import { Button, Spinner } from '../../ui/components/controls';
import { CommandLine, HintList, errorText } from '../../ui/components/Hints';
import { toast, toastError } from '../../ui/components/Toast';
import { plat } from '../../app/state';
import { ToolHeader } from './common';
import { usePorts } from './PortPicker';
import { desktopSerial, needsChooser, noChooserHint, portDetail, rankPorts, type DesktopSerial } from './ports';
import { BlockedSiteHint, rememberPicked } from './SerialPromptHint';
import { usbHelp, type HelpSection } from './usbhelp';
import { theDevice } from '../../app/device';

const OS_NAMES = { linux: 'Linux', windows: 'Windows', macos: 'macOS', other: 'dein System' } as const;

/** The name of this page, also in the list of the Werkstatt: what one sees, not a word of the technician (Prüfrunde 1 B6). */
export const USB_HELP_TITLE = 'Computer findet die Box am USB-Kabel nicht';

export function UsbHelpTool() {
  const p = plat();
  const desktop = desktopSerial(p.serial);
  const help = usbHelp({ os: p.os, kind: p.kind, serialSupported: p.capabilities.serial, canSetupAccess: !!desktop && p.os === 'linux', mayAskForAddon: p.serial.mayAskForAddon, phone: !!p.mobile });
  return (
    <div class="page narrow ws-page">
      <ToolHeader title={USB_HELP_TITLE} intro={`Die häufigsten Gründe, warum ${theDevice()} die Box am USB-Kabel nicht findet, die einfachen zuerst. Passend für ${p.mobile ? 'Android' : OS_NAMES[p.os]}.`} />
      {p.capabilities.serial ? <LiveCheck desktop={desktop} /> : null}
      {help.sections
        .filter((s) => !s.terminal)
        .map((s) => (
          <HelpCard key={s.id} section={s} desktop={desktop} />
        ))}
      {help.sections.some((s) => s.terminal) ? (
        <details class="ws-later">
          <summary>Hilft das alles nicht? Mehr für Linux, mit Befehlen im Terminal</summary>
          <div class="stack loose">
            {help.sections
              .filter((s) => s.terminal)
              .map((s) => (
                <HelpCard key={s.id} section={s} desktop={desktop} />
              ))}
          </div>
        </details>
      ) : null}
      {help.later.length ? (
        <details class="ws-later">
          <summary>Erst wichtig, wenn du Chrome, Edge, Firefox ab 151 oder die Desktop-App benutzt</summary>
          <div class="stack loose">
            {help.later.map((s) => (
              <HelpCard key={s.id} section={s} desktop={desktop} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** Ports the app sees now; in the desktop app also what its check finds (USB access, brltty, …). */
function LiveCheck({ desktop }: { desktop: DesktopSerial | null }) {
  const serial = plat().serial;
  const { ports, refresh, loaded } = usePorts(true);
  const ranked = rankPorts(ports);
  const [hints, setHints] = useState<HintInfo[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const diagnose = async () => {
    if (!desktop) return;
    try {
      setHints(await desktop.diagnose());
      setCheckError(null);
    } catch (e) {
      setCheckError(errorText(e));
    }
  };
  useEffect(() => {
    void diagnose();
  }, []);

  const choose = async (all: boolean) => {
    if (!serial.request) return;
    setAsking(true);
    setBlocked(false);
    const started = Date.now();
    try {
      const info = await serial.request(all ? [] : undefined);
      if (info) {
        rememberPicked();
        await refresh();
      } else setBlocked(noChooserHint(Date.now() - started, serial.mayAskForAddon));
    } catch (e) {
      toastError('Die Auswahl hat nicht geklappt', e);
    } finally {
      setAsking(false);
    }
  };

  const again = async () => {
    await refresh();
    await diagnose();
  };

  return (
    <section class="card pad stack" aria-labelledby="ws-live-title">
      <div class="row wrap">
        <h2 id="ws-live-title" class="grow">
          Was {theDevice()} gerade sieht
        </h2>
        {needsChooser(serial) ? null : (
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={again}>
            Noch einmal prüfen
          </Button>
        )}
      </div>
      {!loaded ? (
        <p class="row soft">
          <Spinner size={16} /> Suche nach Anschlüssen …
        </p>
      ) : ranked.length ? (
        <ul class="ws-ports" aria-label="Gefundene Anschlüsse">
          {ranked.map((r) => (
            <li key={r.port.id} class="ws-port ws-port-static">
              <span class="ws-port-text">
                <span class="ws-port-name">{r.port.label}</span>
                {portDetail(r.port) ? <span class="ws-port-detail">{portDetail(r.port)}</span> : null}
              </span>
              {r.fits ? (
                <span class="badge success">
                  <CircleCheck size={13} /> wohl die Box
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p class="soft">
          {needsChooser(serial)
            ? 'Noch keine Box freigegeben. Der Browser zeigt der App eine Box erst, wenn du sie einmal im Auswahlfenster wählst.'
            : 'Kein USB-Gerät zu sehen. Stecke die Box ein: Taucht sie hier nach ein paar Sekunden nicht auf, hilft einer der Punkte unten.'}
        </p>
      )}
      {needsChooser(serial) ? (
        <div class="row wrap">
          <Button icon={Usb} loading={asking} onClick={() => choose(false)}>
            {ranked.length ? 'Andere Box verbinden …' : 'Box verbinden …'}
          </Button>
          <button type="button" class="link-button" disabled={asking} onClick={() => choose(true)}>
            Alle USB-Geräte zeigen
          </button>
        </div>
      ) : null}
      {blocked ? <BlockedSiteHint /> : null}
      {desktop ? <DesktopCheck desktop={desktop} hints={hints} error={checkError} onFixed={again} /> : null}
    </section>
  );
}

function DesktopCheck({ desktop, hints, error, onFixed }: { desktop: DesktopSerial; hints: HintInfo[] | null; error: string | null; onFixed: () => void }) {
  const [busy, setBusy] = useState(false);
  const setup = async () => {
    setBusy(true);
    try {
      await desktop.setupAccess();
      toast.success('USB-Zugriff ist eingerichtet', 'Stecke die Box einmal aus und wieder ein.');
      onFixed();
    } catch (e) {
      toastError('Das Einrichten hat nicht geklappt', e);
    } finally {
      setBusy(false);
    }
  };
  if (error) return <p class="small muted">Die Prüfung des Computers ging nicht: {error}</p>;
  if (!hints) return null;
  if (!hints.length) {
    return (
      <p class="row small" style={{ color: 'var(--success-text)' }}>
        <CircleCheck size={16} /> Ich finde nichts, was den USB-Zugriff blockiert.
      </p>
    );
  }
  return (
    <div class="stack">
      <span class="section-title">Das ist der App aufgefallen</span>
      <HintList hints={hints.map((h) => ({ text: h.detail ? `${h.text} (${h.detail})` : h.text, command: h.command }))} />
      {plat().os === 'linux' ? (
        <div>
          <Button variant="primary" icon={ShieldCheck} loading={busy} onClick={setup}>
            USB-Zugriff einrichten
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function HelpCard({ section, desktop }: { section: HelpSection; desktop: DesktopSerial | null }) {
  const [busy, setBusy] = useState(false);
  const action = section.action;
  const setup = async () => {
    if (!desktop) return;
    setBusy(true);
    try {
      await desktop.setupAccess();
      toast.success('USB-Zugriff ist eingerichtet', 'Stecke die Box einmal aus und wieder ein.');
    } catch (e) {
      toastError('Das Einrichten hat nicht geklappt', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card pad ws-help" id={`usb-${section.id}`} aria-labelledby={`usb-${section.id}-title`}>
      <h2 id={`usb-${section.id}-title`}>{section.title}</h2>
      <p class="soft">{section.intro}</p>
      <ol class="ws-numbered">
        {section.steps.map((st) => (
          <li key={st.text}>
            <div class="stack tight">
              <span>{st.text}</span>
              {/* Terminal commands only for those who look for them (Prüfrunde 1 B6). */}
              {st.command ? (
                <details class="ws-befehl">
                  <summary>Befehl fürs Terminal zeigen</summary>
                  <CommandLine command={st.command} />
                </details>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {action?.kind === 'link' ? (
        <div>
          <Button icon={ExternalLink} onClick={() => void plat().openExternal(action.url)}>
            {action.label}
          </Button>
        </div>
      ) : action?.kind === 'setup-access' && desktop ? (
        <div>
          <Button variant="primary" icon={ShieldCheck} loading={busy} onClick={setup}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
