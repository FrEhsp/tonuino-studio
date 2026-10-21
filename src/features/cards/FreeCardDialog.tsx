/**
 * "Karte frei zusammenstellen" and "Karte ändern": a card for any folder
 * number 1 to 99, also without the SD card (the box at grandma's), a special
 * card with any number of minutes, and folded away "Zahlen und Bytes" for
 * tinkerers: the five numbers and the bytes as in TonUINO NFC Tools. The card
 * goes on the list of cards to write, selected, like every other card.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Copy } from 'lucide-preact';
import { ADMIN_MODE, type FirmwareProfile } from '../../core/tonuino/card';
import {
  RAW_FIELDS,
  RAW_LABELS,
  cardBytesText,
  folderNumberOf,
  parseCardHex,
  rawCardProblems,
  rawTextsValid,
  rawValue,
  sleepMinutesProblem,
  storedCard,
  type FullCard,
  type RawField,
} from '../../core/tonuino/cardedit';
import { DANCE_PAUSES, describeCard, modeByCode, modifiersFor, sleepMaxMinutes, sleepMinutesOf } from '../../core/tonuino/modes';
import { folderName, MAX_FOLDER } from '../../core/tonuino/sd';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Field, Segmented, Switch } from '../../ui/components/controls';
import { toast, toastError } from '../../ui/components/Toast';
import { boxScan, catalog, profile, settings } from '../../app/state';
import { addExtraCard, cardItems, extraLabel, isSelected, sameCard, setSelected, trackCounts } from './items';
import { format20 } from './format20';
import { ModePicker } from './ModePicker';
import '../../ui/styles/freecard.css';

type Kind = 'folder' | 'special';

/** A new card for this kind: folder 1 as Hörbuch, or a Schlummerkarte of 15 minutes. */
function startCard(kind: Kind, folder = 1): FullCard {
  return kind === 'folder' ? { version: 2, folder, mode: 5, special: 0, special2: 0 } : { version: 2, folder: 0, mode: 1, special: 15, special2: 0 };
}

export interface FreeCardDialogProps {
  onClose: () => void;
  /** A card read from the reader: the dialog changes it. */
  start?: FullCard;
  /** Open "Zahlen und Bytes" from the start. */
  bytes?: boolean;
}

export function FreeCardDialog({ onClose, start, bytes }: FreeCardDialogProps) {
  const prof = profile.value;
  const [card, setCard] = useState<FullCard>(start ?? { ...startCard('folder'), version: format20.peek() ? 1 : 2 });
  const [busy, setBusy] = useState(false);
  const kind: Kind = card.folder === 0 ? 'special' : 'folder';
  const problems = rawCardProblems(card, prof);
  const sleepProblem = kind === 'special' && modifiersFor(prof).some((m) => m.code === card.mode && m.params === 'sleep') ? sleepMinutesProblem(sleepMinutesOf(card, prof), prof) : undefined;
  // Fields that hold something the card cannot take: the card is still the last good one, so it must not go on the list.
  const [wrong, setWrong] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback((field: string, bad: boolean) => {
    setWrong((w) => {
      if (w.has(field) === bad) return w;
      const next = new Set(w);
      if (bad) next.add(field);
      else next.delete(field);
      return next;
    });
  }, []);
  const blocked = !!sleepProblem || wrong.size > 0;

  const add = async () => {
    setBusy(true);
    try {
      await addToList(card, prof, start ? 'Lege die Karte auf und schreibe sie neu, oder nimm eine leere.' : 'Sie ist ausgewählt. Schreibe sie wie die anderen Karten.');
      onClose();
    } catch (e) {
      toastError('Die Karte ließ sich nicht hinzufügen', e);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={start ? 'Karte ändern' : 'Karte frei zusammenstellen'}
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={add} loading={busy} disabled={blocked}>
            In die Liste
          </Button>
        </>
      }
    >
      <div class="stack">
        <Segmented<Kind>
          label="Art der Karte"
          value={kind}
          options={[
            { value: 'folder', label: 'Für einen Ordner' },
            { value: 'special', label: 'Spezialkarte' },
          ]}
          onChange={(k) => k !== kind && setCard({ ...startCard(k), version: card.version })}
        />
        {kind === 'folder' ? <FolderPart card={card} prof={prof} onChange={setCard} report={report} /> : <SpecialPart card={card} prof={prof} onChange={setCard} problem={sleepProblem} />}
        <p class="free-card-says small">
          <b>So liest die Box die Karte:</b> {wrong.size ? 'Das steht hier, sobald alle Eingaben stimmen.' : cardSays(card, prof)}
        </p>
        {problems.length ? (
          <Callout tone="warning">
            {problems.map((p) => (
              <span class="block" key={p}>
                {p}
              </span>
            ))}
          </Callout>
        ) : null}
        <RawPart card={card} onChange={setCard} open={bytes} report={report} />
      </div>
    </Dialog>
  );
}

/**
 * Puts the card on the list of cards to write, selected. A card the list has
 * already (a folder's own card, too) is selected instead of added twice.
 */
