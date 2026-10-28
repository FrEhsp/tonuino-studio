import { useState } from 'preact/hooks';
import { BookOpen, CircleAlert, CircleCheck, Download, Info, TriangleAlert, Wrench } from 'lucide-preact';
import type { Issue } from '../../core/tonuino/health';
import { isAutoFixable, KEEP_WORDS_LINE, noteNewFolder, planFix, repairAll, touchedFolders, type RepairPlan, type StepFailure } from '../../core/tonuino/repair';
import { checkHealth } from '../../core/tonuino/health';
import { folderName, type SdScan } from '../../core/tonuino/sd';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Progress } from '../../ui/components/controls';
import { toast, toastError } from '../../ui/components/Toast';
import { normalizeCover } from '../../ui/image';
import { card, catalogAfterRepair, healthContext, platform, rescan, runRepair, saveAfterRepair, setCover, settings, updateCatalog } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { discoverFolder } from './discover';
import { SoundsDialog } from './SoundsDialog';
import { ThoroughDialog } from './ThoroughDialog';
import { canChangeCard } from '../../app/pending';
import { openPackageDialog } from './PackageDialog';
import { openRebuildDialog } from './openDialogs';
import { PackageWaitingDialog } from './PackageWaitingGate';
import { fixableLine, WriteFixButton } from './WriteAccessNotice';

const ICON = { error: CircleAlert, warning: TriangleAlert, info: Info };

const HELPER_WAITING = 'Es ging nichts verloren. Ein Teil der Dateien wartet im Hilfsordner der App: Tippe gleich auf „Dateien zurücklegen“, dann ist alles wieder an seinem Platz.';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "3 betroffene Dateien", or folders when the items are folders ("02 Bibi/").
 * A shortened list says how many there are in all.
 */
export function itemsLabel(items: string[], total = items.length): string {
  const folders = items.filter((x) => x.endsWith('/')).length;
  const n = Math.max(total, items.length);
  const label = folders === items.length ? `${n} ${n === 1 ? 'betroffener Ordner' : 'betroffene Ordner'}` : `${n} betroffene ${folders ? 'Dateien und Ordner' : n === 1 ? 'Datei' : 'Dateien'}`;
  return n > items.length ? `${label}, hier die ersten ${items.length}` : label;
}

/**
 * Reads a folder the catalog knows by no more than a title, or not at all,
 * from the tags of its files, as "Übernehmen" on the shelf does: track
 * titles, artist, kind. What the catalog has stays. Returns the cover of
 * the tags, if any.
 */
async function fillFromFiles(scan: SdScan, n: number): Promise<{ data: Uint8Array; mimeType: string } | undefined> {
  const s = card.value!;
  const name = folderName(n);
  const d = await discoverFolder(s.volume.root, scan, n);
  if (!d) throw new Error(`In Ordner ${name} hab ich keine Titel gefunden.`);
  await updateCatalog(
    (c) => {
      const known = c.folders[name];
      if (known?.tracks.length) return;
      c.folders[name] = known ? { ...d.entry, ...known, tracks: d.entry.tracks, updatedAt: Date.now() } : d.entry;
    },
    { touchFolders: [n] },
  );
  return d.cover;
}

/** Makes a picture of the folder its cover, before the plan deletes the picture (see planRemoveOthers). */
async function takeCover(scan: SdScan, take: { folder: number; file: string }) {
  const s = card.value!;
  const name = folderName(take.folder);
  if (!s.catalog?.folders[name]) await fillFromFiles(scan, take.folder);
  const bytes = await (await s.volume.root.dir(name)).read(take.file);
  const img = await normalizeCover(bytes, /\.png$/i.test(take.file) ? 'image/png' : 'image/jpeg');
  await setCover(take.folder, img.data, img.mimeType, 'Datei');
  // Nothing may be deleted unless the cover really arrived in the catalog.
  if (!card.value?.catalog?.folders[name]?.cover) throw new Error('Ich konnte das Cover nicht im Katalog der Karte speichern.');
}

/** A folder renamed into place ("02 Bibi" → "02") gets track titles and a cover from its files, under the title from its old name. */
async function completeNewFolder(scan: SdScan, n: number) {
  try {
    const cover = await fillFromFiles(scan, n);
    if (cover && !card.value?.catalog?.folders[folderName(n)]?.cover) await setCover(n, cover.data, cover.mimeType, 'Datei');
  } catch {
    // The title from the folder name is there; titles from the files can still come from the folder page.
  }
}

