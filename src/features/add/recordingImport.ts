/**
 * A finished recording ("Selbst aufnehmen") goes into the import like a
 * file picked on the computer: read, shown in the review, converted to MP3
 * at the album's loudness and written to the folder (session.ts). From a
 * folder's page it goes to that folder; from "Hinzufügen" the review asks.
 */
import { fileSource } from '../../core/audio/source';
import { navigate } from '../../app/router';
import { addSources, markRecording, resetImport, session, type ImportSession } from './session';

/** Why a recording cannot join the import for `folder` now, in words; null when it can. */
export function recordingBlocked(s: Pick<ImportSession, 'phase' | 'forFolder' | 'albums' | 'result'>, folder: number | undefined): string | null {
  if (s.phase === 'writing') return 'Gerade kommen Titel auf die Karte. Warte, bis das fertig ist, dann übernimm die Aufnahme.';
  if (s.phase === 'done' && s.result?.rest.length) return 'Unter „Hinzufügen“ wartet noch, was beim letzten Übertragen nicht auf die Karte kam. Übertrage es oder verwirf es, dann übernimm die Aufnahme.';
  if ((s.phase === 'review' || s.phase === 'reading') && s.albums.length && s.forFolder !== folder) {
    return 'Unter „Hinzufügen“ wartet noch eine andere Auswahl. Übertrage sie oder verwirf sie, dann übernimm die Aufnahme.';
  }
  return null;
}

/** Whether the import starts afresh for the recording (nothing else waits in it). */
export function startsAfresh(s: Pick<ImportSession, 'phase' | 'forFolder' | 'albums'>, folder: number | undefined): boolean {
  return s.phase === 'pick' || s.phase === 'done' || s.forFolder !== folder || !s.albums.length;
}

/** Hands the recording to the import and opens its page. Throws the reason when it cannot. */
export async function takeRecording(wav: Blob, fileName: string, folder: number | undefined): Promise<void> {
  const s = session.value;
  const blocked = recordingBlocked(s, folder);
  if (blocked) throw new Error(blocked);
  const afresh = startsAfresh(s, folder) && s.phase !== 'reading';
  if (afresh) resetImport(folder);
  const done = addSources([fileSource(wav, fileName)]);
  // Alone in the import, the review asks only where the recording goes; added to a selection, it is one more file.
  if (afresh) markRecording();
  navigate({ page: 'add', folder });
  await done;
}
