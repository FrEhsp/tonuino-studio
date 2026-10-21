/**
 * The sticker styles of 0.4: "Kassette" right after "Klassisch", "Hell" gone,
 * and a saved "Hell" (or anything else unknown) quietly becomes "Klassisch".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { knownStyle, STICKER_STYLES } from '../../src/core/stickers/layout';

const KEY = 'tonuino-studio:stickers';

function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

/** design.ts as it starts with this storage (it reads it once, when loaded). */
async function startWith(stored: unknown) {
  const storage = fakeStorage(stored === undefined ? {} : { [KEY]: JSON.stringify(stored) });
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
  const mod = await import('../../src/features/stickers/design');
  return { mod, storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the sticker styles', () => {
  it('offers Klassisch, then Kassette, and no Hell', () => {
    expect(STICKER_STYLES.slice(0, 2)).toEqual(['blur', 'tape']);
    expect(STICKER_STYLES).not.toContain('light');
    expect(knownStyle('tape')).toBe('tape');
    expect(knownStyle('light')).toBe('blur');
    expect(knownStyle(undefined)).toBe('blur');
    expect(knownStyle(42)).toBe('blur');
  });

  it('turns a saved "Hell" into "Klassisch" and saves it so, keeping the rest', async () => {
    const { mod, storage } = await startWith({ design: { style: 'light', font: 'comic', showTitle: true }, print: { templateId: 'card-a4', cutMarks: null } });
    expect(mod.design.value.style).toBe('blur');
    expect(mod.design.value.font).toBe('comic');
    expect(mod.design.value.showTitle).toBe(true);
    expect(mod.printSetup.value.templateId).toBe('card-a4');
    const saved = JSON.parse(storage.data.get(KEY)!);
    expect(saved.design.style).toBe('blur');
    expect(saved.design.font).toBe('comic');
    expect(saved.print.templateId).toBe('card-a4');
  });

  it('turns the stand-in wordmark "TonUINO" into the official logo, but keeps another wordmark', async () => {
    const { mod, storage } = await startWith({ design: { style: 'tape', logo: 'text', logoText: ' TonUINO ' }, print: { templateId: 'herma-5028', cutMarks: null } });
    expect(mod.design.value.logo).toBe('tonuino');
    expect(JSON.parse(storage.data.get(KEY)!).design.logo).toBe('tonuino');
    const other = await startWith({ design: { style: 'tape', logo: 'text', logoText: 'Emmas Box' }, print: { templateId: 'herma-5028', cutMarks: null } });
    expect(other.mod.design.value.logo).toBe('text');
  });

  it('leaves a known style and the storage alone', async () => {
    const stored = { design: { style: 'full' }, print: { templateId: 'herma-5028', cutMarks: null } };
    const { mod, storage } = await startWith(stored);
    expect(mod.design.value.style).toBe('full');
    expect(storage.data.get(KEY)).toBe(JSON.stringify(stored));
  });

  it('starts with Kassette when nothing is saved, and without storage at all', async () => {
    expect((await startWith(undefined)).mod.design.value.style).toBe('tape');
    vi.stubGlobal('localStorage', undefined);
    vi.resetModules();
    const mod = await import('../../src/features/stickers/design');
    expect(mod.design.value.style).toBe('tape');
  });
});
