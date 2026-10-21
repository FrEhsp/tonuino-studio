/**
 * The firmware wizard's answer when the new firmware would drop extras of the
 * box (core/firmware/extrascheck.ts): take the extras over, or flash anyway
 * on purpose. And the line in the firmware step that says what the app found
 * on the box last time.
 */
import { ArrowLeft, CircleCheck, Upload, Wand } from 'lucide-preact';
import { choiceSummary } from '../../core/firmware/baukasten';
import { Button } from '../../ui/components/controls';
import { knownBuild, knownChoice, type KnownBuild } from './boxbuild';
import { chooseExtras, chooseShutdown, goTo, type WizardState } from './wizard';

/** The wizard with the extras of the build on the box, back at the firmware step. Undefined for another board or keys. */
export function takeOverExtras(s: WizardState, k: KnownBuild): WizardState | undefined {
  if (s.board !== k.board || s.variant !== k.buttons) return undefined;
  const { traeger, ...extras } = knownChoice(k);
  let next = chooseExtras(s, extras);
  if (traeger) next = chooseShutdown(next, 'traeger');
  return goTo(next, 'source');
}

export function ExtrasLostButtons({ wizard, setWizard, again, back }: { wizard: WizardState; setWizard: (s: WizardState) => void; again: () => void; back: () => void }) {
  const k = knownBuild.value;
  const taken = k?.from === 'read' ? takeOverExtras(wizard, k) : undefined;
  return (
    <>
      {taken ? (
        <Button variant="primary" icon={Wand} onClick={() => setWizard(taken)}>
          Extras übernehmen
        </Button>
      ) : (
        <Button variant="primary" icon={ArrowLeft} onClick={back}>
          Extras wählen
        </Button>
      )}
      <Button icon={Upload} onClick={again}>
        Trotzdem aufspielen
      </Button>
    </>
  );
}

/** "Auf deiner Box erkannt: …", when the app read this box's firmware before and it was a Baukasten build with extras. */
export function KnownExtrasNote({ board, variant }: { board: string; variant: string }) {
  const k = knownBuild.value;
  if (!k || k.board !== board || k.buttons !== variant) return null;
  const summary = choiceSummary(knownChoice(k));
  if (!summary) return null;
  return (
    <p class="small soft row tight">
      <CircleCheck size={14} aria-hidden="true" /> {k.from === 'read' ? 'Auf deiner Box automatisch erkannt' : 'Zuletzt aufgespielt'}: {summary}.
    </p>
  );
}
