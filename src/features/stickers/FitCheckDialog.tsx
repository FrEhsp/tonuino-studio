/**
 * "Sitzt es?" (Frank, 25.10.2026, TODO #128): after the first print of a paper on a printer the app
 * asks once whether the stickers sit on the labels. "Weißer Streifen" with its side and about how wide
 * moves the whole print that far (the printer correction of "Drucker ausrichten", kept per printer);
 * doubled writing or stripes are the printer's own alignment, which only the printer can fix.
 *
 * How the sticker page uses it (a page of its own, so the page can be rebuilt around it):
 *
 *   const [fit, setFit] = useState<FitQuestion | null>(null);
 *   // after printDocument(...) resolved true, for sheets of labels:
 *   setFit(fitQuestionAfterPrint(template.value));
 *   // any time, e.g. a link "Sitzt es nicht?":
 *   setFit(fitQuestion(template.value));
 *   {fit ? <FitCheckDialog question={fit} onClose={() => setFit(null)} onAlign={() => setCalibrating(true)} /> : null}
 *
 * fitQuestionAfterPrint returns null when this printer was asked for this paper already, or the paper
 * is no sheet the app prints on (photo service, single pictures).
 */
import { useState } from 'preact/hooks';
import { Check, Columns2, Ruler } from 'lucide-preact';
import { correctionFor, describeShift, FIT_AMOUNTS, FIT_MAX_MM, fitKey, movesPrint, type FitAnswer } from '../../core/stickers/fitcheck';
import { isIdentityCalibration } from '../../core/stickers/calibration';
import type { LabelTemplate } from '../../core/stickers/templates';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Segmented } from '../../ui/components/controls';
import { toast } from '../../ui/components/Toast';
import { calibrationOf, calibrations, saveCalibration } from './design';
import { activePrinter, ANY_PRINTER, printerLabel } from './printers';

const ASKED_KEY = 'tonuino-studio:sitzt-es';

/** What the dialog asks about: one paper on one printer. */
export interface FitQuestion {
  templateId: string;
  templateName: string;
  /** The printer as the app knows it (printers.ts); ANY_PRINTER where it cannot name it. */
  printer: string;
}

