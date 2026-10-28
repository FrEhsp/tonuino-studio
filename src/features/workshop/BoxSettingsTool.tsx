/**
 * Box einstellen: volume limits, Ausschalt-Timer, buttons, lock and more,
 * chosen in sentences (VerhaltenSaetze.tsx, the same as the step „Verhalten“ of
 * the firmware wizard) and done step by step in the box's own admin menu.
 * The steps come from settingsguide.ts; what the box has now comes from the
 * Steckbrief of the Box-Logbuch, when it ran in this session.
 */
import { CircleAlert, CircleCheck, CreditCard, Info, NotebookText } from 'lucide-preact';
import { keyCount, adminKeys, type KeyCount } from '../../core/tonuino/adminkeys';
import { adminAccessFor, effectiveAccess, type AdminAccess } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { FACTORY_SETTINGS, settingsGuide, type BoxSettingValues } from '../../core/tonuino/settingsguide';
import { Button, Callout, Segmented } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { plat, profile, setProfile, settings, updateSettings } from '../../app/state';
import { GuideStep, KeyLegend } from '../cards/BoxPanel';
import { ADMIN_ACCESS } from '../settings/options';
import { ToolHeader } from './common';
import { HeadphoneLimits } from './HeadphoneLimits';
import { AdminCardButton, Saetze } from './VerhaltenSaetze';
import { NOTHING_ON, applied, currentValues, doneNote, draftFrom, knowledge, verhalten, visibleParts, wishOf, type Draft } from './verhalten';

// Kept here for the tests and the help texts that know them by this file.
export { basisOf, currentValues, lockOf, pinUnusable, valuesFromInfo, type Applied, type Basis } from './verhalten';
export { BUTTONS_PART_HINT, buttonsOptions, noLockText, standbyOffText } from './VerhaltenSaetze';

/** "der Admin-Karte", "einer PIN": to follow "mit". */
function accessLabel(a: AdminAccess): string {
  return ADMIN_ACCESS.find((c) => c.value === a)?.label ?? a;
}

/** After "Erledigt" with a new lock: how the card guides open the admin menu from now on. */
export function lockDoneNote(lock: AdminAccess, prof: FirmwareProfile, keys?: KeyCount): string {
  const how = lock === 'buttons' ? `mit ${adminKeys(prof, keys)}` : lock === 'card' ? 'mit der Admin-Karte' : lock === 'pin' ? 'mit der PIN' : 'mit der Rechenaufgabe';
  return `Gemerkt. Die Anleitungen für Karten öffnen das Admin-Menü jetzt ${how}.`;
}

/* ------------------------------------------------------------------ page */

