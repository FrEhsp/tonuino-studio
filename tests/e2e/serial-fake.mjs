/**
 * USB in Firefox 151 and later, faked: no folder access, but Web Serial.
 * The app names the add-on question before the first pick, says how to lift
 * a block when no chooser came, and stops explaining after the first pick.
 * The fake's requestPort() follows window.__serialMode: 'blocked' (empty
 * answer after 3.5 s, as Firefox after "Nie erlauben"), 'cancel' (empty
 * answer at once) or 'ok' (a CH340 port).
 */
import { check, failed, launch, noErrors, openApp, shot } from './lib.mjs';

const FAKE_SERIAL = () => {
  const ports = [];
  const port = () => {
    const p = new EventTarget();
    p.getInfo = () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
    p.open = async () => {
      throw new DOMException('Failed to open serial port.', 'NetworkError');
    };
    p.close = async () => undefined;
    return p;
  };
  const serial = new EventTarget();
  serial.getPorts = async () => ports.slice();
  serial.requestPort = async () => {
    const mode = window.__serialMode ?? 'blocked';
    if (mode === 'blocked') {
      await new Promise((r) => setTimeout(r, 3500));
      throw new DOMException('No port selected by the user.', 'NotFoundError');
    }
    if (mode === 'cancel') throw new DOMException('No port selected by the user.', 'NotFoundError');
    const p = port();
    ports.push(p);
    return p;
  };
  Object.defineProperty(Navigator.prototype, 'serial', { get: () => serial, configurable: true });
};

const BLOCKED = 'Kam kein Auswahlfenster? Dann hat dein Browser den Zugriff für diese Seite vielleicht gesperrt.';

export async function serialFake(browser) {
  console.log('USB in Firefox (faked)');
  const { page, errors } = await openApp(browser, { init: [{ fn: FAKE_SERIAL }], hash: '#/werkstatt' });
  await page.getByRole('heading', { name: 'Werkstatt' }).waitFor();
  check((await page.getByText(/Per USB nur in/).filter({ visible: true }).count()) === 0, 'with Web Serial the overview has no USB note');
  check((await page.getByText('Dieser Browser kann nicht über USB mit der Box sprechen.').filter({ visible: true }).count()) === 0, 'no NoSerial box');
  check(await page.getByRole('link', { name: /Paket auf die Karte bringen/ }).isVisible(), 'the Paket tool is there too');

  await page.getByRole('link', { name: /Box-Logbuch/ }).click();
  await page.getByText('Dein Browser fragt gleich, welches Gerät ich benutzen darf. Wähle die Box aus.').waitFor();
  check(await page.getByText(/Fragt dein Browser vorher, ob er ein Add-on hinzufügen darf\?/).isVisible(), 'the add-on question is named before the first pick');
  await shot(page, 'serial-01-prompt-hint');

  const connect = page.getByRole('button', { name: 'Box verbinden …' });
  await connect.click();
  await page.getByText(BLOCKED, { exact: false }).waitFor({ timeout: 10_000 });
  check(true, 'no chooser for 3.5 s: the app says how to lift the block');
  await shot(page, 'serial-02-blocked');

  await page.evaluate(() => (window.__serialMode = 'cancel'));
  await connect.click();
  await page.waitForTimeout(500);
  check((await page.getByText(BLOCKED, { exact: false }).filter({ visible: true }).count()) === 0, 'a quick empty answer (closed chooser): no block hint');

  await page.evaluate(() => (window.__serialMode = 'ok'));
  await connect.click();
  await page.locator('.ws-port').first().waitFor({ timeout: 10_000 });
  check((await page.getByText('Dein Browser fragt gleich, welches Gerät ich benutzen darf.').filter({ visible: true }).count()) === 0, 'after the first pick the hint is gone');
  check((await page.evaluate(() => localStorage.getItem('tonuino-studio:serial-picked'))) === '1', 'the first pick is remembered');

  // After a reload Firefox forgets the port; the hint stays away.
  await page.reload();
  await page.getByText('Noch keine Box ausgewählt.', { exact: false }).waitFor();
  check((await page.getByText('Dein Browser fragt gleich, welches Gerät ich benutzen darf.').filter({ visible: true }).count()) === 0, 'after a reload: no hint again');

  await page.goto(page.url().replace(/#.*$/, '#/werkstatt/usb'));
  await page.getByRole('heading', { name: 'Fragt der Browser nach einem Add-on?' }).waitFor();
  check(true, 'USB help: the Firefox section comes first');
  await shot(page, 'serial-03-usbhelp');

  // Opening the fake port fails on purpose; the app reports that on the page.
  noErrors(errors, 'no errors on the page', [/Failed to open serial port/]);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await serialFake(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
