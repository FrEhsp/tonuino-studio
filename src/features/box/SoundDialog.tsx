/**
 * "Lautstärke anpassen" and "Kleiner machen" in the menu of a folder
 * (TODO #94.1, #95a): the work of folderSound.ts with a question first.
 * Loudness measures at once and says what will happen; meanwhile one picks
 * how loud the folder should be: as loud as the others, or quieter or
 * louder on purpose (Frank 20.10.: "Leiser für die Nacht", levelOffset.ts),
 * which the catalog keeps for the folder. Smaller first asks how small.
 * Each file on the card is replaced only once its new version is complete
 * and checked.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Minimize2, Volume2 } from 'lucide-preact';
import { cleanLevelOffset, type ContentKind } from '../../core/tonuino/catalog';
import { folderName } from '../../core/tonuino/sd';
import { card, plat, settings, updateCatalog } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { formatBytes, plural } from '../../app/format';
import { Button, Callout, Progress, Segmented } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast, toastError } from '../../ui/components/Toast';
import type { TrackRow } from '../cards/trackTitles';
import { afterRewrite, messageOf } from './trackEdit';
import { isMp3 } from './tagWrite';
import type { FolderPlan, FolderRun, Measured, SoundJob } from './folderSound';
import { LevelPick } from './LevelPick';
import { levelNote, levelOffsetOf } from './levelOffset';
import { emptyEntry } from './shownRows';
import { WriteAccessNotice, WriteFixButton } from './WriteAccessNotice';

type Helpers = typeof import('./folderSound');

const db = (x: number) => `${Math.abs(x).toLocaleString('de-DE', { maximumFractionDigits: 1 })} dB`;

type Phase =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'measure'; fraction: number }
  /** Measured: the plan follows the loudness chosen (planLevel). */
  | { kind: 'plan'; measured: Measured[] }
  | { kind: 'run'; done: number; total: number; fraction: number };

