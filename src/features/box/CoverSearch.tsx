import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { downloadCoverImage, keepShownOrder, searchCovers, type CoverCandidate, type CoverKind, type CoverSearchResult } from '../../core/stickers/coversearch';
import { isAbortError, type FetchLike } from '../../core/stickers/image';
import { routedFetch } from '../../core/covers/route';
import type { Platform } from '../../platform/types';
import { Button, Callout, Segmented, Spinner } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { plat } from '../../app/state';

/** How long the hits of the faster service wait for the slower one before they show on their own. */
const FIRST_HITS_GRACE_MS = 700;

/** Names of the services for the credit line of a cover. */
export const SOURCE_LABEL: Record<CoverCandidate['source'], string> = { itunes: 'iTunes', deezer: 'Deezer', musicbrainz: 'MusicBrainz' };

/** CD or cassette, remembered for this visit: someone looking for cassette covers usually wants more of them. */
let lastKind: CoverKind = 'cd';

/**
 * Online cover search: iTunes and MusicBrainz, ranked for German audio plays.
 * "Kassette" looks for the covers of cassette editions instead (MusicBrainz
 * only): taller than wide, much like a card turned upright.
 * Hits show as soon as the first service answers; hits of the slower one
 * join them at the end, so no tile moves while someone aims at it. The
 * search can start again at any time. Choosing a cover while
 * another one is still loading drops the earlier one; leaving the search
 * (other tab, closed dialog) stops the download.
 */
/**
 * `quiet`: „Suchen“ as a plain button, where the dialog has its own purple one („Übernehmen“).
 * `pictograms`: a third choice „Piktogramm“ beside the two kinds of cover, showing what it returns (TODO #113).
 */
