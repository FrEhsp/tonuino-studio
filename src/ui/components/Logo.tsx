
/** The app mark; the sidebar shows it a little bigger than the default. */
export function LogoMark({ size = 36 }: { size?: number }) {
  return <HolzMark size={size} />;
}

/**
 * The mark: a little wooden box with a drilled speaker and three buttons in a row,
 * and a card with a sticker going on top. Drawn by hand, in the spirit of
 * the boxes people build; deliberately not the TonUINO logo.
 */
function HolzMark({ size }: { size: number }) {
  const holes = [0, 60, 120, 180, 240, 300].map((a) => [32 + 7.4 * Math.cos((a * Math.PI) / 180), 38.5 + 7.4 * Math.sin((a * Math.PI) / 180)]);
  return (
    <svg class="logo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g filter="url(#ts-wobble-art)" stroke="#2a1f16" stroke-linejoin="round" stroke-linecap="round">
        <path d="M7.4 25.6 L57.2 24.2 L58.3 59.4 L6.1 60.4 Z" fill="#c98c50" stroke-width="3" />
        <path d="M9.8 31.2 C13 30.6 16 31.6 19.5 30.9 M44.5 30.6 C48 30 51 31.2 54.6 30.5" fill="none" stroke="#8c6238" stroke-width="1.5" />
        <circle cx="32" cy="38.5" r="2.4" fill="#2a1f16" stroke="none" />
        {holes.map(([x, y]) => (
          <circle cx={x} cy={y} r="1.8" fill="#2a1f16" stroke="none" />
        ))}
        <circle cx="19.5" cy="53.2" r="3.7" fill="#e5483b" stroke-width="2.2" />
        <circle cx="32" cy="53" r="4.3" fill="#f6c12c" stroke-width="2.2" />
        <circle cx="44.5" cy="52.8" r="3.7" fill="#3f8fd6" stroke-width="2.2" />
        <g transform="rotate(-13 35 13)">
          <rect x="21.5" y="2.5" width="27" height="19" rx="3" fill="#fffcf5" stroke-width="2.6" />
          <rect x="24.6" y="5.6" width="11.6" height="12.8" rx="1.4" fill="#9c5d98" stroke-width="1.6" />
          <path d="M40.4 9.2c1.3 1.5 1.3 3.6 0 5.1 M43.6 7.4c2.4 2.6 2.4 6.7 0 9.3" fill="none" stroke-width="1.6" />
        </g>
      </g>
    </svg>
  );
}

/**
 * The sidebar's name plate, a link to the start page. Its class is not
 * "brand": that one is a badge tone (badge brand). The label keeps it apart
 * from the menu item "Meine Box", which leads to the same page (in the
 * Android app: "Karten", its start page).
 */
export function Logo({ home = '#/' }: { home?: string }) {
  return (
    <a class="app-brand" href={home} aria-label="TonUINO Studio, Startseite">
      <LogoMark size={44} />
      <div class="brand-name">
        <span class="brand-word">TonUINO</span> <span class="brand-studio">Studio</span>
        <small>für deine TonUINO-Box</small>
      </div>
    </a>
  );
}
