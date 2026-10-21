import { ADMIN_KEYS, adminOpenText, type KeyCount } from './adminkeys';
import { ADMIN_MODE, type CardData, type FirmwareProfile } from './card';
import { DANCE_PAUSES, modeByCode, modifierNeeds, modifiersFor, modifierUnsupportedFor, QUIZ_VARIANTS, SLEEP_MINUTES, TNG_SEPTEMBER_2026 } from './modes';

/**
 * Step-by-step instructions for programming a card with the box's own voice
 * menu, for families without a card reader. The button counts follow the
 * menus of TonUINO-TNG (src/state_machine.cpp, src/commands.cpp) and
 * TonUINO 2.1 (Tonuino.ino):
 *
 * - A menu starts at 0 (a few start at a given value). Vor adds 1, Zurück
 *   subtracts 1 (never below 1). Holding Vor or Zurück for a second jumps
 *   by 10 (never past the last option). Pause confirms, holding Pause aborts.
 * - TNG asks for the mode first and then for the folder, 2.1 the other way
 *   round. Both write the card at the end and say "OK".
 * - TNG starts the menu by itself only for a blank card (first four bytes
 *   zero); 2.1 for any card that is not a TonUINO card. A used card goes
 *   through the admin menu, entry 1.
 * - After a card written through the admin menu, TNG stays in the admin menu
 *   ("Und weiter im Admin Menü", Admin_End = Admin_Entry) at the entry used
 *   last. Its guides therefore end by leaving the menu with a long Pause, so
 *   the next guide starts from a playing-ready box again. 2.1 leaves the
 *   admin menu by itself.
 */

export type BoxKey = 'pause' | 'up' | 'down' | 'all';

export interface KeyPress {
  key: BoxKey;
  /** Hold for about a second. */
  long?: boolean;
  times: number;
}

export type StepKind = 'card' | 'admin' | 'menu' | 'done';

export interface BoxStep {
  kind: StepKind;
  /** What to do, in plain German. */
  text: string;
  /** The button presses in order, for the button pictures. */
  presses?: KeyPress[];
  /** What the box says when the step worked. */
  hear?: string;
  /** Only some boxes ask this: shown apart, without a number of its own. */
  optional?: boolean;
}

export interface BoxGuide {
  steps: BoxStep[];
  /** Hints that apply to this card. */
  notes: string[];
}

/** 'blank': a new card starts the menu by itself. 'reuse': through the admin menu. */
export type GuideStart = 'blank' | 'reuse';
/** How the admin menu opens on this box. 'calc': a sum to solve first (TonUINO 2.1 only). */
export type AdminAccess = 'buttons' | 'card' | 'pin' | 'calc';

/**
 * The locks a firmware offers under "Das Adminmenü absichern". TNG 3.x has
 * no sum to solve: its menu offers three choices, and its code for the sum
 * is switched off (Admin_Allow in src/state_machine.cpp).
 */
export function adminAccessFor(profile: FirmwareProfile): AdminAccess[] {
  return profile === 'classic21' ? ['buttons', 'card', 'pin', 'calc'] : ['buttons', 'card', 'pin'];
}

/** The lock the guide goes by: a sum chosen for a 2.1 box opens a TNG box like no lock at all. */
export function effectiveAccess(access: AdminAccess, profile: FirmwareProfile): AdminAccess {
  return adminAccessFor(profile).includes(access) ? access : 'buttons';
}

/**
 * Which TNG release the box has, as far as the family knows: 'newer' is
 * TNG_SEPTEMBER_2026 or later, which asks Hörbuch cards for a last folder.
 */
export type TngRelease = 'older' | 'newer' | 'unknown';

/** Whether the TNG release changes the guide for this card: Hörbuch cards and the cards new in TNG_SEPTEMBER_2026. */
export function releaseMatters(card: CardData): boolean {
  if (card.folder === 0) return modifiersFor('tng').find((m) => m.code === card.mode)?.since === TNG_SEPTEMBER_2026;
  return card.mode === 5 || card.mode === 10;
}

