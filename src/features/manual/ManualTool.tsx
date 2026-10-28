/**
 * Werkstatt › Bedienkarte: a short manual to print, for the box the app
 * knows. What came from the box says "automatisch erkannt"; the rest is the
 * factory setting and can be switched. The Kurzwahlen are folded away, since
 * the box does not tell them.
 */
import { useState } from 'preact/hooks';
import { CircleCheck, FileDown, Printer } from 'lucide-preact';
import { manualSections, shortcutKeys } from '../../core/tonuino/manual';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { Button, Field, Segmented } from '../../ui/components/controls';
import { toastError, toastSaved } from '../../ui/components/Toast';
import { catalog, plat, profile } from '../../app/state';
import { extras } from '../cards/items';
import { ToolHeader } from '../workshop/common';
import { printDocument, printWay } from '../stickers/print';
import { knownBuild } from '../workshop/boxbuild';
import { logSession } from '../workshop/logsession';
import { manualAbout, manualFacts, manualTitle, type ManualChoice, type ManualFact } from './manualbox';
import '../../ui/styles/manual.css';

const SLOTS = [1, 2, 3, 4] as const;

export function ManualTool() {
  void logSession.revision.value;
  const info = logSession.source.kind === 'live' ? logSession.book.info : undefined;
  const [choice, setChoice] = useState<ManualChoice>({});
  const [shortcuts, setShortcuts] = useState<Partial<Record<1 | 2 | 3 | 4, string>>>({});
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
  const facts = manualFacts({ info, profile: profile.value, build: knownBuild.value, specials: extras.value, choice });
  const box = { ...facts.box, shortcuts };
  const sections = manualSections(box);
  const title = manualTitle(catalog.value?.name);
  const about = manualAbout(box);
  const keys = shortcutKeys(box.profile);
  const folderTitles = Object.values(catalog.value?.folders ?? {}).map((f) => f.title);

  const save = async () => {
    setBusy('pdf');
    try {
      const { manualPdf } = await import('./manualpdf');
      const blob = await manualPdf(sections, { title, about, contact });
      if (await plat().files.save('Bedienkarte.pdf', blob)) toastSaved('Bedienkarte gespeichert', 'Drucke sie aus und schneide sie in der Mitte durch.');
    } catch (e) {
      toastError('Das PDF ließ sich nicht erstellen', e);
    } finally {
      setBusy(null);
    }
  };
  // Printing straight away where the app prints the PDF itself (desktop and Android app, Prüfrunde 1, bastler 25).
  // The browser's print dialog would need the card as a picture; there the PDF stays the way.
  const way = printWay(plat());
  const printing = way === 'pdf' || way === 'system';
  const printNow = async () => {
    setBusy('print');
    try {
      const { manualPdf } = await import('./manualpdf');
      const pdf = () => manualPdf(sections, { title, about, contact });
      await printDocument(plat(), { name: 'Bedienkarte.pdf', page: { widthMm: 297, heightMm: 210 }, pages: 1, pdf, pictures: async () => [] });
    } catch (e) {
      toastError('Drucken hat nicht geklappt', e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="page ws-page">
      <ToolHeader title="Bedienkarte" intro="Eine Karte zum Ausdrucken: was die Tasten kurz und lang machen. Für alle, die die Box geschenkt bekommen." />
      <div class="manual-layout">
        <section class="card pad stack" aria-label="Deine Box">
          <h2 class="ws-set-title">Deine Box</h2>
          <Field label="Firmware" hint={<Detected on={facts.detected.has('profile')} />}>
            <Segmented<FirmwareProfile>
              label="Firmware"
              value={box.profile}
              options={[
                { value: 'tng', label: 'TonUINO TNG' },
                { value: 'classic21', label: 'TonUINO 2.1' },
              ]}
              onChange={(p) => setChoice({ ...choice, profile: p })}
            />
          </Field>
          <Field label="Tasten" hint={<Detected on={facts.detected.has('buttons')} />}>
            <Segmented<3 | 5>
              label="Tasten"
              value={box.buttons}
              options={[
                { value: 3, label: '3 Tasten' },
                { value: 5, label: '5 Tasten' },
              ]}
              onChange={(b) => setChoice({ ...choice, buttons: b })}
            />
          </Field>
          {box.buttons === 3 ? (
            <Field label="Kurz drücken" hint={<Detected on={facts.detected.has('shortPressVolume')} fallback="Wie ab Werk." />}>
              <Segmented<'volume' | 'skip'>
                label="Kurz drücken"
                value={box.shortPressVolume ? 'volume' : 'skip'}
                options={[
                  { value: 'volume', label: 'Lauter und leiser' },
                  { value: 'skip', label: 'Nächster Titel' },
                ]}
                onChange={(v) => setChoice({ ...choice, shortPressVolume: v === 'volume' })}
              />
            </Field>
          ) : null}
          <Known detected={facts.detected} />
          <details class="manual-more">
            <summary>Kurzwahlen eintragen</summary>
            <div class="stack tight">
              <p class="small soft">Die Box verrät ihre Kurzwahlen nicht. Trage ein, was du eingestellt hast. Leer bleibt weg.</p>
              {SLOTS.map((slot) => (
                <Field key={slot} label={slot === 4 ? keys[4] : `${keys[slot]}, wenn nichts läuft`} id={`manual-sc-${slot}`}>
                  <input
                    id={`manual-sc-${slot}`}
                    class="input"
                    list="manual-folders"
                    placeholder="z. B. Schlaflieder"
                    value={shortcuts[slot] ?? ''}
                    onInput={(e) => setShortcuts({ ...shortcuts, [slot]: (e.currentTarget as HTMLInputElement).value })}
                  />
                </Field>
              ))}
              <datalist id="manual-folders">
                {folderTitles.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
          </details>
          <Field label="Fragen an" id="manual-contact" hint="Steht unten auf der Karte. Leer bleibt eine Linie zum Ausfüllen.">
            <input id="manual-contact" class="input" maxLength={100} placeholder="z. B. Onkel Tom, 0170 …" value={contact} onInput={(e) => setContact((e.currentTarget as HTMLInputElement).value)} />
          </Field>
          <div class="row wrap">
            {printing ? (
              <Button variant="primary" icon={Printer} onClick={printNow} loading={busy === 'print'} disabled={!!busy}>
                Drucken
              </Button>
            ) : null}
            <Button variant={printing ? 'default' : 'primary'} icon={FileDown} onClick={save} loading={busy === 'pdf'} disabled={!!busy}>
              Als PDF speichern
            </Button>
          </div>
          <p class="small soft">Zwei Karten auf einem A4-Blatt. In der Mitte durchschneiden: eine für die Box, eine für die Schublade.</p>
        </section>

        <section class="manual-paper" aria-label="Vorschau der Bedienkarte">
          <h2 class="manual-title">{title}</h2>
          <p class="manual-about">{about}</p>
          {sections.map((s) => (
            <div class="manual-section" key={s.title}>
              <h3 class="manual-stamp">{s.title}</h3>
              <dl class="manual-rows">
                {s.rows.map((r) => (
                  <div key={r.what}>
                    <dt>{r.what}</dt>
                    <dd>{r.does}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <p class="manual-contact">
            Fragen? <span>{contact.trim() || ' '}</span>
          </p>
        </section>
      </div>
    </div>
  );
}

function Detected({ on, fallback }: { on: boolean; fallback?: string }) {
  if (on)
    return (
      <span class="manual-detected">
        <CircleCheck size={13} aria-hidden="true" /> automatisch erkannt
      </span>
    );
  return <>{fallback ?? 'Schließe die Box im Box-Logbuch an, dann erkenne ich das.'}</>;
}

const FACT_NAMES: Partial<Record<ManualFact, string>> = {
  standby: 'Ausschalt-Timer',
  pauseWhenCardRemoved: 'Karte abnehmen',
  lock: 'Admin-Sperre',
  headphones: 'Kopfhörer',
  extras: 'Extras der Firmware',
};

/** What else came from the box, in one line. */
function Known({ detected }: { detected: Set<ManualFact> }) {
  const names = (Object.keys(FACT_NAMES) as ManualFact[]).filter((f) => detected.has(f)).map((f) => FACT_NAMES[f]!);
  if (!names.length) return null;
  return (
    <p class="small soft">
      <span class="manual-detected">
        <CircleCheck size={13} aria-hidden="true" /> Auch automatisch erkannt:
      </span>{' '}
      {names.join(', ')}.
    </p>
  );
}
