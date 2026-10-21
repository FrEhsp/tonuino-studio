# TonUINO Studio

TonUINO Studio hilft Eltern, eine [TonUINO](https://www.tonuino.de)-Box zu
befüllen, ohne sich mit Ordnernummern und Dateinamen herumzuschlagen:

- **Hinzufügen:** Hörspiele, Hörbücher und Musik auf die SD-Karte bringen.
  Die App wandelt in MP3 um, gleicht die Lautstärke an, teilt lange Dateien
  und nummeriert alles so, wie die Box es braucht.
- **Meine Box:** sehen, was auf der Karte ist, und Fehler auf der Karte finden
  und reparieren.
- **Karten beschreiben:** an der Box, mit dem Handy (NFC), mit einem NFC-Leser
  am Computer oder über WLAN.
- **Sticker drucken:** Etiketten für die Karten, mit Cover oder Piktogramm.
- **Werkstatt:** Firmware (TonUINO TNG) auf die Box spielen und die Box prüfen.
- **Entdecken:** freie Hörspiele und Lieder für Kinder, die man legal laden darf.

Die App arbeitet auf dem eigenen Gerät. Es gibt kein Konto, und sie lädt
keine Hörspiele, Bilder oder Karten irgendwo hoch.

## Plattformen

| Fassung | Hinweis |
|---|---|
| Web-App | Chrome und Edge schreiben direkt auf die SD-Karte. Firefox und Safari packen alles Neue in ein Paket für die Karte. |
| Windows | Installer (`.exe`, x64) |
| Linux | `.deb`-Paket und AppImage (x86_64, aarch64) |
| macOS | Universal-App (Apple Silicon und Intel), nur ad hoc signiert |
| Android | App für Handy und Tablet, Karten über NFC, SD-Karte über USB-Kartenleser |

NFC-Leser am Computer und Boxen mit WLAN gehen nur mit der Desktop-App.

## Bauen

Voraussetzungen: Node.js 20.19 oder 22.12 und neuer mit npm, für die
Desktop-App außerdem Rust (stable, über [rustup](https://rustup.rs)).

```sh
npm ci
npm run dev          # Web-App zum Entwickeln, http://localhost:5173
npm test             # Tests (vitest)
npm run typecheck    # TypeScript prüfen
npm run build        # Web-App nach dist/
```

Die fertigen Pakete bauen Skripte:

```sh
scripts/build-linux.sh      # .deb und AppImage
scripts/build-windows.sh    # Windows-Installer, unter Linux gebaut
scripts/build-android.sh    # Android-App (braucht einen eigenen Signierschlüssel)
```

Die Mac-App baut GitHub Actions (`.github/workflows/mac.yml`). Alle
Voraussetzungen, Einstellungen und Grenzen stehen in
[docs/BUILD.md](docs/BUILD.md), der Aufbau des Codes in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Lizenz

TonUINO Studio ist freie Software unter der GNU General Public License,
Version 3 oder später (GPL-3.0-or-later). Der Text steht in [LICENSE](LICENSE).

Nicht unter der GPL stehen:

- das TonUINO-Logo (`src/features/stickers/tonuino-logo.png`, siehe unten),
- die Schriften in `src/assets/fonts` (SIL Open Font License bzw. Apache 2.0,
  Lizenztexte daneben),
- Testdaten mit eigener Lizenz, die jeweils in einer README daneben steht,
  zum Beispiel ein Hörbeispiel von Global Storybooks in
  `tests/fixtures/sources/gitlab` (CC BY 3.0).

Die Firmware-Dateien in `public/firmware/baukasten` sind Bauten von
[TonUINO TNG](https://github.com/tonuino/TonUINO-TNG) (GPL-3.0). Welche
Quellen, Commits und Einstellungen in jedem Bau stecken, steht in
`public/firmware/baukasten/manifest.json` und in
[docs/FIRMWARE-BAUKASTEN.md](docs/FIRMWARE-BAUKASTEN.md).

Die Pakete anderer Projekte, die in der App stecken, listet die App selbst
mit ihren Lizenztexten (Hilfe, „Bausteine anderer Projekte“).

## Marke

„TonUINO“ ist eine Marke von Thorsten Voß.
