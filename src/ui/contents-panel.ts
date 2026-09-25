// src/ui/contents-panel.ts
//
// The Contents dialog: what is loaded, and from which file. It edits only
// the About note and what each Case is shown as. It never judges a study complete or incomplete, so there are no "missing"
// badges: a blank cell under a column every kind always has says that already.
//
// A pivot cell is a count, never a list of files: one Case with many metrics
// would otherwise set the height of every row, and a long filename ellipsed
// to fit loses the part that differs. Clicking a count lists that cell's
// files in full below the pivot; Copy still writes every file.
//
// A snapshot taken when it opens, rendered with plain DOM rather than
// Tabulator: there are few rows and nothing to sort. The root closes
// it when a load starts, since a drop onto an open modal still starts one and
// a half-updated study is worse than no panel.

import type { CellFile, LogLine, PivotView, RecordDetail, StripRow } from '../inventory/store';
import { NOT_RECORDED, cellSummary } from '../inventory/store';

/** What the dialog reads from; the root builds it from the inventory. */
export interface ContentsSource {
  /** The inputs that serve every Case, shown once above the pivot. */
  strip(): StripRow[];
  pivot(): PivotView;
  detail(recordId: string): RecordDetail | undefined;
  /** Every load, replace, refusal and skip, oldest first. */
  log(): LogLine[];
  /** The long form Copy writes: tab-separated, one row per (file, slot). */
  tsv(): string;
  /** The bundle's "About" note, saved with it. */
  about(): string;
  setAbout(text: string): void;
  /** Show a Case as `text` (blank restores its name). Returns why it was
   * refused, or undefined once it is taken and the app repainted. */
  renameCase(caseId: string, text: string): string | undefined;
  /** True while a load runs: the note is then read-only, since a restore is
   * about to replace it. */
  loading(): boolean;
}

/** A cell with nothing loaded. */
const BLANK = '—';

/** An ⓘ whose tooltip says what an input enables. */
function infoMark(text: string): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = 'contents-info';
  mark.textContent = 'ⓘ';
  mark.title = text;
  mark.setAttribute('aria-label', text);
  return mark;
}

/** A filename as a button: truncated, whole on hover, and a click shows its
 * record in the detail pane. */
function fileButton(file: { id: string; name: string | null }, show: (id: string) => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'contents-file';
  button.dataset.record = file.id;
  button.textContent = file.name ?? NOT_RECORDED;
  button.title = file.name ?? NOT_RECORDED;
  if (file.name === null) button.classList.add('contents-muted');
  button.addEventListener('click', () => show(file.id));
  return button;
}

/** Files as plain text, for a tooltip. */
function filesText(files: readonly CellFile[]): string {
  return files.map((file) => file.name ?? NOT_RECORDED).join(' + ');
}

/** Files joined by ` + ` (a merged table, a merged list), or a muted blank. */
function fillFiles(host: HTMLElement, files: readonly CellFile[], show: (id: string) => void) {
  if (files.length === 0) {
    const blank = document.createElement('span');
    blank.className = 'contents-muted';
    blank.textContent = BLANK;
    host.appendChild(blank);
    return;
  }
  files.forEach((file, at) => {
    if (at > 0) host.append(' + ');
    host.appendChild(fileButton(file, show));
  });
}

/** Open the dialog. `close` is idempotent, so the root can call it on every
 * load start without asking whether it is open. */
