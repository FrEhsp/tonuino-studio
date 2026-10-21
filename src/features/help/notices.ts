/**
 * Third-party notices for "Über TonUINO Studio": every runtime dependency of
 * package.json, every font the app bundles and every direct crate of the
 * desktop app. Versions, licences and copyright lines are copied from the
 * packages' own files (node_modules/<name>/package.json and LICENSE*, the
 * crates' Cargo.toml and licence files), not guessed.
 * tests/help/notices.test.ts compares this list with the installed packages,
 * so an update that changes a version or a licence fails until the list
 * here is updated too.
 */
// Free of dependencies: the Vite config loads this file natively.

export interface PackageNotice {
  /** Name as in package.json. */
  name: string;
  version: string;
  /** SPDX expression from the package's own package.json. */
  license: string;
  /** Copyright line as the licence file has it, or the author when the package has no licence file. */
  copyright: string;
  /** Names in `copyright`; the test finds each in the licence file or the author field. */
  holders: string[];
  /** What the app uses it for, in plain German. */
  use: string;
  url: string;
  /** Font packages are listed with the fonts. */
  kind: 'code' | 'font';
  /** Listed in package.json, but nothing in the app imports it, so it is not part of the app. */
  unused?: boolean;
  /** Extra facts, e.g. code the package is based on. */
  note?: string;
}

export interface FontNotice {
  family: string;
  /** Where the app shows it. */
  use: string;
  /** First line of the font's licence file (LICENSE_FONT or LICENSE), or the copyright the font itself names. */
  copyright: string;
  license: 'OFL-1.1' | 'Apache-2.0';
  /** npm packages the font files come from; empty for a font that lies in src/assets/fonts. */
  packages: string[];
  /**
   * A font that ships as its own files in src/assets/fonts instead of from
   * npm: the files, the licence text next to them (and a NOTICE file where
   * the licence has no copyright line), and the version the font files name.
   * The build puts the licence text into lizenzen.json (scripts/licenses.ts).
   */
  bundled?: { files: string[]; licenseFile: string; noticeFile?: string; version: string };
  url: string;
}

export interface CrateNotice {
  /** Name as in src-tauri/Cargo.toml. */
  name: string;
  version: string;
  license: string;
  copyright: string;
  use: string;
  url: string;
}

const NOT_INCLUDED = 'Steht in der Paketliste, ist aber derzeit nicht in der App enthalten.';

