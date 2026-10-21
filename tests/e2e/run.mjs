/**
 * All browser checks of the Paket mode in one go (see lib.mjs for how to
 * start them). Exits with 1 when one check failed.
 */
import { boxtest } from './boxtest.mjs';
import { checkMistakes } from './check-mistakes.mjs';
import { directMode } from './direct-mode.mjs';
import { dropFlow } from './drop.mjs';
import { failed, launch } from './lib.mjs';
import { folderLoudness } from './folder-loudness.mjs';
import { handheld } from './handheld.mjs';
import { hoerspiel } from './hoerspiel.mjs';
import { loetplan } from './loetplan.mjs';
import { memoryMode } from './memory-mode.mjs';
import { mergedFeatures } from './merged-features.mjs';
import { packageFlow } from './package-flow.mjs';
import { packageGuards } from './package-guards.mjs';
import { pageEdges } from './page-edges.mjs';
import { player } from './player.mjs';
import { remember } from './remember.mjs';
import { allScreens } from './screens.mjs';
import { serialFake } from './serial-fake.mjs';
import { stickerMove } from './sticker-move.mjs';
import { swapFolders } from './swap-folders.mjs';
import { waitingPackage } from './waiting-package.mjs';
import { workshopPackage } from './workshop-package.mjs';

const flows = [packageFlow, checkMistakes, waitingPackage, workshopPackage, loetplan, boxtest, dropFlow, memoryMode, mergedFeatures, packageGuards, swapFolders, serialFake, directMode, folderLoudness, stickerMove, player, hoerspiel, remember, handheld, pageEdges, allScreens];

const browser = await launch();
try {
  for (const flow of flows) {
    try {
      await flow(browser);
    } catch (e) {
      console.log(`  FAIL ${flow.name} stopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
}
const n = failed();
console.log(n || process.exitCode ? `\n${n} check(s) failed.` : '\nAll checks passed.');
process.exit(n || process.exitCode ? 1 : 0);
