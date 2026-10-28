import { describe, expect, it } from 'vitest';
import { decodeCard, encodeCard, type CardData } from '../../src/core/tonuino/card';
import { holdsOther, newRunMemory, writeCards, type ReaderPort, type RunEvents, type RunMemory } from '../../src/features/cards/readerRun';

const folder = (n: number): CardData => ({ folder: n, mode: 5, special: 0, special2: 0 });
const ITEMS = [7, 8, 9].map((n) => ({ key: `f${n}`, data: folder(n) }));

/**
 * A reader the test puts cards on: each waitForCard takes the next card of
 * `placed`; when there is none, the parent pressed "Anhalten".
 */
function reader(placed: string[], cards = new Map<string, Uint8Array>()) {
  let onReader: string | null = null;
  const port: ReaderPort = {
    waitForCard: async () => {
      const uid = placed.shift();
      if (!uid) return null;
      onReader = uid;
      return { uid, type: 'mifare-classic-1k' };
    },
    waitForRemoval: async () => {
      onReader = null;
      return true;
    },
    read: async () => ({ data: cards.get(onReader!) ?? new Uint8Array(16) }),
    write: async (data) => {
      cards.set(onReader!, data);
    },
  };
  /** The folder a card plays, or null when it is empty. */
  const plays = (uid: string) => {
    const d = decodeCard(cards.get(uid) ?? new Uint8Array(16));
    return d.kind === 'tonuino' ? d.data.folder : null;
  };
  return { port, cards, plays };
}

function recorder() {
  const log: string[] = [];
  const events: RunEvents = {
    waiting: (i) => log.push(`waiting ${ITEMS[i].key}`),
    clash: (uid, key) => log.push(`clash ${uid} holds ${key}`),
    occupied: (uid, data) => {
      const d = decodeCard(data);
      log.push(`occupied ${uid}: ${d.kind === 'tonuino' ? `folder ${d.data.folder}` : d.kind}`);
    },
    writing: () => {},
    written: (key, _before, replaced) => log.push(replaced ? `written ${key}, ${replaced} has no card` : `written ${key}`),
    remove: () => {},
  };
  return { log, events };
}

const run = (port: ReaderPort, memory: RunMemory, events: RunEvents, start = 0, overwrite?: string) => writeCards(ITEMS, start, port, memory, events, new AbortController().signal, overwrite);

