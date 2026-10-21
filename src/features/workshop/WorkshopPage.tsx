/**
 * Werkstatt: tools for the box itself. #/werkstatt shows the overview,
 * #/werkstatt/<tool> one tool.
 */
import '../../ui/styles/workshop.css';
import type { LucideIcon } from 'lucide-preact';
import { Cable, CircleQuestionMark, CirclePlay, Cpu, Keyboard, Megaphone, NotebookText, PackageOpen, ScrollText, SlidersHorizontal } from 'lucide-preact';
import { checkSystemSounds } from '../../core/tonuino/systemsounds';
import { card, plat, profile, releaseDecision } from '../../app/state';
import { systemSoundsPending } from '../../app/pending';
import { BoxSettingsTool } from './BoxSettingsTool';
import { BoxTestTool } from './BoxTestTool';
import { starteBoxWaechter } from './boxwatch';
import { NoSerial } from './common';
import { flashSession } from './flashsession';
import { FirmwareTool } from './FirmwareTool';
import { LogbookTool } from './LogbookTool';
import { KeyStickerTool } from './KeyStickerTool';
import { LoetplanTool } from './LoetplanTool';
import { ManualTool } from '../manual/ManualTool';
import { PackageTool } from './PackageTool';
import { PartsTestTool } from './PartsTestTool';
import { ReaderTestTool } from './ReaderTestTool';
import { SoundsTool } from './SoundsTool';
import { UsbHelpTool } from './UsbHelpTool';
import { soundsOverviewNote } from './sounds';
import { percent } from './wizard';
import { theDevice } from '../../app/device';

export function WorkshopPage({ tool }: { tool?: string }) {
  // Collects what the connected box reports, for the banner at the top of the tools.
  starteBoxWaechter();
  switch (tool) {
    case 'testen':
      return <BoxTestTool />;
    case 'firmware':
      return <FirmwareTool />;
    case 'einstellen':
      return <BoxSettingsTool />;
    case 'logbuch':
      return <LogbookTool />;
    case 'kartenleser':
      return <ReaderTestTool />;
    case 'tasten':
      return <PartsTestTool />;
    case 'loetplan':
      return <LoetplanTool />;
    case 'ansagen':
      return <SoundsTool />;
    case 'usb':
      return <UsbHelpTool />;
    case 'paket':
      return <PackageTool />;
    case 'bedienkarte':
      return <ManualTool />;
    case 'tastensticker':
      return <KeyStickerTool />;
    default:
      return <Overview />;
  }
}

interface Note {
  text: string;
  /** calm: worth knowing, nothing broken here (the announcements, which „Meine Box“ flags in red). */
  tone: 'warn' | 'busy' | 'ok' | 'calm';
}

