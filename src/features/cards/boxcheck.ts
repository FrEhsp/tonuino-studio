import type { FirmwareProfile } from '../../core/tonuino/card';
import type { HealthReport, Issue } from '../../core/tonuino/health';

/**
 * Teaching a card at the box only works when the box can speak: „Oh, eine
 * neue Karte!“, the numbers of its menus and „OK“ are system announcements
 * in mp3/ and advert/ on the SD card. The health check (core/tonuino/
 * health.ts) already finds every problem with them, and the ids of those
 * issues start with "system-". This module adds no checks of its own: it
 * picks the issue that matters most for the guide at the box and says it in
 * the words of the cards page, with a way to fix it.
 */

/** What is wrong with the announcements, as the cards page tells it. */
export type SoundsProblem =
  /** mp3/ or advert/ is not there at all. */
  | 'missing'
  /** Announcements every box needs are gone, empty, misnamed or there twice. */
  | 'broken'
  /** Only announcements of newer firmware are missing. */
  | 'outdated'
  /** A file in mp3/ or advert/ is far too big for an announcement. */
  | 'oversized'
  /** A check the cards page has no words of its own for yet. */
  | 'other';

export type SoundsAction =
  /** A place in the app, the Systemansagen tool. */
  | { kind: 'link'; href: string; label: string }
  /** The health check with its repairs, opened right on the cards page. */
  | { kind: 'health'; label: string };

export interface SoundsWarning {
  problem: SoundsProblem;
  tone: 'danger' | 'warning';
  text: string;
  action: SoundsAction;
  /** The issue of the health check the warning stands for. */
  issue: Issue;
}

const PREFIX = 'system-';
const SOUNDS_TOOL = '#/werkstatt/ansagen';
const REPAIR: SoundsAction = { kind: 'health', label: 'Ansehen und reparieren' };
/** Order among issues of the same severity: what silences the most comes first. */
const RANK: Record<SoundsProblem, number> = { missing: 0, broken: 1, outdated: 2, oversized: 3, other: 4 };

/** The kind of sound problem behind an issue of the health check; null for other issues. */
export function soundsProblem(issue: Issue): SoundsProblem | null {
  if (!issue.id.startsWith(PREFIX)) return null;
  const kind = issue.id.slice(PREFIX.length).split(':')[0];
  switch (kind) {
    case 'missing':
      return 'missing';
    // One id for two states: an error when announcements every box needs are gone, a warning when only newer ones are.
    case 'outdated':
      return issue.severity === 'error' ? 'broken' : 'outdated';
    case 'empty':
    case 'digits':
    case 'dup':
    case 'suffix':
    case 'typo':
      return 'broken';
    case 'oversized':
      return 'oversized';
    default:
      return 'other';
  }
}

/**
 * The announcement problem the guide at the box should warn about, or null
 * when the report has none. Hints (severity info) do not count: they never
 * keep the box from speaking.
 */
export function soundsWarning(report: HealthReport | null | undefined): SoundsWarning | null {
  let best: { issue: Issue; problem: SoundsProblem } | null = null;
  for (const issue of report?.issues ?? []) {
    if (issue.severity === 'info') continue;
    const problem = soundsProblem(issue);
    if (!problem) continue;
    if (!best || before(issue, problem, best.issue, best.problem)) best = { issue, problem };
  }
  if (!best) return null;
  const { issue, problem } = best;
  return { problem, issue, tone: issue.severity === 'error' ? 'danger' : 'warning', ...wording(issue, problem) };
}

function before(a: Issue, pa: SoundsProblem, b: Issue, pb: SoundsProblem): boolean {
  const sa = a.severity === 'error' ? 0 : 1;
  const sb = b.severity === 'error' ? 0 : 1;
  return sa !== sb ? sa < sb : RANK[pa] < RANK[pb];
}

