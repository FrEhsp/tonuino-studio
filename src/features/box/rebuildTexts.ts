import { formatBytes } from '../../app/format';
import { CopyError, durationText, estimateMinutes, type TargetJudgement } from '../../core/tonuino/rebuild';
import { isWriteDenied, withoutBoxHint } from './writeDenied';

/**
 * The words of "Karte neu aufbauen", kept apart from the dialog so the
 * important ones (why a card is turned down) can be tested.
 */

/** Which way into the dialog: rebuild this card, move to a new card, or only write a backup back. */
export type RebuildStart = 'rebuild' | 'move' | 'restore';

export const WHY_TEXT =
  'Hat jemand früher Dateien einzeln auf die Karte kopiert, findet der MP3-Player manchmal Titel nicht, springt oder bleibt hängen. Das kann auch passieren, wenn der Gesundheitscheck nichts findet. Dann hilft oft: Karte sichern, frisch formatieren, alles in der richtigen Reihenfolge zurückspielen.';

export const MOVE_TEXT =
  'Die Karte macht Ärger, oder sie ist größer als 32 GB? Dann ziehe auf eine neue Karte um. Ich sichere alles, was die Box abspielt, auf deinem Computer und spiele es in der richtigen Reihenfolge auf die neue Karte.';

/** Words for a few names: "„Fotos“, „05/cover.jpg“ und 3 mehr". */
export function namesText(items: readonly string[], max = 4): string {
  const shown = items.slice(0, max).map((i) => `„${i.replace(/\/$/, '')}“`).join(', ');
  return items.length > max ? `${shown} und ${items.length - max} mehr` : shown;
}

/** Said before formatting: what the backup does not hold is gone afterwards. */
export function notInBackupText(items: readonly string[]): string {
  return `Nicht in der Sicherung: ${namesText(items)}. Die Box spielt das nicht ab. Brauchst du es, kopiere es vor dem Formatieren selbst auf deinen Computer, sonst ist es weg.`;
}

export const KEEPS_NUMBERS = 'Alle Ordner behalten ihre Nummer. Deine Karten funktionieren danach weiter.';

/** "9,4 GB · etwa 20 Minuten" for the backup and the way back together. */
export function sizeAndTime(bytes: number): string {
  return `${formatBytes(bytes)} · ${durationText(estimateMinutes(bytes))}`;
}

const SWAP_CARDS = 'Das ist noch die alte Karte. Nimm sie heraus und stecke die neue Karte ein.';

/**
 * What a card in the list of possible targets is, in one or two sentences.
 * `start` is the way into the dialog, `oldCard` that the card holds the
 * catalog of the backed-up box: moving never formats the old card.
 */
export function verdictText(j: TargetJudgement, o: { browser?: boolean; start?: RebuildStart; oldCard?: boolean } = {}): string {
  const start = o.start ?? 'rebuild';
  switch (j.verdict) {
    case 'ok': {
      const parts = ['Leer und bereit.'];
      if (j.fsUnknown) parts.push(o.browser ? 'Ob sie FAT32 hat, kann ich im Browser nicht sehen. Hast du sie eben mit FAT32 formatiert, passt es.' : 'Ihr Format kenne ich nicht. Hast du sie eben mit FAT32 formatiert, passt es.');
      if (j.smallClusters) parts.push('Sie hat kleine Zuordnungseinheiten. Das geht. Mit 32 KB findet die Box ihre Titel etwas schneller.');
      return parts.join(' ');
    }
    case 'resume':
      return 'Hier hat das Zurückspielen schon angefangen. Ich mach dort weiter.';
    case 'not-fat':
      return `Die Karte hat das Format ${fsName(j.fsType)}. Die Box liest nur FAT32. Formatiere sie noch einmal mit FAT32.${j.big ? ' Sie ist größer als 32 GB, dafür bietet dein Computer oft kein FAT32 an. Nimm dann eine Karte mit höchstens 32 GB.' : ''}`;
    case 'not-empty': {
      const items = j.items ?? [];
      if (o.oldCard && start === 'move') return SWAP_CARDS;
      if (o.oldCard && start === 'rebuild' && items.length) return `Das ist noch die alte Karte. Formatiere sie zuerst. Nicht in der Sicherung: ${namesText(items)}. Kopiere das vorher selbst, wenn du es brauchst.`;
      return `Auf der Karte liegt noch etwas${items.length ? `: ${namesText(items)}` : ''}. Formatiere sie zuerst.`;
    }
    case 'not-formatted':
      if (start === 'move') return SWAP_CARDS;
      if (start === 'restore') return 'Auf der Karte liegt schon alles aus der Sicherung. Hier musst du nichts zurückspielen.';
      return 'Auf der Karte liegt noch alles von vorher. Formatiere sie zuerst.';
    case 'too-small':
      return `Zu klein: Die Sicherung braucht ${formatBytes(j.need ?? 0)}, frei sind ${formatBytes(j.free ?? 0)}. Nimm eine größere Karte.`;
    case 'incomplete':
      return 'Die Sicherung ist nicht fertig. Spiele sie so nicht zurück.';
  }
}

/** Whether the restore may start on this card. */
export function canRestoreTo(j: TargetJudgement): boolean {
  return j.verdict === 'ok' || j.verdict === 'resume';
}

