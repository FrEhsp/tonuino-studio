/**
 * The download link of the desktop app: only a web build with an https
 * address (VITE_DESKTOP_DOWNLOAD_URL) shows it; without one nothing changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopDownloadUrl } from '../../src/features/help/desktopapp';

type Topics = typeof import('../../src/features/help/topics');

async function topicsOf(desktop: boolean, url?: string): Promise<Topics> {
  vi.resetModules();
  vi.stubGlobal('__DESKTOP_BUILD__', desktop);
  if (url !== undefined) vi.stubEnv('VITE_DESKTOP_DOWNLOAD_URL', url);
  return import('../../src/features/help/topics');
}

const downloadLinks = (t: Topics) => t.helpLinks().filter((l) => l.label === 'Desktop-App herunterladen');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('desktopDownloadUrl', () => {
  it('takes an https address', () => {
    expect(desktopDownloadUrl(' https://example.org/studio/download ')).toBe('https://example.org/studio/download');
  });

  it('takes nothing else', () => {
    expect(desktopDownloadUrl(undefined)).toBeUndefined();
    expect(desktopDownloadUrl('  ')).toBeUndefined();
    expect(desktopDownloadUrl('http://example.org/download')).toBeUndefined();
    expect(desktopDownloadUrl('example.org/download')).toBeUndefined();
    expect(desktopDownloadUrl('javascript:alert(1)')).toBeUndefined();
  });
});

describe('the help on the desktop app', () => {
  it('links the download in a web build with an address', async () => {
    const t = await topicsOf(false, 'https://example.org/studio/download');
    expect(downloadLinks(t)).toEqual([expect.objectContaining({ href: 'https://example.org/studio/download', topic: 'app', section: 'browser' })]);
  });

  it('links nothing without an address', async () => {
    expect(downloadLinks(await topicsOf(false))).toEqual([]);
    expect(downloadLinks(await topicsOf(false, 'http://example.org/download'))).toEqual([]);
  });

  it('links nothing in the desktop app itself', async () => {
    expect(downloadLinks(await topicsOf(true, 'https://example.org/studio/download'))).toEqual([]);
  });
});
