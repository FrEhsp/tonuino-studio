/**
 * Testlabor, NFC am Handy (TODO #69): the Android app's NFC (AndroidNfc)
 * against a phone that behaves like TonuinoNfc.kt with real card types
 * (nfc/simphone.ts). Writing runs through the app's writeCards with the
 * port ReaderPanel.tsx builds; a "person" holds cards to the phone and
 * takes them away when the page says so, sometimes too early.
 */
import { describe, expect, it } from 'vitest';
import { decodeCard, encodeCard, type CardData } from '../../src/core/tonuino/card';
import { handleTap, tappedCard } from '../../src/features/cards/nfcTap';
import { newRunMemory, readCardNow, writeCards, type ReaderPort, type RunEnd, type RunEvents } from '../../src/features/cards/readerRun';
import { AndroidNfc, PHONE_READER } from '../../src/platform/tauri/nfcAndroid';
import type { NfcAccess, NfcCardInfo } from '../../src/platform/types';
import { laborOn, sleep } from './labor';
import { SimPhone, tag, type SimTag } from './nfc/simphone';

/** The port ReaderPanel.tsx builds for the phone (kept in step with it). */
function panelPort(nfc: NfcAccess, reader = PHONE_READER): ReaderPort {
  return {
    waitForCard: async (signal) => {
      while (!signal.aborted) {
        const c = await nfc.waitForCard(reader, 1500);
        if (c) return c;
      }
      return null;
    },
    waitForRemoval: async (uid, signal) => {
      while (!signal.aborted) {
        const c = await nfc.waitForCard(reader, 250);
        if (!c || c.uid !== uid) return true;
        await sleep(350);
      }
      return false;
    },
    read: () => nfc.read(reader),
    write: (data, uid) => nfc.write(reader, data, uid),
  };
}

const item = (folder: number, mode = 2): { key: string; data: CardData } => ({ key: `f${folder}`, data: { folder, mode, special: 0, special2: 0 } });
const content = (t: SimTag) => decodeCard(t.data);

interface Rig {
  phone: SimPhone;
  nfc: AndroidNfc;
  log: string[];
  events: RunEvents;
  /** What the page shows right now. */
  phase: () => string;
  /** The person: what they do when the page says something. */
  react: (event: string, r: Rig) => void;
}

function rig(react: (event: string, r: Rig) => void = () => undefined): Rig {
  const host: { __tonuinoNfc?: never } = {};
  const phone = new SimPhone(host as never);
  const nfc = new AndroidNfc(phone, host as never);
  const log: string[] = [];
  let phase = 'idle';
  const r: Rig = {
    phone,
    nfc,
    log,
    react,
    phase: () => phase,
    events: {
      waiting: (i) => ((phase = 'waiting'), log.push(`waiting ${i}`), r.react(`waiting ${i}`, r)),
      clash: (uid, key) => ((phase = 'clash'), log.push(`clash ${uid} ${key}`), r.react('clash', r)),
      occupied: (uid) => ((phase = 'occupied'), log.push(`occupied ${uid}`), r.react('occupied', r)),
      writing: () => ((phase = 'writing'), log.push('writing')),
      written: (key) => ((phase = 'written'), log.push(`written ${key}`)),
      remove: () => ((phase = 'remove'), log.push('remove'), r.react('remove', r)),
    },
  };
  return r;
}