describe('writing cards with the reader', () => {
  it('a card put back on the reader is not overwritten with the next item', async () => {
    const r = reader(['A', 'A', 'B', 'C']);
    const { log, events } = recorder();
    expect(await run(r.port, newRunMemory(), events)).toEqual({ kind: 'done' });
    expect(log).toEqual(['waiting f7', 'written f7', 'waiting f8', 'clash A holds f7', 'waiting f8', 'written f8', 'waiting f9', 'written f9']);
    expect([r.plays('A'), r.plays('B'), r.plays('C')]).toEqual([7, 8, 9]);
  });

  it('remembers the cards across "Anhalten" and "Weiter beschreiben"', async () => {
    const cards = new Map<string, Uint8Array>();
    const memory = newRunMemory();
    // Card A gets folder 07, then the parent stops while it still lies on the reader.
    expect(await run(reader(['A'], cards).port, memory, recorder().events)).toEqual({ kind: 'stopped' });
    const r = reader(['A', 'B', 'C'], cards);
    const { log, events } = recorder();
    expect(await run(r.port, memory, events, 1)).toEqual({ kind: 'done' });
    expect(log[1]).toBe('clash A holds f7');
    expect([r.plays('A'), r.plays('B'), r.plays('C')]).toEqual([7, 8, 9]);
  });

  it('overwrites only when asked, and the earlier item then needs a card again', async () => {
    const cards = new Map<string, Uint8Array>();
    const memory = newRunMemory();
    await run(reader(['A'], cards).port, memory, recorder().events);
    // The parent chose "Trotzdem überschreiben" for card A while waiting for 08.
    const r = reader(['A', 'C'], cards);
    const { log, events } = recorder();
    expect(await run(r.port, memory, events, 1, 'A')).toEqual({ kind: 'done' });
    expect(log).toEqual(['waiting f8', 'written f8, f7 has no card', 'waiting f9', 'written f9']);
    expect([...memory.done].sort()).toEqual(['f8', 'f9']);
    // The permission was for one write: A put back again is refused.
    const again = reader(['A', 'B'], cards);
    const rec = recorder();
    await run(again.port, memory, rec.events);
    expect(rec.log).toEqual(['waiting f7', 'clash A holds f8', 'waiting f7', 'written f7']);
    expect([again.plays('A'), again.plays('B'), again.plays('C')]).toEqual([8, 7, 9]);
  });

  it('skips items that already have their card', async () => {
    const memory = newRunMemory();
    memory.done.add('f8');
    const r = reader(['X', 'Y']);
    const { log, events } = recorder();
    await run(r.port, memory, events);
    expect(log).toEqual(['waiting f7', 'written f7', 'waiting f9', 'written f9']);
  });

  it('asks before overwriting a card that holds something from before', async () => {
    const cards = new Map([
      ['OLD', encodeCard(folder(3))],
      ['ODD', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])],
    ]);
    const memory = newRunMemory();
    const r = reader(['OLD', 'ODD', 'NEW'], cards);
    const { log, events } = recorder();
    // Nothing was overwritten: both cards wait until they are taken off, an empty one takes the item.
    expect(await run(r.port, memory, events)).toEqual({ kind: 'stopped' });
    expect(log).toEqual(['waiting f7', 'occupied OLD: folder 3', 'waiting f7', 'occupied ODD: foreign', 'waiting f7', 'written f7', 'waiting f8']);
    expect(r.plays('OLD')).toBe(3);
    // The parent chose "Überschreiben" for OLD: only that card, only once.
    const again = reader(['OLD', 'ODD'], cards);
    const rec = recorder();
    expect(await run(again.port, memory, rec.events, 1, 'OLD')).toEqual({ kind: 'stopped' });
    expect(rec.log).toEqual(['waiting f8', 'written f8', 'waiting f9', 'occupied ODD: foreign', 'waiting f9']);
    // "Immer überschreiben": no more questions in this run.
    memory.overwriteAll = true;
    const last = reader(['ODD'], cards);
    const end = recorder();
    expect(await run(last.port, memory, end.events, 2)).toEqual({ kind: 'done' });
    expect(end.log).toEqual(['waiting f9', 'written f9']);
  });

  it('writes a card that holds this very item already without asking', async () => {
    const cards = new Map([['SAME', encodeCard(folder(7))]]);
    const { log, events } = recorder();
    await run(reader(['SAME'], cards).port, newRunMemory(), events);
    expect(log.slice(0, 2)).toEqual(['waiting f7', 'written f7']);
    expect(holdsOther(encodeCard(folder(7)), folder(7))).toBe(false);
    expect(holdsOther(new Uint8Array(16), folder(7))).toBe(false);
    expect(holdsOther(encodeCard({ ...folder(7), mode: 2 }), folder(7))).toBe(true);
  });

  it('a card that holds this very item may be written again', async () => {
    const memory = newRunMemory();
    memory.writtenTo.set('A', 'f7');
    const { log, events } = recorder();
    await run(reader(['A']).port, memory, events);
    expect(log.slice(0, 2)).toEqual(['waiting f7', 'written f7']);
  });

  it('does not write blindly after the card left while it was read (Testlabor)', async () => {
    const cards = new Map([['B', encodeCard(folder(3))]]);
    const r = reader(['A', 'B'], cards);
    let reads = 0;
    const read = r.port.read;
    r.port.read = async () => {
      if (reads++ === 0) throw Object.assign(new Error('gone'), { code: 'tag-lost' });
      return read();
    };
    const { log, events } = recorder();
    await run(r.port, newRunMemory(), events);
    // A left during the read; B came: it is read and asked about, not overwritten.
    expect(log.slice(0, 3)).toEqual(['waiting f7', 'waiting f7', 'occupied B: folder 3']);
    expect(r.plays('B')).toBe(3);
  });

  it('names the card it read when writing, and looks again when the phone has another one by then (Testlabor)', async () => {
    const cards = new Map([['B', encodeCard(folder(3))]]);
    const r = reader(['A', 'B'], cards);
    const meant: string[] = [];
    const write = r.port.write;
    r.port.write = async (data, uid) => {
      meant.push(uid);
      // The phone holds B already: the write for A is refused, nothing written.
      if (meant.length === 1) throw Object.assign(new Error('other card'), { code: 'wrong-card' });
      return write(data, uid);
    };
    const { log, events } = recorder();
    await run(r.port, newRunMemory(), events);
    expect(meant).toEqual(['A']);
    expect(log.slice(0, 3)).toEqual(['waiting f7', 'waiting f7', 'occupied B: folder 3']);
    expect(r.plays('B')).toBe(3);
  });

  it('writes again without asking onto a card whose write broke off (Testlabor)', async () => {
    const cards = new Map<string, Uint8Array>();
    const memory = newRunMemory();
    const r = reader(['A'], cards);
    r.port.write = async () => {
      // Taken away after the first page: the cookie is on the card, the rest is not.
      cards.set('A', Uint8Array.from([0x13, 0x37, 0xb3, 0x47, ...new Uint8Array(12)]));
      throw Object.assign(new Error('gone'), { code: 'tag-lost' });
    };
    expect((await run(r.port, memory, recorder().events)).kind).toBe('failed');
    const { log, events } = recorder();
    const again = reader(['A', 'B', 'C'], cards);
    expect(await run(again.port, memory, events)).toEqual({ kind: 'done' });
    expect(log.slice(0, 2)).toEqual(['waiting f7', 'written f7']);
  });
});

