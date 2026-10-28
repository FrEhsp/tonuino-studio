import type { ComponentChildren } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { CircleCheck, Copy, FolderOpen, HardDrive, LogOut } from 'lucide-preact';
import { folderLabel, formatBytes, plural } from '../../app/format';
import { card, isBuiltInDrive, plat, platform, volumes } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { loadCatalog, serializeCatalog, type Catalog } from '../../core/tonuino/catalog';
import {
  cloneCatalog,
  cloneCovers,
  cloneSpace,
  copiedFolders,
  executeClone,
  FIRMWARE_NAMES,
  planClone,
  prepareExportFolder,
  soundsFit,
  takenText,
  type ClonePlan,
  type OtherFirmware,
} from '../../core/tonuino/clone';
import { loadCovers, type CoverMap } from '../../core/tonuino/covers';
import { isFatFilesystem } from '../../core/tonuino/health';
import { folderFiles, readBackupManifest, systemFiles, totalBytes, type CopyProgress } from '../../core/tonuino/rebuild';
import { CATALOG_FILE, COVERS_FILE, scanSd, type SdScan, type SystemDirName } from '../../core/tonuino/sd';
import type { Dir, Volume, VolumeInfo } from '../../platform/types';
import { Button, Callout, Field, Progress, Segmented, Spinner } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { errorText } from '../../ui/components/Hints';
import { toast } from '../../ui/components/Toast';
import { copyErrorText, fsName } from './rebuildTexts';
import { playDoneSound } from '../../ui/sound';
import { copyToCardDialog, openCopyToCardDialog } from './openDialogs';
import { fixableLine, WriteFixButton } from './WriteAccessNotice';

/**
 * "Auf eine andere SD-Karte kopieren": folders of this card onto the card
 * of a second box (or a folder to take there), under the same numbers so
 * the cards work in both boxes. A number taken over there is skipped, or
 * replaced when the user says so. This card is only read.
 */

export { openCopyToCardDialog };

export function CopyToCardDialogHost() {
  const d = copyToCardDialog.value;
  const s = card.value;
  if (d === null || !s || s.status !== 'ready' || !s.scan || s.volume.access === 'snapshot') return null;
  return <CopyToCardDialog key={d} onClose={() => (copyToCardDialog.value = null)} />;
}

/** The other card, or a folder on the computer to take there by hand, read. */
interface Target {
  /** Where the copy is written. */
  dir: Dir;
  label: string;
  /** A card (written for the box), or a folder on the computer (copied to the card by hand later). */
  kind: 'card' | 'folder';
  /** Folder: the folder the user picked, to read again after a stop. */
  picked?: Dir;
  volume?: Volume;
  info?: VolumeInfo;
  scan: SdScan;
  catalog: Catalog | null;
  covers: CoverMap;
}

type View =
  | { kind: 'choose' }
  | { kind: 'target' }
  | { kind: 'reading' }
  | { kind: 'plan' }
  | { kind: 'confirm' }
  | { kind: 'running'; progress: CopyProgress | null }
  | { kind: 'done'; plan: ClonePlan };

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

