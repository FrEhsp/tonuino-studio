/**
 * Systemansagen: checks the announcements on the SD card (mp3/ and advert/)
 * against what the firmware expects and installs them with the same dialog
 * the start page uses. Without a card it offers the start page's way in.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { CardSim, FolderSearch, HardDrive, Megaphone, Play, RefreshCw, ShieldCheck, Square } from 'lucide-preact';
import { CardNoteCallout, CardReader, UPLOAD_HINT } from '../box/CardReader';
import { SoundsDialog } from '../box/SoundsDialog';
import { PendingChanges } from '../box/PendingChanges';
import { systemSoundsPending } from '../../app/pending';
import { useCardDrop } from '../../ui/useCardDrop';
import { SdCardArt } from '../../ui/components/Art';
import { Button, Callout, Spinner } from '../../ui/components/controls';
import { toast, toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { card, needsPermission, openVolume, plat, profile, releaseDecision, rescan, volumes } from '../../app/state';
import { canChangeCard } from '../../app/pending';
import { writeGuard } from '../../app/writeguard';
import { openPlayer } from '../../ui/nativeAudio';
import { istStill, stillesMp3 } from '../../core/tonuino/stillerTon';
import { Facts, ToolHeader } from './common';
import { soundsSummary } from './sounds';
import { cardIntoDevice } from '../../app/device';
import { ArcadeCap, CapHaken, CapLautsprecher } from '../../ui/icons/caps';

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
  return (
    <section class="card pad stack loose" aria-labelledby="ws-sounds-title">
      <div class="ws-sounds-state">
        {/* A real cap in full colour: green when all is there, red when something is missing (Prüfrunde 1 Aussehen 3). */}
        <ArcadeCap icon={ok ? CapHaken : CapLautsprecher} color={ok ? 'gruen' : 'rot'} size={40} />
        <div class="stack tight">
          <h2 id="ws-sounds-title">{summary.title}</h2>
          <p class="soft">{summary.text}</p>
        </div>
      </div>
      {/* The numbers per folder and version only for whoever wants them (audit 0.4 #19). */}
      <details class="ws-sounds-more">
        <summary class="link-button">Mehr</summary>
        <Facts facts={summary.facts} />
        <Piepton />
        <Anhoeren />
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

/**
 * TonUINO TNG plays mp3/0262 each time a card is put on. Who does not want
 * the beep gets a silent file in its place: deleting it would stop the box
 * after the first card (Prüfrunde 1, bastler 14; help topic „Ansagen“).
 */
function Piepton() {
  const s = card.value!;
  const mp3 = s.scan?.system.mp3;
  const piep = mp3?.files.find((f) => f.number === 262 && f.ext === 'mp3');
  const [busy, setBusy] = useState(false);
  if (profile.value !== 'tng' || !mp3 || !piep) return null;
  if (istStill(piep.size))
    return (
      <p class="small">
        <b>Piepton beim Auflegen:</b> aus. Wieder an mit „{soundsSummary(s.scan!, profile.value, s.catalog?.systemSounds, releaseDecision.value).action}“.
      </p>
    );
  const aus = async () => {
    if (!canChangeCard()) {
      toastError('Gerade nicht möglich', new Error('Das Paket ist schon heruntergeladen. Lies die Karte neu ein, dann geht es.'));
      return;
    }
    setBusy(true);
    try {
      await writeGuard.during('sounds', async () => {
        const dir = await s.volume.root.dir(mp3.dirName);
        await dir.write(piep.name, stillesMp3());
      });
      await rescan();
      if (s.volume.access === 'snapshot') toast.success('Piepton aus, im Paket', 'Lade das Paket herunter und entpacke es auf die Karte.');
      else toast.success('Piepton aus', 'Beim Auflegen bleibt die Box jetzt still.');
    } catch (e) {
      toastError('Den Piepton konnte ich nicht ausschalten', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <p class="small row wrap tight">
      <span>
        <b>Piepton beim Auflegen:</b> an.
      </span>
      <button type="button" class="link-button" disabled={busy} onClick={() => void aus()}>
        Ausschalten
      </button>
      <span class="soft">Die Datei bleibt da, nur still: Ohne sie spielt die Box nur die erste Karte.</span>
    </p>
  );
}

/** Every announcement on the card, to listen to one by one (Prüfrunde 1, bastler 14). */
function Anhoeren() {
  const s = card.value!;
  const scan = s.scan!;
  const files = (['mp3', 'advert'] as const).flatMap((d) => {
    const sys = scan.system[d];
    return sys ? sys.files.map((f) => ({ key: `${sys.dirName}/${f.name}`, dir: sys.dirName, name: f.name })) : [];
  });
  const [pick, setPick] = useState(files[0]?.key ?? '');
  const [playing, setPlaying] = useState(false);
  const player = useRef<{ free: () => void } | null>(null);
  useEffect(() => () => player.current?.free(), []);
  if (!files.length) return null;
  const stop = () => {
    player.current?.free();
    player.current = null;
    setPlaying(false);
  };
  const play = async () => {
    stop();
    const f = files.find((x) => x.key === pick);
    if (!f) return;
    try {
      const dir = await s.volume.root.dir(f.dir);
      const p = await openPlayer(await dir.source(f.name), f.name);
      player.current = p;
      p.el.addEventListener('ended', stop);
      setPlaying(true);
      await p.el.play();
    } catch (e) {
      stop();
      toastError('Diese Ansage ließ sich nicht abspielen', e);
    }
  };
  return (
    <div class="row wrap tight small">
      <label for="ws-ansage">
        <b>Ansage anhören:</b>
      </label>
      <select id="ws-ansage" class="select" style={{ width: 220 }} value={pick} onChange={(e) => (stop(), setPick(e.currentTarget.value))}>
        {files.map((f) => (
          <option key={f.key} value={f.key}>
            {f.key}
          </option>
        ))}
      </select>
      <Button size="sm" icon={playing ? Square : Play} onClick={() => (playing ? stop() : void play())}>
        {playing ? 'Stopp' : 'Abspielen'}
      </Button>
    </div>
  );
}
