/**
 * The check before a firmware update, as the app runs it: the Baukasten
 * manifest is loaded before the upload starts (the check itself must be quick,
 * see core/firmware/extrascheck.ts), the old firmware read off the box is
 * looked at, and a known Baukasten build is remembered for the Bedienkarte.
 */
import type { FirmwareBackup, FlashProblem } from '../../core/firmware/flash';
import type { BaukastenManifest } from '../../core/firmware/baukasten';
import { checkExtrasKept } from '../../core/firmware/extrascheck';
import { rememberBuild } from './boxbuild';
import { baukastenManifest } from './ExtrasPanel';
import type { StartFlash } from './flashsession';

export type BackupCheck = (backup: FirmwareBackup) => Promise<FlashProblem | undefined>;

/**
 * The check for one upload, or undefined when there is none: no backup is
 * read, the user said "Trotzdem aufspielen", or the old firmware goes back on.
 */
export function backupCheckFor(request: StartFlash, manifest: BaukastenManifest | undefined, remember: typeof rememberBuild = rememberBuild): BackupCheck | undefined {
  if (!request.backup || request.skipExtrasCheck || request.firmware.kind === 'backup') return undefined;
  const next = request.firmware.image.data;
  // A ready-made or Baukasten build is known; a file of your own may have anything.
  const known = request.firmware.kind === 'download';
  return async (backup) => {
    const { before, problem } = await checkExtrasKept(manifest, backup.data, next, known);
    if (before.build) remember(before.build, 'read');
    return problem;
  };
}

/** Loads what the check needs, before the box is touched. Without the manifest only the texts are checked. */
export async function prepareBackupCheck(request: StartFlash): Promise<BackupCheck | undefined> {
  if (!request.backup || request.skipExtrasCheck) return undefined;
  let manifest: BaukastenManifest | undefined;
  try {
    manifest = await baukastenManifest();
  } catch {
    manifest = undefined;
  }
  return backupCheckFor(request, manifest);
}
