# Quellen für „Entdecken“

„Entdecken“ zeigt freie Hörspiele, Hörbücher und Lieder für Kinder und Jugendliche.
Die App durchsucht dabei nicht das Internet, sondern eine kleine Liste, die ein
täglicher Lauf aus diesem Ordner baut. In die Liste kommt nur, was eine Person hier
aufgenommen hat.

| Datei | Inhalt |
| --- | --- |
| `catalog.json` | Die Quellen mit Status, Rechten, Altersangaben und Prüfdatum. Nur Einträge mit `"status": "active"` werden veröffentlicht. |
| `released.json` | Titel, die eine Person nach einem Halt angehört und aufgenommen hat. |
| `terms-hashes.json` | Stand der Nutzungsbedingungen (SHA-256 des sichtbaren Textes) für die Wochenprüfung. |
| `snapshot/index-v1.json` | Die Liste, die mit der App ausgeliefert wird. Die App nimmt sie, wenn sie die aktuelle Liste nicht laden kann. |
| `ci/quellen.yml` | Vorschlag für den täglichen Lauf (GitHub Actions), noch nicht aktiv. |

## Notizen der Redaktion

Was nur die Redaktion braucht, steht nicht in `catalog.json`, sondern in einer eigenen Datei
außerhalb des Repos: wer einen Eintrag geprüft hat (`review.by`), offene Punkte
(`openChecks`), eine noch nötige Zustimmung (`permission`), Notizen (`internal`), ein
genauerer Status wie `waiting-permission` und die abgelehnten Quellen (`notUsed`). Die
Skripte unter `scripts/sources` mischen sie ein, wenn es sie gibt:
`SOURCES_EDITORIAL=/pfad/zur/datei.json`, sonst `sources/redaktion.json` (steht in
`.gitignore`). Format und Regeln: `src/core/sources/editorial.ts`. Ohne die Datei baut der
Lauf dieselbe Liste; nur die Prüfungen der Redaktion (Zustimmung, offene Punkte) fehlen dann.
Die App liest `catalog.json` ohne die Notizen.

## Eine Quelle aufnehmen

1. Rechte klären und belegen: Darf man die Dateien für den privaten Gebrauch herunterladen?
   Nur offizielle Feeds, dokumentierte Schnittstellen und die öffentlichen Seiten einer
   Reihe ohne Feed (ARD Sounds, OHRKA: nur was die Seite selbst angibt, siehe „Reihen ohne
   Feed“), keine inoffiziellen Schnittstellen. Abgelehntes kommt mit Grund nach `notUsed` (Notizen der Redaktion).
2. Eintrag in `catalog.json` mit `"status": "review"` anlegen. Offene Punkte in `openChecks`,
   Notizen in `internal`, beides in den Notizen der Redaktion (siehe oben).
3. Vorschau bauen und Folgen anhören (siehe unten).
4. Für die Aufnahme: `"status": "active"` und `"review": { "at": "2026-10-12", "next": "2027-04-12" }`,
   den Namen (`reviewBy`) in die Notizen der Redaktion.
   `next` ist spätestens nach sechs Monaten. Ist die Prüfung überfällig, warnt der Lauf;
   nach 60 Tagen nimmt er die Quelle aus der Liste, bis sie wieder geprüft ist.
   Die App zeigt `review.at` als „Rechte und Inhalte zuletzt geprüft am …“.

Eine Quelle wird nur `active`, wenn
- `openChecks` leer ist (jeder offene Punkt ist erledigt oder gestrichen),
- Podcasts und Quellen „nur privat“ ihre Nutzungsbedingungen in `rights.termsUrl` haben und
  deren Stand in `terms-hashes.json` steht (Bedingungen lesen, dann
  `npm run sources:check -- --update-hashes`),
- eine nötige Zustimmung belegt ist (Ausnahme: ein Podcast mit `"delivery": "browser"` und ein Link-Eintrag (OHRKA) werden nur als Link angeboten; die Familie speichert die Folgen auf der Seite des Senders selbst. So stehen die ARD-Reihen in der Liste, bis der Sender dem Speichern über die App zustimmt; danach `delivery` auf `direct`): `"permission": { "needed": "Schriftliche Zustimmung von …",
  "granted": { "by": "Name", "at": "2026-10-12", "filed": "wo das Schreiben liegt" } }`.
  Der Status `waiting-permission` braucht `permission.needed`,
