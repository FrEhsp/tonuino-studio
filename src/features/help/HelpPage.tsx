import { signal } from '@preact/signals';
import { createContext } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ArrowRight, ChevronDown, ScrollText, Search, SearchX, X } from 'lucide-preact';
import { usePageShown } from '../../app/pageAlive';
import { parseHash } from '../../app/router';
import { platform } from '../../app/state';
import { APP_VERSION, runsAs } from '../../app/version';
import { BUILTIN_TEMPLATES } from '../../core/stickers/templates';
import { MODES, modifiersFor, type ModeInfo, type ModifierInfo } from '../../core/tonuino/modes';
import { Badge, Button, Callout } from '../../ui/components/controls';
import { CommandLine } from '../../ui/components/Hints';
import { LogoMark } from '../../ui/components/Logo';
import { ExternalLink } from './ExternalLink';
import { forumLink } from './forum';
import { GLOSSARY, glossaryAnchor, type GlossaryEntry } from './glossary';
import { HelpArt } from './HelpArt';
import { LicenseDialog } from './LicenseDialog';
import { LicenseLinks } from './LicenseLinks';
import { BUNDLED_DEPENDENCY_LICENSES, CRATE_NOTICES, FONT_NOTICES, PACKAGE_NOTICES } from './notices';
import { resultStatus, searchForMissing, searchHelp, type MarkedPart } from './search';
import {
  HELP_PHOTOS,
  HELP_TOPICS,
  helpHref,
  isExternal,
  parseInline,
  plainText,
  resolveHelp,
  sectionParts,
  termText,
  type HelpBlock,
  type HelpLink,
  type HelpPart,
  type HelpSection,
  type HelpTopic,
} from './topics';
import '../../ui/styles/help.css';

/** Kept while the help is open, so going back from a page shows the same results. */
const query = signal('');

/** The page shown, so a word of the Wörterbuch does not send you to the page you are on. */
const HerePage = createContext<string | undefined>(undefined);

/** Pages on the start page for the questions asked most, under the topics. */
/** The gift first, for new owners: it is no problem, and it was sorted under one (audit 0.4 #21). */
const OFTEN = ['geschenkt', 'box-bleibt-stumm', 'aussetzer', 'box-geht-aus', 'karte-geht-nicht', 'album-hinzufuegen'];

/**
 * #/hilfe: start page with search and the categories; #/hilfe/<topic>: the
 * pages of a category; #/hilfe/<page or part>: one short page, opened at
 * its part.
 */
export function HelpPage({ topic }: { topic?: string }) {
  const target = resolveHelp(topic);
  if (target.kind !== 'topic') return <HelpIndex missing={target.kind === 'missing' ? target.id : undefined} />;
  if (!target.section) return <HelpCategory topic={target.topic} key={target.topic.id} />;
  return <HelpArticle topic={target.topic} section={target.section} part={target.part} routeId={topic} key={target.section.id} />;
}

/* ------------------------------------------------------------------ start page */