export interface GuideOptions {
  start: GuideStart;
  /** TNG only; 'unknown' when left out. */
  release?: TngRelease;
  access?: AdminAccess;
  /** Track count of a folder, for menus that list the tracks. */
  trackCount?: (folder: number) => number | undefined;
  /** Keys of the box, when known: TNG with five opens the admin menu two ways. */
  buttons?: KeyCount;
}

export type GuideResult = { ok: true; guide: BoxGuide } | { ok: false; reason: string };

export const KEY_NAMES: Record<BoxKey, string> = {
  pause: 'Play/Pause-Taste',
  up: 'Vor-Taste',
  down: 'Zurück-Taste',
  all: `Tasten ${ADMIN_KEYS}`,
};

/* ------------------------------------------------------------------ what the box says */

const MODE_SAYS: Record<number, string> = {
  1: 'Hörspielmodus …',
  2: 'Albummodus …',
  3: 'Party Modus …',
  4: 'Einzel Modus …',
  5: 'Hörbuch Modus …',
  6: 'Admin Funktionen',
  7: 'Spezialmodus Von-Bis, Hörspiel …',
  8: 'Spezialmodus Von-Bis, Album …',
  9: 'Spezialmodus Von-Bis, Party …',
  10: 'Hörbuch Modus einzeln …',
  11: 'Wiederhole Karte Modus …',
  12: 'Quiz Spiel Modus …',
  13: 'Memory Spiel Modus …',
  14: 'Switch Bluetooth …',
  15: 'Teekesselchen Spiel Modus …',
  16: 'Spezialmodus Von-Bis, Hörbuch …',
};

const ADMIN_SAYS: Record<number, string> = {
  1: 'Eine Karte neu konfigurieren.',
  6: 'Eine Modifikationskarte erstellen …',
  9: 'Einzelkarten für einen Ordner erstellen.',
};

const TNG_MODIFIER_SAYS: Record<number, string> = {
  1: 'Schlummermodus',
  2: 'Stopptanz …',
  3: 'Feuer, Wasser und Luft Spiel.',
  4: 'Krabbler-Modus …',
  5: 'KiTa-Modus …',
  6: 'Titel wiederholen …',
  7: 'Bluetoothkarte …',
  8: 'Jukeboxkarte …',
  9: 'Pause nach jedem Track Karte …',
  10: 'Disable Standby Karte …',
  11: 'Endlos Ein- und Ausschaltkarte …',
};

const CLASSIC_MODIFIER_SAYS: Record<number, string> = {
  1: 'Schlummermodus',
  2: 'Stopptanz …',
  3: 'TonUINO Sperren',
  4: 'Krabbler-Modus …',
  5: 'KiTa-Modus …',
  6: 'Titel wiederholen …',
};

const QUIZ_SAYS = ['2 Antworten.', '4 Antworten.', '2 Antworten und eine Lösung.', '4 Antworten und eine Lösung.', 'Nur eine Lösung mit Buzzer.'];

const WELCOME = '„Willkommen im Admin Menü …“';
const OK = '„OK. Ich habe die Karte konfiguriert.“';
const PLACE = '„Bitte lege nun die Karte auf!“';
/**
 * While TonUINO 2.1 waits for a card (resetCard(), modifier and batch loops in
 * Tonuino.ino) it only checks Vor and Zurück; a long Pause does nothing there.
 */
const CLASSIC_CARD_ABORT = 'Abbrechen geht hier nur mit einem kurzen Druck auf Vor oder Zurück, nicht mit der Play/Pause-Taste.';

/** Menu sizes: TNG 3.3 has 16 modes, 14 admin entries, 11 modifier cards. */
const MENU = {
  tng: { modes: 16, admin: 14, modifiers: 11 },
  classic21: { modes: 9, admin: 12, modifiers: 6 },
} as const;

