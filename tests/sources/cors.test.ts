import { describe, expect, it } from 'vitest';
import { appOrigins, chainHostProblem, chainReachedFile, checkChain, deliveryFromChain, DESKTOP_ORIGINS, isMeasurementHost, stableVerdict, type Hop } from '../../src/core/sources/cors';
import { corsFixtures, ORIGINS } from './sample';

describe('CORS chains from the fixtures', () => {
  for (const { file, fx } of corsFixtures()) {
    it(`${file}: ${fx.expect}`, () => {
      if (fx.expect === 'rejected') {
        expect(fx.hops!.slice(0, -1).some((h) => isMeasurementHost(new URL(h.url).hostname))).toBe(true);
        return;
      }
      if (fx.expect === 'unverified' || fx.expect === 'unstable') {
        // Only a host root or changing answers were observed: never 'direct' on that basis.
        expect(fx.kind === 'partial' || !fx.hops).toBe(true);
        return;
      }
      const { delivery, failures } = deliveryFromChain(fx.hops!, ORIGINS);
      expect(delivery, failures.join('; ')).toBe(fx.expect);
    });
  }
});

describe('checkChain', () => {
  const redirect = (acao: string | undefined, to = 'https://b.example/x') => ({
    status: 302,
    url: 'https://a.example/x',
    headers: { location: to, ...(acao ? { 'access-control-allow-origin': acao } : {}) },
  });

  it('an echo after a cross-origin redirect works for the desktop origin (Origin becomes "null")', () => {
    expect(checkChain([redirect('*'), { status: 200, url: 'https://b.example/x', headers: { 'access-control-allow-origin': '<echo>' } }], 'tauri://localhost')).toEqual({ ok: true });
  });

  it('a fixed origin fails after a cross-origin redirect', () => {
    const r = checkChain([redirect('*'), { status: 200, url: 'https://b.example/x', headers: { 'Access-Control-Allow-Origin': 'https://studio.example.de' } }], 'https://studio.example.de');
    expect(r).toEqual({ ok: false, hop: 1, reason: 'erlaubt nur https://studio.example.de, gesendet wurde null' });
  });

  it('a redirect without the header stops the browser before the file', () => {
    expect(checkChain([redirect(undefined), { status: 200, url: 'https://b.example/x', headers: { 'access-control-allow-origin': '*' } }], 'https://studio.example.de')).toMatchObject({ ok: false, hop: 0 });
  });

  it('a redirect to plain http fails', () => {
    expect(checkChain([redirect('*', 'http://b.example/x'), { status: 200, url: 'http://b.example/x', headers: { 'access-control-allow-origin': '*' } }], 'https://studio.example.de')).toMatchObject({ ok: false, reason: 'Weiterleitung ohne HTTPS (http:)' });
  });

  it('an empty chain is no answer', () => {
    expect(checkChain([], 'https://studio.example.de')).toMatchObject({ ok: false });
  });

  it('counts a check only when the chain reached a file', () => {
    expect(chainReachedFile([{ status: 200, url: 'https://a.example/x', headers: {} }])).toBe(true);
    expect(chainReachedFile([{ status: 404, url: 'https://a.example/x', headers: {} }])).toBe(false);
    expect(chainReachedFile([redirect('*')])).toBe(false);
  });
});

describe('origins, stability and measurement hosts', () => {
  it('checks the web origin and all desktop WebView origins', () => {
    expect(appOrigins('https://studio.example.de/app/')).toEqual(['https://studio.example.de', ...DESKTOP_ORIGINS]);
    expect(DESKTOP_ORIGINS).toEqual(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
  });

  it('a verdict that changed since the last run is unstable', () => {
    expect(stableVerdict(undefined, 'direct')).toBe('direct');
    expect(stableVerdict('direct', 'direct')).toBe('direct');
    expect(stableVerdict('direct', 'browser')).toBe('unstable');
    expect(stableVerdict('browser', 'direct')).toBe('unstable');
  });

  it('recognises measurement hosts and their subdomains', () => {
    expect(isMeasurementHost('www.podtrac.com')).toBe(true);
    expect(isMeasurementHost('dts.podtrac.com')).toBe(true);
    expect(isMeasurementHost('pdst.fm')).toBe(true);
    expect(isMeasurementHost('op3.dev')).toBe(true);
    expect(isMeasurementHost('audio.podigee-cdn.net')).toBe(false);
    expect(isMeasurementHost('notpodtrac.com')).toBe(false);
  });
});

describe('chainHostProblem', () => {
  const hop = (url: string, location?: string): Hop => ({ status: location ? 302 : 200, url, headers: location ? { Location: location } : {} });
  it('accepts a chain that stays on the allowed hosts or below them', () => {
    expect(chainHostProblem([hop('https://archive.org/download/x/a.mp3', 'https://ia800300.us.archive.org/1/items/x/a.mp3'), hop('https://ia800300.us.archive.org/1/items/x/a.mp3')], ['archive.org'])).toBeUndefined();
  });

  it('names a measurement service or a foreign host anywhere in the chain, also as the last redirect target', () => {
    expect(chainHostProblem([hop('https://media.example/a.mp3', 'https://op3.dev/e/media.example/a.mp3')], ['media.example'])).toBe('Weiterleitung über den Messdienst op3.dev');
    expect(chainHostProblem([hop('https://media.example/a.mp3', 'https://cdn.other.example/a.mp3'), hop('https://cdn.other.example/a.mp3')], ['media.example'])).toBe(
      'Weiterleitung zu cdn.other.example, der für diesen Eintrag nicht erlaubt ist',
    );
  });
});
