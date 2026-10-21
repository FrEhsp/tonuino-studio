import { describe, expect, it } from 'vitest';
import { CHIP_DEFINES, CHIP_SYMPTOM_TEXT, CHIP_TEXTS, OTHER_CHIPS, chipFromDefines, suggestChip } from '../../src/core/firmware/mp3chip';

describe('MP3 player chip', () => {
  it('uses the defines of TNG constants.hpp (V3.3.3 17.09.26)', () => {
    expect(CHIP_DEFINES.mh2024k24ss).toBe('DFMiniMp3_T_CHIP_MH2024K24SS_MP3_TF_16P_V3_0');
    expect(CHIP_DEFINES.gd3200b).toBe('DFMiniMp3_T_CHIP_GD3200B');
    expect(CHIP_DEFINES.lisp3).toBe('DFMiniMp3_T_CHIP_LISP3');
    expect(CHIP_DEFINES.standard).toBeUndefined();
    // MH2024K16SS needs a change of the source (see mp3chip.ts) and is not offered.
    expect(OTHER_CHIPS).not.toContain('mh2024k16ss');
    expect(chipFromDefines(['TonUINO_Classic=1', 'DFMiniMp3_T_CHIP_GD3200B'])).toBe('gd3200b');
    expect(chipFromDefines(['TonUINO_Classic=1'])).toBe('standard');
  });

  it('says in plain words that the chip, not the file, is the cause', () => {
    expect(CHIP_SYMPTOM_TEXT).toContain('nur manche Dateien');
    expect(CHIP_SYMPTOM_TEXT).toContain('nicht an der Datei');
    expect(CHIP_TEXTS.mh2024k24ss.label).toBe('Anderer MP3-Player-Chip (MH2024K-24SS)');
    expect(CHIP_TEXTS.mh2024k24ss.look).toContain('MP3-TF-16P V3.0');
  });

  it('suggests the chip someone identified, unless the box has it already', () => {
    expect(suggestChip({ chip: 'mh2024k24ss' })).toMatchObject({ chip: 'mh2024k24ss', sure: true });
    expect(suggestChip({ chip: 'gd3200b' })?.reason).toContain('GD3200B');
    expect(suggestChip({ chip: 'mh2024k24ss', current: 'mh2024k24ss' })).toBeUndefined();
    expect(suggestChip({ chip: 'standard', missingOnPlayFinished: 5, playingFlaps: 5 })).toBeUndefined();
  });

  it('guesses MH2024K-24SS from the busy pin flapping and early track ends (forum 15006)', () => {
    expect(suggestChip({ playingFlaps: 3, missingOnPlayFinished: 2 })).toMatchObject({ chip: 'mh2024k24ss', sure: false });
    expect(suggestChip({ playingFlaps: 2, onlySomeFiles: true })?.chip).toBe('mh2024k24ss');
    expect(suggestChip({ missingOnPlayFinished: 3, onlySomeFiles: true })?.chip).toBe('mh2024k24ss');
    // Once is harmless (logexplain: "Ab und zu ist das harmlos").
    expect(suggestChip({ missingOnPlayFinished: 1, playingFlaps: 1 })).toBeUndefined();
    expect(suggestChip({ missingOnPlayFinished: 4 })).toBeUndefined();
    expect(suggestChip({})).toBeUndefined();
  });

  it('guesses the other chips from their symptoms', () => {
    expect(suggestChip({ sameCountEveryFolder: true })).toMatchObject({ chip: 'gd3200b', sure: false });
    expect(suggestChip({ skipsAfterAnnouncement: true })).toMatchObject({ chip: 'lisp3', sure: false });
    expect(suggestChip({ sameCountEveryFolder: true, current: 'gd3200b' })).toBeUndefined();
  });
});
