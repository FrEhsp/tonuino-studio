/**
 * What the settings page shows: the choices of every setting and a short
 * explanation in plain German. The texts describe what the code that reads
 * a setting really does (add/process.ts, tonuino/sd.ts, cards/*), so change
 * them together. Plain data and functions, so tests can check that every
 * setting has a control, an explanation and a working help link.
 */
import type { CardMethod, Settings } from '../../app/state';
import { ADMIN_KEYS, ADMIN_KEYS_FIVE } from '../../core/tonuino/adminkeys';
import type { AdminAccess, TngRelease } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { normalizeBoxAddress } from '../../core/tonuino/esp32';

export type SettingKey = keyof Settings;

export interface Choice<T> {
  value: T;
  label: string;
  /** Short name for the summary before a reset, when `label` does not read well alone. */
  short?: string;
  /** One line under a big choice. */
  text?: string;
  /** Only in the desktop program for Windows and Linux. */
  desktopOnly?: boolean;
}

export interface SettingText {
  /** Label of the control. */
  label: string;
  /** Short name for lists, when the label is a question or half a sentence. */
  name?: string;
  /** One line under the control. */
  hint: string;
  /** "Mehr erfahren": short paragraphs. */
  more: string[];
  /** Help section with more background, as in #/hilfe/<id>. */
  help?: string;
}

export const THEMES: Choice<Settings['theme']>[] = [
  { value: 'auto', label: 'Automatisch' },
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
];

export const PROFILES: Choice<FirmwareProfile>[] = [
  { value: 'tng', label: 'TonUINO TNG' },
  { value: 'classic21', label: 'TonUINO 2.1' },
];

/**
 * Phrased to follow "Das Admin-Menü öffnest du mit", as in the guide at the
 * box. The page offers only those of adminAccessFor(profile): the sum to
 * solve exists in TonUINO 2.1 only.
 */
export const ADMIN_ACCESS: Choice<AdminAccess>[] = [
  { value: 'buttons', label: 'den Tasten', short: 'Tasten' },
  { value: 'card', label: 'der Admin-Karte', short: 'Admin-Karte' },
  { value: 'pin', label: 'einer PIN', short: 'PIN' },
  { value: 'calc', label: 'einer Rechenaufgabe', short: 'Rechenaufgabe' },
];

/** TNG 3.3.3 came out twice; only the release of 17.09.2026 asks Hörbuch cards for a last folder and knows the Endlos card. */
export const TNG_RELEASES: Choice<TngRelease>[] = [
  { value: 'older', label: 'vor 17.09.2026' },
  { value: 'newer', label: 'ab 17.09.2026' },
  { value: 'unknown', label: 'Weiß nicht' },
];

/** The releases as words in the sentence "Das TNG der Box ist …" (Einstellungen and the guide at the box). */
export const TNG_RELEASE_WORDS: Record<TngRelease, string> = { older: 'älter als das vom 17.09.2026', newer: 'vom 17.09.2026 oder neuer', unknown: 'weiß ich nicht' };

/** The quality in words first, the number small behind it (audit 0.4 #22): parents read „normal“, not „128 kbit/s“. */
export const BITRATES: (Choice<Settings['bitrateKbps']> & { word: string })[] = [
  { value: 96, word: 'kleiner', label: '96\u00a0kbit/s' },
  { value: 128, word: 'normal', label: '128\u00a0kbit/s' },
  { value: 160, word: 'besser', label: '160\u00a0kbit/s' },
  { value: 192, word: 'am besten', label: '192\u00a0kbit/s' },
];

/** Same choices as the split box on the add page, so its list always contains the default. */
export const SPLIT_MINUTES = [3, 5, 8, 10, 15, 20, 30] as const;

/** Same names and texts as the choice on the cards page. */
export const CARD_METHODS: Choice<CardMethod>[] = [
  { value: 'box', label: 'An der Box', text: 'Schritt für Schritt mit den Tasten der Box. Ohne Zubehör.' },
  { value: 'qr', label: 'Mit dem Handy', text: 'Android-Handy mit NFC, mit TonUINO Studio für Android oder über einen QR-Code.' },
  { value: 'reader', label: 'Mit dem NFC-Leser', text: 'NFC-Leser am USB, z. B. ACR122U. Am schnellsten bei vielen Karten.', desktopOnly: true },
  { value: 'wifi', label: 'Über WLAN', text: 'Für Boxen mit ESP32. Ich schicke die Karte über dein WLAN an die Box.', desktopOnly: true },
];

