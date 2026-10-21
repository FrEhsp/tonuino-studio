import { KeyRound, Lock } from 'lucide-preact';
import type { Volume, VolumeInfo } from '../../platform/types';
import { card, platform } from '../../app/state';
import { Button, Callout } from '../../ui/components/controls';
import { canFixOn, FIX_LABEL, fixing, fixTarget, fixWriteAccess, runFix, WRITE_HELP, WRITE_NOTICE_TITLE, writeNoticeKind, writeNoticeText } from './writeAccess';
import { isWriteDenied, withoutBoxHint } from './writeDenied';

/** On "Meine Box": the app may not change anything on the open card (see writeAccess.ts). */
export function WriteAccessNotice() {
  const s = card.value;
  if (!s) return null;
  const kind = writeNoticeKind(s, canFixOn(platform.value));
  if (!kind) return null;
  return (
    <Callout tone="warning" icon={kind === 'read-only' ? Lock : undefined}>
      <div class="row wrap card-note">
        <span class="grow">
          <b>{WRITE_NOTICE_TITLE}.</b> {writeNoticeText(kind, !!s.info.foreignOwner)}{' '}
          {kind === 'read-only' ? null : <a href={WRITE_HELP}>Mehr dazu</a>}
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
