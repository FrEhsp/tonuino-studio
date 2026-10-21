/**
 * The album's cover after "Auf die SD-Karte übertragen" (TODO #84, Frank
 * 17.10.2026: folder 50 "hat noch kein Cover", although the review showed
 * the cover from its file). The cover goes in also where the catalog still
 * names a picture the card no longer has, and a cover that cannot be stored
 * is said on the done screen instead of being dropped without a word.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { card, platform, settings } from '../../src/app/state';
import { createBrowserAudioBackend } from '../../src/core/audio';
import type { DraftTrack } from '../../src/core/library/grouping';
import { newCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { doneNotes, resetImport, runImport, session, type ImportAlbum } from '../../src/features/add/session';
import { memDir, memSource, type MemTree } from '../../src/platform/memory';
import type { Platform } from '../../src/platform/types';
import { fakeWebCodecs } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { monoMp3 } from '../audio/fixtures';
import { tinyJpeg } from '../stickers/fixtures';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });
const defaults = settings.value;
const g = globalThis as { createImageBitmap?: unknown };
const before = g.createImageBitmap;

async function useCard(tree: MemTree = {}, catalog: Catalog = newCatalog()) {
  const root = memDir(tree);
  platform.value = { kind: 'web', os: 'linux', audio, volumes: { info: async () => ({}) } } as unknown as Platform;
  card.value = { volume: { id: 'sd', label: 'SD', root, info: {}, canEject: false }, status: 'ready', scan: await scanSd(root), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
  resetImport();
  return root;
}

function album(target: number): ImportAlbum {
  const tracks: DraftTrack[] = [{ source: memSource('Bibi & Tina - Das Kürbisfest (Folge 50).mp3', monoMp3()), info: { codec: 'mp3', durationSec: 12 }, title: 'Das Kürbisfest' }];
  return { id: 'a', title: 'Bibi & Tina - Das Kürbisfest (Folge 50)', kind: 'hoerspiel', tracks, split: 'none', splitMinutes: 5, target, append: false, cover: { data: tinyJpeg(), mimeType: 'image/jpeg' } };
}

beforeEach(() => {
  settings.value = { ...defaults, normalizeLoudness: false };
  // The picture decodes (8 × 5 px); a small JPEG is kept as it is.
  g.createImageBitmap = async () => ({ width: 8, height: 5, close: () => undefined });
});

afterEach(() => {
  settings.value = defaults;
  g.createImageBitmap = before;
});

describe('the cover of an added album', { timeout: 30_000 }, () => {
  it('goes with the album into its new folder', async () => {
    await useCard({});
    session.value = { phase: 'review', rejected: [], albums: [album(50)] };
    await runImport();
    const entry = card.value!.catalog!.folders['50'];
    expect(entry.cover).toBe('50.jpg');
    expect(card.value!.covers.get('50.jpg')).toEqual(tinyJpeg());
    expect(session.value.result?.notes?.filter((n) => n.kind === 'cover')).toEqual([]);
  });

  it('goes in where the catalog still names a picture that is no longer on the card', async () => {
    // Folder 50 was deleted outside the app: its entry and the name of its cover stayed in the catalog.
    const c = newCatalog();
    c.folders['50'] = { title: 'Alt', tracks: [], cover: '50.png', addedAt: 1, updatedAt: 1 };
    await useCard({}, c);
    session.value = { phase: 'review', rejected: [], albums: [album(50)] };
    await runImport();
    expect(card.value!.catalog!.folders['50'].cover).toBe('50.jpg');
    expect(card.value!.covers.has('50.jpg')).toBe(true);
  });

  it('is said on the done screen when it cannot be stored', async () => {
    g.createImageBitmap = async () => {
      throw new Error('broken');
    };
    await useCard({});
    session.value = { phase: 'review', rejected: [], albums: [album(50)] };
    await runImport();
    // The tracks are there all the same.
    expect(card.value!.catalog!.folders['50'].tracks).toHaveLength(1);
    expect(card.value!.catalog!.folders['50'].cover).toBeUndefined();
    const notes = doneNotes(session.value.result!);
    expect(notes).toEqual([
      {
        text: 'Das Cover von „Bibi & Tina - Das Kürbisfest (Folge 50)“ konnte ich nicht speichern, Ordner 50 hat darum noch keins. Das Bild lässt sich nicht öffnen. Nimm ein JPG- oder PNG-Bild. Du kannst es auf der Seite des Ordners noch einmal festlegen.',
        folder: 50,
      },
    ]);
  });
});
