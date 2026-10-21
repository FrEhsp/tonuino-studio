import { slotRects } from '../../core/stickers/slots';
import type { LabelTemplate } from '../../core/stickers/templates';

/**
 * A small drawing of a label sheet. With `onToggle` every label is a button,
 * so labels that are gone already can be marked. `filled`: which labels
 * carry a sticker (the small sheets of the pager on "Sticker drucken").
 */
export function SheetDiagram({
  template,
  used = [],
  onToggle,
  height = 56,
  filled,
}: {
  template: LabelTemplate;
  used?: number[];
  onToggle?: (slot: number) => void;
  height?: number;
  filled?: readonly boolean[];
}) {
  const { widthMm: pw, heightMm: ph } = template.page;
  const rects = slotRects(template);
  const usedSet = new Set(used);
  const round = template.label.shape === 'round';
  const r = Math.min(template.label.cornerRadiusMm, 4);
  return (
    <svg
      class={`sheet-diagram ${onToggle ? 'interactive' : ''}`}
      viewBox={`0 0 ${pw} ${ph}`}
      style={{ height: onToggle ? undefined : height, aspectRatio: `${pw} / ${ph}` }}
      role={onToggle ? 'group' : 'img'}
      aria-label={onToggle ? 'Etiketten auf dem Bogen' : `Bogen: ${template.name}`}
    >
      <rect class="sheet-page" x={0} y={0} width={pw} height={ph} rx={Math.min(pw, ph) * 0.02} />
      {rects.map((s) => {
        const isUsed = usedSet.has(s.index);
        const shape = round ? (
          <ellipse cx={s.x + s.width / 2} cy={s.y + s.height / 2} rx={s.width / 2} ry={s.height / 2} />
        ) : (
          <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={r} />
        );
        if (!onToggle) {
          return (
            <g class={`sheet-slot ${filled?.[s.index] ? 'filled' : ''} ${isUsed ? 'used' : ''}`} key={s.index}>
              {shape}
            </g>
          );
        }
        return (
          <g
            key={s.index}
            class={`sheet-slot ${isUsed ? 'used' : ''}`}
            role="button"
            tabIndex={0}
            aria-pressed={isUsed}
            aria-label={`Etikett ${s.index + 1}${isUsed ? ', fehlt schon' : ''}`}
            onClick={() => onToggle(s.index)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle(s.index);
              }
            }}
          >
            {shape}
            {rects.length <= 24 ? (
              <text x={s.x + s.width / 2} y={s.y + s.height / 2} dominant-baseline="central" text-anchor="middle" style={{ fontSize: Math.min(s.width, s.height) * 0.32 }}>
                {isUsed ? '✕' : s.index + 1}
              </text>
            ) : isUsed ? (
              <text x={s.x + s.width / 2} y={s.y + s.height / 2} dominant-baseline="central" text-anchor="middle" style={{ fontSize: Math.min(s.width, s.height) * 0.5 }}>
                ✕
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
