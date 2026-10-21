/**
 * The small dictionary of the help ("Wörterbuch"): words of the box and the
 * forum, each in one or two sentences. A help text marks a word with
 * [[Wort]] or [[shown text|id]]; the page then underlines it with dots and
 * shows the explanation on a tap. Mark a word once per page, where it
 * first comes up.
 *
 * Explanations may hold [links](#/…) but no marked words of their own.
 */

export interface GlossaryEntry {
  id: string;
  /** As the entry is headed in the Wörterbuch. */
  term: string;
  /** Other spellings a text may mark, e.g. "DFPlayer" for the MP3 player. */
  aka?: string[];
  text: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    id: 'firmware',
    term: 'Firmware',
    text: 'Das Programm auf der Box. Es steckt im kleinen Rechner der Box und sagt ihr, was sie bei Karten und Tasten tut. In der [Werkstatt](#/werkstatt/firmware) spielst du es auf.',
  },
  {
    id: 'tng',
    term: 'TonUINO TNG und TonUINO 2.1',
    aka: ['TNG', 'TonUINO TNG', '2.1', 'TonUINO 2.1'],
    text: 'Die zwei verbreiteten Firmwares. TNG (die Versionen 3.x) wird weiterentwickelt, ältere Boxen laufen oft noch mit 2.1. Woran du sie unterscheidest, steht unter [TonUINO TNG oder 2.1?](#/hilfe/tng-oder-2-1).',
  },
  {
    id: 'mp3-player',
    term: 'MP3-Player (DFPlayer)',
    aka: ['MP3-Player', 'DFPlayer', 'DFPlayer Mini'],
    text: 'Das kleine Bauteil in der Box, das die SD-Karte liest und die Titel abspielt. Es hat den Kartenschlitz und den Verstärker für den Lautsprecher. Im Forum heißt es meist DFPlayer.',
  },
  {
    id: 'nachbau-chip',
    term: 'Nachbau-Chip',
    aka: ['nachgebauter Chip', 'nachgebaute Chip', 'MH2024K', 'GD3200B'],
    text: 'Viele MP3-Player tragen einen nachgebauten Chip, zum Beispiel MH2024K oder GD3200B. Sie spielen meist gut, verhalten sich aber in Kleinigkeiten anders. Mehr unter [Nachgebauter MP3-Player](#/hilfe/nachbau-chip).',
  },
  {
    id: 'platine',
    term: 'Classic, AiO und AiO+',
    aka: ['AiO', 'AiO+', 'Classic', 'TonUINO Classic', 'Arduino Nano', 'Nano', 'Platine'],
    text: 'Bauarten der Box. Beim Classic steckt ein Arduino Nano (ein kleiner Rechner) mit einzelnen Teilen in der Box. Bei der AiO („All in One“) ist alles auf einer Platine, auch das Laden des Akkus; neu gibt es sie nicht mehr. Die AiO+ ist ihr Nachfolger.',
  },
  {
    id: 'admin-menue',
    term: 'Admin-Menü',
    aka: ['Admin-Menüs', 'Admin'],
    text: 'Die Einstellungen der Box, bedient mit ihren Tasten: Halte Play/Pause, Vor und Zurück gleichzeitig gedrückt oder lege die Admin-Karte auf. Die Box sagt an, wo du bist. Jeden Tastendruck zeig ich dir unter [Box einstellen](#/werkstatt/einstellen).',
  },
  {
    id: 'spezialkarte',
    term: 'Spezialkarte (Modifikationskarte)',
    aka: ['Spezialkarte', 'Spezialkarten', 'Modifikationskarte'],
    text: 'Eine Karte, die keinen Ordner spielt, sondern etwas an der Box umschaltet, zum Beispiel die Schlummerkarte. Im Forum heißt sie Modifikationskarte. Mehr unter [Spezialkarten](#/hilfe/spezialkarten).',
  },
  {
    id: 'systemansagen',
    term: 'Systemansagen',
    aka: ['Ansagen', 'Systemansage'],
    text: 'Die Sätze, mit denen die Box spricht, etwa „Oh, eine neue Karte!“ und die Zahlen im Menü. Sie liegen in den Ordnern mp3 und advert auf der SD-Karte und müssen zur Firmware passen.',
  },
  {
    id: 'kartenleser',
    term: 'Kartenleser in der Box (RC522)',
    aka: ['Kartenleser', 'RC522'],
    text: 'Das Bauteil in der Box, das die Karten liest, meist ein RC522. Sein Licht zeigt nur, dass er Strom hat.',
  },
  {
    id: 'nfc-leser',
    term: 'NFC-Leser (z. B. ACR122U)',
    aka: ['NFC-Leser', 'ACR122U'],
    text: 'Ein kleines Gerät am USB des Computers, mit dem du Karten beschreibst, meist ein ACR122U. Das geht in der Desktop-App für Windows und Linux. Mit der SD-Karte hat er nichts zu tun.',
  },
  {
    id: 'sd-kartenleser',
    term: 'SD-Kartenleser',
    aka: ['Kartenschlitz'],
    text: 'Der Schlitz am Computer oder ein kleines Gerät am USB, in das du die SD-Karte der Box steckst. Am Handy ist es meist ein Stecker mit USB-C. Karten beschreiben kann er nicht, dafür gibt es den NFC-Leser.',
  },
  {
    id: 'kartensorten',
    term: 'MIFARE und NTAG',
    aka: ['MIFARE', 'NTAG', 'MIFARE Classic'],
    text: 'Sorten von Karten und Stickern mit Chip. Die Box liest MIFARE Classic, MIFARE Ultralight und NTAG. Mehr unter [Welche Karten kaufen?](#/hilfe/kartentypen).',
  },
  {
    id: 'ausschalt-timer',
    term: 'Ausschalt-Timer (Standby-Timer)',
    aka: ['Ausschalt-Timer', 'Standby-Timer', 'Standby'],
    text: 'Eine Einstellung im Admin-Menü: Spielt die Box 5, 15, 30 oder 60 Minuten nichts, schaltet sie sich ab. Ab Werk ist er aus. Im Forum heißt er Standby-Timer.',
  },
  {
    id: 'abschalt-technik',
    term: 'Pololu-Schalter und Abschalt-Platine',
    aka: ['Pololu-Schalter', 'Pololu', 'Abschalt-Platine', 'Abschalt-Technik'],
    text: 'Ein kleiner Schalter oder eine Platine in der Box, die den Strom ganz trennt, wenn der Ausschalt-Timer abläuft. Ohne sie schläft eine Classic-Box nur. AiO und AiO+ können das selbst.',
  },
  {
    id: 'fat32',
    term: 'FAT32',
    aka: ['exFAT'],
    text: 'Ein Format für SD-Karten. Der MP3-Player liest nur Karten mit FAT32, nicht mit exFAT oder NTFS. Neue Karten bis 32 GB haben es meist schon.',
  },
  {
    id: 'logbuch',
    term: 'Box-Logbuch und Steckbrief',
    aka: ['Box-Logbuch', 'Logbuch', 'Steckbrief'],
    text: 'Über USB meldet die Box, was sie tut. Das [Box-Logbuch](#/werkstatt/logbuch) liest mit und erklärt es. Der Steckbrief fasst zusammen, was ich dabei über deine Box erfahre: Firmware, Platine und Einstellungen.',
  },
  {
    id: 'loetstelle',
    term: 'Kalte Lötstelle',
    aka: ['kalte Lötstelle', 'Lötstelle', 'Lötstellen', 'kalte Lötstellen'],
    text: 'Eine Lötstelle, bei der das Zinn nicht richtig geflossen ist. Sie sieht matt und kugelig aus und hat nur manchmal Kontakt. Mehr unter [Wackelkontakt und schlechte Lötstellen](#/hilfe/wackelkontakt).',
  },
];

function key(word: string): string {
  return word.trim().toLowerCase();
}

const BY_WORD = new Map<string, GlossaryEntry>();
for (const e of GLOSSARY) {
  BY_WORD.set(e.id, e);
  for (const w of [e.term, ...(e.aka ?? [])]) if (!BY_WORD.has(key(w))) BY_WORD.set(key(w), e);
}

/** The entry for a marked word: by id, by its term or by one of its other spellings. */
export function glossaryEntry(word: string): GlossaryEntry | undefined {
  return BY_WORD.get(key(word));
}

/** Element id of an entry on the Wörterbuch page. */
export function glossaryAnchor(id: string): string {
  return `wort-${id}`;
}
