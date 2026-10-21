/**
 * What the Systemansagen tool says about the announcements on the SD card:
 * a headline, a sentence, a few facts and the label of the install button.
 */
import type { TngRelease } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { TNG_SEPTEMBER_2026 } from '../../core/tonuino/modes';
import type { SdScan, SystemDirName } from '../../core/tonuino/sd';
import { TNG_START_TONE, checkSystemSounds, type SystemSoundsStatus } from '../../core/tonuino/systemsounds';
import { START_TONE_TEXT } from '../../core/tonuino/health';
import { plural } from '../../app/format';

export interface SoundsFact {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'error';
}

export interface SoundsSummary {
  /** As checkSystemSounds, plus 'empty': nothing important is missing, but some announcements have 0 bytes. */
  state: SystemSoundsStatus['state'] | 'empty';
  title: string;
  text: string;
  /** Numbers that exist twice; the box may play the wrong one. */
  duplicates?: string;
  /** Files far too big for an announcement, e.g. an audio play stored as mp3/0001.mp3. */
  oversized?: string;
  facts: SoundsFact[];
  /** Label of the install button. */
  action: string;
}

/** When and which announcements TonUINO Studio put on the card (from the catalog). */
export interface InstalledSounds {
  version: string;
  installedAt: number;
}

/** Whether the box runs TNG of 17.09.2026 or newer, and whether its start said so (else the setting). */
export interface SoundsRelease {
  release: TngRelease;
  detected: boolean;
}

const DIRS: SystemDirName[] = ['mp3', 'advert'];

function folderList(names: string[]): string {
  return names.length === 1 ? `Der Ordner ${names[0]} fehlt` : `Die Ordner ${names.join(' und ')} fehlen`;
}

