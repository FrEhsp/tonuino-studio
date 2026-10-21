/**
 * The picks ("Empfehlungen"): a section at the top of "Entdecken" and a
 * small teaser on the start page. Both follow the choices for kind and age,
 * and both are absent when there is nothing to recommend. A recommended
 * show is never one bundle here: each story has its own card.
 */
import './sources.css';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ArrowRight } from 'lucide-preact';
import { recommendations, type Recommendation } from '../../core/sources/filter';
import type { SourceIndex } from '../../core/sources/types';
import { routeToHash } from '../../app/router';
import { plural } from '../../app/format';
import { pickAges, pickAgesLabel, pickLengthLabel, pickText, pickTitle } from './labels';
import { SourceCover } from './parts';
import { focusItem, kindChoice, peekKept, prefs, sourcesAvailable, teaserIndex } from './state';

/** Picks shown before "Alle anzeigen": two rows on a wide screen. */
export const PICKS_SHOWN = 4;
/** On a phone two, so the search and the filters stay close to the top. */
export const PICKS_SHOWN_NARROW = 2;
/** Where the picks get fewer and smaller; the same width as the compact cards in sources.css. */
export const NARROW_QUERY = '(max-width: 480px)';

/** How many picks show before "Alle anzeigen" on a screen of this kind. */
export function picksShown(narrow: boolean): number {
  return narrow ? PICKS_SHOWN_NARROW : PICKS_SHOWN;
}

/** "Alle Empfehlungen anzeigen" was clicked: kept while people look around, so going back finds the page as it was. */
export const picksExpanded = signal(false);

/**
 * The picks on "Entdecken" for the choices of kind and age, and the ones
 * shown before "Alle anzeigen". The list below leaves the shown ones out.
 */
export function usePicks(index: SourceIndex, off = false): { picks: Recommendation[]; shown: Recommendation[]; folded: number } {
  const p = prefs.value;
  const kind = kindChoice.value;
  const picks = useMemo(() => (off ? [] : recommendations(index, { category: kind, band: p.band })), [off, index, kind, p.band]);
  const narrow = useNarrow();
  const folded = picksShown(narrow);
  return { picks, shown: picksExpanded.value ? picks : picks.slice(0, folded), folded };
}

/** Whether the screen is phone-sized; follows turning the phone. */
function useNarrow(): boolean {
  const query = (): MediaQueryList | undefined => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : undefined;
    } catch {
      return undefined;
    }
  };
  const [narrow, setNarrow] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return narrow;
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

/** "Weniger anzeigen": back to the first picks, with the heading in view again. */
function showFewer(): void {
  picksExpanded.value = false;
  document.getElementById('sources-picks-h')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The section "Empfehlungen" above the list on "Entdecken" (usePicks). `folded`: how many show before "Alle anzeigen". */
export function PicksSection({ picks, shown, folded }: { picks: Recommendation[]; shown: Recommendation[]; folded: number }) {
  if (!picks.length) return null;
  return (
    <section class="sources-picks" aria-labelledby="sources-picks-h">
      <div class="sources-picks-head">
        <h2 id="sources-picks-h">
          Empfehlungen
        </h2>
        <span class="small muted">Ich hab hier freie Hörspiele und Hörbücher rausgesucht, die ich gut finde.</span>
      </div>
      <div class="sources-picks-grid">
        {shown.map((r) => (
          <PickCard key={r.item?.key ?? r.entry.id} r={r} />
        ))}
      </div>
      {picks.length > shown.length ? (
        <button type="button" class="link-button sources-picks-more" onClick={() => (picksExpanded.value = true)}>
          Alle {plural(picks.length, 'Empfehlung', 'Empfehlungen')} anzeigen
        </button>
      ) : picksExpanded.value && picks.length > folded ? (
        <button type="button" class="link-button sources-picks-more" onClick={showFewer}>
          Weniger anzeigen
        </button>
      ) : null}
    </section>
  );
}

/**
 * One pick. The whole card opens it, the picture and the title too: the
 * title is its one link, stretched over the card (sources.css); "Ansehen"
 * only shows where to click and is no second target.
 */
export function PickCard({ r }: { r: Recommendation }) {
  const title = pickTitle(r);
  return (
    <article class="source-pick">
      <SourceCover entry={r.entry} cover={r.item?.cover ?? r.entry.cover} title={title} />
      <div class="source-pick-body">
        <h3 class="source-pick-title">
          <a class="source-pick-link" href={hrefOf(r)} onClick={() => follow(r)}>
            {title}
          </a>
        </h3>
        <p class="source-card-publisher">{r.item ? `Aus „${r.entry.title}“` : r.entry.publisher}</p>
        <p class="source-pick-meta">{metaLine(r)}</p>
        <p class="source-pick-why">{pickText(r)}</p>
        <span class="btn sm soft source-pick-action" aria-hidden="true">
          Ansehen <ArrowRight size={16} strokeWidth={2.2} aria-hidden="true" />
        </span>
      </div>
    </article>
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
