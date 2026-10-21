/**
 * Box testen, the guided test, with a faked box on Web Serial: the box
 * starts (TonUINO TNG, Classic, 3 buttons), the test asks for every button,
 * the card, the sound, the headphones; in the Wackeltest the box loses the
 * card and restarts. The result names the joints and rings them in the
 * Lötplan. The banner of the Werkstatt shows the problems on the other
 * tools too. window.__boxSend(lines) is the box talking.
 */
import { check, noErrors, openApp, shot } from './lib.mjs';

const FAKE_BOX = () => {
  const START = 'TonUINO Version 3.3.3\r\nV3.3.3 17.09.26\r\nC 3\r\nVer:2\r\nVol:20 3 8 15 3 8\r\nMFRC522: 146\r\nVolume: 8\r\n';
  const enc = new TextEncoder();
  let controller = null;
  const send = (text) => {
    try {
      controller?.enqueue(enc.encode(text));
    } catch {
      // closed
    }
  };
  window.__boxSend = (lines) => send(lines.map((l) => `${l}\r\n`).join(''));
  const port = new EventTarget();
  let readable = null;
  port.getInfo = () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
  Object.defineProperty(port, 'readable', { get: () => readable });
  Object.defineProperty(port, 'writable', { get: () => null });
  port.open = async () => {
    readable = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        controller = null;
      },
    });
    // Opening the port restarts the box.
    setTimeout(() => send(START), 150);
  };
  port.setSignals = async (s) => {
    if (s.dtr && s.rts) setTimeout(() => send(START), 150);
  };
  port.close = async () => {
    readable = null;
    controller = null;
  };
  const serial = new EventTarget();
  serial.getPorts = async () => [port];
  serial.requestPort = async () => port;
  Object.defineProperty(Navigator.prototype, 'serial', { get: () => serial, configurable: true });
};

