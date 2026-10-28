/**
 * In the Box-Logbuch, next to the Steckbrief: shown only when the box counts
 * the tracks of a folder differently from the open SD card, which points to
 * a copied MP3 player (core/tonuino/mp3clone.ts). When a firmware for the
 * player's chip helps (core/firmware/mp3chip.ts), it says where to choose it.
 */
import { Cpu } from 'lucide-preact';
import type { BoxInfo } from '../../core/firmware/bootlog';
import { cloneAdvice, detectClonePlayer } from '../../core/tonuino/mp3clone';
import { routeToHash } from '../../app/router';
import { card } from '../../app/state';
import { trackCounts } from '../cards/items';

export function CloneHint({ info }: { info: BoxInfo }) {
  const scan = card.value?.status === 'ready' ? card.value.scan : undefined;
  if (!scan || !Object.keys(info.folderTracks).length) return null;
  const finding = detectClonePlayer(info.folderTracks, trackCounts(scan));
  if (!finding) return null;
  const t = cloneAdvice(finding);
  return (
    <section class="card" aria-labelledby="ws-clone-title">
      <div class="card-header">
        <h2 id="ws-clone-title" class="row tight">
          <Cpu size={18} aria-hidden="true" /> {t.title}
        </h2>
      </div>
      <div class="card-body stack tight">
        <p>{t.text}</p>
        <p class="small soft">{t.example}</p>
        {t.chip ? (
          <p class="small">
            Abhilfe: eine Firmware für diesen Chip. {t.chip.look ? `${t.chip.look} ` : ''}Du wählst ihn unter{' '}
            <a href={routeToHash({ page: 'workshop', tool: 'firmware' })}>Firmware aufspielen → Extras → „Mehr“</a>. Die SD-Karte musst du dafür nicht ändern.
          </p>
        ) : null}
        {t.remedy ? <p class="small">{t.remedy}</p> : null}
      </div>
    </section>
  );
}