- Global Storybooks auf einen Commit festgelegt ist (`ref` mit 40 Hex-Zeichen statt `master`;
  nach einer Prüfung von Hand weiterstellen),
- ein archive.org-Album die geprüften Dateien mit `sha1` nennt (`"files": [{ "name": "…mp3", "sha1": "…" }]`,
  aus den Metadaten von archive.org). Kommt eine Datei dazu oder ändert sich eine, hält der Lauf das ganze Album,
- jeder Titel eines Link-Eintrags (OHRKA) eigene `ages` hat.

Regeln, die der Lauf erzwingt (`validateCatalog`): eindeutige ids aus Kleinbuchstaben,
Ziffern und Bindestrichen; nur https-Adressen; Podcasts mit mindestens einem erlaubten
`mediaHost` (keine Messdienste wie podtrac); CC-Lizenzen als Link, den die App versteht;
Lizenzen ohne Bearbeitung (ND) nur mit `"editPolicy": "unchanged"`; Alter 0 bis 18;
dazu die Regeln für `active` oben. Verbieten die Bedingungen Änderungen an den Dateien
(z. B. SRG, Deutschlandradio), gilt `"editPolicy": "unchanged"`: Die Datei kommt Byte für Byte
auf die Karte, und die App nimmt auf der Seite der Quelle keine Datei an, die sie nicht wiedererkennt.

## Anbieter: Abspielen und Speichern

Was ein Anbieter erlaubt, steht einmal in `src/core/sources/providers.ts`, mit den Worten seiner
Bedingungen und dem Tag, an dem jemand sie gelesen hat. Einträge finden ihre Zeile über
`rights.termsUrl`. Freie Lizenzen (CC, gemeinfrei) brauchen keine Zeile, eine schriftliche
Zustimmung (`permission.granted`) auch nicht. Jeder andere aktive Eintrag braucht eine.

| Anbieter | Bedingungen | Abspielen in der App | Speichern | Stand |
| --- | --- | --- | --- | --- |
| ARD Sounds | https://www.ardsounds.de/nutzungsbedingungen/ | Player der ARD (`twitter:player` der Folgenseite, `https://www.ardsounds.de/embed/episode/<Nummer>/`), erst nach einem Klick | nur auf der Seite der Folge („Herunterladen“), die App verlinkt dorthin | 2026-10-15 |
| Deutschlandradio (Kakadu) | https://www.kakadu.de/nutzungsbedingungen-106.html | Dateien des Kakadu-Feeds; Kakadu-Sendungen auf ARD Sounds im Player der ARD | nur auf der Seite | 2026-10-15 |
| OHRKA | https://www.ohrka.de/impressum | die Datei von www.ohrka.de | erlaubt (privat und für Bildung); ohne CORS öffnet die App die Datei, du speicherst sie, die App findet sie im Download-Ordner | 2026-10-05 |
| SRG SSR | https://www.srgssr.ch/de/nutzungsbedingungen | die Dateien von download-media.srf.ch | einmal herunterladen und speichern, unverändert | 2026-10-05 |

Der Lauf übernimmt nur Player und Dateien, die die Zeile erlaubt (`playable` in `build.ts`), das
Tor vor dem Veröffentlichen lehnt jeden anderen Player ab, und die App lässt ihn beim Lesen der
Liste weg. `delivery: "direct"` geht nur, wo die App speichern darf. Nichts davon umgeht einen
Schutz: Die App lädt nichts, was die Bedingungen nur auf der Seite des Anbieters erlauben.
Ändern sich die Bedingungen, ändert sich die Zeile (und `checkedAt`).

Im Katalog steht der Player einer ARD-Folge als `embed` am Titel (`"embed":
"https://www.ardsounds.de/embed/episode/16329591/"`), die Datei einer OHRKA-Geschichte als `fileUrl`
(die Adresse, die ihre Seite verlinkt). Beides nur so, wie die Seite es nennt, nie geraten. Liest der
Lauf die Seite, gewinnt, was dort steht.

Entscheidungen aus 0.4 (2026-10-15):

- ARD Sounds: Alle ARD-Sendungen sind Link-Einträge auf ARD Sounds, jede Folge mit dem Player der ARD.
  Mumins, Pfefferkörner, MausHörspiel lang und Sandmännchen waren Podcasts, deren Feeds nie erreichbar
  waren; ihre Dateien hätte die App ohne Zustimmung angeboten. Die Feed-Hosts der Sender
  (`www1.wdr.de`, `kinder.wdr.de`, `www.ndr.de`, `www.antennebrandenburg.de`) sind deshalb aus der
  Liste der Desktop-App heraus.
