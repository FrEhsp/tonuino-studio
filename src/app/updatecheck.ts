/**
 * "Neue Version von TonUINO Studio da": a one-line notice in the desktop app
 * and the Android app. Off until the user switches it on in the settings,
 * and only in builds that name a public list of releases (VITE_RELEASES_URL
 * at build time); without it the switch is not shown and the app asks
 * nobody. Then the app asks that address at most once a day. The answer may
 * be a GitHub release ({tag_name, html_url, assets}), a list of them, or
 * {version, url}. What to do with a new version on this system says
 * updatesteps.ts; the web app learns of new versions from its service
 * worker instead (src/app/pwa.ts).
 */
import { signal } from '@preact/signals';

export interface Release {
  version: string;
  /** The release page (what is new, all files). */
  url: string;
  /** The files of the release, when the answer lists them (GitHub: assets). */
  assets?: ReleaseAsset[];
}

/** One file of a release, with its direct download address. */
export interface ReleaseAsset {
  name: string;
  url: string;
}

interface Stored {
  on: boolean;
  lastCheck?: number;
  latest?: Release;
  /** The version whose notice the user closed. */
  dismissed?: string;
}

const KEY = 'tonuino-studio:update-check';
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The address of the release list, from the build; empty: no check at all. */
export const RELEASES_URL: string = (import.meta.env.VITE_RELEASES_URL ?? '').trim();

/** The switch is offered: the build names a list, and it is the desktop or Android app (the web app hears of new versions from its service worker, pwa.ts). */
export function updateCheckOffered(kind: 'desktop' | 'web' | undefined, url = RELEASES_URL): boolean {
  return kind === 'desktop' && /^https:\/\//.test(url);
}

/** The host the app asks, for the privacy line. */
export function releasesHost(url = RELEASES_URL): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------ versions */

function parts(v: string): { nums: number[]; pre: string } {
  const clean = v.trim().replace(/^v/i, '');
  const [main, pre = ''] = clean.split('-', 2);
  return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
}

/** Like semver: 0.10.0 after 0.9.2, and a pre-release ("0.4.0-beta.1") before its release. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The newest release in an answer; drafts and pre-releases do not count. */
export function parseRelease(json: unknown): Release | undefined {
  const list = Array.isArray(json) ? json : [json];
  let best: Release | undefined;
  for (const r of list) {
    if (!isObj(r) || r.draft === true || r.prerelease === true) continue;
    const version = typeof r.tag_name === 'string' ? r.tag_name : typeof r.version === 'string' ? r.version : undefined;
    const url = typeof r.html_url === 'string' ? r.html_url : typeof r.url === 'string' ? r.url : undefined;
    if (!version || !url || !/^https:\/\//.test(url) || !/\d/.test(version)) continue;
    const assets = parseAssets(r.assets);
    const release: Release = { version: version.replace(/^v/i, ''), url, ...(assets.length ? { assets } : {}) };
    if (!best || compareVersions(release.version, best.version) > 0) best = release;
  }
  return best;
}

/** GitHub's assets ({name, browser_download_url}) or plain {name, url}; https only. */
function parseAssets(v: unknown): ReleaseAsset[] {
  if (!Array.isArray(v)) return [];
  const out: ReleaseAsset[] = [];
  for (const a of v) {
    if (!isObj(a) || typeof a.name !== 'string') continue;
    const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : typeof a.url === 'string' ? a.url : undefined;
    if (url && /^https:\/\//.test(url)) out.push({ name: a.name, url });
  }
  return out;
}

/* ------------------------------------------------------------ state */

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Stored>) : {};
    return { on: v.on === true, lastCheck: typeof v.lastCheck === 'number' ? v.lastCheck : undefined, latest: v.latest, dismissed: typeof v.dismissed === 'string' ? v.dismissed : undefined };
  } catch {
    return { on: false };
  }
}

function save(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not remembered: the switch is off again next time, which is the safe side.
  }
}

export const updateCheck = signal<Stored>(load());

/** A newer version than this one that the user has not closed, else null. */
export function pendingUpdate(s: Stored, current: string): Release | null {
  const l = s.latest;
  if (!s.on || !l || compareVersions(l.version, current) <= 0 || s.dismissed === l.version) return null;
  return l;
}

export function setUpdateCheck(on: boolean): void {
  const next: Stored = on ? { ...updateCheck.peek(), on } : { on: false };
  updateCheck.value = next;
  save(next);
}

export function dismissUpdate(version: string): void {
  const next = { ...updateCheck.peek(), dismissed: version };
  updateCheck.value = next;
  save(next);
}

/**
 * Asks the list, when switched on and the last question is a day old. A
 * failure is quiet: it asks again tomorrow.
 */
export async function checkForUpdate(deps: { fetch: (url: string, init?: RequestInit) => Promise<Response>; now?: () => number; url?: string }): Promise<void> {
  const url = deps.url ?? RELEASES_URL;
  const now = (deps.now ?? Date.now)();
  const s = updateCheck.peek();
  if (!s.on || !url || (s.lastCheck !== undefined && now - s.lastCheck < DAY_MS && now >= s.lastCheck)) return;
  const asked: Stored = { ...s, lastCheck: now };
  try {
    const res = await deps.fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'omit' });
    if (res.ok) {
      const latest = parseRelease(await res.json());
      if (latest) asked.latest = latest;
    }
  } catch {
    // Offline or blocked: next time.
  }
  // Switched off while asking: keep it off.
  if (!updateCheck.peek().on) return;
  updateCheck.value = asked;
  save(asked);
}
