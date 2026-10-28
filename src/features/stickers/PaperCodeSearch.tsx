/**
 * "Nummer auf der Packung" (TODO #120): type the number from the pack, get the paper. A number the app
 * knows without a paper, or does not know, leads to "Eigene Größe".
 *
 * Self-contained, so the rebuilt sticker page can place it where it likes:
 *   <PaperCodeSearch onOwnSize={() => setOwnSize(true)} />
 */
import { useState } from 'preact/hooks';
import { findPaperByCode } from '../../core/stickers/packcodes';
import { getTemplate } from '../../core/stickers/templates';
import { Button } from '../../ui/components/controls';
import { template, updatePrint } from './design';

export function PaperCodeSearch({ onOwnSize }: { onOwnSize: () => void }) {
  const [code, setCode] = useState('');
  const match = findPaperByCode(code);
  const found = match.kind === 'found' ? getTemplate(match.templateId) : undefined;
  const chosen = found && template.value.id === found.id;
  return (
    <div class="stack tight paper-code">
      <label class="soft small" for="st-paper-code">
        Nummer auf der Packung
      </label>
      <input id="st-paper-code" class="input" type="search" autoComplete="off" spellcheck={false} placeholder="zum Beispiel 5028 oder L4775" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
      {match.kind === 'found' && found ? (
        <div class="row wrap" role="status">
          <span class="small">
            {match.entry.maker} {match.entry.codes[0]}: {match.entry.what}. {chosen ? <>Ist schon gewählt: „{found.name}“.</> : <>Dafür nimmst du „{found.name}“.</>}
          </span>
          {chosen ? null : (
            <Button size="sm" onClick={() => updatePrint({ templateId: found.id })}>
              Nehmen
            </Button>
          )}
        </div>
      ) : match.kind === 'known' ? (
        <div class="row wrap" role="status">
          <span class="small">
            {match.entry.maker} {match.entry.codes[0]}: {match.entry.what}. {match.entry.note}
          </span>
          <Button size="sm" onClick={onOwnSize}>
            Eigene Größe eingeben
          </Button>
        </div>
      ) : match.kind === 'unknown' ? (
        <div class="row wrap" role="status">
          <span class="small">Diese Nummer kenne ich nicht. Gib die Maße von der Packung ein.</span>
          <Button size="sm" onClick={onOwnSize}>
            Eigene Größe eingeben
          </Button>
        </div>
      ) : null}
    </div>
  );
}