function askedSet(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ASKED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remembers that this printer was asked for this paper; it is not asked again after a print. */
export function markFitAsked(q: Pick<FitQuestion, 'printer' | 'templateId'>): void {
  const s = askedSet();
  s.add(fitKey(q.printer, q.templateId));
  try {
    localStorage.setItem(ASKED_KEY, JSON.stringify([...s]));
  } catch {
    // Asked again next time; no harm.
  }
}

/** Whether this printer was asked for this paper already. */
export function fitAsked(q: Pick<FitQuestion, 'printer' | 'templateId'>): boolean {
  return askedSet().has(fitKey(q.printer, q.templateId));
}

/** Papers the app prints on itself: sheets of labels and paper to cut, not prints ordered from a photo service. */
function printsHere(t: LabelTemplate): boolean {
  return t.output === 'pdf';
}

/** The question for this paper and the printer the stickers went to, whenever the user asks. */
export function fitQuestion(t: LabelTemplate): FitQuestion {
  return { templateId: t.id, templateName: t.name, printer: activePrinter.value };
}

/** The question right after a print: only the first time on this printer and paper. */
export function fitQuestionAfterPrint(t: LabelTemplate): FitQuestion | null {
  if (!printsHere(t)) return null;
  const q = fitQuestion(t);
  return fitAsked(q) ? null : q;
}

type Step = 'ask' | 'shift' | 'quality';

export function FitCheckDialog({ question: q, onClose, onAlign }: { question: FitQuestion; onClose: () => void; onAlign?: () => void }) {
  const [step, setStep] = useState<Step>('ask');
  const [answer, setAnswer] = useState<FitAnswer>({});
  const current = calibrationOf(calibrations.value, q.printer, q.templateId);
  const named = q.printer !== ANY_PRINTER;
  const total = (answer.vertical?.mm ?? 0) + (answer.horizontal?.mm ?? 0);
  const tooFar = total > FIT_MAX_MM;

  const close = () => {
    markFitAsked(q);
    onClose();
  };

  const fits = () => {
    markFitAsked(q);
    toast.success('Schön, dann bleibt alles so', named ? `Gilt für „${printerLabel(q.printer)}“.` : undefined);
    onClose();
  };

  const apply = () => {
    if (!movesPrint(answer)) return;
    // Saved for the printer asked about: the one the stickers went to.
    const before = activePrinter.value;
    activePrinter.value = q.printer;
    saveCalibration(q.templateId, correctionFor(current, answer));
    activePrinter.value = before;
    markFitAsked(q);
    toast.success('Gemerkt', `${describeShift(answer)} Das gilt ab dem nächsten Druck${named ? ` auf „${printerLabel(q.printer)}“` : ''}.`);
    onClose();
  };

  const align = onAlign
    ? () => {
        markFitAsked(q);
        onClose();
        onAlign();
      }
    : undefined;

  if (step === 'quality') {
    return (
      <Dialog
        title="Doppelte Schrift oder Streifen"
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStep('ask')}>
              Zurück
            </Button>
            <Button variant="primary" onClick={close}>
              Verstanden
            </Button>
          </>
        }
      >
        <div class="stack">
          <p>Das kommt vom Drucker, nicht von den Stickern. Sein Druckkopf ist nicht mehr genau ausgerichtet, oder eine Düse ist eingetrocknet.</p>
          <ol class="plain-steps">
            <li>
              Starte am Drucker <b>Ausrichtung</b>. Bei vielen Brother-Druckern: <b>Tinte › Druckqualität verbessern › Ausrichtung</b>.
            </li>
            <li>
              Sind Streifen im Bild, lasse dort auch <b>Druckqualität prüfen</b> laufen.
            </li>
            <li>Danach druckst du die Sticker noch einmal.</li>
          </ol>
          <p class="soft small">Bei anderen Druckern heißt es oft „Druckkopf ausrichten“, im Menü „Wartung“ oder im Programm des Druckers am Computer.</p>
        </div>
      </Dialog>
    );
  }

  if (step === 'shift') {
    const axis = (which: 'vertical' | 'horizontal') => {
      const sides = which === 'vertical' ? (['top', 'bottom'] as const) : (['left', 'right'] as const);
      const names: Record<string, string> = which === 'vertical' ? { top: 'Oben', bottom: 'Unten' } : { left: 'Links', right: 'Rechts' };
      const now = answer[which];
      return (
        <div class="stack tight">
          <Segmented<string>
            label={which === 'vertical' ? 'Weiß oben oder unten' : 'Weiß links oder rechts'}
            value={now?.side ?? 'none'}
            options={[{ value: 'none', label: 'Kein Streifen' }, ...sides.map((s) => ({ value: s, label: names[s] }))]}
            onChange={(v) => setAnswer({ ...answer, [which]: v === 'none' ? undefined : { side: v, mm: now?.mm ?? 1 } })}
          />
          {now ? (
            <div class="row wrap">
              <span class="soft small">Wie breit, in mm?</span>
              <Segmented<number>
                label="Wie breit ist der Streifen, in mm?"
                value={now.mm}
                options={FIT_AMOUNTS.map((mm) => ({ value: mm, label: String(mm).replace('.', ',') }))}
                onChange={(mm) => setAnswer({ ...answer, [which]: { ...now, mm } })}
              />
            </div>
          ) : null}
        </div>
      );
    };
    return (
      <Dialog
        title="Wo ist der weiße Streifen?"
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStep('ask')}>
              Zurück
            </Button>
            <Button variant="primary" icon={Check} disabled={!movesPrint(answer) || tooFar} onClick={apply}>
              Beim nächsten Druck ausgleichen
            </Button>
          </>
        }
      >
        <div class="stack">
          <p class="soft">Lege den Bogen so vor dich, wie er aus dem Drucker kam: bedruckte Seite nach oben, die kleine graue Zeile unten.</p>
          <FitPicture answer={answer} />
          <div class="stack tight">
            <strong>Oben oder unten?</strong>
            {axis('vertical')}
          </div>
          <div class="stack tight">
            <strong>Links oder rechts?</strong>
            {axis('horizontal')}
          </div>
          <p class="soft small">Zum Schätzen: Eine TonUINO-Karte ist knapp 1 mm dick.</p>
          {movesPrint(answer) && !tooFar ? <p>{describeShift(answer)}</p> : null}
          {tooFar ? <p class="callout warning">So viel misst du besser genau nach, mit der Testseite unter „Drucker ausrichten“.</p> : null}
          {align ? (
            <p class="soft small">
              Sitzen manche Sticker richtig und andere nicht, oder unten mehr daneben als oben?{' '}
              <button type="button" class="link-button" onClick={align}>
                Drucker genau ausrichten
              </button>
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Sitzt es?" onClose={close}>
      <div class="stack">
        <p>
          Schaue dir den gedruckten Bogen an. Liegen die Bilder genau auf den Etiketten?
          {named ? <span class="soft">{` Ich merke mir die Antwort für „${printerLabel(q.printer)}“ und „${q.templateName}“.`}</span> : null}
        </p>
        <div class="choices" role="group" aria-label="Sitzt es?">
          <button type="button" class="choice" onClick={fits}>
            <span class="choice-icon" aria-hidden="true">
              <Check size={20} />
            </span>
            <span class="choice-title">Ja, alles sitzt</span>
          </button>
          <button type="button" class="choice" onClick={() => setStep('shift')}>
            <span class="choice-icon" aria-hidden="true">
              <Ruler size={20} />
            </span>
            <span class="choice-title">Weißer Streifen am Rand</span>
            <span class="choice-text">Oben, unten, links oder rechts ist ein Stück Etikett weiß geblieben.</span>
          </button>
          <button type="button" class="choice" onClick={() => setStep('quality')}>
            <span class="choice-icon" aria-hidden="true">
              <Columns2 size={20} />
            </span>
            <span class="choice-title">Schrift doppelt oder Streifen</span>
            <span class="choice-text">Buchstaben wirken verschwommen oder doppelt, oder im Bild sind Linien.</span>
          </button>
        </div>
        {!isIdentityCalibration(current) ? <p class="soft small">Es gibt schon eine Korrektur für diesen Drucker. Was du jetzt sagst, kommt dazu.</p> : null}
      </div>
    </Dialog>
  );
}

