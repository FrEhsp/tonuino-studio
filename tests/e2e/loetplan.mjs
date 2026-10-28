/**
 * Werkstatt > Lötplan (0.6): the entry in the Werkstatt, one big picture per
 * board with the extras drawn in, the steps beside it and "Schritt für
 * Schritt", the rest of the build folded, the wires with sources below, the
 * Classic without board with its old picture, the choice kept for the next
 * visit, the link to the guided "Box testen". On a phone: the picture as big
 * as its smallest text needs (14 px), the buttons in view, no sideways
 * scrolling of the page, light and dark.
 */
import { check, failed, launch, noErrors, openApp, shot, visitAgain } from './lib.mjs';

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** The smallest text of the picture as shown, in CSS pixels. */
async function kleinsteSchrift(page) {
  return page.locator('.lp-blatt svg.lp-svg').first().evaluate((svg) => {
    let min = 99;
    for (const t of svg.querySelectorAll('text')) {
      const m = t.getScreenCTM();
      if (!m) continue;
      min = Math.min(min, parseFloat(t.getAttribute('font-size') ?? '12') * Math.hypot(m.a, m.b));
    }
    return Math.round(min * 10) / 10;
  });
}

/** Whether the element is fully inside the window, without scrolling. */
async function imBild(locator) {
  const box = await locator.boundingBox();
  const vp = locator.page().viewportSize();
  return !!box && box.y >= 0 && box.y + box.height <= vp.height + 0.5 && box.x >= 0 && box.x + box.width <= vp.width + 0.5;
}

/** The wires of the open step that the picture on a phone cuts off (or the + and − cover). */
async function wiresCut(page) {
  return page.locator('.lp-zoom').evaluate((el) => {
    const view = el.getBoundingClientRect();
    const keys = el.parentElement.querySelector('.lp-zoom-knoepfe')?.getBoundingClientRect();
    const right = keys ? keys.left : view.right;
    const strong = el.querySelector('svg.lp-svg > g > g:nth-of-type(3)');
    return [...(strong?.querySelectorAll('path, line, polyline') ?? [])]
      .map((w) => w.getBoundingClientRect())
      .filter((r) => r.width + r.height > 0 && (r.left < view.left - 1 || r.right > right + 1 || r.top < view.top - 1 || r.bottom > view.bottom + 1))
      .map((r) => `${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)}`);
  });
}

