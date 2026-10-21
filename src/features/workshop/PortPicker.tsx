/**
 * Choosing the box's USB port. The desktop app lists every port and finds a
 * newly plugged box by itself; the browser shows only ports the user picked
 * once in its own chooser, so there the main button opens that chooser.
 * When that chooser closes without a box, or the desktop app finds none for
 * a while, a short hint names the usual causes.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CircleCheck, RefreshCw, Usb } from 'lucide-preact';
import { usbFiltersFor, usesCh340, type BoardInfo } from '../../core/firmware/variants';
import type { SerialPortInfo } from '../../platform/types';
import { Button, Callout } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { plat } from '../../app/state';
import { needsChooser, noChooserHint, portDetail, preselectPort, rankPorts, type RankedPort } from './ports';
import { BlockedSiteHint, pickedBefore, rememberPicked, SerialPromptHint } from './SerialPromptHint';
import { EMPTY_PORTS_HINT_MS, boxCandidates, chooserMissHint, nextChooserMiss, type ChooserEvent, type ChooserMiss } from './usbhelp';

/** How often the list is read again while the picker is visible. */
const POLL_MS = 2000;

/** The ports the app can see, read again every few seconds. */
export function usePorts(active = true): { ports: SerialPortInfo[]; refresh: () => Promise<SerialPortInfo[]>; loaded: boolean } {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  const refresh = async () => {
    try {
      const list = await plat().serial.list();
      if (alive.current) {
        setPorts((old) => (sameList(old, list) ? old : list));
        setLoaded(true);
      }
      return list;
    } catch {
      // Listing failed (desktop backend busy): keep what we had and try again later.
      if (alive.current) setLoaded(true);
      return [];
    }
  };
  useEffect(() => {
    alive.current = true;
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [active]);
  return { ports, refresh, loaded };
}

function sameList(a: SerialPortInfo[], b: SerialPortInfo[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.label === b[i].label);
}

export function PortPicker({
  board,
  value,
  onChange,
  onChosen,
  disabled,
}: {
  /** Ranks fitting ports first and narrows the browser's chooser. */
  board?: BoardInfo;
  value: string | undefined;
  onChange: (port: SerialPortInfo | undefined) => void;
  /** After a pick in the browser's chooser, which already says "use this box" (the Box-Logbuch connects then). */
  onChosen?: (port: SerialPortInfo) => void;
  disabled?: boolean;
}) {
  const serial = plat().serial;
  const web = needsChooser(serial);
  const { ports, refresh, loaded } = usePorts(!disabled);
  const ranked: RankedPort[] = useMemo(() => rankPorts(ports, board), [ports, board]);
  const [asking, setAsking] = useState(false);
  const [miss, setMiss] = useState<ChooserMiss>(null);
  const note = (event: ChooserEvent) => setMiss((m) => nextChooserMiss(m, event));

  // A box that gets chosen, by a click or because it is the obvious one, ends the hint.
  const shownValue = useRef(value);
  useEffect(() => {
    if (value && value !== shownValue.current) note({ kind: 'port-chosen' });
    shownValue.current = value;
  }, [value]);

  // Desktop app: no chooser, so the hint comes when no port that may be the box shows up for a while.
  const candidates = boxCandidates(ranked);
  const emptyList = !web && loaded && !disabled && candidates === 0;
  useEffect(() => {
    if (!web) note({ kind: 'ports', count: candidates, desktop: true });
  }, [candidates]);
  useEffect(() => {
    if (!emptyList) return;
    const timer = setTimeout(() => note({ kind: 'empty-for', ms: EMPTY_PORTS_HINT_MS }), EMPTY_PORTS_HINT_MS);
    return () => clearTimeout(timer);
  }, [emptyList]);
  const [picked, setPicked] = useState(pickedBefore);
  const [blocked, setBlocked] = useState(false);

  // Keep the choice while its port is there; otherwise pick the obvious one.
  useEffect(() => {
    if (!loaded || disabled) return;
    const keep = value ? ranked.find((r) => r.port.id === value)?.port : undefined;
    const next = keep ?? preselectPort(ranked, value);
    if (next?.id !== value) onChange(next);
  }, [ranked, loaded, disabled]);

  // Called straight from the click: Firefox shows its chooser only right after one.
  const choose = async (all: boolean) => {
    if (!serial.request) return;
    setAsking(true);
    setBlocked(false);
    const started = Date.now();
    try {
      const filters = all ? [] : board && board.usb.length ? usbFiltersFor(board) : undefined;
      const info = await serial.request(filters);
      // Firefox after "Nie erlauben": no chooser came at all, so a hint about its list would not fit.
      const noChooser = !info && noChooserHint(Date.now() - started, serial.mayAskForAddon);
      setBlocked(noChooser);
      // null: the chooser was closed without a box, often because it listed none.
      if (!noChooser) note({ kind: 'chooser-closed', chosen: !!info, filtered: !!filters?.length });
      if (info) {
        rememberPicked();
        setPicked(true);
        await refresh();
        onChange(info);
        onChosen?.(info);
      }
    } catch (e) {
      toastError('Die Auswahl hat nicht geklappt', e);
    } finally {
      setAsking(false);
    }
  };

  const hint = miss && !disabled ? chooserMissHint({ os: plat().os, filtered: miss.filtered, ch340: usesCh340(undefined, board), desktop: !web, phone: !!plat().mobile }) : null;

  return (
    <div class="stack">
      {ranked.length ? (
        <ul class="ws-ports" role="radiogroup" aria-label="USB-Anschluss der Box">
          {ranked.map((r) => (
            <li key={r.port.id}>
              <button
                type="button"
                role="radio"
                class="ws-port"
                aria-checked={r.port.id === value}
                disabled={disabled}
                onClick={() => {
                  onChange(r.port);
                  note({ kind: 'port-chosen' });
                }}
              >
                <span class="ws-port-dot" aria-hidden="true" />
                <span class="ws-port-text">
                  <span class="ws-port-name">{r.port.label}</span>
                  {portDetail(r.port) ? <span class="ws-port-detail">{portDetail(r.port)}</span> : null}
                </span>
                {r.fits ? (
                  <span class="badge success">
                    <CircleCheck size={13} /> {board ? 'passt' : 'wohl die Box'}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : loaded ? (
        <p class="soft">
          {web
            ? 'Noch keine Box ausgewählt. Stecke die Box per USB-Kabel ein und klicke auf „Box verbinden“.'
            : 'Keine Box gefunden. Stecke die Box per USB-Kabel ein, sie erscheint hier von selbst.'}
        </p>
      ) : (
        <p class="soft">Suche nach Anschlüssen …</p>
      )}
      <div class="row wrap">
        {web ? (
          <>
            <Button icon={Usb} variant={ranked.length ? 'default' : 'primary'} loading={asking} disabled={disabled} onClick={() => choose(false)}>
              {ranked.length ? 'Andere Box verbinden …' : 'Box verbinden …'}
            </Button>
            <button type="button" class={hint?.showAll ? 'link-button ws-show-all' : 'link-button'} disabled={disabled || asking} onClick={() => choose(true)}>
              Alle USB-Geräte zeigen
            </button>
          </>
        ) : (
          <Button icon={RefreshCw} variant="ghost" size="sm" disabled={disabled} onClick={() => void refresh()}>
            Aktualisieren
          </Button>
        )}
        {hint ? null : (
          <a class="small" href="#/werkstatt/usb">
            Box wird nicht erkannt?
          </a>
        )}
      </div>
      <div aria-live="polite">
        {hint ? (
          <Callout tone="neutral">
            <div class="stack tight ws-miss">
              <b>{hint.title}</b>
              {hint.lines.map((line) => (
                <span key={line}>{line}</span>
              ))}
              <a href={hint.more.href}>{hint.more.label}</a>
            </div>
          </Callout>
        ) : null}
      </div>
      {/* Only where the browser first asks about an add-on (Firefox): Chrome and Edge just show their chooser. */}
      {web && serial.mayAskForAddon && !picked && !ranked.length ? <SerialPromptHint /> : null}
      {web && blocked ? <BlockedSiteHint /> : null}
    </div>
  );
}
