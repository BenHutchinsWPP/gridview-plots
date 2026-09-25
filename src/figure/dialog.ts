// src/figure/dialog.ts
//
// The Figure dialog: a live preview of the print figure a pane makes, its
// size, and the download. It holds the pane's lines as they were when the
// button was clicked (`FigureCapture`), as the drawer's downloads capture
// theirs, so the figure cannot disagree with what was on screen, and a
// repaint behind the dialog does not move it.
//
// The preview is the exported SVG itself, shown as an image, so what the
// dialog shows is what Word gets; a PNG or JPG is that SVG rasterised.
//
// Text edits and the caption live in this dialog's closure and nowhere else:
// they fix one export's wording, and the next figure starts from the app's
// own labels.

import {
  FIGURE_SIZES,
  buildFigure,
  type Figure,
  type FigureCapture,
  type FigureInput,
  type FigureSize,
} from './build';
import { RASTER_DPI, rasterFont, rasterPixels, rasterise, type RasterFormat } from './raster';
import { FONT_FAMILY } from './svg';
import { saveBlob } from '../ui/download';

type Format = 'svg' | RasterFormat;
const EXTENSIONS: Record<Format, string> = { svg: 'svg', png: 'png', jpeg: 'jpg' };

export interface FigureDialogRequest {
  readonly capture: FigureCapture;
  /** The hour filter the pane was drawn under, as a sentence. */
  readonly hourFilter: string;
}

/** Custom sizes are held to what fits a page with room to spare. */
const MIN_IN = 1;
const MAX_IN = 11;

/** Text widths from the browser's own font stack, in points at `fontPt`. */
function canvasMeasurer(): FigureInput['measureText'] {
  const context = document.createElement('canvas').getContext('2d');
  return (text, fontPt) => {
    // Without a 2D context, an average glyph is about half an em.
    if (!context) return text.length * fontPt * 0.55;
    context.font = `${fontPt}px ${FONT_FAMILY}`;
    return context.measureText(text).width;
  };
}

/** An error as a clause, without its own full stop, to sit inside a sentence. */
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.+$/, '');
}

/** What an edit box is labelled with, from its text id. */
function textIdLabel(id: string): string {
  if (id === 'context') return 'Context line';
  if (id === 'axis.x') return 'x-axis title';
  const axis = /^axis\.y\[(\d+)\]$/.exec(id);
  if (axis) return axis[1] === '0' ? 'Left axis title' : 'Right axis title';
  const note = /^footnote\[(\d+)\]$/.exec(id);
  if (note) return `Footnote ${Number(note[1]) + 1}`;
  const cell = /^legend\[(\d+)\]\[(\d+|under)\]$/.exec(id);
  if (cell) {
    const row = `Legend row ${Number(cell[1]) + 1}`;
    return cell[2] === 'under' ? `${row}, second line` : `${row}, cell ${Number(cell[2]) + 1}`;
  }
  return id;
}

function option(select: HTMLSelectElement, value: string, label: string): void {
  const entry = document.createElement('option');
  entry.value = value;
  entry.textContent = label;
  select.appendChild(entry);
}

function inchInput(value: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(MIN_IN);
  input.max = String(MAX_IN);
  input.step = '0.05';
  input.value = String(value);
  input.className = 'figure-inch';
  return input;
}

function field(caption: string, control: HTMLElement, after?: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'modal-field';
  label.append(caption, control);
  if (after) label.append(after);
  return label;
}

