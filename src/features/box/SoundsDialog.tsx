import { useState } from 'preact/hooks';
import { Download, FileArchive } from 'lucide-preact';
import { downloadWithProgress, installSystemSounds, readSoundPackage, TNG_SOUNDS_URL } from '../../core/tonuino/soundsinstall';
import { checkSystemSounds, CLASSIC21_SOUNDS_URL, TNG_SYSTEM_SOUNDS } from '../../core/tonuino/systemsounds';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Progress } from '../../ui/components/controls';
import { toast } from '../../ui/components/Toast';
import { card, plat, profile, releaseDecision, rescan, updateCatalog } from '../../app/state';
import { formatBytes } from '../../app/format';
import { writeGuard } from '../../app/writeguard';
import { ExternalLink } from '../help/ExternalLink';
import { canChangeCard } from '../../app/pending';
import { PackageWaitingDialog } from './PackageWaitingGate';
import { playDoneSound } from '../../ui/sound';
import { fixableLine, WriteFixButton } from './WriteAccessNotice';

/** How far the announcements are: downloading (or reading a chosen ZIP), then writing. */
export type SoundsProgress = { kind: 'download'; received: number; total?: number } | { kind: 'install'; done: number; total: number };

type Phase = { kind: 'intro' } | SoundsProgress | { kind: 'error'; message: string };

/**
 * Downloads the announcements of TonUINO-TNG (or reads a chosen ZIP) and
 * writes mp3/ and advert/ on the open card, or into its Paket. False when
 * no ZIP was chosen. Also used by "Karte einrichten" (BoxPage.tsx), where
 * the click on that button was the yes to it.
 */
export async function installSounds(fromFile: boolean, onProgress: (p: SoundsProgress) => void): Promise<boolean> {
  const s = card.value!;
  const packaged = s.volume.access === 'snapshot';
  let zip: Uint8Array;
  if (fromFile) {
    const [file] = await plat().pickFiles({ multiple: false, extensions: ['zip'] });
    if (!file) return false;
    onProgress({ kind: 'download', received: 0, total: file.size });
    zip = await file.read(0, file.size);
  } else {
    onProgress({ kind: 'download', received: 0 });
    zip = await downloadWithProgress(plat().fetch, TNG_SOUNDS_URL, (received, total) => onProgress({ kind: 'download', received, total }));
  }
  const pkg = await readSoundPackage(zip);
  onProgress({ kind: 'install', done: 0, total: pkg.files.length });
  // The old announcements go first: closing now would leave the box without some of them.
  await writeGuard.during('sounds', () =>
    installSystemSounds(s.volume.root, pkg, {
      onProgress: (p) => onProgress({ kind: 'install', done: p.done, total: p.total }),
    }),
  );
  await rescan();
  await updateCatalog((c) => {
    c.systemSounds = { version: fromFile ? 'eigene' : TNG_SYSTEM_SOUNDS.version, installedAt: Date.now() };
  });
  // An own ZIP may hold only some of them: then "alle" would be wrong, the card's problems say which are missing.
  const scan = card.value?.scan;
  const st = fromFile && !packaged && scan ? checkSystemSounds(scan, profile.value, releaseDecision.value.release) : null;
  const short = st?.state === 'missing' || st?.state === 'incomplete';
  if (packaged) toast.success('Die Ansagen sind im Paket.', 'Lade das Paket herunter und entpacke es auf die Karte.');
  else if (short) toast.info('Deine Ansagen sind auf der Karte', 'Es fehlen aber noch Ansagen, die jede Box braucht. Welche, steht unter „Meine Box“.');
  else toast.success('Systemansagen installiert', 'Die Box kann jetzt alle Ansagen abspielen.');
  void playDoneSound('sounds');
  return true;
}

