import { describe, expect, it } from 'vitest';
import { CH340_DRIVER_URLS, getBoard } from '../../src/core/firmware/variants';
import { rankPorts } from '../../src/features/workshop/ports';
import { EMPTY_PORTS_HINT_MS, boxCandidates, chooserMissHint, nextChooserMiss, usbHelp, type ChooserMiss, type HelpContext } from '../../src/features/workshop/usbhelp';

const ctx = (patch: Partial<HelpContext>): HelpContext => ({ os: 'linux', kind: 'web', serialSupported: true, canSetupAccess: false, ...patch });
const ids = (c: HelpContext) => usbHelp(c).sections.map((s) => s.id);
const everything = (c: HelpContext) => {
  const help = usbHelp(c);
  return [...help.sections, ...help.later];
};

describe('USB help', () => {
  it('starts with the browser when it cannot talk to USB devices, and folds the rest away', () => {
    const firefox = usbHelp(ctx({ serialSupported: false }));
    // Linux commands cannot help a browser without USB access.
    expect(firefox.sections.map((s) => s.id)).toEqual(['browser']);
    expect(firefox.later.map((s) => s.id)).toEqual(['cable', 'hub', 'busy', 'linux-access', 'linux-brltty', 'linux-modemmanager']);
    expect(usbHelp(ctx({ os: 'macos', serialSupported: false })).later.map((s) => s.id)).toEqual(['cable', 'hub', 'busy', 'macos-driver']);

    const chrome = usbHelp(ctx({}));
    expect(chrome.sections.map((s) => s.id)).not.toContain('browser');
    expect(chrome.later).toEqual([]);
  });

  it('offers the one-time setup in the desktop app on Linux', () => {
    const { sections } = usbHelp(ctx({ kind: 'desktop', canSetupAccess: true }));
    // The simple things first, the terminal last (Prüfrunde 1 B6); the desktop app's own button is no terminal.
    expect(sections.map((s) => s.id)).toEqual(['cable', 'hub', 'busy', 'linux-access', 'linux-modemmanager', 'linux-brltty']);
    expect(sections.filter((s) => s.terminal).map((s) => s.id)).toEqual(['linux-brltty']);
    expect(sections[3].action).toEqual({ kind: 'setup-access', label: 'USB-Zugriff einrichten' });
    expect(sections[5].steps[0].command).toBe('sudo apt remove brltty');
  });

  it('does not remove brltty on Pop!_OS, where the desktop depends on it', () => {
    const brltty = usbHelp(ctx({})).sections.find((s) => s.id === 'linux-brltty')!;
    const pop = brltty.steps.find((s) => s.text.includes('Pop!_OS'))!;
    expect(pop.command).toContain('/dev/null');
    expect(pop.command).not.toContain('remove');
    expect(brltty.steps.map((s) => s.text).join(' ')).toContain('sudo dnf remove brltty');
  });

  it('names the Snap Chromium on Linux only in the browser', () => {
    const snap = (c: HelpContext) => usbHelp(c).sections.find((s) => s.id === 'linux-access')!.steps.some((s) => s.text.includes('Snap'));
    expect(snap(ctx({}))).toBe(true);
    expect(snap(ctx({ kind: 'desktop', canSetupAccess: true }))).toBe(false);
  });

  it('explains the dialout group in the browser on Linux', () => {
    const { sections } = usbHelp(ctx({}));
    const access = sections.find((s) => s.id === 'linux-access')!;
    expect(access.action).toBeUndefined();
    expect(access.steps.map((s) => s.command).filter(Boolean)).toEqual(['sudo usermod -aG dialout $USER']);
    expect(sections.find((s) => s.id === 'linux-modemmanager')?.steps[1].command).toBe('sudo systemctl disable --now ModemManager');
    // The simple things end with the browser's chooser; the terminal comes after, folded.
    expect(sections.filter((s) => !s.terminal).at(-1)?.id).toBe('chooser');
    expect(sections.filter((s) => s.terminal).map((s) => s.id)).toEqual(['linux-access', 'linux-brltty', 'linux-modemmanager']);
  });

  it('names the button the page shows for choosing the box', () => {
    const chooser = usbHelp(ctx({})).sections.find((s) => s.id === 'chooser')!;
    expect(chooser.steps[0].text).toContain('„Box verbinden …“');
  });

  it('links the English CH340 driver pages and says what to click there', () => {
    const windows = usbHelp(ctx({ os: 'windows' })).sections.filter((s) => s.id.startsWith('windows'));
    expect(windows.slice(0, 3).map((s) => s.id)).toEqual(['windows-driver', 'windows-device-manager', 'windows-open']);
    expect(windows[0].action).toEqual({ kind: 'link', label: 'CH340-Treiber herunterladen', url: CH340_DRIVER_URLS.windows });
    expect(CH340_DRIVER_URLS.windows).toMatch(/^https:\/\/www\.wch-ic\.com\//);
    expect(windows[0].steps[0].text).toContain('Klicke dort auf den Knopf „Download“');
    expect(windows[0].steps[1].text).toContain('„CH341SER.EXE“');

    const mac = usbHelp(ctx({ os: 'macos' })).sections.filter((s) => s.id.startsWith('macos'));
    expect(mac[0].action).toMatchObject({ kind: 'link', url: CH340_DRIVER_URLS.macos });
    expect(CH340_DRIVER_URLS.macos).toMatch(/^https:\/\/www\.wch-ic\.com\//);
    expect(mac[0].steps[0].text).toContain('„Download“');
    expect(ids(ctx({ os: 'other' })).filter((id) => /^(windows|macos)/.test(id))).toEqual(['windows-driver', 'windows-device-manager', 'windows-open', 'macos-driver']);
    // Windows and Mac never see a terminal command.
    expect(usbHelp(ctx({ os: 'windows' })).sections.flatMap((s) => s.steps).some((st) => st.command)).toBe(false);
    expect(usbHelp(ctx({ os: 'macos' })).sections.flatMap((s) => s.steps).some((st) => st.command)).toBe(false);
  });

  it('helps on Windows when the box is listed but does not open', () => {
    const web = usbHelp(ctx({ os: 'windows' })).sections.find((s) => s.id === 'windows-open')!;
    expect(web.title).toBe('Windows: Die Box ist da, lässt sich aber nicht öffnen');
    const text = web.steps.map((s) => s.text).join(' ');
    // The fix from the FAQ of the TonUINO forum: switch on SerEnum for the CH340 port.
    expect(text).toContain('„Anschlusseinstellungen“ und klicke auf „Erweitert …“');
    expect(text).toContain('„Enabling the Serial Port Enumerator (SerEnum)“');
    expect(text).toContain('installiere zuerst den aktuellen CH340-Treiber');
    expect(web.intro).toContain('Failed to open serial port');
    expect(web.steps.at(-1)?.text).toContain('Desktop-App');
    // In the desktop app there is no other app to point to.
    const desktop = usbHelp(ctx({ os: 'windows', kind: 'desktop' })).sections.find((s) => s.id === 'windows-open')!;
    expect(desktop.steps.some((s) => s.text.includes('Desktop-App'))).toBe(false);
  });

  it('always covers charge-only cables, hubs and busy ports', () => {
    for (const os of ['linux', 'windows', 'macos', 'other'] as const) {
      expect(ids(ctx({ os }))).toEqual(expect.arrayContaining(['cable', 'hub', 'busy']));
      expect(everything(ctx({ os, serialSupported: false })).map((s) => s.id)).toEqual(expect.arrayContaining(['cable', 'hub', 'busy']));
    }
    expect(ids(ctx({ kind: 'desktop', os: 'windows' }))).not.toContain('chooser');
  });
  it('explains the add-on question first in Firefox, with the Linux limits there', () => {
    const linux = usbHelp(ctx({ mayAskForAddon: true })).sections;
    expect(linux[0].id).toBe('firefox');
    const text = linux[0].steps.map((s) => s.text).join(' ');
    expect(text).toContain('„Installation fortsetzen“, dann auf „Hinzufügen“ und danach auf „Erlauben“');
    expect(text).toContain('„Nie erlauben“');
    expect(text).toContain('Snap-Paket');
    const windows = usbHelp(ctx({ os: 'windows', mayAskForAddon: true })).sections;
    expect(windows[0].id).toBe('firefox');
    expect(windows[0].steps.map((s) => s.text).join(' ')).not.toContain('Snap');
    // An old Firefox without USB access: the browser answer comes first, nothing about the add-on.
    expect(everything(ctx({ serialSupported: false, mayAskForAddon: true })).map((s) => s.id)).not.toContain('firefox');
    expect(usbHelp(ctx({ serialSupported: false })).sections[0].steps[0].text).toContain('Firefox ab Version 151');
  });
});

describe('hint after an empty port chooser', () => {
  const CABLE = 'Meist liegt es am Kabel: Viele USB-Kabel laden nur und übertragen keine Daten. Nimm ein anderes Kabel und stecke die Box direkt am Computer ein.';
  const DRIVER = 'Hat die Box den Chip CH340, braucht Windows einmalig einen Treiber.';
  const OTHER_CHIP = 'Vielleicht hat deine Box einen anderen USB-Chip. Klicke dann auf „Alle USB-Geräte zeigen“ und wähle deine Box dort aus.';

  it('starts with the cable and links the full USB help', () => {
    for (const os of ['linux', 'windows', 'macos', 'other'] as const) {
      const hint = chooserMissHint({ os, filtered: false, ch340: false });
      expect(hint.title).toBe('Keine Box im Auswahlfenster?');
      expect(hint.lines).toEqual([CABLE]);
      expect(hint.showAll).toBe(false);
      expect(hint.more).toEqual({ label: 'Mehr Hilfe', href: '#/werkstatt/usb' });
    }
  });

  it('names the CH340 driver only on Windows and only for a CH340', () => {
    expect(chooserMissHint({ os: 'windows', filtered: false, ch340: true }).lines).toEqual([CABLE, DRIVER]);
    expect(chooserMissHint({ os: 'windows', filtered: false, ch340: false }).lines).not.toContain(DRIVER);
    for (const os of ['linux', 'macos', 'other'] as const) {
      expect(chooserMissHint({ os, filtered: false, ch340: true }).lines).not.toContain(DRIVER);
    }
    // brltty takes the CH340 away on Ubuntu and Linux Mint, so it never shows up in the chooser.
    expect(chooserMissHint({ os: 'linux', filtered: false, ch340: true }).lines[1]).toContain('„brltty“');
    expect(chooserMissHint({ os: 'linux', filtered: false, ch340: false }).lines.join(' ')).not.toContain('brltty');
  });

  it('points to „Alle USB-Geräte zeigen“ when the chooser was narrowed to the board', () => {
    const filtered = chooserMissHint({ os: 'windows', filtered: true, ch340: true });
    expect(filtered.lines).toEqual([CABLE, DRIVER, OTHER_CHIP]);
    expect(filtered.showAll).toBe(true);
    const all = chooserMissHint({ os: 'macos', filtered: false, ch340: true });
    expect(all.lines).not.toContain(OTHER_CHIP);
    expect(all.showAll).toBe(false);
  });

  it('has its own title in the desktop app, which has no chooser', () => {
    const desktop = chooserMissHint({ os: 'windows', filtered: true, ch340: true, desktop: true });
    expect(desktop.title).toBe('Die Box taucht nicht auf?');
    expect(desktop.showAll).toBe(false);
    expect(desktop.lines).toEqual([CABLE, DRIVER]);
  });

  it('shows after the chooser closes without a box and hides after a choice', () => {
    let miss: ChooserMiss = null;
    miss = nextChooserMiss(miss, { kind: 'chooser-closed', chosen: false, filtered: true });
    expect(miss).toEqual({ filtered: true });
    // Trying again with all devices and closing again: the hint stays, now without the filter.
    miss = nextChooserMiss(miss, { kind: 'chooser-closed', chosen: false, filtered: false });
    expect(miss).toEqual({ filtered: false });
    // New ports in the browser list do not count as a choice.
    expect(nextChooserMiss(miss, { kind: 'ports', count: 1, desktop: false })).toEqual({ filtered: false });
    expect(nextChooserMiss(miss, { kind: 'chooser-closed', chosen: true, filtered: true })).toBeNull();
    expect(nextChooserMiss(miss, { kind: 'port-chosen' })).toBeNull();
    expect(nextChooserMiss(null, { kind: 'chooser-closed', chosen: true, filtered: false })).toBeNull();
  });

  it('shows in the desktop app when the list stays empty for 15 seconds', () => {
    expect(EMPTY_PORTS_HINT_MS).toBe(15_000);
    expect(nextChooserMiss(null, { kind: 'empty-for', ms: 14_999 })).toBeNull();
    const miss = nextChooserMiss(null, { kind: 'empty-for', ms: 15_000 });
    expect(miss).toEqual({ filtered: false });
    expect(nextChooserMiss(miss, { kind: 'ports', count: 0, desktop: true })).toEqual({ filtered: false });
    expect(nextChooserMiss(miss, { kind: 'ports', count: 1, desktop: true })).toBeNull();
  });

  it('counts only ports that may be the box, so built-in COM ports on Windows do not hide the hint', () => {
    const com1 = { id: 'COM1', label: 'Kommunikationsanschluss (COM1)', path: 'COM1' };
    const bluetooth = { id: 'COM4', label: 'Standard Serial over Bluetooth link (COM4)', path: 'COM4' };
    const ch340 = { id: 'COM5', label: 'USB-Serial CH340 (COM5)', path: 'COM5', usbVendorId: 0x1a86, usbProductId: 0x7523 };
    const otherUsb = { id: 'COM6', label: 'USB-Serial (COM6)', path: 'COM6', usbVendorId: 0x1234, usbProductId: 0x0001 };
    const classic = getBoard('classic');
    // A PC with only COM1 and Bluetooth: no box yet, so after 15 seconds the hint shows.
    const onlyBuiltIn = rankPorts([com1, bluetooth], classic);
    expect(onlyBuiltIn).toHaveLength(2);
    expect(boxCandidates(onlyBuiltIn)).toBe(0);
    let miss = nextChooserMiss(null, { kind: 'ports', count: boxCandidates(onlyBuiltIn), desktop: true });
    miss = nextChooserMiss(miss, { kind: 'empty-for', ms: EMPTY_PORTS_HINT_MS });
    expect(miss).toEqual({ filtered: false });
    // The box shows up (driver installed, other cable): the hint goes.
    const withBox = rankPorts([com1, ch340], classic);
    expect(boxCandidates(withBox)).toBe(1);
    expect(nextChooserMiss(miss, { kind: 'ports', count: boxCandidates(withBox), desktop: true })).toBeNull();
    // Any USB device may be the box (another USB chip); without a board, too.
    expect(boxCandidates(rankPorts([com1, otherUsb], classic))).toBe(1);
    expect(boxCandidates(rankPorts([bluetooth, ch340]))).toBe(1);
  });
});
