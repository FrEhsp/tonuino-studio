/**
 * One form of the imperative in the whole app and its help (TODO #72): the
 * long one, „Wähle, Prüfe, Lege, Klicke, Stecke …“. Before 0.5 both stood
 * side by side („Wähle“ 98×, „Wähl“ 46×). Verbs whose imperative changes the
 * vowel (nimm, gib, lies, sieh, wirf, miss, hilf) have no long form and stay.
 *
 * Two checks over every text in src/: the known verbs never appear in the
 * short form, and no word appears as an imperative both with and without
 * the final „e“ (so a verb missing from the list is caught as well).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

/** Short form → the long form the app uses. */
const LONG: Record<string, string> = {
  wähl: 'wähle', prüf: 'prüfe', steck: 'stecke', klick: 'klicke', leg: 'lege', zieh: 'ziehe', versuch: 'versuche', lass: 'lasse',
  spiel: 'spiele', stell: 'stelle', probier: 'probiere', lösch: 'lösche', schau: 'schaue', beschreib: 'beschreibe', schließ: 'schließe',
  druck: 'drucke', drück: 'drücke', tipp: 'tippe', such: 'suche', mach: 'mache', schreib: 'schreibe', kleb: 'klebe', hör: 'höre',
  halt: 'halte', setz: 'setze', kopier: 'kopiere', schieb: 'schiebe', frag: 'frage', pack: 'packe', installier: 'installiere',
  schneid: 'schneide', dreh: 'drehe', lern: 'lerne', hak: 'hake', füg: 'füge', häng: 'hänge', kauf: 'kaufe', trag: 'trage', nutz: 'nutze',
  zeig: 'zeige', geh: 'gehe', bring: 'bringe', heb: 'hebe', klopf: 'klopfe', sag: 'sage', merk: 'merke', markier: 'markiere',
  formatier: 'formatiere', speicher: 'speichere', lad: 'lade', hol: 'hole', räum: 'räume', schalt: 'schalte', zähl: 'zähle', kürz: 'kürze',
  verschieb: 'verschiebe', wisch: 'wische', spül: 'spüle', fang: 'fange', schraub: 'schraube', streich: 'streiche',
  überschreib: 'überschreibe', übertrag: 'übertrage', ersetz: 'ersetze', benenn: 'benenne', bau: 'baue', entpack: 'entpacke',
  erlaub: 'erlaube', tausch: 'tausche', trenn: 'trenne', aktualisier: 'aktualisiere', bestätig: 'bestätige', klapp: 'klappe',
  füll: 'fülle', bleib: 'bleibe', denk: 'denke', schick: 'schicke', verbind: 'verbinde', entfern: 'entferne', behalt: 'behalte',
  verwend: 'verwende', änder: 'ändere', sortier: 'sortiere', reparier: 'repariere', kalibrier: 'kalibriere', scann: 'scanne',
  lös: 'löse', löt: 'löte', roll: 'rolle', klemm: 'klemme', spring: 'springe', vergleich: 'vergleiche', besorg: 'besorge',
  bestell: 'bestelle', sperr: 'sperre', wart: 'warte', komm: 'komme', richt: 'richte', start: 'starte', teil: 'teile', leer: 'leere',
};

/** Short forms that are also nouns or other words („der Druck“, „Teil 2“, „Start der Box“, „leer und bereit“). */
const NOUNISH = new Set(['druck', 'tipp', 'versuch', 'spiel', 'teil', 'start', 'halt', 'kauf', 'pack', 'fang', 'bau', 'test', 'leer', 'hör', 'wart', 'schau', 'zeig', 'merk', 'geh']);

/** Phrases where such a word is no command: „Teil ab Byte …“ (a part of a download), „Leer und bereit“. */
const NOT_COMMANDS = new Set(['teil ab', 'leer und']);

/** Words that follow an imperative („Drücke die …“, „Versuche es …“), not a noun („Der Druck ist …“). */
const AFTER_IMPERATIVE = new Set(('die den das dem ein eine einen einem dir dich sie es ihn mal bitte auf in an im am zuerst noch nur hier dort dann alle deine dein deinen ' +
  'zurück weiter ab aus ruhig kurz einfach lieber genau unter oben unten danach erst mit nach vor über beim sofort jetzt einmal nie nicht beide beides diese diesen ' +
  'dafür damit dazu darauf vorher mich uns lange fest weg los hin um durch zu mindestens etwa weniger mehr bis ganz zwei drei gleichzeitig jede jeden jedes neu ' +
  'selbst direkt gleich am play/pause neue').split(' '));

