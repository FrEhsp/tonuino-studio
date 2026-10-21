/**
 * "Box einstellen" › Kopfhörer-Grenzen: only for TNG boxes that notice a
 * headphone (headphones.ts). A switch like the other parts; turned on, it
 * shows its own steps right here, since they need the headphone plugged in
 * and so do not mix with the steps for the speaker below.
 */
import { useState } from 'preact/hooks';
import { CircleCheck, Headphones, Info } from 'lucide-preact';
import type { KeyCount } from '../../core/tonuino/adminkeys';
import type { AdminAccess } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { MAX_VOLUME, volumeProblem, type Volumes } from '../../core/tonuino/settingsguide';
import { Callout, Field, Segmented } from '../../ui/components/controls';
import { GuideStep } from '../cards/BoxPanel';
import { knownBuild } from './boxbuild';
import { HEADPHONE_PRESETS, hasHeadphoneDetection, headphoneGuide, type HeadphonePreset } from './headphones';
import { logSession } from './logsession';
import { SettingCheck } from './common';

const FIELDS: { key: keyof Volumes; label: string }[] = [
  { key: 'max', label: 'Am lautesten' },
  { key: 'min', label: 'Am leisesten' },
  { key: 'init', label: 'Beim Einschalten' },
];

export function HeadphoneLimits({ prof, access, open, buttons }: { prof: FirmwareProfile; access: AdminAccess; open?: AdminAccess; buttons?: KeyCount }) {
  void logSession.revision.value;
  const info = logSession.source.kind === 'live' ? logSession.book.info : undefined;
  const [on, setOn] = useState(false);
  const [preset, setPreset] = useState<HeadphonePreset>('leise');
  const [own, setOwn] = useState<Record<keyof Volumes, string>>({ max: '15', min: '1', init: '5' });
  if (prof !== 'tng' || !hasHeadphoneDetection({ info, build: knownBuild.value, board: info?.board })) return null;

  const now = info?.settings.headphoneVolume;
  const volume: Volumes = preset === 'eigene' ? { max: Number(own.max), min: Number(own.min), init: Number(own.init) } : HEADPHONE_PRESETS.find((p) => p.id === preset)!.volume;
  const problem = preset === 'eigene' ? volumeProblem(volume) : undefined;
  const result = on && !problem ? headphoneGuide(prof, volume, now, { access, open, buttons }) : undefined;
  const nowText = now ? `Jetzt: ${now.min} bis ${now.max}, beim Einschalten ${now.init}` : 'Eigene Lautstärke, wenn ein Kopfhörer steckt';

  return (
    <div class={`card ws-set ${on ? 'on' : ''}`}>
      <div class="ws-set-head">
        <SettingCheck checked={on} onChange={setOn} title="Lautstärke für Kopfhörer" note={nowText} />
      </div>
      {on ? (
        <div class="ws-set-body stack">
          <p class="small soft row tight">
            <Headphones size={15} aria-hidden="true" /> Deine Box merkt, wenn ein Kopfhörer steckt, und nimmt dann diese Grenzen. Das schont Kinderohren.
          </p>
          <Segmented<HeadphonePreset>
            label="Grenzen für Kopfhörer"
            value={preset}
            options={[...HEADPHONE_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'eigene' as const, label: 'Eigene Werte' }]}
            onChange={setPreset}
          />
          {preset === 'eigene' ? (
            <div class="stack tight">
              <div class="row wrap">
                {FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} id={`hp-${f.key}`}>
                    <input
                      id={`hp-${f.key}`}
                      class="input"
                      style={{ width: 90 }}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_VOLUME}
                      value={own[f.key]}
                      onInput={(e) => setOwn({ ...own, [f.key]: (e.currentTarget as HTMLInputElement).value })}
                    />
                  </Field>
                ))}
              </div>
              <p class="small muted">Von 1 bis {MAX_VOLUME}, wie beim Lautsprecher.</p>
            </div>
          ) : (
            <p class="small soft">{HEADPHONE_PRESETS.find((p) => p.id === preset)!.text}</p>
          )}
          {problem ? <Callout tone="warning">{problem}</Callout> : null}
          {result && !result.ok ? <Callout tone="danger">{result.reason}</Callout> : null}
          {result?.ok && !result.guide.steps.length ? (
            <Callout tone="success" icon={CircleCheck}>
              Der Kopfhörer hat schon diese Grenzen. Du musst nichts drücken.
            </Callout>
          ) : null}
          {result?.ok && result.guide.steps.length ? (
            <div class="guide">
              <ol class="guide-steps">
                {result.guide.steps.map((s, i) => (
                  <GuideStep step={s} n={i + 1} key={i} />
                ))}
              </ol>
              {result.guide.notes.length ? (
                <div class="guide-notes">
                  {result.guide.notes.map((n) => (
                    <p key={n}>
                      <Info size={15} /> {n}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
