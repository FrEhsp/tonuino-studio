import { BookOpen, GraduationCap, Headphones, Music, Music2, Shapes } from 'lucide-preact';
import { bestTextColor, fromHex, toCss } from '../../core/stickers/color';

/**
 * Flat sticker colours for folders without a picture, from the TonUINO forum,
 * each with the ink that reads on it (WCAG AA for normal text). No purple:
 * that colour means "do something" in the app. The same in every style and
 * on the printed sticker (src/features/stickers/content.ts), so shelf and
 * sticker sheet always match.
 */
export const COVER_COLORS: readonly { bg: string; fg: string }[] = [
  { bg: '#f7941d', fg: '#161412' },
  { bg: '#9eb83b', fg: '#161412' },
  { bg: '#0e76bd', fg: '#ffffff' },
  { bg: '#12a89d', fg: '#161412' },
  { bg: '#ef2f84', fg: '#161412' },
  { bg: '#fdd459', fg: '#161412' },
  { bg: '#8c6238', fg: '#ffffff' },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** The ink that reads on a background: the palette's own for its colours, else black or white, whichever reads better. */
export function inkOn(bg: string): string {
  const known = COVER_COLORS.find((c) => c.bg === bg.toLowerCase());
  if (known) return known.fg;
  return HEX.test(bg) ? toCss(bestTextColor(fromHex(bg))) : '#161412';
}

export const KIND_ICONS = { hoerspiel: Headphones, hoerbuch: BookOpen, musik: Music, lieder: Music2, wissen: GraduationCap, sonstiges: Shapes };

/**
 * The colour of a folder without a picture: the colour chosen for its sticker
 * when there is one (the sticker sheet uses the same), else one by number.
 */
export function coverColor(seed: number, chosen?: string): { bg: string; fg: string } {
  if (chosen && HEX.test(chosen)) return { bg: chosen.toLowerCase(), fg: inkOn(chosen) };
  return COVER_COLORS[Math.abs(seed) % COVER_COLORS.length];
}

interface CoverProps {
  url?: string;
  title: string;
  seed: number;
  small?: boolean;
  /** The folder number as shown on the shelf ("07"). */
  number?: string;
  /** The colour chosen for the folder's sticker, if any. */
  color?: string;
}

/**
 * A folder cover: the picture when there is one, otherwise a sticker made by
 * hand in one flat colour.
 */
export function Cover(props: CoverProps) {
  if (props.url) return <img class="cover-img" src={props.url} alt="" loading="lazy" draggable={false} />;
  return <HolzCover {...props} />;
}

/**
 * What the printed sticker shows, the folder number in marker
 * (when given) and the title on a strip of paper, on the folder's flat colour.
 * No picture is made up for a folder that has none.
 */
function HolzCover({ title, seed, small, number, color }: CoverProps) {
  const c = coverColor(seed, color);
  const style = { '--gc-bg': c.bg, '--gc-fg': c.fg };
  if (small) {
    return (
      <div class="gen-cover small" style={style} aria-hidden="true">
        {number ? (
          <span class="gen-num">
            {number}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    // Decorative like the photo (alt=""): the tile's own caption names the folder once.
    <div class={`gen-cover ${number ? '' : 'no-num'}`} style={style} aria-hidden="true">
      {number ? (
        <span class="gen-num">
          {number}
        </span>
      ) : null}
      <span class="gen-title">{title}</span>
    </div>
  );
}