describe('reading the card back after writing (0.6, „Karte beschreiben“)', () => {
  it('says the card holds what was written, before it waits for the card to go', async () => {
    const r = reader(['A']);
    const { log, events } = recorder();
    events.verified = (key, ok) => log.push(`verified ${key} ${ok}`);
    expect(await writeCards(ITEMS.slice(0, 1), 0, r.port, newRunMemory(), events, new AbortController().signal)).toEqual({ kind: 'done' });
    expect(log).toEqual(['waiting f7', 'verified f7 true', 'written f7']);
  });

  it('says so when the card holds something else afterwards, or could not be read', async () => {
    const r = reader(['A', 'B']);
    // A card that keeps its old content (the write did not take).
    r.port.write = async () => {};
    const { log, events } = recorder();
    events.verified = (key, ok) => log.push(`verified ${key} ${ok}`);
    await writeCards(ITEMS.slice(0, 1), 0, r.port, newRunMemory(), events, new AbortController().signal);
    expect(log).toContain('verified f7 false');
    const gone = reader(['C']);
    let reads = 0;
    const read = gone.port.read;
    gone.port.read = async () => {
      if (++reads > 1) throw Object.assign(new Error('weg'), { code: 'tag-lost' });
      return read();
    };
    const second = recorder();
    second.events.verified = (key, ok) => second.log.push(`verified ${key} ${ok}`);
    await writeCards(ITEMS.slice(0, 1), 0, gone.port, newRunMemory(), second.events, new AbortController().signal);
    expect(second.log).toContain('verified f7 false');
  });

  it('does not read again when nobody listens (the list of many cards)', async () => {
    const r = reader(['A']);
    let reads = 0;
    const read = r.port.read;
    r.port.read = async () => {
      reads++;
      return read();
    };
    await writeCards(ITEMS.slice(0, 1), 0, r.port, newRunMemory(), recorder().events, new AbortController().signal);
    expect(reads).toBe(1);
  });
});
