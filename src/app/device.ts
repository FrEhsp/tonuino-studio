/**
 * Where the box and its SD card are plugged in, in the words of a sentence:
 * the computer, or the phone in the Android app (Platform.mobile). The
 * workshop and "Meine Box" tell people where to plug things in; on the
 * phone "an den Computer" would send them away from the device in hand.
 */
import { platform } from './state';

function phone(): boolean {
  return !!platform.value?.mobile;
}

/**
 * „Handy“ or „Tablet“ for the device the Android app runs on: a tablet was
 * called „Handy“ (audit 0.4 #29). A tablet as Android counts them, its
 * shorter side at least 600 px (sw600dp).
 */
export function handheldWord(): 'Handy' | 'Tablet' {
  try {
    return typeof screen !== 'undefined' && Math.min(screen.width, screen.height) >= 600 ? 'Tablet' : 'Handy';
  } catch {
    return 'Handy';
  }
}

/** "der Computer" / "das Handy", as the subject of a sentence. */
export function theDevice(): string {
  return phone() ? `das ${handheldWord()}` : 'der Computer';
}

/** "an den Computer" / "ans Handy": where the box's USB cable goes. */
export function toDevice(): string {
  return phone() ? `ans ${handheldWord()}` : 'an den Computer';
}

/** "in den Computer" / "in einen SD-Kartenleser am Handy": where the SD card goes. */
export function cardIntoDevice(): string {
  return phone() ? `in einen SD-Kartenleser am ${handheldWord()}` : 'in den Computer';
}