- Ohrenbär und MausHörspiel kurz warteten als Podcasts auf den rbb bzw. WDR; als Links auf ARD Sounds
  brauchen sie keine Zustimmung. Ohrenbär nur mit den kompletten Hörgeschichten (`series.noNew`), weil
  die Sendung sonst jede Geschichte in vielen Teilen einstellt.
- Neu: Der kleine Prinz und seine Freunde (WDR) und Dr. Brumm (rbb).
- Nicht genommen: Die Märchen der ARD (Ton der Märchenfilme, kein Hörspiel) und Narnia (nur noch Buch 7,
  bis 2026-12-31). Steht in `notUsed`.
- OHRKA: Speichern ist erlaubt. Für Alice im Wunderland und Der Zauberer von Oz steht die Datei im
  Katalog; die übrigen bringt der Lauf von ihren Seiten, sobald er sie lesen kann.

Aus der Wochenrunde vom 27.10.2026 (0.6), alles nur als Link:

- Neu: Mimi Sandmädchen (rbb), Hörspiele für die Kleinsten. Die Seiten nennen kein Alter; die Redaktion
  schätzt 2 bis 4, neue Folgen bekommen das Alter der Reihe (`series.agesFromSeries`). Nicht angehört.
- Ohrenbär: zwei komplette Hörgeschichten dazu, „Als der Herbst seine Farben verlor“ (ab 6) und „Emil und
  die Zauberlaterne“ (ab 4), Player und Ablauf von ihren Seiten.
- Krümelgeschichten (MDR SACHSEN) wartet als `check`: Der MDR nennt kein Alter, vorher anhören.
- In `snapshot/index-v1.json` stehen die neuen Titel so, wie `buildIndex` sie aus dem Katalog baut
  (ohne Netz); der nächste Lauf ersetzt die Datei.

## Altersangaben

`ages.source` sagt, woher die Angabe kommt: `publisher` (mit dem Wortlaut in `text`, wörtlich
zitiert, ohne eigene Zusätze) oder `editor` (Einschätzung der Redaktion). Die App schreibt
„Empfohlen ab …“: Altersangaben sind Empfehlungen.
Altersangaben in Titel, Beschreibung und Shownotes („(Ab 8 Jahren)“, „ab 6 bis 9“, „12+“, „FSK 12“,
„Ü18“, „für Erwachsene“) liest der Lauf alle mit; die höchste gilt. Er engt sie auf die Reihe ein.
Titel ab 16 nimmt er nie auf, ebenso Folgen oder Feeds, die der Anbieter als `explicit` markiert.

## Halt und Aufnahme einzelner Titel

Neue Folgen bleiben draußen, bis jemand sie angehört hat, wenn
- Titel, Beschreibung, Zusammenfassung oder Shownotes Warnwörter enthalten (Grusel, Gewalt oder Tod,
  Sexualität, Drogen oder Alkohol, Werbung, Warnhinweise). Der Lauf liest den Text dafür ohne HTML,
  mit allen Sonderzeichen und auch in zusammengesetzten Wörtern („Doppelmord“, „Werbepause“).
  Feste Sätze einer Quelle, die immer vorkommen, stehen in `ignorePhrases` (mindestens drei Wörter),
- die Altersangabe der Folge über der Reihe liegt,
- eine Geschichte im Katalog eine `review`-Notiz hat, oder
- die Quelle `"holdNew": true` hat (dann jede neue Folge, z. B. bei Radio Klops).

Der Lauf listet gehaltene Titel im Bericht und im Issue „Quellen: N Titel warten auf Prüfung“.
Zum Aufnehmen den Schlüssel eintragen, bei Bedarf mit eigener Altersangabe:

```json
{ "format": 1, "released": [
  { "key": "global-storybooks-de/0262", "by": "Name", "at": "2026-10-12", "note": "angehört, ab 6", "ages": { "min": 6, "max": 9 } }
] }
```

## Qualitätsfilter