/* ------------------------------------------------------------------ presses */

/**
 * The presses that move a voice menu from `from` to `to` when it has `max`
 * options. Tens go by holding the button; for 8 and 9 one more jump and a
 * few steps back is shorter.
 */
export function menuPresses(from: number, to: number, max: number): KeyPress[] {
  if (to === from) return [];
  const forward = to > from;
  const delta = Math.abs(to - from);
  const tens = Math.floor(delta / 10);
  const ones = delta % 10;
  const fwd: BoxKey = forward ? 'up' : 'down';
  const back: BoxKey = forward ? 'down' : 'up';
  const roomForJump = forward ? from + (tens + 1) * 10 <= max : from - (tens + 1) * 10 >= 1;
  if (ones >= 8 && roomForJump) {
    return [
      { key: fwd, long: true, times: tens + 1 },
      { key: back, times: 10 - ones },
    ];
  }
  const out: KeyPress[] = [];
  if (tens) out.push({ key: fwd, long: true, times: tens });
  if (ones) out.push({ key: fwd, times: ones });
  return out;
}

const TIMES = ['', 'einmal', 'zweimal', 'dreimal', 'viermal', 'fünfmal', 'sechsmal', 'siebenmal', 'achtmal', 'neunmal'];

export function timesWord(n: number): string {
  return TIMES[n] ?? `${n}-mal`;
}

/** "die Vor-Taste zweimal lang und dann dreimal kurz" */
export function describePresses(presses: KeyPress[]): string {
  const parts: string[] = [];
  let lastKey: BoxKey | undefined;
  for (const p of presses) {
    const how = `${timesWord(p.times)} ${p.long ? 'lang' : 'kurz'}`;
    parts.push(p.key === lastKey ? how : `die ${KEY_NAMES[p.key]} ${how}`);
    lastKey = p.key;
  }
  return parts.join(' und dann ');
}

export function menuStep(what: string, from: number, to: number, max: number, says: string): BoxStep {
  const presses = menuPresses(from, to, max);
  const hear = `„${says}“`;
  const text = presses.length
    ? `${what}: Drücke ${describePresses(presses)}, bis die Box ${hear} sagt. Dann kurz die Play/Pause-Taste.`
    : `${what}: Das Richtige ist schon eingestellt. Drücke nur kurz die Play/Pause-Taste.`;
  return { kind: 'menu', text, presses: [...presses, { key: 'pause', times: 1 }], hear };
}

/* ------------------------------------------------------------------ shared steps */

export function adminEntry(profile: FirmwareProfile, chosen: AdminAccess, buttons?: KeyCount): BoxStep[] {
  const access = effectiveAccess(chosen, profile);
  if (access === 'card') {
    return [
      {
        kind: 'admin',
        text:
          profile === 'tng'
            ? 'Öffne das Admin-Menü: Lege die Admin-Karte auf und nimm sie gleich wieder ab, bevor du eine Taste drückst.'
            : 'Öffne das Admin-Menü: Lege die Admin-Karte auf und nimm sie wieder ab, sobald die Box spricht.',
        hear: WELCOME,
      },
    ];
  }
  const open: BoxStep = {
    kind: 'admin',
    // TNG answers while the keys are still held; 2.1 waits until they are let go (adminkeys.ts).
    text: `Öffne das Admin-Menü: ${adminOpenText(profile, buttons)}`,
    presses: [{ key: 'all', long: true, times: 1 }],
    hear: access === 'pin' ? '„Bitte gebe die Pin ein.“' : access === 'calc' ? '„Wieviel ist …“' : WELCOME,
  };
  if (access === 'pin') {
    // Commands::getButtonCode (TNG) and adminMenu() (2.1) count Play/Pause, Vor and Zurück only.
    const only = buttons === 5 ? ' Lauter und Leiser zählen nicht.' : '';
    return [open, { kind: 'admin', text: `Gib deine PIN ein: die vier Tasten nacheinander, jeweils kurz.${only}`, hear: WELCOME }];
  }
  if (access === 'calc') {
    // Tonuino.ino adminMenu(): "Wieviel ist 12 plus 5", then a voice menu from
    // 0 to 255 without a start message; a wrong answer returns silently.
    return [
      open,
      {
        kind: 'admin',
        text: 'Die Box stellt eine Rechenaufgabe, zum Beispiel „Wieviel ist 12 plus 5“. Gib das Ergebnis mit der Vor-Taste ein: Ein kurzer Druck zählt 1 weiter, ein langer 10, und die Box sagt jede Zahl an. Dann kurz die Play/Pause-Taste. Bleibt die Box danach still, war das Ergebnis falsch: Fange dann noch einmal mit dem Öffnen an.',
        hear: WELCOME,
      },
    ];
  }
  return [open];
}

