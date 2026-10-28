/**
 * What to do with a new version, per system (TODO #123). The notice
 * "Neue Version da" (UpdateNotice.tsx) opens these steps. Where the app can
 * update itself (Tauri's updater: the Windows setup, the Mac app and the
 * AppImage, once a build has it, see `selfUpdateBuilt`), one button does it;
 * everywhere else the steps say which file to get and what to do with it.
 * Pure: the tests check every system.
 */
import type { Release, ReleaseAsset } from './updatecheck';

/**
 * How this copy of the app was installed. `bundle` is Tauri's own answer
 * (getBundleType: nsis, msi, deb, rpm, appimage, app), `os` the platform's.
 */
export type InstallKind = 'windows' | 'msi' | 'mac' | 'appimage' | 'deb' | 'rpm' | 'android' | 'other';

export function installKind(o: { os: 'linux' | 'windows' | 'macos' | 'other'; mobile?: boolean; bundle?: string | null }): InstallKind {
  if (o.mobile) return 'android';
  switch (o.bundle) {
    case 'nsis':
      return 'windows';
    case 'msi':
      return 'msi';
    case 'app':
      return 'mac';
    case 'appimage':
      return 'appimage';
    case 'deb':
      return 'deb';
    case 'rpm':
      return 'rpm';
  }
  // Started without a bundle (built by hand): the system says at least where to look.
  if (o.os === 'windows') return 'windows';
  if (o.os === 'macos') return 'mac';
  return 'other';
}

/** Tauri's updater replaces exactly these: the NSIS setup, the Mac app and the AppImage (not deb, rpm or msi). */
export function canSelfUpdate(kind: InstallKind): boolean {
  return kind === 'windows' || kind === 'mac' || kind === 'appimage';
}

/** The file of a release for this kind of install; signatures (.sig) and update archives never. */
export function pickAsset(kind: InstallKind, assets: readonly ReleaseAsset[] | undefined): ReleaseAsset | undefined {
  const files = (assets ?? []).filter((a) => !/\.(sig|json|tar\.gz|zip)$/i.test(a.name));
  const first = (re: RegExp, prefer?: RegExp) => {
    const all = files.filter((a) => re.test(a.name));
    return (prefer && all.find((a) => prefer.test(a.name))) || all[0];
  };
  switch (kind) {
    case 'windows':
      return first(/\.exe$/i, /setup/i);
    case 'msi':
      return first(/\.msi$/i);
    case 'mac':
      return first(/\.dmg$/i, /universal/i);
    case 'appimage':
      return first(/\.appimage$/i, /amd64|x86_64/i);
    case 'deb':
      return first(/\.deb$/i, /amd64/i);
    case 'rpm':
      return first(/\.rpm$/i, /x86_64/i);
    case 'android':
      return first(/\.apk$/i);
    case 'other':
      return undefined;
  }
}

export interface UpdateSteps {
  /** One short sentence per step, in order. */
  steps: string[];
  /** A command to copy (the .deb from the terminal). */
  command?: string;
  /** The file for this system, else the release page. */
  download: { label: string; url: string };
  /** The app replaces itself: one button instead of the steps above. */
  self: boolean;
}

const DOWNLOAD_LABEL: Record<InstallKind, string> = {
  windows: 'Setup herunterladen',
  msi: 'Installer herunterladen',
  mac: 'Mac-App herunterladen',
  appimage: 'AppImage herunterladen',
  deb: '.deb-Paket herunterladen',
  rpm: '.rpm-Paket herunterladen',
  android: 'APK herunterladen',
  other: 'Zur Download-Seite',
};

/**
 * The steps for this system. `selfUpdate`: the build has Tauri's updater
 * (only then the button "Jetzt aktualisieren" can work).
 */
export function updateSteps(kind: InstallKind, release: Release, selfUpdate: boolean): UpdateSteps {
  const asset = pickAsset(kind, release.assets);
  const download = asset ? { label: DOWNLOAD_LABEL[kind], url: asset.url } : { label: 'Zur Download-Seite', url: release.url };
  const file = asset ? `„${asset.name}“` : 'die Datei für dein System';
  if (selfUpdate && canSelfUpdate(kind)) {
    return {
      self: true,
      download,
      steps: [
        'Ich lade die neue Version und prüfe, ob sie wirklich von TonUINO Studio kommt.',
        kind === 'windows' ? 'Dann schließt sich das Fenster kurz, und die neue Version startet von selbst.' : 'Danach schließt du die App und öffnest sie wieder.',
        'Deine Einstellungen und gemerkten Karten bleiben.',
      ],
    };
  }
  switch (kind) {
    case 'windows':
      return {
        self: false,
        download,
        steps: [
          `Lade ${file} herunter und starte es.`,
          'Warnt Windows, klicke auf „Weitere Informationen“ und dann auf „Trotzdem ausführen“.',
          'Das Setup ersetzt die alte Version. Deine Einstellungen bleiben.',
        ],
      };
    case 'mac':
      return {
        self: false,
        download,
        steps: [
          `Lade ${file} herunter und öffne sie.`,
          'Ziehe TonUINO Studio in den Ordner „Programme“ und ersetze die alte Version.',
          'Beim ersten Start: Rechtsklick auf die App, dann „Öffnen“.',
        ],
      };
    case 'appimage':
      return {
        self: false,
        download,
        steps: [`Lade ${file} herunter.`, 'Mache sie in ihren Eigenschaften ausführbar und starte sie.', 'Die alte Datei kannst du danach löschen. Deine Einstellungen bleiben.'],
      };
    case 'deb':
      return {
        self: false,
        download,
        steps: [`Lade ${file} herunter.`, 'Öffne es mit der Softwareverwaltung und klicke auf „Installieren“.', 'Oder nimm das Terminal, im Ordner mit der Datei:'],
        command: `sudo apt install ./${asset ? shellName(asset.name) : 'tonuino-studio.deb'}`,
      };
    case 'rpm':
      return {
        self: false,
        download,
        steps: [`Lade ${file} herunter.`, 'Öffne es mit der Softwareverwaltung und klicke auf „Installieren“.'],
      };
    case 'android':
      return {
        self: false,
        download,
        steps: [
          `Lade ${file} herunter und tippe sie an.`,
          'Android fragt, ob du die App aktualisieren möchtest. Tippe auf „Aktualisieren“.',
          'Deine Einstellungen und gemerkten Karten bleiben.',
        ],
      };
    case 'msi':
    case 'other':
      return {
        self: false,
        download,
        steps: [`Lade ${file} herunter und installiere sie wie die alte Version.`],
      };
  }
}

/** A file name as the shell takes it: names with spaces in quotes ("TonUINO Studio_0.6.0_amd64.deb"). */
function shellName(name: string): string {
  return /^[\w.+-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`;
}
