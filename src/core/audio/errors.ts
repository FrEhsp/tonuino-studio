/**
 * Errors of the audio core. `message` is German, user facing and says what
 * happened and what to do next; `code` is for the program.
 */

export type AudioErrorCode =
  | 'not-mp3'
  | 'free-format'
  | 'unsupported-layer'
  | 'mixed-format'
  | 'unsupported-format'
  | 'too-long'
  | 'too-big'
  | 'decode-failed'
  | 'read-failed'
  | 'no-audio'
  | 'drm-protected'
  | 'worker-failed';

const MESSAGES: Record<AudioErrorCode, string> = {
  'not-mp3':
    'In dieser Datei ist kein abspielbarer MP3-Ton. Vermutlich ist sie beschädigt oder gar keine MP3-Datei. Nimm eine andere Kopie der Datei oder wandle sie zuerst in MP3 um.',
  'free-format':
    'Diese MP3-Datei ist in einer seltenen Sonderform gespeichert, die wir nicht direkt bearbeiten können. Wandle sie neu in MP3 um, dann klappt es.',
  'unsupported-layer':
    'Diese Datei ist eine ältere Variante (MP1 oder MP2) und keine richtige MP3. Wandle sie zuerst in MP3 um.',
  'mixed-format':
    'Diese MP3-Datei wechselt mittendrin ihr Format (zum Beispiel von Mono zu Stereo), meist weil sie aus mehreren Dateien zusammengefügt wurde. So können wir sie nicht direkt bearbeiten. Wandle sie neu in MP3 um, dann klappt es.',
  'unsupported-format':
    'Dieses Dateiformat kann der Browser nicht öffnen. Wandle die Datei mit einem anderen Programm in MP3 um oder nutze die Desktop-App.',
  'too-long':
    'Diese Datei ist zu lang, um sie im Browser zu öffnen (über 45 Minuten). Nutze die Desktop-App oder wandle die Datei vorher in MP3 um.',
  'too-big':
    'Diese Datei ist zu groß, um sie im Browser zu öffnen (über 1\u00a0GB). Ist es ein Video, speichere zuerst nur seinen Ton als eigene Datei, zum Beispiel als M4A. Oder nutze die Desktop-App.',
  'decode-failed':
    'Die Datei ließ sich nicht abspielen. Vielleicht ist sie beschädigt. Versuche es mit einer anderen Kopie der Datei.',
  'read-failed':
    'Die Datei konnte nicht gelesen werden. Prüfe, ob sie noch da ist, und versuche es noch einmal.',
  'no-audio': 'In dieser Datei ist kein Ton. Wähle eine andere Datei.',
  'drm-protected':
    'Diese Datei ist kopiergeschützt (zum Beispiel von Audible oder iTunes). Solche Dateien können wir nicht öffnen. Nimm eine Datei ohne Kopierschutz.',
  'worker-failed':
    'Die Tonbearbeitung im Hintergrund ist abgestürzt. Lade die Seite neu und versuche es noch einmal.',
};

/** The same, for files the desktop app cannot open either: it is no way out for them. */
const NOT_ON_DESKTOP: Partial<Record<AudioErrorCode, string>> = {
  'unsupported-format': 'Dieses Dateiformat kann der Browser nicht öffnen. Wandle die Datei mit einem anderen Programm in MP3 um.',
  'too-long':
    'Diese Datei ist zu lang, um sie im Browser zu öffnen (über 45 Minuten). Wandle die Datei vorher mit einem anderen Programm in MP3 um.',
  'too-big':
    'Diese Datei ist zu groß, um sie im Browser zu öffnen (über 1\u00a0GB). Ist es ein Video, speichere zuerst nur seinen Ton als eigene Datei, zum Beispiel als M4A. Oder wandle die Datei mit einem anderen Programm in MP3 um.',
};

/** Containers and codecs (as the demuxers name them) the desktop app reads. */
const DESKTOP_CONTAINERS = ['mp3', 'wav', 'aiff', 'mp4', 'aac', 'flac', 'ogg'];
const DESKTOP_CODECS = ['mp3', 'aac', 'alac', 'flac', 'vorbis', 'pcm', 'pcm-float'];

/** Extra facts for the caller, e.g. whether another decoder may still open the file. */
export interface AudioErrorDetails {
  /** The browser's own decoder (AudioContext) may still open the file. */
  fallback?: boolean;
  /** Playing time, when the container told it. */
  durationSec?: number;
  container?: string;
  codec?: string;
}

/** False when the details show a file the desktop app cannot open either (WebM, WMA, Opus, AC-3, …). */
function desktopOpens(details: AudioErrorDetails | undefined): boolean {
  if (!details?.container) return true;
  const codec = details.codec?.toLowerCase();
  return DESKTOP_CONTAINERS.includes(details.container) && (codec === undefined || DESKTOP_CODECS.includes(codec));
}

export class AudioError extends Error {
  readonly code: AudioErrorCode;
  readonly details?: AudioErrorDetails;

  constructor(code: AudioErrorCode, message?: string, options?: { cause?: unknown; details?: AudioErrorDetails }) {
    super(message ?? audioErrorMessage(code, options?.details), options);
    this.name = 'AudioError';
    this.code = code;
    this.details = options?.details;
  }
}

/** The German user message for an error code, about the file the details describe. */
export function audioErrorMessage(code: AudioErrorCode, details?: AudioErrorDetails): string {
  return (!desktopOpens(details) && NOT_ON_DESKTOP[code]) || MESSAGES[code];
}

/** Plain object form of an error, for postMessage between worker and page. */
export interface SerializedError {
  name: string;
  message: string;
  code?: AudioErrorCode;
  details?: AudioErrorDetails;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof AudioError) return { name: 'AudioError', message: err.message, code: err.code, details: err.details };
  if (isAbortError(err)) return { name: 'AbortError', message: 'Abgebrochen.' };
  return { name: 'Error', message: err instanceof Error ? err.message : String(err) };
}

export function deserializeError(s: SerializedError): Error {
  if (s.name === 'AbortError') return new DOMException(s.message, 'AbortError');
  if (s.code && isAudioErrorCode(s.code)) return new AudioError(s.code, s.message, { details: s.details });
  return new AudioError('decode-failed', undefined, { cause: new Error(s.message) });
}

export function isAudioErrorCode(code: unknown): code is AudioErrorCode {
  return typeof code === 'string' && code in MESSAGES;
}

/** Throws the signal's reason (an AbortError) when the signal is aborted. */
export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Abgebrochen.', 'AbortError');
  }
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Waits for `promise`, but rejects with the signal's reason as soon as the signal is aborted. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Abgebrochen.', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
