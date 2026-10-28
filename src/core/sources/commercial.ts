/**
 * Searches for well-known commercial series ("Die drei ???", "TKKG", …) find
 * nothing in a list of free sources. Instead of an empty result the page
 * says so honestly: these may not be downloaded freely, families can buy
 * them without copy protection and add their own files. The names live in
 * commercial-series.json; nothing here links to a shop or shows a logo.
 */
import data from './commercial-series.json';
import { foldText, normalizeSearch } from './text';
import type { SourceIndex } from './types';

export interface CommercialSeries {
  /** As families know it: "Die drei ???". */
  name: string;
  /**
   * "tonies": content on the figures of the Toniebox. "kreativ": a figure
   * that holds the family's own recordings.
   */
  kind?: 'tonies' | 'kreativ';
  /** Folded spellings, matched as whole words. */
  match: string[];
  /** Folded spellings that only count when they are the whole search ("die drei", "bibi"). */
  alone?: string[];
}

export const COMMERCIAL_SERIES: readonly CommercialSeries[] = (data as { series: CommercialSeries[] }).series;

/** Lower case, umlauts folded, but "???" and "!!!" kept: "Die drei ???" is not "die drei". */
function folded(text: string): string {
  const t = foldText(text)
    .replace(/[^a-z0-9?!]+/g, ' ')
    .replace(/([?!])\s+(?=[?!])/g, '$1')
    .trim();
  return ` ${t} `;
}

/**
 * The commercial series a search text names, if any. The longest spelling
 * wins ("Bibi und Tina" is not "Bibi Blocksberg"); a short form like "bibi"
 * only counts when nothing longer matched and it is the whole search.
 */
export function commercialSeriesIn(text: string | undefined): CommercialSeries | undefined {
  if (!text?.trim()) return undefined;
  const raw = folded(text);
  const words = ` ${normalizeSearch(text)} `;
  let best: CommercialSeries | undefined;
  let bestLength = 0;
  for (const s of COMMERCIAL_SERIES) {
    for (const m of s.match) {
      const plain = /^[a-z0-9 ]+$/.test(m);
      if (m.length > bestLength && (plain ? words.includes(` ${m} `) : raw.includes(` ${m} `))) {
        best = s;
        bestLength = m.length;
      }
    }
  }
  return best ?? COMMERCIAL_SERIES.find((s) => s.alone?.some((m) => words === ` ${m} `));
}

/**
 * Whether the list has the series after all (a free podcast of it, say):
 * then the hint would be wrong. Looks at titles and descriptions, not at the
 * search result, which may hold unrelated titles with the same words.
 */
export function seriesListed(index: SourceIndex, series: CommercialSeries): boolean {
  const blocked = new Set(index.blocked);
  return index.entries.some(
    (e) =>
      !blocked.has(e.id) &&
      (commercialSeriesIn(`${e.title} ${e.blurb ?? ''}`) === series || e.items.some((it) => !blocked.has(it.key) && commercialSeriesIn(it.title) === series)),
  );
}

/** The commercial series a search names that the list does not have; the page then shows the hint. */
export function missingSeries(index: SourceIndex, text: string | undefined): CommercialSeries | undefined {
  const series = commercialSeriesIn(text);
  return series && !seriesListed(index, series) ? series : undefined;
}

/** The help section on CDs, streaming and bought audio books: what can be added and what cannot. */
export const BUY_HELP_ID = 'cd-und-streaming';

export interface CommercialHint {
  title: string;
  text: string;
  /** A help section that says what can be bought and added, and what cannot (copy protection, streaming). */
  help?: string;
}

/** The friendly hint for a search that named a commercial series and found nothing. */
export function commercialHint(series: CommercialSeries): CommercialHint {
  if (series.kind === 'kreativ') {
    return {
      title: 'Aufnahmen von Kreativ-Tonies',
      text: 'Was auf einem Kreativ-Tonie ist, kann ich nicht von der Figur holen. Hast du die Aufnahmen noch als Dateien, zum Beispiel auf dem Handy oder Computer? Dann bringst du sie mit „Musik auf die SD-Karte“ auf die Box.',
    };
  }
  if (series.kind === 'tonies') {
    return {
      title: 'Inhalte von Tonies gibt es hier nicht',
      text: 'Die Hörspiele auf den Tonie-Figuren darfst du nicht frei herunterladen, und ich kann sie nicht von den Figuren holen. Viele davon gibt es auch auf CD. Die kopierst du auf deinen Computer und bringst sie dann mit „Musik auf die SD-Karte“ auf die Box.',
      help: BUY_HELP_ID,
    };
  }
  return {
    title: `„${series.name}“ gibt es hier nicht`,
    text: `Hier stehen nur Inhalte, die du kostenlos und legal herunterladen darfst. „${series.name}“ gehört nicht dazu. Du kannst die Folgen auf CD oder als Download ohne Kopierschutz (MP3) kaufen und dann mit „Musik auf die SD-Karte“ auf die Box bringen.`,
    help: BUY_HELP_ID,
  };
}
