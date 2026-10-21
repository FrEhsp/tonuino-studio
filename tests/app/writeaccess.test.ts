import { afterEach, describe, expect, it } from 'vitest';
import { boot, card, closeCard, fixCardAccess, platform } from '../../src/app/state';
import { canFixOn, fixTarget, fixWriteAccess, writeErrorAction, writeNoticeKind, writeNoticeText } from '../../src/features/box/writeAccess';
import { isAccessLost, isWriteDenied, withoutBoxHint, WRITE_DENIED_HINT } from '../../src/features/box/writeDenied';
import { explainFsError } from '../../src/platform/web/fsa';
import { restoreErrorText } from '../../src/features/box/rebuildTexts';
import { CopyError } from '../../src/core/tonuino/rebuild';
import { memDir } from '../../src/platform/memory';
import { messageFor } from '../../src/platform/tauri/errors';
import type { Platform, Volume, VolumeInfo } from '../../src/platform/types';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function volume(id: string, info: VolumeInfo): Volume {
  return { id, label: 'TONUINO', root: memDir({}, 'TONUINO'), info, canEject: true };
}

describe('the notice on "Meine Box"', () => {
  const direct = { access: undefined };
  const kind = (info: VolumeInfo, canFix = true, writeDenied = false) => writeNoticeKind({ info, writeDenied, volume: direct }, canFix);

  it('says nothing about a card the app may write to, or where it cannot tell', () => {
    expect(kind({ writable: true })).toBeNull();
    // The browser knows nothing about rights: no notice.
    expect(kind({})).toBeNull();
  });

  it('offers "Schreibrechte holen" where the app can mount the card again', () => {
    expect(kind({ writable: false, foreignOwner: true, canFixAccess: true })).toBe('fix');
    // Windows and macOS, or a Linux without a way to mount again: no button.
    expect(kind({ writable: false, canFixAccess: true }, false)).toBe('denied');
    expect(kind({ writable: false, canFixAccess: false })).toBe('denied');
  });

  it('a write that failed for lack of rights counts even when the card looked writable', () => {
    expect(kind({ writable: true }, true, true)).toBe('denied');
    expect(kind({ writable: true, canFixAccess: true }, true, true)).toBe('fix');
  });

  it('a read-only card gets the lock slider, never the button', () => {
    expect(kind({ writable: false, readOnly: true, canFixAccess: true })).toBe('read-only');
    expect(writeNoticeText('read-only', false)).toMatch(/Schalter/);
    expect(writeNoticeText('fix', true)).toMatch(/„Schreibrechte holen“/);
    expect(writeNoticeText('fix', true)).toMatch(/anderen Konto/);
    expect(writeNoticeText('fix', false)).not.toMatch(/anderen Konto/);
    expect(writeNoticeText('denied', false)).toMatch(/auswerfen|Wirf die Karte/);
  });

  it('a snapshot of the card (Firefox, Safari) never gets the notice', () => {
    expect(writeNoticeKind({ info: { writable: false }, volume: { access: 'snapshot' } }, true)).toBeNull();
  });
});

describe('the error text when writing is not allowed', () => {
  it('no longer blames the lock slider; that is the read-only case', () => {
    expect(messageFor('permission', 'fs')).not.toMatch(/Schieber|Schalter/);
    expect(messageFor('permission', 'fs')).toMatch(/Schreibrechte/);
    expect(messageFor('permission', 'fs')).toMatch(/Meine Box/);
    expect(messageFor('read-only', 'fs')).toMatch(/Schalter/);
  });

  it('tells the next step when mounting again fails', () => {
    for (const code of ['permission', 'unsupported', 'other', 'unchanged']) {
      expect(messageFor(code, 'remount'), code).toMatch(/im Dateimanager aus, ziehe sie heraus und stecke sie neu ein/);
    }
    expect(messageFor('busy', 'remount')).toMatch(/Dateimanager/);
    expect(messageFor('read-only', 'remount')).toMatch(/Schalter/);
  });
});

