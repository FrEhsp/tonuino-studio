import type { ByteSource, PickFilesOptions } from '../types';
import { fileSource } from './fsa';
import { PickQueue } from './pickqueue';

/** Picks that wait for the hidden input below; a new one ends the one before. */
const inputPicks = new PickQueue<ByteSource[]>([]);

/**
 * Fallback for browsers without the file pickers, and the Android app's way to
 * pick files (its WebView shows the system's chooser): a hidden <input type="file">.
 * Firefox fires neither "change" nor "cancel" when its "Hochladen" question
 * is declined, so such a pick only ends when the next one starts.
 */
export function inputPick(opts: PickFilesOptions): Promise<ByteSource[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = opts.multiple ?? true;
    if (opts.directory) input.webkitdirectory = true;
    if (opts.extensions?.length && !opts.directory) input.accept = opts.extensions.map((e) => '.' + e).join(',');
    input.style.display = 'none';
    const finish = inputPicks.begin((files) => {
      input.remove();
      resolve(files);
    });
    input.addEventListener('change', () => finish([...(input.files ?? [])].map((f) => fileSource(f))));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}
