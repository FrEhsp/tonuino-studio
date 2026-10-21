/**
 * Text for a field that holds one line, such as a title: line breaks (from
 * pasting), with the spaces around them, become a single space. `caret` is
 * where the cursor was in `text`; the result says where it goes, so it stays
 * behind what was pasted.
 */
export function oneLine(text: string, caret = text.length): { text: string; caret: number } {
  if (!/[\r\n]/.test(text)) return { text, caret };
  let out = '';
  let last = 0;
  let pos = caret;
  for (const m of text.matchAll(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    out += `${text.slice(last, start)} `;
    if (caret >= end) pos -= m[0].length - 1;
    else if (caret > start) pos = out.length;
    last = end;
  }
  return { text: out + text.slice(last), caret: pos };
}

/** The selection in a text field: where it starts and ends, and which end moves with Shift. */
export interface FieldSelection {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
}

/**
 * Home and End in a field that holds one line but shows it wrapped: as in a
 * one-line field, they go to the start and the end of the whole text, not of
 * the line on screen. With Shift (`extend`) they select up to there, from
 * where the selection began.
 */
export function homeEnd(key: 'Home' | 'End', length: number, selection: FieldSelection, extend = false): FieldSelection {
  const to = key === 'Home' ? 0 : length;
  if (!extend) return { start: to, end: to, direction: 'none' };
  const anchor = selection.direction === 'backward' ? selection.end : selection.start;
  return to < anchor ? { start: to, end: anchor, direction: 'backward' } : { start: anchor, end: to, direction: 'forward' };
}