/**
 * One label as the user describes it: its outline, the picture moved off it as far as the answer says
 * (a little more, so it shows), white where the strip is. Only a drawing; the sizes are not to scale.
 */
function FitPicture({ answer }: { answer: FitAnswer }) {
  const W = 168;
  const H = 102;
  const k = 4;
  const dy = answer.vertical ? (answer.vertical.side === 'top' ? 1 : -1) * Math.min(answer.vertical.mm, 3) * k : 0;
  const dx = answer.horizontal ? (answer.horizontal.side === 'left' ? 1 : -1) * Math.min(answer.horizontal.mm, 3) * k : 0;
  return (
    <svg class="fit-picture" viewBox={`-8 -8 ${W + 16} ${H + 16}`} width={W + 16} height={H + 16} role="img" aria-label="Ein Etikett mit dem verrutschten Bild">
      <defs>
        <clipPath id="fit-label">
          <rect x="0" y="0" width={W} height={H} rx="8" />
        </clipPath>
      </defs>
      <rect x="0" y="0" width={W} height={H} rx="8" fill="#fff" />
      <g clip-path="url(#fit-label)">
        <rect x={dx} y={dy} width={W} height={H} fill="var(--accent, #6b4ba1)" opacity="0.55" />
        <rect x={dx + 10} y={dy + 10} width={H - 20} height={H - 20} fill="var(--accent, #6b4ba1)" opacity="0.8" />
      </g>
      <rect x="0" y="0" width={W} height={H} rx="8" fill="none" stroke="var(--ink, #222)" stroke-width="2" />
    </svg>
  );
}
