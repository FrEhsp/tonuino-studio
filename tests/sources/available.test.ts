/**
 * The menu item "Entdecken" and its tip on "Hinzufügen" follow
 * sourcesAvailable: only a build that offers "Entdecken"
 * (`__SOURCES_ENABLED__`) and can load the list shows them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../src/platform/types';

const WEB_ORIGIN = 'https://studio.example.de';

async function availableIn(enabled: boolean, kind: 'web' | 'desktop', env: Record<string, string> = {}, bundled = false): Promise<boolean> {
  vi.resetModules();
  vi.stubGlobal('__SOURCES_ENABLED__', enabled);
  vi.stubGlobal('__SOURCES_BUNDLED__', bundled);
  vi.stubGlobal('location', new URL(`${WEB_ORIGIN}/`));
  vi.stubEnv('VITE_SOURCES_INDEX_URL', '');
  vi.stubEnv('VITE_WEB_ORIGIN', '');
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const { platform } = await import('../../src/app/state');
  const { sourcesAvailable } = await import('../../src/features/sources/state');
  platform.value = { kind } as Platform;
  return sourcesAvailable.value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Loads the pages of the app once: quick alone, several seconds while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('"Entdecken" in the menu and on "Hinzufügen"', SLOW, () => {
  it('shows in a build that offers it', async () => {
    expect(await availableIn(true, 'web')).toBe(true);
    expect(await availableIn(true, 'desktop', { VITE_WEB_ORIGIN: WEB_ORIGIN })).toBe(true);
  });

  it('stays hidden in a build without it, whatever the settings', async () => {
    expect(await availableIn(false, 'web')).toBe(false);
    expect(await availableIn(false, 'web', { VITE_SOURCES_INDEX_URL: '/quellen/index-preview.json' })).toBe(false);
    expect(await availableIn(false, 'desktop', { VITE_WEB_ORIGIN: WEB_ORIGIN })).toBe(false);
  });

  it('stays hidden in a desktop app that has no list and cannot load one', async () => {
    expect(await availableIn(true, 'desktop')).toBe(false);
    expect(await availableIn(true, 'desktop', { VITE_WEB_ORIGIN: 'http://studio.example.de' })).toBe(false);
  });

  it('shows in a desktop app that brings its list, also without an address for a newer one', async () => {
    expect(await availableIn(true, 'desktop', {}, true)).toBe(true);
    const { canUpdateList } = await import('../../src/features/sources/state');
    expect(canUpdateList.value).toBe(false);
  });
});
