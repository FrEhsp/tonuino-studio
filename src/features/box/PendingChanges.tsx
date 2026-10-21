import { BookOpen, CircleCheck, Download, Package, PackageOpen } from 'lucide-preact';
import { cardChangedElsewhere, changesWouldBeLost, packageState, plan, snapshotOfCard } from '../../app/pending';
import { catalog } from '../../app/state';
import { Button } from '../../ui/components/controls';
import { ChangedElsewhereNotice } from './ChangedElsewhere';
import { openPackageDialog } from './PackageDialog';
import { changeLines, firstLines, fromText, waitingText } from './packageTexts';

/**
 * What waits for the card (Firefox, Safari): changes that still need a
 * Paket, or a downloaded Paket that still needs unpacking.
 */
export function PendingChanges() {
  const st = packageState.value;
  const p = plan.value;
  if (!snapshotOfCard.value || !p || st.kind === 'clean') return null;
  // A Paket from elsewhere changed the card: what waits here no longer fits it.
  if (cardChangedElsewhere.value) return <ChangedElsewhereNotice />;
  if (st.kind === 'pending') {
    return (
      <div class="health-banner package-banner pending" role="status">
        <div class="health-icon">
          <Package size={24} />
        </div>
        <div class="grow">
          <b>{waitingText(p.count)}</b>
          <div class="small soft">{firstLines(changeLines(p, catalog.value, false), 3, false).join(' · ')}</div>
        </div>
        <Button variant="primary" icon={Download} onClick={() => openPackageDialog('choose')}>
          Paket herunterladen
        </Button>
      </div>
    );
  }
  return (
    <div class="health-banner package-banner downloaded" role="status">
      <div class="health-icon">
        <PackageOpen size={24} />
      </div>
      <div class="grow">
        <b>Das Paket {fromText(st.at)} wartet aufs Entpacken</b>
        <div class="small soft">
          {st.restored ? (
            <>
              Es ist noch nicht auf der Karte: <span class="break">„{st.manifest.name}“</span>. Entpacke es und prüfe die Karte danach. Bis dahin kannst du hier nichts ändern.
            </>
          ) : (
            <>
              Entpacke es auf die Karte und prüfe sie danach.
              {changesWouldBeLost.value ? ' Neue Namen und Bilder kommen ins nächste Paket.' : ''}
            </>
          )}
        </div>
      </div>
      <div class="row wrap package-banner-actions">
        <Button icon={BookOpen} onClick={() => openPackageDialog('guide')}>
          So geht’s
        </Button>
        <Button variant="primary" icon={CircleCheck} onClick={() => openPackageDialog('check')}>
          Karte prüfen
        </Button>
      </div>
    </div>
  );
}