/** Downloads the official announcements and writes mp3/ and advert/. */
export function SoundsDialog({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' });
  const s = card.value!;
  const hasOld = !!(s.scan?.system.mp3 || s.scan?.system.advert);
  const classic = profile.value === 'classic21';
  // Firefox, Safari: the announcements go into the Paket for the card.
  const packaged = s.volume.access === 'snapshot';

  const run = async (fromFile: boolean) => {
    try {
      if (!(await installSounds(fromFile, setPhase))) return;
      onDone?.();
      onClose();
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const busy = phase.kind === 'download' || phase.kind === 'install';
  // A downloaded Paket waits for the card: new announcements have to wait for it.
  if (!busy && !canChangeCard()) return <PackageWaitingDialog onClose={onClose} />;
  return (
    <Dialog
      title="Systemansagen installieren"
      onClose={onClose}
      dismissable={!busy}
      footer={
        busy ? null : (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            {/* Two buttons, so the main one stays on the row. Own announcements have theirs next to the sentence about them. */}
            {classic ? (
              <Button icon={FileArchive} variant="primary" onClick={() => run(true)}>
                ZIP-Datei auswählen …
              </Button>
            ) : (
              <Button variant="primary" icon={Download} onClick={() => run(false)}>
                {phase.kind === 'error' ? 'Noch einmal versuchen' : packaged ? 'Herunterladen und ins Paket legen' : 'Herunterladen und installieren'}
              </Button>
            )}
          </>
        )
      }
    >
      <div class="stack">
        {phase.kind === 'intro' || phase.kind === 'error' ? (
          <>
            <p>
              Die Box spricht mit dir: „Oh, eine neue Karte“, Titelnummern, das Admin-Menü. Diese Ansagen liegen in den Ordnern <b>mp3</b> und <b>advert</b>.
              {/* For 2.1 the box below says where they come from. */}
              {classic ? null : ` Ich lade die aktuellen Ansagen von TonUINO-TNG herunter (etwa 20 MB) und ${packaged ? 'lege sie ins Paket für die Karte' : 'spiele sie auf'}.`}
              {/* TNG_SEPTEMBER_SOUNDS: the release of 17.09.2026 only added files to the one of 25.02.2026. */}
              {classic ? null : ' Sie passen auch zu TonUINO TNG vom 25.02.2026. Die vier neueren Ansagen (Endlos-Karte, letzter Hörbuch-Ordner) bleiben dort einfach ungenutzt.'}
            </p>
            {packaged ? (
              hasOld ? (
                <Callout tone="warning">Die neuen Ansagen kommen ins Paket. Beim Entpacken ersetzt du damit die Ordner mp3 und advert. Eigene Ansagen darin gehen verloren.</Callout>
              ) : null
            ) : hasOld ? (
              <Callout tone="warning">Die vorhandenen Ordner mp3 und advert werden ersetzt. Eigene Ansagen darin gehen verloren.</Callout>
            ) : null}
            {classic ? (
              <Callout>
                Deine Box läuft mit TonUINO 2.1. Die Ansagen von TNG passen dazu nicht: Im Menü würde die Box Falsches ansagen. Lade die{' '}
                <ExternalLink href={CLASSIC21_SOUNDS_URL}>Ansagen für Version 2.1</ExternalLink> aus dem ursprünglichen TonUINO-Projekt als ZIP-Datei herunter und wähle sie hier aus. Die
                Ordner mp3 und advert darin finde ich selbst.
              </Callout>
            ) : (
              <div class="stack tight" style={{ alignItems: 'flex-start' }}>
                <p class="small muted">Du hast eigene Ansagen, zum Beispiel mit deiner Stimme? Wähle sie als ZIP-Datei aus, ich sortiere sie richtig ein und benenne sie nach ihrer Nummer, zum Beispiel 0300.mp3.</p>
                <Button size="sm" icon={FileArchive} onClick={() => run(true)}>
                  ZIP-Datei auswählen …
                </Button>
              </div>
            )}
          </>
        ) : null}
        {phase.kind === 'download' ? (
          <>
            <p class="soft">Lade die Ansagen herunter … {formatBytes(phase.received)}{phase.total ? ` von ${formatBytes(phase.total)}` : ''}</p>
            <Progress value={phase.received} max={phase.total ?? 1} indeterminate={!phase.total} />
          </>
        ) : null}
        {phase.kind === 'install' ? (
          <>
            <p class="soft">
              {packaged ? `Lege Ansage ${phase.done} von ${phase.total} ins Paket …` : `Schreibe Ansage ${phase.done} von ${phase.total} auf die Karte …`}
            </p>
            <Progress value={phase.done} max={phase.total} />
            <Callout tone="warning">{packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}</Callout>
          </>
        ) : null}
        {phase.kind === 'error' ? (
          <Callout tone="danger">
            <div class="stack tight">
              <span>{fixableLine(phase.message)}</span>
              <WriteFixButton error={phase.message} onFixed={() => setPhase({ kind: 'intro' })} />
            </div>
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
