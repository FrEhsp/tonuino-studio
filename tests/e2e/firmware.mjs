/**
 * Werkstatt > Firmware (0.6) for Classic and AiO: „Extras“ as tiles with
 * pictures and „Deine Auswahl“ in view, grey tiles that say why, the
 * shutdown question before „Weiter“, the Lötplan with the same extras;
 * then „Verhalten“ in sentences, each with its mark (firmware or box), the
 * column „Was dafür passiert“, and „Box einstellen“ with the same answers.
 * At 1440×900 nothing scrolls; on a phone the tiles swipe and the button
 * stays in view.
 */
import { check, failed, launch, noErrors, openApp, shot } from './lib.mjs';

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Whether the element is fully inside the window, without scrolling. */
async function imBild(locator) {
  const box = await locator.boundingBox();
  const vp = locator.page().viewportSize();
  return !!box && box.y >= 0 && box.y + box.height <= vp.height + 0.5 && box.x >= 0 && box.x + box.width <= vp.width + 0.5;
}

/** Board and buttons, up to „Extras“. */
async function bisExtras(page, board = /^TonUINO Classic/, buttons = /^3 Tasten/) {
  await page.getByRole('radio', { name: board }).first().click();
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await page.getByRole('radio', { name: buttons }).first().click();
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await page.locator('.bk-schirm:not([data-vorab]) .bk').waitFor();
}

/** „Extras“ is drawn ahead while „Tasten“ is asked, out of reach; „Weiter“ only shows it (never slower than 0.5.1). */
async function vorab(browser) {
  const { page: p, errors, context } = await openApp(browser, { hash: '#/werkstatt/firmware', width: 1440, height: 900 });
  await p.getByRole('radio', { name: /^TonUINO Classic/ }).first().click();
  await p.getByRole('button', { name: 'Weiter', exact: true }).click();
  await p.getByRole('radio', { name: /^3 Tasten/ }).first().click();
  await p.locator('.bk-schirm[data-vorab] .bk-wahl').waitFor({ state: 'attached' });
  const frei = await p.evaluate(() => {
    window.__vorab = document.querySelector('.bk-schirm[data-vorab]');
    return [200, 450, 700, 1100].every((x) => [150, 400, 650, 850].every((y) => document.elementsFromPoint(x, y).every((e) => !e.closest('[data-vorab]'))));
  });
  check(frei, 'firmware: the screen drawn ahead cannot be clicked');
  await p.getByRole('button', { name: 'Weiter', exact: true }).focus();
  let drin = false;
  for (const key of [...Array(8).fill('Tab'), ...Array(12).fill('Shift+Tab')]) {
    await p.keyboard.press(key);
    drin ||= await p.evaluate(() => !!document.activeElement?.closest('[data-vorab]'));
  }
  check(!drin, 'firmware: Tab does not reach the screen drawn ahead');
  check((await p.getByRole('radio', { name: 'Drehregler', exact: true }).count()) === 0, 'firmware: screen readers do not find it either');
  await p.getByRole('button', { name: 'Weiter', exact: true }).click();
  await p.locator('.bk-schirm:not([data-vorab]) .bk').waitFor();
  check(await p.evaluate(() => document.querySelector('.bk-schirm') === window.__vorab), 'firmware: „Weiter“ shows the screen drawn ahead');
  noErrors(errors, 'firmware: no errors with the screen drawn ahead');
  await context.close();
}

