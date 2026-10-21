/**
 * The computer's own voice (see src-tauri/src/speech.rs): SAPI on Windows,
 * `say` on macOS, pico2wave or espeak on Linux. The backend finds it in
 * fixed places and starts it without a shell; the app installs nothing.
 *
 *   speech_voice, speech_say
 */
import type { SpeechAccess, VoiceInfo } from '../types';
import type { Bridge } from './bridge';
import { toBytes } from './binary';

interface VoiceDto {
  engine: string | null;
  voice?: string | null;
  german: boolean;
}

export class TauriSpeech implements SpeechAccess {
  constructor(private readonly bridge: Bridge) {}

  async voice(refresh = false): Promise<VoiceInfo> {
    const dto = await this.bridge.call<VoiceDto>('speech', 'speech_voice', { refresh });
    return { engine: dto.engine ?? null, ...(dto.voice ? { voice: dto.voice } : {}), german: !!dto.german };
  }

  async say(text: string): Promise<Uint8Array> {
    return toBytes(await this.bridge.call<unknown>('speech', 'speech_say', { text }));
  }
}