/** "exFAT", "NTFS": the name people see in their system's tools. */
export function fsName(fs: string | undefined): string {
  const f = (fs ?? '').trim().toLowerCase();
  if (f === 'exfat') return 'exFAT';
  if (f === 'ntfs' || f === 'ntfs3' || f === 'fuseblk') return 'NTFS';
  if (f === 'apfs') return 'APFS';
  if (f === 'hfs' || f === 'hfsplus') return 'Mac OS Extended';
  if (f === 'ext4' || f === 'ext3' || f === 'ext2') return f;
  return fs?.trim() || 'unbekannt';
}

/** Said after a backup stopped: making it never touches the box's folders. */
export const CARD_UNCHANGED = 'An deinen Ordnern auf der Karte hat sich nichts geändert.';

/** The backup stopped: what happened and what to do. The box's folders are unchanged. */
export function backupErrorText(e: unknown): string[] {
  const msg = e instanceof Error ? e.message : String(e);
  const lines = [msg];
  if (e instanceof CopyError && e.stage === 'check') {
    lines.push(`${CARD_UNCHANGED} Versuche es noch einmal. Passiert das wieder, ist vielleicht die Karte oder das Laufwerk kaputt. Formatiere die Karte dann nicht.`);
  } else if (e instanceof CopyError && e.stage === 'read') {
    lines.push(`${CARD_UNCHANGED} Stecke sie neu ein und versuche es noch einmal. Ich mach dort weiter, wo ich aufgehört hab.`);
  } else {
    lines.push(`${CARD_UNCHANGED} Prüfe den Ordner für die Sicherung und versuche es noch einmal. Ich mach dort weiter, wo ich aufgehört hab.`);
  }
  return lines;
}

/**
 * Copying to another card stopped: what happened and what to do. This card
 * is only read. A file that failed its check stays on the other card, and
 * the folder then counts as taken there: the next try needs „Ersetzen“.
 */
export function copyErrorText(e: unknown, target: 'card' | 'folder'): string[] {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof CopyError && e.stage === 'check') {
    const where = target === 'card' ? 'Auf der anderen Karte' : 'Im Ordner';
    const broken = target === 'card' ? 'die andere Karte vielleicht kaputt. Nimm dann eine andere Karte.' : 'das Laufwerk vielleicht kaputt. Wähle dann einen anderen Ordner.';
    return [
      `${where} ist eine Datei nicht heil angekommen.`,
      msg,
      `Diese Karte ist unverändert. Versuche es noch einmal und wähle bei den belegten Nummern „Ersetzen“. Passiert das wieder, ist ${broken}`,
    ];
  }
  return [
    'Das Kopieren hat nicht geklappt.',
    msg,
    target === 'card' ? 'Diese Karte ist unverändert. Stecke die andere Karte neu ein und versuche es noch einmal.' : 'Diese Karte ist unverändert. Prüfe den Ordner und versuche es noch einmal.',
  ];
}

/** A write failed because the drive is full (browser, Linux, macOS, Windows wording). */
export function isDiskFull(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 4; depth++) {
    if (x instanceof DOMException && x.name === 'QuotaExceededError') return true;
    const msg = x instanceof Error ? x.message : String(x);
    if (/ist voll|no space left|not enough space|disk full|os error (28|112)\b|ENOSPC/i.test(msg)) return true;
    x = x instanceof Error ? x.cause : undefined;
  }
  return false;
}

/** Writing back stopped: what happened and what to do. `need` is what the whole backup takes on a card. */
export function restoreErrorText(e: unknown, o: { need?: number; canFix?: boolean } = {}): string[] {
  const msg = e instanceof Error ? e.message : String(e);
  if (isWriteDenied(e)) {
    // The way out is right below the text ("Schreibrechte holen"), or it is the one that always works.
    return o.canFix
      ? [withoutBoxHint(msg), 'Die Karte ist noch nicht fertig. Tippe auf „Schreibrechte holen“ und danach noch einmal auf „Zurückspielen“. Ich mach dort weiter, wo ich aufgehört hab.']
      : [withoutBoxHint(msg), 'Die Karte ist noch nicht fertig. Wirf sie im Dateimanager aus, ziehe sie heraus und stecke sie neu ein. Dann tippe noch einmal auf „Zurückspielen“. Ich mach dort weiter, wo ich aufgehört hab.'];
  }
  if (e instanceof CopyError && e.stage === 'damaged') {
    return [msg, 'Die Karte ist noch nicht fertig: Die Sicherung hat sich seit dem Sichern verändert. Liegt sie auf einem Laufwerk, das Ärger macht? Ist die alte Karte noch nicht formatiert, mache mit ihr eine neue Sicherung.'];
  }
  if (isDiskFull(e)) {
    const need = o.need ? ` Die Sicherung braucht ${formatBytes(o.need)}.` : '';
    return [msg, `Die Karte ist zu klein.${need} Nimm eine größere Karte mit höchstens 32 GB, formatiere sie mit FAT32 und spiele die Sicherung dort zurück.`];
  }
  return [msg, 'Die Karte ist noch nicht fertig. Stecke sie neu ein und versuche es noch einmal. Ich mach dort weiter, wo ich aufgehört hab.'];
}
