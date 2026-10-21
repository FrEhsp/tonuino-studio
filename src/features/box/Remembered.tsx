import { useEffect, useMemo, useState } from 'preact/hooks';
import { BookmarkCheck, BookmarkPlus, CardSim, Nfc, Printer, Search, Trash2, X } from 'lucide-preact';
import { buildShelf, trackRows, type ShelfItem } from '../../core/tonuino/catalog';
import { isStale, rememberedDate } from '../../core/tonuino/remember';
import { folderName } from '../../core/tonuino/sd';
import { Button, Callout } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast, toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { formatBytes, formatDuration, plural } from '../../app/format';
import { usePageShown } from '../../app/pageAlive';
import { openVolume, plat, platform, settings, shownMemory } from '../../app/state';
import { answerOffer, closeMemory, forgetMemory, loadMemories, markOffered, memories, offerRemember, showMemory } from '../../app/remembered';
import { useCardDrop } from '../../ui/useCardDrop';
import { CardReader } from './CardReader';
import { FolderShelf, ShelfViewChoice } from './ShelfViews';
import { formatOffset, levelNote, levelOffsetOf } from './levelOffset';

/**
 * „Box merken“ on the pages (the logic is in src/app/remembered.ts): the
 * quiet question on the shelf, the remembered boxes on a page without a
 * card, and the remembered box itself, read only.
 */

