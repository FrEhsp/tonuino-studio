import { describe, expect, it } from 'vitest';
import { filterNotices, isLicenseFile, loadLicenseFile, type LicenseFile } from '../../src/features/help/licensefile';

const file: LicenseFile = {
  npm: [
    { name: 'preact', version: '11.0.0', license: 'MIT', texts: [0] },
    { name: 'mpg123-decoder', version: '1.0.3', license: 'MIT', authors: 'Ethan Halsall', texts: [] },
  ],
  rust: [{ name: 'serde', version: '1.0.0', license: 'MIT OR Apache-2.0', url: 'https://github.com/serde-rs/serde', texts: [0, 1] }],
  texts: ['MIT License …', 'Apache License …'],
};

function respond(status: number, body: string): typeof fetch {
  return async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

describe('licence file', () => {
  it('accepts what the build writes and refuses broken data', () => {
    expect(isLicenseFile(file)).toBe(true);
    expect(isLicenseFile(JSON.parse(JSON.stringify(file)))).toBe(true);
    expect(isLicenseFile(null)).toBe(false);
    expect(isLicenseFile({ npm: [], rust: [] })).toBe(false);
    expect(isLicenseFile({ ...file, npm: [{ name: 'x', version: '1', texts: [5] }] })).toBe(false);
    expect(isLicenseFile({ ...file, rust: [{ name: 'x', texts: [] }] })).toBe(false);
  });

  it('filters by package name, ignoring case', () => {
    expect(filterNotices(file.npm, ' MPG ').map((e) => e.name)).toEqual(['mpg123-decoder']);
    expect(filterNotices(file.npm, '')).toHaveLength(2);
  });

  it('loads the file, or says why not', async () => {
    expect(await loadLicenseFile(respond(200, JSON.stringify(file)), 'lizenzen.json')).toEqual({ kind: 'ok', file });
    // The dev server has no build output.
    expect(await loadLicenseFile(respond(404, ''), 'lizenzen.json')).toEqual({ kind: 'missing' });
    const broken = await loadLicenseFile(respond(200, '<!doctype html>'), 'lizenzen.json');
    expect(broken.kind === 'error' && broken.message).toContain('beschädigt');
    const server = await loadLicenseFile(respond(500, ''), 'lizenzen.json');
    expect(server.kind === 'error' && server.message).toContain('Fehler 500');
    const offline = await loadLicenseFile(async () => Promise.reject(new TypeError('Failed to fetch')), 'lizenzen.json');
    expect(offline.kind === 'error' && offline.message).toContain('versuche es noch einmal');
  });

  it('asks for JSON, so a dev server does not answer with the app page', async () => {
    let accept = '';
    await loadLicenseFile(async (_url, init) => {
      accept = new Headers(init?.headers).get('Accept') ?? '';
      return new Response('', { status: 404 });
    }, 'lizenzen.json');
    expect(accept).toBe('application/json');
  });
});
