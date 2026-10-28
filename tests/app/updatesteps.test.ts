import { describe, expect, it } from 'vitest';
import { parseRelease, type Release } from '../../src/app/updatecheck';
import { canSelfUpdate, installKind, pickAsset, updateSteps, type InstallKind } from '../../src/app/updatesteps';
import { installNewest, type DownloadEvent } from '../../src/platform/tauri/updater';

/** A GitHub release as api.github.com answers, with the files the build scripts and mac.yml make. */
const GITHUB = {
  tag_name: 'v0.6.0',
  html_url: 'https://github.com/FrEhsp/tonuino-studio/releases/tag/v0.6.0',
  assets: [
    'TonUINO Studio_0.6.0_amd64.deb',
    'TonUINO Studio_0.6.0_amd64.AppImage',
    'TonUINO Studio_0.6.0_amd64.AppImage.sig',
    'TonUINO Studio_0.6.0_x64-setup.exe',
    'TonUINO Studio_0.6.0_x64-setup.exe.sig',
    'TonUINO Studio_0.6.0_universal.dmg',
    'TonUINO Studio_universal.app.tar.gz',
    'TonUINO Studio_universal.app.tar.gz.sig',
    'TonUINO-Studio_0.6.0.apk',
    'latest.json',
  ].map((name) => ({ name, browser_download_url: `https://github.com/FrEhsp/tonuino-studio/releases/download/v0.6.0/${encodeURIComponent(name)}` })),
};

describe('what to do with a new version', () => {
  const release = parseRelease(GITHUB)!;

  it('reads the files of a GitHub release', () => {
    expect(release.version).toBe('0.6.0');
    expect(release.assets).toHaveLength(10);
    expect(parseRelease({ ...GITHUB, assets: [{ name: 'x.exe', browser_download_url: 'http://unsicher/x.exe' }] })!.assets).toBeUndefined();
  });

  it('knows how the app was installed', () => {
    expect(installKind({ os: 'windows', bundle: 'nsis' })).toBe('windows');
    expect(installKind({ os: 'linux', bundle: 'deb' })).toBe('deb');
    expect(installKind({ os: 'linux', bundle: 'appimage' })).toBe('appimage');
    expect(installKind({ os: 'macos', bundle: 'app' })).toBe('mac');
    expect(installKind({ os: 'other', mobile: true, bundle: null })).toBe('android');
    // Built by hand, no bundle: the system at least.
    expect(installKind({ os: 'windows', bundle: null })).toBe('windows');
    expect(installKind({ os: 'linux', bundle: null })).toBe('other');
    expect(['windows', 'mac', 'appimage'].every((k) => canSelfUpdate(k as InstallKind))).toBe(true);
    expect(['deb', 'android', 'msi', 'rpm', 'other'].some((k) => canSelfUpdate(k as InstallKind))).toBe(false);
  });

  it('offers the file for this system, never a signature or an update archive', () => {
    const name = (k: InstallKind) => pickAsset(k, release.assets)?.name;
    expect(name('windows')).toBe('TonUINO Studio_0.6.0_x64-setup.exe');
    expect(name('deb')).toBe('TonUINO Studio_0.6.0_amd64.deb');
    expect(name('appimage')).toBe('TonUINO Studio_0.6.0_amd64.AppImage');
    expect(name('mac')).toBe('TonUINO Studio_0.6.0_universal.dmg');
    expect(name('android')).toBe('TonUINO-Studio_0.6.0.apk');
    expect(name('rpm')).toBeUndefined();
    expect(name('other')).toBeUndefined();
  });

  it('says per system what to do', () => {
    const deb = updateSteps('deb', release, false);
    expect(deb.self).toBe(false);
    expect(deb.download.label).toBe('.deb-Paket herunterladen');
    expect(deb.command).toBe("sudo apt install ./'TonUINO Studio_0.6.0_amd64.deb'");
    expect(updateSteps('windows', release, false).steps.join(' ')).toMatch(/Trotzdem ausführen/);
    expect(updateSteps('mac', release, false).steps.join(' ')).toMatch(/Programme/);
    expect(updateSteps('appimage', release, false).steps.join(' ')).toMatch(/ausführbar/);
    expect(updateSteps('android', release, false).steps.join(' ')).toMatch(/Aktualisieren/);
    // Without the file for it, the release page.
    const plain: Release = { version: '0.6.0', url: 'https://example.org/releases' };
    expect(updateSteps('deb', plain, false).download).toEqual({ label: 'Zur Download-Seite', url: 'https://example.org/releases' });
  });

  it('updates by itself only where the build has the updater and Tauri can replace the app', () => {
    expect(updateSteps('windows', release, true).self).toBe(true);
    expect(updateSteps('appimage', release, true).self).toBe(true);
    expect(updateSteps('deb', release, true).self).toBe(false);
    expect(updateSteps('android', release, true).self).toBe(false);
    expect(updateSteps('windows', release, false).self).toBe(false);
  });
});

describe('the updater of the desktop app', () => {
  it('checks, loads with progress and installs through the plugin', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const channel = { onmessage: (_e: DownloadEvent) => undefined } as { onmessage: (e: DownloadEvent) => void };
    const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([cmd, args]);
      if (cmd === 'plugin:updater|check') return { rid: 7, currentVersion: '0.5.1', version: '0.6.0' } as T;
      channel.onmessage({ event: 'Started', data: { contentLength: 200 } });
      channel.onmessage({ event: 'Progress', data: { chunkLength: 50 } });
      channel.onmessage({ event: 'Progress', data: { chunkLength: 150 } });
      channel.onmessage({ event: 'Finished' });
      return undefined as T;
    };
    const progress: [number, number | undefined][] = [];
    const got = await installNewest((d, t) => progress.push([d, t]), invoke, () => channel as never);
    expect(got).toBe('0.6.0');
    expect(calls.map((c) => c[0])).toEqual(['plugin:updater|check', 'plugin:updater|download_and_install']);
    expect(calls[1][1]).toMatchObject({ rid: 7 });
    expect(progress.at(-1)).toEqual([200, 200]);
  });

  it('does nothing when there is no newer version', async () => {
    const invoke = async <T,>(): Promise<T> => null as T;
    expect(await installNewest(() => undefined, invoke, () => ({}) as never)).toBeNull();
  });
});
