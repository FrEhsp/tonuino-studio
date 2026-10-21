import { describe, expect, it } from 'vitest';
import { createTauriPlatform } from '../../src/platform/tauri';
import { TauriDir } from '../../src/platform/tauri/fs';
import { pathWithin } from '../../src/platform/tauri/volumes';
import type { Volume } from '../../src/platform/types';
import { FakeIpc, fakeBridge, flush } from './fake-ipc';

const card = { id: '/media/anna/TONUINO', label: 'TONUINO', mountPath: '/media/anna/TONUINO', fsType: 'vfat', clusterSize: 32768, totalBytes: 32e9, freeBytes: 20e9, removable: true, device: '/dev/sdb1', canEject: true };

function platformWithCard() {
  const ipc = new FakeIpc();
  ipc.on('volumes_list', () => [card]);
  ipc.on('dialog_pick_folder', () => ({ path: '/home/anna/Sicherungen', name: 'Sicherungen' }));
  ipc.on('volume_info', (args) => {
    expect(args).toEqual({ path: '/home/anna/Sicherungen' });
    return { fsType: 'ext4', clusterSize: 4096, totalBytes: 500e9, freeBytes: 120e9, removable: false, device: '/dev/nvme0n1p2', mountPath: '/', canEject: false };
  });
  return { ipc, p: createTauriPlatform({ ipc, os: 'linux' }) };
}

describe('pickBackupFolder (desktop)', () => {
  it('asks for a folder with write access and hands it over without adding a card', async () => {
    const { ipc, p } = platformWithCard();
    const lists: Volume[][] = [];
    p.volumes.subscribe((v) => lists.push(v));
    await flush();
    const dir = await p.pickBackupFolder();
    expect(dir).toBeInstanceOf(TauriDir);
    expect(dir?.path).toBe('/home/anna/Sicherungen');
    expect(ipc.callsOf('dialog_pick_folder')[0].args).toEqual({ purpose: 'card', title: 'Ordner für die Sicherung wählen' });
    await flush();
    // Still only the card: the backup folder is no volume.
    expect(lists.at(-1)?.map((v) => v.id)).toEqual([card.id]);
    expect(lists).toHaveLength(1);
  });

  it('names the other card in the title when copying', async () => {
    const { ipc, p } = platformWithCard();
    await p.pickBackupFolder({ purpose: 'copy' });
    expect(ipc.callsOf('dialog_pick_folder')[0].args).toMatchObject({ title: 'SD-Karte der anderen Box wählen' });
    await p.pickBackupFolder({ purpose: 'export' });
    expect(ipc.callsOf('dialog_pick_folder')[1].args).toMatchObject({ purpose: 'card', title: 'Ordner auf dem Computer wählen' });
  });

  it('resolves null when the dialog is cancelled', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('dialog_pick_folder', () => null);
    const p = createTauriPlatform({ ipc: bridge.ipc as FakeIpc, os: 'linux' });
    expect(await p.pickBackupFolder()).toBeNull();
  });

  it('tells the free space and the drive of the folder', async () => {
    const { p } = platformWithCard();
    const dir = (await p.pickBackupFolder())!;
    expect(await p.folderInfo!(dir)).toEqual({ fsType: 'ext4', clusterSize: 4096, totalBytes: 500e9, freeBytes: 120e9, removable: false, device: '/dev/nvme0n1p2', mountPath: '/' });
  });

  it('sees a backup folder on the card itself', async () => {
    const { bridge } = fakeBridge();
    const p = createTauriPlatform({ ipc: new FakeIpc(), os: 'linux' });
    const cardDir = new TauriDir(bridge, '/media/anna/TONUINO');
    expect(await p.isWithin(new TauriDir(bridge, '/media/anna/TONUINO/Sicherung'), cardDir)).toBe(true);
    expect(await p.isWithin(new TauriDir(bridge, '/media/anna/TONUINO2'), cardDir)).toBe(false);
  });
});

describe('pathWithin', () => {
  it('compares like the system does', () => {
    expect(pathWithin('E:\\Sicherung', 'e:\\', 'windows')).toBe(true);
    expect(pathWithin('E:\\', 'E:', 'windows')).toBe(true);
    expect(pathWithin('D:\\Sicherung', 'E:\\', 'windows')).toBe(false);
    expect(pathWithin('/media/a/SD/', '/media/a/SD', 'linux')).toBe(true);
    expect(pathWithin('/media/a/sd/x', '/media/a/SD', 'linux')).toBe(false);
    expect(pathWithin('/home/a', '/', 'linux')).toBe(true);
  });
});
