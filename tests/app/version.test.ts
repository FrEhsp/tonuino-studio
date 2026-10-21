import { describe, expect, it } from 'vitest';
import { runsAs } from '../../src/app/version';

describe('runsAs', () => {
  it('names the browser mode next to the version', () => {
    expect(runsAs(null)).toBe('Web-App im Browser');
    expect(runsAs({ kind: 'web', os: 'linux', capabilities: { sd: true, sdPackage: false } })).toBe('Web-App im Browser');
    // Firefox and Safari: the card gets its files through Pakete.
    expect(runsAs({ kind: 'web', os: 'macos', capabilities: { sd: false, sdPackage: true } })).toBe('Web-App im Browser (Karte über Pakete)');
    expect(runsAs({ kind: 'web', os: 'other', capabilities: { sd: false, sdPackage: false } })).toBe('Web-App im Browser');
    expect(runsAs({ kind: 'desktop', os: 'windows', capabilities: { sd: true, sdPackage: false } })).toBe('Desktop-App für Windows');
    // The Android app is the Tauri app on a phone.
    expect(runsAs({ kind: 'desktop', os: 'other', mobile: true, capabilities: { sd: false, sdPackage: false } })).toBe('App für Android');
  });
});
