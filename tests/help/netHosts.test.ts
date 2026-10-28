/**
 * „Internetfilter und Firewall“ (src/features/help/netHosts.ts): the help
 * names every address the app reaches, taken from the code that reaches it,
 * and the same lists as the desktop app's backend.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filterHostGroups, filterHostLines, SOURCES_LIST_HOSTS } from '../../src/features/help/netHosts';
import { PROVIDERS } from '../../src/core/sources/providers';
import { SERVICE_HOSTS } from '../../src/core/covers/net';
import { blockTexts, findSection, parseInline, plainText, resolveHelp } from '../../src/features/help/topics';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const rust = (file: string) => readFileSync(join(ROOT, 'src-tauri', 'src', file), 'utf8');
/** The ("host", below) pairs of a Rust list. */
function rustHosts(src: string, name: string): string[] {
  const body = src.slice(src.indexOf(`pub const ${name}`));
  return [...body.slice(0, body.indexOf('];')).matchAll(/\("([^"]+)",\s*(true|false)\)/g)].map((m) => m[1]);
}

describe('what a web filter must let through', () => {
  const all = filterHostGroups({ sources: true, updates: 'github.com' }).flatMap((g) => g.hosts);

  it('names the addresses of every service, pictogram and download the app reaches', () => {
    for (const h of [
      'itunes.apple.com',
      'is1-ssl.mzstatic.com',
      'api.deezer.com',
      'cdn-images.dzcdn.net',
      'e-cdns-images.dzcdn.net',
      'musicbrainz.org',
      'coverartarchive.org',
      'archive.org',
      'api.arasaac.org',
      'static.arasaac.org',
      'tonuino.github.io',
      'gitlab.com',
      'github.com',
    ]) {
      expect(all, h).toContain(h);
    }
    for (const hosts of Object.values(SERVICE_HOSTS)) for (const h of hosts) expect(all).toContain(h);
  });

  it('names every host whose files „Entdecken“ plays or saves, and the pages the desktop app builds its list from', () => {
    for (const p of PROVIDERS) for (const h of p.fileHosts) expect(all, p.id).toContain(h);
    expect([...SOURCES_LIST_HOSTS].sort()).toEqual(rustHosts(rust('sources_net.rs'), 'ALLOWED_HOSTS').sort());
  });

  it('covers every host the desktop app may ask for covers', () => {
    for (const h of rustHosts(rust('cover_net.rs'), 'COVER_HOSTS')) {
      expect(all.some((a) => a === h || a.endsWith(`.${h}`) || a === `*.${h}`), h).toBe(true);
    }
  });

  it('leaves out „Entdecken“ and new versions where the build has none', () => {
    const plain = filterHostGroups({ sources: false }).map((g) => g.what);
    expect(plain.some((w) => w.startsWith('Entdecken'))).toBe(false);
    expect(plain).not.toContain('Neue Versionen');
  });

  it('stands in the help under „Datenschutz“, found by „Firewall“ and „Webfilter“', () => {
    const texts = findSection('datenschutz')!.section.blocks.flatMap(blockTexts).join('\n');
    expect(texts).toContain('Internetfilter und Firewall: was die App erreichen muss');
    for (const line of filterHostLines({ sources: false })) expect(texts).toContain(line.split(':** ')[1]);
    expect(texts).toContain('WebKitNetworkProcess');
    // Each address stays on one line: is1-ssl.mzstatic.com must not break at its hyphen on a phone.
    const [cover] = filterHostLines({ sources: false });
    const parts = parseInline(cover);
    expect(parts.filter((p) => p.kind === 'nowrap').map((p) => p.text)).toEqual(filterHostGroups({ sources: false })[0].hosts);
    expect(plainText(cover)).toContain('itunes.apple.com, is1-ssl.mzstatic.com');
    expect(resolveHelp('firewall')).toEqual(resolveHelp('internetfilter'));
    expect(resolveHelp('webfilter')).toEqual(resolveHelp('internetfilter'));
  });
});