export function SoundDialog({ folder, rows, job, kind, beforeSave, onClose }: { folder: number; rows: TrackRow[]; job: SoundJob; kind?: ContentKind; beforeSave: () => void; onClose: () => void }) {
  const packaged = card.value?.volume.access === 'snapshot';
  const [helpers, setHelpers] = useState<Helpers | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [problem, setProblem] = useState<{ text: string; error: unknown } | null>(null);
  const [speech, setSpeech] = useState(kind === 'hoerspiel' || kind === 'hoerbuch');
  const [level, setLevel] = useState(settings.value.normalizeLoudness);
  /** What the folder was set to before, and what is chosen now (dB from the others, levelOffset.ts). */
  const saved = levelOffsetOf(card.value?.catalog?.folders[folderName(folder)]);
  const [offset, setOffset] = useState(saved);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const mp3s = rows.filter((r) => isMp3(r.file));
  const others = rows.length - mp3s.length;

  const measure = async (h: Helpers, analyze: boolean): Promise<Measured[] | null> => {
    const s = card.value;
    if (!s) return null;
    const c = (ctrl.current = new AbortController());
    setProblem(null);
    setPhase({ kind: 'measure', fraction: 0 });
    try {
      const dir = await s.volume.root.dir(folderName(folder));
      const files = await Promise.all(mp3s.map(async (r) => ({ file: r.file, source: await dir.source(r.file) })));
      return await h.measureFolder(files, plat().audio, { analyze, signal: c.signal, onProgress: (fraction) => setPhase({ kind: 'measure', fraction }) });
    } catch (e) {
      if (!c.signal.aborted) setProblem({ text: `Die Titel ließen sich nicht lesen. ${messageOf(e)}`, error: e });
      setPhase(job === 'shrink' ? { kind: 'choose' } : { kind: 'loading' });
      return null;
    }
  };

  useEffect(() => {
    let alive = true;
    void import('./folderSound').then(async (h) => {
      if (!alive) return;
      setHelpers(h);
      if (job === 'shrink') return setPhase({ kind: 'choose' });
      const measured = await measure(h, true);
      if (alive && measured) setPhase({ kind: 'plan', measured });
    });
    return () => {
      alive = false;
    };
  }, []);

  /** Keeps the chosen loudness with the folder, so matching again and new tracks keep it. */
  const keepOffset = async (db: number): Promise<boolean> => {
    const name = folderName(folder);
    if (levelOffsetOf(card.value?.catalog?.folders[name]) === db) return true;
    const known = !!card.value?.catalog?.folders[name];
    try {
      await updateCatalog(
        (c) => {
          const e = c.folders[name] ?? (c.folders[name] = emptyEntry(folder));
          e.levelOffsetDb = cleanLevelOffset(db);
          e.updatedAt = Date.now();
        },
        { touchFolders: known ? [] : [folder] },
      );
      return true;
    } catch (e) {
      toastError('Speichern hat nicht geklappt', e);
      return false;
    }
  };

  const run = async (measured: Measured[], plan: FolderPlan) => {
    const s = card.value;
    const before = s?.scan?.folders.find((x) => x.number === folder);
    if (!s || !before || !helpers) {
      setProblem({ text: 'Der Ordner ist nicht mehr auf der Karte. Lies die Karte neu ein.', error: null });
      return;
    }
    beforeSave();
    setProblem(null);
    const c = (ctrl.current = new AbortController());
    const result: FolderRun = { written: [], left: [] };
    let failure: unknown = null;
    setPhase({ kind: 'run', done: 0, total: 1, fraction: 0 });
    try {
      const dir = await s.volume.root.dir(folderName(folder));
      await writeGuard.during('tracks', async () => {
        try {
          await helpers.runFolderPlan(dir, measured, plan, {
            audio: plat().audio,
            signal: c.signal,
            into: result,
            onFile: (done, total, fraction) => setPhase({ kind: 'run', done, total, fraction }),
          });
        } finally {
          await afterRewrite(dir, folder, before, result.written);
        }
      });
    } catch (e) {
      failure = e;
    }
    ctrl.current = null;
    const titleOf = (f: string) => `„${rows.find((r) => r.file === f)?.title ?? f}“`;
    const left = result.left.length ? ` Unverändert geblieben: ${result.left.slice(0, 3).map((l) => `${titleOf(l.file)} (${l.reason.replace(/\.$/, '')})`).join(', ')}${result.left.length > 3 ? ' und weitere' : ''}.` : '';
    if (failure && !c.signal.aborted) {
      const done = result.written.length ? ` ${plural(result.written.length, 'Titel ist', 'Titel sind')} schon fertig.` : ' Es wurde nichts geändert.';
      setProblem({ text: `${messageOf(failure)}${done}`, error: failure });
      setPhase(job === 'shrink' ? { kind: 'choose' } : { kind: 'plan', measured });
      return;
    }
    const n = result.written.length;
    const later = packaged ? ' Kommt mit dem nächsten Paket auf die Karte.' : '';
    // Kept once a track has its new level (or all stay as they are): stopped before, the folder has its old one.
    if (job === 'level' && (n || !c.signal.aborted)) await keepOffset(plan.offsetDb);
    if (!n) toast.info('Nichts geändert', `${c.signal.aborted ? 'Angehalten, bevor ein Titel fertig war.' : 'Kein Titel ließ sich ändern.'}${left}`);
    else if (job === 'level') {
      const change = plan.gain?.convertDb ?? 0;
      const title = plan.offsetDb === 0 ? 'Lautstärke angeglichen' : plan.offsetDb < 0 ? 'Ordner ist leiser gestellt' : 'Ordner ist lauter gestellt';
      toast.success(title, `${plural(n, 'Titel ist', 'Titel sind')} jetzt ${db(change)} ${change > 0 ? 'lauter' : 'leiser'}.${later}${left}`);
    } else {
      const before = result.written.reduce((a, w) => a + w.oldSize, 0);
      const after = result.written.reduce((a, w) => a + w.size, 0);
      toast.success('Ordner ist kleiner', `${plural(n, 'Titel', 'Titel')}: vorher ${formatBytes(before)}, jetzt ${formatBytes(after)}.${later}${left}`);
    }
    onClose();
  };

  const startShrink = async () => {
    if (!helpers) return;
    const measured = await measure(helpers, level);
    if (!measured) return;
    const plan = helpers.planShrink(measured, helpers.shrinkTarget(speech ? 'speech' : 'music', settings.value.bitrateKbps), { level, offsetDb: saved });
    if (!plan.actions.some((a) => a.kind !== 'keep')) {
      setPhase({ kind: 'choose' });
      setProblem({ text: 'Die Titel sind schon so klein. Es gibt nichts zu tun.', error: null });
      return;
    }
    await run(measured, plan);
  };

  /** Nothing to convert, only a new choice to keep: the folder has that loudness already. */
  const remember = async () => {
    if (await keepOffset(offset)) {
      const note = levelNote(offset);
      toast.success(note ? `Ordner ist ${note}` : 'So laut wie die anderen', 'Der Ordner hat diese Lautstärke schon. Neue Titel bekommen sie auch.');
      onClose();
    }
  };

  const stop = () => ctrl.current?.abort();
  const busy = phase.kind === 'measure' || phase.kind === 'run';
  const measured = phase.kind === 'plan' ? phase.measured : null;
  const plan = useMemo(
    () => (measured && helpers ? helpers.planLevel(measured, { boostQuietMp3: settings.value.boostQuietMp3, bitrateKbps: settings.value.bitrateKbps, offsetDb: offset }) : null),
    [measured, helpers, offset],
  );
  const changes = !!plan?.actions.some((a) => a.kind !== 'keep');
  const keepOnly = !!plan?.already && offset !== saved;
  const writing = 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.';

  // An estimate before measuring, from what the folder page knows: lengths and sizes.
  const target = helpers?.shrinkTarget(speech ? 'speech' : 'music', settings.value.bitrateKbps);
  let now = 0;
  let after = 0;
  if (helpers && target) {
    for (const r of mp3s) {
      now += r.size;
      const est = r.durationSec ? helpers.convertedSize(r.durationSec, target, 2) : r.size;
      after += est < r.size * 0.85 ? est : r.size;
    }
  }

  return (
    <Dialog
      title={job === 'level' ? 'Lautstärke anpassen' : 'Ordner kleiner machen'}
      onClose={busy ? stop : onClose}
      dismissable={!busy}
      footer={
        busy ? (
          <Button onClick={stop}>Anhalten</Button>
        ) : (
          <>
            <Button onClick={onClose}>{plan && !changes && !keepOnly ? 'Schließen' : 'Abbrechen'}</Button>
            {job === 'level' && plan && measured && changes ? (
              <Button variant="primary" icon={Volume2} onClick={() => void run(measured, plan)}>
                {plan.offsetDb === 0 ? 'Angleichen' : (plan.gain?.convertDb ?? 0) > 0 ? 'Lauter machen' : 'Leiser machen'}
              </Button>
            ) : null}
            {job === 'level' && keepOnly ? (
              <Button variant="primary" icon={Volume2} onClick={() => void remember()}>
                Übernehmen
              </Button>
            ) : null}
            {job === 'shrink' && phase.kind === 'choose' ? (
              <Button variant="primary" icon={Minimize2} disabled={!helpers || !mp3s.length} onClick={() => void startShrink()}>
                Kleiner machen
              </Button>
            ) : null}
          </>
        )
      }
    >
      <div class="stack">
        <WriteAccessNotice />
        {job === 'level' && phase.kind !== 'run' ? <LevelPick value={offset} onChange={setOffset} /> : null}
        {job === 'level' ? <LevelText plan={plan} mp3s={mp3s.length} others={others} saved={saved} /> : null}
        {job === 'shrink' && (phase.kind === 'choose' || phase.kind === 'loading') ? (
          <>
            <p>
              Ich wandle die Titel neu um, damit sie weniger Platz brauchen. Bei Hörspielen hört man fast keinen Unterschied, bei Musik etwas.
              {others > 0 ? ` ${plural(others, 'Datei ist', 'Dateien sind')} keine MP3 und ${others === 1 ? 'bleibt' : 'bleiben'}, wie sie ist.` : ''}
            </p>
            <Segmented<'speech' | 'music'>
              label="Wofür"
              value={speech ? 'speech' : 'music'}
              options={[
                { value: 'speech', label: 'Sprache (Mono)' },
                { value: 'music', label: 'Musik (Stereo)' },
              ]}
              onChange={(v) => setSpeech(v === 'speech')}
            />
            <p class="small muted">
              {speech ? 'Mono mit 64 kbit/s: genug für Hörspiele und Hörbücher, etwa halb so groß wie vorher.' : `Stereo mit ${target?.bitrateKbps ?? 128} kbit/s: kleiner wird nur, was jetzt in besserer Qualität auf der Karte ist.`}
              {now && after < now ? ` Jetzt ${formatBytes(now)}, danach etwa ${formatBytes(after)}.` : now ? ' Die Titel sind schon so klein, viel spart das nicht.' : ''}
            </p>
            <label class="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={level} onChange={(e) => setLevel(e.currentTarget.checked)} />
              <span>
                Dabei auch die Lautstärke angleichen
                <span class="small muted" style={{ display: 'block' }}>
                  {saved ? `So, wie du den Ordner gestellt hast: ${levelNote(saved)}.` : 'Wie beim Hinzufügen: so laut wie deine anderen Titel.'} Dafür messe ich vorher jeden Titel.
                </span>
              </span>
            </label>
            <Callout tone="neutral">Rückgängig machen lässt sich das nicht. Bilder in den Dateien fallen weg, Titel und Namen bleiben. Jeder alte Titel wird erst ersetzt, wenn der neue fertig und geprüft ist.</Callout>
          </>
        ) : null}
        {problem ? (
          <Callout tone={problem.error ? 'danger' : 'info'}>
            <div class="stack tight">
              <span>{problem.text}</span>
              {problem.error ? <WriteFixButton error={problem.error} /> : null}
            </div>
          </Callout>
        ) : null}
        {phase.kind === 'measure' ? (
          <div class="stack tight">
            <span class="small">Ich messe die Titel …</span>
            <Progress value={phase.fraction} label="Titel messen" />
          </div>
        ) : null}
        {phase.kind === 'run' ? (
          <div class="stack tight">
            <span class="small">
              {job === 'level' ? 'Passe die Lautstärke an' : 'Mache die Titel kleiner'} … {Math.min(phase.done + 1, phase.total)} von {phase.total}. {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : writing}
            </span>
            <Progress value={phase.done + phase.fraction} max={Math.max(1, phase.total)} label={job === 'level' ? 'Lautstärke anpassen' : 'Kleiner machen'} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** What "Lautstärke anpassen" found and will do, in words. */
function LevelText({ plan, mp3s, others, saved }: { plan: FolderPlan | null; mp3s: number; others: number; saved: number }) {
  const rest = others > 0 ? ` ${plural(others, 'Datei ist', 'Dateien sind')} keine MP3 und ${others === 1 ? 'bleibt' : 'bleiben'}, wie sie ist.` : '';
  if (!plan) {
    return (
      <p>
        Ich messe, wie laut die {plural(mp3s, 'Titel', 'Titel')} in diesem Ordner sind. Dann bringe ich den Ordner auf dieselbe Lautstärke wie deine anderen Titel, oder mit Absicht leiser oder lauter. Innerhalb des Ordners bleibt alles, wie es war.{rest}
      </p>
    );
  }
  if (plan.lufs === undefined) return <Callout tone="info">Ich konnte keinen Titel messen. Sind es MP3-Dateien mit Ton?{rest}</Callout>;
  const offset = plan.offsetDb;
  // New tracks of this folder get the same: said whenever the folder is or becomes quieter or louder on purpose.
  const kept = offset ? <p class="small muted">Ich merke mir das für diesen Ordner. Titel, die du später hinzufügst, bekommen dieselbe Lautstärke.</p> : null;
  if (plan.already) {
    if (!offset) return <Callout tone="success">Der Ordner hat schon die richtige Lautstärke. {saved ? 'Übernimm das, dann ist er nicht mehr leiser oder lauter gestellt.' : 'Es gibt nichts zu tun.'}{rest}</Callout>;
    return (
      <div class="stack tight">
        <Callout tone="success">Der Ordner hat schon diese Lautstärke. Umwandeln muss ich nichts.{rest}</Callout>
        {offset !== saved ? kept : null}
      </div>
    );
  }
  const g = plan.gain!;
  const louder = g.convertDb > 0;
  const n = plan.actions.filter((a) => a.kind !== 'keep').length;
  if (!n) {
    return (
      <Callout tone="info">
        {offset ? 'So laut' : 'So laut wie deine anderen Titel'} geht es nicht ohne neu umzuwandeln, sonst würden die lautesten Stellen übersteuern. Schalte in den Einstellungen „Leise MP3s lauter machen“ ein, dann wandle ich ihn dafür neu um.{rest}
      </Callout>
    );
  }
  return (
    <div class="stack tight">
      <p>
        {/* With an offset the two numbers differ (slider: from the others, here: from now): the sentence links them. */}
        {offset ? `Damit der Ordner etwa ${db(offset)} ${offset < 0 ? 'leiser' : 'lauter'} ist als deine anderen Titel, mache ich ` : `Der Ordner ist ${louder ? 'leiser' : 'lauter'} als deine anderen Titel. Ich mache `}
        {n === 1 ? 'den Titel' : `alle ${n} Titel`} um {db(g.convertDb)} {louder ? 'lauter' : 'leiser'}, alle um denselben Wert.{rest}
      </p>
      {g.boosted ? (
        <p class="small muted">Dafür wandle ich die Titel neu um. Die lautesten Stellen dämpfe ich dabei etwas, damit nichts übersteuert. Ein wenig Klangqualität geht dabei verloren.</p>
      ) : (
        <p class="small muted">Das geht ohne Qualitätsverlust: In jeder MP3 ändert sich nur ein Wert für die Lautstärke, wie mit dem Programm MP3Gain.</p>
      )}
      {g.quietDb && g.quietDb >= 1 ? (
        <p class="small muted">Ganz so laut wird er nicht, sonst würden die lautesten Stellen übersteuern. Er bleibt etwa {db(g.quietDb)} leiser.</p>
      ) : null}
      {kept}
      <p class="small muted">Jeder alte Titel wird erst ersetzt, wenn der neue fertig und geprüft ist.</p>
    </div>
  );
}
