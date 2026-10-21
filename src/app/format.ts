/** Formatting helpers for German UI texts. */

const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${nf0.format(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${nf1.format(n / 1024 ** 2)} MB`;
  return `${nf1.format(n / 1024 ** 3)} GB`;
}

/** 3725 → "1 Std. 2 Min.", 95 → "1:35 Min." */
export function formatDuration(sec: number | undefined, opts: { long?: boolean } = {}): string {
  if (sec === undefined || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} Std.${m ? ` ${m} Min.` : ''}`;
  if (opts.long) return m ? `${m} Min.${r ? ` ${r} Sek.` : ''}` : `${r} Sek.`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;
}

export function folderLabel(n: number): string {
  return String(n).padStart(2, '0');
}
