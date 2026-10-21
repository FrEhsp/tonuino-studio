/**
 * What the browser is about to ask when the app wants the box over USB,
 * shown until the user picked a box once, and only where the browser may
 * first ask about an add-on (Firefox, `mayAskForAddon`): that question
 * looks alarming, so it is named beforehand. Chrome and Edge show their
 * chooser right away and need no word about it.
 */
import { Callout } from '../../ui/components/controls';

const PICKED_KEY = 'tonuino-studio:serial-picked';

export const BLOCKED_TEXT =
  'Kam kein Auswahlfenster? Dann hat dein Browser den Zugriff für diese Seite vielleicht gesperrt. Klicke links in der Adressleiste auf das Schloss, entferne bei den Berechtigungen die Sperre und lade die Seite neu.';

/** Worded as a question: the flag behind it is a guess from capabilities (Firefox asks; another browser may not). */
export const ADDON_TEXT =
  'Fragt dein Browser vorher, ob er ein Add-on hinzufügen darf? So macht es Firefox beim ersten Mal. Das Add-on erzeugt der Browser selbst, die Warnung dabei zeigt er bei jeder Seite mit USB-Zugriff. Klicke auf „Installation fortsetzen“, „Hinzufügen“ und dann „Erlauben“.';

/** Whether a box was picked in this browser before. */
export function pickedBefore(): boolean {
  try {
    return localStorage.getItem(PICKED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the first successful pick: the hint is not needed after that. */
export function rememberPicked(): void {
  try {
    localStorage.setItem(PICKED_KEY, '1');
  } catch {
    // Private window or blocked storage: the hint just stays.
  }
}

export function SerialPromptHint() {
  return (
    <div class="stack tight small muted ws-serial-hint">
      <span>Dein Browser fragt gleich, welches Gerät ich benutzen darf. Wähle die Box aus.</span>
      <span>{ADDON_TEXT}</span>
    </div>
  );
}

export function BlockedSiteHint() {
  return <Callout tone="warning">{BLOCKED_TEXT}</Callout>;
}
