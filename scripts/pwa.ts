/**
 * The web app as an installable app (TODO #122): adds the manifest, its
 * icons and the service worker (src/pwa) to the web build, and to
 * index.html the links to them and the build's version, which the page
 * compares with the service worker's (src/app/pwa.ts). The desktop and the
 * Android app get none of it: they update in their own way (TODO #123).
 *
 * The version is a hash of every file name below assets/ (their content is
 * in their names) and of index.html, so each build that changes anything
 * gets a new service worker, and an unchanged one keeps it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const PWA_DIR = new URL('../src/pwa/', import.meta.url);
export const PWA_ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'] as const;

/** The files index.html loads itself (script, style sheets, preloads), relative like the build writes them. */
export function shellFiles(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\s(?:src|href)="\.?\/?(assets\/[^"?#]+)"/g)) out.add(m[1]);
  return [...out].sort();
}

/** The version of a build: changes with any file below assets/ and with the page. */
export function buildVersion(assetNames: readonly string[], html: string): string {
  const h = createHash('sha256');
  for (const n of [...assetNames].sort()) h.update(`${n}\n`);
  h.update(html);
  return h.digest('hex').slice(0, 16);
}

/** The service worker with this build's version and files filled in. */
export function serviceWorkerSource(template: string, version: string, shell: readonly string[], assets: readonly string[]): string {
  return template
    .replace("'__VERSION__'", JSON.stringify(version))
    .replace('__SHELL__', JSON.stringify(shell))
    .replace('__ASSETS__', JSON.stringify(assets));
}

/** What index.html gets in its head, before </head>. */
export function headTags(version: string): string {
  return [
    `<link rel="manifest" href="./manifest.webmanifest" />`,
    `<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />`,
    `<meta name="theme-color" content="#f6f1e8" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="#1d1b19" media="(prefers-color-scheme: dark)" />`,
    `<meta name="tonuino-build" content="${version}" />`,
  ]
    .map((t) => `    ${t}\n`)
    .join('');
}

/** Only in the build of the web app (`enabled`); never in the dev server. */
export function pwaPlugin(enabled: boolean): Plugin {
  return {
    name: 'tonuino-pwa',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(options, bundle) {
        if (!enabled || options.format !== 'es') return;
        const page = bundle['index.html'];
        if (!page || page.type !== 'asset') return;
        const html = typeof page.source === 'string' ? page.source : new TextDecoder().decode(page.source);
        const assets = Object.keys(bundle)
          .filter((f) => f.startsWith('assets/') && !f.endsWith('.map'))
          .sort();
        const version = buildVersion(assets, html);
        page.source = html.replace(/\n?[ \t]*<\/head>/, `\n${headTags(version)}  </head>`);
        const shell = ['index.html', 'favicon.svg', 'manifest.webmanifest', ...shellFiles(html)];
        const template = readFileSync(new URL('sw.template.js', PWA_DIR), 'utf8');
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(template, version, shell, assets) });
        this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: readFileSync(new URL('manifest.webmanifest', PWA_DIR), 'utf8') });
        for (const icon of PWA_ICONS) this.emitFile({ type: 'asset', fileName: `icons/${icon}`, source: readFileSync(new URL(`icons/${icon}`, PWA_DIR)) });
      },
    },
  };
}