function HelpIndex({ missing }: { missing?: string }) {
  const input = useRef<HTMLInputElement>(null);
  // An old or mistyped link: search for its words if a page is about them, else start with all categories.
  useEffect(() => {
    if (missing) query.value = searchForMissing(missing) ?? '';
  }, [missing]);

  const q = query.value;
  const caps = platform.value?.capabilities;
  const packageMode = !!caps && !caps.sd && caps.sdPackage;
  const results = useMemo(() => searchHelp(q, undefined, { packageMode }), [q, packageMode]);
  const searching = results.terms.length > 0;
  const status = resultStatus(results);
  const often = OFTEN.map((id) => resolveHelp(id)).flatMap((t) => (t.kind === 'topic' && t.section ? [t.section] : []));

  const clear = () => {
    query.value = '';
    input.current?.focus();
  };

  return (
    <div class="page help-page">
      <header class="page-header">
        <div class="titles">
          <h1>Hilfe</h1>
          <p>Antworten rund um deine Box und TonUINO Studio. Suche nach einem Wort wie „Lautstärke“ oder „stumm“, oder wähle ein Thema.</p>
        </div>
      </header>

      {missing ? (
        <Callout tone="warning">
          Die Hilfeseite „{missing}“ gibt es nicht. Vielleicht hat sie einen neuen Namen. Nutze die Suche unten oder wähle ein Thema.
        </Callout>
      ) : null}

      <div class="help-search" role="search">
        <label class="visually-hidden" for="help-search-input">
          Hilfe durchsuchen
        </label>
        <div class="input-group">
          <Search size={18} aria-hidden="true" />
          <input
            ref={input}
            id="help-search-input"
            class="input help-search-input"
            type="search"
            value={q}
            placeholder="Wonach suchst du?"
            autocomplete="off"
            spellcheck={false}
            aria-describedby="help-search-status"
            onInput={(e) => (query.value = e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) {
                e.preventDefault();
                query.value = '';
              } else if (e.key === 'Enter' && results.hits[0]) {
                location.hash = helpHref(results.hits[0].id);
              }
            }}
          />
          {q ? (
            <button type="button" class="help-search-clear" aria-label="Suche leeren" title="Suche leeren" onClick={clear}>
              <X size={16} strokeWidth={2.4} />
            </button>
          ) : null}
        </div>
        {/* Announced to screen readers; without hits the box below says it for everyone. */}
        <p id="help-search-status" class={`small muted help-search-status ${searching && !results.hits.length ? 'visually-hidden' : ''}`} aria-live="polite">
          {status}
        </p>
      </div>

      {searching && results.hits.length ? (
        <ul class="help-results" aria-label="Suchergebnisse">
          {results.hits.map((h) => (
            <li class="help-result" key={h.id}>
              <span class="help-result-where">{h.part && h.section ? `${h.topic.title} › ${h.section.title}` : h.section ? h.topic.title : 'Thema'}</span>
              <a class="help-result-link" href={helpHref(h.id)}>
                <Marked parts={h.title} />
              </a>
              {h.snippet.length ? (
                <p class="help-result-snippet">
                  <Marked parts={h.snippet} />
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {searching && !results.hits.length ? (
        <div class="help-empty">
          <SearchX size={28} aria-hidden="true" />
          <div class="stack tight">
            <strong>Nichts gefunden für „{q.trim()}“.</strong>
            <span class="small soft">Versuche ein anderes oder kürzeres Wort, zum Beispiel „Leser“ statt „NFC-Leser-Treiber“. Oder schaue in die Themen unten.</span>
          </div>
        </div>
      ) : null}

      {!searching || !results.hits.length ? (
        <>
          <section aria-labelledby="help-topics-title" class="stack">
            <h2 id="help-topics-title" class="section-title">
              Themen
            </h2>
            <ul class="help-topics">
              {HELP_TOPICS.map((t) => (
                <li class="help-topic-card" key={t.id}>
                  <HelpArt art={t.art} class="help-topic-art" />
                  <div class="help-topic-text">
                    <a class="help-topic-link" href={helpHref(t.id)}>
                      {t.title}
                    </a>
                    <p class="small soft">{t.summary}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {often.length ? (
            <nav class="help-often" aria-labelledby="help-often-title">
              <h2 id="help-often-title" class="section-title">
                Oft gesucht
              </h2>
              <ul>
                {often.map((s) => (
                  <li key={s.id}>
                    <a href={helpHref(s.id)}>{s.title}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <p class="small muted help-footnote">
            Fremde Wörter wie TNG, DFPlayer oder Admin-Menü erklärt das <a href={helpHref('woerterbuch')}>Wörterbuch</a>. TonUINO Studio ist ein unabhängiges Projekt und nicht
            das offizielle TonUINO-Projekt. Fragen zur Box selbst beantworten die Leute im <ExternalLink href="https://discourse.voss.earth">TonUINO-Forum</ExternalLink>. Mehr
            unter <a href={helpHref('ueber')}>Über TonUINO Studio</a>.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Marked({ parts }: { parts: MarkedPart[] }) {
  return <>{parts.map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : p.text))}</>;
}

/* ------------------------------------------------------------------ category */

function HelpCategory({ topic }: { topic: HelpTopic }) {
  const shown = usePageShown();
  useEffect(() => {
    if (shown) document.getElementById('help-article-title')?.focus({ preventScroll: true });
  }, [topic.id, shown]);
  const index = HELP_TOPICS.indexOf(topic);
  return (
    <div class="page help-page">
      <div>
        <a class="back-link" href="#/hilfe">
          <ArrowLeft size={15} strokeWidth={2.4} aria-hidden="true" /> Alle Themen
        </a>
        <header class="help-article-head">
          <HelpArt art={topic.art} class="help-head-art" />
          <div class="stack tight">
            <h1 id="help-article-title" tabIndex={-1}>
              {topic.title}
            </h1>
            <p class="soft">{topic.summary}</p>
          </div>
        </header>
      </div>

      <ol class="card help-pages" aria-label={`Seiten zu „${topic.title}“`}>
        {topic.sections.map((s) => (
          <li key={s.id}>
            <a href={helpHref(s.id)}>{s.title}</a>
            {s.summary ? <span class="small soft">{s.summary}</span> : null}
          </li>
        ))}
      </ol>

      {topic.footnote ? (
        <p class="small soft help-footnote">
          <Inline text={topic.footnote} />
        </p>
      ) : null}

      <Pager label="Weitere Themen" prev={HELP_TOPICS[index - 1]} next={HELP_TOPICS[index + 1]} what="Thema" />
    </div>
  );
}

/* ------------------------------------------------------------------ page */

/**
 * One page of a category: its summary, the open blocks, the parts folded
 * away under "Mehr", and at the end one thread of the forum.
 *
 * @param part The part the link opens, unfolded and scrolled to.
 * @param routeId The id as the link has it. "acr122u" and "kartenleser" show
 *   the same part, and going from one to the other still has to scroll.
 */
function HelpArticle({ topic, section, part, routeId }: { topic: HelpTopic; section: HelpSection; part?: HelpPart; routeId?: string }) {
  const { main, parts } = useMemo(() => sectionParts(section), [section]);
  const index = topic.sections.indexOf(section);
  const forum = section.forum !== undefined ? forumLink(section.forum) : undefined;

  // A link to a part (#/hilfe/cover-finden) opens it and scrolls there; keyboard and screen reader users
  // start there too. Again each time the page comes back into view: it stays mounted, hidden, while another
  // one shows (App.tsx).
  const shown = usePageShown();
  useEffect(() => {
    if (!shown) return;
    const target = showPlace(part?.id);
    if (!target) return;
    // Text in the fallback font wraps differently; once the app font is in, the part has moved.
    let current = true;
    void document.fonts?.ready.then(() => {
      if (current) target.scrollIntoView({ block: 'start' });
    });
    return () => {
      current = false;
    };
  }, [section.id, part?.id, routeId, shown]);

  // A link to the place already shown changes no route, or only how the id is
  // spelled ("acr122u" → "kartenleser"), so nothing would move: do it by hand.
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof Element ? e.target.closest('a[href^="#/hilfe/"]') : null;
    if (!link) return;
    const r = parseHash(link.getAttribute('href') ?? '');
    const to = resolveHelp(r.page === 'help' ? r.topic : undefined);
    if (to.kind !== 'topic' || to.section?.id !== section.id || to.part?.id !== part?.id) return;
    e.preventDefault();
    showPlace(part?.id, true);
  };

  return (
    <HerePage.Provider value={section.id}>
      <div class="page help-page" onClick={onClick}>
        <a class="back-link" href={helpHref(topic.id)}>
          <ArrowLeft size={15} strokeWidth={2.4} aria-hidden="true" /> {topic.title}
        </a>

        <div class="help-layout">
          <article class="card help-section" aria-labelledby="help-article-title">
            <header class="stack tight">
              <h1 id="help-article-title" tabIndex={-1}>
                {section.title}
              </h1>
              {section.summary ? <p class="help-lead">{section.summary}</p> : null}
            </header>
            {main.map((b, i) => (
              <Block block={b} key={i} />
            ))}
            {parts.map((p, i) => (
              <details class="trouble help-more" id={p.id ? partAnchor(p.id) : undefined} open={!!p.id && p.id === part?.id} key={`${section.id}-${i}`}>
                <summary>
                  <span>{p.title}</span>
                  <ChevronDown class="trouble-chevron" size={18} strokeWidth={2.4} aria-hidden="true" />
                </summary>
                <div class="help-more-body">
                  {p.blocks.map((b, j) => (
                    <Block block={b} key={j} />
                  ))}
                </div>
              </details>
            ))}
            {forum ? (
              <p class="help-forum small">
                Im Forum nachlesen: <ExternalLink href={forum.url}>{`„${forum.title}“`}</ExternalLink>
              </p>
            ) : null}
          </article>

          <nav class="help-toc" aria-labelledby="help-toc-title">
            <h2 id="help-toc-title" class="section-title">
              {topic.title}
            </h2>
            <ol>
              {topic.sections.map((s) => (
                <li key={s.id}>
                  <a href={helpHref(s.id)} aria-current={s.id === section.id ? 'page' : undefined}>
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <Pager label={`Weitere Seiten zu „${topic.title}“`} prev={topic.sections[index - 1]} next={topic.sections[index + 1]} what="Seite" />
        </div>
      </div>
    </HerePage.Provider>
  );
}

function Pager({ label, prev, next, what }: { label: string; prev?: { id: string; title: string }; next?: { id: string; title: string }; what: 'Seite' | 'Thema' }) {
  if (!prev && !next) return null;
  return (
    <nav class="help-pager" aria-label={label}>
      {prev ? (
        <a class="help-pager-link" href={helpHref(prev.id)}>
          <span class="small muted">{what === 'Seite' ? 'Vorherige Seite' : 'Vorheriges Thema'}</span>
          <span class="help-pager-title">
            <ArrowLeft size={16} strokeWidth={2.4} aria-hidden="true" />
            {prev.title}
          </span>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a class="help-pager-link next" href={helpHref(next.id)}>
          <span class="small muted">{what === 'Seite' ? 'Nächste Seite' : 'Nächstes Thema'}</span>
          <span class="help-pager-title">
            {next.title}
            <ArrowRight size={16} strokeWidth={2.4} aria-hidden="true" />
          </span>
        </a>
      ) : null}
    </nav>
  );
}

/** Element id of a part; "hilfe-" keeps it apart from the ids of other pages. */
function partAnchor(id: string): string {
  return `hilfe-${id}`;
}

/**
 * Opens a part, brings it into view and moves focus to its summary, or to the
 * title without a part. `again` is for a link to the place already shown: the
 * router does not scroll then, so this does it, and the part flashes once
 * more so the click visibly does something.
 */
function showPlace(partId: string | undefined, again = false): HTMLElement | null {
  const target = partId ? document.getElementById(partAnchor(partId)) : null;
  if (target instanceof HTMLDetailsElement) target.open = true;
  const focus = target?.querySelector<HTMLElement>('summary') ?? document.getElementById('help-article-title');
  focus?.focus({ preventScroll: true });
  if (target) {
    target.scrollIntoView({ block: 'start' });
    if (again) {
      target.classList.remove('is-target');
      void target.offsetWidth; // restarts the highlight animation
    }
    target.classList.add('is-target');
  } else if (again) {
    document.querySelector('.help-page')?.scrollIntoView({ block: 'start' });
  }
  return target;
}

/* ------------------------------------------------------------------ blocks */

function Block({ block }: { block: HelpBlock }) {
  switch (block.kind) {
    case 'p':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case 'h3':
      return (
        <h3>
          <Inline text={block.text} />
        </h3>
      );
    case 'steps':
      return (
        <ol class="help-steps">
          {block.items.map((t) => (
            <li key={t}>
              <Inline text={t} />
            </li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul class="help-list">
          {block.items.map((t) => (
            <li key={t}>
              <Inline text={t} />
            </li>
          ))}
        </ul>
      );
    case 'checks':
      return (
        <ol class="help-checks" aria-label="Der Reihe nach prüfen">
          {block.items.map((t) => (
            <li key={t}>
              <Inline text={t} />
            </li>
          ))}
        </ol>
      );
    case 'note':
      return (
        <Callout tone={block.tone}>
          <Inline text={block.text} />
        </Callout>
      );
    case 'bild':
      return (
        <figure class="help-figure">
          <HelpArt art={block.art} />
          <figcaption>
            <Inline text={block.caption} />
          </figcaption>
        </figure>
      );
    case 'foto': {
      // A picture of the app; the browser loads it only when the page shows it.
      const photo = HELP_PHOTOS[block.photo];
      return (
        <figure class="help-figure help-photo">
          <img src={photo.file} width={photo.width} height={photo.height} alt="" loading="lazy" decoding="async" />
          <figcaption>
            <Inline text={block.caption} />
          </figcaption>
        </figure>
      );
    }
    case 'command':
      return (
        <div class="help-command">
          <p>
            <Inline text={block.text} />
          </p>
          <CommandLine command={block.command} />
        </div>
      );
    case 'links':
      return (
        <div class="row wrap help-links">
          {block.links.map((l) => (
            <LinkButton link={l} key={l.href} />
          ))}
        </div>
      );
    case 'mehr':
      // Split off by sectionParts before; a stray one shows nothing.
      return null;
    case 'modes':
      return <ModeList />;
    case 'modifiers':
      return <ModifierList />;
    case 'papers':
      return <PaperList />;
    case 'notices':
      return <Notices />;
    case 'glossary':
      return <Glossary />;
    case 'version':
      return <VersionInfo />;
  }
}

/** Text with **bold**, [links](#/…) and [[words]] of the Wörterbuch. */
function Inline({ text, terms = true }: { text: string; terms?: boolean }) {
  return (
    <>
      {parseInline(text).map((p, i) =>
        p.kind === 'text' ? (
          p.text
        ) : p.kind === 'strong' ? (
          <strong key={i}>{p.inner ? <Inline text={p.inner} terms={terms} /> : p.text}</strong>
        ) : p.kind === 'term' ? (
          terms ? (
            <Term text={p.text} entry={p.entry} key={i} />
          ) : (
            p.text
          )
        ) : isExternal(p.href) ? (
          <ExternalLink href={p.href} key={i}>
            {p.text}
          </ExternalLink>
        ) : (
          <a href={p.href} key={i}>
            {p.text}
          </a>
        ),
      )}
    </>
  );
}

let termCount = 0;

/** A word of the Wörterbuch: underlined with dots, a tap shows what it means right below. */
function Term({ text, entry }: { text: string; entry: GlossaryEntry }) {
  const [open, setOpen] = useState(false);
  const [id] = useState(() => `help-term-${++termCount}`);
  const here = useContext(HerePage);
  return (
    <>
      <button type="button" class="help-term" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {text}
      </button>
      <span id={id} class="help-term-note" role="note" hidden={!open}>
        <strong>{entry.term}:</strong> <Inline text={termText(entry, here)} terms={false} />{' '}
        <a href={helpHref('woerterbuch')} class="help-term-more">
          Wörterbuch
        </a>
      </span>
    </>
  );
}

function Glossary() {
  return (
    <dl class="help-glossary">
      {GLOSSARY.map((e) => (
        <div id={glossaryAnchor(e.id)} key={e.id}>
          <dt>{e.term}</dt>
          <dd>
            <Inline text={e.text} terms={false} />
            {e.aka?.length ? <span class="tiny muted"> Auch: {e.aka.filter((a) => plainText(a) !== e.term).join(', ')}.</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LinkButton({ link }: { link: HelpLink }) {
  if (isExternal(link.href)) {
    return (
      <ExternalLink href={link.href} class="btn">
        {link.label}
      </ExternalLink>
    );
  }
  return (
    <a class="btn" href={link.href}>
      {link.label}
      <ArrowRight size={16} strokeWidth={2.2} aria-hidden="true" />
    </a>
  );
}

/* ------------------------------------------------------------------ generated blocks */

function ModeItem({ mode }: { mode: ModeInfo }) {
  const tngOnly = !mode.profiles.includes('classic21');
  return (
    <li>
      <span class="help-def-head">
        <strong>{mode.name}</strong>
        {tngOnly ? <Badge>{mode.since ? `ab TNG ${mode.since}` : 'nur TNG'}</Badge> : null}
      </span>
      <span class="small soft">
        {mode.tagline} {mode.goodFor}
      </span>
    </li>
  );
}

/** Every mode of src/core/tonuino/modes.ts, so the list matches what the app offers. */
function ModeList() {
  return (
    <>
      <ul class="help-defs">
        {MODES.filter((m) => !m.advanced).map((m) => (
          <ModeItem mode={m} key={m.code} />
        ))}
      </ul>
      <h3>Spiele und Spezialmodi</h3>
      <ul class="help-defs">
        {MODES.filter((m) => m.advanced).map((m) => (
          <ModeItem mode={m} key={m.code} />
        ))}
      </ul>
    </>
  );
}

function ModifierItem({ mod, badge }: { mod: ModifierInfo; badge?: string }) {
  return (
    <li>
      <span class="help-def-head">
        <strong>{mod.name}</strong>
        {badge ? <Badge>{badge}</Badge> : null}
      </span>
      <span class="small soft">{mod.tagline}</span>
    </li>
  );
}

/** The modifier cards of TNG, plus those only TonUINO 2.1 has. */
function ModifierList() {
  const tng = modifiersFor('tng');
  const classicOnly = modifiersFor('classic21').filter((m) => !tng.some((t) => t.name === m.name));
  return (
    <ul class="help-defs">
      {tng.map((m) => (
        <ModifierItem mod={m} badge={m.profiles.includes('classic21') ? undefined : m.since ? `ab TNG ${m.since}` : 'nur TNG'} key={`tng-${m.code}`} />
      ))}
      {classicOnly.map((m) => (
        <ModifierItem mod={m} badge="nur 2.1" key={`classic-${m.code}`} />
      ))}
    </ul>
  );
}

function PaperList() {
  return (
    <ul class="help-defs">
      {BUILTIN_TEMPLATES.map((t) => (
        <li key={t.id}>
          <strong>{t.name}</strong>
          <span class="small soft">
            {t.description}
            {t.verified ? null : ' Die Maße sind noch nicht mit einem echten Bogen geprüft: Drucke zuerst die Testseite.'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function VersionInfo() {
  return (
    <div class="help-version">
      <LogoMark size={40} />
      <div class="stack tight">
        <strong>TonUINO Studio {APP_VERSION}</strong>
        <span class="small soft">{runsAs(platform.value)}</span>
      </div>
    </div>
  );
}

/** Who made the parts the app is built from, and their licences; the full texts are in a dialog. */
function Notices() {
  const code = PACKAGE_NOTICES.filter((p) => p.kind === 'code' && !p.unused);
  const fontPackages = PACKAGE_NOTICES.filter((p) => p.kind === 'font');
  const unused = PACKAGE_NOTICES.filter((p) => p.unused);
  return (
    <div class="stack help-notices">
      <h3>Programmteile</h3>
      <ul class="help-notice-list">
        {code.map((p) => (
          <li key={p.name}>
            <span class="help-def-head">
              <ExternalLink href={p.url}>{p.name}</ExternalLink>
              <span class="tiny muted">{p.version}</span>
            </span>
            <span class="small soft">{p.use}</span>
            <span class="tiny muted">
              {p.copyright} · Lizenz: <LicenseLinks expression={p.license} />
            </span>
            {p.note ? <span class="tiny muted">{p.note}</span> : null}
          </li>
        ))}
      </ul>

      <h3>Schriften</h3>
      <ul class="help-notice-list">
        {FONT_NOTICES.map((f) => (
          <li key={f.family}>
            <span class="help-def-head">
              <ExternalLink href={f.url}>{f.family}</ExternalLink>
            </span>
            <span class="small soft">{f.use}</span>
            <span class="tiny muted">
              {f.copyright} · Lizenz: <LicenseLinks expression={f.license} />
            </span>
            <span class="tiny muted">
              {f.bundled
                ? `Liegt der App bei, von Google Fonts (${f.bundled.version}).`
                : `Aus ${f.packages
                    .map((name) => {
                      const pkg = fontPackages.find((p) => p.name === name);
                      return pkg ? `${name} ${pkg.version}` : name;
                    })
                    .join(' und ')}.`}
            </span>
          </li>
        ))}
      </ul>
      <p class="tiny muted">
        Die Schrift-Pakete von Expo stehen außerdem unter der <LicenseLinks expression="MIT" />-Lizenz, Copyright (c) 2020 Expo.
      </p>

      <h3>In der Desktop-App</h3>
      <ul class="help-notice-list">
        {CRATE_NOTICES.map((c) => (
          <li key={c.name}>
            <span class="help-def-head">
              <ExternalLink href={c.url}>{c.name}</ExternalLink>
              <span class="tiny muted">{c.version}</span>
            </span>
            <span class="small soft">{c.use}</span>
            <span class="tiny muted">
              {c.copyright} · Lizenz: <LicenseLinks expression={c.license} />
            </span>
          </li>
        ))}
      </ul>

      <p class="small soft">
        Die Programmteile bringen weitere kleine Pakete mit. Diese stehen unter den Lizenzen {listInWords(BUNDLED_DEPENDENCY_LICENSES, 'oder')}. Die Desktop-App bringt außerdem weitere Rust-Pakete
        mit, die meisten unter MIT oder Apache-2.0. Alle Pakete mit ihren vollständigen Lizenztexten liegen der App bei:
      </p>
      <FullLicenses />
      {unused.length ? (
        <p class="small muted">
          In der Paketliste stehen außerdem {listInWords(unused.map((p) => p.name))}. Sie sind derzeit nicht in der App enthalten.
        </p>
      ) : null}
    </div>
  );
}

/** The button to the full list; the texts are loaded only when someone asks for them. */
function FullLicenses() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button icon={ScrollText} onClick={() => setOpen(true)}>
        Alle Lizenztexte anzeigen
      </Button>
      {open ? <LicenseDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** "a, b und c" */
function listInWords(items: readonly string[], last = 'und'): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}