/** The Android app writes cards with the device's own NFC ('reader' there is the phone or tablet, device.ts handheldWord). */
export function phoneCardMethod(device: 'Handy' | 'Tablet' = 'Handy'): Choice<CardMethod> & { text: string } {
  return { value: 'reader', label: `Mit diesem ${device}`, text: `Halte die Karte an die Rückseite. Das ${device} schreibt sie selbst.` };
}

/**
 * The ways to write cards in this app. The Android app (Platform.mobile)
 * writes with the phone itself, first, and has no QR code for another phone.
 */
export function cardMethodsFor(mobile: boolean, device: 'Handy' | 'Tablet' = 'Handy'): Choice<CardMethod>[] {
  return mobile ? [phoneCardMethod(device), ...CARD_METHODS.filter((m) => m.value === 'box' || m.value === 'wifi')] : CARD_METHODS;
}

export const DESKTOP_ONLY = 'Nur in der Desktop-App für Windows und Linux';

export const SETTING_TEXTS: Record<SettingKey, SettingText> = {
  theme: {
    label: 'Darstellung',
    hint: '„Automatisch“ folgt der Einstellung deines Computers.',
    more: [
      'Bei „Automatisch“ wechselt die App mit deinem Computer zwischen hell und dunkel, zum Beispiel am Abend.',
      'Die Vorschau der Sticker bleibt immer weiß wie das Papier. So siehst du, wie der Druck aussieht.',
    ],
  },
  doneSound: {
    label: 'Töne',
    hint: 'Spielt ein kurzes Pling, wenn die SD-Karte fertig beschrieben ist. Mit SD-Karte klingt es wie deine Box.',
    more: [
      'Das Pling kommt nur, wenn die SD-Karte fertig ist: wenn Hörspiele auf der Karte sind, wenn eine Karte neu aufgebaut oder kopiert ist und wenn die Ansagen drauf sind. Im Firefox und Safari kommt es erst, wenn du das Paket auf der Karte geprüft hast. Bei Stickern, Firmware, Reparaturen, beim Umbenennen, beim Speichern und bei Fehlern bleibe ich still.',
      'Dazu gibt es zwei leise Klopfer: ein kurzes „Klack“, wenn der NFC-Leser eine Karte fertig beschrieben hat, und zwei Klopfer, wenn in „Box testen“ alles angekommen ist. Auch sie schaltest du hier aus.',
      'Steckt die SD-Karte deiner Box, spiele ich den kurzen Ton, den auch die Box spielt (bei TonUINO TNG die Datei 0262.mp3 im Ordner advert). Ich lese ihn nur von deiner Karte und speichere ihn nirgends. Fehlt er, spiele ich einen eigenen kurzen Zweiklang.',
    ],
  },
  findCovers: {
    label: 'Fehlende Cover selbst suchen',
    hint: 'Hat ein Ordner kein Bild, suche ich im Internet nach dem Original-Cover für die Karte im Regal.',
    more: [
      'Dafür schicke ich den Namen des Ordners an iTunes und MusicBrainz, aber nur, wenn der Name eindeutig ein Album nennt. Ein gefundenes Bild bleibt auf deinem Computer. Auf die SD-Karte kommt es erst, wenn du im Ordner auf „Übernehmen“ klickst.',
      'Schaltest du das aus, frage ich nur noch, wenn du selbst auf „Cover suchen“ klickst.',
    ],
  },
  profile: {
    label: 'Firmware deiner Box',
    hint: 'Nicht sicher? Fragt die Box bei einer neuen Karte zuerst nach dem Ordner, ist es 2.1.',
    more: [
      'Die Firmware ist das Programm auf der Box. TonUINO TNG wird weiterentwickelt. Ältere Boxen laufen oft noch mit TonUINO 2.1.',
      'Die Wahl entscheidet, welche Wiedergabearten und Spezialkarten ich anbiete, in welcher Reihenfolge die Anleitung „An der Box“ fragt und welche Systemansagen auf die SD-Karte gehören.',
      'Jede SD-Karte merkt sich ihre Firmware. Die Wahl hier gilt für die eingesteckte Karte und für neue Karten.',
    ],
    help: 'tng-oder-2-1',
  },
  tngRelease: {
    label: 'Version von TonUINO TNG',
    name: 'TNG-Version',
    hint: 'Ab der Version vom 17.09.2026 fragt die Box bei Hörbuch-Karten nach dem letzten Ordner und kennt die Endlos-Karte.',
    more: [
      'TonUINO TNG 3.3.3 gibt es zweimal: vom 25.02.2026 und vom 17.09.2026. Erst die neuere fragt bei Hörbuch-Karten nach dem letzten Ordner. Damit spielt eine Karte bei jedem Auflegen zufällig einen von mehreren Ordnern. Auch die Endlos-Karte kennt erst sie.',
      'Weißt du es nicht, zeigt die Anleitung diese Frage als Schritt, den nur manche Boxen stellen.',
    ],
    help: 'tng-oder-2-1',
  },
  adminAccess: {
    label: 'Das Admin-Menü öffnest du mit',
    name: 'Admin-Menü',
    hint: 'Für die Anleitung „An der Box“, wenn du eine benutzte Karte neu anlernst oder eine Spezialkarte.',
    more: [
      `Im Admin-Menü stellst du die Box ein und lernst Karten neu an. Normalerweise öffnest du es, indem du ${ADMIN_KEYS} gleichzeitig gedrückt hältst, bis die Box spricht. Hat die Box 5 Tasten und TonUINO TNG, geht auch ${ADMIN_KEYS_FIVE}. Bei TonUINO 2.1 lässt du die Tasten nach etwa einer Sekunde los, dann spricht die Box.`,
      'Du kannst das Menü an der Box schützen: mit einer Admin-Karte oder mit einer PIN aus vier Tastendrücken. TonUINO 2.1 kennt außerdem eine Rechenaufgabe, die du an der Box lösen musst. Hast du das Menü geschützt, wähle hier, wie. Dann zeigt die Anleitung die richtigen Schritte.',
    ],
    help: 'an-der-box',
  },
  advancedModes: {
    label: 'Spiele und Spezialmodi zeigen',
    hint: 'Quiz, Memory, Teekesselchen und mehr. Nur mit TonUINO TNG.',
    more: [
      'Die Spiele gehen nur mit einer Firmware, die sie enthält. Quiz und Memory stecken in der fertigen Firmware „5 Tasten mit allen Extras“, die es nicht für Boxen mit Arduino Nano oder AiO gibt. Für Teekesselchen und Bluetooth brauchst du eine selbst gebaute Firmware, für Bluetooth auch ein Bluetooth-Modul.',
      'Quiz und Teekesselchen brauchen außerdem einen besonders vorbereiteten Ordner. Darum blende ich diese Arten normalerweise aus.',
      'Ist der Schalter an, findest du sie bei jedem Ordner unter „So spielt die Karte“. Nutzt ein Ordner schon so eine Art, zeige ich sie auch ohne den Schalter.',
    ],
    help: 'wiedergabearten',
  },
  rememberBoxes: {
    label: 'Boxen auf diesem Gerät merken',
    hint: 'Ohne SD-Karte zeigt „Meine Box“ dann Nummern, Namen und Cover. Karten beschreiben und Sticker drucken geht auch.',
    more: [
      'Von jeder Box, die du hier öffnest, merke ich mir die Ordnernummern, die Namen von Ordnern und Titeln, den Interpreten, wie jede Karte spielt, die weiteren Karten und kleine Cover. Hörspiele und Musik merke ich mir nicht.',
      'Steckt die Karte wieder, bringe ich das Gemerkte von selbst auf den neuen Stand. Ohne Karte ist alles nur zum Ansehen: Hinzufügen, Umbenennen und Cover ändern geht erst wieder mit der Karte.',
      'Alles bleibt auf diesem Gerät, im Speicher des Browsers oder der Desktop-App. Ich schicke nichts davon ins Internet. Mit „Vergessen“ löschst du eine gemerkte Box hier wieder.',
    ],
    help: 'datenschutz',
  },
  normalizeLoudness: {
    label: 'Gleiche Lautstärke',
    hint: 'Leise Hörspiele und laute Musik klingen danach ähnlich laut.',
    more: [
      'Manche Hörspiele sind viel leiser aufgenommen als Musik. Dann wird die Box laut gedreht, und beim nächsten Lied erschrecken alle.',
      'Beim Hinzufügen messe ich, wie laut ein Album ist, und gleiche es an einen gemeinsamen Wert an. Innerhalb des Albums bleibt alles, wie es war: Leise Stellen bleiben leise.',
      'MP3-Dateien ändere ich dabei in kleinen Stufen ohne Qualitätsverlust und nie so weit, dass es übersteuert. Neu umwandeln muss ich MP3-Dateien dafür nur, wenn ein leises Album sonst nicht laut genug würde und „Leise MP3s lauter machen“ an ist. Titel, die schon auf der Karte sind, gleichst du in „Meine Box“ an: im Menü „…“ des Ordners unter „Lautstärke anpassen“. Dort stellst du einen Ordner auch mit Absicht leiser, etwa für die Nacht.',
    ],
    help: 'lautstaerke',
  },
  boostQuietMp3: {
    label: 'Leise MP3s lauter machen',
    hint: 'Dafür wandle ich leise MP3-Alben neu um. Sonst bleiben sie leiser als der Rest.',
    more: [
      'Manche MP3-Alben sind leise aufgenommen, haben aber einzelne sehr laute Stellen. Ohne Umwandeln hebe ich sie nur so weit an, dass diese Stellen nicht übersteuern. Dann bleibt das Album leiser als deine anderen.',
      'Ist der Schalter an, wandle ich die MP3-Dateien so eines Albums neu um und hebe es um bis zu 12\u00a0dB an. Die lauten Stellen dämpfe ich dabei etwas, damit nichts übersteuert. Das dauert länger, und ein wenig Klangqualität geht verloren.',
      'Das passiert nur mit „Gleiche Lautstärke“ und nur, wenn ein Album sonst um 3\u00a0dB oder mehr zu leise bliebe. Ist der Schalter aus, sag ich dir nach dem Übertragen, welches Album leiser geblieben ist.',
    ],
    help: 'lautstaerke',
  },
  bitrateKbps: {
    label: 'Qualität beim Umwandeln',
    hint: 'Für Hörspiele reicht „kleiner“ (96\u00a0kbit/s), für Musik „besser“ (160\u00a0kbit/s).',
    more: [
      'Downloads aus dem Netz sind meist schon verkleinert. Mehr als „am besten“ (192\u00a0kbit/s) bringt bei ihnen nichts: Was beim Verkleinern verloren ging, holt keine Einstellung zurück.',
      'Ich wandle vor allem Dateien um, die keine MP3s sind, zum Beispiel M4A, FLAC oder WAV. MP3-Dateien wandle ich nur um, wenn sie beschädigt oder aus mehreren Dateien zusammengesetzt sind oder wenn ein leises Album sonst nicht laut genug würde. Sonst gehen Lautstärke angleichen, Bilder entfernen und Teilen bei ihnen ohne Qualitätsverlust.',
      'Die Zahl sagt, wie viele Daten pro Sekunde gespeichert werden. Mehr klingt besser, braucht aber mehr Platz: Eine Stunde braucht mit 96\u00a0kbit/s etwa 43\u00a0MB, mit 192\u00a0kbit/s etwa 86\u00a0MB.',
      'Stereo-Aufnahmen speichere ich immer mit mindestens 112\u00a0kbit/s, sonst gingen hohe Töne verloren. Nur Mono-Aufnahmen werden mit 96\u00a0kbit/s noch kleiner.',
    ],
    help: 'dateiformate',
  },
  splitMinutes: {
    label: 'Länge der Teile',
    hint: 'So lang werden die Teile, wenn ich ein langes Hörbuch an Sprechpausen teile.',
    more: [
      'Die Box merkt sich nur, bei welchem Titel ihr wart, nicht die Minute. Kürzere Titel helfen beim Weiterhören.',
      'Dateien, die länger als 20\u00a0Minuten sind, teile ich beim Hinzufügen. Hat die Datei Kapitel, teile ich dort, sonst an einer Sprechpause nahe der gewählten Länge. So wird kein Wort zerschnitten.',
      'Beim Hinzufügen kannst du die Länge für jedes Album ändern oder das Teilen abschalten. Hier stellst du ein, womit ich anfange.',
    ],
    help: 'lange-dateien',
  },
  pureNumbers: {
    label: 'Nur Nummern als Dateinamen',
    hint: 'Zum Beispiel „001.mp3“ statt „001_Der_Hund.mp3“.',
    more: [
      'Die Box findet einen Titel nur über die Nummer am Anfang seines Namens. Text danach ist nur für dich am Computer.',
      'Manche nachgebauten MP3-Player spielen aber nur Dateien ab, die reine Nummern heißen. Damit bist du auf der sicheren Seite. Die Namen der Titel merke ich mir trotzdem, in einer eigenen Datei auf der Karte.',
      'Die Einstellung gilt für neue Titel und wenn ich Titel neu nummeriere. Systemansagen heißen immer nur nach ihrer Nummer, zum Beispiel 0300.mp3, weil manche MP3-Player sie sonst nicht finden, etwa auf der AiO-Platine oder im LKP-Player.',
    ],
    help: 'dateinamen',
  },
  stripTags: {
    label: 'Bilder und Zusatzinfos aus MP3s entfernen',
    hint: 'Große Bilder in den Dateien können den MP3-Player der Box ins Stolpern bringen.',
    more: [
      'MP3-Dateien tragen oft Zusatzinfos mit, die sogenannten Tags: Titel, Interpret und manchmal ein großes Cover-Bild. Die Box braucht davon nichts. Sie spielt die Titel nach ihrer Nummer.',
      'Ist der Schalter an, ersetze ich die Tags beim Kopieren durch einen kleinen Eintrag mit Titel, Interpret und Album. Am Ton ändert sich nichts. Das Cover merke ich mir trotzdem für deine Sticker.',
      'Umgewandelte Dateien bekommen immer nur den kleinen Eintrag.',
    ],
    help: 'dateinamen',
  },
  cardMethod: {
    label: 'Womit beschreibst du Karten meistens?',
    name: 'Karten beschreiben',
    hint: '„Karten beschreiben“ startet dann gleich mit diesem Weg.',
    more: [
      'An der Box zeig ich dir Schritt für Schritt, welche Tasten du drückst. Mit dem Handy schreibt ein Android-Handy mit NFC die Karten, mit TonUINO Studio für Android oder über einen QR-Code.',
      'Ein NFC-Leser am USB, z. B. der ACR122U, schreibt viele Karten am schnellsten. Boxen mit ESP32 bekommen die Karte über WLAN. Diese beiden Wege gehen nur in der Desktop-App für Windows und Linux.',
    ],
    help: 'vier-wege',
  },
  boxAddress: {
    label: 'Adresse deiner WLAN-Box',
    hint: 'Für „Über WLAN“. Du findest sie in deinem Router, das Gerät heißt meist „tonuino“.',
    more: [
      'Boxen mit ESP32 und TonUINO TNG haben eine eigene kleine Webseite. Darüber schicke ich neue Karten an die Box. Box und Computer müssen dafür im selben WLAN sein.',
      'Die Adresse ist eine Zahlenfolge wie 192.168.178.40 oder ein Name wie tonuino.fritz.box. Hat die Box noch kein WLAN eingerichtet, öffnet sie ihr eigenes Netz „TonUINO“. Verbinde dich damit, dann ist die Adresse 192.168.4.1.',
      'Ob die Box antwortet, prüfst du unter „Karten beschreiben“ bei „Über WLAN“.',
    ],
    help: 'wlan',
  },
  joinTracks: {
    label: 'Titel zusammenfügen',
    hint: 'Auf der Seite eines Ordners fügst du mehrere Titel zu einem zusammen, zum Beispiel alle Kapitel einer Folge.',
    more: [
      'Hat jede Folge viele Kapitel, passen die Folgen zusammengefügt als je ein Titel in einen Ordner. Eine Karte „Einzeltitel“ spielt dann genau eine Folge, „Zufällige Folge“ eine ganze Folge statt eines Kapitels. Und die 99 Ordner der Box reichen länger.',
      'MP3-Dateien im gleichen Format füge ich ohne Umwandeln aneinander, am Ton ändert sich nichts. Sonst wandle ich die Titel zusammen neu um, mit der Qualität von „Qualität beim Umwandeln“.',
      'Der neue Titel steht an der Stelle des ersten. Die anderen lösche ich erst, wenn der neue Titel fertig auf der Karte ist. Die Titel danach rücken nach vorn.',
    ],
    help: 'titel-zusammenfuegen',
  },
  trimTracks: {
    label: 'Anfang und Ende abschneiden',
    hint: 'Im Menü eines Titels schneidest du Sekunden am Anfang oder Ende ab, zum Beispiel die gleiche Titelmusik vor jeder Folge.',
    more: [
      'Du gibst an, wie viele Sekunden weg sollen, und hörst den neuen Anfang zur Probe an. Auf Wunsch schneide ich alle Titel des Ordners gleich.',
      'MP3-Dateien schneide ich ohne Umwandeln, am Ton ändert sich nichts. Der Schnitt liegt auf etwa 1/40\u00a0Sekunde genau.',
      'Was abgeschnitten ist, ist von der Karte weg. Brauchst du es noch, behalte die Originale auf deinem Computer.',
    ],
    help: 'anfang-abschneiden',
  },
  monoSpeech: {
    label: 'Hörspiele in Mono speichern (halb so groß)',
    name: 'Hörspiele in Mono',
    hint: 'Hörspiele und Hörbücher, die ich umwandle, speichere ich in Mono mit halb so vielen Daten.',
    more: [
      'Bei Sprache hörst du an der Box keinen Unterschied, sie hat meist nur einen Lautsprecher. Bei 128\u00a0kbit/s braucht eine Stunde dann etwa 29\u00a0MB statt 58\u00a0MB.',
      'Das gilt für Alben, bei denen unter „Hinzufügen“ Hörspiel oder Hörbuch gewählt ist, und nur für Dateien, die ich umwandle, zum Beispiel M4A oder FLAC. MP3-Dateien kopiere ich wie bisher. Musik bleibt in Stereo.',
    ],
    help: 'mono-speichern',
  },
  episodePlanner: {
    label: 'Mehr als 99 Hörspiele: Folgen in einem Ordner',
    name: 'Mehr als 99 Hörspiele',
    hint: 'Mehrere Hörspiele kommen nacheinander in einen Ordner, und jedes bekommt seine eigene Karte „von Titel … bis …“.',
    more: [
      'Eine Box spielt höchstens 99 Ordner. Für eine große Sammlung legst du darum mehrere Folgen hintereinander in einen Ordner. Die Karte einer Folge spielt dann nur deren Titel, zum Beispiel Titel 15 bis 28.',
      'Beim Hinzufügen hängst du neue Alben hinten an einen Ordner an. Die Titel, die schon drin sind, behalten ihre Nummern, so bleiben deine fertigen Karten richtig. Auf der Seite des Ordners zeigt „Folgen in diesem Ordner“, welche Titel zu welcher Folge gehören. Dort machst du die Karten und Sticker für alle Folgen auf einmal.',
      'Ein Ordner fasst höchstens 255 Titel. Mehr spielt die Box nicht ab, und auf eine Karte passt keine höhere Nummer. Ich sag dir rechtzeitig, wenn ein Ordner voll wird.',
    ],
    help: 'mehr-als-99',
  },
  stickerBacks: {
    label: 'Sticker-Rückseite mit Titelliste',
    name: 'Sticker-Rückseite',
    hint: 'Beim Drucken bekommt jeder Sticker eine Rückseite mit den Titeln oder einem QR-Code, für beidseitiges Drucken.',
    more: [
      'Unter „Sticker drucken“ wählst du dann bei „Mehr …“ eine Rückseite: die Titelliste mit Nummern und Namen, zu lang gewordene Namen gekürzt, oder einen QR-Code mit der Liste zum Nachlesen auf dem Handy.',
      'Auf jeden Bogen folgt ein Bogen mit den Rückseiten, spiegelverkehrt angeordnet. Druckst du beidseitig und wendest an der langen Kante, liegt jede Rückseite genau hinter ihrem Sticker. Das passt zu Papier oder Fotopapier zum Ausschneiden, das du auf die Karte klebst oder mit ihr einlaminierst. Bei Etikettenbögen landet die Rückseite auf dem Trägerpapier.',
    ],
    help: 'sticker-rueckseite',
  },
  announceTitles: {
    label: 'Titelansagen',
    hint: 'Vor jedem Titel sagt eine Stimme seinen Namen. So finden Kinder, die noch nicht lesen, ihr Lied oder Kapitel.',
    more: [
      'Auf der Seite eines Ordners findest du dann im Menü „…“ „Titelansagen hinzufügen …“, und beim Hinzufügen von Alben einen Haken „Titel ansagen“. Die Ansage steckt am Anfang der MP3-Datei. So geht es mit jeder Box, ohne andere Firmware.',
      'Es spricht die Stimme, die dein Computer schon hat: unter Windows die Sprachausgabe von Windows, unter Linux espeak-ng, espeak oder pico2wave. Ich lade keine Stimme herunter und schicke nichts ins Internet. Darum geht das nur in der Desktop-App.',
      'Der Titel selbst wird dabei nicht umgewandelt. Mit „Titelansagen entfernen“ schneide ich die Ansage wieder ab. Bilder in den Dateien fallen dabei weg, das Cover für deine Sticker bleibt.',
    ],
    help: 'titelansagen',
  },
  recordAudio: {
    label: 'Selbst aufnehmen',
    hint: 'Mit dem Mikrofon nimmst du eigene Titel auf, zum Beispiel wenn Oma eine Geschichte vorliest.',
    more: [
      'Auf der Seite eines Ordners findest du dann im Menü „…“ „Aufnehmen …“. Unter „Hinzufügen“ steht „Selbst aufnehmen“ auch ohne diesen Haken, in der Android-App hat „Aufnehmen“ einen eigenen Reiter. Du nimmst auf, hörst es dir an und nimmst es bei Bedarf noch einmal auf.',
      'Die Aufnahme kommt wie eine Datei von deinem Computer auf die SD-Karte. Ich wandle sie in MP3 um und gleiche die Lautstärke an.',
      'Das geht in der Desktop-App und in Chrome und Edge. Die Aufnahme bleibt auf deinem Computer, bis sie auf der Karte ist.',
    ],
    help: 'selbst-aufnehmen',
  },
};

