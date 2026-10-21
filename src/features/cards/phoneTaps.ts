/**
 * Starts nfcTap.ts for the Android app with the app's own ways: the words
 * of "Karte prüfen" and a short note with a button to the cards page.
 * main.tsx loads it only on the phone.
 */
import type { NfcAccess } from '../../platform/types';
import { PHONE_READER } from '../../platform/tauri/nfcAndroid';
import { navigate } from '../../app/router';
import { toast } from '../../ui/components/Toast';
import { readCardText } from './ReadCardActions';
import { startNfcTaps } from './nfcTap';

export function startPhoneTaps(nfc: NfcAccess): () => void {
  return startNfcTaps(nfc, PHONE_READER, readCardText, (text) =>
    toast.info('Karte erkannt', text, { label: 'Bei den Karten zeigen', run: () => navigate({ page: 'cards' }) }),
  );
}
