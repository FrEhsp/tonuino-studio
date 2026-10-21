/**
 * What each provider allows, decided once from its terms and kept in one
 * table: whether the app may play its titles (the file itself, or the
 * provider's own player), and whether the app may save them on the card or
 * only link to the provider's page, where the family saves them itself.
 *
 * Entries find their provider by the terms they name (rights.termsUrl).
 * Entries under a free licence (CC, public domain) need no row: the licence
 * allows playing and saving. validate.ts checks every active entry against
 * this table, build.ts keeps only the players and files a row allows, and
 * the app drops any other player address it finds in a list.
 *
 * Only what the terms allow, nothing that works around a provider's
 * protection. A row changes when the terms change or a provider agrees in
 * writing (then permission.granted in the catalogue, not a new row).
 */
import type { CatalogEntry, IndexEntry, Rights } from './types';

/** How the app may play a title: its file in the app's own player, or the provider's player in a frame. */
export type PlayWay = 'file' | 'embed';

/**
 * Where the family may save a title. 'app': the app may load the file and put
 * it on the card. 'page': only on the provider's page (the app links there and
 * finds the saved file in the download folder). 'none': not at all.
 */
export type SaveWay = 'app' | 'page' | 'none';

export interface Provider {
  id: string;
  name: string;
  /** The terms this row was read from: the key entries name in rights.termsUrl. */
  termsUrl: string;
  /** The day a person read them for this row (YYYY-MM-DD). */
  checkedAt: string;
  /** The words of the terms the decision rests on, quoted exactly (parts left out marked with …). */
  quote: string;
  play: readonly PlayWay[];
  save: SaveWay;
  /** Hosts whose files the app may play or save (https, exact host names). */
  fileHosts: readonly string[];
  /** The provider's player addresses the app may load in a frame. Only with play 'embed'. */
  embed?: RegExp;
  /**
   * With save 'app' for files whose server sends no CORS header: the desktop
   * app loads them itself through its https helper (src-tauri/src/sources_net.rs,
   * whose ALLOWED_HOSTS must name every one of fileHosts). The web app and the
   * Android app cannot, there the family saves the file and the app picks it up.
   */
  appLoads?: true;
}

/** ARD Sounds' player for one episode, as the episode page names it (twitter:player). */
export const ARD_EMBED = /^https:\/\/www\.ardsounds\.de\/embed\/episode\/\d{4,12}\/$/;

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'ardsounds',
    name: 'ARD Sounds',
    termsUrl: 'https://www.ardsounds.de/nutzungsbedingungen/',
    checkedAt: '2026-10-15',
    quote:
      '„ARD Mediathek und ARD Sounds dürfen ausschließlich zu privaten, nichtkommerziellen Zwecken … genutzt werden.“ „Die Vervielfältigung, Änderung, Neuzusammenstellung, Wiederpublizierung, Verbreitung oder Speicherung von Informationen … bedarf der vorherigen schriftlichen Zustimmung der produzierenden Landesrundfunkanstalt.“ „Diese Embedding-Funktion gestattet die Einbindung des ARD-Players in fremde Angebote außerhalb der ARD“ (Stand 22.4.2026)',
    // The episode pages name no file address the app could check from here (the
    // download button sits behind the page's script), so only the player.
    play: ['embed'],
    save: 'page',
    fileHosts: [],
    embed: ARD_EMBED,
  },
  {
    id: 'deutschlandradio',
    name: 'Deutschlandradio',
    termsUrl: 'https://www.kakadu.de/nutzungsbedingungen-106.html',
    checkedAt: '2026-10-15',
    quote: '„Die Inhalte dürfen ausschließlich zu privaten, nichtkommerziellen Zwecken …“ Vervielfältigung und Speicherung „bedarf daher der vorherigen schriftlichen Zustimmung von Deutschlandradio“ (Stand 09.04.2020)',
    // Kakadu's own feed files play in the app; Kakadu shows on ARD Sounds use ARD's player.
    play: ['file', 'embed'],
    save: 'page',
    fileHosts: ['podcast-mp3.dradio.de'],
    embed: ARD_EMBED,
  },
  {
    id: 'ohrka',
    name: 'OHRKA',
    termsUrl: 'https://www.ohrka.de/impressum',
    checkedAt: '2026-10-05',
    quote: '„… nicht-kommerzielle Gebrauch … zu privaten Zwecken und zu Bildungszwecken ausdrücklich erwünscht und erlaubt“; andere Verwertung nur mit vorheriger schriftlicher Zustimmung (Impressum)',
    // Private saving is allowed. The files send no CORS header: the desktop app
    // loads them through its own https helper, elsewhere the family opens the
    // file and the app finds it in the download folder.
    play: ['file'],
    save: 'app',
    fileHosts: ['www.ohrka.de'],
    appLoads: true,
  },
  {
    id: 'srgssr',
    name: 'SRG SSR',
    termsUrl: 'https://www.srgssr.ch/de/nutzungsbedingungen',
    checkedAt: '2026-10-05',
    quote: '„… einmalige Herunterladen und Speichern …“ für den privaten Gebrauch, ohne Änderung, Weitergabe oder öffentliche Wiedergabe',
    play: ['file'],
    save: 'app',
    fileHosts: ['download-media.srf.ch'],
  },
];