function blankCardStep(profile: FirmwareProfile): BoxStep {
  return {
    kind: 'card',
    text:
      profile === 'tng'
        ? 'Lege die neue, leere Karte auf die Box und lasse sie bis zum Schluss liegen.'
        : 'Lege die neue Karte auf die Box und lasse sie bis zum Schluss liegen.',
    hear: '„Oh, eine neue Karte!“',
  };
}

function folderStep(folder: number): BoxStep {
  const step = menuStep('Wähle den Ordner', 0, folder, 99, String(folder));
  step.text = step.text.replace('. Dann kurz', ' und kurz in den Ordner hineinspielt. Dann kurz');
  return step;
}

/**
 * Hörbuch and Hörbuch Stück für Stück on TNG: the release of 17.09.2026 asks
 * for a last folder after the folder (ChLastFolder starts one below the
 * folder, so one press selects the folder itself). Older releases skip that
 * question: Hörbuch writes the card at once, Stück für Stück goes on with the
 * number of tracks. Without knowing the release, the step is one only some
 * boxes ask.
 */
function lastFolderStep(card: CardData, start: GuideStart, release: TngRelease): BoxStep | null {
  const last = card.folder + card.special2;
  if (card.special2 > 0) {
    return menuStep(`Die Box fragt nach dem letzten Ordner. Damit sie zufällig einen der Ordner ${card.folder} bis ${last} spielt`, card.folder - 1, last, 99, String(last));
  }
  if (release === 'older') return null;
  if (release === 'newer') return menuStep(`Die Box fragt nach dem letzten Ordner. Damit sie nur Ordner ${card.folder} spielt`, card.folder - 1, last, 99, String(last));
  const step = menuStep(`Neuere Boxen (ab TNG ${TNG_SEPTEMBER_2026}) fragen jetzt nach dem letzten Ordner`, card.folder - 1, last, 99, String(last));
  const older =
    card.mode === 10
      ? 'Ältere Boxen fragen das nicht, sondern gleich nach der Zahl der Titel pro Auflegen. Dann geht es mit dem nächsten Schritt weiter.'
      : start === 'blank'
        ? 'Ältere Boxen fragen das nicht und sagen gleich „OK“. Dann ist die Karte schon fertig.'
        : `Ältere Boxen fragen das nicht und sagen gleich ${PLACE} Dann geht es mit dem nächsten Schritt weiter.`;
  step.text = `${step.text} ${older}`;
  return { ...step, optional: true };
}

function trackLimit(opts: GuideOptions, folder: number): number {
  return opts.trackCount?.(folder) ?? 255;
}

function finishOnBox(): BoxStep {
  return { kind: 'done', text: 'Fertig, sobald die Box „OK“ sagt. Jetzt kannst du die Karte abnehmen.', hear: OK };
}

function placeCardStep(profile: FirmwareProfile): BoxStep {
  const abort = profile === 'classic21' ? ` ${CLASSIC_CARD_ABORT}` : '';
  return { kind: 'card', text: `Die Box sagt ${PLACE} Lege jetzt die Karte, die du beschreiben willst, auf und lasse sie liegen, bis die Box „OK“ sagt.${abort}`, hear: OK };
}

