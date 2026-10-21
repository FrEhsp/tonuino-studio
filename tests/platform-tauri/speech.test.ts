/** The desktop bridge to the computer's voice (src-tauri/src/speech.rs), against a fake IPC. */
import { describe, expect, it } from 'vitest';
import { createTauriPlatform } from '../../src/platform/tauri';
import { messageFor, TauriPlatformError } from '../../src/platform/tauri/errors';
import { TauriSpeech } from '../../src/platform/tauri/speech';
import { FakeIpc, fakeBridge } from './fake-ipc';

describe('TauriSpeech', () => {
  it('reports the voice without empty fields, and looks again on request', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('speech_voice', (args) => ((args as { refresh: boolean }).refresh ? { engine: 'espeak-ng', voice: null, german: true } : { engine: null, voice: null, german: false }));
    const speech = new TauriSpeech(bridge);
    expect(await speech.voice()).toEqual({ engine: null, german: false });
    expect(await speech.voice(true)).toEqual({ engine: 'espeak-ng', german: true });
    expect(ipc.calls.map((c) => c.args)).toEqual([{ refresh: false }, { refresh: true }]);
  });

  it('hands the text over as it is and gets the WAV back as bytes', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('speech_say', () => new Uint8Array([82, 73, 70, 70]).buffer);
    const wav = await new TauriSpeech(bridge).say('Titel 1. Der "Hund"; rm -rf');
    expect([...wav]).toEqual([82, 73, 70, 70]);
    expect(ipc.calls[0].args).toEqual({ text: 'Titel 1. Der "Hund"; rm -rf' });
  });

  it('says in words when there is no voice', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('speech_say', () => {
      throw { code: 'no-voice', detail: 'no voice found' };
    });
    const e = await new TauriSpeech(bridge).say('Hallo').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TauriPlatformError);
    expect((e as TauriPlatformError).message).toBe(messageFor('no-voice', 'speech'));
  });

  it('is part of the desktop platform', () => {
    expect(createTauriPlatform({ ipc: new FakeIpc(), os: 'windows' }).speech).toBeInstanceOf(TauriSpeech);
  });
});