export interface SettingsSection {
  id: string;
  title: string;
  intro: string;
  keys: SettingKey[];
}

/** The order on the page. Every setting appears exactly once. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'aussehen', title: 'Aussehen', intro: 'Wie ich aussehe und klinge.', keys: ['theme', 'doneSound', 'findCovers'] },
  { id: 'box', title: 'Deine Box', intro: 'Damit Karten und Anleitungen zu deiner Box passen, auch ohne SD-Karte.', keys: ['profile', 'advancedModes', 'rememberBoxes'] },
  {
    id: 'hinzufuegen',
    title: 'Hörspiele und Musik hinzufügen',
    intro: 'Was ich mit den Dateien mache, bevor sie auf die SD-Karte kommen.',
    keys: ['normalizeLoudness', 'boostQuietMp3', 'splitMinutes'],
  },
  { id: 'dateien', title: 'Dateien auf der SD-Karte', intro: 'Wie die Dateien auf der Karte heißen und was in ihnen steckt.', keys: ['pureNumbers', 'stripTags'] },
  { id: 'karten', title: 'Karten beschreiben', intro: 'Womit du die Karten für die Box beschreibst.', keys: ['cardMethod', 'boxAddress'] },
  // Words for tinkerers, folded away from what parents set (audit 0.4 #22). SettingsPage shows it closed.
  { id: 'bastler', title: 'Für Bastler', intro: 'Was nur zählt, wenn du an der Box etwas umgebaut hast oder es genau wissen willst.', keys: ['tngRelease', 'adminAccess', 'bitrateKbps'] },
  {
    id: 'zusatzfunktionen',
    title: 'Zusatzfunktionen',
    intro: 'Seltene Werkzeuge, wie sie andere TonUINO-Programme haben. Ausgeschaltet zeige ich sie nirgends.',
    keys: ['joinTracks', 'trimTracks', 'monoSpeech', 'episodePlanner', 'stickerBacks', 'announceTitles', 'recordAudio'],
  },
];

/* ------------------------------------------------------------------ box address */