/** Where a sentence or a clause begins: there an imperative stands first. */
const IMPERATIVE = /(?<=(?:^\s*|[`'"„>({[]\s*|\*\*\s*|[})]\s+|[.!?:;–…]“?\s+|,\s+|\b(?:[Dd]ann|[Oo]der|[Uu]nd|[Bb]itte|[Dd]anach|[Ss]onst|[Ee]infach|[Jj]etzt|[Ee]rst|[Zz]uerst|[Ll]ieber|[Nn]ochmal|[Aa]lso|[Aa]ber|[Dd]abei|[Dd]afür|[Vv]orher|[Hh]ier|[Dd]ort)\s+))([A-ZÄÖÜa-zäöüß][a-zäöüß]+)(?=\s*([,.!;](?!\w)|(?<=\s)[^\s,.;:!?]+))/g;

interface Hit { word: string; next: string; where: string }

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** Every word in imperative position in the app's texts, without code comments. */
function imperatives(): Hit[] {
  const out: Hit[] = [];
  for (const file of files(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
      const t = raw.trimStart();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ')) return;
      const line = raw.replace(/\{?\/\*.*?\*\/\}?/g, '').replace(/\s\/\/\s.*$/, '');
      for (const m of line.matchAll(IMPERATIVE)) {
        const next = m[2];
        // „Ich schau nach“, „dann prüf ich“: the app speaking of itself, no command.
        if (next === 'ich') continue;
        // Code, not text: „press === 'short'“, „start ?? …“. A comma or full stop may follow a command („Prüfe, ob …“).
        if (!/^[A-Za-zÄÖÜäöüß„[*$,.!;]/.test(next)) continue;
        out.push({ word: m[1], next, where: `${relative(ROOT, file)}:${i + 1}` });
      }
    });
  }
  return out;
}

const HITS = imperatives();

describe('Befehlsformen (#72)', () => {
  it('finds the imperatives at all (the check itself works)', () => {
    const words = new Set(HITS.map((h) => h.word));
    for (const w of ['Wähle', 'Prüfe', 'Lege', 'Klicke', 'Stecke', 'Nimm', 'Gib', 'Lies']) expect(words, w).toContain(w);
  });

  it('uses the long form of every known verb', () => {
    const short = HITS.filter((h) => {
      const lw = h.word.toLowerCase();
      if (!(lw in LONG)) return false;
      if (NOUNISH.has(lw)) {
        // A capital noun after „und“ („und Druck“) or a noun followed by a verb is no command.
        if (!AFTER_IMPERATIVE.has(h.next.replace(/^[„[*]+/, '').toLowerCase()) && !/^[„[*]/.test(h.next)) return false;
        if (NOT_COMMANDS.has(`${lw} ${h.next}`)) return false;
      }
      return true;
    });
    expect(short.map((h) => `${h.where}: „${h.word} ${h.next}“ → „${LONG[h.word.toLowerCase()]}“`)).toEqual([]);
  });

  it('never has the same verb with and without the final „e“', () => {
    // Nouns and other words that happen to sit at the start of a sentence next to a verb of the same stem.
    const notVerbs = new Set(['Ende', 'Seite', 'Reihe', 'Tipp', 'Teil', 'Start', 'Druck', 'Spiel', 'Versuch', 'Halt', 'Test', 'Lage', 'Leer', 'Stell', 'Mal', 'Sag', 'Folge', 'Probe', 'Frage', 'Name', 'Karte', 'Taste', 'Liste', 'Pause', 'Datei', 'Hilfe', 'Box', 'Bild', 'Wart', 'Kauf', 'Pack', 'Fang', 'Bau', 'Hör', 'Schau', 'Zeig', 'Merk', 'Geh', 'Seit', 'Antwort', 'Ratespiel', 'All', 'Gleich', 'Ein', 'Sicher']);
    const commands = new Map<string, Hit>();
    for (const h of HITS) {
      const w = h.word.toLowerCase();
      // Only where the word looks like a command („Prüf die …“), not like any other word.
      if (!commands.has(w) && AFTER_IMPERATIVE.has(h.next.toLowerCase())) commands.set(w, h);
    }
    const mixed: string[] = [];
    for (const [w, h] of commands) {
      const long = commands.get(`${w}e`);
      if (!long || notVerbs.has(h.word[0].toUpperCase() + h.word.slice(1))) continue;
      mixed.push(`„${h.word} ${h.next}“ (${h.where}) neben „${long.word} ${long.next}“ (${long.where})`);
    }
    expect(mixed).toEqual([]);
  });
});