/**
 * TNG keeps the admin menu open after writing (state_machine.cpp: Admin_End =
 * Admin_Entry, entry() plays "Und weiter im Admin Menü" and restores the last
 * position). Holding Pause there is adm_end: "OK, ich habe den Vorgang
 * abgebrochen." and back to Idle. Without it the next card's presses would
 * count on from the old position and could change box settings.
 */
function leaveAdminStep(batch = false): BoxStep {
  const lead = batch ? 'Nach der letzten Karte' : 'Nimm die Karte ab. Dann';
  return {
    kind: 'done',
    text: `${lead} sagt die Box „Und weiter im Admin Menü …“. Verlass das Admin-Menü jetzt: Halte die Play/Pause-Taste lang, bis die Box „OK, ich habe den Vorgang abgebrochen.“ sagt. ${batch ? 'Die Karten bleiben' : 'Die Karte bleibt'} trotzdem beschrieben.`,
    presses: [{ key: 'pause', long: true, times: 1 }],
    hear: '„OK, ich habe den Vorgang abgebrochen.“',
  };
}

function unsupported(reason: string): GuideResult {
  return { ok: false, reason };
}

/* ------------------------------------------------------------------ guides */

/** Instructions for one card. */
export function boxGuide(card: CardData, profile: FirmwareProfile, opts: GuideOptions): GuideResult {
  return profile === 'tng' ? tngGuide(card, opts) : classicGuide(card, opts);
}

