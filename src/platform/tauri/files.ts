/** FileSaver: the native save dialog, then a flushed write to the chosen path. */
import type { FileSaver } from '../types';
import type { Bridge } from './bridge';
import { writeFile } from './fs';

export class TauriFileSaver implements FileSaver {
  constructor(private readonly bridge: Bridge) {}

  async save(suggestedName: string, data: Blob): Promise<boolean> {
    const path = await this.bridge.call<string | null>('dialog', 'dialog_save', {
      suggestedName,
      title: 'Speichern unter',
    });
    if (!path) return false;
    await writeFile(this.bridge, path, data, { area: 'save' });
    return true;
  }
}
