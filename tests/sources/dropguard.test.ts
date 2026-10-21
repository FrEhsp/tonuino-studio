import { describe, expect, it } from 'vitest';
import { guardWindowDrops, refuseStrayFileDrag } from '../../src/ui/dropGuard';

function drag(type: 'dragover' | 'drop', o: { files?: boolean; taken?: boolean; target?: unknown } = {}) {
  const e = {
    type,
    defaultPrevented: !!o.taken,
    dataTransfer: { types: o.files === false ? ['text/plain'] : ['Files'], dropEffect: 'copy' as DataTransfer['dropEffect'] },
    target: o.target ?? null,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  return e;
}

describe('files let go next to a drop zone', () => {
  it('are refused instead of opening in the tab', () => {
    const over = drag('dragover');
    refuseStrayFileDrag(over as unknown as DragEvent);
    expect(over.prevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('none');
    const drop = drag('drop');
    refuseStrayFileDrag(drop as unknown as DragEvent);
    expect(drop.prevented).toBe(true);
  });

  it('leave drops that a zone took, text drags and file inputs alone', () => {
    const taken = drag('dragover', { taken: true });
    refuseStrayFileDrag(taken as unknown as DragEvent);
    expect(taken.dataTransfer.dropEffect).toBe('copy');
    const text = drag('drop', { files: false });
    refuseStrayFileDrag(text as unknown as DragEvent);
    expect(text.prevented).toBe(false);
    const input = drag('drop', { target: { closest: (sel: string) => (sel.includes('file') ? {} : null) } });
    refuseStrayFileDrag(input as unknown as DragEvent);
    expect(input.prevented).toBe(false);
  });

  it('are guarded while at least one zone is on the page', () => {
    const listeners = new Map<string, number>();
    const win = {
      addEventListener: (type: string) => listeners.set(type, (listeners.get(type) ?? 0) + 1),
      removeEventListener: (type: string) => listeners.set(type, (listeners.get(type) ?? 0) - 1),
    } as unknown as Window;
    const a = guardWindowDrops(win);
    const b = guardWindowDrops(win);
    expect(listeners.get('dragover')).toBe(1);
    expect(listeners.get('drop')).toBe(1);
    a();
    a();
    expect(listeners.get('drop')).toBe(1);
    b();
    expect(listeners.get('dragover')).toBe(0);
    expect(listeners.get('drop')).toBe(0);
  });
});