export const PACKAGE_NOTICES: readonly PackageNotice[] = [
  {
    name: '@breezystack/lamejs',
    version: '1.2.7',
    license: 'LGPL-3.0',
    copyright: 'Alex Zhukov',
    holders: ['Alex Zhukov'],
    use: 'Wandelt Hörspiele und Musik in MP3 um.',
    url: 'https://github.com/shijinyu/lamejs',
    kind: 'code',
    note: 'Beruht auf dem MP3-Encoder LAME (lame.sourceforge.net).',
  },
  {
    name: '@preact/signals',
    version: '2.11.3',
    license: 'MIT',
    copyright: 'Copyright (c) 2022-present Preact Team',
    holders: ['Preact Team'],
    use: 'Hält alles auf dem Bildschirm aktuell.',
    url: 'https://github.com/preactjs/signals',
    kind: 'code',
  },
  {
    name: '@tauri-apps/api',
    version: '2.12.1',
    license: 'Apache-2.0 OR MIT',
    copyright: 'Copyright (c) 2017 - Present Tauri Apps Contributors',
    holders: ['Tauri Apps Contributors'],
    use: 'Verbindet die Oberfläche mit der Desktop-App.',
    url: 'https://tauri.app',
    kind: 'code',
  },
  {
    name: 'browser-id3-writer',
    version: '6.4.0',
    license: 'MIT',
    copyright: 'Copyright @egoroof',
    holders: ['egoroof'],
    use: NOT_INCLUDED,
    url: 'https://github.com/egoroof/browser-id3-writer',
    kind: 'code',
    unused: true,
  },
  {
    name: 'jspdf',
    version: '4.2.1',
    license: 'MIT',
    copyright: 'Copyright (c) 2010-2025 James Hall, (c) 2015-2025 yWorks GmbH',
    holders: ['James Hall', 'yWorks GmbH'],
    use: 'Erstellt die PDFs für Sticker und QR-Codes.',
    url: 'https://github.com/parallax/jsPDF',
    kind: 'code',
  },
  {
    name: 'jszip',
    version: '3.10.2',
    license: '(MIT OR GPL-3.0-or-later)',
    copyright: 'Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso',
    holders: ['Stuart Knightley', 'David Duponchel', 'Franz Buchinger', 'António Afonso'],
    use: 'Liest und schreibt ZIP-Dateien: die Cover auf der SD-Karte, Systemansagen und Einzelbilder.',
    url: 'https://github.com/Stuk/jszip',
    kind: 'code',
  },
  {
    name: 'lucide-preact',
    version: '1.52.0',
    license: 'ISC',
    copyright: 'Copyright (c) 2026 Lucide Icons and Contributors',
    holders: ['Lucide Icons and Contributors'],
    use: 'Die Symbole in der App und auf Spezialkarten-Stickern.',
    url: 'https://lucide.dev',
    kind: 'code',
    note: 'Einige Symbole stammen aus dem Projekt Feather: MIT-Lizenz, Copyright (c) 2013-present Cole Bemis.',
  },
  {
    name: 'mpg123-decoder',
    version: '1.0.3',
    license: 'MIT',
    copyright: 'Ethan Halsall',
    holders: ['Ethan Halsall'],
    use: 'Liest MP3-Dateien in der Web-App.',
    url: 'https://github.com/eshaz/wasm-audio-decoders',
    kind: 'code',
    note: 'Enthält den MP3-Decoder mpg123 (mpg123.de), der unter der LGPL-2.1 steht.',
  },
  {
    name: 'music-metadata',
    version: '12.0.0',
    license: 'MIT',
    copyright: 'Copyright © 2026 Borewit',
    holders: ['Borewit'],
    use: 'Liest Titel, Interpret, Cover und Kapitel aus Audiodateien.',
    url: 'https://github.com/Borewit/music-metadata',
    kind: 'code',
  },
  {
    name: 'preact',
    version: '11.0.0',
    license: 'MIT',
    copyright: 'Copyright (c) 2015-present Jason Miller',
    holders: ['Jason Miller'],
    use: 'Das Grundgerüst der Oberfläche.',
    url: 'https://preactjs.com',
    kind: 'code',
  },
  {
    name: 'qrcode',
    version: '1.5.4',
    license: 'MIT',
    copyright: 'Copyright (c) 2012 Ryan Day',
    holders: ['Ryan Day'],
    use: 'Erzeugt die QR-Codes für das Handy.',
    url: 'https://github.com/soldair/node-qrcode',
    kind: 'code',
  },
  {
    name: '@expo-google-fonts/baloo-2',
    version: '0.4.2',
    license: 'MIT AND OFL-1.1',
    copyright: 'Copyright (c) 2020 Expo; Schrift: Copyright 2019 The Baloo 2 Project Authors',
    holders: ['Expo', 'The Baloo 2 Project Authors'],
    use: NOT_INCLUDED,
    url: 'https://github.com/expo/google-fonts',
    kind: 'font',
    unused: true,
  },
  {
    name: '@expo-google-fonts/bitter',
    version: '0.4.2',
    license: 'MIT AND OFL-1.1',
    copyright: 'Copyright (c) 2020 Expo; Schrift: Copyright 2011 The Bitter Project Authors',
    holders: ['Expo', 'The Bitter Project Authors'],
    use: 'Bringt die Schrift Bitter mit.',
    url: 'https://github.com/expo/google-fonts',
    kind: 'font',
  },
  {
    name: '@expo-google-fonts/figtree',
    version: '0.4.1',
    license: 'MIT AND OFL-1.1',
    copyright: 'Copyright (c) 2020 Expo; Schrift: Copyright 2022 The Figtree Project Authors',
    holders: ['Expo', 'The Figtree Project Authors'],
    use: 'Bringt die Schrift Figtree für Sticker mit.',
    url: 'https://github.com/expo/google-fonts',
    kind: 'font',
  },
  {
    name: '@expo-google-fonts/fredoka',
    version: '0.4.1',
    license: 'MIT AND OFL-1.1',
    copyright: 'Copyright (c) 2020 Expo; Schrift: Copyright 2016 The Fredoka Project Authors',
    holders: ['Expo', 'The Fredoka Project Authors'],
    use: 'Bringt die Schrift Fredoka mit.',
    url: 'https://github.com/expo/google-fonts',
    kind: 'font',
  },
  {
    name: '@expo-google-fonts/nunito',
    version: '0.4.2',
    license: 'MIT AND OFL-1.1',
    copyright: 'Copyright (c) 2020 Expo; Schrift: Copyright 2014 The Nunito Project Authors',
    holders: ['Expo', 'The Nunito Project Authors'],
    use: 'Bringt die Schrift Nunito für Sticker mit.',
    url: 'https://github.com/expo/google-fonts',
    kind: 'font',
  },
  {
    name: '@expo-google-fonts/patrick-hand',
    version: '0.4.1',
    license: 'MIT AND OFL-1.1',
    copyright: 'Copyright (c) 2020 Expo; Schrift: Copyright (c) 2010-2012 Patrick Wagesreiter',
    holders: ['Expo', 'Patrick Wagesreiter'],
    use: 'Bringt die Schrift Patrick Hand mit.',
    url: 'https://github.com/expo/google-fonts',
    kind: 'font',
  },
  {
    name: '@fontsource-variable/figtree',
    version: '5.3.0',
    license: 'OFL-1.1',
    copyright: 'Copyright 2022 The Figtree Project Authors',
    holders: ['The Figtree Project Authors'],
    use: NOT_INCLUDED,
    url: 'https://fontsource.org/fonts/figtree',
    kind: 'font',
    unused: true,
  },
];

