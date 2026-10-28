import { ANDROID_DOWNLOAD_URL, DESKTOP_DOWNLOAD_URL } from './desktopapp';
import { ExternalLink } from './ExternalLink';

/** "Desktop-App herunterladen", where the app recommends it; nothing when the build has no download address. */
export function DesktopAppLink({ class: cls }: { class?: string }) {
  if (!DESKTOP_DOWNLOAD_URL) return null;
  return (
    <ExternalLink href={DESKTOP_DOWNLOAD_URL} class={cls}>
      Desktop-App herunterladen
    </ExternalLink>
  );
}

/** "Android-App herunterladen", in the browser of an Android phone; nothing without a download address. */
export function AndroidAppLink({ class: cls }: { class?: string }) {
  if (!ANDROID_DOWNLOAD_URL) return null;
  return (
    <ExternalLink href={ANDROID_DOWNLOAD_URL} class={cls}>
      Android-App herunterladen
    </ExternalLink>
  );
}
