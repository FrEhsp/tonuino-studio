import { useEffect, useState } from 'preact/hooks';
import { card, catalog, setCover, updateCatalog } from '../../app/state';
import { AS_STICKER } from '../../core/covers/shelf';
import { folderName } from '../../core/tonuino/sd';
import { Button, Field } from '../../ui/components/controls';
import { toast, toastError } from '../../ui/components/Toast';
import { cardInfos, foundCoverBytes, shelfLook, shelfSource } from './shelfCards';

/**
 * The shelf on the folder page: with the shelf showing covers, whether this
 * folder shows its cover or its printed sticker; and a cover the app found
 * by itself, to take onto the SD card. The app ships no cover recipes
 * (SHIPPED_RECIPES in src/core/covers/shelf.ts): a recipe chosen with an
 * older app counts as the cover. A section that only explained the shelf, with nothing to click, is
 * gone (audit 0.4 #4): the switch over the shelf says it all.
 */
export function ShelfCardSection({ folder, title }: { folder: number; title: string }) {
  const name = folderName(folder);
  const entry = catalog.value?.folders[name];
  const src = shelfSource(folder, title);
  const choice = src.choice;
  const info = src.card ? cardInfos.value.get(src.card.key) : undefined;
  const [taking, setTaking] = useState(false);

  // Built (or fetched from this computer) while the page is open, so the check's verdict shows.
  const c = src.card;
  useEffect(() => {
    if (!c || info) return undefined;
    const r = c.request();
    r.near(true);
    return () => r.release();
  }, [c?.key]);

  const choose = (value: string) =>
    updateCatalog((cat) => {
      const e = cat.folders[name];
      if (!e) return;
      const sticker = { ...e.sticker, recipe: value || undefined };
      e.sticker = Object.values(sticker).some((v) => v !== undefined) ? sticker : undefined;
      e.updatedAt = Date.now();
    }).catch((e) => toastError('Speichern hat nicht geklappt', e));

  const take = async () => {
    const f = src.found;
    if (!f) return;
    setTaking(true);
    try {
      await setCover(folder, await foundCoverBytes(f), f.blob.type || 'image/jpeg', f.source);
      toast.success('Cover gespeichert');
    } catch (e) {
      toastError('Das Cover konnte nicht gespeichert werden', e);
    } finally {
      setTaking(false);
    }
  };

  if (!entry || !choice || !card.value) return null;
  const covers = shelfLook.value === 'karte';
  // Following the printing, every card looks the same way: nothing to pick, nothing to say.
  if (!covers && !src.found) return null;
  const chosen = entry.sticker?.recipe === AS_STICKER ? AS_STICKER : '';
  const found = src.found ? (
    <span class="row wrap" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
      <span>
        Cover automatisch gefunden ({src.found.source}): „{src.found.title}“{src.found.artist ? ` von ${src.found.artist}` : ''}. Bisher nur auf diesem Computer.
      </span>
      <Button size="sm" loading={taking} onClick={() => void take()}>
        Übernehmen
      </Button>
    </span>
  ) : null;
  if (!covers) return <div class="shelf-card-section small soft">{found}</div>;
  return (
    <div class="shelf-card-section">
      <Field
        label="Im Regal"
        id="karte-im-regal"
        hint={
          <>
            {choice.kind === 'karte' && !src.card ? 'Ohne Cover zeigt das Regal den Sticker.' : ''}
            {info?.simplified.length ? (
              <>
                {' '}
                <b>Automatisch vereinfacht:</b> {info.simplified[0]} Darum steht das Cover ganz da, daneben eine Fläche in seiner Farbe.
              </>
            ) : null}
            {found}
          </>
        }
      >
        {/* The same two words as the switch over the shelf (ShelfFormatChoice). */}
        <select id="karte-im-regal" class="select" value={chosen} onChange={(e) => void choose(e.currentTarget.value)}>
          <option value="">Cover</option>
          <option value={AS_STICKER}>Sticker</option>
        </select>
      </Field>
    </div>
  );
}
