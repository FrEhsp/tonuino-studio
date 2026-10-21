import { dropPictureTweaks, type Catalog, type StickerTweaks } from './catalog';

/**
 * Sticker changes to a remembered box, made without its SD card (Frank,
 * 17.10.2026: „Was hat das für einen Sinn, dass ich ohne SD Karte nicht die
 * Karten anpassen kann“): a sticker's text, colour, section and orientation,
 * and new covers. They are kept on this device with the memory, shown at
 * once, and go onto the card the next time it is open; a folder changed on
 * the card after them (on another computer) keeps what the card says.
 */

/** A sticker as "Sticker anpassen" leaves it: the whole look, not a difference. */
export interface WaitingLook {
  sticker?: StickerTweaks;
  color?: string;
  at: number;
}

/** A new cover (or none: data null) for a folder, as CoverChange. */
export interface WaitingCover {
  data: Uint8Array | null;
  mimeType?: string;
  source?: string;
  orientation?: StickerTweaks['orientation'];
  at: number;
}

export interface WaitingChanges {
  /** By folder name ("05"). */
  looks: Record<string, WaitingLook>;
  /** By the further card's id (ExtraCard.id). */
  extras: Record<string, WaitingLook>;
  /** By folder name. */
  covers: Record<string, WaitingCover>;
}

export function noWaiting(): WaitingChanges {
  return { looks: {}, extras: {}, covers: {} };
}

export function hasWaiting(w: WaitingChanges): boolean {
  return Object.keys(w.looks).length + Object.keys(w.extras).length + Object.keys(w.covers).length > 0;
}

/** What was kept, read leniently: anything unreadable counts as nothing waiting. */
export function parseWaiting(raw: unknown): WaitingChanges {
  const out = noWaiting();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof WaitingChanges, unknown>>;
  const looks = (v: unknown, into: Record<string, WaitingLook>) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const l = x as Partial<WaitingLook> | null;
      if (l && typeof l.at === 'number') into[k] = { sticker: l.sticker && typeof l.sticker === 'object' ? l.sticker : undefined, color: typeof l.color === 'string' ? l.color : undefined, at: l.at };
    }
  };
  looks(r.looks, out.looks);
  looks(r.extras, out.extras);
  if (r.covers && typeof r.covers === 'object') {
    for (const [k, x] of Object.entries(r.covers as Record<string, unknown>)) {
      const c = x as Partial<WaitingCover> | null;
      if (c && typeof c.at === 'number' && (c.data === null || c.data instanceof Uint8Array)) out.covers[k] = { ...c, data: c.data, at: c.at };
    }
  }
  return out;
}

/** The name a waiting cover has among the remembered box's pictures (RememberedView.coverUrls). */
export function waitingCoverEntry(folder: string, mimeType = 'image/jpeg'): string {
  return `wartet-${folder}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
}

/** The remembered catalog as it looks with the changes waiting for the card. */
export function withWaiting(catalog: Catalog, w: WaitingChanges): Catalog {
  const c = structuredClone(catalog);
  for (const [name, cover] of Object.entries(w.covers)) {
    const f = c.folders[name];
    if (!f) continue;
    if (cover.data || f.cover) dropPictureTweaks(f);
    if (cover.data && cover.orientation) f.sticker = { ...f.sticker, orientation: cover.orientation };
    f.cover = cover.data ? waitingCoverEntry(name, cover.mimeType) : undefined;
    f.coverSource = cover.data ? cover.source : undefined;
  }
  applyLooks(c, w);
  return c;
}

/**
 * Puts the waiting looks into a catalog; returns how many. With `since`
 * (a folder's or card's last change on the card), a look older than that
 * change, or older than a new cover of its folder, stays out.
 */
export function applyLooks(c: Catalog, w: WaitingChanges, since?: (folder: string) => number): number {
  let n = 0;
  for (const [name, look] of Object.entries(w.looks)) {
    const f = c.folders[name];
    const cover = w.covers[name];
    if (!f || (cover && cover.at > look.at) || (since && since(name) > look.at)) continue;
    f.sticker = look.sticker;
    f.color = look.color;
    if (since) f.updatedAt = Math.max(f.updatedAt ?? 0, look.at);
    n++;
  }
  for (const [id, look] of Object.entries(w.extras)) {
    const i = c.extraCards.findIndex((x) => x.id === id);
    if (i < 0) continue;
    const next = { ...c.extraCards[i], sticker: look.sticker, color: look.color };
    if (!look.sticker) delete next.sticker;
    if (!look.color) delete next.color;
    c.extraCards[i] = next;
    n++;
  }
  return n;
}