function CopyToCardDialog({ onClose }: { onClose: () => void }) {
  const s = card.value!;
  const scan = s.scan!;
  const source = { root: s.volume.root, catalog: s.catalog ?? null, covers: s.covers, id: s.volume.id };
  const folders = useMemo(() => [...scan.folders].sort((a, b) => a.number - b.number), [scan]);
  const [view, setView] = useState<View>({ kind: 'choose' });
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(folders.map((f) => f.number)));
  const [sounds, setSounds] = useState(true);
  // What the other box runs: from its catalog, else as the user says.
  const [otherFw, setOtherFw] = useState<OtherFirmware>('unknown');
  const [target, setTarget] = useState<Target | null>(null);
  const [decisions, setDecisions] = useState<Map<number | SystemDirName, 'skip' | 'replace'>>(new Map());
  const [name, setName] = useState(s.catalog?.name ?? 'Meine TonUINO-Box');
  const [error, setError] = useState<string[] | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const hasSounds = !!(scan.system.mp3 || scan.system.advert);
  const sourceFw = source.catalog?.profile;
  const knownFw: OtherFirmware = target?.catalog?.profile ?? otherFw;
  const soundsGo = sounds && soundsFit(sourceFw, knownFw);
  const chosenBytes =
    folders.filter((f) => chosen.has(f.number)).reduce((n, f) => n + totalBytes(folderFiles(f)), 0) +
    (sounds ? [scan.system.mp3, scan.system.advert].reduce((n, d) => n + (d ? totalBytes(systemFiles(d)) : 0), 0) : 0);

  const plan = useMemo(
    () => (target ? planClone({ source: scan, sourceCatalog: source.catalog, folders: [...chosen], sounds: soundsGo, target: target.scan, targetCatalog: target.catalog, decisions }) : null),
    [target, chosen, soundsGo, decisions],
  );

  const others = volumes.value.filter((v) => v.id !== s.volume.id && v.access !== 'snapshot' && !isBuiltInDrive(v));
  const direct = platform.value?.capabilities.sdAutoDetect;

  const read = async (picked: Dir, label: string, o: { volume?: Volume; kind?: 'card' | 'folder' } = {}) => {
    const kind = o.kind ?? 'card';
    setError(null);
    setView({ kind: 'reading' });
    try {
      const p = plat();
      if ((await p.isWithin(picked, source.root)) || (await p.isWithin(source.root, picked))) {
        setError(['Das ist diese Karte selbst. Wähle die SD-Karte der anderen Box oder einen Ordner auf deinem Computer.']);
        setView({ kind: 'target' });
        return;
      }
      // A backup changed by a copy would no longer match its own list and could not be written back.
      if (await readBackupManifest(picked)) {
        setError(['Das ist eine Sicherung. Ich kopiere nichts hinein, damit du sie weiter zurückspielen kannst. Wähle die SD-Karte der anderen Box oder einen anderen Ordner.']);
        setView({ kind: 'target' });
        return;
      }
      // A folder with other things in it gets a folder of its own for the copy.
      const dir = kind === 'folder' ? (await prepareExportFolder(picked)).dir : picked;
      const where = kind === 'folder' ? (dir.path ?? (dir === picked ? label : `${label}/${dir.name}`)) : label;
      const info = o.volume ? await p.volumes.info(o.volume).catch(() => o.volume!.info) : await p.folderInfo?.(dir).catch(() => undefined);
      const [tScan, tCatalog, tCovers] = await Promise.all([scanSd(dir), loadCatalog(dir).catch(() => null), loadCovers(dir).catch(() => new Map() as CoverMap)]);
      setTarget({ dir, label: where, kind, picked: kind === 'folder' ? picked : undefined, volume: o.volume, info, scan: tScan, catalog: tCatalog, covers: tCovers });
      setDecisions(new Map());
      if (tCatalog?.name) setName(tCatalog.name);
      setView({ kind: 'plan' });
    } catch (e) {
      setError(
        kind === 'folder'
          ? ['Der Ordner ließ sich nicht verwenden.', errorText(e), 'Wähle einen anderen Ordner, zum Beispiel einen neuen Ordner in „Dokumente“.']
          : ['Die andere Karte ließ sich nicht lesen.', errorText(e), 'Stecke sie neu ein und versuche es noch einmal.'],
      );
      setView({ kind: 'target' });
    }
  };

  const pickOther = async (kind: 'card' | 'folder') => {
    try {
      const dir = await plat().pickBackupFolder({ purpose: kind === 'card' ? 'copy' : 'export' });
      if (dir) await read(dir, dir.path ?? dir.name, { kind });
    } catch (e) {
      setError([errorText(e)]);
    }
  };

  const run = async () => {
    if (!target || !plan) return;
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setView({ kind: 'running', progress: null });
    try {
      const catalog = cloneCatalog(target.catalog, source.catalog, plan, { name, profile: knownFw === 'unknown' ? undefined : knownFw });
      const covers = cloneCovers(target.covers, source.covers, source.catalog, plan);
      await writeGuard.during('tracks', () =>
        executeClone(source.root, target.dir, plan, { catalog, covers, signal: c.signal, onProgress: (progress) => setView({ kind: 'running', progress }) }),
      );
      setView({ kind: 'done', plan });
      void playDoneSound('copy');
    } catch (e) {
      const lines = isAbort(e)
        ? ['Angehalten. Auf der anderen Karte ist nur ein Teil angekommen. Starte das Kopieren noch einmal und wähle bei den belegten Nummern „Ersetzen“.']
        : copyErrorText(e, target.kind);
      // Read the other card again: what arrived counts as taken now.
      await read(target.picked ?? target.dir, target.picked ? (target.picked.path ?? target.picked.name) : target.label, { volume: target.volume, kind: target.kind });
      setError(lines);
    } finally {
      ctrl.current = null;
    }
  };

  // The other card refused the copy for lack of rights: get them right here, then read it again and go on.
  const fixFor = target?.kind === 'card' && target.volume ? target : null;
  const errorBox = error ? (
    <Callout tone="danger">
      <div class="stack tight">
        {error.map((l) => (
          <span key={l}>{fixFor ? fixableLine(l, fixFor.volume, fixFor.info) : l}</span>
        ))}
        {fixFor ? <WriteFixButton error={error.join(' ')} volume={fixFor.volume} info={fixFor.info} onFixed={(fresh) => void read(fresh.root, fresh.label, { volume: fresh })} /> : null}
      </div>
    </Callout>
  ) : null;

  const frame = (body: ComponentChildren, footer: ComponentChildren, o: { dismissable?: boolean } = {}) => (
    <Dialog title="Auf eine andere SD-Karte kopieren" width="wide" onClose={onClose} dismissable={o.dismissable ?? true} footer={footer}>
      <div class="stack copy-card">{body}</div>
    </Dialog>
  );

  switch (view.kind) {
    case 'choose': {
      const all = chosen.size === folders.length;
      return frame(
        <>
          <p>Liegen auf der SD-Karte einer anderen Box dieselben Ordner unter derselben Nummer, funktionieren deine Karten auch dort. Ich kopiere die Ordner dafür unter ihrer Nummer auf die andere SD-Karte.</p>
          <div class="row wrap">
            <span class="section-title grow">Welche Ordner?</span>
            <button type="button" class="link-button" onClick={() => setChosen(all ? new Set() : new Set(folders.map((f) => f.number)))}>
              {all ? 'Keinen' : 'Alle'}
            </button>
          </div>
          <ul class="copy-folders">
            {folders.map((f) => {
              const id = `copy-folder-${f.number}`;
              return (
                <li key={f.number}>
                  <input
                    type="checkbox"
                    id={id}
                    checked={chosen.has(f.number)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.currentTarget.checked) next.add(f.number);
                      else next.delete(f.number);
                      setChosen(next);
                    }}
                  />
                  <label for={id} class="grow">
                    <span class="copy-num">{folderLabel(f.number)}</span> {source.catalog?.folders[f.name]?.title || `Ordner ${f.name}`}
                  </label>
                  <span class="small muted">{formatBytes(totalBytes(folderFiles(f)))}</span>
                </li>
              );
            })}
          </ul>
          {hasSounds ? (
            <label class="row copy-sounds">
              <input type="checkbox" checked={sounds} onChange={(e) => setSounds(e.currentTarget.checked)} aria-describedby="copy-sounds-hint" />
              <span class="stack tight">
                <span>Ansagen mitkopieren (Ordner mp3 und advert)</span>
                <span class="small muted" id="copy-sounds-hint">
                  Nur, wenn die andere Box dieselbe Firmware hat{sourceFw ? ` wie diese (${FIRMWARE_NAMES[sourceFw]})` : ''}. Ich prüfe das gleich oder frage dich.
                </span>
              </span>
            </label>
          ) : null}
          <p class="small muted">Zusammen {formatBytes(chosenBytes)}. Auf dieser Karte ändert sich nichts.</p>
        </>,
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!chosen.size && !sounds} onClick={() => setView({ kind: 'target' })}>
            Weiter
          </Button>
        </>,
      );
    }

    case 'target':
    case 'reading':
      return frame(
        <>
          <p>Stecke die SD-Karte der anderen Box ein. Hast du nur einen SD-Kartenleser, wähle einen Ordner auf deinem Computer. Dessen Inhalt kopierst du später selbst auf die Karte, ich zeig dir wie.</p>
          {view.kind === 'reading' ? (
            <p class="row soft" role="status">
              <Spinner size={16} /> Liest die andere Karte …
            </p>
          ) : (
            <div class="stack tight">
              {others.length ? (
                <ul class="rebuild-list">
                  {others.map((v) => (
                    <li key={v.id}>
                      <HardDrive size={20} aria-hidden="true" />
                      <span class="grow break">
                        <b>{v.label}</b>
                      </span>
                      <Button size="sm" onClick={() => read(v.root, v.label, { volume: v })}>
                        Diese Karte
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : direct ? (
                <p class="row soft small">
                  <Spinner size={16} /> Wartet auf die andere Karte …
                </p>
              ) : null}
              <div class="row wrap">
                <Button icon={HardDrive} variant={others.length || direct ? 'default' : 'primary'} onClick={() => pickOther('card')}>
                  {direct ? 'Karte selbst wählen' : 'Andere SD-Karte wählen'}
                </Button>
                <Button icon={FolderOpen} onClick={() => pickOther('folder')}>
                  Ordner auf dem Computer
                </Button>
              </div>
            </div>
          )}
          {errorBox}
        </>,
        <Button onClick={() => setView({ kind: 'choose' })}>Zurück</Button>,
      );

    case 'plan':
    case 'confirm': {
      if (!target || !plan) return null;
      const taken = [...plan.system.filter((x) => x.taken), ...plan.folders.filter((f) => f.taken)];
      const replacing = [...plan.system.filter((x) => x.action === 'replace').map((x) => `die Ansagen (${x.targetName ?? x.name})`), ...plan.folders.filter((f) => f.action === 'replace').map((f) => `${f.name} („${f.targetTitle}“)`)];
      const notFat = target.kind === 'card' && target.info?.fsType && !isFatFilesystem(target.info.fsType);
      // Whole clusters per file, the covers that come along, less what the replaced folders free.
      const coverBytes = copiedFolders(plan).reduce((n, f) => {
        const entry = source.catalog?.folders[f.name]?.cover;
        return n + (entry ? (source.covers.get(entry)?.byteLength ?? 0) : 0);
      }, 0);
      const catalogBytes = new TextEncoder().encode(serializeCatalog(cloneCatalog(target.catalog, source.catalog, plan, { name, profile: knownFw === 'unknown' ? undefined : knownFw }))).length;
      const space = cloneSpace(plan, target.scan, { cluster: target.info?.clusterSize ?? (target.kind === 'card' ? undefined : 4096), coverBytes, catalogBytes });
      const tooSmall = target.info?.freeBytes !== undefined && target.info.freeBytes < space.net;
      const otherProfile = !!target.catalog && !!sourceFw && target.catalog.profile !== sourceFw;
      const soundsLeft = sounds && hasSounds && !soundsGo;
      const replacedFolders = plan.folders.some((f) => f.action === 'replace');
      if (view.kind === 'confirm') {
        return (
          <Dialog
            title="Ordner auf der anderen Karte ersetzen?"
            onClose={() => setView({ kind: 'plan' })}
            closeButton={false}
            footer={
              <>
                <Button onClick={() => setView({ kind: 'plan' })}>Zurück</Button>
                <Button variant="danger" onClick={run}>
                  Ersetzen und kopieren
                </Button>
              </>
            }
          >
            <div class="stack">
              <p>Auf der anderen Karte lösche ich diese Ordner und lege dafür die von hier hin:</p>
              <ul class="stack tight" style={{ paddingLeft: 18 }}>
                {replacing.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {replacedFolders ? <p class="small muted">Die Karten, die dort zu diesen Ordnern gehören, spielen danach das Neue.</p> : null}
            </div>
          </Dialog>
        );
      }
      return frame(
        <>
          <p>
            {target.kind === 'folder' ? 'Ordner auf dem Computer' : 'Ziel'}: <b class="break">{target.label}</b>
            {target.info?.freeBytes !== undefined ? ` · ${formatBytes(target.info.freeBytes)} frei` : ''}
          </p>
          {notFat ? <Callout tone="warning">Die andere Karte hat das Format {fsName(target.info?.fsType)}. Die Box liest nur FAT32. Formatiere sie zuerst mit FAT32.</Callout> : null}
          {taken.length ? (
            <div class="stack tight">
              <span class="section-title">Schon belegt</span>
              <ul class="rebuild-list">
                {plan.system
                  .filter((x) => x.taken)
                  .map((x) => (
                    <TakenRow
                      key={x.name}
                      text={`Auf der anderen Karte gibt es schon Ansagen (${x.targetName ?? x.name}).`}
                      action={x.action}
                      onChange={(a) => setDecisions(new Map(decisions).set(x.name, a))}
                    />
                  ))}
                {plan.folders
                  .filter((f) => f.taken)
                  .map((f) => (
                    <TakenRow key={f.number} text={takenText(f)} action={f.action} onChange={(a) => setDecisions(new Map(decisions).set(f.number, a))} />
                  ))}
              </ul>
            </div>
          ) : null}
          <p>
            {plan.files ? (
              <>
                Ich kopiere {plural(copiedFolders(plan).length, 'Ordner', 'Ordner')}
                {plan.system.some((x) => x.action !== 'skip') ? ' und die Ansagen' : ''} ({formatBytes(plan.bytes)}).{' '}
                {plan.system.some((x) => x.action !== 'skip') ? 'Erst die Ansagen, dann die Ordner der Reihe nach.' : 'Die Ordner kommen der Reihe nach.'} Titel, Cover und Karten-Einstellungen kommen mit.
              </>
            ) : (
              'So kommt nichts auf die andere Karte. Wähle bei den belegten Nummern „Ersetzen“ oder gehe zurück und wähle andere Ordner.'
            )}
          </p>
          {!target.catalog ? (
            <>
              <Field label="Name der anderen Box" id="copy-boxname">
                <input id="copy-boxname" class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} />
              </Field>
              <div class="field">
                <span class="field-label" id="copy-fw-label">
                  Welche Firmware hat die andere Box?
                </span>
                <Segmented<OtherFirmware>
                  label="Welche Firmware hat die andere Box?"
                  value={otherFw}
                  options={[
                    { value: 'tng', label: FIRMWARE_NAMES.tng },
                    { value: 'classic21', label: FIRMWARE_NAMES.classic21 },
                    { value: 'unknown', label: 'Weiß ich nicht' },
                  ]}
                  onChange={setOtherFw}
                />
              </div>
            </>
          ) : null}
          {otherProfile ? (
            <Callout tone="info">
              Die andere Box läuft mit {FIRMWARE_NAMES[target.catalog!.profile]}, diese mit {FIRMWARE_NAMES[sourceFw!]}. Prüfe dort die Karten der kopierten Ordner, bevor du sie benutzt.
            </Callout>
          ) : null}
          {soundsLeft ? (
            <Callout tone="info">
              {knownFw === 'unknown'
                ? 'Die Ansagen kopiere ich nicht, sie müssen zur Firmware der anderen Box passen. '
                : `Die Ansagen kopiere ich nicht, denn die Ansagen dieser Box passen nicht zu ${FIRMWARE_NAMES[knownFw]}. `}
              Fehlen sie dort, spiele sie mit der Karte der anderen Box unter „Werkstatt“ › „Systemansagen“ auf.
            </Callout>
          ) : null}
          {tooSmall ? (
            <Callout tone="danger">
              Auf der anderen Karte ist zu wenig Platz: Es braucht {formatBytes(space.net)}, frei sind {formatBytes(target.info!.freeBytes!)}. Wähle weniger Ordner.
            </Callout>
          ) : null}
          {errorBox}
        </>,
        <>
          <Button onClick={() => setView({ kind: 'target' })}>Zurück</Button>
          <Button variant="primary" icon={replacing.length ? undefined : Copy} disabled={!plan.files || tooSmall} onClick={() => (replacing.length ? setView({ kind: 'confirm' }) : run())}>
            {replacing.length ? 'Weiter' : 'Kopieren'}
          </Button>
        </>,
      );
    }

    case 'running': {
      const p = view.progress;
      return frame(
        <div class="stack" role="status">
          <p>
            <b>Kopiert …</b> {p ? `${plural(p.files, 'Datei', 'Dateien')} von ${p.totalFiles}` : ''}
          </p>
          <Progress value={p?.done ?? 0} max={p?.total || 1} indeterminate={!p} label="Kopieren" />
          {p?.current ? <p class="small muted break">{p.current}</p> : null}
          <Callout tone="warning">Ziehe keine der Karten heraus, bis alles fertig ist.</Callout>
        </div>,
        <Button onClick={() => ctrl.current?.abort()}>Anhalten</Button>,
        { dismissable: false },
      );
    }

    case 'done': {
      const copied = copiedFolders(view.plan);
      const skipped = view.plan.folders.filter((f) => f.action === 'skip');
      const withSounds = view.plan.system.some((x) => x.action !== 'skip');
      const v = target?.volume;
      if (target?.kind === 'folder') {
        return frame(
          <>
            <Callout tone="success" icon={CircleCheck}>
              <b>Fertig.</b> {withSounds ? `${plural(copied.length, 'Ordner', 'Ordner')} und die Ansagen liegen` : plural(copied.length, 'Ordner liegt', 'Ordner liegen')} jetzt in „
              <span class="break">{target.label}</span>“ auf deinem Computer.
            </Callout>
            {skipped.length ? <p class="small">Übersprungen: {skipped.map((f) => f.name).join(', ')}.</p> : null}
            <FolderToCardSteps where={target.label} sounds={withSounds} />
            {errorBox}
          </>,
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>,
        );
      }
      return frame(
        <>
          <Callout tone="success" icon={CircleCheck}>
            <b>Fertig.</b> {plural(copied.length, 'Ordner ist', 'Ordner sind')} auf der anderen Karte{withSounds ? ', dazu die Ansagen' : ''}.
          </Callout>
          {skipped.length ? <p class="small">Übersprungen: {skipped.map((f) => f.name).join(', ')}.</p> : null}
          {copied.length ? <p>Die Karten dieser Ordner laufen jetzt auch in der anderen Box. Wo ein Hörbuch steht, merkt sich jede Box selbst.</p> : null}
          {errorBox}
        </>,
        <>
          {v?.canEject && platform.value?.capabilities.eject ? (
            <Button
              icon={LogOut}
              onClick={async () => {
                try {
                  await plat().volumes.eject(v);
                  toast.success('Karte ausgeworfen', 'Du kannst die andere Karte jetzt herausnehmen.');
                  onClose();
                } catch (e) {
                  setError(['Die Karte ließ sich nicht auswerfen.', errorText(e)]);
                }
              }}
            >
              Andere Karte auswerfen
            </Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        </>,
      );
    }
  }
}

/** Taking a copy from the computer to the other card by hand: the announcements first, then the folders in order (forum 13455#4–7, 14326#9). */
function FolderToCardSteps({ where, sounds }: { where: string; sounds: boolean }) {
  return (
    <div class="stack tight">
      <b>So kommt alles auf die Karte der anderen Box:</b>
      <ol class="copy-steps">
        <li>Stecke die SD-Karte der anderen Box ein. Sie muss mit FAT32 formatiert sein und sollte leer sein.</li>
        <li>
          Öffne den Ordner „<span class="break">{where}</span>“. Kopiere seinen Inhalt auf die Karte, nicht den Ordner selbst. Mache es in dieser Reihenfolge, sonst findet der MP3-Player manchmal Titel nicht:
          <ul>
            {sounds ? <li>zuerst die Ordner mp3 und advert,</li> : null}
            <li>{sounds ? 'dann' : 'zuerst'} alle Ordner 01, 02 und so weiter zusammen,</li>
            <li>
              zum Schluss die Dateien {CATALOG_FILE} und {COVERS_FILE}, wenn es sie gibt.
            </li>
          </ul>
        </li>
        <li>Öffne die Karte danach in TonUINO Studio. Hat der Computer versteckte Dateien angelegt, räumt der Gesundheitscheck sie mit „Aufräumen“ weg.</li>
      </ol>
      <p class="small muted">Liegt auf der anderen Karte schon etwas, stecke sie lieber hier ein und kopiere direkt auf die Karte. Dann prüfe ich, welche Nummern schon belegt sind.</p>
    </div>
  );
}

function TakenRow({ text, action, onChange }: { text: string; action: 'copy' | 'skip' | 'replace'; onChange: (a: 'skip' | 'replace') => void }) {
  return (
    <li class="copy-taken">
      <span class="grow small">{text}</span>
      <Segmented
        label={text}
        value={action === 'replace' ? 'replace' : 'skip'}
        options={[
          { value: 'skip', label: 'Überspringen' },
          { value: 'replace', label: 'Ersetzen' },
        ]}
        onChange={onChange}
      />
    </li>
  );
}
