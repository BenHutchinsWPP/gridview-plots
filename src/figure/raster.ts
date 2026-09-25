// src/figure/raster.ts
//
// A figure's PNG and JPG: the figure's own SVG drawn onto a canvas at 300 dpi
// and stamped with that resolution (`dpi.ts`). No second renderer, so the
// three formats cannot disagree.
//
// The SVG is drawn from a same-origin blob URL; a data URL or a cross-origin
// image would taint the canvas and `toBlob` would refuse.
//
// **An SVG drawn as an image can use only fonts installed on the system**, and
// Office often installs Aptos where the browser cannot see it. `rasterFont`
// names the family a PNG was actually set in, so the dialog can say so. It
// compares measured widths against a generic family: `document.fonts.check`
// answers true for any font the page did not declare, installed or not.

import { stampJpeg, stampPng } from './dpi';
import type { FigureSize } from './build';

export type RasterFormat = 'png' | 'jpeg';

/** Word inserts an image at its stated resolution; 300 dpi prints sharply. */
export const RASTER_DPI = 300;

/** A raster's pixel size: 1,950 × 1,125 at the default 6.5" × 3.75". */
export function rasterPixels(size: FigureSize): { width: number; height: number } {
  return {
    width: Math.round(size.width * RASTER_DPI),
    height: Math.round(size.height * RASTER_DPI),
  };
}

/** The families `FONT_FAMILY` names, in the order a renderer tries them. */
const NAMED_FAMILIES = ['Aptos', 'Calibri', 'Arial'];

/** The first named family this browser can draw, or the generic fallback. */
export function rasterFont(): string {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return 'sans-serif';
  const probe = 'mmmmmmmmmmlli WW 0123456789';
  const width = (family: string): number => {
    context.font = `72px ${family}`;
    return context.measureText(probe).width;
  };
  // Two generics, so a font that happens to match one's metrics still shows.
  const installed = (family: string): boolean =>
    width(`${family}, monospace`) !== width('monospace') ||
    width(`${family}, serif`) !== width('serif');
  return NAMED_FAMILIES.find(installed) ?? 'sans-serif';
}

/** The figure as a stamped PNG or JPEG. A PNG carries `caption`. */
export async function rasterise(
  svg: string,
  size: FigureSize,
  format: RasterFormat,
  caption?: string,
): Promise<Blob> {
  const { width, height } = rasterPixels(size);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('this browser gave no canvas to draw on');
    // JPEG has no transparency; white is what the figure's own background is.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const mime = `image/${format}`;
    const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.95));
    if (!encoded) throw new Error(`this browser could not encode a ${format.toUpperCase()}`);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const stamped =
      format === 'png' ? stampPng(bytes, RASTER_DPI, caption) : stampJpeg(bytes, RASTER_DPI);
    return new Blob([stamped as Uint8Array<ArrayBuffer>], { type: mime });
  } finally {
    URL.revokeObjectURL(url);
  }
}
