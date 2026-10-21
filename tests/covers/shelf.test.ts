/**
 * What the shelf shows for a folder (src/core/covers/shelf.ts): recognised
 * recipe, a choice on the folder page, and what to search for a missing cover.
 * The app ships no recipes since 0.5; the recipes here exist only for the test.
 */
import { describe, expect, it } from 'vitest';
import type { Recipe } from '../../src/core/covers/recipe';
import { AS_STICKER, NO_RECIPE, SHIPPED_RECIPES, coverWanted, shelfChoice, shippedRecipeById } from '../../src/core/covers/shelf';
import type { CatalogFolder } from '../../src/core/tonuino/catalog';

const RECIPES: Recipe[] = [
  {
    id: 'kleines-gespenst',
    name: 'Das kleine Gespenst',
    art: 'titel',
    erkennen: { titel: ['das kleine gespenst', 'kleine gespenst'], kuenstler: ['otfried preussler'] },
    suche: { begriff: 'Das kleine Gespenst Hörspiel', kuenstler: 'Otfried Preußler' },
    basis: { schrift: 'storybook', nummer: 'ordner' },
  },
  {
    id: 'hotzenplotz',
    name: 'Der Räuber Hotzenplotz',
    art: 'serie',
    erkennen: { titel: ['raeuber hotzenplotz', 'hotzenplotz'] },
    suche: { begriff: 'Der Räuber Hotzenplotz Hörspiel', kuenstler: 'Otfried Preußler' },
  },
  {
    id: 'drei-fragezeichen',
    name: 'Die drei ???',
    art: 'serie',
    erkennen: { titel: ['die drei fragezeichen', 'drei fragezeichen'], nicht: ['kids'] },
    suche: { begriff: 'Die drei ???', folge: true },
    basis: { schrift: 'detective', nummer: 'im-cover' },
  },
];
const recipeById = (id: string) => RECIPES.find((r) => r.id === id);

const folder = (f: Partial<CatalogFolder>): CatalogFolder => ({ title: 'Ordner 01', tracks: [], addedAt: 1, updatedAt: 1, ...f });
const choice = (f: CatalogFolder) => shelfChoice(f, RECIPES, recipeById);

describe('the shipped recipes', () => {
  it('are none: every folder gets the card without one, an old choice counts as unknown', () => {
    expect(SHIPPED_RECIPES).toEqual([]);
    expect(shippedRecipeById('hotzenplotz')).toBeUndefined();
    const gespenst = folder({ title: 'Das kleine Gespenst', artist: 'Otfried Preußler' });
    expect(shelfChoice(gespenst, SHIPPED_RECIPES, shippedRecipeById)).toMatchObject({ kind: 'karte', recipe: null, auto: true });
    expect(shelfChoice(folder({ title: 'Urlaub', sticker: { recipe: 'hotzenplotz' } }), SHIPPED_RECIPES, shippedRecipeById)).toMatchObject({ kind: 'karte', recipe: null, auto: false });
  });
});

describe('shelfChoice', () => {
  it('recognises a recipe and says so', () => {
    const c = choice(folder({ title: 'Das kleine Gespenst', artist: 'Otfried Preußler', cover: '42.jpg', coverSource: 'Datei' }));
    expect(c.kind).toBe('karte');
    expect(c.recipe?.id).toBe('kleines-gespenst');
    expect(c.auto).toBe(true);
    expect(c.via).toBe('titel');
  });

  it('keeps the episode of a series', () => {
    const c = choice(folder({ title: 'Die drei ??? Folge 125 - Feuermond', artist: 'Die drei ???' }));
    expect(c.recipe?.id).toBe('drei-fragezeichen');
    expect(c.episode).toBe(125);
  });

  it('follows a choice made on the folder page', () => {
    const gespenst = { title: 'Das kleine Gespenst', artist: 'Otfried Preußler' };
    expect(choice(folder({ ...gespenst, sticker: { recipe: NO_RECIPE } }))).toMatchObject({ kind: 'karte', recipe: null, auto: false });
    expect(choice(folder({ ...gespenst, sticker: { recipe: AS_STICKER } })).kind).toBe('sticker');
    expect(choice(folder({ title: 'Urlaub', sticker: { recipe: 'hotzenplotz' } }))).toMatchObject({ recipe: { id: 'hotzenplotz' }, auto: false });
    // A recipe of a newer app: the card without one.
    expect(choice(folder({ title: 'Urlaub', sticker: { recipe: 'gibt-es-nicht' } })).recipe).toBeNull();
  });

  it('builds a card without recipe for an unknown folder', () => {
    expect(choice(folder({ title: 'Omas Lieder' }))).toMatchObject({ kind: 'karte', recipe: null, auto: true });
  });
});

describe('coverWanted', () => {
  it('searches with the recipe, sure for a title and for a series episode', () => {
    const g = folder({ title: 'Das kleine Gespenst', artist: 'Otfried Preußler' });
    expect(coverWanted(g, choice(g))).toEqual({ query: 'Das kleine Gespenst Hörspiel', specific: true });
    const d = folder({ title: 'Die drei ??? Folge 125 - Feuermond', artist: 'Die drei ???' });
    expect(coverWanted(d, choice(d))).toEqual({ query: 'Die drei ??? Folge 125', specific: true });
  });

  it('takes no hit without a look for an artist alone', () => {
    const z = folder({ title: 'Ordner 05', artist: 'Rolf Zuckowski' });
    expect(coverWanted(z, choice(z))?.specific).toBe(false);
  });

  it('searches like the folder page without a recipe', () => {
    const o = folder({ title: 'Ordner 07' });
    expect(coverWanted(o, choice(o))).toBeNull();
  });
});