/**
 * Fonts in the app: the fonts of the styles of the interface
 * (src/assets/fonts, declared in src/ui/styles/tokens.css) and the four
 * sticker fonts (src/features/stickers/fonts.ts).
 */
export const FONT_NOTICES: readonly FontNotice[] = [
  {
    family: 'Fira Sans',
    use: 'Schrift der ganzen App: Texte, Knöpfe und Eingabefelder',
    copyright: 'Digitized data copyright (c) 2012-2015, The Mozilla Foundation and Telefonica S.A.',
    license: 'OFL-1.1',
    packages: [],
    bundled: {
      files: [
        'fira-sans-latin-400-normal.woff2',
        'fira-sans-latin-ext-400-normal.woff2',
        'fira-sans-latin-400-italic.woff2',
        'fira-sans-latin-600-normal.woff2',
        'fira-sans-latin-ext-600-normal.woff2',
        'fira-sans-latin-700-normal.woff2',
        'fira-sans-latin-ext-700-normal.woff2',
      ],
      licenseFile: 'OFL-FiraSans.txt',
      version: 'Version 4.203',
    },
    url: 'https://github.com/mozilla/Fira',
  },
  {
    family: 'Shantell Sans',
    use: 'Name der App, Überschriften, Notizen und Sprechblasen',
    copyright: 'Copyright 2022 The Shantell Sans Project Authors (https://github.com/arrowtype/shantell-sans)',
    license: 'OFL-1.1',
    packages: [],
    bundled: { files: ['shantell-sans-latin.woff2', 'shantell-sans-latin-ext.woff2'], licenseFile: 'OFL-ShantellSans.txt', version: 'Version 1.011' },
    url: 'https://github.com/arrowtype/shantell-sans',
  },
  {
    family: 'Permanent Marker',
    use: 'Die Ordnernummer auf den Karten im Regal und auf Stickern ohne Bild',
    copyright: 'Copyright (c) 2010 by Font Diner, Inc. All rights reserved.',
    license: 'Apache-2.0',
    packages: [],
    bundled: { files: ['permanent-marker-latin.woff2'], licenseFile: 'LICENSE-PermanentMarker.txt', noticeFile: 'NOTICE-PermanentMarker.txt', version: 'Version 1.001' },
    url: 'https://fonts.google.com/specimen/Permanent+Marker',
  },
  {
    family: 'Gochi Hand',
    use: 'Der Titel auf Stickern ohne Bild',
    copyright: 'Copyright (c) 2011, Juan Pablo del Peral (juandelperal@htfonts.com), with Reserved Font Names "Gochi" and "Gochi Hand"',
    license: 'OFL-1.1',
    packages: [],
    bundled: { files: ['gochi-hand-latin.woff2'], licenseFile: 'OFL-GochiHand.txt', version: 'Version 1.001' },
    url: 'https://fonts.google.com/specimen/Gochi+Hand',
  },
  {
    family: 'Figtree',
    use: 'Sticker-Schrift „Klar“',
    copyright: 'Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree)',
    license: 'OFL-1.1',
    packages: ['@expo-google-fonts/figtree'],
    url: 'https://github.com/erikdkennedy/figtree',
  },
  {
    family: 'Nunito',
    use: 'Sticker-Schrift „Rund“',
    copyright: 'Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)',
    license: 'OFL-1.1',
    packages: ['@expo-google-fonts/nunito'],
    url: 'https://github.com/googlefonts/nunito',
  },
  {
    family: 'Anton',
    use: 'Sticker-Schrift „Detektiv“',
    copyright: 'Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git)',
    license: 'OFL-1.1',
    packages: [],
    bundled: { files: ['anton-latin.woff2'], licenseFile: 'OFL-Anton.txt', version: 'Fontsource 5.3.0' },
    url: 'https://fonts.google.com/specimen/Anton',
  },
  {
    family: 'Lilita One',
    use: 'Sticker-Schrift „Comic“',
    copyright: 'Copyright (c) 2011 Juan Montoreano (juan@remolacha.biz), with Reserved Font Names "Lilita One"',
    license: 'OFL-1.1',
    packages: [],
    bundled: { files: ['lilita-one-latin.woff2'], licenseFile: 'OFL-LilitaOne.txt', version: 'Fontsource 5.3.0' },
    url: 'https://fonts.google.com/specimen/Lilita+One',
  },
  {
    family: 'Caprasimo',
    use: 'Sticker-Schrift „Bilderbuch“',
    copyright: 'Copyright 2023 The Caprasimo Project Authors (https://github.com/docrepair-fonts/caprasimo-fonts)',
    license: 'OFL-1.1',
    packages: [],
    bundled: { files: ['caprasimo-latin.woff2'], licenseFile: 'OFL-Caprasimo.txt', version: 'Fontsource 5.3.0' },
    url: 'https://fonts.google.com/specimen/Caprasimo',
  },
  {
    family: 'Fredoka',
    use: 'Kleine Schrift unter dem Titel bei der Sticker-Schrift „Comic“',
    copyright: 'Copyright 2016 The Fredoka Project Authors (https://github.com/hafontia/Fredoka-One)',
    license: 'OFL-1.1',
    packages: ['@expo-google-fonts/fredoka'],
    url: 'https://github.com/hafontia/Fredoka-One',
  },
  {
    family: 'Bitter',
    use: 'Sticker-Schrift „Buch“',
    copyright: 'Copyright 2011 The Bitter Project Authors (https://github.com/solmatas/BitterPro) with Reserved Font Name "Bitter Pro".',
    license: 'OFL-1.1',
    packages: ['@expo-google-fonts/bitter'],
    url: 'https://github.com/solmatas/BitterPro',
  },
  {
    family: 'Patrick Hand',
    use: 'Sticker-Schrift „Handschrift“',
    copyright: 'Copyright (c) 2010-2012 Patrick Wagesreiter (mail@patrickwagesreiter.at)',
    license: 'OFL-1.1',
    packages: ['@expo-google-fonts/patrick-hand'],
    url: 'https://fonts.google.com/specimen/Patrick+Hand',
  },
];