function tngGuide(card: CardData, opts: GuideOptions): GuideResult {
  const access = opts.access ?? 'buttons';
  const steps: BoxStep[] = [];
  const notes: string[] = [];
  const isAdminCard = card.folder === 0 && card.mode === ADMIN_MODE;

  if (card.folder === 0 && !isAdminCard) {
    const mod = modifiersFor('tng').find((m) => m.code === card.mode);
    if (!mod) return unsupported('Diese Spezialkarte kennt die Box nicht.');
    const release = opts.release ?? 'unknown';
    const tooNew = modifierUnsupportedFor(mod, release);
    if (tooNew) return unsupported(tooNew);
    steps.push(...adminEntry('tng', access, opts.buttons));
    steps.push(menuStep('Wähle im Admin-Menü die Spezialkarten', 0, 6, MENU.tng.admin, ADMIN_SAYS[6]));
    steps.push(menuStep('Wähle die Karte', 0, mod.code, MENU.tng.modifiers, TNG_MODIFIER_SAYS[mod.code]));
    if (mod.params === 'sleep') {
      const minutes = card.special & 0x7f;
      const index = (SLEEP_MINUTES as readonly number[]).indexOf(minutes);
      if (index < 0) return unsupported(`An der Box gibt es nur ${SLEEP_MINUTES.join(', ')} Minuten.`);
      steps.push(menuStep('Wähle die Zeit', 0, index + 1, SLEEP_MINUTES.length, `${minutes} Minuten.`));
      const atEnd = (card.special & 0x80) !== 0;
      steps.push(menuStep('Die Box fragt, ob sie erst am Ende des Titels ausschalten soll', 0, atEnd ? 2 : 1, 2, atEnd ? 'Ja.' : 'Nein.'));
    }
    if (mod.params === 'dancePause') {
      if (card.special > 2) return unsupported('Diese Pausenlänge gibt es an der Box nicht.');
      steps.push(menuStep('Wähle, wie lange die Musik zwischen den Pausen spielt', 0, card.special + 1, 3, DANCE_PAUSES[card.special]));
    }
    steps.push(placeCardStep('tng'), leaveAdminStep());
    if (mod.requires === 'bluetooth') notes.push('Die Box braucht dafür ein Bluetooth-Modul und eine passende Firmware.');
    // The modifier menu always lists all cards (Admin_ModCard: numberOfOptions = 11).
    if (mod.requires === 'jukebox' || mod.requires === 'pauseAfterTrack') notes.push(`${modifierNeeds(mod)} Das Menü der Box bietet die Karte trotzdem an.`);
    if (mod.since && release !== 'newer') {
      notes.push(
        `Diese Karte gibt es erst ab TNG ${mod.since}. Sagt die Box bei der Wahl der Karte nicht „${TNG_MODIFIER_SAYS[mod.code]}“, ist ihre Firmware älter: Halte dann die Play/Pause-Taste lang, um abzubrechen.`,
      );
    }
    return { ok: true, guide: { steps, notes } };
  }

  const mode = isAdminCard ? undefined : modeByCode(card.mode);
  if (!isAdminCard && (!mode || !mode.profiles.includes('tng'))) return unsupported('Diesen Modus kennt die Box nicht.');
  if (card.mode === 13) return unsupported('Memory-Karten legt die Box über ihren eigenen Admin-Punkt an. Nimm dafür besser das Handy oder den NFC-Leser.');

  if (opts.start === 'blank') {
    steps.push(blankCardStep('tng'));
    notes.push('Die Box fragt nur bei ganz leeren Karten von selbst. Bei einer schon benutzten Karte nimm den Weg über das Admin-Menü.');
  } else {
    steps.push(...adminEntry('tng', access, opts.buttons));
    steps.push(menuStep('Wähle im Admin-Menü', 0, 1, MENU.tng.admin, ADMIN_SAYS[1]));
  }

  const modeCode = isAdminCard ? 6 : card.mode;
  steps.push(menuStep('Wähle, wie die Karte abspielt', 0, modeCode, MENU.tng.modes, MODE_SAYS[modeCode]));
  if (mode?.since) notes.push(`Diesen Modus gibt es erst ab TNG ${mode.since}. Sagt die Box etwas anderes, ist ihre Firmware älter.`);
  if (mode?.requires && mode.requires !== 'bluetooth') notes.push('Funktioniert nur mit einer Firmware, die dieses Spiel enthält. Sonst bricht die Box hier ab.');

  if (!isAdminCard && card.mode !== 11 && card.mode !== 14) {
    steps.push(folderStep(card.folder));
    switch (card.mode) {
      case 4: {
        const max = trackLimit(opts, card.folder);
        if (card.special < 1 || card.special > max) return unsupported(`Titel ${card.special} gibt es in diesem Ordner nicht.`);
        steps.push(menuStep('Wähle den Titel', 0, card.special, max, String(card.special)));
        break;
      }
      case 5:
      case 10: {
        const last = card.folder + card.special2;
        if (last > 99) return unsupported('Der letzte Ordner liegt hinter Ordner 99.');
        const release = opts.release ?? 'unknown';
        if (card.special2 > 0 && release === 'older') {
          return unsupported(`Einen zufälligen Ordner aus mehreren gibt es erst ab TNG ${TNG_SEPTEMBER_2026}. Ältere Boxen fragen nicht nach dem letzten Ordner, die Karte würde nur Ordner ${card.folder} spielen.`);
        }
        const lastStep = lastFolderStep(card, opts.start, release);
        if (lastStep) steps.push(lastStep);
        if (card.special2 > 0 && release === 'unknown') {
          notes.push(
            `Einen zufälligen Ordner gibt es erst ab TNG ${TNG_SEPTEMBER_2026}. Fragt die Box nicht nach dem letzten Ordner, ist ihre Firmware älter und die Karte spielt nur Ordner ${card.folder}. Brich dann mit der Play/Pause-Taste (lang) ab.`,
          );
        }
        if (card.mode === 10) {
          if (card.special > 29) return unsupported('An der Box gehen höchstens 30 Titel pro Auflegen.');
          steps.push(menuStep('Wähle, wie viele Titel pro Auflegen spielen', 0, card.special + 1, 30, String(card.special + 1)));
        }
        break;
      }
      case 7:
      case 8:
      case 9:
      case 16: {
        const max = trackLimit(opts, card.folder);
        if (card.special < 1 || card.special2 < card.special || card.special2 > max) return unsupported('Der Bereich von … bis … passt nicht zum Ordner.');
        steps.push(menuStep('Wähle den ersten Titel', 0, card.special, max, String(card.special)));
        steps.push(menuStep('Wähle den letzten Titel', card.special, card.special2, max, String(card.special2)));
        break;
      }
      case 12: {
        const index = QUIZ_VARIANTS.findIndex((q) => q.special === card.special && q.special2 === card.special2);
        if (index < 0) return unsupported('Diese Quiz-Einstellung gibt es an der Box nicht.');
        steps.push(menuStep('Wähle die Art des Quiz', 0, index + 1, QUIZ_VARIANTS.length, QUIZ_SAYS[index]));
        break;
      }
    }
  }

  if (opts.start === 'blank') steps.push(finishOnBox());
  else steps.push(placeCardStep('tng'), leaveAdminStep());
  return { ok: true, guide: { steps, notes } };
}

