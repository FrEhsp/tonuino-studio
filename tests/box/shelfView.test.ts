import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fresh module with this browser storage (shelfView.ts reads it once, on load). */
async function load(stored: Record<string, string>) {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.resetModules();
  return { mod: await import('../../src/features/box/shelfView'), store };
}

afterEach(() => vi.unstubAllGlobals());

describe('shelf view (#80)', () => {
  it('shows the covers when nothing was chosen', async () => {
    const { mod } = await load({});
    expect(mod.shelfView.value).toBe('cover');
    expect(mod.DEFAULT_VIEW).toBe('cover');
  });

  it('keeps a chosen view', async () => {
    const { mod } = await load({ 'tonuino-studio:regal-ansicht': 'liste' });
    expect(mod.shelfView.value).toBe('liste');
  });

  it('does not take the old "Sticker | Cover" choice or anything unknown', async () => {
    expect((await load({ 'tonuino-studio:regal-aussehen': 'karte' })).mod.shelfView.value).toBe('cover');
    expect((await load({ 'tonuino-studio:regal-ansicht': 'karte' })).mod.shelfView.value).toBe('cover');
  });

  it('remembers a new choice', async () => {
    const { mod, store } = await load({});
    mod.setShelfView('sticker');
    expect(mod.shelfView.value).toBe('sticker');
    expect(store.get('tonuino-studio:regal-ansicht')).toBe('sticker');
  });
});