export function CoverSearch({ initialQuery, onPick, quiet = false, pictograms }: { initialQuery: string; onPick: (blob: Blob, source: string, kind: CoverKind, hit: CoverCandidate) => void; quiet?: boolean; pictograms?: () => ComponentChildren }) {
  const [q, setQ] = useState(initialQuery);
  const [kind, setKind] = useState<CoverKind>(lastKind);
  const [picto, setPicto] = useState(false);
  const [state, setState] = useState<{ status: 'idle' | 'busy' | 'done'; kind: CoverKind; results: CoverCandidate[]; warnings: string[] }>({ status: 'idle', kind, results: [], warnings: [] });
  const [loading, setLoading] = useState<string | null>(null);
  // Thumbnails that did not load: hits without a picture (MusicBrainz often has none) are left out.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  // MusicBrainz pictures come only once loaded (often slowly, often not at all): no empty tiles meanwhile.
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set());
  const abort = useRef<AbortController | null>(null);
  const download = useRef<AbortController | null>(null);

  const run = async (text: string, as: CoverKind = kind) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    // Tiles of this search in the order they went on the screen; later hits only add to them.
    let onScreen: CoverCandidate[] = [];
    const show = (status: 'busy' | 'done', r: CoverSearchResult) => {
      onScreen = keepShownOrder(onScreen, r.candidates);
      setState({ status, kind: as, results: onScreen, warnings: [...r.warnings, ...(r.notes ?? [])] });
    };
    // The first service to answer shows its hits only if the other one takes a while: answering
    // within the grace time, both come out ranked together.
    let early: ReturnType<typeof setTimeout> | undefined;
    const stopEarly = () => clearTimeout(early);
    ctrl.signal.addEventListener('abort', stopEarly, { once: true });
    // Tiles of the last search would pass for hits of this one.
    setState({ status: 'busy', kind: as, results: [], warnings: [] });
    try {
      const r = await searchCovers(
        { query: text },
        {
          fetchFn: coverFetch,
          signal: ctrl.signal,
          kind: as,
          onProgress: (partial) => {
            stopEarly();
            early = setTimeout(() => {
              if (!ctrl.signal.aborted) show('busy', partial);
            }, FIRST_HITS_GRACE_MS);
          },
        },
      );
      stopEarly();
      show('done', r);
    } catch (e) {
      stopEarly();
      if (!isAbortError(e)) setState({ status: 'done', kind: as, results: [], warnings: ['Die Suche hat nicht geklappt. Prüfe die Internetverbindung. Blockiert vielleicht ein Filter? Welche Adressen frei sein müssen, steht in der Hilfe unter „Internetfilter und Firewall“.'] });
    }
  };

  useEffect(() => {
    if (initialQuery.trim()) void run(initialQuery);
    return () => {
      abort.current?.abort();
      download.current?.abort();
      download.current = null;
    };
  }, []);

  const switchKind = (k: CoverKind) => {
    if (k === kind) return;
    lastKind = k;
    setKind(k);
    if (q.trim()) void run(q, k);
    else setState({ status: 'idle', kind: k, results: [], warnings: [] });
  };

  const pick = async (c: CoverCandidate) => {
    if (loading === c.id) return;
    download.current?.abort();
    const ctrl = new AbortController();
    download.current = ctrl;
    setLoading(c.id);
    try {
      const blob = await loadSearchCover(c, ctrl.signal);
      if (!ctrl.signal.aborted) onPick(blob, SOURCE_LABEL[c.source], c.edition ? 'cassette' : 'cd', c);
    } catch (e) {
      if (!ctrl.signal.aborted && !isAbortError(e)) toastError('Das Bild lässt sich nicht laden', e);
    } finally {
      if (download.current === ctrl) {
        download.current = null;
        setLoading(null);
      }
    }
  };

  useEffect(() => {
    const waiting = state.results.filter((c) => c.source === 'musicbrainz' && !ready.has(c.thumbUrl) && !broken.has(c.thumbUrl));
    const imgs = waiting.map((c) => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => setReady((r) => new Set(r).add(c.thumbUrl));
      img.onerror = () => setBroken((b) => new Set(b).add(c.thumbUrl));
      img.src = c.thumbUrl;
      return img;
    });
    return () => imgs.forEach((img) => (img.onload = img.onerror = null));
  }, [state.results]);

  const shown = state.results.filter((c) => !broken.has(c.thumbUrl) && (c.source !== 'musicbrainz' || ready.has(c.thumbUrl)));
  const waitingForPictures = state.results.some((c) => c.source === 'musicbrainz' && !broken.has(c.thumbUrl) && !ready.has(c.thumbUrl));
  const cassette = state.kind === 'cassette';

  const chooser = (
    <Segmented<CoverKind | 'pictogram'>
      label="Was für ein Cover?"
      value={picto ? 'pictogram' : kind}
      options={[
        { value: 'cd', label: 'CD-Cover' },
        { value: 'cassette', label: 'Kassetten-Cover' },
        ...(pictograms ? [{ value: 'pictogram' as const, label: 'Piktogramm' }] : []),
      ]}
      onChange={(k) => {
        setPicto(k === 'pictogram');
        if (k !== 'pictogram') switchKind(k);
      }}
    />
  );

  if (picto && pictograms) {
    return (
      <div class="stack cover-search">
        {chooser}
        {pictograms()}
      </div>
    );
  }

  return (
    <div class="stack cover-search">
      {chooser}
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <div class="input-group grow">
          <Search size={17} />
          <input class="input" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Titel oder Interpret, z. B. Die drei ??? Folge 12" aria-label="Suchbegriff" />
        </div>
        {/* Never locked: a new search stops the one before. */}
        <Button type="submit" variant={quiet ? 'default' : 'primary'}>
          Suchen
        </Button>
      </form>
      {state.warnings.map((w) => (
        <Callout tone="warning" key={w}>
          {w}
        </Callout>
      ))}
      {(state.status === 'busy' || waitingForPictures) && !shown.length ? (
        <div class="row soft">
          <Spinner size={18} /> Suche läuft …
        </div>
      ) : null}
      {state.status === 'done' && !waitingForPictures && !shown.length && !state.warnings.length ? (
        <p class="soft">
          {cassette
            ? 'Keine Kassette mit Bild gefunden. Versuche es mit weniger Wörtern oder nur dem Namen der Serie. Für viele Kassetten hat noch niemand ein Bild hochgeladen, dann hilft nur das CD-Cover.'
            : 'Nichts gefunden. Versuche es mit weniger Wörtern oder nur dem Namen der Serie.'}
        </p>
      ) : null}
      {shown.length ? (
        <div class={`cover-results${cassette ? ' tall' : ''}`} aria-busy={state.status === 'busy'}>
          {shown.map((c) => (
            <button type="button" class="cover-result" key={c.id} onClick={() => pick(c)} aria-busy={loading === c.id} title={`${c.title} – ${c.artist}`}>
              <span class="cover-result-img">
                <img src={c.thumbUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setBroken((b) => new Set(b).add(c.thumbUrl))} />
                {loading === c.id ? (
                  <span class="cover-result-busy">
                    <Spinner size={22} />
                  </span>
                ) : null}
              </span>
              <span class="cover-result-title">{c.title}</span>
              <span class="cover-result-meta">
                {c.artist}
                {c.year ? ` · ${c.year}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {state.status === 'busy' && shown.length ? (
        <div class="row soft small" role="status">
          <Spinner size={14} /> Weitere Treffer werden gesucht …
        </div>
      ) : null}
      {shown.length ? (
        <p class="hint">
          {cassette
            ? 'Kassetten-Cover sind hoch wie eine aufgestellte Karte: Der Sticker wird dafür hochkant. Bilder von MusicBrainz (Cover Art Archive). Nur für den privaten Gebrauch.'
            : 'Bilder von iTunes, Deezer und MusicBrainz (Cover Art Archive). Nur für den privaten Gebrauch.'}
        </p>
      ) : null}
    </div>
  );
}

/** Loads a hit of the search in the largest size the server gives out (see downloadCoverImage). */
export function loadSearchCover(c: Pick<CoverCandidate, 'fullUrl' | 'mediumUrl' | 'thumbUrl'>, signal?: AbortSignal): Promise<Blob> {
  return downloadCoverImage(c, { fetchFn: coverFetch, signal });
}

let routed: FetchLike | undefined;
let routedFor: Platform | undefined;

/**
 * fetch for the search requests and pictures (src/core/covers/route.ts): in
 * the desktop app through the backend with the app's own User-Agent, else
 * the WebView's fetch, and JSONP for iTunes and Deezer when their answer
 * has no CORS header.
 */
export function coverFetch(url: string, init?: RequestInit): Promise<Response> {
  const p = plat();
  if (!routed || routedFor !== p) {
    routedFor = p;
    routed = routedFetch({
      native: p.coverNet ? (u, i) => p.coverNet!.fetch(u, i) : undefined,
      web: (u, i) => p.fetch(u, i),
      jsonp: typeof document === 'undefined' ? undefined : (u, signal) => jsonp(u, signal),
    });
  }
  return routed(url, init);
}

function jsonp(url: string, signal?: AbortSignal, timeoutMs = 12_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const name = `__tonuinoJsonp_${Math.random().toString(36).slice(2, 10)}`;
    const w = window as unknown as Record<string, unknown>;
    const script = document.createElement('script');
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      script.remove();
      delete w[name];
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Abgebrochen', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, timeoutMs);
    w[name] = (data: unknown) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('JSONP failed'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${name}`;
    document.head.append(script);
  });
}
