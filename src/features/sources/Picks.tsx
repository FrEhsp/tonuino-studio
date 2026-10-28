/**
 * The picks ("Empfehlungen"): the big tip at the top of "Entdecken" and a
 * small teaser on the start page. Both follow the choices for kind and age,
 * and both are absent when there is nothing to recommend. A recommended
 * show is never one bundle here: each story is a pick of its own.
 */
import './sources.css';
import { useEffect, useMemo } from 'preact/hooks';
import { ArrowRight } from 'lucide-preact';
import { recommendations, type Recommendation } from '../../core/sources/filter';
import type { SourceIndex } from '../../core/sources/types';
import { routeToHash } from '../../app/router';
import { pickAges, pickAgesLabel, pickLengthLabel, pickText, pickTitle } from './labels';
import { SourceCover } from './parts';
import { focusItem, kindChoice, peekKept, prefs, sourcesAvailable, teaserIndex } from './state';

/** The picks on "Entdecken" for the choices of kind and age; none while searching. */
export function usePicks(index: SourceIndex, off = false): Recommendation[] {
  const p = prefs.value;
  const kind = kindChoice.value;
  return useMemo(() => (off ? [] : recommendations(index, { category: kind, band: p.band })), [off, index, kind, p.band]);
}

/** Picks on the start page. */
export const TEASER_PICKS = 3;

function hrefOf(r: Recommendation): string {
  return routeToHash({ page: 'sources', entry: r.entry.id });
}

/** A title pick opens its source, scrolls to the title and marks all parts of its story there. */
function follow(r: Recommendation): void {
  if (r.item) focusItem.value = { entry: r.entry.id, key: r.item.key, keys: r.items.map((it) => it.key), story: pickTitle(r) };
}

function metaLine(r: Recommendation): string {
  return [pickAgesLabel(pickAges(r)), pickLengthLabel(r)].filter(Boolean).join(' · ');
}

/**
 * The one big thing of "Entdecken" (TODO #119): the first pick for the
 * choices of kind and age, with its cover large, why it is recommended and
 * the one filled button of the page. The rows below hold everything else.
 */
export function LeadPick({ r }: { r: Recommendation }) {
  const title = pickTitle(r);
  const href = hrefOf(r);
  const why = pickText(r);
  return (
    <section class="sources-lead" aria-labelledby="sources-lead-h">
      {/* The button opens it too; the picture is one more way for the mouse, not a second stop for the keyboard. */}
      <a class="sources-lead-cover" href={href} onClick={() => follow(r)} tabIndex={-1} aria-hidden="true">
        <SourceCover entry={r.entry} cover={r.item?.cover ?? r.entry.cover} title={title} size="xl" />
      </a>
      <div class="sources-lead-text">
        <p class="sources-lead-kicker">Mein Tipp</p>
        <h2 id="sources-lead-h" class="sources-lead-title">
          {title}
        </h2>
        <p class="sources-lead-from">{r.item ? `Aus „${r.entry.title}“` : r.entry.publisher}</p>
        <p class="sources-lead-meta">{metaLine(r)}</p>
        {why ? <p class="sources-lead-why">{why}</p> : null}
        <a class="btn primary sources-lead-go" href={href} onClick={() => follow(r)}>
          Ansehen <ArrowRight size={18} strokeWidth={2.2} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}

/**
 * Up to three picks on the start page, with "Mehr entdecken". Only in a
 * build with "Entdecken" and only when the list the app already has (the
 * one loaded on "Entdecken", the kept copy or the one that came with the
 * app) has picks: the start page never loads the list from the internet.
 */
export function PicksTeaser() {
  if (!__SOURCES_ENABLED__ || !sourcesAvailable.value) return null;
  return <Teaser />;
}

function Teaser() {
  useEffect(() => peekKept(), []);
  const index = teaserIndex.value;
  const p = prefs.value;
  const kind = kindChoice.value;
  const picks = useMemo(() => (index ? recommendations(index, { category: kind, band: p.band }).slice(0, TEASER_PICKS) : []), [index, kind, p.band]);
  if (!picks.length) return null;
  return (
    <section class="picks-teaser" aria-labelledby="picks-teaser-h">
      <div class="picks-teaser-head">
        <h2 id="picks-teaser-h">
          Empfehlungen zum Entdecken
        </h2>
        <a class="picks-teaser-more" href={routeToHash({ page: 'sources' })}>
          Mehr entdecken <ArrowRight size={15} strokeWidth={2.2} aria-hidden="true" />
        </a>
      </div>
      <ul class="picks-teaser-list">
        {picks.map((r) => (
          <li key={r.item?.key ?? r.entry.id}>
            {/* No picture here: the start page loads nothing from the internet. */}
            <SourceCover entry={r.entry} size="sm" />
            <span class="picks-teaser-text">
              <a href={hrefOf(r)} onClick={() => follow(r)}>
                {pickTitle(r)}
              </a>
              <span class="small muted">{metaLine(r)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
