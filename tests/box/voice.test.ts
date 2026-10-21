import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../src/app/state';
import type { Platform, VoiceInfo } from '../../src/platform/types';
import { announceTargets, FOREIGN_VOICE_NOTE, lookForVoice, noVoiceText, voice, voiceLabel, voiceStateOf } from '../../src/features/box/voice';

describe('the computer’s voice for spoken titles', () => {
  afterEach(() => {
    platform.value = null;
    voice.value = null;
  });

  it('says in one sentence per system how to get a voice', () => {
    for (const os of ['windows', 'macos', 'linux', 'other'] as const) {
      const text = noVoiceText(os);
      expect(text.match(/[.!?](\s|$)/g), os).toHaveLength(1);
    }
    expect(noVoiceText('linux')).toContain('espeak-ng');
    expect(noVoiceText('windows')).toContain('Zeit und Sprache');
  });

  it('names the voice and notes one for another language', () => {
    expect(voiceLabel({ engine: 'sapi', voice: 'Microsoft Hedda Desktop', german: true })).toBe('Microsoft Hedda Desktop (Windows-Stimme)');
    expect(voiceLabel({ engine: 'espeak-ng', german: true })).toBe('eSpeak NG');
    expect(voiceStateOf({ engine: null, german: false }, 'linux')).toEqual({ kind: 'none', text: noVoiceText('linux') });
    expect(voiceStateOf({ engine: 'say', voice: 'Samantha', german: false }, 'macos')).toMatchObject({ kind: 'ready', note: FOREIGN_VOICE_NOTE });
    expect(voiceStateOf({ engine: 'pico2wave', german: true }, 'linux')).toMatchObject({ kind: 'ready', note: undefined });
  });

  it('announces the MP3s of a folder, with the number when asked', () => {
    const rows = [
      { file: '001.mp3', title: 'Der Hund', number: 1 },
      { file: '002.m4a', title: 'Nicht MP3', number: 2 },
      { file: '003_Die_Katze.MP3', title: 'Die_Katze.mp3', number: 3 },
    ];
    expect(announceTargets(rows, false).map((t) => t.text)).toEqual(['Der Hund', 'Die Katze']);
    expect(announceTargets(rows, true).map((t) => [t.file, t.text])).toEqual([
      ['001.mp3', 'Titel 1. Der Hund'],
      ['003_Die_Katze.MP3', 'Titel 3. Die Katze'],
    ]);
  });

  it('looks once, again only when asked, and says when the browser cannot', async () => {
    await lookForVoice();
    expect(voice.value).toEqual({ kind: 'web' });
    const info: VoiceInfo = { engine: null, german: false };
    const look = vi.fn(async () => info);
    platform.value = { kind: 'desktop', os: 'linux', speech: { voice: look, say: vi.fn() } } as unknown as Platform;
    voice.value = null;
    await lookForVoice();
    await lookForVoice();
    expect(look).toHaveBeenCalledTimes(1);
    expect(voice.value).toMatchObject({ kind: 'none' });
    info.engine = 'espeak-ng';
    info.german = true;
    await lookForVoice(true);
    expect(look).toHaveBeenLastCalledWith(true);
    expect(voice.value).toMatchObject({ kind: 'ready', info: { engine: 'espeak-ng' } });
  });
});
