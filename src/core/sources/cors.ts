/**
 * Decides whether the app may fetch() a media file, from the response
 * headers of every hop of its redirect chain (the browser rules, verified
 * with Chromium against local servers). The index builder records the
 * chains; nothing here touches the network.
 */

export interface Hop {
  status: number;
  url: string;
  headers: Record<string, string>;
}

export type CorsResult = { ok: true } | { ok: false; hop: number; reason: string };

/**
 * What the builder knows about a media host. 'direct': every app origin may
 * fetch its files. 'browser': at least one may not. 'unverified': no file
 * was checked yet. 'unstable': the result changed since the last run.
 * 'browser', 'unverified' and 'unstable' mean: open the page, save, drag in.
 * 'blocked': the files are handed out through a measurement service or a
 * host the entry does not allow; they are not listed at all.
 */
export type HostVerdict = 'direct' | 'browser' | 'unverified' | 'unstable' | 'blocked';

/** The desktop WebView: Linux and macOS, Windows (http), Windows with https scheme. */
export const DESKTOP_ORIGINS: readonly string[] = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

/** Origins the app runs under: the web build (from the configuration) and the desktop WebView. */
export function appOrigins(webOrigin: string): string[] {
  return [new URL(webOrigin).origin, ...DESKTOP_ORIGINS];
}

function header(h: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v.trim();
  return undefined;
}

/**
 * Every response, redirects included, needs Access-Control-Allow-Origin "*"
 * or exactly the Origin that was sent. After a redirect to another origin
 * the browser sends "Origin: null". Credentials are never sent, so "*" is enough.
 * "<echo>" in a snapshot stands for a server that echoes the Origin it got.
 */
export function checkChain(hops: readonly Hop[], pageOrigin: string): CorsResult {
  if (!hops.length) return { ok: false, hop: 0, reason: 'keine Antwort' };
  let tainted = false;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const sent = tainted ? 'null' : pageOrigin;
    const raw = header(hop.headers, 'access-control-allow-origin');
    const allowed = raw === '<echo>' ? sent : raw;
    if (!allowed) return { ok: false, hop: i, reason: 'kein Access-Control-Allow-Origin' };
    if (allowed !== '*' && allowed !== sent) return { ok: false, hop: i, reason: `erlaubt nur ${allowed}, gesendet wurde ${sent}` };
    if (hop.status >= 300 && hop.status < 400) {
      const location = header(hop.headers, 'location');
      if (!location) return { ok: false, hop: i, reason: 'Weiterleitung ohne Ziel' };
      let next: URL;
      try {
        next = new URL(location, hop.url);
      } catch {
        return { ok: false, hop: i, reason: 'Weiterleitung mit ungültigem Ziel' };
      }
      if (next.protocol !== 'https:') return { ok: false, hop: i, reason: `Weiterleitung ohne HTTPS (${next.protocol})` };
      if (next.origin !== new URL(hop.url).origin) tainted = true;
    }
  }
  return { ok: true };
}

function hostIn(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith('.' + a));
}

/**
 * A hop of the redirect chain on a measurement service, or on a host that
 * is neither one of `allowed` nor below one of them (ia800300.us.archive.org
 * is below archive.org). Undefined when the whole chain stays where it should.
 */
export function chainHostProblem(hops: readonly Hop[], allowed: readonly string[]): string | undefined {
  const urls: string[] = [];
  for (const hop of hops) {
    urls.push(hop.url);
    const location = header(hop.headers, 'location');
    if (hop.status >= 300 && hop.status < 400 && location) {
      try {
        urls.push(new URL(location, hop.url).toString());
      } catch {
        // checkChain reports it
      }
    }
  }
  for (const u of urls) {
    let host: string;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (isMeasurementHost(host)) return `Weiterleitung über den Messdienst ${host}`;
    if (!hostIn(host, allowed)) return `Weiterleitung zu ${host}, der für diesen Eintrag nicht erlaubt ist`;
  }
  return undefined;
}

/** The status the chain ended with is a file (2xx), not an error page or a cut-off redirect: only then does a check count. */
export function chainReachedFile(hops: readonly Hop[]): boolean {
  const last = hops[hops.length - 1];
  return !!last && last.status >= 200 && last.status < 300;
}

/** 'direct' only when the chain passes for every app origin. */
export function deliveryFromChain(hops: readonly Hop[], origins: readonly string[]): { delivery: 'direct' | 'browser'; failures: string[] } {
  const failures: string[] = [];
  for (const o of origins) {
    const r = checkChain(hops, o);
    if (!r.ok) failures.push(`${o}: Schritt ${r.hop + 1}: ${r.reason}`);
  }
  return { delivery: failures.length ? 'browser' : 'direct', failures };
}

/**
 * Today's measurement against the last one: a host whose answer changed
 * between runs is 'unstable' (treated like 'browser') until two runs agree.
 */
export function stableVerdict(previous: 'direct' | 'browser' | undefined, measured: 'direct' | 'browser'): HostVerdict {
  return previous !== undefined && previous !== measured ? 'unstable' : measured;
}

/** Hosts that only measure downloads and pass them on. Enclosures through them are rejected. */
export const MEASUREMENT_HOSTS: readonly string[] = [
  'podtrac.com',
  'pdst.fm',
  'chrt.fm',
  'chtbl.com',
  'op3.dev',
  'podscribe.com',
  'claritaspod.com',
  'arttrk.com',
  'pfx.vpixl.com',
  'mgln.ai',
  'prfx.byspotify.com',
];

export function isMeasurementHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return MEASUREMENT_HOSTS.some((m) => h === m || h.endsWith('.' + m));
}
