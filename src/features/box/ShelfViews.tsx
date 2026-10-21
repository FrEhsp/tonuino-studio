import { Image } from 'lucide-preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ShelfItem } from '../../core/tonuino/catalog';
import { softHyphens } from '../../core/stickers/text';
import { coverUrlFor } from '../../app/state';
import { navigate } from '../../app/router';
import { usePageShown } from '../../app/pageAlive';
import { formatDuration, plural } from '../../app/format';
import { Segmented } from '../../ui/components/controls';
import { Cover } from '../../ui/components/Cover';
import { Liste, Plus, Stickerbogen } from '../../ui/icons';
import { ShelfSticker } from '../covers/ShelfSticker';
import { levelNote, levelOffsetOf } from './levelOffset';
import { setShelfView, shelfView, type ShelfView } from './shelfView';

/**
 * The shelf of "Meine Box" in its three views (shelfView.ts), the same with
 * the card in and for a box remembered on this device (Remembered.tsx): only
 * what a click on a folder does differs.
 */

type Open = (item: ShelfItem) => void;

/** How the shelf shows the folders: the words Frank expected, one click each. */
export function ShelfViewChoice() {
  return (
    <Segmented<ShelfView>
      label="Ansicht des Regals"
      value={shelfView.value}
      onChange={setShelfView}
      options={[
        { value: 'cover', label: 'Cover', icon: Image },
        { value: 'sticker', label: 'Sticker', icon: Stickerbogen },
        { value: 'liste', label: 'Liste', icon: Liste },
      ]}
    />
  );
}

/** The folders as the chosen view shows them; `addTile`: the empty "Hinzufügen" card at the end of the cards. */
export function FolderShelf({ items, onOpen, addTile = false }: { items: readonly ShelfItem[]; onOpen: Open; addTile?: boolean }) {
  const view = shelfView.value;
  const shelf = useRef<HTMLDivElement>(null);
  const shown = usePageShown();
  useLayoutEffect(() => (shown ? nearFirst(shelf.current) : undefined), [shown, view]);
  if (view === 'liste') {
    return (
      <div class="shelf-list card">
        {items.map((item) => (
          <Row item={item} onOpen={onOpen} key={item.number} />
        ))}
      </div>
    );
  }
  return (
    <div class={`shelf shelf-${view}`} ref={shelf}>
      {items.map((item) => (view === 'sticker' ? <Tile item={item} onOpen={onOpen} key={item.number} /> : <CoverTile item={item} onOpen={onOpen} key={item.number} />))}
      {addTile ? (
        <button class="tile add" onClick={() => navigate({ page: 'add' })}>
          <div class="tile-cover">
            <div class="stack" style={{ alignItems: 'center' }}>
              <Plus size={34} />
              <b>Hinzufügen</b>
            </div>
          </div>
        </button>
      ) : null}
      {/* The grain of the plywood, on a layer of its own (stil-holz.css); last, so the cards keep their turns (nth-child). */}
      <span class="shelf-grain" aria-hidden="true" />
    </div>
  );
}

/**
 * The part of the shelf in and near the window first: the cards further away
 * stay hidden (visibility, so nothing moves) and the plywood's grain covers
 * only that part, until the first frame is painted; the rest comes with the
 * next one. WebKitGTK painted the whole shelf before it showed it, also far
 * below the window: going back to "Meine Box" with 47 folders took a third
 * longer than in 0.4.1 (Linux app). Runs when the shelf shows, also again.
 */