export function soundsSummary(scan: SdScan, profile: FirmwareProfile, installed?: InstalledSounds, box: SoundsRelease = { release: 'unknown', detected: false }): SoundsSummary {
  const st = checkSystemSounds(scan, profile, box.release);
  const tng = profile === 'tng';
  const when = box.release === 'newer' ? ' ab 17.09.2026' : box.release === 'older' ? ' vor 17.09.2026' : '';
  const facts: SoundsFact[] = [{ label: 'Firmware', value: tng ? `TonUINO TNG${when}${when && box.detected ? ' (automatisch erkannt)' : ''}` : 'TonUINO 2.1' }];
  for (const name of DIRS) {
    const dir = scan.system[name];
    facts.push(
      dir
        ? { label: `Ordner ${name}`, value: plural(dir.files.length, 'Ansage', 'Ansagen') }
        : { label: `Ordner ${name}`, value: 'fehlt', tone: 'error' },
    );
  }
  const missing = st.missing.mp3.length + st.missing.advert.length;
  if (missing && st.state !== 'missing') facts.push({ label: 'Es fehlen', value: plural(missing, 'Ansage', 'Ansagen'), tone: 'warn' });
  // 0 bytes, like the health check's "Leere Ansagen": the box stays silent there.
  const empty = DIRS.flatMap((n) => st.empty[n].map((f) => `${scan.system[n]!.dirName}/${f}`));
  if (empty.length) facts.push({ label: 'Leer', value: plural(empty.length, 'Ansage', 'Ansagen'), tone: 'error' });
  // The files new on 17.09.2026, while nobody knows whether the box is that new: said, not counted as missing.
  const september = box.release === 'unknown' ? st.september.mp3.length + st.september.advert.length : 0;
  // "zusätzlich": next to "Es fehlen 127", a bare "3 fehlen" read as a second count that disagrees (audit 0.4 #19).
  if (september) facts.push({ label: 'Für TNG ab 17.09.2026 zusätzlich', value: plural(september, 'Ansage fehlt', 'Ansagen fehlen') });
  if (installed) {
    const what = installed.version === 'eigene' ? 'eigene Ansagen' : `Version ${installed.version}`;
    facts.push({ label: 'Installiert', value: `${what}, am ${new Date(installed.installedAt).toLocaleDateString('de-DE')}` });
  }

  const doubled = [...st.duplicates.mp3.map((n) => `mp3/${String(n).padStart(4, '0')}`), ...st.duplicates.advert.map((n) => `advert/${String(n).padStart(4, '0')}`)];
  const duplicates = doubled.length
    ? `Manche Nummern gibt es doppelt, zum Beispiel ${doubled[0]}. Dann spielt die Box vielleicht die falsche Ansage. Neu installieren räumt das auf.`
    : undefined;

  const big = DIRS.flatMap((n) => st.oversized[n].map((t) => `${scan.system[n]!.dirName}/${t.name}`));
  const oversized = big.length
    ? `${big.length === 1 ? 'Eine Ansage ist' : `${big.length} Ansagen sind`} viel zu groß, zum Beispiel ${big[0]}. Vermutlich liegt dort ein Hörspiel oder Lied, und die Box wirkt dort wie eingefroren. Brauchst du die Datei noch, kopiere sie zuerst auf deinen Computer. Neu installieren ersetzt sie.`
    : undefined;

  const emptyText = empty.length
    ? `${empty.length === 1 ? `Die Ansage ${empty[0]} hat` : `${empty.length} Ansagen haben`} 0 Byte, meist weil das Kopieren abgebrochen ist. An diesen Stellen bleibt die Box stumm.`
    : '';
  const base = { state: st.state, facts, duplicates, oversized };
  // Empty files are not missing ones: they come first only when nothing important is missing.
  if (empty.length && (st.state === 'outdated' || st.state === 'ok')) {
    return {
      ...base,
      state: 'empty',
      title: 'Manche Ansagen sind leer',
      text: `${emptyText}${missing ? ` Außerdem ${missing === 1 ? 'fehlt eine Ansage' : `fehlen ${missing} Ansagen`}, die neuere Versionen von TonUINO TNG brauchen.` : ''} Neu installieren ersetzt sie.`,
      action: 'Ansagen neu installieren',
    };
  }
  switch (st.state) {
    case 'missing':
      return {
        ...base,
        title: 'Auf der Karte fehlen die Ansagen',
        text: `${folderList(DIRS.filter((n) => !st.present[n]))}. Dann schweigt die Box an vielen Stellen, auch bei den Titelnummern.`,
        action: 'Ansagen installieren',
      };
    case 'incomplete': {
      const core = st.coreMissing.mp3.length + st.coreMissing.advert.length;
      const startTone = tng && st.coreMissing.mp3.includes(TNG_START_TONE);
      const also = emptyText ? ` Außerdem: ${emptyText}` : '';
      // Forum 12980: only the start tone is gone. Its own sentence, with what else is missing after it.
      if (startTone && core === 1) {
        const more = missing > 1 ? ` Außerdem ${missing - 1 === 1 ? 'fehlt eine Ansage' : `fehlen ${missing - 1} Ansagen`}, die neuere Versionen von TonUINO TNG brauchen.` : '';
        return { ...base, title: 'Eine wichtige Ansage fehlt', text: `Es fehlt ${START_TONE_TEXT}${more}${also}`, action: 'Ansagen installieren' };
      }
      // One number in the sentence, the rest under "Mehr" (SoundsTool): two counts side by side seemed to disagree (audit 0.4 #19).
      return {
        ...base,
        title: 'Wichtige Ansagen fehlen',
        text: `Es ${missing === 1 ? 'fehlt eine Ansage' : `fehlen ${missing} Ansagen`}, auch welche, die die Box oft braucht, zum Beispiel im Admin-Menü. Der Knopf unten spielt sie auf.${startTone ? ` Darunter ist auch ${START_TONE_TEXT}` : ''}${also}`,
        action: 'Ansagen installieren',
      };
    }
    case 'outdated':
      return {
        ...base,
        title: 'Die Ansagen sind älter als die Firmware',
        text: `Es ${missing === 1 ? 'fehlt eine Ansage' : `fehlen ${missing} Ansagen`}, die neuere Versionen von TonUINO TNG brauchen. Der Knopf unten spielt sie auf.`,
        action: 'Ansagen erneuern',
      };
    case 'ok':
      if (september)
        return {
          ...base,
          title: 'Die Ansagen sind da',
          text: `Die Box findet alle Ansagen, die TonUINO TNG bis zur Version vom 25.02.2026 braucht. Für die Endlos-Karte und die Frage nach dem letzten Ordner bei Hörbuch-Karten ${september === 1 ? 'fehlt eine Ansage' : `fehlen ${september} Ansagen`}. Die braucht erst TonUINO TNG ${TNG_SEPTEMBER_2026}.`,
          action: 'Ansagen erneuern',
        };
      return {
        ...base,
        title: 'Alle Ansagen sind da',
        text: tng && box.release !== 'older' ? `Die Box findet alle Ansagen, die TonUINO TNG ${TNG_SEPTEMBER_2026} braucht.` : 'Die Box findet alle Ansagen, die sie braucht.',
        action: 'Ansagen neu installieren',
      };
  }
}

/** The short line on the Systemansagen card of the Werkstatt overview. */
export function soundsOverviewNote(st: SystemSoundsStatus): { text: string; tone: 'ok' | 'warn' } {
  // Files with 0 bytes are there, but silent: said as such, not as missing.
  if ((st.state === 'outdated' || st.state === 'ok') && st.empty.mp3.length + st.empty.advert.length) return { text: 'Manche Ansagen auf der SD-Karte sind leer', tone: 'warn' };
  switch (st.state) {
    case 'missing':
      return { text: 'Fehlen auf der SD-Karte', tone: 'warn' };
    case 'incomplete':
      return { text: 'Auf der SD-Karte fehlen wichtige Ansagen', tone: 'warn' };
    case 'outdated':
      return { text: 'Älter als die Firmware', tone: 'warn' };
    case 'ok':
      return { text: 'Alle Ansagen da', tone: 'ok' };
  }
}