function classicGuide(card: CardData, opts: GuideOptions): GuideResult {
  const access = opts.access ?? 'buttons';
  const steps: BoxStep[] = [];
  const notes: string[] = [];
  const isAdminCard = card.folder === 0 && card.mode === ADMIN_MODE;

  if (card.folder === 0 && !isAdminCard) {
    const mod = modifiersFor('classic21').find((m) => m.code === card.mode);
    if (!mod) return unsupported('Diese Spezialkarte kennt TonUINO 2.1 nicht.');
    steps.push(...adminEntry('classic21', access, opts.buttons));
    steps.push(menuStep('Wähle im Admin-Menü die Spezialkarten', 0, 6, MENU.classic21.admin, ADMIN_SAYS[6]));
    steps.push(menuStep('Wähle die Karte', 0, mod.code, MENU.classic21.modifiers, CLASSIC_MODIFIER_SAYS[mod.code]));
    if (mod.params === 'sleep') {
      if (card.special & 0x80) return unsupported('Ausschalten am Ende des Titels kennt TonUINO 2.1 nicht.');
      const index = (SLEEP_MINUTES as readonly number[]).indexOf(card.special);
      if (index < 0) return unsupported(`An der Box gibt es nur ${SLEEP_MINUTES.join(', ')} Minuten.`);
      steps.push(menuStep('Wähle die Zeit', 0, index + 1, SLEEP_MINUTES.length, `${card.special} Minuten.`));
    }
    steps.push(placeCardStep('classic21'));
    return { ok: true, guide: { steps, notes } };
  }

  const modeCode = isAdminCard ? 6 : card.mode;
  if (modeCode < 1 || modeCode > MENU.classic21.modes) return unsupported('Diesen Modus kennt TonUINO 2.1 nicht.');
  if (modeCode === 5 && card.special2 > 0) return unsupported('Einen zufälligen Ordner aus mehreren kennt TonUINO 2.1 nicht.');

  if (opts.start === 'blank') {
    steps.push(blankCardStep('classic21'));
  } else {
    steps.push(...adminEntry('classic21', access, opts.buttons));
    steps.push(menuStep('Wähle im Admin-Menü', 0, 1, MENU.classic21.admin, ADMIN_SAYS[1]));
    steps.push({
      kind: 'card',
      text: `Die Box sagt ${PLACE} Lege jetzt die Karte auf, die du neu beschreiben willst, und lasse sie bis zum Schluss liegen. ${CLASSIC_CARD_ABORT}`,
    });
  }

  if (isAdminCard) {
    steps.push(menuStep('Wähle einen Ordner, für die Admin-Karte ist es egal welcher', 0, 1, 99, '1'));
  } else {
    steps.push(folderStep(card.folder));
  }
  steps.push(menuStep('Wähle, wie die Karte abspielt', 0, modeCode, MENU.classic21.modes, MODE_SAYS[modeCode]));

  if (modeCode === 4) {
    const max = trackLimit(opts, card.folder);
    if (card.special < 1 || card.special > max) return unsupported(`Titel ${card.special} gibt es in diesem Ordner nicht.`);
    steps.push(menuStep('Wähle den Titel', 0, card.special, max, String(card.special)));
  }
  if (modeCode >= 7 && modeCode <= 9) {
    const max = trackLimit(opts, card.folder);
    if (card.special < 1 || card.special2 < card.special || card.special2 > max) return unsupported('Der Bereich von … bis … passt nicht zum Ordner.');
    steps.push(menuStep('Wähle den ersten Titel', 0, card.special, max, String(card.special)));
    steps.push(menuStep('Wähle den letzten Titel', card.special, card.special2, max, String(card.special2)));
  }

  steps.push(finishOnBox());
  return { ok: true, guide: { steps, notes } };
}