Auch aus guten Quellen kommt kein Ausschuss in die Liste. Jeder Lauf prüft alle Titel, auch
die schon in der Liste stehen (Regeln und Grenzen in `src/core/sources/quality.ts`). Ändert ein
Anbieter den Text einer Folge oder ändern wir eine Grenze, kann ein Titel also wieder herausfallen
oder auf Prüfung warten. Solche Titel zählen auch beim Schutz gegen eine stark geschrumpfte Liste
(höchstens 20 % weniger Titel als beim letzten Mal, sonst `"allowShrink": true`):

| Was | Folge |
| --- | --- |
| Trailer, Teaser, Vorschau, Ankündigung, Hörprobe, Programmhinweis, „in eigener Sache“ im Titel, oder der Feed markiert die Folge als `trailer` | abgelehnt |
| eines dieser Wörter am Anfang der Beschreibung (erste 160 Zeichen) | Halt |
| Hörspiel oder Hörbuch kürzer als 3 Minuten, Lied kürzer als 45 Sekunden | abgelehnt |
| geschätzte Bitrate unter 48 kbit/s (nur wenn Größe und Länge bekannt sind) | Halt |
| keine Beschreibung außer dem Titel | aufgenommen und als `sparse` markiert; fehlt mehr als 20 % der Titel einer Quelle der Text oder die Länge, steht die ganze Quelle weiter unten. Die Reihenfolge der Titel in einer Quelle bleibt |

Kurze Titel, die trotzdem gut sind (Gutenachtgeschichten, Bilderbuch-Lesungen), erlaubt die
Quelle mit `"minSeconds": 20` (0 bis 600; senkt die Grenze nur). Ein Titel, der in
`released.json` steht, kommt immer durch. Der Bericht zählt die Titel je Grund
(`report.json` unter `quality`, im Issue unter „Qualitätsfilter“).

## Empfehlungen

Die Redaktion kann bis zu 12 Empfehlungen setzen. „Entdecken“ zeigt sie oben in einem eigenen
Bereich, die Startseite der App bis zu drei davon. Eine ganze Quelle empfiehlt man in
`catalog.json`, einen einzelnen Titel in `released.json`:

```json
{ "id": "ard-hoerspielklassiker", "status": "active", "featured": { "rank": 10, "why": "Die großen Kinderbuch-Klassiker als richtige Hörspiele, mit Musik und vielen Stimmen." }, … }

{ "key": "global-storybooks-de/0262", "by": "Name", "at": "2026-10-12", "featured": { "rank": 2, "why": "Kurz, lustig und gut für die Kleinsten." } }
```

`validateCatalog` und `validateReleased` lehnen ab: Empfehlungen für Quellen, die nicht `active` sind,
denselben `rank` zweimal (Quellen und Titel zusammen), ein fehlendes `why` oder eines mit mehr als
140 Zeichen oder mehr als einem Satz, mehr als 12 Empfehlungen und einen Titel, dessen Quelle schon
als Ganzes empfohlen ist. `why` ist ein kurzer deutscher Satz in der Du-Form: warum es sich lohnt,
ohne Werbesprache. Steht ein empfohlener Titel nicht in der Liste (gehalten, abgelehnt, nicht mehr
im Feed), meldet der Lauf das unter „Hinweise für die Redaktion“.

Eine empfohlene Quelle mit `"single": true` steht oben nicht als Ganzes, sondern mit ihren ersten
drei Geschichten (`PICK_STORIES` in `src/core/sources/filter.ts`), jede mit eigenem Bild. Teile einer
Geschichte („(1/3)“, „(2/3)“) bleiben zusammen. Die erste Geschichte jeder Quelle kommt vor der zweiten
irgendeiner Quelle, innerhalb einer Runde nach `rank`. Alle ARD-Sendungen und OHRKA haben `single`.

In der Liste stehen die Empfehlungen als `featured` an der Quelle oder am Titel. Ältere Versionen der
App kennen das Feld nicht und lassen es weg; das Format bleibt `1`.

## Cover

„Entdecken“ zeigt nur das Bild, das eine Quelle selbst veröffentlicht, nie ein gezeichnetes.
Ohne Bild bleibt ein ruhiges, leeres Feld in derselben Größe; ein Bild blendet weich ein, sobald es
geladen ist. Der Lauf übernimmt es in das optionale Feld `cover` (an der Quelle, an einem Titel nur,
wenn es anders ist) und schreibt in `coverFrom`, woher es kommt; die App zeigt das klein unter dem
Bild auf der Seite der Quelle. Das Format bleibt `1`, ältere Apps übergehen beide Felder.

