/**
 * A long file on "Hinzufügen" for which the shops know no track list (TODO
 * 0.5 #81): the album card says so in a line and offers a field to search
 * under another name, instead of saying nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
import { NotFoundNote } from '../../src/features/add/AlbumCut';

/** Every element below a node, without drawing components. */
function walk(node: unknown, out: VNode[] = []): VNode[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!node || typeof node !== 'object' || !('type' in node)) return out;
  const v = node as VNode<{ children?: unknown }>;
  out.push(v);
  walk(v.props.children, out);
  return out;
}

const text = (nodes: VNode[]) =>
  nodes
    .flatMap((n) => [(n.props as { children?: unknown }).children].flat())
    .filter((c): c is string | number => typeof c === 'string' || typeof c === 'number')
    .join('');

describe('nothing found for a whole album in one file', () => {
  const query = 'Bibi & Tina – Das Kürbisfest (Folge 50)';

  it('says so, with the length of the file, and offers a search field with what was looked for', () => {
    const nodes = walk(NotFoundNote({ query, length: 41 * 60 + 4, onQuery: () => undefined, onSearch: () => undefined }));
    expect(text(nodes)).toContain('Keine Titelliste gefunden, die zusammen so lang ist wie die Datei (41 Min. 4 Sek.)');
    expect(text(nodes)).toContain('Dann suche hier danach');
    const field = nodes.find((n) => n.type === 'input')!;
    expect(field).toBeDefined();
    expect((field.props as unknown as { value: string }).value).toBe(query);
    expect((field.props as unknown as Record<string, string>)['aria-label']).toBe('Name des Albums');
    const button = nodes.find((n) => (n.props as { type?: string }).type === 'submit')!;
    expect(text([button])).toBe('Suchen');
  });

  it('searches for what is typed, with the button or Enter', () => {
    const onQuery = vi.fn();
    const onSearch = vi.fn();
    const nodes = walk(NotFoundNote({ query: 'Bibi und Tina Folge 50', length: 2464, onQuery, onSearch }));
    const field = nodes.find((n) => n.type === 'input')!;
    (field.props as unknown as { onInput: (e: unknown) => void }).onInput({ currentTarget: { value: 'Bibi und Tina Folge 50' } });
    expect(onQuery).toHaveBeenCalledWith('Bibi und Tina Folge 50');
    const form = nodes.find((n) => n.type === 'form')!;
    const preventDefault = vi.fn();
    (form.props as unknown as { onSubmit: (e: unknown) => void }).onSubmit({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onSearch).toHaveBeenCalledWith('Bibi und Tina Folge 50');
  });
});
