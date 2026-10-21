/**
 * How loud a folder should be, in the sound dialog (SoundDialog.tsx): four
 * choices in words and a slider for the exact value, only there in dB.
 */
import { Field, Segmented } from '../../ui/components/controls';
import { formatOffset, LEVEL_CHOICES, LEVEL_OFFSET_MAX_DB, LEVEL_OFFSET_MIN_DB, levelChoiceOf, type LevelChoice } from './levelOffset';

/**
 * How loud the folder should be: four choices in words, and a slider for the
 * exact value (only there in dB). A value of the slider that is none of the
 * four leaves them all unchosen.
 */
export function LevelPick({ value, onChange }: { value: number; onChange: (db: number) => void }) {
  return (
    <div class="level-pick stack tight">
      <Field label="Wie laut soll der Ordner sein?">
        <Segmented<LevelChoice | ''>
          label="Wie laut soll der Ordner sein?"
          value={levelChoiceOf(value) ?? ''}
          options={LEVEL_CHOICES.map((c) => ({ value: c.id, label: c.label }))}
          onChange={(id) => onChange(LEVEL_CHOICES.find((c) => c.id === id)?.db ?? 0)}
        />
      </Field>
      <label class="slider-row level-slider">
        <span class="small soft">Genauer</span>
        <input
          type="range"
          min={LEVEL_OFFSET_MIN_DB}
          max={LEVEL_OFFSET_MAX_DB}
          step={1}
          value={value}
          aria-valuetext={formatOffset(value)}
          onInput={(e) => onChange(Number(e.currentTarget.value))}
        />
        <span class="small muted nowrap level-slider-value">{formatOffset(value)}</span>
      </label>
    </div>
  );
}
