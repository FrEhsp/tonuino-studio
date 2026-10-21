/**
 * On the add page: several albums of one series, or albums with no folder
 * left for them (Frank 16.10.2026, "Reihe in einen Ordner packen"). One
 * sentence and one button: the albums go as episodes into one folder (the
 * path of the extra "Mehr als 99 Hörspiele", also with it off), and the
 * same line takes it back. With nothing to put them into, the button packs
 * a series on the card first and the albums get the numbers that became free.
 */
import { useMemo, useState } from 'preact/hooks';
import { Library, Undo2 } from 'lucide-preact';
import { buildShelf } from '../../core/tonuino/catalog';
import { findSeries } from '../../core/tonuino/series';
import { folderName } from '../../core/tonuino/sd';
import { card, settings } from '../../app/state';
import { plural } from '../../app/format';
import { Button, Callout } from '../../ui/components/controls';
import { PackDialog } from '../box/PackSeries';
import { packAlbums, packOffer, refillTargets, session, unpackAlbums } from './session';

export function PackOfferLine() {
  const s = card.value;
  const sess = session.value;
  const [packing, setPacking] = useState(false);
  const offer = s?.scan ? packOffer(sess, s.scan, s.catalog) : null;
  const shelf = useMemo(() => (s?.scan && packing ? buildShelf(s.scan, s.catalog ?? null) : []), [s?.scan, s?.catalog, packing]);
  // Apart from the line: after packing the offer changes or goes, the dialog stays to show how it went.
  const dialog = packing ? (
    <PackDialog
      shelf={shelf}
      found={findSeries(shelf.filter((i) => i.folder).map((i) => ({ number: i.number, title: i.title, series: i.entry?.series })))}
      onClose={() => setPacking(false)}
      onPacked={refillTargets}
    />
  ) : null;
  if (!offer || !s?.scan) return dialog;
  // The extra's own box says this already, with its own button to take it back.
  if (offer.kind === 'packed' && settings.value.episodePlanner) return dialog;
  const n = offer.kind === 'pack' ? offer.albums : offer.albums.length;
  const albums = n === 1 ? 'das Album' : `die ${n} Alben`;

  return (
    <>
      <Callout tone="info" icon={Library}>
        <div class="pack-line pack-offer">
          <span>
            {offer.kind === 'gather'
              ? offer.existing
                ? `„${offer.series}“ hat schon Ordner ${folderName(offer.target)}. Ich kann ${albums} dort als ${n === 1 ? 'Folge' : 'Folgen'} hinten anhängen, dann ${n === 1 ? 'braucht es' : 'brauchen sie'} keine eigene Nummer.`
                : `Die ${n} Alben gehören zu „${offer.series}“. Ich kann sie als Folgen in einen Ordner legen, dann brauchen sie nur eine Nummer.`
              : offer.kind === 'packed'
                ? `${n === 1 ? 'Das Album kommt als Folge' : `Die ${n} Alben kommen als Folgen`} in Ordner ${folderName(offer.target)} „${offer.series}“. Jede Folge bekommt danach ihre eigene Karte.`
                : `Für ${plural(n, 'Album', 'Alben')} ist kein Ordner mehr frei. Packe eine Reihe auf der Karte in einen Ordner, dann werden Nummern frei.`}
          </span>
          {offer.kind === 'gather' ? (
            <Button size="sm" icon={Library} onClick={() => packAlbums(offer)}>
              {offer.existing ? 'Dort anhängen' : 'In einen Ordner legen'}
            </Button>
          ) : offer.kind === 'packed' ? (
            <Button size="sm" variant="ghost" icon={Undo2} onClick={() => unpackAlbums(offer.target)}>
              Doch eigene Ordner
            </Button>
          ) : (
            <Button size="sm" icon={Library} onClick={() => setPacking(true)}>
              Reihe packen …
            </Button>
          )}
        </div>
      </Callout>
      {dialog}
    </>
  );
}
