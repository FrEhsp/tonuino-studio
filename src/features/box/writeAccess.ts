/**
 * The card is there, but the app may not change anything on it. On Linux
 * that happens when the card is mounted for another user account (often
 * root, e.g. through a fixed entry the "Laufwerke" app wrote); the desktop
 * app can then mount it again for this user ("Schreibrechte holen"). A card
 * whose lock slider is down is read-only: nothing the app could change.
 */
import { signal } from '@preact/signals';
import type { Platform, Volume, VolumeInfo } from '../../platform/types';
import { card, fixCardAccess, plat, platform } from '../../app/state';
import { toast, type ToastAction } from '../../ui/components/Toast';
import { isAccessLost, isWriteDenied, withoutBoxHint } from './writeDenied';

export type WriteNoticeKind = 'fix' | 'denied' | 'read-only' | 'read-only-system';

export const FIX_LABEL = 'Schreibrechte holen';
export const WRITE_HELP = '#/hilfe/sd-karte-schreibrechte';
export const CHECK_HELP = '#/hilfe/sd-karte-pruefen';

export const WRITE_NOTICE_TITLE = 'Ich kann die Karte zeigen, aber nichts darauf ändern';

/** Which notice "Meine Box" shows for the open card, if any. */
export function writeNoticeKind(
  state: { info: VolumeInfo; writeDenied?: boolean; volume: Pick<Volume, 'access'> },
  platformCanFix: boolean,
): WriteNoticeKind | null {
  // A card read as a snapshot (Firefox, Safari) is never written directly.
  if (state.volume.access === 'snapshot') return null;
  if (state.info.readOnly) return state.info.readOnlyBySystem ? 'read-only-system' : 'read-only';
  if (state.info.writable === false || state.writeDenied) return platformCanFix && state.info.canFixAccess ? 'fix' : 'denied';
  return null;
}

/** Whether the platform can mount a card again for the user at all (desktop on Linux). */
export function canFixOn(p: Pick<Platform, 'volumes'> | null): boolean {
  return !!p?.volumes.fixAccess;
}

export function writeNoticeText(kind: WriteNoticeKind, foreignOwner: boolean): string {
  switch (kind) {
    case 'fix':
      return `Dein Benutzerkonto hat keine Schreibrechte für die SD-Karte${foreignOwner ? ', sie gehört einem anderen Konto' : ''}. Deshalb klappen Löschen, Hinzufügen und neue Ordner nicht. „${FIX_LABEL}“ bindet die Karte für dich neu ein. Dabei fragt der Computer vielleicht nach deinem Passwort.`;
    case 'denied':
      return 'Dein Benutzerkonto hat keine Schreibrechte für die SD-Karte. Deshalb klappen Löschen, Hinzufügen und neue Ordner nicht. Wirf die Karte im Dateimanager aus, ziehe sie heraus und stecke sie neu ein.';
    case 'read-only':
      return 'Die SD-Karte ist schreibgeschützt. Schiebe den kleinen Schalter an der Seite der Karte oder des Adapters nach oben und stecke sie neu ein.';
    case 'read-only-system':
      return 'Am Schalter liegt es nicht: Der Computer gibt die Karte nur zum Lesen frei. Das passiert, wenn die Verbindung beim Schreiben abgebrochen ist und auf der Karte etwas nicht mehr stimmt. Neu einstecken hilft dann nicht, die Karte muss einmal geprüft werden.';
  }
}

/** True while "Schreibrechte holen" runs. */
export const fixing = signal(false);

function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The card "Schreibrechte holen" would mount again for a write that was
 * denied there: the given one (a card that is not open, like the freshly
 * formatted one of "Karte neu aufbauen") or else the open card. Null when the
 * app cannot do that here (browser, Windows, a card whose lock slider is down,
 * a mount the system does not let it change).
 */
export function fixTarget(volume?: Volume, info?: VolumeInfo): Volume | null {
  if (!canFixOn(platform.value)) return null;
  const s = card.value;
  const v = volume ?? s?.volume;
  if (!v) return null;
  const facts = info ?? (s && s.volume.id === v.id ? s.info : v.info);
  if (writeNoticeKind({ info: facts, writeDenied: true, volume: v }, true) !== 'fix') return null;
  return v;
}

/**
 * Runs "Schreibrechte holen" for a card (the open one when none is given)
 * and says how it went. Resolves with the card as it is mounted now, or null
 * when it did not work or was cancelled.
 */
export async function fixWriteAccess(volume?: Volume): Promise<Volume | null> {
  if (fixing.value) return null;
  const v = volume ?? card.value?.volume;
  const fix = plat().volumes.fixAccess;
  if (!v || !fix) return null;
  fixing.value = true;
  try {
    let fresh: Volume | null;
    if (card.value?.volume.id === v.id) {
      await fixCardAccess();
      const s = card.value;
      fresh = s && s.info.writable !== false && !s.info.readOnly ? s.volume : null;
    } else {
      const now = await fix.call(plat().volumes, v);
      fresh = now.info.writable !== false && !now.info.readOnly ? now : null;
    }
    if (fresh) toast.success('Jetzt darf ich auf die Karte schreiben');
    return fresh;
  } catch (e) {
    // The password window was closed: nothing to report.
    if (errorCode(e) !== 'cancelled') toast.error('Schreibrechte holen hat nicht geklappt', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    fixing.value = false;
  }
}

/** Runs "Schreibrechte holen" for the open card. */
export async function runFix(): Promise<void> {
  await fixWriteAccess();
}

/**
 * The button in the toast of a write that failed for lack of rights, when
 * the app can fix that for the open card. Takes the error or its text.
 */
export function writeErrorAction(e: unknown): ToastAction | undefined {
  // Chrome, Edge: the browser took back the access. Its text asks for „Zugriff erlauben“; the button is here.
  if (isAccessLost(e)) {
    const ask = platform.value?.volumes.requestPermission;
    if (!ask) return undefined;
    return { label: 'Zugriff erlauben', run: () => void askAgain(ask.bind(platform.value!.volumes)) };
  }
  if (!isWriteDenied(e) || !fixTarget()) return undefined;
  return { label: FIX_LABEL, run: () => void runFix(), tidy: withoutBoxHint };
}

async function askAgain(ask: () => Promise<boolean>) {
  try {
    if (await ask()) toast.success('Zugriff erlaubt', 'Versuche es jetzt noch einmal.');
  } catch {
    // Asked again next time.
  }
}
