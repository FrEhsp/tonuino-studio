import { useEffect, useState } from 'preact/hooks';
import { CircleAlert, Copy, FileDown } from 'lucide-preact';
import { phoneAppSteps, readCrashNotice, splitForPhoneApp, unknownNotice } from '../../core/tonuino/androidapp';
import { cardToQrLine, qrGroups } from '../../core/tonuino/card';
import { Button, Callout, Field, Segmented } from '../../ui/components/controls';
import { toast, toastError, toastSaved } from '../../ui/components/Toast';
import { catalog, plat } from '../../app/state';
import { ExternalLink } from '../help/ExternalLink';
import type { CardItem } from './items';
import { linesFor, qrSheetPdf } from './qrsheet';
import { ArcadeCap, CapHandy } from '../../ui/icons/caps';

/** F-Droid has the newest version; Google Play turned down its updates (forum 2151#207). */
const F_DROID = 'https://f-droid.org/packages/de.mw136.tonuino/';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=de.mw136.tonuino';

/** Writing cards with an Android phone and the free app "TonUINO NFC Tools". */
export function QrPanel({ items }: { items: CardItem[] }) {
  const [perCode, setPerCode] = useState<number>(4);
  // Every card goes into the codes; some get a note on what the phone app cannot do with them.
  const { readCrash, unknown } = splitForPhoneApp(items, (i) => i.data);
  // "alle" means as many as fit into a code that is still easy to scan.
  const groups = qrGroups(items, (i) => cardToQrLine(i.data, i.title), perCode >= 99 ? Infinity : perCode);
  const wanted = perCode >= 99 ? 1 : Math.ceil(items.length / perCode);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(linesFor(items).join('\n'));
      toast.success('Liste kopiert', 'Füge sie in der App unter „Liste eingeben“ ein.');
    } catch (e) {
      toastError('Kopieren hat nicht geklappt', e);
    }
  };

  const pdf = async () => {
    try {
      const blob = await qrSheetPdf(groups, { boxName: catalog.value?.name, date: new Date() });
      if (await plat().files.save('TonUINO-Karten-QR.pdf', blob)) toastSaved();
    } catch (e) {
      toastError('Das PDF ließ sich nicht erstellen', e);
    }
  };

  return (
    <div class="stack">
      {readCrash.length ? (
        <Callout tone="warning" icon={CircleAlert}>
          {readCrashNotice(readCrash.map((i) => i.title))}
        </Callout>
      ) : null}
      {unknown.length ? <Callout tone="info">{unknownNotice(unknown.map((i) => i.title))}</Callout> : null}

      <div class="qr-intro">
        <ArcadeCap icon={CapHandy} color="blau" size={36} />
        <div class="stack tight">
          {/* Our own Android app first (audit 0.4 #16): it needs no code to scan. */}
          <p>
            <strong>Hast du TonUINO Studio auf dem Android-Handy?</strong> Dann öffne dort „Karte“. Steckt die SD-Karte der Box in einem SD-Kartenleser am Handy, siehst du dort alle Ordner.
          </p>
          <p class="qr-second-way">
            Ohne TonUINO Studio am Handy geht es mit einem QR-Code. Du brauchst ein Android-Handy mit NFC und die kostenlose App <strong>TonUINO NFC Tools</strong>. Die neueste Version gibt es bei{' '}
            <ExternalLink href={F_DROID}>F-Droid</ExternalLink>, eine ältere bei <ExternalLink href={PLAY_STORE}>Google Play</ExternalLink>. iPhones können
            TonUINO-Karten leider nicht beschreiben.
          </p>
          <ol class="plain-steps">
            {phoneAppSteps(groups.length > 1).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>

      <div class="row wrap" style={{ gap: 16, alignItems: 'flex-end' }}>
        {/* Only a choice with more than one card (Prüfrunde 1, eltern B14). */}
        {items.length > 1 ? (
          <Field label="Karten pro Code">
            <Segmented<number>
              label="Karten pro Code"
              value={perCode}
              options={[
                { value: 1, label: '1' },
                { value: 4, label: '4' },
                { value: 8, label: '8' },
                { value: 99, label: 'alle' },
              ]}
              onChange={setPerCode}
            />
          </Field>
        ) : null}
        <div class="spacer" />
        <Button icon={Copy} onClick={copy}>
          Liste kopieren
        </Button>
        <Button icon={FileDown} onClick={pdf}>
          Als PDF speichern
        </Button>
      </div>

      {groups.length > wanted ? (
        <Callout tone="info">So viele Karten passen nicht gut lesbar in einen Code. Studio verteilt sie deshalb auf {groups.length} Codes.</Callout>
      ) : null}

      <div class="qr-grid">
        {groups.map((g, i) => (
          <QrBlock key={`${perCode}-${i}`} items={g} label={groups.length > 1 ? `Code ${i + 1} von ${groups.length}` : 'Code'} />
        ))}
      </div>
    </div>
  );
}

function QrBlock({ items, label }: { items: CardItem[]; label: string }) {
  /** The code as SVG; null when it could not be made. */
  const [svg, setSvg] = useState<string | null>('');
  const text = linesFor(items).join('\n');
  useEffect(() => {
    let alive = true;
    setSvg('');
    import('qrcode')
      .then((QRCode) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }))
      .then(
        (s) => alive && setSvg(s),
        () => alive && setSvg(null),
      );
    return () => {
      alive = false;
    };
  }, [text]);
  return (
    <figure class="qr-block">
      {svg === null ? (
        <Callout tone="warning">Dieser Code ließ sich nicht erzeugen, die Titel sind zu lang. Wähle weniger Karten pro Code.</Callout>
      ) : (
        <div class="qr-code" role="img" aria-label={`QR-Code mit ${items.length} Karten`} dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <figcaption>
        <span class="section-title">{label}</span>
        <ol>
          {items.map((i) => (
            <li key={i.key}>{i.title}</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}