/** What to make of files that could not be deleted. */
function skippedHints(skipped: StepFailure[]): string[] {
  if (!skipped.length) return [];
  const topLevelOnly = skipped.every((x) => x.step.op === 'delete' && x.step.path.length === 1);
  if (!topLevelOnly) return ['Versuche es noch einmal. Klappt es wieder nicht, lösche diese Dateien am Computer von Hand.'];
  const mac = platform.value?.os === 'macos' ? ' macOS schützt einige davon, zum Beispiel „.Spotlight-V100“.' : '';
  return [`Diese Dateien liegen außerhalb der Hörspielordner und stören die Box meist nicht.${mac}`];
}

type Mode =
  | { kind: 'list' }
  | { kind: 'preview'; issue: Issue; plan: RepairPlan }
  | { kind: 'running'; title: string; done: number; total: number }
  | { kind: 'repair-all-confirm'; issues: Issue[] }
  | { kind: 'result'; title: string; lines: string[]; ok: boolean }
  | { kind: 'sounds' }
  | { kind: 'waiting' }
  | { kind: 'thorough' };

export function HealthDialog({ onClose }: { onClose: () => void }) {
  const s = card.value!;
  const report = s.report!;
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const fixable = report.issues.filter(isAutoFixable);
  // Firefox, Safari: a repair changes the app's copy of the card and comes with the next Paket.
  const packaged = s.volume.access === 'snapshot';

  const startFix = (issue: Issue) => {
    if (!issue.fix || !s.scan) return;
    if (!canChangeCard()) return setMode({ kind: 'waiting' });
    if (issue.fix.kind === 'install-system-sounds') return setMode({ kind: 'sounds' });
    if (issue.fix.kind === 'confirm-fat32') {
      // Noted in the catalog of the card, so the guess stays quiet for this card on every computer.
      void updateCatalog((c) => {
        c.formatChecked = Date.now();
      })
        .then(() => toast.success('Danke, notiert', 'Bei dieser Karte frag ich nicht mehr nach dem Format.'))
        .catch((e) => toastError('Das ließ sich nicht auf der Karte speichern', e));
      return;
    }
    try {
      setMode({ kind: 'preview', issue, plan: planFix(s.scan, issue.fix, { pureNumbers: settings.value.pureNumbers, catalog: s.catalog }) });
    } catch (e) {
      toastError('Diese Reparatur geht gerade nicht', e);
    }
  };

  const runPlan = async (plan: RepairPlan) => {
    const take = plan.takeCover;
    if (take && s.scan) {
      setMode({ kind: 'running', title: `Übernehme ${take.file} als Cover …`, done: 0, total: 1 });
      try {
        await takeCover(s.scan, take);
      } catch (e) {
        setMode({
          kind: 'result',
          ok: false,
          title: 'Das Cover ließ sich nicht übernehmen',
          lines: [message(e), 'Gelöscht wurde nichts. Wähle auf der Seite des Ordners selbst ein Cover und versuche es dann noch einmal.'],
        });
        return;
      }
    }
    setMode({ kind: 'running', title: plan.title, done: 0, total: plan.steps.length });
    try {
      // The catalog follows what really happened on the card, also when it stopped half way.
      const { result, done, scan } = await runRepair(plan, {
        kind: 'repair',
        onProgress: (p) => setMode({ kind: 'running', title: plan.title, done: p.done, total: p.total }),
        prepare: (c, sofar) => noteNewFolder(c, plan, sofar),
      });
      if (plan.newTitle && done.length && scan) await completeNewFolder(scan, plan.newTitle.folder);
      const problems = [...result.skipped.map((x) => x.message), ...plan.leftovers];
      if (result.error) {
        const next = scan?.tempDirs.length ? HELPER_WAITING : 'Es ging nichts verloren. Lies die Karte neu ein und versuche es noch einmal.';
        setMode({ kind: 'result', ok: false, title: 'Die Reparatur wurde unterbrochen', lines: [result.error.message, next] });
      } else if (problems.length) {
        setMode({ kind: 'result', ok: false, title: 'Nicht alles hat geklappt', lines: [...problems.map((p) => `• ${p}`), ...skippedHints(result.skipped)] });
      } else {
        toast.success(plan.title, packaged ? 'Kommt ins Paket für die Karte.' : 'Erledigt.');
        setMode({ kind: 'list' });
      }
    } catch (e) {
      setMode({ kind: 'result', ok: false, title: 'Die Reparatur wurde unterbrochen', lines: [message(e)] });
    }
  };

  const runAll = async () => {
    setMode({ kind: 'running', title: 'Alles reparieren', done: 0, total: 1 });
    try {
      const touched = new Set<number>();
      const renamed: number[] = [];
      const result = await writeGuard.during('repair', () =>
        repairAll(s.volume.root, (scan) => checkHealth(scan, healthContext(card.value ?? s)), {
          planOptions: { pureNumbers: settings.value.pureNumbers, catalog: s.catalog },
          onExecuted: async (_issue, plan, done) => {
            await catalogAfterRepair(plan, done, (c) => noteNewFolder(c, plan, done));
            for (const n of touchedFolders(done)) touched.add(n);
            if (plan.newTitle && done.length) renamed.push(plan.newTitle.folder);
          },
          onProgress: (p) => setMode({ kind: 'running', title: p.issue.title, done: p.done, total: p.total }),
        }).then(async (r) => {
          // Still while closing asks first: the catalog belongs to the repair.
          const scan = await rescan().catch(() => undefined);
          await saveAfterRepair([...touched], scan).catch(() => undefined);
          return { ...r, fresh: scan };
        }),
      );
      const scan = result.fresh;
      if (scan) for (const n of renamed) await completeNewFolder(scan, n);
      const skipped = result.steps.flatMap((st) => st.skipped);
      const lines = result.steps.map((st) => (st.error ? `✗ ${st.issue.title}: ${st.error}` : st.skipped.length ? `✗ ${st.issue.title} (nur zum Teil)` : `✓ ${st.issue.title}`));
      for (const l of result.leftovers) lines.push(`• ${l}`);
      lines.push(...skippedHints(skipped));
      if (result.error && result.scan.tempDirs.length) lines.push(HELPER_WAITING);
      const ok = !result.error && !skipped.length && !result.leftovers.length;
      setMode({ kind: 'result', ok, title: ok ? (packaged ? 'Fertig geplant' : 'Fertig repariert') : 'Nicht alles hat geklappt', lines });
    } catch (e) {
      setMode({ kind: 'result', ok: false, title: 'Die Reparatur wurde unterbrochen', lines: [message(e)] });
    }
  };

  if (mode.kind === 'sounds') return <SoundsDialog onClose={() => setMode({ kind: 'list' })} />;
  if (mode.kind === 'waiting') return <PackageWaitingDialog onClose={() => setMode({ kind: 'list' })} />;
  if (mode.kind === 'thorough') return <ThoroughDialog onClose={onClose} onBack={() => setMode({ kind: 'list' })} />;

  if (mode.kind === 'preview') {
    const { plan, issue } = mode;
    return (
      <Dialog
        title={plan.title}
        onClose={() => setMode({ kind: 'list' })}
        footer={
          <>
            <Button onClick={() => setMode({ kind: 'list' })}>Abbrechen</Button>
            <Button variant="primary" disabled={!plan.steps.length} onClick={() => runPlan(plan)}>
              {!plan.steps.length ? 'Nichts zu tun' : packaged ? 'Reparatur planen' : 'Jetzt reparieren'}
            </Button>
          </>
        }
      >
        <div class="stack">
          {issue.fixWarning ? <Callout tone="warning">{issue.fixWarning}</Callout> : null}
          <ul class="stack tight" style={{ paddingLeft: 18 }}>
            {/* The warning above already says that the words of the old names are kept. */}
            {plan.summary.filter((l) => l && !(issue.fixWarning && l === KEEP_WORDS_LINE)).slice(0, 30).map((l) => (
              <li>{l}</li>
            ))}
          </ul>
          {packaged && issue.fix?.kind === 'clean-junk' ? (
            <p class="small muted">Kein Ordner kommt dafür neu auf die Karte. Mit dem nächsten Paket zeig ich dir, welche Dateien du dort von Hand löschst.</p>
          ) : null}
          {plan.leftovers.length ? (
            <Callout tone="neutral">
              <b>Bleibt übrig, weil ich es nicht sicher lösen kann:</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {plan.leftovers.map((l) => (
                  <li>{l}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </div>
      </Dialog>
    );
  }

  if (mode.kind === 'running') {
    return (
      <Dialog title={packaged ? 'Plant die Reparatur …' : 'Repariere die SD-Karte …'} onClose={() => undefined} dismissable={false}>
        <div class="stack">
          <p class="soft">{mode.title}</p>
          <Progress value={mode.done} max={Math.max(1, mode.total)} label="Fortschritt" />
          <Callout tone="warning">{packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}</Callout>
        </div>
      </Dialog>
    );
  }

  if (mode.kind === 'result') {
    return (
      <Dialog
        title={mode.title}
        onClose={() => setMode({ kind: 'list' })}
        footer={
          packaged && mode.ok ? (
            <>
              <Button onClick={() => setMode({ kind: 'list' })}>Weiter</Button>
              <Button
                variant="primary"
                icon={Download}
                onClick={() => {
                  onClose();
                  openPackageDialog('choose');
                }}
              >
                Paket herunterladen
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => setMode({ kind: 'list' })}>
              Weiter
            </Button>
          )
        }
      >
        <div class="stack tight">
          {mode.lines.map((l) => (
            <div class="small">{fixableLine(l)}</div>
          ))}
          {/* The app may not write on the card: get the rights here, then repair again from the list. */}
          {mode.ok ? null : <WriteFixButton error={mode.lines.join(' ')} onFixed={() => setMode({ kind: 'list' })} />}
        </div>
      </Dialog>
    );
  }

  if (mode.kind === 'repair-all-confirm') {
    const warnings = mode.issues.map((i) => i.fixWarning).filter(Boolean);
    return (
      <Dialog
        title="Alles reparieren?"
        onClose={() => setMode({ kind: 'list' })}
        footer={
          <>
            <Button onClick={() => setMode({ kind: 'list' })}>Abbrechen</Button>
            <Button variant="primary" icon={Wrench} onClick={runAll}>
              {packaged ? 'Reparatur planen' : 'Jetzt reparieren'}
            </Button>
          </>
        }
      >
        <div class="stack">
          <p>{packaged ? 'Das plane ich nacheinander:' : 'Das behebe ich nacheinander:'}</p>
          <ul class="stack tight" style={{ paddingLeft: 18 }}>
            {mode.issues.map((i) => (
              <li>{i.title}</li>
            ))}
          </ul>
          {warnings.length ? <Callout tone="warning">{[...new Set(warnings)][0]}</Callout> : null}
          <p class="small muted">Deine Hörspiele werden dabei nur umbenannt oder verschoben, nie gelöscht. Versteckte Systemdateien werden entfernt.</p>
          {packaged ? (
            <p class="small muted">Auf der Karte änderst du erst etwas, wenn du das Paket entpackst. Am saubersten ist danach „Karte komplett neu aufbauen“.</p>
          ) : null}
        </div>
      </Dialog>
    );
  }

  // Like the banner: no "in Ordnung" for the whole card when its format could not be checked.
  const okTitle = report.issues.some((i) => i.id === 'fs-unknown' || i.id === 'not-a-card') ? 'Ordner und Dateien sind in Ordnung' : 'Die SD-Karte ist in Ordnung';
  return (
    <Dialog
      title={report.status === 'ok' ? okTitle : 'Gesundheitscheck der SD-Karte'}
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Schließen</Button>
          {fixable.length ? (
            <Button variant="primary" icon={Wrench} onClick={() => setMode(canChangeCard() ? { kind: 'repair-all-confirm', issues: fixable } : { kind: 'waiting' })}>
              Alles reparieren
            </Button>
          ) : null}
        </>
      }
    >
      {report.issues.length === 0 ? (
        <div class="empty" style={{ padding: 24 }}>
          <CircleCheck size={40} color="var(--success)" />
          <p>Keine Probleme gefunden. Die Box sollte alles finden und abspielen.</p>
        </div>
      ) : (
        <div class="issue-list">
          {report.issues.map((issue) => {
            const Icon = ICON[issue.severity];
            return (
              <div class={`issue ${issue.severity}`} key={issue.id}>
                <Icon class="issue-icon" size={20} strokeWidth={2.2} />
                <div class="grow">
                  <div style={{ fontWeight: 700 }}>{issue.title}</div>
                  <div class="small soft">{issue.detail}</div>
                  {issue.help ? (
                    <a class="link-button" href={issue.help}>
                      <BookOpen size={15} aria-hidden="true" /> Mehr dazu in der Hilfe
                    </a>
                  ) : null}
                  {issue.items?.length ? (
                    <details>
                      <summary class="small muted" style={{ cursor: 'pointer', marginTop: 4 }}>
                        {itemsLabel(issue.items, issue.itemsTotal)}
                      </summary>
                      <div class="issue-items">
                        {issue.items.map((x) => (
                          <div>{x}</div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
                {issue.fix ? (
                  // One purple button: with „Alles reparieren“ below, the single fixes are plain buttons.
                  <Button size="sm" variant={issue.severity === 'error' && !fixable.length ? 'primary' : 'default'} onClick={() => startFix(issue)}>
                    {issue.fixLabel ?? 'Beheben'}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <p class="rebuild-entry small">
        <span class="muted">Spielt die Box trotzdem nicht richtig? Oft hilft es, die Karte neu aufzubauen:</span>{' '}
        <button
          type="button"
          class="link-button"
          onClick={() => {
            onClose();
            if (packaged) openPackageDialog('choose');
            else openRebuildDialog('rebuild');
          }}
        >
          Karte neu aufbauen …
        </button>
      </p>
      {s.scan ? (
        <details class="health-more small">
          <summary>Mehr</summary>
          <p>
            <button type="button" class="link-button" onClick={() => setMode({ kind: 'thorough' })}>
              Gründlich prüfen …
            </button>{' '}
            <span class="muted">Liest jede MP3 einmal ganz. Findet kaputte Dateien und eine SD-Karte, die schwächelt.</span>
          </p>
        </details>
      ) : null}
    </Dialog>
  );
}