export async function addToList(card: FullCard, prof: FirmwareProfile, next: string): Promise<void> {
  const data = storedCard(card);
  const listed = cardItems.value.find((i) => sameCard(i.data, data));
  if (listed) {
    if (!isSelected(listed)) setSelected(listed, true);
    toast.success('Diese Karte steht schon in der Liste', `„${listed.title}“ ist jetzt ausgewählt.`);
    return;
  }
  await addExtraCard(data, extraLabel(data, prof));
  toast.success('Die Karte steht jetzt in der Liste', next);
}

export function cardSays(card: FullCard, prof: FirmwareProfile): string {
  const text = describeCard(card, prof);
  return card.version === 1 ? `${text} Im Kartenformat für TonUINO 2.0.` : text;
}

/* ---------------------------------------------------------------- folder */

/** Tells the dialog that a field holds something the card cannot take (`bad`), or no longer. */
type Report = (field: string, bad: boolean) => void;

/** Reports `bad` while the part is shown, and nothing once it is gone. */
function useReport(report: Report, field: string, bad: boolean) {
  useEffect(() => report(field, bad), [bad]);
  useEffect(() => () => report(field, false), []);
}

function FolderPart({ card, prof, onChange, report }: { card: FullCard; prof: FirmwareProfile; onChange: (c: FullCard) => void; report: Report }) {
  const [text, setText] = useState(String(card.folder));
  // Changed under "Zahlen und Bytes": show the new number.
  useEffect(() => {
    if (Number(text) !== card.folder) setText(String(card.folder));
  }, [card.folder]);
  const scan = boxScan.value;
  const counts = trackCounts(scan);
  const known = counts.get(card.folder);
  const title = catalog.value?.folders[folderName(card.folder)]?.title;
  const valid = folderNumberOf(text) !== undefined;
  useReport(report, 'folder', !valid);
  let hint: string;
  if (!valid) hint = `Gib eine Zahl von 1 bis ${MAX_FOLDER} ein.`;
  else if (title) hint = `Auf der SD-Karte: „${title}“${known !== undefined ? `, ${known} Titel` : ''}.`;
  else if (scan) hint = known === undefined ? 'Diesen Ordner gibt es auf der SD-Karte nicht. Für eine andere Box geht das trotzdem.' : `${known} Titel auf der SD-Karte.`;
  else hint = 'Ohne SD-Karte prüfe ich nicht, ob es den Ordner gibt.';
  return (
    <div class="stack">
      <Field label="Ordner" id="free-folder" hint={hint}>
        <input
          id="free-folder"
          class="input"
          style={{ width: 120 }}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_FOLDER}
          value={text}
          aria-invalid={valid ? undefined : true}
          onInput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            setText(v);
            const n = folderNumberOf(v);
            if (n !== undefined) onChange({ ...card, folder: n });
          }}
        />
      </Field>
      {modeByCode(card.mode) ? (
        <ModePicker
          profile={prof}
          value={{ mode: card.mode, special: card.special, special2: card.special2 }}
          onChange={(v) => onChange({ ...card, mode: v.mode, special: v.special ?? 0, special2: v.special2 ?? 0 })}
          trackCount={known ?? 255}
          folder={card.folder}
          advanced={settings.value.advancedModes}
        />
      ) : (
        <p class="soft small">Modus {card.mode} kenne ich nicht. Unter „Zahlen und Bytes“ kannst du ihn ändern.</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- special */

interface SpecialOption {
  id: string;
  name: string;
  build: () => FullCard;
  matches: (c: FullCard) => boolean;
}

function specialOptions(prof: FirmwareProfile, version: number): SpecialOption[] {
  const mods: SpecialOption[] = modifiersFor(prof).map((m) => ({
    id: `m${m.code}`,
    name: m.name,
    build: () => ({ version, folder: 0, mode: m.code, special: m.params === 'sleep' ? 15 : 0, special2: 0 }),
    matches: (c) => c.folder === 0 && c.mode === m.code,
  }));
  return [
    ...mods,
    { id: 'admin', name: 'Admin-Karte', build: () => ({ version, folder: 0, mode: ADMIN_MODE, special: 0, special2: 0 }), matches: (c) => c.folder === 0 && c.mode === ADMIN_MODE },
  ];
}

function SpecialPart({ card, prof, onChange, problem }: { card: FullCard; prof: FirmwareProfile; onChange: (c: FullCard) => void; problem?: string }) {
  const options = specialOptions(prof, card.version);
  const picked = options.find((o) => o.matches(card));
  const mod = modifiersFor(prof).find((m) => card.folder === 0 && m.code === card.mode);
  const tng = prof === 'tng';
  const minutes = sleepMinutesOf(card, prof);
  const atEnd = tng && (card.special & 0x80) !== 0;
  const [text, setText] = useState(String(minutes));
  useEffect(() => {
    if (Number(text) !== minutes) setText(String(minutes));
  }, [minutes]);
  const max = sleepMaxMinutes(prof);
  return (
    <div class="stack">
      <Field label="Welche Spezialkarte?" id="free-special">
        <select
          id="free-special"
          class="select"
          style={{ maxWidth: 360 }}
          value={picked?.id ?? ''}
          onChange={(e) => {
            const o = options.find((x) => x.id === (e.currentTarget as HTMLSelectElement).value);
            if (o) {
              const next = o.build();
              setText(String(next.special & 0x7f));
              onChange(next);
            }
          }}
        >
          {picked ? null : <option value="">Spezialkarte {card.mode} (unbekannt)</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </Field>
      {mod?.params === 'sleep' ? (
        <div class="stack tight">
          <Field label={tng ? 'Ausschalten nach Minuten' : 'Anhalten nach Minuten'} id="free-minutes" hint={problem ?? `Jede Zahl von 1 bis ${max}.`}>
            <input
              id="free-minutes"
              class="input"
              style={{ width: 120 }}
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              value={text}
              aria-invalid={problem ? true : undefined}
              onInput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                setText(v);
                const n = /^\d{1,3}$/.test(v.trim()) ? Number(v) : 0;
                const m = Math.min(n, max);
                onChange({ ...card, special: tng ? (m & 0x7f) | (atEnd ? 0x80 : 0) : m });
              }}
            />
          </Field>
          {tng ? <Switch checked={atEnd} onChange={(on) => onChange({ ...card, special: (card.special & 0x7f) | (on ? 0x80 : 0) })} label="Erst am Ende des Titels ausschalten" /> : null}
        </div>
      ) : null}
      {mod?.params === 'dancePause' && tng ? (
        <Field label="Musik zwischen den Pausen" id="free-dance">
          <Segmented<number> label="Pausenlänge" value={card.special} options={DANCE_PAUSES.map((p, i) => ({ value: i, label: p }))} onChange={(special) => onChange({ ...card, special })} />
        </Field>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- numbers and bytes */

/** Folded away: the five numbers and the bytes, as TonUINO NFC Tools shows them. */
function RawPart({ card, onChange, open, report }: { card: FullCard; onChange: (c: FullCard) => void; open?: boolean; report: Report }) {
  // Only fields typed wrong keep their text, so it can be put right; the others show the card.
  const [texts, setTexts] = useState<Partial<Record<RawField, string>>>({});
  const [hex, setHex] = useState<string | null>(null);
  const shown = Object.fromEntries(RAW_FIELDS.map((f) => [f, texts[f] ?? String(card[f])])) as Record<RawField, string>;
  const parsed = hex !== null ? parseCardHex(hex) : undefined;
  useReport(report, 'numbers', !rawTextsValid(shown));
  useReport(report, 'bytes', !!parsed && !parsed.ok);
  const box = useRef<HTMLDetailsElement>(null);
  // Opened through "Zahlen und Bytes …": the fields are what was asked for, not the part above them.
  useEffect(() => {
    if (open) box.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cardBytesText(card).replaceAll(' ', ''));
      toast.success('Kopiert', 'Die Bytes der Karte sind in der Zwischenablage.');
    } catch (e) {
      toastError('Kopieren ging nicht', e);
    }
  };
  return (
    <details class="free-card-raw" open={open} ref={box}>
      <summary>Zahlen und Bytes</summary>
      <div class="stack">
        <p class="small soft">Für Bastler, wie in TonUINO NFC Tools. Falsche Werte versteht die Box nicht.</p>
        <div class="free-card-fields">
          {RAW_FIELDS.map((f) => {
            const bad = rawValue(shown[f]) === undefined;
            return (
              <Field label={RAW_LABELS[f]} id={`free-raw-${f}`} key={f}>
                <input
                  id={`free-raw-${f}`}
                  class="input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={255}
                  value={shown[f]}
                  aria-invalid={bad ? true : undefined}
                  onInput={(e) => {
                    const v = (e.currentTarget as HTMLInputElement).value;
                    const rest = { ...texts };
                    delete rest[f];
                    setHex(null);
                    const n = rawValue(v);
                    setTexts(n === undefined ? { ...rest, [f]: v } : rest);
                    if (n !== undefined) onChange({ ...card, [f]: n });
                  }}
                />
              </Field>
            );
          })}
        </div>
        <Field label="Bytes der Karte (hex)" id="free-raw-hex" hint={parsed && !parsed.ok ? parsed.message : 'Kennung, Version, Ordner, Modus, Extra 1, Extra 2, dann Nullen.'}>
          <div class="row tight">
            <input
              id="free-raw-hex"
              class="input mono grow"
              spellcheck={false}
              autocomplete="off"
              value={hex ?? cardBytesText(card)}
              aria-invalid={parsed && !parsed.ok ? true : undefined}
              onInput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                setHex(v);
                setTexts({});
                const p = parseCardHex(v);
                if (p.ok) onChange(p.card);
              }}
              onBlur={() => parsed?.ok && setHex(null)}
            />
            <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>
              Kopieren
            </Button>
          </div>
        </Field>
      </div>
    </details>
  );
}

