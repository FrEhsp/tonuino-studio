import { beforeEach, describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, DAY_MS, dismissUpdate, parseRelease, pendingUpdate, releasesHost, setUpdateCheck, updateCheck, updateCheckOffered } from '../../src/app/updatecheck';

const URL_ = 'https://api.github.com/repos/beispiel/tonuino-studio/releases/latest';
const answer = (body: unknown, ok = true) => async () => ({ ok, json: async () => body }) as Response;

describe('Neue Version da', () => {
  beforeEach(() => setUpdateCheck(false));

  it('is offered only in the desktop app of a build with an https list', () => {
    expect(updateCheckOffered('desktop', URL_)).toBe(true);
    expect(updateCheckOffered('web', URL_)).toBe(false);
    expect(updateCheckOffered('desktop', '')).toBe(false);
    expect(updateCheckOffered('desktop', 'http://example.org/x')).toBe(false);
    expect(releasesHost(URL_)).toBe('api.github.com');
  });

  it('compares versions like semver', () => {
    expect(compareVersions('0.10.0', '0.9.2')).toBe(1);
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.4.0-beta.1', '0.4.0')).toBe(-1);
    expect(compareVersions('0.3', '0.3.1')).toBe(-1);
  });

  it('reads a GitHub release, a list of them, or a plain answer', () => {
    expect(parseRelease({ tag_name: 'v0.4.0', html_url: 'https://github.com/x/releases/tag/v0.4.0' })).toEqual({ version: '0.4.0', url: 'https://github.com/x/releases/tag/v0.4.0' });
    expect(
      parseRelease([
        { tag_name: 'v0.5.0', html_url: 'https://g/5', prerelease: true },
        { tag_name: 'v0.4.1', html_url: 'https://g/41' },
        { tag_name: 'v0.4.0', html_url: 'https://g/40' },
        { tag_name: 'v0.6.0', html_url: 'https://g/6', draft: true },
      ]),
    ).toEqual({ version: '0.4.1', url: 'https://g/41' });
    expect(parseRelease({ version: '1.0.0', url: 'https://example.org/' })).toEqual({ version: '1.0.0', url: 'https://example.org/' });
    expect(parseRelease({ version: '1.0.0', url: 'javascript:alert(1)' })).toBeUndefined();
    expect(parseRelease('nein')).toBeUndefined();
  });

  it('asks nobody while switched off', async () => {
    let asked = 0;
    await checkForUpdate({ url: URL_, fetch: async () => (asked++, answer({})()) });
    expect(asked).toBe(0);
  });

  it('asks at most once a day and shows a newer version until closed', async () => {
    setUpdateCheck(true);
    let asked = 0;
    const fetch = async () => {
      asked++;
      return answer({ tag_name: 'v9.0.0', html_url: 'https://g/9' })();
    };
    await checkForUpdate({ url: URL_, fetch, now: () => 1000 });
    await checkForUpdate({ url: URL_, fetch, now: () => 1000 + DAY_MS - 1 });
    expect(asked).toBe(1);
    expect(pendingUpdate(updateCheck.value, '0.3.0')).toEqual({ version: '9.0.0', url: 'https://g/9' });
    expect(pendingUpdate(updateCheck.value, '9.0.0')).toBeNull();
    dismissUpdate('9.0.0');
    expect(pendingUpdate(updateCheck.value, '0.3.0')).toBeNull();
    await checkForUpdate({ url: URL_, fetch, now: () => 1000 + DAY_MS });
    expect(asked).toBe(2);
  });

  it('stays quiet when offline, and forgets everything when switched off', async () => {
    setUpdateCheck(true);
    await checkForUpdate({ url: URL_, fetch: async () => Promise.reject(new Error('offline')), now: () => 5 });
    expect(updateCheck.value).toMatchObject({ on: true, lastCheck: 5 });
    expect(updateCheck.value.latest).toBeUndefined();
    setUpdateCheck(false);
    expect(updateCheck.value).toEqual({ on: false });
  });
});