export function openFigureDialog(request: FigureDialogRequest): void {
  const measureText = canvasMeasurer();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal modal-wide';
  backdrop.appendChild(modal);

  const title = document.createElement('h2');
  title.textContent = 'Figure';
  const subtitle = document.createElement('p');
  subtitle.className = 'modal-subtitle';
  subtitle.textContent =
    'The chart as this pane shows it, laid out for a Letter page. SVG stays sharp at any ' +
    'size in Word 365 and Word 2019 or later; PNG works in any Word.';

  const preview = document.createElement('div');
  preview.className = 'figure-preview';
  const image = document.createElement('img');
  image.alt = 'Figure preview';
  preview.appendChild(image);

  const size = document.createElement('select');
  option(size, 'half', `Half page (${FIGURE_SIZES.half.width} × ${FIGURE_SIZES.half.height} in)`);
  option(size, 'full', `Full width (${FIGURE_SIZES.full.width} × ${FIGURE_SIZES.full.height} in)`);
  option(size, 'custom', 'Custom');
  const width = inchInput(FIGURE_SIZES.half.width);
  const height = inchInput(FIGURE_SIZES.half.height);
  const widthField = field('Width ', width, ' in');
  const heightField = field('Height ', height, ' in');
  // PNG first among the rasters: a line chart's edges blur under JPEG.
  const format = document.createElement('select');
  option(format, 'svg', 'SVG (vector)');
  option(format, 'png', 'PNG, 300 dpi (recommended)');
  option(format, 'jpeg', 'JPG, 300 dpi');
  format.value = 'png';
  const printDashes = document.createElement('input');
  printDashes.type = 'checkbox';
  const controls = document.createElement('div');
  controls.className = 'figure-controls';
  controls.append(
    field('Size ', size),
    widthField,
    heightField,
    field('Format ', format),
    field('', printDashes, ' Dashes for black-and-white print'),
  );

  const captionBox = document.createElement('textarea');
  captionBox.className = 'figure-caption';
  captionBox.rows = 2;
  const copyCaption = document.createElement('button');
  copyCaption.type = 'button';
  copyCaption.className = 'btn';
  copyCaption.textContent = 'Copy caption';
  const captionRow = document.createElement('div');
  captionRow.className = 'figure-caption-row';
  const captionLabel = document.createElement('span');
  captionLabel.className = 'modal-subtitle';
  captionLabel.textContent = 'Caption, for Word’s Insert Caption:';
  captionRow.append(captionLabel, captionBox, copyCaption);

  // Collapsed: most figures go out with the app's own labels.
  const textPanel = document.createElement('details');
  textPanel.className = 'figure-texts';
  const textSummary = document.createElement('summary');
  textSummary.textContent = 'Edit figure text (this export only)';
  const textGrid = document.createElement('div');
  textGrid.className = 'figure-text-grid';
  textPanel.append(textSummary, textGrid);

  const crowdNote = document.createElement('p');
  crowdNote.className = 'modal-readout';

  const status = document.createElement('p');
  status.className = 'modal-readout';
  // Measured once: the browser's fonts do not change while the dialog is up.
  const font = rasterFont();
  const fontNote = document.createElement('p');
  fontNote.className = 'modal-readout';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = 'Close';
  const copyNote = document.createElement('span');
  copyNote.className = 'modal-subtitle figure-copy-note';
  copyNote.textContent =
    'Word sizes a pasted image to the text width; Download keeps the exact size.';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn';
  copy.textContent = 'Copy image';
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'btn btn-primary';
  actions.append(copyNote, close, copy, download);

  const body = document.createElement('div');
  body.className = 'figure-body';
  body.append(preview, controls, crowdNote, captionRow, textPanel, fontNote, status);
  modal.append(title, subtitle, body, actions);

  /** Per-export text by id (`FigureInput.edits`), caption included. */
  const edits: Record<string, string> = {};
  let figure: Figure | null = null;
  let editIds = '';
  let svg = '';
  let url = '';
  let shownSize: FigureSize = FIGURE_SIZES.half;

  function chosenSize(): FigureSize {
    const preset = size.value === 'full' ? FIGURE_SIZES.full : FIGURE_SIZES.half;
    if (size.value !== 'custom') return preset;
    const inches = (input: HTMLInputElement, fallback: number) => {
      const value = Number(input.value);
      return Number.isFinite(value) ? Math.min(MAX_IN, Math.max(MIN_IN, value)) : fallback;
    };
    return { width: inches(width, preset.width), height: inches(height, preset.height) };
  }

  function chosenFormat(): Format {
    return format.value === 'svg' || format.value === 'jpeg' ? format.value : 'png';
  }

  /** What the chosen format is drawn with, said only when it is not Aptos. */
  function describeFormat(): void {
    const chosen = chosenFormat();
    download.textContent = `Download ${EXTENSIONS[chosen].toUpperCase()}`;
    if (chosen === 'svg') {
      fontNote.textContent = '';
      return;
    }
    const { width: w, height: h } = rasterPixels(shownSize);
    const pixels = `${w.toLocaleString('en-US')} × ${h.toLocaleString('en-US')} px at ${RASTER_DPI} dpi.`;
    fontNote.textContent =
      font === 'Aptos'
        ? pixels
        : `${pixels} Aptos is not available to this browser, so the ` +
          `${EXTENSIONS[chosen].toUpperCase()} is set in ${font}. The SVG names Aptos first, ` +
          'and Word draws it in Aptos where it is installed.';
  }

  function rebuild(): void {
    const chosen = chosenSize();
    shownSize = chosen;
    width.disabled = height.disabled = size.value !== 'custom';
    if (size.value !== 'custom') {
      width.value = String(chosen.width);
      height.value = String(chosen.height);
    }
    try {
      figure = buildFigure({
        ...request.capture,
        hourFilter: request.hourFilter,
        size: chosen,
        measureText,
        edits,
        printDashes: printDashes.checked,
      });
      svg = figure.svg;
      showTexts(figure);
      crowdNote.textContent = !figure.crowded
        ? ''
        : 'The legend and footnotes leave the plot less than half the figure’s height. ' +
          (size.value === 'half'
            ? `Full width (${FIGURE_SIZES.full.width} × ${FIGURE_SIZES.full.height} in) gives it more room.`
            : 'A taller size gives it more room.');
      status.textContent = '';
      download.disabled = copy.disabled = false;
    } catch (error) {
      figure = null;
      svg = '';
      crowdNote.textContent = '';
      status.textContent = `This pane cannot be exported: ${reason(error)}.`;
      download.disabled = copy.disabled = true;
    }
    describeFormat();
    if (url) URL.revokeObjectURL(url);
    url = svg ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) : '';
    image.src = url;
  }

  /** One box per drawn text, built again only when the set of ids moves, so
   * typing in a box does not lose its focus to the rebuild it causes. */
  function showTexts(built: Figure): void {
    if (document.activeElement !== captionBox) captionBox.value = built.caption;
    const drawn = built.texts.filter((entry) => entry.id !== 'caption');
    const ids = drawn.map((entry) => entry.id).join('|');
    if (ids === editIds) return;
    editIds = ids;
    textGrid.replaceChildren();
    for (const entry of drawn) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'modal-filter';
      input.value = entry.text;
      input.dataset.textId = entry.id;
      input.addEventListener('input', () => {
        edits[entry.id] = input.value;
        schedule();
      });
      const label = document.createElement('label');
      label.textContent = textIdLabel(entry.id);
      textGrid.append(label, input);
    }
  }

  // Typing rebuilds at most once a frame: thinning a year of lines per key
  // would otherwise trail the keyboard.
  let pending = 0;
  function schedule(): void {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      rebuild();
    });
  }

  function finish(): void {
    if (pending) cancelAnimationFrame(pending);
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (url) URL.revokeObjectURL(url);
  }
  // Capture phase, and it stops propagation, as the other dialogs do: an
  // Escape meant for this dialog must not reach anything behind it.
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    finish();
  }

  size.addEventListener('change', rebuild);
  width.addEventListener('change', rebuild);
  height.addEventListener('change', rebuild);
  format.addEventListener('change', describeFormat);
  printDashes.addEventListener('change', rebuild);
  captionBox.addEventListener('input', () => {
    edits.caption = captionBox.value;
    schedule();
  });
  copyCaption.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(captionBox.value);
      status.textContent = 'Caption copied.';
    } catch (error) {
      status.textContent = `The clipboard refused the caption: ${reason(error)}. Select it and copy it instead.`;
    }
  });
  close.addEventListener('click', finish);

  /** The chosen file's bytes, or null with the reason in the status line. */
  async function encoded(chosen: Format): Promise<Blob | null> {
    if (!svg) return null;
    if (chosen === 'svg') return new Blob([svg], { type: 'image/svg+xml' });
    try {
      return await rasterise(svg, shownSize, chosen, figure?.caption);
    } catch (error) {
      status.textContent = `The ${EXTENSIONS[chosen].toUpperCase()} could not be drawn: ${reason(error)}.`;
      return null;
    }
  }

  download.addEventListener('click', async () => {
    const chosen = chosenFormat();
    const blob = await encoded(chosen);
    if (!blob) return;
    saveBlob(blob, `${figure?.fileStem ?? 'figure'}.${EXTENSIONS[chosen]}`);
  });
  // The clipboard takes a PNG whatever the chosen format: Word pastes it,
  // and Chromium re-encodes it without its dpi, hence the note beside it.
  copy.addEventListener('click', async () => {
    const blob = await encoded('png');
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status.textContent = 'Copied as a PNG.';
    } catch (error) {
      status.textContent = `The clipboard refused the image: ${reason(error)}. Download it instead.`;
    }
  });
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(backdrop);
  rebuild();
  download.focus();
}
