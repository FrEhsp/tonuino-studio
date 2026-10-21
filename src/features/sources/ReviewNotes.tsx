/** What the review step of "Hinzufügen" says about albums from "Entdecken". */
import './sources.css';
import type { TrackOrigin } from '../../core/sources/origin';
import { Callout } from '../../ui/components/controls';
import { originLine, unchangedNote } from './labels';

function originsOf(tracks: readonly { origin?: TrackOrigin }[]): TrackOrigin[] {
  return tracks.flatMap((t) => (t.origin ? [t.origin] : []));
}

/** "Aus Entdecken: {publisher} · {licence}" under the album title. */
export function FromSourcesLine({ tracks }: { tracks: readonly { origin?: TrackOrigin }[] }) {
  const line = originLine(originsOf(tracks));
  return line ? <span class="small muted from-sources">{line}</span> : null;
}

/** Why loudness and length stay as they are. */
export function UnchangedNote({ tracks }: { tracks: readonly { origin?: TrackOrigin }[] }) {
  const text = unchangedNote(originsOf(tracks));
  return text ? <Callout tone="neutral">{text}</Callout> : null;
}