function Overview() {
  const p = plat();
  const serialOk = p.capabilities.serial;
  const run = flashSession.run.value;

  // The Android app without USB to the box: the tools show all the same, the ones for the cable say where they work (audit 0.4 #28).
  const phoneOnly = !serialOk && !!p.mobile;
  let firmwareNote: Note | undefined;
  if (run.phase === 'running') firmwareNote = { text: `Läuft gerade, ${percent(run.status)} %`, tone: 'busy' };
  else if (run.phase === 'failed' && run.problem.code !== 'aborted') firmwareNote = { text: 'Hat nicht geklappt. Hier steht, was du tun kannst.', tone: 'warn' };
  else if (phoneOnly) firmwareNote = { text: 'Über USB nur am Computer, über WLAN auch hier', tone: 'warn' };
  else if (!serialOk) firmwareNote = { text: 'Per USB nur in Chrome, Edge, Firefox ab 151 oder der Desktop-App', tone: 'warn' };

  // No "connected" here: leaving the box tools for this page ends the connection (keepsLogConnection).
  // The box above already says which browsers can do it, so the tools only say that this one cannot.
  const logNote: Note | undefined = serialOk ? undefined : { text: phoneOnly ? 'Live nur am Computer, Dateien auch hier' : 'Live nicht in diesem Browser, Dateien schon', tone: 'warn' };
  const readerNote: Note | undefined = serialOk ? undefined : { text: phoneOnly ? 'Nur am Computer' : 'Nicht in diesem Browser', tone: 'warn' };

  return (
    <div class="page ws-page">
      <header class="page-header">
        <div class="titles">
          <h1>Werkstatt</h1>
          <p>Werkzeuge für die Box selbst, für neue Firmware, Einstellungen, Fehlersuche und Ansagen.</p>
        </div>
      </header>
      {!serialOk && !phoneOnly ? (
        <NoSerial>
          <span>
            Firmware über USB, Box testen und das Live-Logbuch gehen deshalb hier nicht. Alles andere schon, auch Firmware über WLAN für Boxen mit ESP32 und gespeicherte Logbuch-Dateien.
          </span>
        </NoSerial>
      ) : null}
      <div class="ws-tools">
        <ToolCard tool="firmware" icon={Cpu} title="Firmware aufspielen" text="Spiele neue Firmware auf die Box, über USB oder WLAN. Schritt für Schritt." note={firmwareNote} />
        <ToolCard tool="einstellen" icon={SlidersHorizontal} title="Box einstellen" text="Lautstärke begrenzen, Ausschalt-Timer und Sperren, Schritt für Schritt an der Box." />
        <ToolCard
          tool="testen"
          icon={Keyboard}
          title="Box testen"
          text="Fertig gelötet? Ich führ dich durch Tasten, Kartenleser in der Box, Ton und Wackeltest und zeige dir, welche Lötstelle du prüfen solltest."
          note={readerNote}
        />
        <ToolCard tool="logbuch" icon={NotebookText} tone="accent" title="Box-Logbuch" text="Sieh, was die Box beim Start meldet, mit einer Erklärung zu jeder wichtigen Zeile." note={logNote} />
        <ToolCard tool="loetplan" icon={Cable} tone="warning" title="Lötplan" text="Das große bunte Bild zum Löten, welches Kabel wohin, für 3 oder 5 Tasten. Zum Danebenlegen oder Ausdrucken." />
        <ToolCard tool="ansagen" icon={Megaphone} tone="success" title="Systemansagen" text="Prüfe und erneuere, was die Box ansagt, also Titelnummern, Menü und Hinweise." note={soundsNote()} />
        <ToolCard tool="bedienkarte" icon={ScrollText} tone="success" title="Bedienkarte" text="Eine Karte zum Ausdrucken, was die Tasten kurz und lang machen. Passend zu deiner Box, zum Verschenken." />
        <ToolCard tool="tastensticker" icon={CirclePlay} tone="accent" title="Tasten-Sticker" text="Runde Sticker mit Zeichen für die Tasten: Play/Pause, vor, zurück, lauter, leiser. Für 3 oder 5 Tasten." />
        {phoneOnly ? null : (
          <ToolCard tool="usb" icon={CircleQuestionMark} tone="warning" title="Box wird nicht erkannt?" text={`Hilfe, wenn ${theDevice()} die Box am USB-Kabel nicht findet.`} />
        )}
        {p.cardSnapshot ? (
          <ToolCard tool="paket" icon={PackageOpen} tone="accent" title="Paket auf die Karte bringen" text="Ein Paket entpacken, das du heruntergeladen oder bekommen hast, und die Karte damit vergleichen." />
        ) : null}
      </div>
    </div>
  );
}

/** What the overview can tell about the announcements on the open SD card. */
function soundsNote(): Note | undefined {
  const caps = plat().capabilities;
  if (!caps.sd && !caps.sdPackage) return { text: 'Braucht Firefox, Chrome, Edge oder Safari am Computer', tone: 'warn' };
  const scan = card.value?.status === 'ready' ? card.value.scan : undefined;
  if (!scan) return undefined;
  if (systemSoundsPending.value) return { text: 'Im Paket, noch nicht auf der Karte', tone: 'warn' };
  const note = soundsOverviewNote(checkSystemSounds(scan, profile.value, releaseDecision.value.release));
  // „Meine Box“ warns about it already: here a calm note on the tag (audit 0.4 #20).
  return note.tone === 'warn' ? { ...note, tone: 'calm' } : note;
}

function ToolCard({ tool, icon: Icon, tone, title, text, note }: { tool: string; icon: LucideIcon; tone?: 'accent' | 'success' | 'warning'; title: string; text: string; note?: Note }) {
  return (
    <a class="ws-tool" href={`#/werkstatt/${tool}`}>
      <span class={`ws-tool-icon ${tone ?? ''}`} aria-hidden="true">
        <Icon size={22} strokeWidth={2.2} />
      </span>
      <span class="ws-tool-title">{title}</span>
      <span class="ws-tool-text">{text}</span>
      {note ? <span class={`ws-tool-note ${note.tone === 'warn' ? '' : note.tone}`}>{note.text}</span> : null}
    </a>
  );
}