| Art | Woher das Cover kommt |
| --- | --- |
| Podcast | Bild des Feeds (`itunes:image`, sonst `<image><url>`), je Folge ihr eigenes `itunes:image` |
| archive.org-Album | ein Bild (JPEG oder PNG), das der Uploader ins Album gelegt hat, „cover“, „folder“ oder „front“ im Namen zuerst |
| Link-Einträge | aus dem Katalog: `cover` am Eintrag und je Titel (`items[].cover`), das Bild, das die Seite des Anbieters zeigt (ARD Sounds: `og:image` der Sendungs- bzw. Folgenseite, mit fester Breite `w=448` statt `{width}`; ohrka.de: das Bild der Titelseite) |
| Global Storybooks, Commons | keins |

Ein eigenes Bild setzt man in `catalog.json` mit `"cover": "https://…"` und `"coverFrom": "…"` (woher es
kommt, unter welchen Bedingungen); es ersetzt das der Quelle. So haben die ARD-Reihen (Podcasts nur als Link) das
Bild ihrer Sendung bei ARD Sounds. Nur Original-Bilder des Anbieters.
Erlaubt ist nur https, kein Messdienst, und der Host muss einer sein, den der Eintrag ohnehin nutzt
(Seite, Seiten der Titel, Dateien; im Katalog auch `linkHosts` und `mediaHosts`) oder ein bekannter
Bilder-Host aus `COVER_HOSTS` in `src/core/sources/cover.ts` (z. B. archive.org mit Subdomains,
bilder.deutschlandfunk.de, images.podigee-cdn.net). Ein anderes Cover lässt der Lauf weg und nennt es
unter „Hinweise für die Redaktion“; dann den Host dort ergänzen oder ein eigenes Bild setzen. Die App
prüft dieselbe Regel und lässt ein unpassendes Cover weg, nie die Quelle.

Die App lädt Cover nur auf der Seite „Entdecken“, ohne Referrer und ohne Cookies (`crossorigin`).
Ein Server, der dafür keinen CORS-Header schickt, bekommt das gezeichnete Cover, ebenso jedes Bild,
das nicht lädt. Die Startseite zeigt immer das gezeichnete Cover, sie lädt nichts aus dem Internet.

## Titel und Links der Folgen

Der Lauf entfernt Vorsilben wie „Kinderhörspiel - “ aus den Titeln: feste Texte in `titlePrefixes`,
Varianten mit einem Ausdruck in `titlePattern` (beginnt mit `^`). Beginnt ein Titel danach noch mit
dem Namen der Reihe, steht das als Hinweis im Bericht; ein eigener Titel kommt dann nach
`titleOverrides` (`{ "id/guid": "Titel" }`). Zählt eine Reihe ihre Folgen am Ende des Titels
(„Verzockt (5/26)“), lässt `"dropCounter": true` den Zähler weg; die Reihenfolge der Liste bleibt.
Nicht für Teile einer Geschichte („Die Schatzinsel (1/3)“), die legt die App zusammen.

Den Link einer Folge übernimmt der Lauf nur, wenn er auf den Host von `pageUrl` oder einen Host in
`linkHosts` zeigt; sonst nimmt er die Seite der Sendung aus dem Feed oder `pageUrl`. Auch das steht
als Hinweis im Bericht. Bei Quellen, die das Laden nur über ihre Webseite erlauben, öffnet die App
die Datei selbst („Datei öffnen“); Titel ohne Datei und ohne eigene Seite meldet der Bericht.

## Nicht mehr online

Antwortet eine Quelle beim Lauf mit 404 oder 410 oder kennt archive.org die Kennung
nicht mehr, nimmt der Lauf ihre Titel sofort aus der Liste (im Bericht „nicht mehr beim Anbieter“).
Zeitüberschreitungen, Serverfehler und 429 lassen die Titel von gestern stehen.

Die App prüft zusätzlich, wenn jemand „Entdecken“ öffnet (nie beim Start im Hintergrund), ob die
Titel noch da sind (`src/core/sources/reach.ts`): bei archive.org eine kleine Abfrage je Item, bei
anderen Dateien, die sie selbst lädt, eine HEAD-Anfrage auf die erste Datei. Nur eine klare Antwort
„gibt es nicht mehr“ blendet einen Titel aus; Netzwerkfehler ändern nichts. Antworten merkt sie sich
im Browser-Speicher: „online“ eine Woche, „weg“ einen Tag (danach fragt sie neu, ein Titel kommt
also zurück). Titel, die nur über die Webseite des Anbieters gehen, prüft der Lauf.

