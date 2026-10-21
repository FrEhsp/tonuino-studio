import { describe, expect, it } from 'vitest';
import type { Volume } from '../../src/platform/types';
import { samePath, TauriVolumes, type VolumeDto } from '../../src/platform/tauri/volumes';
import { fakeBridge, flush } from './fake-ipc';

function dto(mountPath: string, patch: Partial<VolumeDto> = {}): VolumeDto {
  return {
    id: mountPath,
    label: mountPath.split('/').pop()!,
    mountPath,
    fsType: 'vfat',
    clusterSize: 32768,
    totalBytes: 8e9,
    freeBytes: 4e9,
    removable: true,
    device: '/dev/sdb1',
    canEject: true,
    ...patch,
  };
}

describe('TauriVolumes', () => {
  it('delivers the initial list, then every change event', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('volumes_list', () => [dto('/media/anna/TONUINO')]);
    const watcher = new TauriVolumes(bridge);
    const seen: Volume[][] = [];
    const stop = watcher.subscribe((v) => seen.push(v));
    await flush();
    expect(seen).toHaveLength(1);
    const [card] = seen[0];
    expect(card.id).toBe('/media/anna/TONUINO');
    expect(card.label).toBe('TONUINO');
    expect(card.canEject).toBe(true);
    expect(card.root.path).toBe('/media/anna/TONUINO');
    expect(card.info).toEqual({ fsType: 'vfat', clusterSize: 32768, totalBytes: 8e9, freeBytes: 4e9, removable: true, device: '/dev/sdb1' });

    ipc.emit('volumes-changed', [dto('/media/anna/TONUINO', { freeBytes: 1e9 }), dto('/media/anna/SD2', { device: '/dev/sdc1' })]);
    expect(seen).toHaveLength(2);
    expect(seen[1].map((v) => v.id)).toEqual(['/media/anna/TONUINO', '/media/anna/SD2']);
    // The same card keeps its object, so the UI does not reopen it.
    expect(seen[1][0]).toBe(card);
    expect(card.info.freeBytes).toBe(1e9);

    // A late subscriber gets the current list at once.
    const late: Volume[][] = [];
    const stopLate = watcher.subscribe((v) => late.push(v));
    expect(late[0].map((v) => v.id)).toEqual(['/media/anna/TONUINO', '/media/anna/SD2']);
    stopLate();
    stop();
    expect(ipc.listenerCount('volumes-changed')).toBe(0);
  });

  it('keeps picked folders in the list until their card goes away', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('volumes_list', () => [dto('/media/anna/USB')]);
    ipc.on('dialog_pick_folder', () => ({ path: '/media/anna/USB/tonuino', name: 'tonuino' }));
    ipc.on('volume_info', () => ({
      fsType: 'exfat',
      clusterSize: 131072,
      totalBytes: 64e9,
      freeBytes: 1e9,
      removable: true,
      device: '/dev/sdd1',
      mountPath: '/media/anna/USB',
      canEject: false,
    }));
    const watcher = new TauriVolumes(bridge);
    const seen: Volume[][] = [];
    watcher.subscribe((v) => seen.push(v));
    await flush();
    const picked = await watcher.pick();
    expect(ipc.callsOf('dialog_pick_folder')[0].args).toMatchObject({ purpose: 'card' });
    expect(picked).toMatchObject({ id: '/media/anna/USB/tonuino', label: 'tonuino', canEject: false });
    expect(picked!.info.clusterSize).toBe(131072);
    expect(seen.at(-1)!.map((v) => v.id)).toEqual(['/media/anna/USB', '/media/anna/USB/tonuino']);
    // Picking the same folder again returns the same volume.
    expect(await watcher.pick()).toBe(picked);
    ipc.emit('volumes-changed', []);
    expect(seen.at(-1)).toEqual([]);
  });

  it('forgets picked folders on request', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('volumes_list', () => []);
    ipc.on('dialog_pick_folder', () => ({ path: '/home/anna/Box-Kopie', name: 'Box-Kopie' }));
    ipc.on('volume_info', () => ({ fsType: 'ext4', clusterSize: 4096, totalBytes: 1, freeBytes: 1, removable: false, device: '/dev/nvme0n1p2', mountPath: '/', canEject: false }));
    const watcher = new TauriVolumes(bridge);
    const seen: Volume[][] = [];
    watcher.subscribe((v) => seen.push(v));
    await flush();
    const picked = (await watcher.pick())!;
    expect(seen.at(-1)!.map((v) => v.label)).toEqual(['Box-Kopie']);
    await watcher.forget(picked);
    expect(seen.at(-1)).toEqual([]);
  });

  it('ejects by mount path and refuses folders', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('volumes_list', () => [dto('/media/anna/TONUINO')]);
    ipc.on('volume_eject', () => {
      throw { code: 'busy', detail: 'target is busy' };
    });
    const watcher = new TauriVolumes(bridge);
    let list: Volume[] = [];
    watcher.subscribe((v) => (list = v));
    await flush();
    const err = await watcher.eject(list[0]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'busy' });
    expect((err as Error).message).toMatch(/noch benutzt/);
    expect(ipc.callsOf('volume_eject')[0].args).toEqual({ mountPath: '/media/anna/TONUINO' });
    await expect(watcher.eject({ ...list[0], canEject: false })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('carries what the app may do on the card', async () => {
    const { ipc, bridge } = fakeBridge();
    const mnt = '/mnt/usb-Generic_STORAGE_DEVICE_000000000819-0:0-part1';
    ipc.on('volumes_list', () => [dto(mnt, { writable: false, readOnly: false, foreignOwner: true, canFixAccess: true })]);
    const watcher = new TauriVolumes(bridge);
    let list: Volume[] = [];
    watcher.subscribe((v) => (list = v));
    await flush();
    expect(list[0].info).toMatchObject({ writable: false, foreignOwner: true, canFixAccess: true });
    expect(list[0].info.readOnly).toBeUndefined();
  });

  it('"Schreibrechte holen" mounts the card again and hands back the card at its new place', async () => {
    const { ipc, bridge } = fakeBridge();
    const before = dto('/media/root/TONUINO', { writable: false, foreignOwner: true, canFixAccess: true });
    const after = dto('/media/ben/TONUINO', { writable: true });
    let mounted = before;
    ipc.on('volumes_list', () => [mounted]);
    ipc.on('volume_fix_access', () => {
      mounted = after;
      return after;
    });
    const watcher = new TauriVolumes(bridge);
    let list: Volume[] = [];
    watcher.subscribe((v) => (list = v));
    await flush();
    const fresh = await watcher.fixAccess(list[0]);
    expect(ipc.callsOf('volume_fix_access')[0].args).toEqual({ mountPath: '/media/root/TONUINO' });
    expect(fresh.id).toBe('/media/ben/TONUINO');
    expect(fresh.info.writable).toBe(true);
    // The list follows without waiting for the event.
    expect(list.map((v) => v.id)).toEqual(['/media/ben/TONUINO']);
    expect(list[0]).toBe(fresh);
  });

  it('says why mounting again failed, with the next step', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('volumes_list', () => [dto('/media/root/TONUINO', { writable: false, canFixAccess: true })]);
    ipc.on('volume_fix_access', () => {
      throw { code: 'permission', detail: 'pkexec remount: Not authorized' };
    });
    const watcher = new TauriVolumes(bridge);
    let list: Volume[] = [];
    watcher.subscribe((v) => (list = v));
    await flush();
    const err = await watcher.fixAccess(list[0]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'permission' });
    expect((err as Error).message).toMatch(/im Dateimanager aus, ziehe sie heraus und stecke sie neu ein/);
  });

  it('reports writes the card refused, with the card they were on', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('volumes_list', () => [dto('/media/anna/TONUINO')]);
    const denied = () => {
      throw { code: 'permission', detail: 'Permission denied (os error 13)' };
    };
    for (const cmd of ['fs_mkdir', 'fs_remove', 'fs_write', 'fs_list']) ipc.on(cmd, denied);
    const watcher = new TauriVolumes(bridge);
    const ids: string[] = [];
    watcher.onWriteDenied((id) => ids.push(id));
    let list: Volume[] = [];
    watcher.subscribe((v) => (list = v));
    await flush();
    const root = list[0].root;
    await expect(root.dir('05', { create: true })).rejects.toMatchObject({ code: 'permission' });
    await expect(root.remove('01', { recursive: true })).rejects.toMatchObject({ code: 'permission' });
    await expect(root.write('x.txt', new Uint8Array([1]))).rejects.toMatchObject({ code: 'permission' });
    // Reading is not writing; paths off the card are not the card's business.
    await expect(root.list()).rejects.toMatchObject({ code: 'permission' });
    await expect(bridge.call('fs', 'fs_mkdir', { path: '/home/anna/Backup' })).rejects.toMatchObject({ code: 'permission' });
    expect(ids).toEqual(['/media/anna/TONUINO', '/media/anna/TONUINO', '/media/anna/TONUINO']);
  });

  it('compares paths per OS', () => {
    expect(samePath('/media/a/', '/media/a', 'linux')).toBe(true);
    expect(samePath('/media/A', '/media/a', 'linux')).toBe(false);
    expect(samePath('E:', 'e:\\', 'windows')).toBe(true);
    expect(samePath('/Volumes/TONUINO', '/volumes/tonuino/', 'macos')).toBe(true);
  });
});
