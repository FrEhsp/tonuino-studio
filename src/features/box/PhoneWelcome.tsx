import { CardSim, ChevronDown, CircleHelp, ShieldCheck } from 'lucide-preact';
import { Button } from '../../ui/components/controls';
import { WelcomeBoxArt } from '../../ui/components/Art';
import { cardIntoDevice } from '../../app/device';
import { needsPermission, platform } from '../../app/state';
import { ExternalLink, FORUM_URL } from '../help/ExternalLink';
import { PicksTeaser } from '../sources/Picks';
import { RememberedBoxes } from './Remembered';

/**
 * Meine Box without a card on a phone (0.5 #74/#75, Frank 16.10. 18:28: „Wie
 * ergibt die Startseite hier Sinn“): a short title, the one button right
 * under it, the how-to folded away. What the four tiles of the wide welcome
 * offer is in the tab bar already. Only where the card is picked by hand.
 */
export function PhoneWelcome({ onPick }: { onPick: () => void }) {
  const p = platform.value!;
  const phone = !!p.mobile;
  return (
    <div class="page phone-welcome">
      <header class="page-header">
        <div class="titles">
          <h1>Stecke die SD-Karte ein</h1>
          <p>Die SD-Karte deiner Box kommt {cardIntoDevice()}. Einmal auswählen, dann erkenne ich sie wieder.</p>
        </div>
      </header>
      <div class="row wrap">
        <Button variant="primary" size="lg" icon={CardSim} onClick={onPick}>
          SD-Karte auswählen
        </Button>
        {needsPermission.value ? (
          <Button size="lg" icon={ShieldCheck} onClick={() => p.volumes.requestPermission?.()}>
            Zugriff erlauben
          </Button>
        ) : null}
      </div>
      <details class="trouble phone-welcome-how">
        <summary>
          <CircleHelp size={18} strokeWidth={2.2} aria-hidden="true" />
          Wie geht das?
          <ChevronDown class="trouble-chevron" size={18} strokeWidth={2.2} aria-hidden="true" />
        </summary>
        <div class="stack phone-welcome-steps">
          <p class="small">
            {phone
              ? 'Ein kleiner SD-Kartenleser mit USB-C-Stecker passt an die meisten Handys und Tablets. Über das USB-Kabel der Box geht es nicht, die Karte muss dafür aus der Box.'
              : 'Über das USB-Kabel der Box geht das nicht. Nimm die Karte aus der Box und stecke sie in den Kartenschlitz des Computers oder einen SD-Kartenleser.'}{' '}
            <a href="#/hilfe/sd-karte-herausnehmen">So kommst du an die Karte</a>
          </p>
          <p class="small">
            {phone
              ? 'Im Fenster des Handys tippst du im Menü links auf den SD-Kartenleser, dann auf „Diesen Ordner verwenden“ und „Zulassen“. Wähle die ganze Karte, nicht einen Ordner darauf.'
              : 'Wähle im Fenster das Laufwerk der Karte selbst aus, nicht einen Ordner darauf. Der Browser fragt dann, ob ich Dateien ändern darf.'}
          </p>
        </div>
      </details>
      <div class="phone-welcome-art">
        <WelcomeBoxArt />
      </div>
      <RememberedBoxes />
      <PicksTeaser />
      <p class="community-line small muted">
        Gemacht für alle, die TonUINO-Boxen bauen, unabhängig und kostenlos. Danke an Thorsten Voß und alle im <ExternalLink href={FORUM_URL}>TonUINO-Forum</ExternalLink>.
      </p>
    </div>
  );
}