export async function boxtest(browser) {
  console.log('Box testen (faked box)');
  const { page, errors } = await openApp(browser, { init: [{ fn: FAKE_BOX }], hash: '#/werkstatt' });
  const say = page.locator('#bt-say');
  const box = (lines) => page.evaluate((l) => window.__boxSend(l), lines);
  await page.getByRole('link', { name: /Box testen/ }).click();
  await page.getByRole('heading', { name: 'Box testen' }).waitFor();
  check((await page.locator('.bt-sketch').count()) === 1, 'the drawn box is there from the start');
  await shot(page, 'bt-01-start');

  await page.getByRole('button', { name: /Box verbinden/ }).click();
  const connectedAt = Date.now();
  await page.getByText('Die Box ist verbunden.').waitFor({ timeout: 10_000 });
  check(await page.getByText(/Arduino Nano, 3 Tasten/).isVisible(), 'the start of the box names board and buttons');
  const marks = await page.locator('.bt-sketch [data-mark]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mark')));
  check(marks.includes('ok'), 'USB is ticked green', marks);
  await page.getByRole('button', { name: 'Test starten' }).click();

  // Buttons: the right one, then the wrong one, then a dead one.
  await say.filter({ hasText: 'Drücke kurz auf Play/Pause.' }).waitFor();
  await box(['btn/cmd: pause/pause']);
  await say.filter({ hasText: 'Drücke kurz auf Vor.' }).waitFor();
  check((await page.locator('.bt-sketch [data-key="pause"][data-state="ok"]').count()) === 1, 'Play/Pause turns green in the drawing');
  await box(['btn/cmd: down/bright_down']);
  await page.getByText('Die Box hat „Zurück“ gemeldet. Versuche es noch einmal.').waitFor();
  check(await page.getByText('Statt „Vor“ kam „Zurück“').isVisible(), 'the problem is listed at the top right away');
  await shot(page, 'bt-02-tasten-statt');
  await box(['btn/cmd: up/bright_up']);
  await say.filter({ hasText: 'Drücke kurz auf Zurück.' }).waitFor();
  await page.getByRole('button', { name: 'Passiert nichts' }).click();
  check((await page.locator('.bt-sketch [data-key="down"][data-state="fehler"]').count()) === 1, 'a dead button turns red');

  // Card and sound.
  await say.filter({ hasText: 'Lege eine Karte mit Musik auf die Box.' }).waitFor();
  await box(['Card Ins', 'CardData: 13 37 b3 47 02 01 02 00 00']);
  await say.filter({ hasText: 'Warte, bis die Box spielt.' }).waitFor();
  await box(['play 1-1', 'Volume: 9']);
  await say.filter({ hasText: 'Hörst du Musik aus dem Lautsprecher?' }).waitFor();
  check(await page.locator('.bt-volume').isVisible(), 'the volume shows live');
  await shot(page, 'bt-03-ton');
  await page.getByRole('button', { name: 'Ja, ich höre Musik' }).click();
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await say.filter({ hasText: 'Stecke einen Kopfhörer ein.' }).waitFor();
  await page.getByRole('button', { name: 'Ja, im Kopfhörer' }).click();
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await say.filter({ hasText: 'Was hat deine Box noch?' }).waitFor();
  await page.getByText('Lautstärke-Knopf').click();
  await say.filter({ hasText: 'Drehe am Lautstärke-Knopf.' }).waitFor();
  await box(['Volume: 10', 'Volume: 11']);
  await say.filter({ hasText: 'Was hat deine Box noch?' }).waitFor();
  check((await page.locator('.bt-sketch [data-mark="ok"]').count()) >= 5, 'the knob turned green by itself');
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();

  // Wackeltest: the card drops, the box restarts.
  await page.getByRole('button', { name: 'Wackeltest starten' }).click();
  await box(['Card Rem', 'Card Ins', 'DfPl Err: 4']);
  // Starts right after connecting are expected (NEUSTART_MS); this one comes later.
  await page.waitForTimeout(Math.max(200, connectedAt + 8500 - Date.now()));
  await box(['TonUINO Version 3.3.3', 'C 3']);
  await page.locator('.bt-wackel-log li', { hasText: 'Die Box ist neu gestartet' }).waitFor();
  check(await page.locator('.bt-wackel-log li', { hasText: 'Der Kartenleser hat die Karte verloren' }).isVisible(), 'the lost card is in the live list');
  await shot(page, 'bt-04-wackeln');
  await page.getByRole('button', { name: 'Fertig geklopft' }).click();

  // The result: parts, findings, the joint ringed in the Lötplan.
  await say.filter({ hasText: /Teile haben ein Problem/ }).waitFor();
  check((await page.locator('.bt-befund').count()) >= 3, 'every finding is listed');
  check((await page.locator('.bt-stelle .lp-mark').count()) >= 1, 'the joint is ringed in the Lötplan picture');
  check(await page.locator('.bt-stelle').getByText('Prüfe diese Stelle').isVisible(), 'and labelled "Prüfe diese Stelle"');
  await shot(page, 'bt-05-ergebnis');
  await page.locator('.bt-stelle').scrollIntoViewIfNeeded();
  await shot(page, 'bt-06-stelle');
  const zeig = page.locator('.bt-befund', { hasText: 'Die Box ist neu gestartet' }).getByRole('button', { name: 'Im Bild zeigen' });
  if (await zeig.count()) {
    await zeig.click();
    await page.locator('.bt-befund.is-shown', { hasText: 'Die Box ist neu gestartet' }).waitFor();
    check(true, '"Im Bild zeigen" switches the ringed joint');
  }

  // The banner on the other box tools.
  await page.evaluate(() => (location.hash = '#/werkstatt/logbuch'));
  await page
    .locator('.box-meldungen')
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  check((await page.locator('.box-meldungen').count()) === 1, 'the Box-Logbuch shows the problems of the box at the top');
  await shot(page, 'bt-07-banner');

  // Phone width, dark: the drawing and the steps fit.
  await page.evaluate(() => (location.hash = '#/werkstatt/testen'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('heading', { name: 'Box testen' }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, 'no sideways scrolling at 390 px', overflow);
  await shot(page, 'bt-08-390-dark');
  noErrors(errors, 'Box testen');
  await page.context().close();
}
