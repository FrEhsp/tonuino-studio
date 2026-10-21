import { loadCatalog, saveCatalog, type Catalog } from '../../core/tonuino/catalog';
import { checkHealth, type HealthContext, type HealthReport } from '../../core/tonuino/health';
import {
  backupFolderName,
  copyEntries,
  findBackups,
  judgeTarget,
  planBackup,
  planRestore,
  totalBytes,
  type BackupEntry,
  type BackupManifest,
  type CopyProgress,
  type RestorePlan,
  type TargetJudgement,
} from '../../core/tonuino/rebuild';
import { executePlan, planFix } from '../../core/tonuino/repair';
import { isJunk, scanSd, type SdScan } from '../../core/tonuino/sd';
import type { Dir, DirEntry, Platform, Volume, VolumeInfo } from '../../platform/types';

/**
 * The steps of "Karte neu aufbauen" that talk to the platform, without the
 * dialog: where the backup goes, which card it goes back onto, and the
 * tidying up afterwards. Kept apart so the checks can be tested with stubs.
 */

/** Where the backup lives: the folder the user chose and the backup folder in it. */
export interface BackupPlace {
  parent: Dir;
  dir: Dir;
  /** Name of the backup folder in `parent`; '' when the user chose the backup folder itself. */
  name: string;
  /** An earlier backup of this card that stopped half-way: the copy goes on from it. */
  resumed: boolean;
}

/** Where to make a backup folder: Chrome does not share „Dokumente“ itself, only folders inside it. */
export const DOCUMENTS_HINT = 'zum Beispiel einen neuen Ordner in „Dokumente“';

/** Why a folder cannot take the backup, in words for the user. */
export class PlaceError extends Error {}

/**
 * Picks the backup folder inside `parent`: an unfinished backup of the
 * same card (to go on with it), else a new "TonUINO-Sicherung <Box>
 * <Datum>". Refuses a folder on the card itself and, where the platform
 * knows the free space, a drive without room for `bytes`.
 */
export async function prepareBackupPlace(
  p: Pick<Platform, 'isWithin' | 'folderInfo'>,
  parent: Dir,
  card: Dir,
  o: { boxName: string; catalogId: string; bytes: number; now?: Date },
): Promise<BackupPlace> {
  const onCard = (await p.isWithin(parent, card)) === true || (await sameDrive(p, parent, card));
  if (onCard) throw new PlaceError(`Dieser Ordner liegt auf der SD-Karte. Die Sicherung muss auf deinen Computer, sonst ist sie nach dem Formatieren weg. Wähle einen Ordner auf dem Computer, ${DOCUMENTS_HINT}.`);
  const all = await findBackups(parent);
  // The chosen folder is a backup itself: only an unfinished one of this card goes on in place.
  const own = all.find((b) => b.name === '');
  if (own && (own.manifest.complete || own.manifest.catalogId !== o.catalogId)) {
    const what = own.manifest.complete ? 'schon eine fertige Sicherung' : 'schon die Sicherung einer anderen Karte';
    throw new PlaceError(`Dieser Ordner ist ${what}. Wähle den Ordner darüber oder einen anderen Ordner. Ich lege darin einen neuen Ordner für die Sicherung an.`);
  }
  const found = all.filter((b) => b.manifest.catalogId === o.catalogId);
  const unfinished = found.find((b) => !b.manifest.complete);
  let place: BackupPlace | undefined;
  if (unfinished) {
    place = { parent, name: unfinished.name, dir: unfinished.name ? await parent.dir(unfinished.name) : parent, resumed: true };
  } else {
    const base = backupFolderName(o.boxName, o.now ?? new Date());
    let name = base;
    // Today's backup of this card is reused; anything else of that name stays as it is.
    for (let i = 2; (await parent.exists(name)) && !found.some((b) => b.name === name); i++) name = `${base} (${i})`;
    place = { parent, name, dir: await parent.dir(name, { create: true }), resumed: false };
  }
  const info = await p.folderInfo?.(parent).catch(() => undefined);
  const done = unfinished ? totalBytes(unfinished.manifest.files) : 0;
  const need = Math.max(0, o.bytes - done);
  if (info?.freeBytes !== undefined && info.freeBytes < need) {
    throw new PlaceError(`Auf diesem Laufwerk ist zu wenig Platz. Die Sicherung braucht ${gb(need)}, frei sind ${gb(info.freeBytes)}. Wähle einen Ordner auf einem anderen Laufwerk oder mache dort Platz.`);
  }
  return place;
}

const gb = (n: number) => `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(n / 1024 ** 3)} GB`;

/** Desktop: the folder lives on the card's drive (also when the card was opened as one of its folders). */
async function sameDrive(p: Pick<Platform, 'folderInfo'>, a: Dir, b: Dir): Promise<boolean> {
  if (!p.folderInfo) return false;
  const [x, y] = await Promise.all([p.folderInfo(a).catch(() => undefined), p.folderInfo(b).catch(() => undefined)]);
  const norm = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase();
  return !!x?.mountPath && !!y?.mountPath && norm(x.mountPath) === norm(y.mountPath);
}

/** What the card holds for the backup right now. */
export async function readCardForBackup(root: Dir): Promise<{ scan: SdScan; entries: BackupEntry[] }> {
  const scan = await scanSd(root);
  return { scan, entries: planBackup(scan, await root.list()) };
}