function nearFirst(shelf: HTMLElement | null): (() => void) | undefined {
  if (!shelf || typeof requestAnimationFrame !== 'function') return undefined;
  const grain = shelf.querySelector<HTMLElement>(':scope > .shelf-grain');
  let later: Element[] = [];
  const show = () => {
    for (const tile of later) tile.removeAttribute('data-later');
    later = [];
    grain?.removeAttribute('style');
  };
  // In the frame about to be painted: by then the page has its place (App.tsx keeps each page's scroll position).
  let frame = requestAnimationFrame(() => {
    // What of the page scrolling the shelf is in the window.
    const main = shelf.closest('.main')?.getBoundingClientRect();
    const view = { top: Math.max(0, main?.top ?? 0), bottom: Math.min(window.innerHeight, main?.bottom ?? Infinity) };
    // A little more: a card cut off at the window's edge shows at once.
    const reach = Math.max(0, view.bottom - view.top) / 8;
    for (const tile of shelf.children) {
      if (tile === grain) continue;
      const r = tile.getBoundingClientRect();
      if (r.bottom < view.top - reach || r.top > view.bottom + reach) later.push(tile);
    }
    const box = shelf.getBoundingClientRect();
    // Whole pixels, so the grain lies exactly where it lies on the whole shelf.
    const above = Math.max(0, Math.floor(view.top - reach - box.top));
    const below = Math.max(0, Math.floor(box.bottom - view.bottom - reach));
    if (!later.length && !above && !below) return;
    // An attribute, not a class: a class change draws the pen frames inside again (drawnFrames.ts).
    for (const tile of later) tile.setAttribute('data-later', '');
    if (grain && (above || below)) {
      // As in stil-holz.css (inset -1px over the border, the pattern from inside it), cut to the part in sight.
      grain.style.top = `${above - 1}px`;
      grain.style.bottom = `${below - 1}px`;
      grain.style.backgroundPosition = `1px ${1 - above}px`;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      show();
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    show();
  };
}

/**
 * A folder's facts in one line: episodes or titles, its length, and
 * "leiser gestellt" when it was made quieter or louder on purpose (`level`);
 * without them its artist, unless `artist` is false.
 */
function folderFacts(item: ShelfItem, artist = true, level = true): string {
  // A packed series says how many episodes it holds; each one has its own card "von … bis …", the length stays on the folder page.
  const episodes = new Set(item.entry?.tracks.map((t) => t.episode).filter(Boolean)).size;
  const meta = [
    episodes > 1 ? plural(episodes, 'Folge', 'Folgen') : null,
    item.trackCount ? plural(item.trackCount, 'Titel', 'Titel') : null,
    // The length in one piece: a narrow card breaks before "1 Std. 13 Min.", not before "Min.".
    item.durationSec && episodes < 2 ? formatDuration(item.durationSec).replace(/ /g, ' ') : null,
    level ? levelNote(levelOffsetOf(item.entry)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return item.state === 'missing' ? 'nicht auf der Karte' : meta || (artist ? item.entry?.artist : '') || '';
}

function FolderFlag({ item }: { item: ShelfItem }) {
  if (item.state === 'missing') return <span class="tile-flag badge danger">Fehlt</span>;
  if (item.state !== 'changed') return null;
  return (
    <span class="tile-flag badge warning" title="Die Dateien wurden außerhalb der App geändert. Öffne den Ordner, prüfe die Titel und übernimm den neuen Stand.">
      Geändert
    </span>
  );
}

/** A short last word stays with the one before it: "Unter meinem Bett 7" never leaves the 7 alone on a line. */
const keepTail = (title: string) => title.replace(/ (\S{1,3})$/, ' $1');

/**
 * A folder on the shelf as its sticker ("Sticker"): its real sticker, drawn
 * by the sticker printer with the design of "Sticker drucken", on a card;
 * under the sticker, on the card's paper, its number, name and facts
 * (draft B: no text on the wood).
 */
function Tile({ item, onOpen }: { item: ShelfItem; onOpen: Open }) {
  return (
    <button class="tile" onClick={() => onOpen(item)} title={item.title}>
      {/* Each folder's card gets a frame of its own (src/ui/drawnFrames.ts). */}
      <div class="tile-cover sticker" data-frame-seed={item.number}>
        <ShelfSticker folder={item.number} title={item.title} />
        <span class="tile-foot">
          <span class="tile-num">{item.name}</span>
          {/* Soft hyphens: on a narrow card a long word breaks at a syllable instead of ending in "…". */}
          <span class="tile-title">{softHyphens(keepTail(item.title))}</span>
          {/* The card's paper has room for one line: the note stays in the list, the tooltip and the folder page. */}
          <span class="tile-meta">{folderFacts(item, true, false)}</span>
        </span>
        <FolderFlag item={item} />
      </div>
    </button>
  );
}

/**
 * A folder on the shelf as its cover ("Cover", the default): a white card
 * with the square cover, the number and the name under it (Frank 17.10.:
 * "Ich fand die Karten charmant"), small enough for many in a row. The
 * facts wait in the tooltip, the list and the folder page: a third line
 * made every row a sixth taller.
 */
function CoverTile({ item, onOpen }: { item: ShelfItem; onOpen: Open }) {
  const facts = folderFacts(item, false);
  return (
    <button class="tile" onClick={() => onOpen(item)} title={facts ? `${item.title} · ${facts}` : item.title}>
      <div class="tile-cover" data-frame-seed={item.number}>
        <Cover url={coverUrlFor(item.number)} title={item.title} seed={item.number} number={item.name} color={item.entry?.color} />
        <span class="tile-num">{item.name}</span>
        {/* On the card's paper, as written on a photo: no text on the wood (rule 14). */}
        <span class="tile-title">{softHyphens(keepTail(item.title))}</span>
        <FolderFlag item={item} />
      </div>
    </button>
  );
}

/** A folder as a line of the list ("Liste"): small cover, number, name, artist, facts. */
function Row({ item, onOpen }: { item: ShelfItem; onOpen: Open }) {
  return (
    <button class="shelf-row" onClick={() => onOpen(item)} title={item.title}>
      <span class="shelf-row-cover">
        <Cover url={coverUrlFor(item.number)} title={item.title} seed={item.number} small color={item.entry?.color} />
      </span>
      <span class="shelf-row-num">{item.name}</span>
      <span class="shelf-row-text">
        <span class="shelf-row-title">{item.title}</span>
        <span class="shelf-row-meta">{[item.entry?.artist, folderFacts(item, false)].filter(Boolean).join(' · ')}</span>
      </span>
      <FolderFlag item={item} />
    </button>
  );
}