## LibriVox

Seit 0.4 gibt es keine LibriVox-Hörbücher mehr in „Entdecken“, und der Code dafür ist entfernt
(Frank am 14.10.2026: „Librivox kannst du da rausschmeißen.“). Laienaufnahmen schwanken zu stark.
Der Grund steht in `notUsed`. Ältere Listen, die die App noch aufbewahrt, verlieren die Einträge
beim Lesen, weil die App die Art `librivox` nicht mehr kennt.

## Sofort entfernen

Entry-id oder Titel-Schlüssel in `blocked` in `catalog.json` eintragen. Der nächste Lauf
veröffentlicht die Sperrliste; die App blendet gesperrte Einträge auch in älteren Kopien aus
und bricht einen laufenden Download davon ab.

## Befehle

```sh
npm run sources:build        # Liste bauen (nur "active") nach dist-sources/
npm run sources:check        # Wochenprüfung: Seiten, je eine Datei, Nutzungsbedingungen, fällige Prüfungen
npm run sources:check -- --update-hashes   # nach dem Lesen geänderter Bedingungen den neuen Stand speichern
npm run sources:snapshot     # die mit der App ausgelieferte Liste erneuern
npm run sources:fixtures     # Testdaten aus dem Netz holen (nach .sources-cache/fixtures/, zum Vergleichen)

# Vorschau mit Einträgen im Status "review" (wird nie veröffentlicht)
npm run sources:build -- --include active,review --out public/quellen/index-preview.json
VITE_SOURCES_INDEX_URL=/quellen/index-preview.json npm run dev
```

Ohne Netz geht die Vorschau auch mit der Beispielliste aus den Tests:
`tests/fixtures/sources/index/index-v1.sample.json` nach `public/quellen/index-preview.json` kopieren.

Umgebungsvariablen für den Lauf: `SOURCES_CONTACT_URL` (Kontaktseite, steht im User-Agent),
`SOURCES_WEB_ORIGIN` (Web-Adresse der App, für den CORS-Test; ohne sie gilt keine Quelle als
direkt ladbar). Für die App: `VITE_WEB_ORIGIN` (von dort lädt die Desktop-App die Liste),
`VITE_SOURCES_CONTACT` (E-Mail-Adresse für „Melden“; ohne sie zeigt die App keinen Melden-Link),
`VITE_SOURCES_INDEX_URL` (andere Liste, z. B. die Vorschau).

„Entdecken“ ist nur in einem Build, der eine Liste zeigen kann: Die mitgelieferte Liste
(`sources/snapshot/index-v1.json`) hat Einträge, oder `VITE_SOURCES_INDEX_URL` ist gesetzt, bei der
Desktop-App auch `VITE_WEB_ORIGIN`. Seit 0.2 liegt im Repository eine Liste (gebaut durch `buildIndex`, `publishGates` und
`validateIndex`; die LibriVox-Bücher sind seit 0.4 heraus). Die ARD-Sendungen stehen darin als
Link-Einträge, jede Folge mit ihrer Seite auf ARD Sounds und dem Player der ARD: Mumins, Pfefferkörner,
MausHörspiel lang und kurz, Sandmännchen, Ohrenbär, Der kleine Prinz und seine Freunde, Dr. Brumm,
Hörspielklassiker für Kinder, Mucks Wüstenfuchs und Pumuckl. Dazu OHRKA. Der Kakadu-Feed war beim Bau
nicht erreichbar und fehlt deshalb. Die ARD stellt Folgen nur eine Zeit lang bereit; das Ablaufdatum jeder
Folge (`unavailable_after` der Folgenseite) steht am Titel als `until` (`"until": "2027-10-02"`, im Katalog
je Titel eines Link-Eintrags, in der Liste je Titel). Ab diesem Tag lässt der Lauf den Titel weg, auch
unter den Titeln von gestern, und die App blendet ihn aus, ohne nachzufragen; hat eine Quelle keinen
Titel mehr, verschwindet sie. Abgelaufene Folgen trotzdem bei jeder Prüfung streichen). Damit hat jeder Build „Entdecken“.
Die Web-App zeigt diese Liste, die Desktop-App baut ab ihr selbst weiter (siehe unten). `SOURCES_SNAPSHOT=off`
baut ohne sie. In 0.3 und 0.4 wurde sie ohne Netz neu gebaut (`buildIndex` über den Katalog, mit der alten Liste als
Titel von gestern, dann `publishGates`; 0.4: 12 Quellen, 94 Titel); mit Netz `npm run sources:snapshot`
laufen lassen.