/**
 * The desktop app that builds the list of "Entdecken" itself (and the tests).
 * vite.config.ts reads this file too, before the build constants exist: hence the typeof.
 */
const LOCAL_LIST_DESKTOP = typeof __DESKTOP_BUILD__ !== 'undefined' && typeof __LOCAL_SOURCES__ !== 'undefined' && __DESKTOP_BUILD__ && __LOCAL_SOURCES__;

/** Direct dependencies of the desktop app (src-tauri/Cargo.toml). */
export const CRATE_NOTICES: readonly CrateNotice[] = [
  {
    name: 'tauri',
    version: '2.12.1',
    license: 'Apache-2.0 OR MIT',
    copyright: 'Tauri Programme within The Commons Conservancy',
    use: 'Das Gerüst der Desktop-App.',
    url: 'https://tauri.app',
  },
  {
    name: 'tauri-plugin-dialog',
    version: '2.8.1',
    license: 'Apache-2.0 OR MIT',
    copyright: 'Tauri Programme within The Commons Conservancy',
    use: 'Fenster zum Öffnen und Speichern von Dateien.',
    url: 'https://github.com/tauri-apps/plugins-workspace',
  },
  {
    name: 'tauri-plugin-opener',
    version: '2.7.0',
    license: 'Apache-2.0 OR MIT',
    copyright: 'Tauri Programme within The Commons Conservancy',
    use: 'Öffnet Links in deinem Browser.',
    url: 'https://github.com/tauri-apps/plugins-workspace',
  },
  {
    name: 'serde',
    version: '1.0.229',
    license: 'MIT OR Apache-2.0',
    copyright: 'Erick Tryzelaar, David Tolnay',
    use: 'Tauscht Daten zwischen Oberfläche und Programm aus.',
    url: 'https://serde.rs',
  },
  {
    name: 'serde_json',
    version: '1.0.151',
    license: 'MIT OR Apache-2.0',
    copyright: 'Erick Tryzelaar, David Tolnay',
    use: 'Liest und schreibt JSON.',
    url: 'https://github.com/serde-rs/json',
  },
  {
    name: 'log',
    version: '0.4.34',
    license: 'MIT OR Apache-2.0',
    copyright: 'The Rust Project Developers',
    use: 'Schreibt Meldungen für die Fehlersuche.',
    url: 'https://github.com/rust-lang/log',
  },
  {
    name: 'sysinfo',
    version: '0.37.2',
    license: 'MIT',
    copyright: 'Copyright (c) 2015 Guillaume Gomez',
    use: 'Hilft beim Finden eingesteckter SD-Karten.',
    url: 'https://github.com/GuillaumeGomez/sysinfo',
  },
  {
    name: 'serialport',
    version: '4.10.1',
    license: 'MPL-2.0',
    copyright: 'Bryant Mairs, Jesse Braham',
    use: 'Spricht über USB mit der Box.',
    url: 'https://github.com/serialport/serialport-rs',
  },
  {
    name: 'pcsc',
    version: '2.9.0',
    license: 'MIT',
    copyright: 'Ran Benita',
    use: 'Spricht mit NFC-Lesern am USB wie dem ACR122U.',
    url: 'https://github.com/bluetech/pcsc-rust',
  },
  {
    name: 'symphonia',
    version: '0.5.5',
    license: 'MPL-2.0',
    copyright: 'Philip Deljanov',
    use: 'Liest Audiodateien in der Desktop-App.',
    url: 'https://github.com/pdeljanov/Symphonia',
  },
  {
    name: 'cpal',
    version: '0.17.3',
    license: 'Apache-2.0',
    copyright: 'The CPAL contributors, Pierre Krieger',
    use: 'Spielt beim Anhören in der Desktop-App über Lautsprecher oder Kopfhörer ab.',
    url: 'https://github.com/RustAudio/cpal',
  },
  {
    name: 'thiserror',
    version: '2.0.21',
    license: 'MIT OR Apache-2.0',
    copyright: 'David Tolnay',
    use: 'Verständliche Fehlermeldungen im Programm.',
    url: 'https://github.com/dtolnay/thiserror',
  },
  {
    name: 'libc',
    version: '0.2.190',
    license: 'MIT OR Apache-2.0',
    copyright: 'Copyright (c) The Rust Project Developers',
    use: 'Zugriff auf Linux, zum Beispiel für den freien Platz auf der SD-Karte.',
    url: 'https://github.com/rust-lang/libc',
  },
  {
    name: 'windows-sys',
    version: '0.60.2',
    license: 'MIT OR Apache-2.0',
    copyright: 'Copyright (c) Microsoft Corporation.',
    use: 'Zugriff auf Windows, zum Beispiel für Laufwerke.',
    url: 'https://github.com/microsoft/windows-rs',
  },
  // The desktop app builds the list of "Entdecken" itself (cargo feature "quellen", on by default).
  ...(LOCAL_LIST_DESKTOP
    ? [
        {
          name: 'rustls',
          version: '0.23.43',
          license: 'Apache-2.0 OR ISC OR MIT',
          copyright: 'Joseph Birr-Pixton and the rustls contributors',
          use: 'Verschlüsselte Verbindung, mit der ich die Liste von „Entdecken“ zusammenstelle.',
          url: 'https://github.com/rustls/rustls',
        },
        {
          name: 'webpki-roots',
          version: '1.0.9',
          license: 'CDLA-Permissive-2.0',
          copyright: 'The rustls contributors; die Zertifikate aus dem Programm der Mozilla Foundation',
          use: 'Die Stammzertifikate, mit denen ich die Server der Quellen prüfe.',
          url: 'https://github.com/rustls/webpki-roots',
        },
      ]
    : []),
];

