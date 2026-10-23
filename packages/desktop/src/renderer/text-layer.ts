import { outlineFor, TEXT_FONTS, wrapLines, type TextLayer } from './editor-model.ts';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Interligne, en multiple de la taille de police. */
const LINE_HEIGHT = 1.15;

export function fontFor(layer: Pick<TextLayer, 'font' | 'size'>, height: number): string {
  const font = TEXT_FONTS[layer.font];
  return `${font.weight} ${Math.max(1, layer.size * height)}px ${font.family}`;
}

/**
 * Dessine le texte sur un canvas de `width` x `height`. Sert a l'apercu comme a
 * l'export : position et taille etant relatives, le rendu est le meme a toute
 * resolution. Renvoie le cadre du texte (pour le glisser), null s'il est vide.
 */
export function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer, width: number, height: number): Box | null {
  if (!layer.content.trim()) return null;

  const px = Math.max(1, layer.size * height);
  ctx.save();
  ctx.font = fontFor(layer, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const lines = wrapLines(layer.content, width * 0.9, (text) => ctx.measureText(text).width);
  const lineHeight = px * LINE_HEIGHT;
  const cx = layer.x * width;
  const top = layer.y * height - (lines.length * lineHeight) / 2;

  let widest = 0;
  lines.forEach((line, i) => {
    const y = top + lineHeight * (i + 0.5);
    if (layer.outline) {
      ctx.lineWidth = px * 0.18;
      ctx.strokeStyle = outlineFor(layer.color);
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = layer.color;
    ctx.fillText(line, cx, y);
    widest = Math.max(widest, ctx.measureText(line).width);
  });
  ctx.restore();

  const pad = layer.outline ? px * 0.09 : 0;
  return {
    left: cx - widest / 2 - pad,
    right: cx + widest / 2 + pad,
    top: top - pad,
    bottom: top + lines.length * lineHeight + pad,
  };
}

/** Calque texte seul, transparent, aux dimensions de la source : incruste par ffmpeg. */
export async function renderTextPng(layer: TextLayer, width: number, height: number): Promise<Uint8Array | null> {
  if (!layer.content.trim()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  drawText(canvas.getContext('2d')!, layer, width, height);
  return toBytes(canvas, 'image/png');
}

export async function toBytes(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new Error('Export du canvas impossible.');
  return new Uint8Array(await blob.arrayBuffer());
}
