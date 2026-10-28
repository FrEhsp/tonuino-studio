/**
 * The manifest of the Firmware-Baukasten (#30/#32), loaded once from the
 * files that come with the app (src/core/firmware/baukasten.ts). The choice
 * itself is FirmwareBaukasten.tsx (0.6); its panel under „Fertige Firmware“
 * of 0.5 is gone.
 */
import { useEffect, useState } from 'preact/hooks';
import { loadManifest, type BaukastenManifest } from '../../core/firmware/baukasten';
import { noteManifestBuilds } from './boxbuild';

/** Where public/ ends up next to the app („./“ in the web app and the desktop app). */
export const APP_BASE: string = import.meta.env.BASE_URL;

/** The files lie next to the app; no internet is needed. */
export const localFetch = (url: string) => fetch(url);

let manifestLoad: Promise<BaukastenManifest> | null = null;
/** The manifest once it is there, so a screen opened later draws it in its first frame. */
let manifestHere: BaukastenManifest | null = null;

/** The manifest of the Baukasten, loaded once. */
export function baukastenManifest(): Promise<BaukastenManifest> {
  if (!manifestLoad) {
    manifestLoad = loadManifest(localFetch, APP_BASE);
    manifestLoad
      .then((m) => {
        manifestHere = m;
        noteManifestBuilds(m.builds);
      })
      .catch(() => (manifestLoad = null));
  }
  return manifestLoad;
}

export function useBaukastenManifest(): BaukastenManifest | null | 'failed' {
  const [m, setM] = useState<BaukastenManifest | null | 'failed'>(() => manifestHere);
  useEffect(() => {
    if (manifestHere) return;
    let live = true;
    baukastenManifest().then(
      (x) => live && setM(x),
      () => live && setM('failed'),
    );
    return () => {
      live = false;
    };
  }, []);
  return m;
}