Ein Build mit „Entdecken“ bricht ohne `VITE_SOURCES_CONTACT` ab. Die Desktop-App braucht keine
Adresse der Liste mehr, sie baut sie selbst; nur mit `VITE_SOURCES_INDEX_URL` muss das eine
vollständige https-Adresse sein. So erscheint keine Version ohne „Melden“. Für einen Testbuild ohne diese Angaben: `SOURCES_RELEASE_CHECK=off npm run build`.
Mehr dazu in `docs/BUILD.md` im Abschnitt „Entdecken“.

## Die Liste in der Desktop-App

Die Desktop-App lädt keine veröffentlichte Liste, sondern stellt sie auf dem
Computer selbst zusammen: mit demselben Code wie der Lauf (`collectAndBuild` in
`src/core/sources/collect.ts`, danach `publishGates`), aus dem `catalog.json` und
`released.json`, mit denen sie gebaut wurde. Dafür braucht es keinen Server. Nur
Einträge mit `"status": "active"`; Halt, Qualitätsfilter, Altersgrenzen und Hosts
gelten wie im Lauf. Höchstens ein Lauf am Tag, wenn jemand „Entdecken“ öffnet; die
Liste liegt im Datenordner der App (`entdecken/liste.json`). Beim ersten Mal und
wenn ein Lauf fehlschlägt, zeigt sie die zuletzt gebaute Liste, sonst die
mitgelieferte (`snapshot/index-v1.json`). Nur ein Desktop-Build mit
`VITE_SOURCES_INDEX_URL` (z. B. eine Vorschau) lädt stattdessen diese Liste.

Die Sperrliste (`blocked`) und neue Quellen kommen in der Desktop-App nur mit einer
neuen Version, weil sie den Katalog mitbringt. Was ein Anbieter selbst entfernt
(404/410, abgelaufenes `until`), verschwindet dagegen beim nächsten Lauf.

Die Anfragen gehen über das Programm der App (`src-tauri/src/sources_net.rs`,
cargo-Feature `quellen`, an in jedem Build): nur GET über https, User-Agent
`TonUINO-Studio-Quellen/1.0 (Desktop-App)`, 20 Sekunden und höchstens 10 MB je
Antwort, keine Weiterleitungen, keine Adressen im eigenen Netz, und nur an diese
Hosts: der Feed-Host des aktiven Podcasts (`www.kakadu.de`) und die Seiten der Reihen ohne Feed
(`www.ardsounds.de`, `www.ohrka.de`). Wird eine Quelle mit einem anderen Host aktiv,
schlägt ein Test fehl, bis der Host dort eingetragen ist.

Die Prüfung der Nutzungsbedingungen (`terms-hashes.json`) macht die App nicht:
Den Stand hält `npm run sources:check -- --update-hashes` fest, nachdem eine Person
die Bedingungen gelesen hat. Ohne diesen Stand bricht `npm run sources:build` bei
aktiven Podcasts ab.

## Die Liste in der Web-App

Der Browser darf Feeds und Seiten der Anbieter nicht lesen (kein CORS). Die Web-App
zeigt deshalb die mitgelieferte Liste, oder die Liste unter `VITE_SOURCES_INDEX_URL`,
wenn jemand sie veröffentlicht. Beim Öffnen prüft sie, welche Titel noch da sind
(`reach.ts`), und blendet Titel nach ihrem `until` aus. Neue Folgen bekommt sie erst
mit einer neuen mitgelieferten Liste: `npm run sources:snapshot` auf einem Rechner mit
Netz, danach die Web-App neu bauen.

## Reihen ohne Feed: Seiten lesen

