/**
 * The editors' notes on the catalogue: who reviewed an entry, what is still
 * open, which permission a publisher still has to give, internal remarks and
 * the sources looked at and not used. They stay out of the public repository
 * and out of the app (which bundles sources/catalog.json); the source scripts
 * mix them in when the file is there (scripts/sources/fsutil.ts, readCatalog).
 * Without it the catalogue builds the same list: none of these fields changes
 * what an 'active' entry publishes.
 */

export interface EntryNotes {
  internal?: string;
  /** review.by */
  reviewBy?: string;
  permission?: unknown;
  openChecks?: unknown;
  /** The status in the editors' workflow when it says more than the catalogue (e.g. 'waiting-permission'); never 'active'. */
  status?: string;
}

export interface EditorialNotes {
  format: 1;
  entries?: Record<string, EntryNotes>;
  notUsed?: unknown;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** The raw catalogue with the notes mixed in; unchanged without notes. Problems with the notes go to `errors`. */
export function withEditorial(raw: unknown, notes: unknown, errors: string[] = []): unknown {
  if (notes === undefined || !isObj(raw) || !Array.isArray(raw.entries)) return raw;
  if (!isObj(notes) || notes.format !== 1) {
    errors.push('Notizen der Redaktion: Format 1 erwartet');
    return raw;
  }
  const byId = isObj(notes.entries) ? notes.entries : {};
  const ids = new Set<string>();
  const entries = raw.entries.map((e: unknown) => {
    if (!isObj(e) || typeof e.id !== 'string') return e;
    ids.add(e.id);
    const n = byId[e.id];
    if (!isObj(n)) return e;
    const out: Record<string, unknown> = { ...e };
    if (n.internal !== undefined) out.internal = n.internal;
    if (n.permission !== undefined) out.permission = n.permission;
    if (n.openChecks !== undefined) out.openChecks = n.openChecks;
    if (n.reviewBy !== undefined && isObj(e.review)) out.review = { ...e.review, by: n.reviewBy };
    // Only a status that keeps the entry out of the list: the notes never publish anything.
    if (typeof n.status === 'string' && n.status !== 'active' && e.status !== 'active') out.status = n.status;
    return out;
  });
  for (const id of Object.keys(byId)) if (!ids.has(id)) errors.push(`Notizen der Redaktion: ${id} gehört zu keinem Eintrag im Katalog`);
  return { ...raw, entries, ...(notes.notUsed !== undefined ? { notUsed: notes.notUsed } : {}) };
}
