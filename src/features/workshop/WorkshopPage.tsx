/**
 * Werkstatt: tools for the box itself. #/werkstatt shows the overview,
 * #/werkstatt/<tool> one tool.
 */
import '../../ui/styles/workshop.css';
import { checkSystemSounds } from '../../core/tonuino/systemsounds';
import { card, plat, profile, releaseDecision } from '../../app/state';
import { systemSoundsPending } from '../../app/pending';
import { BoxSettingsTool } from './BoxSettingsTool';
import { BoxTestTool } from './BoxTestTool';
import { starteBoxWaechter } from './boxwatch';
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
import { USB_HELP_TITLE, UsbHelpTool } from './UsbHelpTool';
import { soundsOverviewNote } from './sounds';
import { percent } from './wizard';
import { routeToHash } from '../../app/router';
import { openForum } from '../../app/Kopf';
import { UpdateNotice } from '../../app/UpdateNotice';
import { navBadge, sourcesAvailable } from '../sources/state';

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

/**
 * The overview (0.6): everything that is not one of the three tasks in
 * front, as a plain list in three groups, a name and one sentence each. No
 * tiles with symbols (ki-look-recherche.md). Each tool keeps its note
 * („Läuft gerade, 40 %“, „Nur am Computer“).
 */
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
  const logNote: Note | undefined = serialOk ? undefined : { text: phoneOnly ? 'Live nur am Computer, Dateien auch hier' : 'Live nicht in diesem Browser, Dateien schon', tone: 'warn' };
  const readerNote: Note | undefined = serialOk ? undefined : { text: phoneOnly ? 'Nur am Computer' : 'Nicht in diesem Browser', tone: 'warn' };
  const sdNote: Note | undefined = p.mobile && !p.capabilities.sd ? { text: 'Nur am Computer', tone: 'warn' } : undefined;
  const sources = sourcesAvailable.value ? navBadge.value : null;

  return (
    <div class="page ws-page ws-overview">
      <header class="page-header">
        <div class="titles">
          <h1>Werkstatt</h1>
        </div>
      </header>
      <div class="ws-gruppen">
        <section class="ws-gruppe" aria-labelledby="ws-box">
          <h2 id="ws-box">Deine Box und ihre Musik</h2>
          <ul class="ws-liste">
            <Row href={routeToHash({ page: 'box' })} title="Meine Box" text="Alle Ordner der SD-Karte: Cover, Namen, prüfen, reparieren." note={sdNote} />
            <Row href={routeToHash({ page: 'add' })} title="Musik genauer hinzufügen" text="Mehrere Alben auf einmal, Folgen einer Serie, Schnitt und Namen." note={sdNote} />
            {sourcesAvailable.value ? (
              <Row href={routeToHash({ page: 'sources' })} title="Entdecken" text="Freie Hörspiele und Musik, gleich für die Box." note={sources ? { text: sources.text ? `${sources.text}: ${sources.label}` : sources.label, tone: 'busy' } : undefined} />
            ) : null}
            <Row href={routeToHash({ page: 'record' })} title="Selbst aufnehmen" text="Eine Geschichte oder ein Lied mit dem Mikrofon aufnehmen." />
            <Row href={routeToHash({ page: 'cards' })} title="Viele Karten auf einmal" text="Alle Ordner der Reihe nach, Spezialkarten wie die Schlummerkarte." />
            <Row href={routeToHash({ page: 'stickers' })} title="Sticker mit allen Einstellungen" text="Schrift, Logo, Rückseite, eigenes Papier, einzelne Sticker." />
          </ul>
        </section>
        <section class="ws-gruppe" aria-labelledby="ws-bauen">
          <h2 id="ws-bauen">Box bauen und prüfen</h2>
          <ul class="ws-liste">
            <Row href="#/werkstatt/loetplan" title="Lötplan" text="Welches Kabel wohin, für 3 oder 5 Tasten. Zum Danebenlegen oder Ausdrucken." />
            <Row href="#/werkstatt/firmware" title="Firmware aufspielen" text="Neue Firmware auf die Box, über USB oder WLAN." note={firmwareNote} />
            <Row href="#/werkstatt/testen" title="Box testen" text="Tasten, Kartenleser, Ton und Wackeltest, mit der Lötstelle, die du prüfen solltest." note={readerNote} />
            <Row href="#/werkstatt/logbuch" title="Box-Logbuch" text="Was die Box beim Start meldet, Zeile für Zeile erklärt." note={logNote} />
            {phoneOnly ? null : <Row href="#/werkstatt/usb" title={USB_HELP_TITLE} text="Kabel, Treiber und was sonst helfen kann, das Einfache zuerst." />}
          </ul>
        </section>
        <section class="ws-gruppe" aria-labelledby="ws-einstellen">
          <h2 id="ws-einstellen">Box einstellen und beschriften</h2>
          <ul class="ws-liste">
            <Row href="#/werkstatt/einstellen" title="Box einstellen" text="Lautstärke begrenzen, Ausschalt-Timer und Sperren, an der Box." />
            <Row href="#/werkstatt/ansagen" title="Systemansagen" text="Was die Box ansagt: Titelnummern, Menü, Hinweise." note={soundsNote()} />
            <Row href="#/werkstatt/bedienkarte" title="Bedienkarte" text="Was die Tasten kurz und lang machen, zum Ausdrucken." />
            <Row href="#/werkstatt/tastensticker" title="Tasten-Sticker" text="Runde Sticker für Play/Pause, vor, zurück, lauter, leiser." />
            {p.cardSnapshot ? <Row href="#/werkstatt/paket" title="Paket auf die Karte bringen" text="Ein Paket entpacken und die Karte damit vergleichen." /> : null}
          </ul>
        </section>
        <section class="ws-gruppe" aria-labelledby="ws-app">
          <h2 id="ws-app">Die App</h2>
          <ul class="ws-liste">
            <Row href={routeToHash({ page: 'settings' })} title="Einstellungen" text="Hell oder dunkel, Firmware deiner Box, für Bastler." />
            <Row href={routeToHash({ page: 'help' })} title="Hilfe" text="Antworten auf häufige Fragen, von der SD-Karte bis zum Löten." />
            <li>
              <button type="button" class="ws-zeile" onClick={openForum}>
                <b class="ws-zeile-titel">TonUINO-Forum</b>
                <span class="ws-zeile-text">Fragen stellen und sehen, was andere bauen. Öffnet sich im Browser.</span>
              </button>
            </li>
          </ul>
          <UpdateNotice />
        </section>
      </div>
    </div>
  );
}

function Row({ href, title, text, note }: { href: string; title: string; text: string; note?: Note }) {
  return (
    <li>
      <a class="ws-zeile" href={href}>
        <b class="ws-zeile-titel">{title}</b>
        <span class="ws-zeile-text">{text}</span>
        {note ? <span class={`ws-tool-note ${note.tone === 'warn' ? '' : note.tone}`}>{note.text}</span> : null}
      </a>
    </li>
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
