/**
 * The rows of "Entdecken" while browsing (TODO #119, rows.ts): per show a
 * row of covers with short titles and nothing else, no boxes, no badges. The
 * age is chosen above, the words of the source are on its page, one click
 * away. A show whose stories share one picture shows it once, with its
 * titles as a list beside it. The pictures have no words of their own (alt ""): the title stands right under them.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight } from 'lucide-preact';
import type { Story } from '../../core/sources/filter';
import type { IndexEntry, IndexItem } from '../../core/sources/types';
import { routeToHash } from '../../app/router';
import { IconButton } from '../../ui/components/controls';
import { countLabel, creatorsLine, titleWithoutReader } from './labels';
import { SourceCover } from './parts';
import { coverOf, SHELF_MAX, shortTitle, storyMeta, type Shelf } from './rows';
import { focusItem } from './state';

export function Shelves({ shelves }: { shelves: Shelf[] }) {
  return (
    <div class="sources-rows">
      {shelves.map((s) => (s.kind === 'sources' ? <SourcesRow key={s.key} shelf={s} /> : s.kind === 'list' ? <ListRow key={s.key} entry={s.entry} stories={s.stories} /> : <CoverRow key={s.key} entry={s.entry} stories={s.stories} />))}
    </div>
  );
}

/** The name of a story as a row shows it: without the reader (named on the page) and without the show's name. */
function storyName(entry: IndexEntry, story: Story): string {
  const item = story.items[0];
  const name = story.items.length > 1 ? story.title : item.title;
  const plain = creatorsLine(item.creators, item.tradition) ? titleWithoutReader(name, item.creators) : name;
  return shortTitle(plain, entry.title);
}

/** Opens the show's page at this story, with all its parts marked. */
function openAt(entry: IndexEntry, story: Story): () => void {
  return () => (focusItem.value = { entry: entry.id, key: story.items[0].key, keys: story.items.map((it: IndexItem) => it.key), ...(story.items.length > 1 ? { story: story.title } : {}) });
}

function RowHead({ id, title, href, more }: { id: string; title: string; href?: string; more?: string }) {
  return (
    <div class="sources-row-head">
      <h2 id={id}>{title}</h2>
      {href && more ? (
        <a class="sources-row-all" href={href}>
          {more}
        </a>
      ) : null}
    </div>
  );
}

/** A show whose stories have their own pictures: the covers side by side, the row scrolls sideways. */
function CoverRow({ entry, stories }: { entry: IndexEntry; stories: Story[] }) {
  const href = routeToHash({ page: 'sources', entry: entry.id });
  const id = `row-${entry.id}`;
  return (
    <section class="sources-row" aria-labelledby={id}>
      <RowHead id={id} title={entry.title} href={href} more={`Alle ${countLabel(entry, entry.items)}`} />
      <Scroller label={entry.title}>
        {stories.slice(0, SHELF_MAX).map((st) => (
          <li key={st.items[0].key}>
            <a class="sources-tile" href={href} onClick={openAt(entry, st)}>
              <SourceCover entry={entry} cover={coverOf(entry, st.items[0])} size="tile" lazy />
              <span class="sources-tile-title">{storyName(entry, st)}</span>
              <span class="sources-tile-meta">{storyMeta(st)}</span>
            </a>
          </li>
        ))}
      </Scroller>
    </section>
  );
}

/** A show whose stories share one picture: the picture once, the stories as a list beside it. */
function ListRow({ entry, stories }: { entry: IndexEntry; stories: Story[] }) {
  const href = routeToHash({ page: 'sources', entry: entry.id });
  const id = `row-${entry.id}`;
  const cover = entry.cover ?? coverOf(entry, stories[0].items[0]);
  const shown = stories.slice(0, SHELF_MAX);
  return (
    <section class="sources-row is-list" aria-labelledby={id}>
      <RowHead id={id} title={entry.title} href={href} more={`Alle ${countLabel(entry, entry.items)}`} />
      <div class="sources-row-list">
        {/* The title links below open the show too; the picture is one more way for the mouse, not for the keyboard. */}
        <a class="sources-row-cover" href={href} tabIndex={-1} aria-hidden="true">
          <SourceCover entry={entry} cover={cover} size="tile" lazy />
        </a>
        <ul class="sources-row-titles">
          {shown.map((st) => {
            const meta = storyMeta(st);
            return (
              <li key={st.items[0].key}>
                <a href={href} onClick={openAt(entry, st)}>
                  {storyName(entry, st)}
                </a>
                {meta ? <span class="sources-tile-meta"> · {meta}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** Sources that are one work or one collection each (an album, a book): side by side in one row. */
function SourcesRow({ shelf }: { shelf: Extract<Shelf, { kind: 'sources' }> }) {
  const id = 'row-quellen';
  return (
    <section class="sources-row" aria-labelledby={id}>
      <RowHead id={id} title="Weitere Quellen" />
      <Scroller label="Weitere Quellen">
        {shelf.hits.map(({ entry, items }) => (
          <li key={entry.id}>
            <a class="sources-tile" href={routeToHash({ page: 'sources', entry: entry.id })}>
              <SourceCover entry={entry} cover={entry.cover} size="tile" lazy />
              <span class="sources-tile-title">{entry.title}</span>
              <span class="sources-tile-meta">{countLabel(entry, items)}</span>
            </a>
          </li>
        ))}
      </Scroller>
    </section>
  );
}

/**
 * A row that scrolls sideways: by swiping, with the trackpad, or with the
 * two arrows, which show only while there is more to that side.
 */
function Scroller({ label, children }: { label: string; children: ComponentChildren }) {
  const list = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const look = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    look();
    el.addEventListener('scroll', look, { passive: true });
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(look) : undefined;
    sized?.observe(el);
    return () => {
      el.removeEventListener('scroll', look);
      sized?.disconnect();
    };
  }, []);
  const go = (dir: -1 | 1) => {
    const el = list.current;
    if (!el) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.8), behavior: reduce ? 'auto' : 'smooth' });
  };
  return (
    <div class="sources-row-scroller">
      <ul class="sources-row-tiles" ref={list}>
        {children}
      </ul>
      {more.left ? <IconButton class="sources-row-arrow left" label={`${label}: zurückblättern`} icon={ChevronLeft} size="sm" onClick={() => go(-1)} /> : null}
      {more.right ? <IconButton class="sources-row-arrow right" label={`${label}: weiterblättern`} icon={ChevronRight} size="sm" onClick={() => go(1)} /> : null}
    </div>
  );
}
