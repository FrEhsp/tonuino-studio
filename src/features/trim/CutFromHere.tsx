/**
 * „Ab hier abschneiden“ (TODO 0.3 #131) under the player of a title that
 * plays: opens the trim editor with its end grip where the title is now.
 */
import { Scissors } from 'lucide-preact';
import type { MediaLike } from '../../ui/nativeAudio';

export function CutFromHere({ audio, title, onCut }: { audio: MediaLike; title: string; onCut: (sec: number) => void }) {
  return (
    <button type="button" class="link-button ab-hier" aria-label={`„${title}“ ab hier abschneiden`} onClick={() => onCut(audio.currentTime)}>
      <Scissors size={15} strokeWidth={2.2} aria-hidden="true" />
      Ab hier abschneiden
    </button>
  );
}
