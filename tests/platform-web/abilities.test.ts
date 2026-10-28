import { describe, expect, it } from 'vitest';
import { abilitiesOf, abilityLines, cardWaysElsewhere, handheldLead, webAbilities, type BrowserFacts } from '../../src/platform/web/abilities';

const CHROME: BrowserFacts = { handheld: false, apple: false, folderAccess: true, folderInput: true, serial: true };
const FIREFOX_OLD: BrowserFacts = { ...CHROME, folderAccess: false, serial: false };
const SAFARI_MAC: BrowserFacts = { ...FIREFOX_OLD };
const ANDROID: BrowserFacts = { handheld: true, apple: false, folderAccess: true, folderInput: true, serial: false };
const IPHONE: BrowserFacts = { handheld: true, apple: true, folderAccess: false, folderInput: true, serial: false };

const text = (f: BrowserFacts) => abilityLines(webAbilities(f)).map((l) => `${l.what}: ${l.here ? 'ja' : 'nein'}. ${l.note ?? ''}`);

describe('what the web app can do in this browser', () => {
  it('in Chrome or Edge on a computer: card and box, but never a USB NFC reader', () => {
    expect(webAbilities(CHROME)).toEqual({ device: 'computer', sd: 'direct', box: true });
    const lines = text(CHROME);
    expect(lines[0]).toBe('SD-Karte: ja. ');
    expect(lines.find((l) => l.startsWith('NFC-Leser'))).toMatch(/nein\. In keinem Browser, nur mit der Desktop-App/);
    expect(cardWaysElsewhere(webAbilities(CHROME))).toMatch(/in keinem Browser/);
  });

  it('in Firefox and Safari: the card as a Paket, and where the box works instead', () => {
    expect(webAbilities(SAFARI_MAC)).toEqual({ device: 'computer', sd: 'package', box: false });
    const lines = text(FIREFOX_OLD);
    expect(lines[0]).toMatch(/SD-Karte: ja\. Über ein Paket\. Direkt auf die Karte geht in Chrome, Edge/);
    expect(lines[1]).toMatch(/Box per USB: nein\. In Chrome, Edge, Firefox ab Version 151/);
    expect(cardWaysElsewhere(webAbilities(FIREFOX_OLD))).toMatch(/über die Box per USB auch in Chrome und Edge/);
  });

  it('on an Android phone: nothing of the card, the box or NFC, but the Android app', () => {
    // Android's Chrome has a folder chooser, and even folder access since 132: it still cannot reach the card.
    expect(webAbilities(ANDROID)).toEqual({ device: 'android', sd: 'none', box: false });
    const lines = text(ANDROID);
    expect(lines.filter((l) => l.includes(': ja.'))).toEqual(['Sticker gestalten und drucken: ja. ']);
    expect(lines.find((l) => l.startsWith('Karten mit dem NFC'))).toMatch(/nur als Web-Link/);
    expect(handheldLead('android')).toMatch(/Android-App/);
  });

  it('on the iPhone and iPad: nothing of it, and no app to point to', () => {
    expect(webAbilities(IPHONE).device).toBe('apple');
    expect(text(IPHONE).join(' ')).not.toMatch(/Android-App/);
    expect(handheldLead('apple')).toMatch(/Eine App dafür gibt es nicht/);
  });

  it('reads the platform of the web app', () => {
    const caps = { sd: false, sdPackage: false, sdAutoDetect: false, eject: false, fsDetails: false, serial: false, nfcReader: false, wifiBox: false, builtInMic: false };
    expect(abilitiesOf({ handheld: true, capabilities: caps }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15').device).toBe('apple');
    expect(abilitiesOf({ handheld: true, capabilities: caps }, 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0 Mobile').device).toBe('android');
    // A Mac without a touch screen is a computer (handheld.ts), whatever it says.
    expect(abilitiesOf({ capabilities: { ...caps, sdPackage: true } }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15')).toEqual({ device: 'computer', sd: 'package', box: false });
  });
});