async function run(r: Rig, items: { key: string; data: CardData }[], memory = newRunMemory(), timeoutMs = 20_000): Promise<RunEnd> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // The cards page looks for the reader first (ReaderPanel findReaders): reader mode goes on.
    await r.nfc.listReaders();
    return await writeCards(items, 0, panelPort(r.nfc), memory, r.events, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!laborOn)('Testlabor: NFC am Handy', () => {
  it('beschreibt NTAG215, Ultralight und MIFARE Classic nacheinander, jede Karte richtig', async () => {
    const cards = [tag('04A1B2C3D4E501', 'ntag215'), tag('04A1B2C3D4E502', 'mifare-ultralight'), tag('A1B2C3D4', 'mifare-classic-1k')];
    let next = 0;
    const r = rig((e, r) => {
      if (e.startsWith('waiting')) setTimeout(() => r.phone.hold(cards[next++]), 30);
      if (e === 'remove') setTimeout(() => r.phone.takeAway(), 80);
    });
    const items = [item(1), item(2), item(3)];
    const end = await run(r, items);
    expect(end).toEqual({ kind: 'done' });
    cards.forEach((c, i) => expect(content(c)).toEqual({ kind: 'tonuino', data: { version: 2, ...items[i].data } }));
  });

  it('Karte zu kurz am Handy: klare Meldung; beim zweiten Versuch mit derselben Karte wird ohne Rückfrage fertig geschrieben', async () => {
    const card = tag('04C0FFEE000001', 'ntag213');
    const r = rig();
    // Taken away after the first page: the cookie is on the card, the rest is not.
    r.phone.hooks.beforePage = (_t, page) => {
      if (page === 9) r.phone.takeAway();
    };
    const memory = newRunMemory();
    r.phone.hold(card);
    const end = await run(r, [item(5)], memory);
    expect(end.kind).toBe('failed');
    const err = (end as { error: Error & { code: string } }).error;
    expect(err.code).toBe('tag-lost');
    expect(err.message).toMatch(/zu kurz/);
    expect(decodeCard(card.data).kind).not.toBe('empty');
    // "Noch einmal": the same card, held properly now.
    r.phone.hooks = {};
    r.react = (e, rr) => {
      if (e === 'remove') setTimeout(() => rr.phone.takeAway(), 50);
    };
    r.phone.hold(card);
    const end2 = await run(r, [item(5)], memory, 8000);
    // The app wrote that card a moment ago itself: no "Die Karte enthält schon etwas".
    expect(r.log.filter((l) => l.startsWith('occupied'))).toEqual([]);
    expect(end2).toEqual({ kind: 'done' });
    expect(content(card)).toEqual({ kind: 'tonuino', data: { version: 2, folder: 5, mode: 2, special: 0, special2: 0 } });
  });

  it('schneller Kartenwechsel: nächste Karte sofort nach dem Wegnehmen, jede bekommt ihren Inhalt', async () => {
    const cards = [tag('04000000000011', 'ntag215'), tag('04000000000012', 'ntag215'), tag('04000000000013', 'ntag215')];
    let next = 0;
    const r = rig((e, r) => {
      // Already on its way: the next card comes the moment the last one leaves.
      if (e === 'remove') setTimeout(() => (r.phone.takeAway(), next < cards.length && r.phone.hold(cards[next++])), 5);
    });
    r.phone.hold(cards[next++]);
    const items = [item(1), item(2), item(3)];
    const end = await run(r, items);
    expect(end).toEqual({ kind: 'done' });
    expect(cards.map((c) => (content(c) as { data?: CardData }).data?.folder)).toEqual([1, 2, 3]);
  });

  it('Kartenwechsel zwischen Lesen und Schreiben: eine fremde Karte wird nicht ungefragt überschrieben', async () => {
    const mine = tag('04000000000021', 'ntag215');
    const theirs = tag('04000000000022', 'ntag215', encodeCard({ folder: 9, mode: 5, special: 0, special2: 0 }));
    const r = rig((e, rr) => {
      if (e === 'remove') setTimeout(() => rr.phone.takeAway(), 30);
    });
    // The empty card was read; right then it is swapped for a card that holds another box's card.
    r.phone.hooks.beforeWrite = () => undefined;
    r.phone.hold(mine);
    let swapped = false;
    r.phone.hooks.beforeRead = () => {
      if (swapped) return;
      swapped = true;
      setTimeout(() => {
        r.phone.takeAway();
        r.phone.hold(theirs);
      }, 0);
    };
    const end = await run(r, [item(1)], newRunMemory(), 6000);
    // Either the write did not go to the other card, or the run stopped to ask.
    expect(decodeCard(theirs.data)).toEqual({ kind: 'tonuino', data: { version: 2, folder: 9, mode: 5, special: 0, special2: 0 } });
    expect(['done', 'failed', 'stopped']).toContain(end.kind);
  });

  it('neue Karte gleich nach dem Lesen, ihre Meldung noch unterwegs: das Handy schreibt nicht auf sie', async () => {
    const mine = tag('04000000000031', 'ntag215');
    const theirs = tag('04000000000032', 'ntag215', encodeCard({ folder: 9, mode: 5, special: 0, special2: 0 }));
    // Asked about the other card, the person swaps back to the empty one.
    const r = rig((e, rr) => {
      if (e === 'occupied')
        setTimeout(() => {
          rr.phone.takeAway();
          rr.phone.hold(mine);
        }, 30);
      if (e === 'remove') setTimeout(() => rr.phone.takeAway(), 30);
    });
    r.phone.hold(mine);
    let swapped = false;
    // Right after the empty card was read the other one comes: Android knows it before the page does.
    r.phone.hooks.afterRead = () => {
      if (swapped) return;
      swapped = true;
      r.phone.takeAway();
      r.phone.hold(theirs);
    };
    const end = await run(r, [item(1)], newRunMemory(), 8000);
    expect(content(theirs)).toEqual({ kind: 'tonuino', data: { version: 2, folder: 9, mode: 5, special: 0, special2: 0 } });
    expect(r.log).toContain('occupied 04:00:00:00:00:00:32');
    expect(end.kind).toBe('done');
    expect(content(mine)).toMatchObject({ kind: 'tonuino', data: { folder: 1 } });
  });

  it('Karte auflegen und gleich die nächste: angezeigt wird die letzte, nicht die erste', async () => {
    const r = rig();
    const a = tag('04000000000031', 'ntag215', encodeCard({ folder: 1, mode: 2, special: 0, special2: 0 }));
    const b = tag('04000000000032', 'ntag215', encodeCard({ folder: 7, mode: 2, special: 0, special2: 0 }));
    const deps = { page: () => 'cards' as const, dialogOpen: () => false, open: () => undefined, note: () => undefined, describe: () => '', reader: PHONE_READER };
    const taps: Promise<void>[] = [];
    r.nfc.onTap((c: NfcCardInfo) => taps.push(handleTap(r.nfc, c, deps)));
    r.phone.hold(a);
    await sleep(2);
    r.phone.takeAway();
    r.phone.hold(b);
    await r.phone.idle();
    await sleep(50);
    await Promise.all(taps);
    expect(tappedCard.value?.uid).toBe('04:00:00:00:00:00:32');
    expect(decodeCard(tappedCard.value!.data!)).toMatchObject({ kind: 'tonuino', data: { folder: 7 } });
  });

  it('falscher Kartentyp (DESFire, Bankkarte): „passt nicht“, nichts geschrieben', async () => {
    const r = rig();
    r.phone.hold(tag('04112233445566', 'desfire'));
    const end = await run(r, [item(1)], newRunMemory(), 6000);
    expect(end.kind).toBe('failed');
    expect((end as { error: Error }).error.message).toMatch(/passt nicht/);
    expect(r.phone.writes).toEqual([]);
  });

  it('MIFARE Classic am Handy ohne NXP-Chip und mit geändertem Schlüssel: die Meldung sagt, was zu tun ist', async () => {
    const r = rig();
    r.phone.nxpChip = false;
    r.phone.hold(tag('A1B2C3D5', 'mifare-classic-1k'));
    const end = await run(r, [item(1)], newRunMemory(), 6000);
    expect((end as { error: Error }).error.message).toMatch(/NTAG213 oder NTAG215/);
    const r2 = rig();
    r2.phone.hold(tag('A1B2C3D6', 'mifare-classic-1k', undefined, { key: 'ndef' }));
    const end2 = await run(r2, [item(1)], newRunMemory(), 6000);
    const err = (end2 as { error: Error & { hints: { id: string }[] } }).error;
    expect(err.hints.map((h) => h.id)).toEqual(['card-ndef-formatted']);
  });

  it('schreibgeschützte Karte: Schreiben scheitert, die Meldung schickt nicht endlos zum „ruhig halten“', async () => {
    const r = rig();
    const locked = tag('04000000000041', 'ntag213', encodeCard({ folder: 3, mode: 2, special: 0, special2: 0 }), { locked: true });
    r.phone.hold(locked);
    const memory = newRunMemory();
    memory.overwriteAll = true;
    const end = await run(r, [item(1)], memory, 6000);
    expect(end.kind).toBe('failed');
    const err = (end as { error: Error & { code: string } }).error;
    expect(err.message).not.toMatch(/zu kurz/);
    expect(decodeCard(locked.data)).toMatchObject({ kind: 'tonuino', data: { folder: 3 } });
  });

  it('NFC aus, dann eingeschaltet: erst die Bitte zum Einschalten, danach geht es', async () => {
    const r = rig();
    r.phone.nfc = 'off';
    await expect(r.nfc.listReaders()).rejects.toMatchObject({ code: 'nfc-off' });
    r.phone.nfc = 'on';
    expect(await r.nfc.listReaders()).toEqual([PHONE_READER]);
    const c = tag('04000000000051', 'ntag215', encodeCard({ folder: 4, mode: 1, special: 0, special2: 0 }));
    setTimeout(() => r.phone.hold(c), 50);
    const read = await readCardNow(r.nfc, PHONE_READER, 2000);
    expect(read && decodeCard(read.data)).toMatchObject({ kind: 'tonuino', data: { folder: 4 } });
  });

  it('„Karte prüfen“ ohne Karte: wartet, gibt dann ruhig auf', async () => {
    const r = rig();
    await r.nfc.listReaders();
    const t0 = Date.now();
    expect(await readCardNow(r.nfc, PHONE_READER, 400)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