/** The row for an entry's terms; undefined for free licences and for terms nobody has decided on yet. */
export function providerOf(rights: Rights): Provider | undefined {
  if (rights.kind !== 'podcast' && rights.kind !== 'private-use') return undefined;
  return rights.termsUrl ? PROVIDERS.find((p) => p.termsUrl === rights.termsUrl) : undefined;
}

/** Free licences allow playing and saving without a row. */
export function freeLicence(rights: Rights): boolean {
  return rights.kind === 'cc' || rights.kind === 'public-domain';
}

/** Where an entry's titles may be saved: by licence, by its row, or by a written permission. */
export function saveWay(entry: Pick<CatalogEntry, 'rights' | 'permission'>): SaveWay {
  if (freeLicence(entry.rights) || entry.permission?.granted) return 'app';
  return providerOf(entry.rights)?.save ?? 'none';
}

function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the app may load this player address for an entry with these rights. */
export function embedAllowed(rights: Rights, url: string | undefined): url is string {
  const p = providerOf(rights);
  return !!url && !!p?.embed && p.play.includes('embed') && p.embed.test(url);
}

/** Whether a file of this address may be offered to save (a link entry's file from its title page). */
export function fileAllowed(entry: Pick<CatalogEntry, 'rights' | 'permission'>, url: string | undefined): url is string {
  if (!url || saveWay(entry) !== 'app') return false;
  const host = hostOf(url);
  const p = providerOf(entry.rights);
  return !!host && !!p && p.fileHosts.includes(host);
}

/** Whether the desktop app loads this file itself for an entry with these rights (Provider.appLoads). */
export function appLoadsFile(rights: Rights, url: string | undefined): boolean {
  const p = providerOf(rights);
  const host = url ? hostOf(url) : undefined;
  return !!p?.appLoads && p.save === 'app' && !!host && p.fileHosts.includes(host);
}

/** Whether a file address lies on a host whose files the desktop app loads itself (the download picks its way by this). */
export function appLoadHost(url: string): boolean {
  const host = hostOf(url);
  return !!host && PROVIDERS.some((p) => p.appLoads && p.save === 'app' && p.fileHosts.includes(host));
}

/** Problems of an active entry against the table, in the words of validate.ts. */
export function providerProblems(entry: CatalogEntry): string[] {
  const out: string[] = [];
  if (freeLicence(entry.rights)) return out;
  const p = providerOf(entry.rights);
  // A written permission (permission.granted) is the decision itself; it needs no row.
  if (!p && entry.permission?.granted) return out;
  if (!p) {
    out.push('Anbieter fehlt in providers.ts: erst die Nutzungsbedingungen lesen und festhalten, was Abspielen und Speichern erlauben');
    return out;
  }
  if (entry.delivery === 'direct' && saveWay(entry) !== 'app') out.push(`${p.name} erlaubt das Speichern über die App nicht (delivery "browser" oder permission.granted)`);
  if (entry.type === 'link') {
    for (const it of entry.items) {
      if (it.embed !== undefined && !embedAllowed(entry.rights, it.embed)) out.push(`${it.pageUrl}: Player ${it.embed} ist für ${p.name} nicht erlaubt`);
      if (it.fileUrl !== undefined && !fileAllowed(entry, it.fileUrl) && saveWay(entry) === 'app') out.push(`${it.pageUrl}: Datei ${it.fileUrl} liegt auf keinem Host von ${p.name}`);
    }
  }
  return out;
}

/** For the app: the player of a title, only when the table allows it for the source's terms. */
export function embedOf(entry: Pick<IndexEntry, 'rights'>, item: { embed?: string }): string | undefined {
  return embedAllowed(entry.rights, item.embed) ? item.embed : undefined;
}

/** Whose player an address is, for the frame's title and the line below it. */
export function playerName(url: string): string {
  return ARD_EMBED.test(url) ? 'ARD Sounds' : (hostOf(url) ?? url);
}
