import { KeyRound, Lock, RefreshCw } from 'lucide-preact';
import type { Volume, VolumeInfo } from '../../platform/types';
import { card, openVolume, platform } from '../../app/state';
import { CATALOG_FILE } from '../../core/tonuino/sd';
import { Button, Callout } from '../../ui/components/controls';
import { canFixOn, CHECK_HELP, FIX_LABEL, fixing, fixTarget, fixWriteAccess, runFix, WRITE_HELP, WRITE_NOTICE_TITLE, writeNoticeKind, writeNoticeText } from './writeAccess';
import { isWriteDenied, withoutBoxHint } from './writeDenied';

/** On "Meine Box": the app may not change anything on the open card (see writeAccess.ts). */
export function WriteAccessNotice() {
  const s = card.value;
  if (!s) return null;
  const kind = writeNoticeKind(s, canFixOn(platform.value));
  if (!kind) return s.unreadable?.length ? <UnreadableNotice files={s.unreadable} /> : null;
  return (
    <Callout tone="warning" icon={kind === 'read-only' || kind === 'read-only-system' ? Lock : undefined}>
      <div class="row wrap card-note">
        <span class="grow">
          <b>{WRITE_NOTICE_TITLE}.</b> {writeNoticeText(kind, !!s.info.foreignOwner)}{' '}
          {kind === 'read-only' ? null : kind === 'read-only-system' ? <a href={CHECK_HELP}>So prüfst du die Karte</a> : <a href={WRITE_HELP}>Mehr dazu</a>}
        </span>
        {kind === 'fix' ? (
          <Button size="sm" variant="primary" icon={KeyRound} loading={fixing.value} onClick={() => void runFix()}>
            {FIX_LABEL}
          </Button>
        ) : null}
      </div>
    </Callout>
  );
}

/**
 * The card's names or covers are there but failed to read (unreadable.ts):
 * the app changes nothing in them until a new reading works.
 */
function UnreadableNotice({ files }: { files: string[] }) {
  const what = files.includes(CATALOG_FILE) ? (files.length > 1 ? 'die Namen und Cover' : 'die Namen') : 'die Cover';
  return (
    <Callout tone="warning">
      <div class="row wrap card-note">
        <span class="grow">
          <b>Ich konnte {what} auf der Karte nicht lesen.</b> Damit nichts verloren geht, ändere ich daran nichts. Oft ist beim Schreiben die Verbindung zur Karte abgebrochen. Stecke die Karte neu ein und lies sie neu ein. Hilft das nicht, prüfe die Karte einmal. <a href={CHECK_HELP}>So prüfst du die Karte</a>
        </span>
        <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => { const v = card.peek()?.volume; if (v) void openVolume(v); }}>
          Neu einlesen
        </Button>
      </div>
    </Callout>
  );
}

/**
 * "Schreibrechte holen" right where a message says the app may not write on
 * the card: in a dialog, a result or a page, instead of sending the user to
 * "Meine Box". Shows nothing for other errors or where the app cannot do it.
 * `volume`: the card the write was for, when it is not the open one.
 * `onFixed` gets the card as it is mounted now, to go on right away.
 */
export function WriteFixButton({ error, volume, info, onFixed }: { error: unknown; volume?: Volume; info?: VolumeInfo; onFixed?: (fresh: Volume) => void }) {
  const target = isWriteDenied(error) ? fixTarget(volume, info) : null;
  if (!target) return null;
  return (
    <div>
      <Button
        size="sm"
        variant="primary"
        icon={KeyRound}
        loading={fixing.value}
        onClick={async () => {
          const fresh = await fixWriteAccess(target);
          if (fresh) onFixed?.(fresh);
        }}
      >
        {FIX_LABEL}
      </Button>
    </div>
  );
}

/** A line of such a message as it reads next to that button: without "see „Meine Box“". */
export function fixableLine(line: string, volume?: Volume, info?: VolumeInfo): string {
  return isWriteDenied(line) && fixTarget(volume, info) ? withoutBoxHint(line) : line;
}