describe('"Schreibrechte holen"', () => {
  afterEach(() => {
    closeCard();
    platform.value = null;
  });

  function linuxPlatform(list: Volume[], fresh?: Volume): Platform & { denied: (id: string) => void } {
    let denied: (id: string) => void = () => undefined;
    const p = {
      volumes: {
        subscribe: (cb: (v: Volume[]) => void) => {
          cb(list);
          return () => undefined;
        },
        info: async (v: Volume) => v.info,
        fixAccess: async () => fresh!,
        onWriteDenied: (cb: (id: string) => void) => {
          denied = cb;
          return () => undefined;
        },
      },
      denied: (id: string) => denied(id),
    };
    return p as unknown as Platform & { denied: (id: string) => void };
  }

  it('opens the card again from where it is mounted now', async () => {
    const old = volume('/mnt/usb-Generic_STORAGE_DEVICE_000000000819-0:0-part1', { writable: false, foreignOwner: true, canFixAccess: true });
    const fresh = volume('/media/ben/TONUINO', { writable: true });
    boot(linuxPlatform([old], fresh));
    await settle();
    await settle();
    expect(card.value?.volume.id).toBe(old.id);
    expect(writeNoticeKind(card.value!, canFixOn(platform.value))).toBe('fix');
    await fixCardAccess();
    expect(card.value?.volume.id).toBe('/media/ben/TONUINO');
    expect(card.value?.error).toBeUndefined();
    expect(card.value?.status).toBe('ready');
    expect(writeNoticeKind(card.value!, true)).toBeNull();
  });

  it('a denied write on the open card shows the notice, and its toast gets the button', async () => {
    const v = volume('/media/ben/TONUINO', { writable: true, canFixAccess: true });
    const p = linuxPlatform([v]);
    boot(p);
    await settle();
    await settle();
    expect(writeNoticeKind(card.value!, true)).toBeNull();
    p.denied('/somewhere/else');
    expect(card.value?.writeDenied).toBeFalsy();
    p.denied(v.id);
    await settle();
    expect(card.value?.writeDenied).toBe(true);
    expect(writeNoticeKind(card.value!, true)).toBe('fix');

    const denied = Object.assign(new Error('Ich darf hier nichts ändern'), { code: 'permission' });
    expect(writeErrorAction(denied)?.label).toBe('Schreibrechte holen');
    expect(writeErrorAction(Object.assign(new Error('voll'), { code: 'no-space' }))).toBeUndefined();
  });

  it('no button in toasts where the platform cannot mount again', async () => {
    const v = volume('E:\\', { writable: true });
    boot({
      volumes: { subscribe: (cb: (v: Volume[]) => void) => (cb([v]), () => undefined), info: async (x: Volume) => x.info },
    } as unknown as Platform);
    await settle();
    await settle();
    expect(card.value?.volume.id).toBe('E:\\');
    expect(writeErrorAction(Object.assign(new Error('x'), { code: 'permission' }))).toBeUndefined();
  });

  it('a toast told only as text gets the button too, and loses the pointer to "Meine Box"', async () => {
    const v = volume('/media/ben/TONUINO', { writable: false, canFixAccess: true });
    boot(linuxPlatform([v]));
    await settle();
    await settle();
    const text = `Der Ordner „mp3“ ließ sich nicht anlegen. ${messageFor('permission', 'fs')}`;
    const action = writeErrorAction(text)!;
    expect(action.label).toBe('Schreibrechte holen');
    expect(action.tidy!(text)).not.toMatch(/Meine Box/);
    expect(action.tidy!(text)).toMatch(/^Der Ordner „mp3“ ließ sich nicht anlegen\. Ich darf hier nichts ändern/);
    expect(writeErrorAction('Auf der SD-Karte ist kein Platz mehr frei.')).toBeUndefined();
  });

  it('gets the rights for a card that is not the open one, and hands it back as mounted now', async () => {
    // "Karte neu aufbauen": the freshly formatted card, mounted for another account, is not the open card.
    const open = volume('/media/ben/ALT', { writable: true });
    const formatted = volume('/media/root/TONUINO', { writable: false, foreignOwner: true, canFixAccess: true });
    const fresh = volume('/media/ben/TONUINO', { writable: true });
    boot(linuxPlatform([open], fresh));
    await settle();
    await settle();
    expect(card.value?.volume.id).toBe(open.id);
    expect(fixTarget(formatted)).toBe(formatted);
    // The open card itself needs nothing.
    expect(fixTarget()).toBeNull();
    // A card with its lock slider down: nothing the app could do.
    expect(fixTarget(formatted, { writable: false, readOnly: true, canFixAccess: true })).toBeNull();
    expect((await fixWriteAccess(formatted))?.id).toBe('/media/ben/TONUINO');
    // The open card stays open.
    expect(card.value?.volume.id).toBe(open.id);
  });

  it('nothing to get where the platform cannot mount again', async () => {
    const v = volume('E:\\', { writable: false, canFixAccess: true });
    boot({
      volumes: { subscribe: (cb: (v: Volume[]) => void) => (cb([v]), () => undefined), info: async (x: Volume) => x.info },
    } as unknown as Platform);
    await settle();
    await settle();
    expect(fixTarget(v)).toBeNull();
    expect(await fixWriteAccess(v)).toBeNull();
  });
});