export type AddressCheck = { ok: true; value: string } | { ok: false; message: string };

/**
 * Checks what someone typed as the address of a Wi-Fi box. Empty is fine
 * (no Wi-Fi box). The stored value stays as typed, like on the cards page;
 * normalizeBoxAddress turns it into a URL when it is used.
 *
 * Digits and dots only are an IP address, and URL parsers fill in what is
 * missing: "192.168.178" becomes 192.168.0.178, "040" is read as an octal
 * number (32). normalizeBoxAddress lets both through, so the most common
 * typo, a missing last number, would only show up later as a box that does
 * not answer, or as another device that does.
 */
export function checkBoxAddress(input: string): AddressCheck {
  const value = input.trim();
  if (!value) return { ok: true, value: '' };
  const base = normalizeBoxAddress(value);
  if (!base) return { ok: false, message: 'Das ist keine gültige Adresse. Gib sie so ein wie 192.168.178.40 oder tonuino.fritz.box.' };
  const [, host, port] = /^http:\/\/([^:]+)(?::(\d+))?$/.exec(base) ?? [];
  if (port && Number(port) > 65535) return { ok: false, message: 'Die Zahl nach dem Doppelpunkt ist zu groß. Meist brauchst du sie gar nicht: Lasse sie einfach weg.' };
  if (host && /^[\d.]+$/.test(host)) {
    const numbers = host.split('.');
    if (numbers.length !== 4 || numbers.includes('')) return { ok: false, message: 'Eine IP-Adresse hat vier Zahlen mit Punkten dazwischen, zum Beispiel 192.168.178.40.' };
    if (numbers.some((n) => Number(n) > 255)) return { ok: false, message: 'Jede Zahl einer IP-Adresse geht nur bis 255, zum Beispiel 192.168.178.40.' };
    if (numbers.some((n) => n.length > 1 && n.startsWith('0'))) return { ok: false, message: 'Lasse die Nullen am Anfang einer Zahl weg, also 192.168.1.40 statt 192.168.001.040.' };
  }
  return { ok: true, value };
}

