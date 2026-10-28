import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script without types (scripts/updater-latest.mjs)
import { githubName, latestJson, platformsOf } from '../../scripts/updater-latest.mjs';

const BASE = 'https://github.com/FrEhsp/tonuino-studio/releases/download/v0.6.0/';

describe('latest.json for the updater', () => {
  it('names the systems each file updates', () => {
    expect(platformsOf('TonUINO Studio_0.6.0_amd64.AppImage')).toEqual(['linux-x86_64', 'linux-x86_64-appimage']);
    expect(platformsOf('TonUINO Studio_0.6.0_x64-setup.exe')).toEqual(['windows-x86_64', 'windows-x86_64-nsis']);
    expect(platformsOf('TonUINO Studio.app.tar.gz')).toContain('darwin-aarch64');
    // The .deb and the Android app do not update through Tauri.
    expect(platformsOf('TonUINO Studio_0.6.0_amd64.deb')).toEqual([]);
    expect(platformsOf('TonUINO-Studio_0.6.0.apk')).toEqual([]);
  });

  it('writes the addresses GitHub gives the files', () => {
    const json = latestJson({
      version: '0.6.0',
      base: BASE,
      notes: 'Neu',
      date: new Date('2026-11-03T08:00:00.123Z'),
      files: [
        { name: 'TonUINO Studio_0.6.0_amd64.AppImage', signature: 'c2lnLWxpbnV4\n' },
        { name: 'TonUINO Studio_0.6.0_x64-setup.exe', signature: 'c2lnLXdpbg==' },
      ],
    });
    expect(json.pub_date).toBe('2026-11-03T08:00:00Z');
    expect(json.platforms['linux-x86_64']).toEqual({ signature: 'c2lnLWxpbnV4', url: `${BASE}TonUINO.Studio_0.6.0_amd64.AppImage` });
    expect(json.platforms['windows-x86_64-nsis'].url).toBe(`${BASE}TonUINO.Studio_0.6.0_x64-setup.exe`);
    expect(githubName('a b c.exe')).toBe('a.b.c.exe');
  });

  it('refuses what would break updates', () => {
    expect(() => latestJson({ version: 'neu', base: BASE, files: [] })).toThrow(/Keine Version/);
    expect(() => latestJson({ version: '0.6.0', base: 'http://x/', files: [] })).toThrow(/https/);
    expect(() => latestJson({ version: '0.6.0', base: BASE, files: [{ name: 'a.deb', signature: 'x' }] })).toThrow(/keine Updates/);
    expect(() => latestJson({ version: '0.6.0', base: BASE, files: [{ name: 'a.AppImage', signature: ' ' }] })).toThrow(/leer/);
  });

  it('matches the endpoint the app asks', () => {
    const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    const updater = conf.plugins.updater;
    expect(updater.endpoints).toEqual(['https://github.com/FrEhsp/tonuino-studio/releases/latest/download/latest.json']);
    // The key itself is made by the owner (docs/BUILD.md); never a private key in the repository.
    expect(updater.pubkey).toMatch(/^PLATZHALTER|^dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk/);
    expect(JSON.stringify(conf)).not.toMatch(/secret key|PRIVATE/i);
    // Signed update files only with the key, so a build without it still works.
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
  });
});