function wording(issue: Issue, problem: SoundsProblem): { text: string; action: SoundsAction } {
  switch (problem) {
    case 'missing':
      return {
        // The menus at the box speak from mp3/ only; health.ts names the missing folders in the title.
        text: onlyAdvertMissing(issue)
          ? 'Auf dieser SD-Karte fehlt der Ordner advert mit Systemansagen. Ohne ihn kann die Box zum Beispiel keine Titelnummern ansagen.'
          : 'Auf dieser SD-Karte fehlen die Systemansagen. Ohne sie sagt die Box beim Anlernen nichts, auch nicht „Oh, eine neue Karte!“.',
        action: { kind: 'link', href: SOUNDS_TOOL, label: 'Systemansagen installieren' },
      };
    case 'broken':
      return { text: 'Einige Systemansagen fehlen oder heißen falsch. Dann bleibt die Box im Menü an manchen Stellen stumm oder sagt etwas Falsches.', action: REPAIR };
    case 'outdated':
      return {
        text: 'Die Systemansagen sind älter als die Firmware. Bei neueren Fragen im Menü bleibt die Box dann vielleicht stumm.',
        action: { kind: 'link', href: SOUNDS_TOOL, label: 'Systemansagen aktualisieren' },
      };
    case 'oversized': {
      const dir = issue.id.split(':')[1];
      const where = dir === 'mp3' || dir === 'advert' ? `Im Ordner ${dir}` : 'Bei den Systemansagen';
      return {
        text: `${where} liegt eine sehr große Datei, vielleicht ein Hörspiel statt einer kurzen Ansage. Spielt die Box sie beim Anlernen ab, wartet sie womöglich, bis sie zu Ende ist.`,
        action: REPAIR,
      };
    }
    case 'other':
      return { text: 'Mit den Systemansagen auf dieser SD-Karte stimmt etwas nicht. Dann bleibt die Box beim Anlernen vielleicht stumm oder sagt etwas Falsches.', action: REPAIR };
  }
}

function onlyAdvertMissing(issue: Issue): boolean {
  return /\badvert\b/.test(issue.title) && !/\bmp3\b/.test(issue.title);
}

/** The parts of the open SD card the guide at the box looks at. */
export interface OpenCard {
  status: 'scanning' | 'ready' | 'error';
  scan?: { kind: string };
  report?: HealthReport;
  /**
   * Firefox, Safari: new announcements wait for the Paket. The report then
   * shows the card as it will be, not as the box has it now.
   */
  soundsPending?: boolean;
}

export type SoundsNotice =
  /** A problem with the announcements on the open SD card. */
  | { kind: 'warning'; warning: SoundsWarning }
  /** No TonUINO card to look at: say where to check the announcements. */
  | { kind: 'hint' }
  /** The announcements are in the Paket, not yet on the card: the box stays silent until it is unpacked. */
  | { kind: 'pending'; text: string }
  /** Nothing to say: the announcements are fine, or the card is still being read. */
  | null;

export const SOUNDS_PENDING =
  'Die Systemansagen sind im Paket für die Karte, aber noch nicht auf der Karte. Bringe erst das Paket auf die Karte. Sonst bleibt die Box beim Anlernen stumm.';

/**
 * What the guide at the box says about the announcements. The health check
 * runs only on a TonUINO card; for no card, an unreadable one or an empty
 * one the guide cannot vouch for them and points to where to check.
 */
export function soundsNotice(open: OpenCard | null | undefined): SoundsNotice {
  if (open?.status === 'scanning') return null;
  if (open?.status === 'ready' && open.soundsPending) return { kind: 'pending', text: SOUNDS_PENDING };
  if (!open || open.status === 'error' || open.scan?.kind !== 'tonuino' || !open.report) return { kind: 'hint' };
  const warning = soundsWarning(open.report);
  return warning ? { kind: 'warning', warning } : null;
}

/* ------------------------------------------------------------------ Klappt es nicht? */

export interface TroubleCase {
  /** What you notice at the box. */
  title: string;
  /** What it means and what to do, in a few short sentences. */
  text: string;
  /** Where to read on or look: a help section or the Box-Logbuch. */
  link: { label: string; href: string };
}

const MORE = { label: 'Mehr dazu in der Hilfe', href: '#/hilfe/anlernen-klappt-nicht' };
const CARD_HELP = { label: 'Eine Karte wird nicht erkannt', href: '#/hilfe/karte-geht-nicht' };
/** „Auth failed“ with every card points at the reader in the box (forum 13422#11, 14719#1). */
const READER = 'Steht das bei jeder Karte, ist vielleicht der Kartenleser in der Box defekt oder falsch angeschlossen.';
/** The installer names announcements by their number alone (with the default setting „Nur Nummern als Dateinamen“). */
const PURE_NUMBERS = 'Spiele die Systemansagen mit der App neu auf, dann heißen sie nur nach ihrer Nummer.';

