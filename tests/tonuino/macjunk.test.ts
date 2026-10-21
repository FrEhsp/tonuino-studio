import { describe, expect, it } from 'vitest';
import { isMacJunk, macTidyText, tidyMacJunk } from '../../src/core/tonuino/macjunk';
import { memDir, memTreeNames } from '../../src/platform/memory';
import type { Dir } from '../../src/platform/types';

/** A card as a Mac leaves it (forum 14978#76–82). */
function macCard() {
  return memDir({
    '.fseventsd': { fseventsd: 3 },
    '.Spotlight-V100': { Store: 3 },
    '.Trashes': {},
    '._.Trashes': 1,
    '._.fseventsd': 1,
    '.DS_Store': 1,
    'tonuino-studio.json': '{}',
    '01': { '001.mp3': 5, '._001.mp3': 1, cover: { '._x.jpg': 1 } },
    mp3: { '0001.mp3': 2, '._0001.mp3': 1 },
    Fotos: { '._bild.jpg': 1 },
  });
}

describe('tidying the junk of a Mac before ejecting', () => {
  it('knows the names macOS leaves', () => {
    for (const n of ['.fseventsd', '.Spotlight-V100', '.Trashes', '._.Trashes', '._.Spotlight-V100', '._001.mp3', '.DS_Store']) expect(isMacJunk(n)).toBe(true);
    for (const n of ['001.mp3', 'tonuino-studio.json', 'System Volume Information', '.Trash-1000', 'mp3']) expect(isMacJunk(n)).toBe(false);
  });

  it('removes it from the top level, the box folders and mp3/advert, and nothing else', async () => {
    const root = macCard();
    const t = await tidyMacJunk(root);
    expect(t.left).toEqual([]);
    expect(t.removed.sort()).toEqual(['.DS_Store', '.Spotlight-V100', '.Trashes', '._.Trashes', '._.fseventsd', '.fseventsd', '01/._001.mp3', 'mp3/._0001.mp3'].sort());
    expect(await memTreeNames(root)).toEqual({
      'tonuino-studio.json': 2,
      '01': { '001.mp3': 5, cover: { '._x.jpg': 1 } },
      mp3: { '0001.mp3': 2 },
      Fotos: { '._bild.jpg': 1 },
    });
    expect(macTidyText(t)).toBe('Vorher hab ich 8 versteckte Dateien vom Mac weggeräumt.');
    expect(macTidyText(await tidyMacJunk(root))).toBeUndefined();
  });

  it('looks again afterwards and says what stayed', async () => {
    const root = macCard();
    // macOS protects the Spotlight index while the card is mounted, and a file in a box folder is locked.
    const remove = root.remove.bind(root);
    root.remove = async (name, opts) => {
      if (name === '.Spotlight-V100') throw new Error('Operation not permitted');
      return remove(name, opts);
    };
    const folder = (await root.dir('01')) as Dir;
    folder.remove = async () => {
      throw new Error('locked');
    };
    const orig = root.dir.bind(root);
    root.dir = async (name, opts) => (name === '01' ? folder : orig(name, opts));
    const t = await tidyMacJunk(root);
    expect(t.left.sort()).toEqual(['.Spotlight-V100', '01/._001.mp3']);
    expect(t.removed).not.toContain('.Spotlight-V100');
    expect(macTidyText(t)).toContain('Eine versteckte Datei vom Mac in den Ordnern der Box ließ sich nicht löschen, zum Beispiel 01/._001.mp3.');
    expect(macTidyText({ removed: [], left: ['.Spotlight-V100'] })).toBe('Der Mac legt ein paar versteckte Ordner beim Einstecken immer wieder an. Die Box stört das nicht.');
  });
});
