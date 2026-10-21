#!/usr/bin/env node
// Runs the app's box functions against the real TonUINO-TNG firmware in the box
// simulator (docs/BOX-SIMULATOR.md, TODO #66): builds scripts/firmware/boxsim.c,
// unpacks only the Baukasten builds the tests use into a temporary folder, runs
// tests/boxsim with nice and one test file at a time, and deletes the folder.
//
//   npm run test:boxsim                 all of tests/boxsim
//   npm run test:boxsim -- start        only files matching "start"
//   BOXSIM_KEEP=1 npm run test:boxsim   keep the folder (its path is printed)
//
// Needs gcc and simavr (Debian/Ubuntu: apt-get install gcc simavr libsimavr-dev).
// simavr elsewhere (macOS with Homebrew): SIMAVR_PREFIX=<prefix with include/simavr
// and lib>, extra linker flags (e.g. -lelf) in BOXSIM_LIBS.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAUKASTEN = join(ROOT, 'public', 'firmware', 'baukasten');

// The builds tests/boxsim starts (BoxSim.start({ build })). Keep this list short: every
// build costs a simulator run of its own.
const BUILDS = ['classic-3', 'classic-5', 'classic-3-headphones', 'classic-3-writeCard', 'classic-3-encoder', 'aio-5'];

function fail(text) {
  console.error(`boxsim: ${text}`);
  process.exit(1);
}

const prefix = [process.env.SIMAVR_PREFIX, '/usr', '/usr/local', '/opt/homebrew'].find((p) => p && existsSync(join(p, 'include', 'simavr', 'sim_avr.h')));
if (!prefix) fail('simavr fehlt (apt-get install simavr libsimavr-dev).');
const gcc = spawnSync('gcc', ['--version'], { encoding: 'utf8' });
if (gcc.status !== 0) fail('gcc fehlt.');

const dir = mkdtempSync(join(tmpdir(), 'boxsim-'));
const keep = process.env.BOXSIM_KEEP === '1';
let status = 1;
try {
  const libs = ['-lsimavr', '-lm', ...(process.env.BOXSIM_LIBS ?? '').split(/\s+/).filter(Boolean)];
  const where = prefix === '/usr' ? [] : [`-I${join(prefix, 'include')}`, `-L${join(prefix, 'lib')}`];
  execFileSync('gcc', ['-O2', '-o', join(dir, 'boxsim'), join(ROOT, 'scripts', 'firmware', 'boxsim.c'), `-I${join(prefix, 'include', 'simavr')}`, ...where, ...libs], { stdio: 'inherit' });

  const manifest = JSON.parse(readFileSync(join(BAUKASTEN, 'manifest.json'), 'utf8'));
  const packs = new Map();
  for (const id of BUILDS) {
    const build = manifest.builds.find((b) => b.id === id);
    if (!build) fail(`${id} steht nicht im Manifest.`);
    if (!packs.has(build.pack)) packs.set(build.pack, gunzipSync(readFileSync(join(BAUKASTEN, build.pack))));
    writeFileSync(join(dir, `${id}.bin`), packs.get(build.pack).subarray(build.offset, build.offset + build.bytes));
  }
  packs.clear();

  const filter = process.argv.slice(2);
  const args = ['-n', '10', 'npx', 'vitest', 'run', '--no-file-parallelism', '--testTimeout', '300000', '--hookTimeout', '120000'];
  args.push(...(filter.length ? filter.map((f) => `tests/boxsim/${f}`) : ['tests/boxsim']));
  const run = spawnSync('nice', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BOXSIM_DIR: dir } });
  status = run.status ?? 1;
} finally {
  if (keep) console.log(`boxsim: Ordner bleibt: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