export async function loetplan(browser) {
  console.log('loetplan: Werkstatt > Lötplan');
  const { page: first, errors, context } = await openApp(browser, { hash: '#/werkstatt', width: 1440, height: 900 });
  let page = first;
  const card = page.locator('a.ws-zeile[href="#/werkstatt/loetplan"]');
  check(await card.isVisible(), 'loetplan: the Werkstatt lists the Lötplan');
  await card.click();
  await page.getByRole('heading', { name: 'Lötplan' }).waitFor();
  const blatt = page.locator('.lp-blatt svg.lp-svg');
  await blatt.waitFor();
  const kopf = () => page.locator('.lp-blatt-kopf b').textContent();
  check(/Classic v1\.7 · Nano/.test((await kopf()) ?? ''), 'loetplan: the Classic is drawn first', await kopf());
  for (const t of ['Play/Pause', 'Vor / lauter', 'Zurück / leiser', 'Kartenleser RC522', 'Arduino Nano']) check((await blatt.getByText(t, { exact: true }).count()) > 0, `loetplan: the picture shows ${t}`);
  check(await imBild(page.getByRole('button', { name: 'Drucken' })), 'loetplan: "Drucken" is in view at 1440×900');
  check(await imBild(page.getByRole('button', { name: 'Schritt für Schritt' })), 'loetplan: "Schritt für Schritt" is in view at 1440×900');

  // Extras as tick boxes, drawn into the same picture.
  const chip = (name) => page.locator('.lp-chip', { hasText: name });
  await chip('Drehregler').click();
  check((await chip('Drehregler').getAttribute('aria-pressed')) === 'true', 'loetplan: the knob is ticked');
  check((await blatt.getByText('Drehregler', { exact: true }).count()) > 0, 'loetplan: the knob is drawn into the picture');
  check(await page.locator('.lp-schritte').getByText('Drehregler.').isVisible(), 'loetplan: the knob has its step');
  await chip('Poti').click();
  check((await chip('Drehregler').getAttribute('aria-pressed')) === 'false', 'loetplan: the poti switches the knob off (both on A3)');
  check(/beide brauchen A3/.test((await page.locator('.lp-notiz').textContent()) ?? ''), 'loetplan: and says why', await page.locator('.lp-notiz').textContent());
  await chip('Poti').click();
  await chip('Wecker').click();
  check((await chip('Wecker').locator('.lp-chip-frage').count()) === 1, 'loetplan: the alarm start carries a "?"');
  check((await blatt.locator('path[stroke-dasharray="11 8"]').count()) > 0, 'loetplan: what is not proven is drawn dashed');
  check(/Noch nicht belegt/.test((await page.locator('.lp-offen h2').textContent()) ?? ''), 'loetplan: the note says what is not proven');
  await chip('Wecker').click();

  // Step by step: zooms to one step, the keys turn the pages.
  await page.getByRole('button', { name: 'Schritt für Schritt' }).click();
  const zaehler = page.locator('.lp-schritt-kopf b');
  check(/^Schritt 1 von \d+$/.test((await zaehler.textContent()) ?? ''), 'loetplan: step 1', await zaehler.textContent());
  await page.getByRole('button', { name: 'Weiter' }).click();
  await page.keyboard.press('ArrowRight');
  check(/^Schritt 3 von/.test((await zaehler.textContent()) ?? ''), 'loetplan: Weiter and the arrow key turn the steps', await zaehler.textContent());
  check(/A0/.test((await page.locator('.lp-schritt .lp-draehte').textContent()) ?? ''), 'loetplan: step 3 lists the wires of the buttons', await page.locator('.lp-schritt .lp-draehte').textContent());
  check((await blatt.locator('.lp-blass').count()) === 1, 'loetplan: the other wires step back');
  await page.keyboard.press('Escape');
  check(await page.locator('.lp-schritte').isVisible(), 'loetplan: Escape shows the whole picture again');

  // The rest of the build, folded.
  await page.locator('.lp-aufbau > summary').click();
  await page.getByRole('group', { name: 'Tasten' }).getByRole('button', { name: '5 Tasten' }).click();
  check(/5 Tasten/.test((await kopf()) ?? ''), 'loetplan: 5 buttons', await kopf());
  check((await chip('Drehregler').getAttribute('aria-disabled')) === 'true', 'loetplan: no knob with 5 buttons');

  // The other boards.
  await page.getByRole('radio', { name: 'AiO', exact: true }).click();
  check(/^AiO · 5 Tasten/.test((await kopf()) ?? ''), 'loetplan: the AiO', await kopf());
  check((await page.locator('.lp-chip').count()) === 4, 'loetplan: the AiO offers 4 extras', await page.locator('.lp-chip').count());
  check((await blatt.getByText('Button-Adapter', { exact: true }).count()) > 0, 'loetplan: the AiO has its button adapter');
  await page.locator('.lp-aufbau > summary').click();
  await page.getByRole('group', { name: 'Tasten' }).getByRole('button', { name: '3 Tasten' }).click();
  await page.getByRole('radio', { name: 'AiO+', exact: true }).click();
  await chip('Drehregler').click();
  check(/PF2/.test((await page.locator('.lp-schritte').textContent()) ?? ''), 'loetplan: the knob of the AiO+ at PF2');
  await chip('Drehregler').click();

  // On paper the sheet ends above the key and the steps (Prüfrunde 2, bastler 1).
  await page.emulateMedia({ media: 'print' });
  const druck = await page.evaluate(() => {
    const sheet = document.querySelector('.lp-blatt')?.getBoundingClientRect();
    const below = document.querySelector('.lp-druck')?.getBoundingClientRect();
    return sheet && below ? { sheet: Math.round(sheet.bottom), steps: Math.round(below.top) } : null;
  });
  await page.emulateMedia({ media: 'screen' });
  check(!!druck && druck.sheet <= druck.steps, 'loetplan: printed, the picture does not lie over the steps', druck);

  // The Classic without board keeps its picture of 0.5.
  await page.getByRole('radio', { name: 'Classic', exact: true }).click();
  await page.locator('.lp-aufbau > summary').click();
  await page.getByRole('group', { name: 'Classic mit oder ohne Platine' }).getByRole('button', { name: 'ohne Platine' }).click();
  await page.locator('.lp-alt svg').first().waitFor();
  check((await page.locator('.lp-blatt.lp-alt').count()) === 1, 'loetplan: without board the old picture');
  await page.getByRole('group', { name: 'Classic mit oder ohne Platine' }).getByRole('button', { name: 'Platine v1.7' }).click();
  await blatt.waitFor();

  // All wires with their sources, folded below the first screen.
  const liste = page.locator('details', { hasText: 'Alle Kabel mit Quellen' });
  check(!(await liste.evaluate((d) => d.open)), 'loetplan: the wire list is folded at first');
  await liste.locator('summary').click();
  const zeilen = liste.locator('tbody tr');
  check((await zeilen.count()) > 15, 'loetplan: the list has every wire', await zeilen.count());
  check((await zeilen.first().locator('td').last().textContent())?.length > 5, 'loetplan: each wire names its source');

  // The choice holds for the next visit.
  await chip('Leuchtring').click();
  page = await visitAgain(page, errors);
  await page.locator('.lp-blatt svg.lp-svg').first().waitFor();
  check((await page.locator('.lp-chip', { hasText: 'Leuchtring' }).getAttribute('aria-pressed')) === 'true', 'loetplan: the choice is remembered');
  await page.locator('.lp-chip', { hasText: 'Leuchtring' }).click();

  await page.getByRole('link', { name: 'Box testen', exact: true }).click();
  await page.getByRole('heading', { name: 'Box testen' }).waitFor();
  check(page.url().endsWith('#/werkstatt/testen'), 'loetplan: "Box testen" opens the guided test', page.url());
  noErrors(errors);
  await context.close();

  for (const [width, height] of [
    [412, 915],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      const phone = await openApp(browser, { theme, width, height, hash: '#/werkstatt/loetplan' });
      const p = phone.page;
      await p.locator('.lp-zoombild svg.lp-svg').waitFor();
      check((await overflow(p)) <= 0, `loetplan ${width} (${theme}): no sideways scrolling of the page`, await overflow(p));
      check((await kleinsteSchrift(p)) >= 13.9, `loetplan ${width} (${theme}): the smallest text is 14 px`, await kleinsteSchrift(p));
      check(await imBild(p.getByRole('button', { name: 'Schritt für Schritt' })), `loetplan ${width} (${theme}): "Schritt für Schritt" in view`);
      check(await p.locator('.lp-minikarte').isVisible(), `loetplan ${width} (${theme}): the small map`);
      await p.getByRole('button', { name: 'Vergrößern' }).click();
      check((await kleinsteSchrift(p)) > 15, `loetplan ${width} (${theme}): + zooms in`, await kleinsteSchrift(p));
      await p.getByRole('button', { name: 'Schritt für Schritt' }).click();
      check((await kleinsteSchrift(p)) >= 13.9, `loetplan ${width} (${theme}): a step without wires keeps 14 px`, await kleinsteSchrift(p));
      await p.getByRole('button', { name: 'Weiter' }).click();
      // The card reader: every one of its wires in view, 3.3 V too, and the warning right under the picture (Prüfrunde 1, bastler 8).
      await p.waitForTimeout(300);
      const cut = await wiresCut(p);
      check(!cut.length, `loetplan ${width} (${theme}): step 2 shows all its wires`, cut);
      check(await imBild(p.locator('.lp-achtung')), `loetplan ${width} (${theme}): step 2 shows the 3V3 warning without scrolling`);
      await p.getByRole('button', { name: 'Weiter' }).click();
      check(/^Schritt 3 von \d+$/.test((await p.locator('.lp-handy-kopf h1').textContent()) ?? ''), `loetplan ${width} (${theme}): "Schritt 3 von …" on top`);
      check(await imBild(p.getByRole('button', { name: 'Weiter' })), `loetplan ${width} (${theme}): Weiter in view`);
      check((await kleinsteSchrift(p)) >= 9, `loetplan ${width} (${theme}): the step's names stay readable`, await kleinsteSchrift(p));
      if (theme === 'dark' && width === 412) await shot(p, 'loetplan-412-dark-schritt');
      noErrors(phone.errors, `loetplan ${width} (${theme}): no errors on the page`);
      await phone.context.close();
    }
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await loetplan(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
