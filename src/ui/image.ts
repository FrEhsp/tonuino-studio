/** Browser-only image helpers for covers. */

export const COVER_MAX_PX = 1200;

/** Decodes any image the browser understands and stores it as a reasonably sized JPEG. */
export async function normalizeCover(input: Blob | Uint8Array, mimeType = 'image/jpeg', maxPx = COVER_MAX_PX): Promise<{ data: Uint8Array; mimeType: string; width: number; height: number }> {
  const blob = input instanceof Blob ? input : new Blob([input as BlobPart], { type: mimeType });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error('Das Bild lässt sich nicht öffnen. Nimm ein JPG- oder PNG-Bild.');
  }
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  // Small JPEGs that fit already: keep the original bytes, no quality loss.
  if (scale === 1 && blob.type === 'image/jpeg' && blob.size < 600 * 1024) {
    bitmap.close();
    return { data: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/jpeg', width: w, height: h };
  }
  const out = await drawJpeg(bitmap, w, h);
  return { data: new Uint8Array(await out.arrayBuffer()), mimeType: 'image/jpeg', width: w, height: h };
}

/** Draws on white and encodes as JPEG. Older Safari (before 16.4) has no OffscreenCanvas with 2D: then a page canvas does it. */
async function drawJpeg(bitmap: ImageBitmap, w: number, h: number): Promise<Blob> {
  const draw = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
  };
  try {
    let offscreen: OffscreenCanvas | null = null;
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    try {
      offscreen = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : null;
      ctx = offscreen?.getContext('2d') ?? null;
    } catch {
      // Some engines have OffscreenCanvas without 2D and throw here: the page canvas below does it.
      offscreen = null;
    }
    if (offscreen && ctx && typeof offscreen.convertToBlob === 'function') {
      draw(ctx);
      return await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const pageCtx = canvas.getContext('2d');
    if (!pageCtx) throw new Error('Das Bild lässt sich nicht umrechnen. Lade die Seite neu und versuche es noch einmal.');
    draw(pageCtx);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Das Bild lässt sich nicht umrechnen. Nimm ein kleineres JPG- oder PNG-Bild.'))), 'image/jpeg', 0.9),
    );
  } finally {
    bitmap.close();
  }
}

export function bytesToObjectUrl(data: Uint8Array, mimeType: string): string {
  return URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }));
}
