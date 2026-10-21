/**
 * The computer's voice for "Titelansagen", an extra of the settings page:
 * looked for once (the desktop app asks the system, src-tauri speech.rs)
 * and shared by the folder page and "Hinzufügen". What to say when there is
 * none, per system, in one sentence.
 */
import { signal } from '@preact/signals';
import type { Platform, VoiceInfo } from '../../platform/types';
import { platform } from '../../app/state';
import { announcementText } from '../../core/audio/announce';
import { messageOf } from './trackEdit';
import { isMp3 } from './tagWrite';

export type VoiceState =
  /** The browser: it may not let the computer's voice speak into a file. */
  | { kind: 'web' }
  | { kind: 'looking' }
  | { kind: 'none'; text: string }
  | { kind: 'ready'; info: VoiceInfo; note?: string };

/** What a browser shows instead of the voice. */
export const WEB_VOICE_TEXT = 'Titelansagen macht nur die Desktop-App: Der Browser darf die Stimme des Computers nicht in eine Datei sprechen lassen.';

/** One sentence: there is no voice, and what gets one on this system. */
export function noVoiceText(os: Platform['os']): string {
  switch (os) {
    case 'windows':
      return 'Auf diesem Computer ist keine Stimme eingerichtet: Füge unter Einstellungen › Zeit und Sprache › Sprache „Deutsch“ mit Sprachausgabe hinzu und tippe dann auf „Noch einmal suchen“.';
    case 'macos':
      return 'Auf diesem Mac ist keine Stimme eingerichtet: Lade unter Systemeinstellungen › Bedienungshilfen › Gesprochene Inhalte eine deutsche Stimme und tippe dann auf „Noch einmal suchen“.';
    case 'linux':
      return 'Auf diesem Computer ist keine Sprachausgabe installiert: Installiere das Paket „espeak-ng“ (schöner klingt „libttspico-utils“) und tippe dann auf „Noch einmal suchen“.';
    default:
      return 'Auf diesem Computer hab ich keine Stimme gefunden, die Titel vorlesen kann.';
  }
}

/** A voice that is not German reads the titles with the wrong pronunciation. */
export const FOREIGN_VOICE_NOTE = 'Der Computer hat keine deutsche Stimme. Die Titel liest eine Stimme für eine andere Sprache vor, das klingt fremd.';

/** The voice in a few words, for "Es spricht: …". */
export function voiceLabel(info: VoiceInfo): string {
  const engine =
    info.engine === 'sapi' ? 'Windows-Stimme' : info.engine === 'say' ? 'Mac-Stimme' : info.engine === 'pico2wave' ? 'Pico' : info.engine === 'espeak-ng' ? 'eSpeak NG' : info.engine === 'espeak' ? 'eSpeak' : 'Stimme des Computers';
  return info.voice ? `${info.voice} (${engine})` : engine;
}

/** The state of the voice for this platform's answer. */
export function voiceStateOf(info: VoiceInfo, os: Platform['os']): VoiceState {
  if (!info.engine) return { kind: 'none', text: noVoiceText(os) };
  return { kind: 'ready', info, note: info.german ? undefined : FOREIGN_VOICE_NOTE };
}

export const voice = signal<VoiceState | null>(null);
let looking: Promise<void> | null = null;

/** Looks for the voice unless that was done already (`again`: looks once more, after installing one). */
export function lookForVoice(again = false): Promise<void> {
  const p = platform.value;
  const speech = p?.speech;
  if (!p || !speech) {
    voice.value = { kind: 'web' };
    return Promise.resolve();
  }
  if (looking && !again) return looking;
  if (voice.value && voice.value.kind !== 'looking' && !again) return Promise.resolve();
  voice.value = { kind: 'looking' };
  looking = speech.voice(again).then(
    (info) => {
      voice.value = voiceStateOf(info, p.os);
    },
    (e) => {
      voice.value = { kind: 'none', text: `Die Stimme des Computers ließ sich nicht finden. ${messageOf(e)}` };
    },
  );
  return looking;
}

/** What the voice says in front of which file: the MP3s of the folder in their order (other files cannot take an announcement). */
export function announceTargets(rows: readonly { file: string; title: string; number: number }[], withNumber: boolean): { file: string; title: string; text: string }[] {
  return rows.filter((r) => isMp3(r.file)).map((r) => ({ file: r.file, title: r.title, text: announcementText(r.title, withNumber ? r.number : undefined) }));
}
