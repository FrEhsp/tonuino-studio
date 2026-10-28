/**
 * What a web filter or a firewall must let through (Hilfe „Internetfilter
 * und Firewall“, TODO 0.3 „was die App erreichen muss“), taken from the code
 * that makes the requests, so the list cannot drift away from it:
 *
 *   cover search and track names  SERVICE_HOSTS (src/core/covers/net.ts),
 *                                 the desktop app asks through its backend (src-tauri/src/cover_net.rs)
 *   pictograms                    ARASAAC_API, ARASAAC_STATIC (src/core/stickers/arasaac.ts)
 *   firmware AiO+ and sounds      FIRMWARE_BASE_URL (src/core/firmware/variants.ts), TNG_SOUNDS_URL (soundsinstall.ts)
 *   „Entdecken“                   PROVIDERS' file hosts (src/core/sources/providers.ts), archive.org and gitlab.com
 *                                 for the freely licensed albums, the pages the desktop app builds the list from
 *                                 (src-tauri/src/sources_net.rs ALLOWED_HOSTS)
 *   new versions                  the release list of the build and GitHub's download servers
 *
 * A test (tests/help/netHosts.test.ts) checks this against the backend's lists.
 */
import { SERVICE_HOSTS, SERVICE_NAME, type Service } from '../../core/covers/net';
import { ARASAAC_API, ARASAAC_STATIC } from '../../core/stickers/arasaac';
import { FIRMWARE_BASE_URL } from '../../core/firmware/variants';
import { TNG_SOUNDS_URL } from '../../core/tonuino/soundsinstall';
import { PROVIDERS } from '../../core/sources/providers';

export interface HostGroup {
  /** What needs them, in a few words. */
  what: string;
  hosts: string[];
}

const hostOf = (url: string) => new URL(url).host;
const unique = (xs: string[]) => [...new Set(xs)];

/** The pages and feeds the desktop app builds the list of „Entdecken“ from (sources_net.rs). */
export const SOURCES_LIST_HOSTS = ['www.kakadu.de', 'www.ardsounds.de', 'www.ohrka.de'];

/** Albums under a free licence: archive.org with its file servers (ia800….us.archive.org), and gitlab.com. */
export const FREE_ALBUM_HOSTS = ['archive.org', '*.archive.org', 'gitlab.com'];

/** GitHub's servers for a release's files: github.com sends the download on to them. */
export const GITHUB_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

export function filterHostGroups(o: { sources: boolean; updates?: string }): HostGroup[] {
  const services = Object.keys(SERVICE_HOSTS) as Service[];
  const groups: HostGroup[] = [
    { what: `Cover-Suche und Titelnamen (${services.map((s) => SERVICE_NAME[s]).join(', ')})`, hosts: services.flatMap((s) => SERVICE_HOSTS[s]) },
    { what: 'Piktogramme (ARASAAC)', hosts: unique([hostOf(ARASAAC_API), hostOf(ARASAAC_STATIC)]) },
    { what: 'Firmware für die AiO+ und Systemansagen (TonUINO TNG)', hosts: unique([hostOf(FIRMWARE_BASE_URL), hostOf(TNG_SOUNDS_URL)]) },
  ];
  if (o.sources) {
    groups.push({
      what: 'Entdecken: Liste, Reinhören und Laden',
      hosts: unique([...FREE_ALBUM_HOSTS, ...SOURCES_LIST_HOSTS, ...PROVIDERS.flatMap((p) => p.fileHosts)]),
    });
  }
  if (o.updates) groups.push({ what: 'Neue Versionen', hosts: unique([o.updates, ...GITHUB_DOWNLOAD_HOSTS]) });
  return groups;
}

/** The groups as lines of the help: „**Cover-Suche …:** `itunes.apple.com`, …“, each address on one line. */
export function filterHostLines(o: { sources: boolean; updates?: string }): string[] {
  return filterHostGroups(o).map((g) => `**${g.what}:** ${g.hosts.map((h) => `\`${h}\``).join(', ')}`);
}