/**
 * What goes wrong most often while a card is taught at the box, from the
 * forum (9156, 13518, 14797, 13992, 14778, 12738, 12463) and checked
 * against the firmware: TonUINO TNG 3.3.3 (state_machine.cpp,
 * chip_card.cpp, commands.cpp) and TonUINO 2.1 (Tonuino.ino).
 */
export function boxTrouble(profile: FirmwareProfile): TroubleCase[] {
  const tng = profile === 'tng';
  return [
    {
      title: 'Die Box sagt nichts',
      // TNG starts the menu only for a blank card, 2.1 for any card that is not a TonUINO card.
      text: `Ohne Systemansagen auf der SD-Karte bleibt die Box stumm. Sagt sie nur beim Auflegen nicht „Oh, eine neue Karte!“, ist die Karte schon ${tng ? '' : 'für TonUINO '}beschrieben oder die Box kann sie nicht lesen. Für eine beschriebene Karte stellst du oben „schon benutzt“ ein.`,
      link: CARD_HELP,
    },
    {
      title: 'Die Box bricht sofort ab',
      // A held Pause key aborts every menu. TNG logs each key as "btn/cmd", except on the original AiO board.
      text: `Sagt die Box gleich „OK, ich habe den Vorgang abgebrochen.“, hält sie wahrscheinlich eine Taste für gedrückt. Vielleicht klemmt eine Taste, oder die Tasten sind falsch angeschlossen.${tng ? ' Im Box-Logbuch siehst du bei den meisten Boxen jeden Tastendruck.' : ''}`,
      link: tng ? { label: 'Box-Logbuch öffnen', href: '#/werkstatt/logbuch' } : MORE,
    },
    {
      title: 'Die Box sagt nur den ersten Modus an',
      text: tng
        ? `Das kommt vor allem bei MP3-Playern mit dem nachgebauten Chip MH2024K-24SS vor. Manche MP3-Player in der Box spielen nur Ansagen, die reine Nummern heißen. ${PURE_NUMBERS} Hilft das nicht, braucht die Box eine eigens für diesen Chip eingestellte Firmware. Frage dafür im TonUINO-Forum.`
        : `Manche MP3-Player in der Box spielen nur Ansagen, die reine Nummern heißen. ${PURE_NUMBERS} Hilft das nicht, frage im TonUINO-Forum.`,
      link: MORE,
    },
    tng
      ? {
          title: 'Im Box-Logbuch steht „Auth failed“',
          // Writing right after „Oh, eine neue Karte!“ failed in 13518; through the admin menu the box asks for the card first.
          text: `Die Box konnte die Karte nicht entsperren. Lerne sie über das Admin-Menü an: Stelle oben „schon benutzt“ ein, auch wenn die Karte neu ist. Dann legst du sie erst auf, wenn die Box darum bittet. Klappt es mit einer Karte nie, nimm eine andere. ${READER}`,
          link: CARD_HELP,
        }
      : {
          title: 'Im Box-Logbuch steht „PCD_Authenticate() failed“',
          text: `Die Box konnte die Karte nicht entsperren. Lege die Karte ruhig auf und lasse sie liegen, bis die Box „OK“ sagt. Klappt es mit einer Karte nie, nimm eine andere. ${READER}`,
          link: CARD_HELP,
        },
    {
      title: 'Admin-Menü gesperrt, PIN vergessen',
      // Both firmwares open the menu for an admin card without asking, and a new card starts its menu despite the lock.
      text: 'Die Admin-Karte öffnet das Menü immer, auch wenn es gesperrt ist. Füge sie oben mit „Spezialkarte hinzufügen“ hinzu und lerne sie mit einer neuen, leeren Karte an. Dafür braucht die Box das Admin-Menü nicht.',
      link: MORE,
    },
    {
      title: 'Die Box reagiert lange nicht',
      // 2.1 waits for „Oh, eine neue Karte!“ and for menu announcements to end; TNG waits for its „OK“ to end before it goes on.
      text: 'An manchen Stellen wartet die Box, bis eine Ansage zu Ende ist. Liegt im Ordner mp3 statt einer kurzen Ansage zum Beispiel ein ganzes Hörspiel, dauert das. Spiele die Systemansagen mit der App neu auf. Hörspiele gehören in die nummerierten Ordner.',
      link: MORE,
    },
  ];
}