export async function firmware(browser) {
  console.log('firmware: Baukasten and Verhalten');
  await vorab(browser);
  const { page, errors, context } = await openApp(browser, { hash: '#/werkstatt/firmware', width: 1440, height: 900 });
  await bisExtras(page);
  const auswahl = page.locator('.spalte .auswahl');
  const weiter = page.locator('.bk-schirm .unten .btn.primary');
  check(/Extras/.test((await page.locator('.fw-steps .step[aria-current]').textContent()) ?? ''), 'firmware: the step „Extras“');
  check((await page.locator('.fw-steps button.step').count()) === 2, 'firmware: the steps done are buttons back');
  check(await imBild(weiter), 'firmware: „Weiter“ is in view at 1440×900');
  check(await imBild(auswahl), 'firmware: „Deine Auswahl“ is in view');
  check((await weiter.textContent()) === 'Weiter: Verhalten', 'firmware: the button says where it goes', await weiter.textContent());
  check(await weiter.isDisabled(), 'firmware: no „Weiter“ before the Classic says how it switches off');
  check(/Sage zuerst, wie deine Box ausgeht/.test((await page.locator('.bk-schirm .unten').textContent()) ?? ''), 'firmware: and says why');

  // Tiles: the knob and the light, by picture.
  await page.getByRole('radio', { name: 'Drehregler', exact: true }).click();
  await page.getByRole('radio', { name: 'Leuchtring', exact: true }).click();
  await page.locator('label.teil', { hasText: 'Kopfhörer-Erkennung' }).click();
  const a = (await auswahl.textContent()) ?? '';
  check(/Drehregler A3, A4/.test(a) && /Leuchtring D5/.test(a) && /Kopfhörer-Erkennung D8/.test(a), 'firmware: „Deine Auswahl“ names the parts with their TNG pins', a);
  check(/TNG 3\.3\.3 · Classic · 3 Tasten · Drehregler · Leuchtring · Kopfhörer/.test(a), 'firmware: and the build in one line', a);
  check((await page.locator('.bk-bild svg circle[r="3.2"]').count()) === 24, 'firmware: the box picture has its ring');
  check(/Grün beim Warten/.test((await page.locator('.satz-wahl').nth(1).textContent()) ?? ''), 'firmware: one sentence on the chosen light');

  // Grey tiles say why; what cannot go now is folded with its reason.
  const grau = page.locator('.bk-kachel.gesperrt').first();
  if (await grau.count()) {
    await grau.click({ force: true });
    check((await page.locator('.satz-wahl.warum').count()) === 1, 'firmware: a grey tile says why when clicked');
  }
  const gehtNicht = page.locator('details.zugeklappt', { hasText: 'Geht gerade nicht' });
  check(/Geht gerade nicht \(\d+\)/.test((await gehtNicht.locator('summary').textContent()) ?? ''), 'firmware: „Geht gerade nicht (n)“');
  check(/Wecker-Start/.test((await gehtNicht.locator('summary').textContent()) ?? ''), 'firmware: the alarm start does not go with the ring');

  // The shutdown answer opens „Weiter“.
  await page.getByRole('group', { name: 'Wie geht deine Box aus?' }).getByRole('button', { name: 'Pololu-Schalter' }).click();
  await page.waitForFunction(() => !document.querySelector('.bk-schirm .unten .btn.primary')?.hasAttribute('disabled'));
  check(!(await weiter.isDisabled()), 'firmware: „Weiter“ after the answer');
  await shot(page, 'firmware-baukasten-1440');

  // The Lötplan with the same extras, and back.
  await page.getByRole('button', { name: 'Lötplan mit diesen Extras ansehen' }).click();
  await page.getByRole('heading', { name: 'Lötplan' }).waitFor();
  for (const n of ['Drehregler', 'Leuchtring', 'Kopfhörer', 'Ein/Aus-Schalter']) check((await page.locator('.lp-chip', { hasText: n }).first().getAttribute('aria-pressed')) === 'true', `firmware: the Lötplan has ${n} ticked`);
  await page.goBack();
  await page.locator('.bk-schirm .bk').waitFor();
  check((await page.getByRole('radio', { name: 'Drehregler', exact: true }).getAttribute('aria-checked')) === 'true', 'firmware: the choice is still there after the Lötplan');

  // Verhalten.
  await weiter.click();
  await page.locator('.saetze').waitFor();
  check(/Verhalten/.test((await page.locator('.fw-steps .step[aria-current]').textContent()) ?? ''), 'firmware: the step „Verhalten“');
  const satz = (id) => page.locator(`.satzzeile:has(#${id})`);
  check((await satz('vh-karte').locator('.vh-lang .marke-box').count()) === 1, 'firmware: „Karte weg“ is set at the box');
  check((await satz('vh-weiter').locator('.vh-lang .marke-fw').count()) === 1, 'firmware: „Play ohne Karte“ goes into the firmware');
  check((await satz('vh-karte').locator('button[aria-pressed="true"]').count()) === 0, 'firmware: nothing is answered at first');
  await satz('vh-karte').getByRole('button', { name: 'hält sie an' }).click();
  await satz('vh-weiter').getByRole('button', { name: /spielt die letzte Karte/ }).click();
  await satz('vh-laut').getByRole('button', { name: /fürs Kinderzimmer/ }).click();
  const passiert = (await page.locator('.passiert').textContent()) ?? '';
  check(/Mit Drehregler, Leuchtring, Kopfhörer-Erkennung und Weitermachen\./.test(passiert), 'firmware: „Was dafür passiert“ 1. the firmware', passiert);
  check(/Karte wegnehmen = Pause/.test(passiert) && /Lautstärke 20 \/ 1 \/ 8/.test(passiert), 'firmware: 2. the box, as in the design', passiert);
  check(await imBild(page.locator('.bk-schirm .unten .btn.primary')), 'firmware: „Weiter: Aufspielen“ in view');
  await shot(page, 'firmware-verhalten-1440');
  // „nicht ändern“ takes an answer back.
  await satz('vh-laut').getByRole('button', { name: 'nicht ändern' }).click();
  check(!/Lautstärke 20/.test((await page.locator('.passiert').textContent()) ?? ''), 'firmware: „nicht ändern“ takes the answer back');
  await satz('vh-laut').getByRole('button', { name: /fürs Kinderzimmer/ }).click();

  // On to the upload with this build.
  await page.waitForFunction(() => !document.querySelector('.bk-schirm .unten .btn.primary')?.hasAttribute('disabled'));
  await page.locator('.bk-schirm .unten .btn.primary').click();
  await page.locator('#ws-step-title').waitFor();
  const facts = (await page.locator('.ws-page').textContent()) ?? '';
  check(/Weitermachen/.test(facts) && /Drehregler/.test(facts), 'firmware: the upload has the build with „Weitermachen“', facts.slice(0, 300));
  await page.getByRole('button', { name: 'Zurück' }).first().click();
  await page.locator('.saetze').waitFor();
  check(true, 'firmware: „Zurück“ from the upload leads to „Verhalten“');

  // „Box einstellen“ has the same sentences and answers, and the steps at the box.
  await page.goto(page.url().replace(/#.*$/, '#/werkstatt/einstellen'));
  await page.getByRole('heading', { name: 'Box einstellen' }).waitFor();
  check((await page.locator('.satzzeile:has(#vh-karte) button[aria-pressed="true"]').textContent()) === 'hält sie an', 'einstellen: the answer from the wizard is here');
  check((await page.locator('.guide-steps li').count()) > 2, 'einstellen: the steps at the box are there', await page.locator('.guide-steps li').count());
  noErrors(errors);
  await context.close();

  // The AiO: only what it can have.
  {
    const aio = await openApp(browser, { hash: '#/werkstatt/firmware', width: 1440, height: 900 });
    await bisExtras(aio.page, /^All-in-One-Platine \(AiO, Version 1\)/);
    check((await aio.page.locator('.bk-wahl h2', { hasText: 'Licht' }).count()) === 0, 'firmware AiO: no light to choose');
    check(/Leuchtring/.test((await aio.page.locator('details.zugeklappt', { hasText: 'Geht gerade nicht' }).textContent()) ?? ''), 'firmware AiO: the ring is said under „Geht gerade nicht“');
    check(!(await aio.page.locator('.bk-schirm .unten .btn.primary').isDisabled()), 'firmware AiO: no shutdown question');
    noErrors(aio.errors, 'firmware AiO: no errors');
    await aio.context.close();
  }

  for (const [width, height] of [
    [412, 915],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      const phone = await openApp(browser, { theme, width, height, hash: '#/werkstatt/firmware' });
      const p = phone.page;
      await bisExtras(p);
      check((await overflow(p)) <= 0, `firmware ${width} (${theme}): no sideways scrolling of the page`, await overflow(p));
      const knopf = p.getByRole('radiogroup', { name: 'Knopf für die Lautstärke' });
      check(await knopf.evaluate((e) => e.scrollWidth > e.clientWidth), `firmware ${width} (${theme}): the tiles swipe sideways`);
      check(await imBild(p.locator('.bk-schirm .unten .btn.primary')), `firmware ${width} (${theme}): the button in view`);
      check(await p.locator('.bk-oben .auswahl').isVisible(), `firmware ${width} (${theme}): „Deine Auswahl“ next to the picture`);
      // The links of the column come after the choice, not over it.
      const unter = await p.evaluate(() => {
        const wahl = document.querySelector('.bk-wahl').getBoundingClientRect().bottom;
        const link = [...document.querySelectorAll('.bk-schirm .spalte a, .bk-schirm .spalte button')].find((e) => /Lötplan mit diesen Extras/.test(e.textContent ?? ''));
        return link ? link.getBoundingClientRect().top - wahl : -1;
      });
      check(unter >= 0, `firmware ${width} (${theme}): the links come after the choice`, unter);
      // Open „Mehr“ too, its texts count as well. Only what is shown: the desktop steps are hidden on a phone.
      await p.locator('details.zugeklappt:has(.bk-mehr-inhalt)').evaluate((e) => (e.open = true));
      const klein = await p.evaluate(() => Math.min(...[...document.querySelectorAll('.bk-schirm .gross *')].filter((e) => e.getClientRects().length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize))));
      check(klein >= 14, `firmware ${width} (${theme}): the smallest text is 14 px`, klein);
      await p.getByRole('group', { name: 'Wie geht deine Box aus?' }).getByRole('button', { name: 'Weiß ich nicht' }).evaluate((e) => e.click());
      await p.waitForFunction(() => !document.querySelector('.bk-schirm .unten .btn.primary')?.hasAttribute('disabled'));
      await p.locator('.bk-schirm .unten .btn.primary').click();
      await p.locator('.saetze').waitFor();
      check((await overflow(p)) <= 0, `firmware ${width} (${theme}): Verhalten without sideways scrolling`, await overflow(p));
      check(await p.locator('.vh-danach').isVisible(), `firmware ${width} (${theme}): „Danach: 1× aufspielen …“`);
      check(await imBild(p.locator('.bk-schirm .unten .btn.primary')), `firmware ${width} (${theme}): „Weiter: Aufspielen“ in view`);
      if (width === 412 && theme === 'dark') await shot(p, 'firmware-verhalten-412-dark');
      noErrors(phone.errors, `firmware ${width} (${theme}): no errors on the page`);
      await phone.context.close();
    }
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await firmware(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
