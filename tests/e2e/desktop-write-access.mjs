/**
 * The desktop app with a card Linux mounted for root (an /etc/fstab line
 * under /mnt, no uid=): "Meine Box" says that the app may not change
 * anything and offers "Schreibrechte holen"; a refused delete offers the
 * same in its toast; after the fix the notice is gone.
 *
 * Needs the desktop front end, so its own dev server, and is not part of
 * run.mjs. The Tauri backend is a fake in the page (window.__TAURI_INTERNALS__):
 *
 *   TAURI_ENV_PLATFORM=linux npx vite --port 5295 --strictPort &
 *   DESKTOP_APP_URL=http://localhost:5295/ PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node tests/e2e/desktop-write-access.mjs
 */
import { check, failed, launch, noErrors, shot, shown } from './lib.mjs';

const URL_ = process.env.DESKTOP_APP_URL ?? 'http://localhost:5295/';

const FAKE = () => {
  const MNT = '/mnt/usb-Generic_STORAGE_DEVICE_000000000819-0:0-part1';
  const state = { writable: false, fixed: 0, denied: 0 };
  const dto = () => ({
    id: MNT, label: 'TONUINO', mountPath: MNT, fsType: 'vfat', clusterSize: 32768, totalBytes: 16e9, freeBytes: 12e9,
    removable: true, device: '/dev/sdb1', canEject: true,
    writable: state.writable, readOnly: false, foreignOwner: !state.writable, canFixAccess: !state.writable,
  });
  const tree = { mp3: { '0001.mp3': 4000 }, advert: { '0001.mp3': 4000 }, '01': { '001.mp3': 4000, '002.mp3': 4000 } };
  const at = (path) => {
    if (!path.startsWith(MNT)) return undefined;
    let node = tree;
    for (const part of path.slice(MNT.length).split('/').filter(Boolean)) {
      if (typeof node !== 'object' || !(part in node)) return undefined;
      node = node[part];
    }
    return node;
  };
  const callbacks = new Map();
  let next = 1;
  window.__fake = state;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    plugins: {},
    transformCallback(cb) {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args = {}) {
      const deny = () => {
        state.denied++;
        throw { code: 'permission', detail: 'Permission denied (os error 13)' };
      };
      switch (cmd) {
        case 'plugin:event|listen':
          return next++;
        case 'plugin:event|unlisten':
          return null;
        case 'volumes_list':
        case 'volumes_refresh':
          return [dto()];
        case 'volume_info': {
          const d = dto();
          return { ...d, mountPath: MNT };
        }
        case 'volume_fix_access':
          state.writable = true;
          state.fixed++;
          return dto();
        case 'fs_list': {
          const node = at(args.path);
          if (!node || typeof node !== 'object') throw { code: 'not-found', detail: args.path };
          return Object.entries(node).map(([name, v]) => (typeof v === 'object' ? { name, kind: 'directory' } : { name, kind: 'file', size: v, modified: 1709373600000 }));
        }
        case 'fs_exists':
          return at(args.path) !== undefined;
        case 'fs_stat': {
          const node = at(args.path);
          if (node === undefined) throw { code: 'not-found', detail: args.path };
          return typeof node === 'object' ? { kind: 'directory', size: 0, modified: null, readOnly: !state.writable } : { kind: 'file', size: node, modified: 1709373600000, readOnly: !state.writable };
        }
        case 'fs_read':
        case 'fs_read_range': {
          const node = at(args.path);
          if (node === undefined || typeof node === 'object') throw { code: 'not-found', detail: args.path };
          return new Uint8Array(args.length ?? 0).buffer;
        }
        case 'fs_mkdir':
        case 'fs_remove':
        case 'fs_rename':
        case 'fs_write':
        case 'fs_write_chunk':
        case 'fs_write_finish':
          if (!state.writable) deny();
          return null;
        default:
          return null;
      }
    },
  };
};

export async function desktopWriteAccess(browser) {
  console.log('desktop: card mounted for another account');
  for (const [theme, width] of [
    ['light', 1280],
    ['dark', 390],
  ]) {
    const tag = `${theme}-${width}`;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    await ctx.addInitScript(FAKE);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(URL_);
    const notice = page.getByText('Ich kann die Karte zeigen, aber nichts darauf ändern');
    await notice.waitFor({ timeout: 20_000 });
    const button = page.getByRole('button', { name: 'Schreibrechte holen' });
    check((await button.count()) === 1, `${tag}: the notice offers "Schreibrechte holen"`);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(sw <= 1, `${tag}: no sideways scrolling`);
    await shot(page, `desktop-write-access-${tag}`);
    if (width === 1280) {
      await page.goto(URL_ + '#/ordner/01');
      // The „…“ of the folder page, not the „Mehr für die Karte“ of the page before (lib.mjs folderPage).
      await shown(page).getByRole('button', { name: 'Mehr', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Ordner löschen' }).click();
      await page.getByRole('button', { name: 'Endgültig löschen' }).click();
      const inToast = page.locator('.toast').getByRole('button', { name: 'Schreibrechte holen' });
      await inToast.waitFor({ timeout: 10_000 });
      check((await page.locator('.toast').getByText(/Schreibschutz|Schieber/).count()) === 0, 'the toast no longer blames the lock slider');
      await inToast.click();
      await page.getByText('Jetzt darf ich auf die Karte schreiben').waitFor({ timeout: 10_000 });
      check((await page.evaluate(() => window.__fake.fixed)) === 1, 'the card was mounted again once');
      await page.goto(URL_ + '#/');
      await shown(page).locator('.page-header h1').waitFor();
      check((await notice.count()) === 0, 'after the fix the notice is gone');
    }
    noErrors(errors, `${tag}: no errors on the page`);
    await ctx.close();
  }
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await desktopWriteAccess(browser);
  } finally {
    await browser.close();
  }
  console.log(failed() ? `${failed()} checks failed.` : 'All checks passed.');
  process.exit(failed() ? 1 : 0);
}
