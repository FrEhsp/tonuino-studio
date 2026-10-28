/**
 * "Was in diesem Browser geht" in the settings of the web app (TODO #122):
 * what works here and, for the rest, what to take instead
 * (src/platform/web/abilities.ts). Plus "Als App installieren" where the
 * browser offers it (src/app/pwa.ts).
 */
import { platform } from '../../app/state';
import { install, installOffer, runsInstalled } from '../../app/pwa';
import { abilitiesOf, abilityLines } from '../../platform/web/abilities';
import { Button } from '../../ui/components/controls';
import { AndroidAppLink, DesktopAppLink } from '../help/DesktopAppLink';

export function WebAbilities() {
  const p = platform.value;
  if (!p || p.kind !== 'web') return null;
  const a = abilitiesOf(p);
  const offer = installOffer.value;
  return (
    <section class="card pad stack tight web-abilities" aria-labelledby="web-abilities-h">
      <h2 id="web-abilities-h">Was in diesem Browser geht</h2>
      <ul class="web-abilities-list">
        {abilityLines(a).map((l) => (
          <li key={l.what}>
            <b>{l.what}:</b> {l.here ? 'geht hier.' : 'nicht hier.'} {l.note ?? ''}
          </li>
        ))}
      </ul>
      <p class="small">
        {a.device === 'android' ? <AndroidAppLink /> : a.device === 'computer' ? <DesktopAppLink /> : null}{' '}
        <a href="#/hilfe/browser">Web-App oder Desktop-App?</a>
      </p>
      {runsInstalled() ? (
        <p class="small muted">Du nutzt TonUINO Studio als installierte App. Neue Versionen kommen von selbst.</p>
      ) : offer ? (
        <div class="row wrap">
          <Button onClick={() => void install()}>Als App installieren</Button>
          <span class="small muted">Dann startet TonUINO Studio in einem eigenen Fenster, auch ohne Internet.</span>
        </div>
      ) : null}
    </section>
  );
}
