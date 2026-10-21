/**
 * Follows a guide of the app (boxguide.ts, settingsguide.ts, headphones.ts)
 * at the simulated box like a person would: lays the card on, presses the
 * keys of each step and listens whether the box says what the step promises.
 */
import type { BoxStep } from '../../src/core/tonuino/boxguide';
import type { BoxSim, SimEvent } from './boxsim';

export interface StepRun {
  step: BoxStep;
  /** What the box said during the step. */
  said: string[];
  /** The step's `hear` came (or the step has none). */
  heard: boolean;
}

export interface FollowOptions {
  /** The card of the card steps, as simulator arguments ("classic uid=…"). */
  card?: string;
  /** Keys of the box: 'all' is Play/Pause, Vor and Zurück, with five keys optionally Play/Pause, Lauter, Leiser. */
  all?: string;
  /** Leave out steps marked optional (questions only some boxes ask). */
  skipOptional?: boolean;
}

const SAYS = /^says (?:mp3|advert)\/\d+ "(.*)"/;

export function spoken(events: readonly SimEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const m = e.tag === 'mp3' ? SAYS.exec(e.text) : null;
    if (m) out.push(m[1]);
  }
  return out;
}

/** „Willkommen im Admin Menü …“ → "willkommen im admin menü" */
export function norm(text: string): string {
  return text
    .replace(/[„“"…]/g, '')
    .replace(/[.!?,\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function matches(said: string, hear: string): boolean {
  const s = norm(said);
  const h = norm(hear);
  return /^\d+$/.test(h) ? s === h : s.startsWith(h) || s.includes(h);
}

async function press(sim: BoxSim, key: string, long: boolean): Promise<void> {
  await sim.do(`press ${key} ${long ? 'long' : 'short'}`);
  // A person needs a moment between two presses.
  await sim.do('wait 0.4');
}

/**
 * Waits up to `seconds` until the box said `hear` since event `from`, and
 * then, like a person, until it finished that sentence (keys pressed while
 * „Oh, eine neue Karte!“ plays are lost, the next question is not asked yet).
 */
export async function listen(sim: BoxSim, from: number, hear: string, seconds = 20): Promise<boolean> {
  const find = () => sim.events.findIndex((e, i) => i >= from && e.tag === 'mp3' && SAYS.test(e.text) && matches(SAYS.exec(e.text)![1], hear));
  let at = find();
  for (let t = 0; at < 0 && t < seconds; t += 0.5) {
    await sim.do('wait 0.5');
    at = find();
  }
  if (at < 0) return false;
  const file = /^says (\S+)/.exec(sim.events[at].text)![1];
  for (let t = 0; t < 15; t += 0.2) {
    if (sim.events.slice(at + 1).some((e) => e.tag === 'mp3' && (e.text.startsWith('says ') || e.text.startsWith(`end of ${file}`)))) break;
    await sim.do('wait 0.2');
  }
  return true;
}

const NUMBER = /^\d+$/;

export async function follow(sim: BoxSim, steps: readonly BoxStep[], opts: FollowOptions = {}): Promise<StepRun[]> {
  const runs: StepRun[] = [];
  let cardOn = false;
  /** Where the last press or card of an earlier step was: a step without one of its own hears what that caused. */
  let acted = sim.events.length;
  for (const step of steps) {
    if (step.optional && opts.skipOptional) continue;
    let from = sim.events.length;
    if (step.kind === 'card' && !cardOn && /\bLege\b/.test(step.text)) {
      await sim.do(`card ${opts.card ?? 'classic'}`);
      cardOn = true;
    } else if (!step.presses?.length && !(step.kind === 'menu' && step.hear)) {
      from = acted;
    }
    const presses = step.presses ?? [];
    let lastSaid: string | undefined;
    for (const [i, p] of presses.entries()) {
      const key = p.key === 'all' ? (opts.all ?? 'pause+up+down') : p.key;
      // menuStep(): "Drücke …, bis die Box „x“ sagt. Dann kurz die Play/Pause-Taste."
      const confirm = i === presses.length - 1 && i > 0 && p.key === 'pause' && !p.long && p.times === 1 && /Dann kurz die Play\/Pause-Taste/.test(step.text);
      if (confirm) {
        // What the box said last before the confirming press is what gets chosen.
        await sim.do('wait 0.6');
        lastSaid = spoken(sim.events.slice(from)).at(-1);
      }
      for (let n = 0; n < p.times; n++) await press(sim, key, !!p.long);
    }
    if (!presses.length && step.kind === 'menu' && step.hear) {
      // "Drück Vor oder Zurück, bis die Box … sagt": step towards the value it should say.
      const firstUp = /Drücke zuerst einmal kurz Vor/.test(step.text);
      if (firstUp) await press(sim, 'up', false);
      const target = norm(step.hear);
      for (let n = 0; n < 40; n++) {
        await sim.do('wait 0.6');
        const last = spoken(sim.events.slice(from)).at(-1);
        if (last !== undefined && matches(last, step.hear)) break;
        const lower = last !== undefined && NUMBER.test(norm(last)) && NUMBER.test(target) && Number(norm(last)) > Number(target);
        await press(sim, lower ? 'down' : 'up', false);
      }
      await sim.do('wait 0.6');
      lastSaid = spoken(sim.events.slice(from)).at(-1);
      await press(sim, 'pause', false);
    }
    if (step.presses?.length || cardOn) acted = Math.max(acted, from);
    let heard = true;
    if (step.hear) heard = lastSaid !== undefined ? matches(lastSaid, step.hear) : await listen(sim, from, step.hear);
    runs.push({ step, said: spoken(sim.events.slice(from)), heard });
    if (!heard) break;
  }
  // Let the last announcement finish.
  await sim.do('wait 3');
  return runs;
}

/** The steps whose `hear` did not come, for an expect(). */
export function unheard(runs: readonly StepRun[]): string[] {
  return runs.filter((r) => !r.heard).map((r) => `${r.step.text}\n  erwartet: ${r.step.hear}\n  gehört: ${r.said.join(' | ') || '(nichts)'}`);
}