describe('a write refused for lack of rights', () => {
  const denied = messageFor('permission', 'fs');

  it('is found by its code, behind a wrapping error, or in its text', () => {
    expect(isWriteDenied(Object.assign(new Error('x'), { code: 'permission' }))).toBe(true);
    const cause = Object.assign(new Error(denied), { code: 'permission' });
    expect(isWriteDenied(new CopyError('Der Ordner „mp3“ ließ sich nicht anlegen.', 'mp3', 'write', { cause }))).toBe(true);
    expect(isWriteDenied(`Der Ordner „mp3“ ließ sich nicht anlegen. ${denied}`)).toBe(true);
    expect(isWriteDenied(messageFor('no-space', 'fs'))).toBe(false);
    expect(isWriteDenied(Object.assign(new Error('x'), { code: 'no-space' }))).toBe(false);
    expect(isWriteDenied(undefined)).toBe(false);
  });

  it('keeps the pointer to "Meine Box" in step with the desktop message, and drops it next to the button', () => {
    expect(denied.endsWith(WRITE_DENIED_HINT)).toBe(true);
    expect(withoutBoxHint(denied)).not.toMatch(/Meine Box/);
    expect(withoutBoxHint(denied)).toMatch(/fehlen die Schreibrechte/);
    expect(withoutBoxHint('Etwas anderes.')).toBe('Etwas anderes.');
  });

  it('"Karte neu aufbauen" says what to do: the button right there, or eject and plug in again', () => {
    const e = new CopyError(`Der Ordner „mp3“ ließ sich nicht anlegen. ${denied}`, 'mp3', 'write');
    const fix = restoreErrorText(e, { canFix: true });
    expect(fix[0]).not.toMatch(/Meine Box/);
    expect(fix[1]).toMatch(/„Schreibrechte holen“ und danach noch einmal auf „Zurückspielen“/);
    const manual = restoreErrorText(e, { canFix: false });
    expect(manual[1]).toMatch(/Wirf sie im Dateimanager aus/);
  });
});

describe('a card the browser took back (Chrome, Edge)', () => {
  afterEach(() => {
    closeCard();
    platform.value = null;
  });

  const lost = () => explainFsError(new DOMException('not allowed', 'NotAllowedError'), 'tonuino-studio.json schreiben');

  it('gets „Zugriff erlauben“ right in the toast, which its text asks for', async () => {
    let asked = 0;
    boot({
      volumes: {
        subscribe: (cb: (v: Volume[]) => void) => (cb([]), () => undefined),
        requestPermission: async () => (asked++, true),
      },
    } as unknown as Platform);
    await settle();
    const e = lost();
    expect(e.message).toMatch(/Klicke auf „Zugriff erlauben“/);
    expect(isAccessLost(e)).toBe(true);
    expect(isAccessLost(`Speichern hat nicht geklappt: ${e.message}`)).toBe(true);
    const action = writeErrorAction(e)!;
    expect(action.label).toBe('Zugriff erlauben');
    action.run();
    await settle();
    expect(asked).toBe(1);
  });

  it('gets no button where the platform cannot ask again', async () => {
    boot({ volumes: { subscribe: (cb: (v: Volume[]) => void) => (cb([]), () => undefined) } } as unknown as Platform);
    await settle();
    expect(writeErrorAction(lost())).toBeUndefined();
  });
});
