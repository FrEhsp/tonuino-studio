import { useState } from 'preact/hooks';
import { Nfc } from 'lucide-preact';
import { Button, EmptyState } from '../ui/components/controls';
import { SdCardArt } from '../ui/components/Art';
import { AndroidAppLink, DesktopAppLink } from '../features/help/DesktopAppLink';
import { abilitiesOf, handheldLead } from '../platform/web/abilities';
import { navigate, type Route } from './router';
import type { Platform } from '../platform/types';
import { handheldWord } from './device';
import { platform } from './state';

const KEY = 'tonuino-studio:handheld-look-around';

function lookedAround(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * On a phone or tablet: shows "Bitte am Computer öffnen" until the person
 * chooses to look around anyway (for this visit). Returns true while the
 * notice is shown instead of the app.
 */
export function useHandheldNotice(handheld: boolean): { show: boolean; lookAround: () => void } {
  const [ok, setOk] = useState(lookedAround);
  const lookAround = () => {
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      // Not remembered: the notice comes back on the next visit.
    }
    setOk(true);
  };
  return { show: handheld && !ok, lookAround };
}

/**
 * The whole screen in the browser of a phone or tablet: the web app needs a
 * computer, an Android phone has the app. Says honestly why (TODO #122,
 * abilities.ts): no browser there reaches the card, the box or NFC cards.
 */
export function HandheldNotice({ onLookAround }: { onLookAround: () => void }) {
  const address = typeof location !== 'undefined' ? `${location.host}${location.pathname === '/' ? '' : location.pathname}` : '';
  // There is an Android app (the help says so), none for the iPhone and iPad.
  const p = platform.value;
  const apple = !!p && abilitiesOf(p).device === 'apple';
  return (
    <main class="main handheld-notice">
      <div class="page narrow">
        <EmptyState
          art={<SdCardArt size={140} />}
          title="Bitte am Computer öffnen"
          actions={
            <>
              <Button
                onClick={() => {
                  onLookAround();
                  navigate({ page: 'help', topic: 'browser' });
                }}
              >
                Hilfe lesen
              </Button>
              <Button variant="ghost" onClick={onLookAround}>
                Trotzdem ansehen
              </Button>
            </>
          }
        >
          {handheldLead(apple ? 'apple' : 'android')} {apple ? null : <AndroidAppLink />}
          <br />
          Am Computer öffnest du {address ? <b>{address}</b> : 'diese Seite'} in Firefox, Chrome, Edge oder Safari. Am meisten geht in Chrome und Edge, oder mit der Desktop-App für Windows und Linux. <DesktopAppLink />
        </EmptyState>
        <p class="center soft small">Schaust du dich hier trotzdem um, kannst du keine SD-Karte auswählen. Die Hilfe und der Lötplan gehen auch hier.</p>
      </div>
    </main>
  );
}

/**
 * Pages of the Android app that may need a computer (the SD card). The
 * Werkstatt is not one: Lötplan, Bedienkarte, „Box einstellen“ and the
 * announcements need no USB, so its board shows and only the tools that
 * talk to the box say „nur am Computer“ (audit 0.4 #28).
 */
export type ComputerOnlyPage = Extract<Route['page'], 'musik' | 'box' | 'folder' | 'add' | 'sticker' | 'stickers'>;

const COMPUTER_ONLY: Record<ComputerOnlyPage, { title: string; text: string }> = {
  musik: { title: 'Im Browser am Handy geht die SD-Karte nicht', text: 'Musik und Hörspiele bringst du am Computer auf die SD-Karte, mit der Desktop-App oder im Browser. Am Android-Handy geht es mit der Android-App und einem SD-Kartenleser.' },
  sticker: { title: 'Sticker gehen nur am Computer', text: 'Sticker gestaltest und druckst du am Computer, mit der Desktop-App oder im Browser.' },
  box: { title: 'Im Browser am Handy geht die SD-Karte nicht', text: 'Musik und Hörspiele bringst du am Computer auf die SD-Karte, mit der Desktop-App oder im Browser. Am Android-Handy geht es mit der Android-App und einem SD-Kartenleser.' },
  folder: { title: 'Im Browser am Handy geht die SD-Karte nicht', text: 'Musik und Hörspiele bringst du am Computer auf die SD-Karte, mit der Desktop-App oder im Browser. Am Android-Handy geht es mit der Android-App und einem SD-Kartenleser.' },
  add: { title: 'Hinzufügen geht nur am Computer', text: 'Neue Musik und Hörspiele kommen am Computer auf die SD-Karte, mit der Desktop-App oder im Browser.' },
  stickers: { title: 'Sticker gehen nur am Computer', text: 'Sticker gestaltest und druckst du am Computer, mit der Desktop-App oder im Browser.' },
};

export function isComputerOnly(page: Route['page']): page is ComputerOnlyPage {
  return Object.prototype.hasOwnProperty.call(COMPUTER_ONLY, page);
}

/**
 * Whether this page needs a computer in this Android app. With the bridges
 * of the APK the phone opens the SD card in a card reader (or a folder),
 * prints and saves the stickers, and talks to the box over the USB cable;
 * an APK without them (or a phone that refuses them) keeps the notice.
 */
export function needsComputer(page: ComputerOnlyPage, p: Pick<Platform, 'mobile' | 'capabilities' | 'printPdf'> | null | undefined): boolean {
  if (!p?.mobile) return false;
  switch (page) {
    case 'musik':
    case 'box':
    case 'folder':
    case 'add':
      return !p.capabilities.sd;
    case 'sticker':
    case 'stickers':
      return !p.printPdf;
  }
}

/** The Android app on a page that needs a computer: says so and leads to the cards. */
export function ComputerOnly({ page }: { page: ComputerOnlyPage }) {
  const c = COMPUTER_ONLY[page];
  return (
    <div class="page narrow">
      <EmptyState
        art={<SdCardArt />}
        title={c.title}
        actions={
          <Button variant="primary" icon={Nfc} onClick={() => navigate({ page: 'karte' })}>
            Karte beschreiben
          </Button>
        }
      >
        {c.text} Auf dem {handheldWord()} beschreibst du die Karten für die Box.
      </EmptyState>
    </div>
  );
}
