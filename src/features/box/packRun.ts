/**
 * Packs a series on the open card (core/tonuino/pack.ts): the covers of the
 * episodes first, then folder by folder with the catalog written after
 * each one, at the end the old folders' covers go and the card is read
 * again. A card written directly gets copies that are checked; a snapshot
 * of the web app (Paket) moves its files, they reach the card with the
 * next Paket like every other change. When the target's own episode is not
 * the first, the folder is put into the order of the episodes afterwards,
 * the way the folder page saves a new order (planReorder, runRepair), and
 * the cards follow their tracks.
 */
import { signal } from '@preact/signals';
import type { Catalog } from '../../core/tonuino/catalog';
import { applyArrival, applyRemoval, coversToDrop, remapCards, reorderList, runPack, type PackPlan, type PackProgress, type PackRunResult } from '../../core/tonuino/pack';
import { planReorder } from '../../core/tonuino/repair';
import { REORDER_DONE_MARKER } from '../../core/tonuino/sd';
import { card, changeCovers, rescan, runRepair, settings, updateCatalog } from '../../app/state';
import { writeGuard } from '../../app/writeguard';

/** What a run did, for the dialog and the line under "Platz auf der Karte". */
export interface PackOutcome extends PackRunResult {
  /** Ids of the cards to write anew: the episodes' and the ones that went along with their tracks. */
  cards: string[];
}

/** The last packing in this visit: "Meine Box" offers its cards until they were opened. */
export const packedSeries = signal<{ catalogId: string; title: string; target: number; cards: string[] } | null>(null);

/** A catalog change that has to reach the card: the old folder may only go once its tracks are noted. */
async function note(mutate: (c: Catalog) => void): Promise<void> {
  let ran = false;
  await updateCatalog((c) => {
    mutate(c);
    ran = true;
  });
  if (!ran) throw new Error('Inzwischen ist eine andere Karte geöffnet. Deshalb hab ich hier aufgehört.');
}

export async function packOnCard(plan: PackPlan, opts: { signal?: AbortSignal; onProgress?: (p: PackProgress) => void; onOrder?: () => void } = {}): Promise<PackOutcome> {
  const s = card.value;
  if (!s?.scan) throw new Error('Es ist keine Karte geöffnet.');
  const members = plan.groups.flatMap((g) => g.members);
  // The episodes' covers under names of their own first: a card never points at a picture that is not there yet.
  const coverReady = await changeCovers((covers) => {
    for (const m of members) {
      const bytes = m.cover && covers.get(m.cover.from);
      if (m.cover && bytes) covers.set(m.cover.to, bytes);
    }
  }).catch(() => false);
  const cards: string[] = [];
  const result = await writeGuard.during('tracks', () =>
    runPack(s.volume.root, plan, {
      how: s.volume.access === 'snapshot' ? 'move' : 'copy',
      signal: opts.signal,
      onProgress: opts.onProgress,
      arrived: async (group, member, first) => {
        let ids: string[] = [];
        await note((c) => {
          ids = applyArrival(c, group, member, { first, coverReady });
        });
        cards.push(...ids);
      },
      removed: async (_group, member) => note((c) => applyRemoval(c, member)),
    }),
  );
  const packed = result.packed.map((x) => x.member);
  const gone = new Set(packed.filter((m) => !result.stuck.includes(m.number)).map((m) => m.number));
  // The old folders' pictures went to their episodes; copies no card took (a run that stopped early) go again.
  const used = new Set(card.value?.catalog?.extraCards.map((x) => x.cover));
  const unused = members.flatMap((m) => (m.cover && !used.has(m.cover.to) ? [m.cover.to] : []));
  await changeCovers((covers) => {
    for (const e of coversToDrop(packed.filter((m) => gone.has(m.number)))) covers.delete(e);
    for (const e of unused) covers.delete(e);
  }).catch(() => undefined);
  let scan = await rescan().catch(() => undefined);
  const targets = [...new Set(result.packed.map((x) => x.group.target))];
  if (scan && targets.length) await updateCatalog(() => undefined, { touchFolders: targets }).catch(() => undefined);
  // The episodes into their order, also after a run that stopped: what arrived is in the right place then.
  for (const group of plan.groups) {
    if (!group.reorder || !result.packed.some((x) => x.group === group)) continue;
    const folder = scan?.folders.find((f) => f.number === group.target);
    const list = folder && reorderList(group, folder);
    if (!folder || !list) continue;
    opts.onOrder?.();
    const why = 'Die Folgen stehen noch nicht in der richtigen Reihenfolge. Das kannst du auf der Seite des Ordners nachholen.';
    const reorder = planReorder(folder, list, { pureNumbers: settings.value.pureNumbers, tempDirs: scan?.tempDirs });
    if (reorder.leftovers.length) {
      result.error ??= `${why} ${reorder.leftovers[0]}`;
      continue;
    }
    try {
      const run = await runRepair(reorder, { kind: 'order', folders: () => [group.target] });
      scan = run.scan ?? scan;
      // The new numbers count once the folder was emptied and made again (see planReorder): from then on the cards follow.
      if (run.done.some((x) => x.op === 'mkdir' && x.path[1] === REORDER_DONE_MARKER)) {
        await note((c) => {
          cards.push(...remapCards(c, group.target, list));
        });
      }
      if (run.result.error) result.error ??= `${why} ${run.result.error.message}`;
    } catch (e) {
      result.error ??= `${why} ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const catalogId = card.value?.catalog?.id;
  if (catalogId && cards.length) packedSeries.value = { catalogId, title: plan.groups[0]?.title ?? plan.name, target: plan.groups[0]?.target ?? 0, cards: [...new Set(cards)] };
  return { ...result, cards: [...new Set(cards)] };
}
