// src/figure/svg.ts
//
// The only place figure markup is spelled, so every element a figure holds is
// one Word can draw. Word 365 renders SVG with a narrower engine than a
// browser: it reads presentation attributes but not `class`, `<style>`, CSS
// variables or `foreignObject`, and it ignores `dominant-baseline`,
// `vector-effect` and, in places, `clipPath`. So text sits on an explicit
// baseline `y`, the caller crops data itself, and each `<text>` names its own
// fonts with Aptos first, since Office may read only the first family.
//
// Coordinates are points: the document is sized in inches with a `viewBox`
// of 72 units per inch, so a 9 pt label is `font-size="9"`.

/** Word's default body font, then what Office and every browser has. */
export const FONT_FAMILY = 'Aptos, Calibri, Arial, sans-serif';

/** Points per inch: the `viewBox` unit. */
export const PT_PER_IN = 72;

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A coordinate at a hundredth of a point: finer is invisible at 300 dpi and
 * only lengthens the file. */
export function pt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export interface TextStyle {
  readonly size: number;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly fill?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Degrees about the text's own anchor point: -90 reads bottom to top. */
  readonly rotate?: number;
}

/** One line of text with its baseline at `y`. */
export function text(content: string, x: number, y: number, style: TextStyle): string {
  const attrs = [
    `x="${pt(x)}"`,
    `y="${pt(y)}"`,
    `font-family="${FONT_FAMILY}"`,
    `font-size="${pt(style.size)}"`,
    `fill="${style.fill ?? '#000000'}"`,
  ];
  if (style.anchor && style.anchor !== 'start') attrs.push(`text-anchor="${style.anchor}"`);
  if (style.bold) attrs.push('font-weight="bold"');
  if (style.italic) attrs.push('font-style="italic"');
  if (style.rotate) attrs.push(`transform="rotate(${style.rotate} ${pt(x)} ${pt(y)})"`);
  return `<text ${attrs.join(' ')}>${escapeXml(content)}</text>`;
}

export interface StrokeStyle {
  readonly color: string;
  readonly width: number;
  readonly dash?: readonly number[];
}

function strokeAttrs(style: StrokeStyle): string {
  const attrs = [`stroke="${style.color}"`, `stroke-width="${pt(style.width)}"`];
  if (style.dash && style.dash.length > 0) {
    attrs.push(`stroke-dasharray="${style.dash.map(pt).join(' ')}"`);
  }
  return attrs.join(' ');
}

export function line(x1: number, y1: number, x2: number, y2: number, style: StrokeStyle): string {
  return `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" ${strokeAttrs(style)}/>`;
}

/** An open polyline through `points`, as one path. */
export function polyline(
  points: readonly (readonly [number, number])[],
  style: StrokeStyle,
): string {
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${pt(x)} ${pt(y)}`).join('');
  // A round cap lengthens every dash by the pen width and closes its gaps,
  // so a dashed line takes a flat one.
  const cap = style.dash && style.dash.length > 0 ? 'butt' : 'round';
  return (
    `<path d="${d}" fill="none" ${strokeAttrs(style)} ` +
    `stroke-linejoin="round" stroke-linecap="${cap}"/>`
  );
}

/** A filled rectangle with an outline. */
export function outlinedRect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: StrokeStyle,
): string {
  return (
    `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(width)}" height="${pt(height)}" ` +
    `fill="${fill}" ${strokeAttrs(stroke)}/>`
  );
}

/** A closed, unstroked shape through `points`, as one path. */
export function polygon(points: readonly (readonly [number, number])[], fill: string): string {
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${pt(x)} ${pt(y)}`).join('');
  return `<path d="${d}Z" fill="${fill}" stroke="none"/>`;
}

/**
 * `color` at `alpha` over the white page, as an opaque colour. A figure's
 * background is always white, so this looks as a translucent fill does, and
 * Word never has to composite.
 */
export function tint(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const channel = (at: number) => {
    const value = parseInt(match[1].slice(at, at + 2), 16);
    return Math.round(255 - (255 - value) * alpha)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

export function circle(cx: number, cy: number, r: number, fill: string): string {
  return `<circle cx="${pt(cx)}" cy="${pt(cy)}" r="${pt(r)}" fill="${fill}"/>`;
}

export function rect(x: number, y: number, width: number, height: number, fill: string): string {
  return `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(width)}" height="${pt(height)}" fill="${fill}"/>`;
}

/**
 * The whole document: sized in inches, a `viewBox` in points and a white
 * background, since a transparent figure takes the colour of whatever Word
 * puts behind it. `title` and `desc` carry the caption when there is one, so
 * a file found later still says what it shows.
 */
export function svgDocument(
  widthIn: number,
  heightIn: number,
  body: readonly string[],
  meta: { readonly title?: string; readonly desc?: string } = {},
): string {
  const w = widthIn * PT_PER_IN;
  const h = heightIn * PT_PER_IN;
  const head = [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${pt(widthIn)}in" ` +
      `height="${pt(heightIn)}in" viewBox="0 0 ${pt(w)} ${pt(h)}">`,
  ];
  if (meta.title) head.push(`<title>${escapeXml(meta.title)}</title>`);
  if (meta.desc) head.push(`<desc>${escapeXml(meta.desc)}</desc>`);
  head.push(rect(0, 0, w, h, '#ffffff'));
  return [...head, ...body, '</svg>'].join('\n') + '\n';
}
