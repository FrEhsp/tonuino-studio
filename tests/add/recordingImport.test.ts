import { describe, expect, it } from 'vitest';
import { recordingBlocked, startsAfresh } from '../../src/features/add/recordingImport';
import { markRecording, resetImport, session, type ImportSession } from '../../src/features/add/session';

const album = { id: 'a' } as ImportSession['albums'][number];
const s = (patch: Partial<ImportSession>): Pick<ImportSession, 'phase' | 'forFolder' | 'albums' | 'result'> => ({ phase: 'pick', albums: [], ...patch });

describe('a recording joins the import', () => {
  it('starts afresh when nothing else waits for another place', () => {
    expect(startsAfresh(s({}), 3)).toBe(true);
    expect(startsAfresh(s({ phase: 'review', forFolder: 3, albums: [album] }), 3)).toBe(false);
    expect(startsAfresh(s({ phase: 'review', forFolder: 3, albums: [album] }), undefined)).toBe(true);
    expect(startsAfresh(s({ phase: 'done', forFolder: 3, albums: [album] }), 3)).toBe(true);
  });

  it('joins the files picked for the same place', () => {
    expect(recordingBlocked(s({ phase: 'review', albums: [album] }), undefined)).toBeNull();
    expect(recordingBlocked(s({ phase: 'review', forFolder: 4, albums: [album] }), 4)).toBeNull();
    expect(recordingBlocked(s({ phase: 'done', result: { rest: [] } as unknown as ImportSession['result'] }), 4)).toBeNull();
  });

  it('waits while tracks go to the card, and for other files picked elsewhere', () => {
    expect(recordingBlocked(s({ phase: 'writing' }), 4)).toMatch(/Warte/);
    expect(recordingBlocked(s({ phase: 'review', forFolder: 2, albums: [album] }), 4)).toMatch(/andere Auswahl/);
    expect(recordingBlocked(s({ phase: 'review', albums: [album] }), 4)).toMatch(/andere Auswahl/);
    expect(recordingBlocked(s({ phase: 'done', result: { rest: [album] } as unknown as ImportSession['result'] }), 4)).toMatch(/nicht auf die Karte kam/);
  });
});

describe('the review of a recording', () => {
  it('knows it holds a recording until the import starts anew', () => {
    resetImport();
    expect(session.value.recording).toBeUndefined();
    markRecording();
    expect(session.value.recording).toBe(true);
    resetImport();
    expect(session.value.recording).toBeUndefined();
  });
});
