/**
 * Werkstatt > Lötplan: the card on the overview, the switches above the
 * picture, the folded steps, wire list and extras, the link to the guided "Box testen", and
 * no sideways scrolling on a phone, light and dark.
 */
import { check, failed, launch, noErrors, openApp, shot } from './lib.mjs';

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function loetplan(browser) {
  console.log('loetplan: Werkstatt > Lötplan');
  const { page, errors, context } = await openApp(browser, { hash: '#/werkstatt' });
  const card = page.locator('a.ws-tool[href="#/werkstatt/loetplan"]');
  check(await card.isVisible(), 'loetplan: the Werkstatt lists the Lötplan');
  await card.click();
  await page.getByRole('heading', { name: 'Lötplan' }).waitFor();
  const sketch = page.locator('svg.lp-sketch');
  await sketch.waitFor();
  const caps = () => sketch.evaluate((svg) => [...svg.querySelectorAll('circle[r="23"]')].map((c) => c.getAttribute('fill')));
  check((await caps()).length === 3, 'loetplan: 3 buttons by default', await caps());

  await page.getByRole('group', { name: 'Tasten' }).getByRole('button', { name: '5 Tasten' }).click();
  check((await caps()).length === 5, 'loetplan: the switch draws 5 buttons', await caps());
  check(/5 Tasten/.test((await page.locator('.lp-caption').textContent()) ?? ''), 'loetplan: the caption says 5 buttons');

  await page.getByRole('group', { name: 'Kopfhörerbuchse' }).getByRole('button', { name: 'einzelne Buchse' }).click();
  check(await sketch.getByText('Klinkenbuchse FC68129').isVisible(), 'loetplan: a single socket is drawn');
  await page.getByRole('group', { name: 'Kopfhörerbuchse' }).getByRole('button', { name: 'keine' }).click();
  check((await sketch.getByText('Kopfhörerplatine').count()) === 0 && (await sketch.getByText('Klinkenbuchse FC68129').count()) === 0, 'loetplan: without a socket only the speaker is left');

  // Details stay folded until asked for.
  const list = page.locator('details', { hasText: 'Alle Kabel als Liste' });
  check(!(await list.evaluate((d) => d.open)), 'loetplan: the wire list is folded at first');
  await list.locator('summary').click();
  check((await list.locator('tbody tr').count()) === 8 + 10 + 2 + 1, 'loetplan: the list has every wire of 5 buttons without socket, plus the power cable', await list.locator('tbody tr').count());

  // Extras: chosen under "Mehr", each with its own picture; the ones on the same pin switch each other off.
  const mehr = page.locator('details', { hasText: 'Mehr: Extras' });
  check(!(await mehr.evaluate((d) => d.open)), 'loetplan: the extras are folded at first');
  await mehr.locator('summary').first().click();
  await mehr.getByRole('checkbox', { name: /LED-Ring/ }).check();
  check(await mehr.getByRole('img', { name: 'Extra: LED-Ring. Jede Farbe ist ein Kabel.' }).isVisible(), 'loetplan: a chosen extra gets its own picture');
  await mehr.getByRole('checkbox', { name: /Tasten mit LED/ }).check();
  check(!(await mehr.getByRole('checkbox', { name: /LED-Ring/ }).isChecked()), 'loetplan: LED buttons switch the ring off (both on D5)');
  check(await mehr.getByRole('checkbox', { name: /Drehknopf/ }).isDisabled(), 'loetplan: no knob with 5 buttons');
  await mehr.getByRole('checkbox', { name: /Tasten mit LED/ }).uncheck();
  await mehr.locator('summary').first().click();

  const steps = page.locator('details', { hasText: 'Schritt für Schritt' });
  await steps.locator('summary').click();
  await steps.getByRole('button', { name: '2 Kartenleser' }).click();
  check(await steps.getByText('Kartenleser nur an 3V3 (orange).').isVisible(), 'loetplan: step 2 warns about 5 volts');
  check(await sketch.getByText('3,3 V – nie 5 V!').isVisible(), 'loetplan: the picture puts the 3.3 V note on tape');

  // The choice holds for the next visit.
  await page.reload();
  await page.locator('svg.lp-sketch').waitFor();
  check((await caps()).length === 5, 'loetplan: the choice is remembered');
  await page.getByRole('group', { name: 'Tasten' }).getByRole('button', { name: '3 Tasten' }).click();
  await page.getByRole('group', { name: 'Kopfhörerbuchse' }).getByRole('button', { name: 'Kopfhörerplatine' }).click();

  await page.getByRole('link', { name: 'Box testen', exact: true }).click();
  await page.getByRole('heading', { name: 'Box testen' }).waitFor();
  check(page.url().endsWith('#/werkstatt/testen'), 'loetplan: "Box testen" opens the guided test', page.url());
  noErrors(errors);
  await context.close();

  for (const theme of ['light', 'dark']) {
    const phone = await openApp(browser, { theme, width: 390, height: 844, hash: '#/werkstatt/loetplan' });
    await phone.page.locator('svg.lp-sketch').waitFor();
    check((await overflow(phone.page)) <= 0, `loetplan (${theme}): no sideways scrolling at 390 px`, await overflow(phone.page));
    if (theme === 'dark') await shot(phone.page, 'loetplan-390-dark');
    noErrors(phone.errors, `loetplan (${theme}): no errors on the page`);
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
