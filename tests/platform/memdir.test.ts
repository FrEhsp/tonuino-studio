import { memDir } from '../../src/platform/memory';
import { dirContract } from './dirContract';

dirContract('MemDir', (tree) => memDir(tree));