/**
 * Runs of at least two single-track cards (mode 4) of one folder whose
 * tracks follow each other, as [first index, last index] into `cards`. The
 * box writes such a run in one go with batchGuide.
 */
export function singleTrackRuns(cards: CardData[]): [number, number][] {
  const runs: [number, number][] = [];
  const single = (c: CardData) => c.mode === 4 && c.folder > 0 && c.folder < 0xff;
  let i = 0;
  while (i < cards.length) {
    let j = i;
    if (single(cards[i])) {
      while (j + 1 < cards.length && single(cards[j + 1]) && cards[j + 1].folder === cards[i].folder && cards[j + 1].special === cards[j].special + 1) j++;
    }
    if (j > i) runs.push([i, j]);
    i = j + 1;
  }
  return runs;
}

/**
 * One card per track of a folder ("Einzelkarten für einen Ordner"): the box
 * announces each number and writes the next card as soon as it lies on the box.
 */
export function batchGuide(folder: number, first: number, last: number, profile: FirmwareProfile, opts: Omit<GuideOptions, 'start'> = {}): GuideResult {
  const max = opts.trackCount?.(folder) ?? 255;
  if (first < 1 || last < first || last > max) return unsupported('Der Bereich von … bis … passt nicht zum Ordner.');
  const menu = MENU[profile];
  const steps: BoxStep[] = [
    ...adminEntry(profile, opts.access ?? 'buttons', opts.buttons),
    menuStep('Wähle im Admin-Menü', 0, 9, menu.admin, ADMIN_SAYS[9]),
    folderStep(folder),
    menuStep('Wähle den ersten Titel', 0, first, max, String(first)),
    menuStep('Wähle den letzten Titel', first, last, max, String(last)),
    {
      kind: 'card',
      // TNG (state_machine.cpp, Admin_CardsForFolder start_writeCard) starts writing only once no
      // card lies on the box after the number; a card laid on during the number makes it wait
      // silently until it is taken off. Found with the box simulator (TODO #66).
      text:
        profile === 'tng'
          ? `Die Box sagt vor jeder Karte ihre Nummer und dann ${PLACE} Lege erst dann die nächste Karte auf, warte auf „OK“ und nimm sie wieder ab. Liegt die Karte schon früher auf, wartet die Box still, bis du sie abnimmst. Das geht so bis Titel ${last}. Abbrechen kannst du jederzeit, indem du die Play/Pause-Taste lang drückst.`
          : `Die Box sagt vor jeder Karte ihre Nummer. Lege dann die nächste Karte auf, warte auf „OK“ und nimm sie wieder ab. Das geht so bis Titel ${last}. ${CLASSIC_CARD_ABORT}`,
      hear: '„OK, bitte lege nun nacheinander die Karten auf die Box …“',
    },
    profile === 'tng' ? leaveAdminStep(true) : { kind: 'done', text: 'Fertig nach der letzten Karte.' },
  ];
  return { ok: true, guide: { steps, notes: ['Jede Karte spielt genau einen Titel (Modus Einzeltitel).'] } };
}