export function BoxSettingsTool() {
  const prof = profile.value;
  const box = knowledge();
  const d: Draft = verhalten.value ?? draftFrom(box.values, box.invert);
  const set = (patch: Partial<Draft>) => {
    verhalten.value = { ...d, ...patch };
    doneNote.value = undefined;
  };

  const tng = prof === 'tng';
  const serial = plat().capabilities.serial;
  const keys = keyCount(box.buttons);
  const visible = visibleParts(prof, keys, box.invert);
  const wish = wishOf(d, visible);

  const access = effectiveAccess(settings.value.adminAccess, prof);
  const result = settingsGuide(prof, wish, box.values, { access, open: box.cardOnly ? 'card' : undefined, buttons: keys, invert: keys === 5 ? box.invert : 'three' });
  const anyOn = Object.keys(wish).length > 0;
  // „Play ohne Karte“ is in the firmware: what the box has, when the app knows its build.
  const weiterJetzt = box.build ? box.build.preset === 'weiter' : undefined;

  const finish = () => {
    if (!result.ok) return;
    const after: BoxSettingValues = wish.reset ? { ...FACTORY_SETTINGS, volume: { ...FACTORY_SETTINGS.volume } } : {};
    if (wish.volume) after.volume = wish.volume;
    if (wish.standby !== undefined) after.standby = wish.standby;
    if (wish.shortPressVolume !== undefined) after.shortPressVolume = wish.shortPressVolume;
    if (wish.pauseWhenCardRemoved !== undefined) after.pauseWhenCardRemoved = wish.pauseWhenCardRemoved;
    if (wish.eq !== undefined) after.eq = wish.eq;
    if (wish.lock !== undefined) after.lock = wish.lock;
    if (wish.pin) after.pin = wish.pin;
    // Layered on what this guide started from; a newer Steckbrief later replaces both.
    applied.value = { values: { ...currentValues({}, box.basis, applied.value), ...after }, basis: box.basis };
    const lock = wish.lock ?? (wish.reset ? 'buttons' : undefined);
    if (lock !== undefined && lock !== settings.value.adminAccess) updateSettings({ adminAccess: lock });
    verhalten.value = { ...draftFrom({ ...box.values, ...after }), on: { ...NOTHING_ON }, weiter: d.weiter };
    doneNote.value =
      lock !== undefined
        ? lockDoneNote(lock, prof, keys)
        : 'Erledigt. In den Sätzen steht jetzt, was die Box hat, bis du die App schließt. Willst du noch etwas ändern, wähle es oben neu.';
  };

  return (
    <div class="page narrow ws-page">
      <ToolHeader title="Box einstellen" intro="Lautstärke begrenzen, Ausschalt-Timer, Sperren: Wähle hier aus, wie die Box sein soll. Danach zeigt die Seite Schritt für Schritt, welche Tasten du an der Box drückst." />

      <section class="card pad stack" aria-labelledby="ws-set-box">
        <h2 id="ws-set-box" class="ws-set-title">
          Deine Box
        </h2>
        <div class="row wrap ws-set-firmware">
          <span class="field-label">Firmware</span>
          <Segmented<FirmwareProfile>
            label="Firmware der Box"
            value={prof}
            options={[
              { value: 'tng', label: 'TonUINO TNG' },
              { value: 'classic21', label: 'TonUINO 2.1' },
            ]}
            onChange={(p) => setProfile(p).catch((e) => toastError('Speichern hat nicht geklappt', e))}
          />
        </div>
        {box.firmware && box.firmware !== prof ? (
          <Callout tone="warning">Das Box-Logbuch hat eben {box.firmware === 'tng' ? 'TonUINO TNG' : 'TonUINO 2.1'} gesehen. Stelle oben die Firmware der Box ein, sonst passen die Schritte nicht.</Callout>
        ) : null}
        {box.fromLog ? (
          <p class="small soft row tight ws-set-source">
            <NotebookText size={16} aria-hidden="true" /> Was jetzt eingestellt ist, stammt aus dem Box-Logbuch. Darum steht bei jedem Schritt genau, wie oft du drückst.
          </p>
        ) : box.fileName ? (
          // A saved file is not used for the values: they may be old.
          <div class="ws-set-unknown">
            <p class="small soft">
              Das Box-Logbuch zeigt die gespeicherte Datei „{box.fileName}“. Ihre Werte können veraltet sein, darum stehen hier die Werte ab Werk.{' '}
              {serial
                ? 'Lies die Box im Box-Logbuch neu aus, dann steht bei jedem Schritt genau, wie oft du drückst.'
                : 'Lies die Box in Chrome, Edge, Firefox ab Version 151 oder der Desktop-App neu aus, dann steht bei jedem Schritt genau, wie oft du drückst.'}
            </p>
            {serial ? (
              <a class="link-button" href="#/werkstatt/logbuch">
                <NotebookText size={16} aria-hidden="true" /> Box neu auslesen
              </a>
            ) : null}
          </div>
        ) : !serial ? (
          // Without USB the Box-Logbuch cannot read the box.
          <p class="small soft ws-set-source">
            Genau zählen kann ich nur, wenn ich die Box über USB auslese. Das geht in Chrome, Edge, Firefox ab Version 151 oder der Desktop-App. Hier stehen die Werte ab Werk.
          </p>
        ) : (
          <div class="ws-set-unknown">
            <p class="small soft">Ich kenne die Einstellungen deiner Box noch nicht. Darum stehen hier die Werte ab Werk. Liest du die Box vorher im Box-Logbuch aus, steht bei jedem Schritt genau, wie oft du drückst.</p>
            <a class="link-button" href="#/werkstatt/logbuch">
              <NotebookText size={16} aria-hidden="true" /> Box-Logbuch öffnen
            </a>
          </div>
        )}
        {box.fileLock && box.fileLock !== access ? (
          <Callout tone="warning">
            {adminAccessFor(prof).includes(box.fileLock) ? (
              // The choice right here: on the settings page it is far down, under another heading.
              <div class="stack tight">
                <span>
                  Laut der Datei ist das Admin-Menü mit {accessLabel(box.fileLock)} geschützt. Die Schritte unten öffnen es mit {accessLabel(access)}. Hast du die Sperre inzwischen geändert, lasse es so.
                </span>
                <div>
                  <Button size="sm" onClick={() => updateSettings({ adminAccess: box.fileLock })}>
                    Schritte mit {accessLabel(box.fileLock)} zeigen
                  </Button>
                </div>
              </div>
            ) : (
              <>
                Laut der Datei ist das Admin-Menü mit {accessLabel(box.fileLock)} geschützt. Die Schritte unten öffnen es mit {accessLabel(access)}. Ist die Box noch gesperrt, stelle in den <a href="#/einstellungen">Einstellungen</a> unter „Für Bastler“ bei „Das Admin-Menü öffnest du mit“ ein, wie du es öffnest.
              </>
            )}
          </Callout>
        ) : null}
        {box.cardOnly ? (
          <Callout tone="warning" icon={CreditCard}>
            <div class="stack tight">
              <span>Die Box ist mit einer PIN gesperrt, die sich nicht eingeben lässt. Ins Admin-Menü kommst du nur mit der Admin-Karte, darum öffnen die Schritte das Menü mit ihr.</span>
              <div>
                <AdminCardButton />
              </div>
            </div>
          </Callout>
        ) : null}
        {box.board === 'esp32nano' || box.board === 'esp32wroom' ? <p class="small soft">Bei deiner Box mit ESP32 geht das auch auf der Webseite der Box.</p> : null}
      </section>

      <section class="stack" aria-labelledby="ws-set-what">
        {/* Nothing here changes the box by itself: the sentences only show the buttons to press (audit 0.4 #17). */}
        <h2 id="ws-set-what" class="ws-set-title">
          So soll sich deine Box verhalten
        </h2>
        <p class="soft">Wähle in Sätzen, was du ändern willst. Unten steht dann, welche Tasten du an der Box drückst.</p>
        <Saetze
          d={d}
          set={set}
          kontext={{ board: box.board, prof }}
          visible={visible}
          values={box.values}
          keys={keys}
          invert={box.invert}
          headphonesIn={box.headphones}
          reset
          weiter={{
            value: d.weiter,
            jetzt: weiterJetzt,
            onChange: (weiter) => set({ weiter }),
            link:
              d.weiter !== undefined && d.weiter !== weiterJetzt ? (
                <a class="link-button" href="#/werkstatt/firmware">
                  Dafür die Firmware aufspielen
                </a>
              ) : undefined,
          }}
        />
        <HeadphoneLimits prof={prof} access={access} open={box.cardOnly ? 'card' : undefined} buttons={keys} />
      </section>

      <section class="card pad stack" aria-labelledby="ws-set-guide">
        <h2 id="ws-set-guide" class="ws-set-title">
          So geht’s an der Box
        </h2>
        {doneNote.value ? <Callout tone="success">{doneNote.value}</Callout> : null}
        {!anyOn ? (
          <p class="soft">Wähle oben in einem Satz, was du ändern willst. Dann stehen hier die Schritte.</p>
        ) : !result.ok ? (
          <Callout tone="danger" icon={CircleAlert}>
            {result.reason}
          </Callout>
        ) : !result.guide.steps.length ? (
          <Callout tone="success" icon={CircleCheck}>
            Die Box ist schon so eingestellt. Du musst nichts drücken.
          </Callout>
        ) : (
          <>
            <KeyLegend />
            <div class="guide">
              <div class="guide-head">
                <div class="guide-title">
                  <span class="guide-count">{result.guide.steps.length} Schritte</span>
                  <strong>{tng ? 'TonUINO TNG' : 'TonUINO 2.1'}</strong>
                  <span class="soft small">{tng ? 'Die Box bleibt im Admin-Menü, bis du es verlässt.' : 'Die Box verlässt das Admin-Menü nach jeder Einstellung. Darum öffnest du es jedes Mal neu.'}</span>
                </div>
              </div>
              <ol class="guide-steps">
                {result.guide.steps.map((s, i) => (
                  <GuideStep step={s} n={i + 1} key={i} />
                ))}
              </ol>
              {result.guide.notes.length || result.guide.unchanged.length ? (
                <div class="guide-notes">
                  {result.guide.unchanged.length ? (
                    <p>
                      <CircleCheck size={15} /> Stimmt schon und braucht keinen Schritt: {result.guide.unchanged.join(', ')}.
                    </p>
                  ) : null}
                  {result.guide.notes.map((n) => (
                    <p key={n}>
                      <Info size={15} /> {n}
                    </p>
                  ))}
                </div>
              ) : null}
              <p class="guide-help">Verdrückt? Mit der anderen Taste gehst du eine Zahl zurück. Ganz von vorn: die Play/Pause-Taste lang drücken, dann bricht die Box ab. Was schon gespeichert ist, bleibt.</p>
            </div>
            <div class="row wrap">
              <Button variant="primary" icon={CircleCheck} onClick={finish}>
                Erledigt: Die Box ist eingestellt
              </Button>
              <span class="small muted">Dann stehen oben die neuen Werte, bis du die App schließt{wish.lock !== undefined ? '. Die Sperre für die Karten-Anleitungen merk ich mir dauerhaft' : ''}.</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