export function showContentsPanel(source: ContentsSource): { close(): void } {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal modal-wide contents-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', 'Contents');
  backdrop.appendChild(modal);

  const title = document.createElement('h2');
  title.textContent = 'Contents';
  modal.appendChild(title);

  // The note: who made the bundle, for which study, and what
  // was left out. Written through on every keystroke, so Save needs no Apply.
  const aboutLabel = document.createElement('label');
  aboutLabel.className = 'contents-about';
  aboutLabel.append('About this bundle');
  const about = document.createElement('textarea');
  about.rows = 2;
  about.value = source.about();
  about.readOnly = source.loading();
  about.placeholder = 'Who made it, for which study, and what was left out';
  about.addEventListener('input', () => source.setAbout(about.value));
  aboutLabel.appendChild(about);
  modal.appendChild(aboutLabel);

  // The session strip: inputs that serve every Case appear once, here. The
  // ones with nothing loaded share a single line rather than a row of "—"
  // each.
  const stripRows = source.strip();
  const unloaded = stripRows.filter((row) => row.files.length === 0 && !row.editedInApp);
  const strip = document.createElement('table');
  strip.className = 'contents-strip';
  const stripBody = document.createElement('tbody');
  for (const row of stripRows) {
    if (unloaded.includes(row)) continue;
    const tr = document.createElement('tr');
    tr.dataset.input = row.input;
    const label = document.createElement('th');
    label.scope = 'row';
    label.append(`${row.label} `, infoMark(row.enables));
    const files = document.createElement('td');
    fillFiles(files, row.files, showDetail);
    if (row.editedInApp) {
      const edited = document.createElement('span');
      edited.className = 'contents-muted';
      edited.textContent = ', edited in app';
      files.appendChild(edited);
    }
    tr.append(label, files);
    stripBody.appendChild(tr);
  }
  strip.appendChild(stripBody);
  if (stripBody.rows.length > 0) modal.appendChild(strip);
  if (unloaded.length > 0) {
    const line = document.createElement('p');
    line.className = 'contents-not-loaded';
    line.append('Not loaded: ');
    unloaded.forEach((row, index) => {
      if (index > 0) line.append(', ');
      const item = document.createElement('span');
      item.dataset.input = row.input;
      item.append(`${row.label} `, infoMark(row.enables));
      line.appendChild(item);
    });
    modal.appendChild(line);
  }

  const view = source.pivot();

  const pivotWrap = document.createElement('div');
  pivotWrap.className = 'contents-pivot-wrap';
  const table = document.createElement('table');
  table.className = 'contents-pivot';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  const caseHead = document.createElement('th');
  caseHead.textContent = 'Case';
  headRow.appendChild(caseHead);
  for (const column of view.columns) {
    const th = document.createElement('th');
    th.dataset.kind = column.kind;
    th.append(`${column.label} `, infoMark(column.enables));
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  /** What Escape does in each Case's name box. */
  const nameReverts = new Map<HTMLInputElement, () => void>();

  /**
   * A Case's display name, with the name drops join on muted beneath it
   * while the two differ. Read as text; the pencil swaps in a box. Taken on
   * change (Enter or leaving the box); a refusal is said beside the name and
   * the box reverts. Escape in the box puts the name back and closes only
   * the box.
   */
  function caseNameEditor(row: PivotView['rows'][number]): HTMLElement {
    const original = row.original ?? row.name;
    const wrap = document.createElement('span');
    wrap.className = 'contents-case-name';
    const shownLine = document.createElement('span');
    shownLine.className = 'contents-case-shown';
    const text = document.createElement('span');
    text.textContent = row.name;
    const pencil = document.createElement('button');
    pencil.type = 'button';
    pencil.className = 'contents-case-edit';
    pencil.textContent = '✎';
    pencil.title = 'Rename how this Case is shown';
    pencil.setAttribute('aria-label', `Rename Case ${original}`);
    pencil.disabled = source.loading();
    shownLine.append(text, pencil);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'contents-case-input';
    input.hidden = true;
    input.value = row.name;
    input.placeholder = original;
    input.title = 'The name this Case is shown as. Clear it to show its original name.';
    input.setAttribute('aria-label', `Display name for Case ${original}`);
    const originalLine = document.createElement('span');
    originalLine.className = 'contents-muted contents-case-original';
    const refusal = document.createElement('span');
    refusal.className = 'contents-case-refusal';
    refusal.setAttribute('role', 'status');
    let shown = row.name;
    const paintOriginal = (): void => {
      originalLine.textContent = shown === original ? '' : original;
      originalLine.hidden = shown === original;
    };
    paintOriginal();
    const editing = (on: boolean): void => {
      input.hidden = !on;
      shownLine.hidden = on;
    };
    pencil.addEventListener('click', () => {
      input.value = shown;
      editing(true);
      input.focus();
      input.select();
    });
    input.addEventListener('blur', () => editing(false));
    input.addEventListener('change', () => {
      const wanted = input.value.trim();
      const refused = source.renameCase(row.caseId, wanted);
      if (refused !== undefined) {
        refusal.textContent = refused;
        input.value = shown;
        return;
      }
      refusal.textContent = '';
      shown = wanted === '' ? original : wanted;
      input.value = shown;
      text.textContent = shown;
      paintOriginal();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
    nameReverts.set(input, () => {
      input.value = shown;
      input.blur();
      pencil.focus();
    });
    wrap.append(shownLine, input, originalLine, refusal);
    return wrap;
  }

  const body = document.createElement('tbody');
  if (view.rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = view.columns.length + 1;
    td.className = 'contents-muted';
    td.textContent = 'No Case is loaded.';
    tr.appendChild(td);
    body.appendChild(tr);
  }
  for (const row of view.rows) {
    const tr = document.createElement('tr');
    tr.dataset.caseId = row.caseId;
    const nameCell = document.createElement('th');
    nameCell.scope = 'row';
    nameCell.className = 'contents-case';
    const swatch = document.createElement('span');
    swatch.className = 'contents-swatch';
    swatch.style.background = row.color;
    nameCell.append(swatch, caseNameEditor(row));
    tr.appendChild(nameCell);
    row.cells.forEach((cell, index) => {
      const column = view.columns[index];
      const td = document.createElement('td');
      td.dataset.kind = column.kind;
      const summary = cellSummary(cell);
      if (summary === undefined) {
        td.textContent = cell.fallback ?? BLANK;
        td.classList.add('contents-muted');
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'contents-count';
        button.textContent = summary;
        button.title = cell.lines.map((line) => line.variant ?? filesText(line.files)).join('\n');
        button.addEventListener('click', () => {
          for (const other of modal.querySelectorAll('.contents-count[aria-pressed]')) {
            other.removeAttribute('aria-pressed');
          }
          button.setAttribute('aria-pressed', 'true');
          showCell(`${column.label} · ${row.name}`, cell);
        });
        td.appendChild(button);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  table.appendChild(body);
  pivotWrap.appendChild(table);
  modal.appendChild(pivotWrap);

  // Collapsed, and never remembered open: what is loaded now comes first,
  // and how it got there is one click further.
  const logLines = source.log();
  const log = document.createElement('details');
  log.className = 'contents-log';
  const logSummary = document.createElement('summary');
  logSummary.textContent = `Log (${logLines.length.toLocaleString()})`;
  log.appendChild(logSummary);
  const logList = document.createElement('ol');
  for (const line of logLines) {
    const item = document.createElement('li');
    item.dataset.event = line.event;
    const at = document.createElement('span');
    at.className = 'contents-muted';
    at.textContent = `${line.at} `;
    const event = document.createElement('strong');
    event.className = 'contents-event';
    event.textContent = line.event;
    item.append(at, event);
    if (line.files.length > 0) {
      item.append(' ');
      line.files.forEach((file, index) => {
        if (index > 0) item.append(' + ');
        if (file.id === undefined) {
          const name = document.createElement('span');
          name.className = 'contents-file-plain';
          name.textContent = file.name ?? NOT_RECORDED;
          name.title = file.name ?? NOT_RECORDED;
          item.appendChild(name);
        } else {
          item.appendChild(fileButton({ id: file.id, name: file.name }, showDetail));
        }
      });
    }
    if (line.where !== undefined) item.append(` · ${line.where}`);
    if (line.reason !== undefined) item.append(` — ${line.reason}`);
    if (line.notes.length > 0) {
      const notes = document.createElement('ul');
      notes.className = 'contents-notes';
      for (const note of line.notes) {
        const entry = document.createElement('li');
        entry.textContent = note;
        notes.appendChild(entry);
      }
      item.appendChild(notes);
    }
    logList.appendChild(item);
  }
  if (logLines.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'contents-muted';
    empty.textContent = 'Nothing has been loaded yet.';
    logList.appendChild(empty);
  }
  log.appendChild(logList);
  modal.appendChild(log);

  // Below the pivot, empty until asked: the files behind the count last
  // clicked, then the record of the file last clicked.
  const cellDetail = document.createElement('div');
  cellDetail.className = 'contents-cell-detail';
  cellDetail.hidden = true;
  modal.insertBefore(cellDetail, log);
  const detail = document.createElement('div');
  detail.className = 'contents-detail';
  detail.hidden = true;
  modal.insertBefore(detail, log);

  /** Every file behind one cell, in full: the pivot shows only a count. */
  function showCell(heading: string, cell: PivotView['rows'][number]['cells'][number]): void {
    const title = document.createElement('h3');
    title.textContent = heading;
    const list = document.createElement('dl');
    for (const line of cell.lines) {
      const term = document.createElement('dt');
      term.textContent = line.variant ?? '';
      const value = document.createElement('dd');
      fillFiles(value, line.files, showDetail);
      list.append(term, value);
    }
    cellDetail.replaceChildren(title, list);
    cellDetail.hidden = false;
  }

  function showDetail(recordId: string): void {
    const found = source.detail(recordId);
    detail.replaceChildren();
    detail.hidden = found === undefined;
    if (found === undefined) return;
    const heading = document.createElement('h3');
    heading.textContent = found.title;
    const list = document.createElement('dl');
    for (const field of found.fields) {
      const term = document.createElement('dt');
      term.textContent = field.label;
      const value = document.createElement('dd');
      value.textContent = field.value;
      list.append(term, value);
    }
    detail.append(heading, list);
    if (found.notes.length > 0) {
      const notes = document.createElement('ul');
      notes.className = 'contents-notes';
      for (const note of found.notes) {
        const item = document.createElement('li');
        item.textContent = note;
        notes.appendChild(item);
      }
      detail.appendChild(notes);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const copyStatus = document.createElement('span');
  copyStatus.className = 'contents-muted contents-copy-status';
  copyStatus.setAttribute('role', 'status');
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'btn';
  copyButton.textContent = 'Copy';
  copyButton.title = 'Copy every file and blank slot as a tab-separated table, for Excel';
  copyButton.addEventListener('click', () => {
    const text = source.tsv();
    const rows = text.split('\n').length - 2;
    navigator.clipboard.writeText(text).then(
      () => {
        copyStatus.textContent = `Copied ${rows.toLocaleString()} row(s).`;
      },
      (error: unknown) => {
        copyStatus.textContent = `Could not copy: ${error instanceof Error ? error.message : String(error)}`;
      },
    );
  });
  actions.append(copyStatus, copyButton);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'btn btn-primary';
  closeButton.textContent = 'Close';
  actions.appendChild(closeButton);
  modal.appendChild(actions);

  let open = true;
  function close(): void {
    if (!open) return;
    open = false;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  // Capture phase, stopping propagation, as the other dialogs do: the app's
  // own keydown owner must not also act on an Escape meant for this.
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    // An open name box takes the Escape: it reverts the box, not the panel.
    const revert = event.target instanceof HTMLInputElement && nameReverts.get(event.target);
    if (revert) {
      revert();
      return;
    }
    close();
  }
  document.addEventListener('keydown', onKey, true);
  closeButton.addEventListener('click', close);

  document.body.appendChild(backdrop);
  closeButton.focus();
  return { close };
}