/* ------------------------------------------------------------------ values in words */

function choiceName<T>(choices: Choice<T>[], value: T): string {
  const c = choices.find((x) => x.value === value);
  return c ? (c.short ?? c.label) : String(value);
}

/** A setting's value in words, e.g. for the list before a reset. */
export function formatSettingValue<K extends SettingKey>(key: K, value: Settings[K]): string {
  switch (key) {
    case 'theme':
      return choiceName(THEMES, value as Settings['theme']);
    case 'profile':
      return choiceName(PROFILES, value as FirmwareProfile);
    case 'adminAccess':
      return choiceName(ADMIN_ACCESS, value as AdminAccess);
    case 'tngRelease':
      return choiceName(TNG_RELEASES, value as TngRelease);
    case 'bitrateKbps':
      return `${value}\u00a0kbit/s`;
    case 'splitMinutes':
      return `${value}\u00a0Minuten`;
    case 'cardMethod':
      return value === 'usb' ? 'Über USB an die Box' : choiceName(CARD_METHODS, value as CardMethod);
    case 'boxAddress':
      return String(value).trim() || 'keine';
    default:
      return value ? 'An' : 'Aus';
  }
}

export interface SettingChange {
  key: SettingKey;
  label: string;
  from: string;
  to: string;
}

/** Settings that differ from `defaults`, in page order, with both values in words. */
export function changedSettings(current: Settings, defaults: Readonly<Settings>): SettingChange[] {
  const out: SettingChange[] = [];
  for (const section of SETTINGS_SECTIONS) {
    for (const key of section.keys) {
      const now = current[key];
      const then = defaults[key];
      const same = key === 'boxAddress' ? String(now).trim() === String(then).trim() : now === then;
      if (same) continue;
      const text = SETTING_TEXTS[key];
      out.push({ key, label: text.name ?? text.label, from: formatSettingValue(key, now), to: formatSettingValue(key, then) });
    }
  }
  return out;
}