/** The question on "Meine Box" once a box opened: asked once, answered with a click. */
export function RememberOffer() {
  const [busy, setBusy] = useState(false);
  const shown = offerRemember.value || busy;
  useEffect(() => {
    if (shown) markOffered();
  }, [shown]);
  if (!shown) return null;
  const yes = async () => {
    setBusy(true);
    try {
      if (await answerOffer(true)) toast.success('Box gemerkt', 'Ohne SD-Karte findest du sie unter „Meine Box“. Ausschalten kannst du das in den Einstellungen.');
    } catch (e) {
      toastError('Merken hat nicht geklappt', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="shelf-note remember-offer">
      <BookmarkPlus size={16} aria-hidden="true" />
      <span>
        {/* The same words as the setting „Boxen auf diesem Gerät merken“ (audit 0.4 #23). */}
        Box auf diesem Gerät merken? Dann siehst du Nummern, Namen und Cover auch ohne <span class="nowrap">SD-Karte</span>.
      </span>
      {/* Answers are buttons, as every action of the page (0.4.1); quiet ones, the page's lila button is "Hinzufügen". */}
      <span class="remember-answers">
        <Button size="sm" disabled={busy} onClick={() => void yes()}>
          Ja
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void answerOffer(false)}>
          Nein
        </Button>
      </span>
    </div>
  );
}

const open = (id: string) => showMemory(id).catch((e) => toastError('Die gemerkte Box ließ sich nicht öffnen', e));

/**
 * The boxes this device remembers, on a page without a card. Read when the
 * page shows (never at the start with a card in). `compact`: one line with
 * a button per box, inside the hints of "Karten beschreiben" and "Sticker drucken".
 */
export function RememberedBoxes({ compact = false }: { compact?: boolean }) {
  useEffect(() => void loadMemories(), []);
  const list = memories.value;
  if (!list?.length) return null;
  if (compact) {
    return (
      <div class="remembered-pick row wrap">
        <span class="small soft">Ohne SD-Karte geht es mit dem gemerkten Stand:</span>
        {list.map((m) => (
          <Button size="sm" icon={BookmarkCheck} key={m.id} onClick={() => void open(m.id)}>
            {m.name} <span class="muted">({rememberedDate(m.at)})</span>
          </Button>
        ))}
      </div>
    );
  }
  return (
    <section class="card pad stack remembered-boxes" aria-labelledby="remembered-boxes">
      <div class="stack tight">
        <h2 id="remembered-boxes" class="row">
          <BookmarkCheck size={20} aria-hidden="true" /> Ohne SD-Karte ansehen
        </h2>
        <p class="small soft">Diese App hat sich deine Box gemerkt. Du siehst Nummern, Namen und Cover, beschreibst Karten und druckst Sticker. Ändern geht erst wieder mit der SD-Karte.</p>
      </div>
      <ul class="remembered-list">
        {list.map((m) => (
          <li key={m.id}>
            <span class="stack tight grow">
              <b class="user-name">{m.name}</b>
              <span class="small muted">
                {plural(m.folders, 'Ordner', 'Ordner')} · gemerkt am {rememberedDate(m.at)}
              </span>
            </span>
            <Button icon={BookmarkCheck} onClick={() => void open(m.id)}>
              Ansehen
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How to get the card itself in, as the page without a card says it. Firefox, Safari: the note takes a dropped card too. */
function CardIn() {
  const caps = platform.value?.capabilities;
  const drop = useCardDrop('card');
  if (!caps || (!caps.sd && !caps.sdPackage)) return null;
  if (caps.sd && caps.sdAutoDetect) return <span>Stecke die SD-Karte ein, ich finde sie von selbst.</span>;
  if (!caps.sd) {
    return (
      <div class={`card-drop ${drop.over ? 'over' : ''}`} {...drop.handlers}>
        <CardReader purpose="card" over={drop.over} size="md" />
      </div>
    );
  }
  const pick = async () => {
    try {
      const v = await plat().volumes.pick();
      if (v) await openVolume(v);
    } catch (e) {
      toastError('Die Karte ließ sich nicht öffnen', e);
    }
  };
  return (
    <div>
      <Button icon={CardSim} onClick={pick}>
        SD-Karte auswählen
      </Button>
    </div>
  );
}

/** "Meine Box" with the remembered box: its shelf as last seen, nothing to change. */
export function RememberedShelf() {
  const view = shownMemory.value!;
  const [query, setQuery] = useState('');
  const [tracksOf, setTracksOf] = useState<ShelfItem | null>(null);
  const shelf = useMemo(() => buildShelf(view.scan, view.catalog), [view]);
  const filtered = query ? shelf.filter((i) => `${i.name} ${i.title} ${i.entry?.artist ?? ''}`.toLowerCase().includes(query.toLowerCase())) : shelf;
  const playable = shelf.filter((i) => i.state !== 'missing' && i.trackCount);
  const total = playable.every((i) => i.durationSec !== undefined) ? playable.reduce((sum, i) => sum + (i.durationSec ?? 0), 0) : undefined;
  const day = rememberedDate(view.memory.at);
  return (
    <div class="page box-page remembered">
      <div class="box-bench">
        <header class="page-header">
          <div class="titles">
            <div class="row">
              <h1 class="user-name">{view.catalog.name}</h1>
              <span class="badge accent">Gemerkt</span>
            </div>
            <p>
              {plural(shelf.length, 'Ordner', 'Ordner')}
              {total ? ` · ${formatDuration(total)}` : ''} · gemerkt am {day}
            </p>
          </div>
          <Button icon={Printer} onClick={() => navigate({ page: 'stickers' })}>
            Sticker drucken
          </Button>
          <Button icon={Nfc} onClick={() => navigate({ page: 'cards' })}>
            Karten beschreiben
          </Button>
          <Button variant="ghost" icon={X} onClick={closeMemory}>
            Schließen
          </Button>
        </header>

        <Callout tone="info" icon={BookmarkCheck}>
          <div class="stack tight">
            <span>
              <b>Das ist der Stand vom {day}, nicht die Karte selbst.</b> Karten beschreiben und Sticker drucken geht damit. Hinzufügen, Umbenennen und Cover ändern geht erst, wenn die <span class="nowrap">SD-Karte</span> im Computer steckt.
            </span>
            {isStale(view.memory.at, Date.now()) ? <span>Das ist über einen Monat her. Was seitdem auf die Karte kam, fehlt hier.</span> : null}
            <CardIn />
          </div>
        </Callout>

        {/* Search and the same three views as with the card (ShelfViews.tsx). */}
        {shelf.length ? (
          <div class="box-bar">
            <div class="shelf-tools">
              {shelf.length > 8 ? (
                <div class="input-group">
                  <Search size={17} />
                  <input class="input" type="search" placeholder="Suchen …" aria-label="Ordner suchen" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
                </div>
              ) : null}
              <ShelfViewChoice />
            </div>
          </div>
        ) : null}

        {!shelf.length ? (
          <p class="soft">Auf der Karte waren noch keine Ordner.</p>
        ) : query && !filtered.length ? (
          <p class="soft">
            Kein Ordner passt zu „{query}“.{' '}
            <button type="button" class="link-button" onClick={() => setQuery('')}>
              Suche löschen
            </button>
          </p>
        ) : (
          <section class="box-piece" aria-label="Regal">
            <FolderShelf items={filtered} onOpen={setTracksOf} />
          </section>
        )}
      </div>
      {tracksOf ? <RememberedTracks item={tracksOf} onClose={() => setTracksOf(null)} /> : null}
    </div>
  );
}

/** A folder of the remembered box: its titles, to read. */
function RememberedTracks({ item, onClose }: { item: ShelfItem; onClose: () => void }) {
  const rows = item.folder ? trackRows(item.folder, item.entry) : [];
  return (
    <Dialog
      title={`${folderName(item.number)} · ${item.title}`}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Schließen
        </Button>
      }
    >
      <div class="stack">
        {item.entry?.artist ? <p class="soft">{item.entry.artist}</p> : null}
        {levelNote(levelOffsetOf(item.entry)) ? <p class="small soft">Lautstärke: {levelNote(levelOffsetOf(item.entry))} ({formatOffset(levelOffsetOf(item.entry))}).</p> : null}
        {rows.length ? (
          <div class="list remembered-tracks">
            {rows.map((r) => (
              <div class="list-row" key={r.file}>
                <span class="pick-num">{String(r.number).padStart(3, '0')}</span>
                <span class="grow">{r.title}</span>
                {r.durationSec ? <span class="small muted">{formatDuration(r.durationSec)}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <p class="soft">In diesem Ordner waren keine Titel.</p>
        )}
        <p class="small muted">Gemerkter Stand. Anhören und Ändern geht, wenn die SD-Karte steckt.</p>
      </div>
    </Dialog>
  );
}

/** On "Karten beschreiben" and "Sticker drucken" while the remembered box stands in for the card. */
export function RememberedNote({ page }: { page: 'cards' | 'stickers' }) {
  const view = shownMemory.value;
  if (!view) return null;
  const what = page === 'cards' ? 'Karten beschreiben geht damit wie mit der Karte.' : 'Sticker drucken, anpassen und Cover suchen geht damit wie mit der Karte.';
  const change = page === 'cards' ? 'Wie ein Ordner spielt, änderst du, wenn die SD-Karte steckt.' : 'Was du änderst, kommt auf die SD-Karte, sobald sie wieder steckt.';
  return (
    <Callout tone="neutral" icon={BookmarkCheck}>
      <div class="row wrap remembered-note">
        <span class="grow">
          <b>Gemerkter Stand von „{view.catalog.name}“ vom {rememberedDate(view.memory.at)}.</b> {what} {change}
        </span>
        <Button size="sm" variant="ghost" icon={X} onClick={closeMemory}>
          Schließen
        </Button>
      </div>
    </Callout>
  );
}

/** Under the switch in the settings: the boxes remembered on this device, each to forget. Read only when the page shows. */
export function RememberedInSettings() {
  const shown = usePageShown();
  useEffect(() => {
    if (shown) void loadMemories();
  }, [shown]);
  const list = memories.value;
  if (!list?.length) return null;
  const forget = async (id: string, name: string) => {
    try {
      await forgetMemory(id);
      const again = settings.value.rememberBoxes ? ' Solange „Boxen auf diesem Gerät merken“ an ist, merke ich sie mir beim nächsten Öffnen wieder.' : '';
      toast.success('Box vergessen', `„${name}“ ist von diesem Gerät gelöscht. Die SD-Karte bleibt, wie sie ist.${again}`);
    } catch (e) {
      toastError('Vergessen hat nicht geklappt', e);
    }
  };
  return (
    <ul class="remembered-list remembered-settings" aria-label="Gemerkte Boxen">
      {list.map((m) => (
        <li key={m.id}>
          <span class="stack tight grow">
            <b class="user-name">{m.name}</b>
            <span class="small muted">
              {plural(m.folders, 'Ordner', 'Ordner')} · gemerkt am {rememberedDate(m.at)} · {formatBytes(m.bytes)}
            </span>
          </span>
          <Button size="sm" icon={Trash2} onClick={() => void forget(m.id, m.name)}>
            Gemerkte Box vergessen
          </Button>
        </li>
      ))}
    </ul>
  );
}
