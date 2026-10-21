/** What "Anhören" says when a track does not play (src/ui/playError.ts): German, with what to do, never the browser's English. */
import { describe, expect, it } from 'vitest';
import { isAbort, isNotSupported, playProblem } from '../../src/ui/playError';

const dom = (name: string, message = 'The operation is not supported.') => new DOMException(message, name);

describe('messages when a track does not play', () => {
  it('never passes on the English text of the browser', () => {
    for (const e of [dom('NotSupportedError'), dom('NotAllowedError', 'play() failed because the user didn’t interact'), new Error('Failed to load because no supported source was found.'), 'x']) {
      const p = playProblem(e);
      expect(p.title).toBe('Abspielen geht nicht');
      expect(p.text).not.toMatch(/operation|supported|failed|interact/i);
      expect(p.text).toMatch(/noch einmal|anderen Titel/);
    }
  });

  it('tells a refused file, a blocked start and a broken file apart', () => {
    expect(playProblem(dom('NotSupportedError')).text).toMatch(/neu/);
    expect(playProblem(dom('NotAllowedError')).text).toMatch(/„Anhören“/);
    expect(playProblem(new Error(''), 3).text).toMatch(/beschädigt/);
    expect(playProblem(new Error(''), 2).text).toMatch(/SD-Karte/);
    expect(playProblem(new Error(''), 4).text).toMatch(/Warte kurz/);
  });

  it('knows which refusals get a second try and which are no error at all', () => {
    expect(isNotSupported(dom('NotSupportedError'))).toBe(true);
    expect(isNotSupported(dom('NotAllowedError'))).toBe(false);
    expect(isNotSupported(undefined)).toBe(false);
    expect(isAbort(dom('AbortError'))).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
  });
});