export async function runBackup(
  card: Dir,
  place: BackupPlace,
  entries: readonly BackupEntry[],
  o: { boxName: string; catalogId: string; signal?: AbortSignal; onProgress?: (p: CopyProgress) => void },
): Promise<BackupManifest> {
  const r = await copyEntries(card, place.dir, entries, { backup: { boxName: o.boxName, catalogId: o.catalogId }, signal: o.signal, onProgress: o.onProgress });
  return r.manifest!;
}

/** A card the backup could go back onto, as checked. */
export interface TargetCheck {
  volume: Volume;
  info: VolumeInfo;
  judgement: TargetJudgement;
  plan?: Extract<RestorePlan, { ok: true }>;
  /** A card that is not ready holds the catalog of the backed-up box: the old card. */
  sameBox?: boolean;
}

/**
 * Looks at a card for the restore: its format and free space (as far as
 * the platform knows them) and what is on it. A card with folders the
 * backup does not have is turned down from its root listing, without
 * reading all of it.
 */
export async function checkTarget(volume: Volume, manifest: BackupManifest, info: VolumeInfo, listed?: DirEntry[]): Promise<TargetCheck> {
  const top = (listed ?? (await volume.root.list())).filter((e) => !isJunk(e.name));
  const known = new Set(manifest.files.map((f) => f.path.split('/')[0].toLowerCase()));
  const foreign = top.filter((e) => !known.has(e.name.toLowerCase()));
  const plan: RestorePlan = foreign.length
    ? { ok: false, reason: 'not-empty', items: foreign.map((e) => (e.kind === 'directory' ? `${e.name}/` : e.name)) }
    : planRestore(manifest, await scanSd(volume.root), top);
  let judgement = judgeTarget(info, plan);
  // Part of the backup on a card while writing back never began: the old card, not formatted yet.
  // All of it on a card: the old card too (or one that needs nothing); writing back would change nothing.
  if (judgement.verdict === 'resume' && plan.ok && (!manifest.restoreStartedAt || plan.present >= plan.entries.length)) {
    judgement = { ...judgement, verdict: 'not-formatted' };
  }
  let sameBox: boolean | undefined;
  if (judgement.verdict === 'not-formatted' || judgement.verdict === 'not-empty') {
    const catalog = await loadCatalog(volume.root).catch(() => null);
    sameBox = !!catalog && !!manifest.catalogId && catalog.id === manifest.catalogId;
  }
  return { volume, info, judgement, plan: plan.ok ? plan : undefined, ...(sameBox === undefined ? {} : { sameBox }) };
}


/** The last full look at one drive, see checkTargetAgain. */
export interface TargetMemo {
  print: string;
  manifest: BackupManifest;
  at: number;
  check: TargetCheck;
}

/** What changes on a drive when it is formatted, written to or swapped: its root listing and its file system. */
export function targetPrint(top: readonly DirEntry[], info: VolumeInfo): string {
  const entries = top.map((e) => `${e.kind === 'directory' ? 'd' : 'f'}:${e.name}:${e.size ?? ''}:${e.modified ?? ''}`).sort();
  return [info.fsType ?? '', info.totalBytes ?? '', info.freeBytes ?? '', ...entries].join('|');
}

/** How long a look at an unchanged drive counts before the next full one. */
export const TARGET_RECHECK_MS = 60_000;

/**
 * checkTarget for the drives the target step watches every few seconds.
 * Only the root is listed each time; the whole card is read again only
 * when its root or file system changed, after TARGET_RECHECK_MS, or when
 * `force` says so (the window came back to the front). The old card, not
 * formatted yet, is read once rather than every few seconds.
 */
export async function checkTargetAgain(
  volume: Volume,
  manifest: BackupManifest,
  info: VolumeInfo,
  memo: Map<string, TargetMemo>,
  opts: { force?: boolean; now?: number } = {},
): Promise<TargetCheck> {
  const now = opts.now ?? Date.now();
  const top = await volume.root.list();
  const print = targetPrint(top, info);
  const last = memo.get(volume.id);
  if (!opts.force && last && last.print === print && last.manifest === manifest && now - last.at < TARGET_RECHECK_MS) {
    return { ...last.check, volume, info };
  }
  const check = await checkTarget(volume, manifest, info, top);
  memo.set(volume.id, { print, manifest, at: now, check });
  return check;
}

/** Drives the restore may go to by itself: no built-in drives (those only when the user picks them). */
export function targetCandidates(list: readonly Volume[]): Volume[] {
  return list.filter((v) => v.info.removable !== false && v.access !== 'snapshot');
}

/**
 * After writing back: forgets that someone saw FAT32 on the old card (the
 * catalog came along from it; this card was not looked at, see
 * Catalog.formatChecked), removes the hidden files a computer may have put
 * on the card meanwhile (the health check's "Aufräumen"), then returns the
 * card's health as the app sees it now.
 */
export async function tidyAfterRestore(volume: Volume, context: (catalog: Catalog | undefined) => HealthContext, pureNumbers: boolean): Promise<HealthReport> {
  const catalog = (await loadCatalog(volume.root).catch(() => null)) ?? undefined;
  if (catalog?.formatChecked !== undefined) {
    delete catalog.formatChecked;
    await saveCatalog(volume.root, catalog).catch(() => undefined);
  }
  const ctx = context(catalog);
  let scan = await scanSd(volume.root);
  let report = checkHealth(scan, ctx);
  const junk = report.issues.find((i) => i.fix?.kind === 'clean-junk');
  if (junk?.fix) {
    await executePlan(volume.root, planFix(scan, junk.fix, { pureNumbers, catalog }));
    scan = await scanSd(volume.root);
    report = checkHealth(scan, ctx);
  }
  return report;
}
