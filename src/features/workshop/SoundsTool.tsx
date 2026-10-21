/**
 * Systemansagen: checks the announcements on the SD card (mp3/ and advert/)
 * against what the firmware expects and installs them with the same dialog
 * the start page uses. Without a card it offers the start page's way in.
 */
import { useState } from 'preact/hooks';
import { CardSim, CircleAlert, CircleCheck, FolderSearch, HardDrive, Megaphone, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-preact';
import { CardNoteCallout, CardReader, UPLOAD_HINT } from '../box/CardReader';
import { SoundsDialog } from '../box/SoundsDialog';
import { PendingChanges } from '../box/PendingChanges';
import { systemSoundsPending } from '../../app/pending';
import { useCardDrop } from '../../ui/useCardDrop';
import { SdCardArt } from '../../ui/components/Art';
import { Button, Callout, Spinner } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { card, needsPermission, openVolume, plat, profile, releaseDecision, volumes } from '../../app/state';
import { Facts, ToolHeader } from './common';
import { soundsSummary } from './sounds';
import { cardIntoDevice } from '../../app/device';

export function SoundsTool() {
  const p = plat();
  const s = card.value;
  const [open, setOpen] = useState(false);
  let body;
  if (!p.capabilities.sd && !p.capabilities.sdPackage) body = <NoSdAccess />;
  else if (!s) body = p.capabilities.sd ? <ChooseCard /> : <ReadCard />;
  else if (s.status === 'scanning') {
    body = (
      <section class="card pad">
        <p class="row soft">
          <Spinner size={18} /> Lese die SD-Karte …
        </p>
      </section>
    );
  } else if (s.status === 'error' || !s.scan) {
    body = (
      <section class="card pad stack">
        <Callout tone="danger">
          <div class="stack tight">
            <b>Die SD-Karte ließ sich nicht lesen.</b>
            <span>{s.error || 'Stecke die Karte neu ein und versuche es noch einmal.'}</span>
          </div>
        </Callout>
        <div>
          <Button variant="primary" icon={RefreshCw} onClick={() => void openVolume(s.volume)}>
            Noch einmal versuchen
          </Button>
        </div>
      </section>
    );
  } else body = <SoundsState onInstall={() => setOpen(true)} />;

  return (
    <div class="page narrow ws-page">
      <ToolHeader title="Systemansagen" intro="Die Box spricht mit dir: Titelnummern, das Admin-Menü und Hinweise. Diese Ansagen liegen auf der SD-Karte." />
      <PendingChanges />
      {body}
      {open && card.value ? <SoundsDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function SoundsState({ onInstall }: { onInstall: () => void }) {
  const s = card.value!;
  // The name the card has everywhere else; the drive's own name only next to it.
  const name = s.catalog?.name ?? s.volume.label;
  const summary = soundsSummary(s.scan!, profile.value, s.catalog?.systemSounds, releaseDecision.value);
  // Firefox, Safari: what the app shows is its copy of the card; new announcements wait in the Paket.
  const inPackage = systemSoundsPending.value;
  if (inPackage) {
    summary.title = 'Im Paket, noch nicht auf der Karte';
    summary.text = 'Die neuen Ansagen kommen mit dem Paket auf die Karte. Lade es herunter und entpacke es auf die Karte. Bis dahin spielt die Box die alten Ansagen.';
    summary.facts = summary.facts.filter((f) => f.label !== 'Installiert');
  }
  const ok = summary.state === 'ok' && !inPackage;
  const Icon = ok ? CircleCheck : summary.state === 'outdated' ? TriangleAlert : CircleAlert;
  return (
    <section class="card pad stack loose" aria-labelledby="ws-sounds-title">
      <div class="ws-sounds-state">
        <span class={`ws-tool-icon ${ok ? 'success' : 'warning'}`} aria-hidden="true">
          <Icon size={22} strokeWidth={2.2} />
        </span>
        <div class="stack tight">
          <h2 id="ws-sounds-title">{summary.title}</h2>
          <p class="soft">{summary.text}</p>
        </div>
      </div>
      {/* The numbers per folder and version only for whoever wants them (audit 0.4 #19). */}
      <details class="ws-sounds-more">
        <summary class="link-button">Mehr</summary>
        <Facts facts={summary.facts} />
      </details>
      {summary.duplicates ? <Callout tone="warning">{summary.duplicates}</Callout> : null}
      {summary.oversized ? <Callout tone="warning">{summary.oversized}</Callout> : null}
      <div class="row wrap">
        <Button variant={ok ? 'default' : 'primary'} icon={Megaphone} onClick={onInstall}>
          {summary.action}
        </Button>
        <span class="small muted">
          Karte: {name}
          {name !== s.volume.label ? ` (${s.volume.label})` : ''}
        </span>
      </div>
    </section>
  );
}

/** Firefox, Safari: the card is read in, as on the start page. */
function ReadCard() {
  const drop = useCardDrop('card');
  return (
    <>
      <CardNoteCallout />
      <section class={`card pad card-drop ${drop.over ? 'over' : ''}`} aria-labelledby="ws-read-title" {...drop.handlers}>
        <div class="ws-sounds-state">
          <div class="ws-sounds-art" aria-hidden="true">
            <SdCardArt size={96} />
          </div>
          <div class="stack">
            <h2 id="ws-read-title">Stecke die SD-Karte der Box in den Computer</h2>
            <p class="soft">Die Ansagen liegen in den Ordnern mp3 und advert auf der Karte. Lies die Karte ein, dann prüf ich, ob alle da sind.</p>
            <CardReader purpose="card" over={drop.over} size="md" />
            <p class="small muted">{UPLOAD_HINT}</p>
          </div>
        </div>
      </section>
    </>
  );
}

/** The start page's way to open a card, for people who come here first. */
function ChooseCard() {
  const p = plat();
  const list = volumes.value;
  const auto = p.capabilities.sdAutoDetect;
  const pick = async () => {
    try {
      const v = await p.volumes.pick();
      if (v) await openVolume(v);
    } catch (e) {
      toastError('Die Karte ließ sich nicht öffnen', e);
    }
  };
  return (
    <section class="card pad" aria-labelledby="ws-choose-title">
      <div class="ws-sounds-state">
        <div class="ws-sounds-art" aria-hidden="true">
          <SdCardArt size={96} />
        </div>
        <div class="stack">
          <h2 id="ws-choose-title">Stecke die SD-Karte der Box {cardIntoDevice()}</h2>
          <p class="soft">
            Die Ansagen liegen in den Ordnern mp3 und advert auf der Karte. {auto ? 'Sobald die Karte steckt, prüf ich, ob alle da sind.' : 'Wähle die Karte aus, dann prüf ich, ob alle da sind.'}
          </p>
          <div class="row wrap">
            {auto ? (
              <span class="row soft">
                <Spinner size={16} /> Warte auf die SD-Karte …
              </span>
            ) : (
              <Button variant="primary" icon={CardSim} onClick={pick}>
                SD-Karte auswählen
              </Button>
            )}
            {needsPermission.value ? (
              <Button icon={ShieldCheck} onClick={() => void p.volumes.requestPermission?.()}>
                Zugriff erlauben
              </Button>
            ) : null}
            {auto ? (
              <Button variant="ghost" icon={FolderSearch} onClick={pick}>
                Ordner selbst wählen
              </Button>
            ) : null}
          </div>
          {!auto ? <p class="small muted">Wähle im Fenster das Laufwerk der Karte selbst aus, nicht einen Ordner darauf.</p> : null}
          {auto && list.length > 1 ? (
            <div class="stack tight">
              <span class="section-title">Welches Laufwerk ist die SD-Karte?</span>
              <div class="row wrap">
                {list.map((v) => (
                  <Button key={v.id} icon={HardDrive} onClick={() => void openVolume(v)}>
                    {v.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function NoSdAccess() {
  return (
    <Callout tone="warning">
      <div class="stack tight">
        <b>Dieser Browser kann keine Ordner von der SD-Karte lesen.</b>
        <span>Nimm am Computer Firefox, Chrome, Edge oder Safari, oder die Desktop-App für Windows und Linux.</span>
        <div>
          <button type="button" class="link-button" onClick={() => navigate({ page: 'help', topic: 'browser' })}>
            Welche Möglichkeiten habe ich?
          </button>
        </div>
      </div>
    </Callout>
  );
}