Ein Link-Eintrag kann `series` haben: `{ "reader": "ardsounds" | "ohrka", "urls": [...] }`.
Der Lauf liest dann die Seiten der Reihe (bei ARD Sounds die Seite der Sendung, bei
OHRKA die Themenseiten) und jede Titelseite (`src/core/sources/pages.ts`): Titel, Bild
(`og:image`, bei OHRKA das Bild zum Hörbuch), Beschreibung, Altersangabe („Ab 7 Jahre“),
Länge, Ende der Verfügbarkeit (`unavailable_after`) und die Sprecher („gelesen von …“).
Titel im Katalog bekommen so ihr aktuelles Bild und Ablaufdatum; neue Titel auf diesen
Seiten nimmt der Lauf nur nach festen Regeln auf (`src/core/sources/rules.ts`, höchstens
20 je Lauf):

1. Nur Reihen, die eine Person aufgenommen hat (`active` mit `series`). Neue Quellen kommen
   nie von selbst.
2. Eine echte Folge mit Titel, kein Extra, Trailer oder Ankündigung.
3. Auf Deutsch.
4. Mit Altersangabe: die der Titelseite, sonst die der Seite, die den Titel listet
   (`series.pageAges`, wörtlich, z. B. OHRKA „Für alle Kinder ab 8“), sonst die der Reihe,
   wenn `series.agesFromSeries` gesetzt ist. Nie ab 16, nie über der Reihe.
5. Lang genug und mit bekannter Länge.
6. Noch mindestens 30 Tage verfügbar.
7. Keine Warnwörter in Titel und Beschreibung.

Was eine Regel nicht erfüllt, bleibt draußen (im Bericht unter „Warten auf Prüfung“).
`series.noNew` liest nur die Titel im Katalog. Antwortet eine Titelseite oder ein Eintrag
mit 404 oder 410, kommt er in die Liste `gone` des Laufs und erscheint nie wieder.

`"single": true` zeigt die Titel eines Eintrags auf „Entdecken“ als eigene Karten (OHRKA,
Hörspielklassiker), jede mit Bild, Sprecher, Alter und Kurzbeschreibung.

## Kurzbeschreibungen

Jeder Titel und jede Quelle bekommt ein bis zwei Sätze aus dem Text der Quelle selbst
(`about`, `src/core/sources/about.ts`): Beschreibung im Feed, Meta-Beschreibung der
Titelseite. Der Text wird nur gekürzt, nie umgeschrieben.
Texte, die nicht beschreiben (Mitwirkende, Links) oder nicht deutsch sind, fallen weg;
dann zeigt die App nichts. `blurb` bleibt der eigene Text der Redaktion und geht vor.

## Wissen

Wissenssendungen für Kinder (Kategorie `wissen`) kommen wie Hörspiele aus offiziellen
Feeds oder Seiten. Aufgenommen sind „Kakadu – Der Kinderpodcast“ (Deutschlandfunk Kultur),
„CheckPod“ und „Anna und die wilden Tiere“ (BR), alle als Link. Die Maus-Formate stehen
nur 30 Tage bereit, Lilipuz und Kinder-Uni haben wir nicht gefunden (`notUsed`).

## Wie der Lauf lädt

Eine Anfrage nach der anderen, User-Agent `TonUINO-Studio-Quellen/1.0 (+Kontakt)`,
20 Sekunden Zeitlimit, höchstens 10 MB je Antwort, nur https, bedingte Anfragen (ETag),
bei archive.org mindestens eine Sekunde Abstand, bei 429/503 so lange
warten wie verlangt (höchstens drei Versuche). Fällt eine Quelle aus, bleiben ihre Titel
von gestern stehen. Je Medien-Host prüft der Lauf eine echte Datei aus Sicht aller
App-Herkünfte (Web und Desktop); nur wenn alle durchkommen, lädt die App die Dateien
direkt, sonst über die Webseite des Anbieters. Jede Weiterleitung muss auf den erlaubten Hosts
der Quelle bleiben (`mediaHosts`, sonst die festen Hosts der Art wie archive.org oder gitlab.com,
jeweils mit Subdomains) und darf keinen Messdienst berühren;
sonst listet der Lauf die Dateien dieses Hosts nicht. Die App lehnt eine Datei ab, deren
Antwort am Ende von einem Messdienst kommt.

Vor dem Veröffentlichen prüft der Lauf: Liste lesbar, unter 2 MB, mindestens ein Eintrag,
höchstens 20 % weniger Titel als zuletzt (sonst `"allowShrink": true` im Katalog setzen),
keine Altersangabe ab 16, nur erlaubte Hosts über https, keine Messdienste, keine Felder
nur für die Redaktion, keine E-Mail-Adressen. Schlägt etwas fehl, bleibt die alte Liste.