/**
 * Licences of the packages the npm packages above bring along (the
 * production packages of package-lock.json). Where a package offers a
 * choice, as "(MPL-2.0 OR Apache-2.0)", one of these is enough. The test
 * keeps the sentence on the help page true.
 */
export const BUNDLED_DEPENDENCY_LICENSES = ['MIT', 'ISC', 'BSD-3-Clause', 'Apache-2.0', 'Zlib'] as const;

export interface LicenseInfo {
  id: string;
  name: string;
  url: string;
}

/** Every licence named above, with the place of its full text. */
export const LICENSES: readonly LicenseInfo[] = [
  { id: 'MIT', name: 'MIT License', url: 'https://spdx.org/licenses/MIT.html' },
  { id: 'ISC', name: 'ISC License', url: 'https://spdx.org/licenses/ISC.html' },
  { id: 'Apache-2.0', name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  { id: 'BSD-3-Clause', name: 'BSD 3-Clause License', url: 'https://spdx.org/licenses/BSD-3-Clause.html' },
  { id: 'Zlib', name: 'zlib License', url: 'https://spdx.org/licenses/Zlib.html' },
  { id: 'MPL-2.0', name: 'Mozilla Public License 2.0', url: 'https://www.mozilla.org/MPL/2.0/' },
  { id: 'LGPL-2.1', name: 'GNU Lesser General Public License 2.1', url: 'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html' },
  { id: 'LGPL-3.0', name: 'GNU Lesser General Public License 3.0', url: 'https://www.gnu.org/licenses/lgpl-3.0.html' },
  { id: 'GPL-3.0-or-later', name: 'GNU General Public License 3.0 oder später', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
  { id: 'OFL-1.1', name: 'SIL Open Font License 1.1', url: 'https://openfontlicense.org' },
  { id: 'CDLA-Permissive-2.0', name: 'Community Data License Agreement Permissive 2.0', url: 'https://cdla.dev/permissive-2-0/' },
];

/** The licence ids in an SPDX expression like "(MIT OR GPL-3.0-or-later)". */
export function licenseIds(expression: string): string[] {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+|\s+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== 'OR' && s !== 'AND');
}

export function licenseInfo(id: string): LicenseInfo | undefined {
  return LICENSES.find((l) => l.id === id);
}

/**
 * Where the text of a licence id is: the place named above, else the SPDX
 * list. Nothing for what is no SPDX id, like "SEE LICENSE IN …",
 * "UNLICENSED" (npm for "no licence") or "LicenseRef-…".
 */
export function licenseUrl(id: string): string | undefined {
  const known = licenseInfo(id);
  if (known) return known.url;
  if (id === 'UNLICENSED' || id.startsWith('LicenseRef-') || !/^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/.test(id)) return undefined;
  return `https://spdx.org/licenses/${id.replace(/\+$/, '')}.html`;
}

const LICENSE_OPERATORS: Readonly<Record<string, string>> = { OR: 'oder', AND: 'und', WITH: 'mit' };

export interface LicenseWord {
  text: string;
  /** A licence, not "oder", "und", "mit" or a bracket. */
  licence: boolean;
}

/**
 * An SPDX expression split into words for the page: "(MIT OR Apache-2.0)"
 * becomes MIT, " oder ", Apache-2.0. Brackets around the whole expression
 * say nothing and are left out; inner ones stay. Older Cargo files write
 * "MIT/Apache-2.0" for "MIT OR Apache-2.0".
 */
export function licenseWords(expression: string): LicenseWord[] {
  let e = expression.trim();
  if (/^\([^()]*\)$/.test(e)) e = e.slice(1, -1).trim();
  if (!e.includes('://')) e = e.replace(/\s*\/\s*/g, ' OR ');
  return e
    .split(/(\s+(?:OR|AND|WITH)\s+|[()])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((word) =>
      Object.hasOwn(LICENSE_OPERATORS, word) ? { text: ` ${LICENSE_OPERATORS[word]} `, licence: false } : { text: word, licence: word !== '(' && word !== ')' },
    );
}

/** An SPDX expression in words: "MIT oder Apache-2.0". */
export function licenseLabel(expression: string): string {
  return licenseWords(expression)
    .map((w) => w.text)
    .join('');
}
