// src/ui/import-dialog.ts
//
// The Import Dialog: RENDERING and event wiring only. Every decision on
// screen (case name, kind, slot, new vs existing, collisions and their
// explanation) comes from the pure planning module, which is tested in Node.
// With no browser test harness in this repo, logic here would be unproven.
//
// Kind and quantity are read from the file, never offered as choices: a
// misdetection is fixed in the detector. The verdict is on the row as text;
// the row's kind tint is a redundant cue, never the only one.
//
// A limits file is the one auxiliary file on this dialog, because it is the
// only one assigned per Case, and Case names do not exist until this runs.
//
// Cancel resolves `null` and NOTHING is ingested. Two exits load: "Choose
// what to load…" (primary) opens the per-file pickers, which state each
// allocation before attempting it; "Load everything" skips them. Skipping is
// deliberately not the default.
//
// Files dropped while it is open join it (`ImportIntake`), as if they had
// been in the first drop: their rows sort in among the others and follow the
// mode, and a highlight shows which arrived.
//
// Modal conventions follow the column pickers (src/tables/area/ui/picker.ts),
// including tearing down the Escape listener on close
// (tests/test_dom_contract.mjs counts them).

import type { AddedFiles, ImportIntake } from '../app/drop-load';
import {
  planImports,
  planLimits,
  type ExistingCase,
  type FileOverride,
  type ImportFile,
  type ImportMode,
  type ImportModeParams,
  type ImportPlan,
  type LimitPlan,
  type LimitScope,
  type TableKind,
} from '../app/import-plan';
import { spanLabel } from '../ingest';
import { KIND_COLORS } from '../tables/registry';

const MODE_CHOICES: { value: ImportMode; label: string }[] = [
  { value: 'one-case', label: 'All files are one Case' },
  { value: 'derive', label: 'Derive the Case name from the filename' },
  { value: 'individual', label: 'Assign each file individually' },
];

/** One file's persistent row, repainted in place so the caret stays in the
 *  field being typed in. */
interface FileRow {
  file: ImportFile;
  originalIndex: number;
  /** The default case name, taken from a first-pass plan. */
  seedName: string;
  rowElement: HTMLElement;
  caseInput: HTMLInputElement;
  conflictLine: HTMLElement;
  yearsCell: HTMLElement;
  /** A span conflict, in one line: the Case's years and the move that
   * clears it. */
  spanLine: HTMLElement;
  spanText: HTMLElement;
  /** Moves this row's table, and any row sharing its years and Case, to a
   * Case of its own: shown only beside a span conflict. */
  splitButton: HTMLButtonElement;
  replaceLine: HTMLElement;
  removeButton: HTMLButtonElement;
}

/**
 * A caption and its control. Layout is a CLASS, not inline styles: an inline
 * `display` overrides the `hidden` attribute, and the bulk fields are shown
 * and hidden by mode through `hidden`.
 */
function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'modal-row-tag modal-field';
  const span = document.createElement('span');
  span.textContent = text;
  label.append(span, control);
  return label;
}

/** The dialog's answer: one plan per kept table file, and one per limits file
 *  (not a table; see `LimitPlan`). */
export interface ImportDecision {
  plans: ImportPlan[];
  limits: LimitPlan[];
  /** `true`: skip every per-file picker and keep the whole union. One field,
   *  so every ingest path reads the same answer. */
  everything: boolean;
}

/**
 * Ask how a batch of dropped table files maps onto Cases. Resolves to one
 * `ImportPlan` per kept file (paired back by `plan.fileIndex`), or `null` on
 * cancel. `existingCases` lets the planner mark targets as existing and
 * occupied slots as replaced.
 */
export function showImportDialog(
  files: ImportFile[],
  existingCases: ExistingCase[] = [],
  droppedLimits: ImportFile[] = [],
  intake?: ImportIntake,
): Promise<ImportDecision | null> {
  return new Promise((resolve) => {
    /** The name a file's Case box starts at: its own default name. */
    const seedOf = (file: ImportFile): string => {
      try {
        return planImports([file], 'derive', { pattern: '*' })[0]?.caseName ?? file.name;
      } catch {
        return file.name;
      }
    };
    // Grows as files are added; a plan's `fileIndex` is a place in it.
    const limitFiles = [...droppedLimits];

    let mode: ImportMode = 'one-case';

    // Loaded Cases as the analyst reads them: by display name, with the name
    // a drop joins on beside it. A plan names an existing Case by its name.
    const shownAs = (name: string): string =>
      existingCases.find((entry) => entry.name === name)?.displayName || name;
    const withOriginal = (name: string): string =>
      shownAs(name) === name ? `"${name}"` : `"${shownAs(name)}" (${name})`;
    const existingList = document.createElement('datalist');
    existingList.id = 'import-existing-cases';
    for (const entry of existingCases) {
      const option = document.createElement('option');
      option.value = shownAs(entry.name);
      if (option.value !== entry.name) option.label = `loaded Case, named ${entry.name}`;
      else option.label = 'loaded Case';
      existingList.appendChild(option);
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-wide import-dialog';
    backdrop.appendChild(modal);
    modal.appendChild(existingList);

    const title = document.createElement('h2');
    modal.appendChild(title);
    const retitle = (): void => {
      const count = activeRows.length;
      title.textContent = `Assign ${count} dropped file${count === 1 ? '' : 's'} to Cases`;
    };

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      'A Case is one simulation run and can hold several tables — an Area export and one ' +
      'Interface export per quantity. Files given the same Case name land on the same Case, ' +
      'which is what makes two runs comparable pane by pane.';
    modal.appendChild(subtitle);

    // ------------------------------------------------------------ bulk mode
    const modeBar = document.createElement('div');
    modeBar.className = 'modal-toolbar';
    modeBar.style.flexWrap = 'wrap';
    const modeRadios: HTMLInputElement[] = [];
    for (const choice of MODE_CHOICES) {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gv-case-assignment-mode';
      radio.value = choice.value;
      radio.checked = choice.value === mode;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        mode = choice.value;
        refresh();
      });
      modeRadios.push(radio);
      modeBar.appendChild(labelled(choice.label, radio));
    }
    modal.appendChild(modeBar);

    const bulkBar = document.createElement('div');
    bulkBar.className = 'modal-toolbar';
    bulkBar.style.flexWrap = 'wrap';

    const oneCaseInput = document.createElement('input');
    oneCaseInput.type = 'text';
    oneCaseInput.className = 'modal-filter';
    oneCaseInput.value = files.length > 0 ? seedOf(files[0]) : '';
    oneCaseInput.placeholder = 'Case name for every file';
    oneCaseInput.setAttribute('list', existingList.id);
    const oneCaseWrap = labelled('Case name', oneCaseInput);
    bulkBar.appendChild(oneCaseWrap);

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'modal-filter';
    patternInput.value = '*';
    patternInput.placeholder = '*_2024_PF.csv';
    patternInput.title =
      'One * marks the part of the filename that becomes the Case name. ' +
      'With "*" (the default) the whole filename stem is the Case name.';
    const patternWrap = labelled('Pattern', patternInput);
    bulkBar.appendChild(patternWrap);
    modal.appendChild(bulkBar);

    // ------------------------------------------------------------ file rows
    //
    // THREE COLUMNS: file, Case, what was detected. A row says nothing else
    // unless something is WRONG with it (a slot collision, a replace, a wide
    // file with no title quantity); restating inputs made long batches
    // unreadable.
    const head = document.createElement('div');
    head.className = 'import-head';
    const fileHead = document.createElement('div');
    fileHead.textContent = 'File';
    // In the bulk modes the Case boxes are a computed preview, so the caption
    // greys with them.
    const caseHead = document.createElement('div');
    caseHead.textContent = 'Case';
    const detectedHead = document.createElement('div');
    detectedHead.textContent = 'Detected';
    const yearsHead = document.createElement('div');
    yearsHead.textContent = 'Years';
    head.append(fileHead, caseHead, detectedHead, yearsHead, document.createElement('div'));

    const list = document.createElement('div');
    list.className = 'modal-list';
    modal.appendChild(list);
    // Inside the scroller and sticky, so its grid tracks align with the rows.
    list.appendChild(head);

    // One expression for both what the column shows and the sort key.
    const detectedText = (file: ImportFile): string =>
      file.detected.kind +
      (file.detected.shape === undefined ? '' : ` · ${file.detected.shape}`) +
      (file.detected.quantity === undefined ? '' : ` · ${file.detected.quantity}`) +
      (file.detected.confidence === 'low' ? ' · low confidence' : '');
    /** A wide file's stated years, or a long file's sampled ones. */
    const yearsText = (file: ImportFile): string =>
      file.detected.years
        ? spanLabel(file.detected.years)
        : file.sampled
          ? `${spanLabel(file.sampled)} (sampled)`
          : '—';

    const activeRows: FileRow[] = [];
    /**
     * Rows are sorted by detected verdict (stable), so a misread file stands
     * out among its neighbours: a row goes after every row whose verdict
     * sorts with or before its own. DISPLAY ONLY: plans carry `fileIndex`
     * back to the caller's order, which failures are attributed by.
     */
    function addRow(file: ImportFile, index: number): FileRow {
      const seedName = seedOf(file);
      const row = document.createElement('div');
      row.className = 'modal-row import-row';

      // A tint per kind, as a cue only: the kind is also named in text for
      // colour-blind readers and greyscale printouts. Every row here is a
      // table kind, so the lookup is total.
      const tint = KIND_COLORS[file.detected.kind as TableKind];
      if (tint) row.style.borderLeft = `3px solid ${tint}`;

      const name = document.createElement('div');
      name.className = 'modal-row-name import-cell';
      name.textContent = file.name;
      // detect.ts's reason is a tooltip: forensics for one misread row.
      name.title = file.detected.reason;

      const caseCell = document.createElement('div');
      caseCell.className = 'import-case';
      const caseInput = document.createElement('input');
      caseInput.type = 'text';
      caseInput.className = 'modal-filter';
      caseInput.value = seedName;
      caseInput.placeholder = seedName;
      caseInput.setAttribute('aria-label', `Case for ${file.name}`);
      caseInput.setAttribute('list', existingList.id);
      caseCell.appendChild(caseInput);

      // Read from the file, so painted once. Confidence shows only when LOW.
      const detectedTag = document.createElement('div');
      detectedTag.className = 'modal-row-tag import-cell';
      detectedTag.textContent = `detected: ${detectedText(file)}`;
      detectedTag.title = file.detected.reason;

      // Read from the file, so painted once; red with its span conflict.
      const yearsCell = document.createElement('div');
      yearsCell.className = 'import-cell import-years';
      yearsCell.textContent = yearsText(file);
      yearsCell.title = file.detected.years
        ? 'The years this file’s date line states.'
        : file.sampled
          ? file.sampled.whole
            ? 'From the file’s first and last rows, which run in date order. The load reads every row.'
            : 'Years seen in the file’s first and last rows, which are not in date order, so it may hold others. The load reads every row.'
          : 'Read when the file loads.';

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'modal-row-remove';
      removeButton.textContent = '×';
      removeButton.title = `Remove ${file.name} from import`;
      removeButton.setAttribute('aria-label', `Remove ${file.name}`);

      row.append(name, caseCell, detectedTag, yearsCell, removeButton);

      // A refusal seen before the load: without a title quantity there is
      // no slot key.
      const warningLine = document.createElement('div');
      warningLine.className = 'modal-subtitle import-note';
      warningLine.style.color = 'var(--color-warning, #a15c00)';
      if (file.detected.shape === 'W' && file.detected.quantity === undefined) {
        warningLine.textContent =
          'No quantity was read from this file’s title line, so it may be refused on load.';
      }
      row.appendChild(warningLine);

      const conflictLine = document.createElement('div');
      conflictLine.className = 'modal-subtitle import-note';
      conflictLine.style.color = 'var(--color-negative, #b3261e)';
      row.appendChild(conflictLine);

      const spanLine = document.createElement('div');
      spanLine.className = 'modal-subtitle import-span';
      spanLine.hidden = true;
      const spanText = document.createElement('span');
      const splitButton = document.createElement('button');
      splitButton.type = 'button';
      splitButton.className = 'btn';
      spanLine.append(spanText, splitButton);
      row.appendChild(spanLine);

      // Non-blocking: confirming overwrites the table at this slot. Separate
      // from `conflictLine` so a row can show both.
      const replaceLine = document.createElement('div');
      replaceLine.className = 'modal-subtitle import-note';
      replaceLine.style.color = 'var(--color-warning, #a15c00)';
      row.appendChild(replaceLine);

      const fileRow: FileRow = {
        file,
        originalIndex: index,
        seedName,
        rowElement: row,
        caseInput,
        conflictLine,
        yearsCell,
        spanLine,
        spanText,
        splitButton,
        replaceLine,
        removeButton,
      };

      splitButton.addEventListener('click', () => {
        const plan = plans?.[activeRows.indexOf(fileRow)];
        if (plan?.splitTo !== undefined) splitOff(plan.caseName, plan.splitTo);
      });

      removeButton.addEventListener('click', () => {
        row.remove();
        const idx = activeRows.indexOf(fileRow);
        if (idx >= 0) {
          activeRows.splice(idx, 1);
        }
        // A limits-only batch is still a batch; do not cancel it.
        if (activeRows.length === 0 && limitRows.length === 0) {
          close(null);
          return;
        }
        retitle();
        refresh();
      });

      caseInput.addEventListener('input', refresh);

      const key = detectedText(file);
      const at = activeRows.findIndex((other) => detectedText(other.file).localeCompare(key) > 0);
      if (at < 0) {
        list.appendChild(row);
        activeRows.push(fileRow);
      } else {
        list.insertBefore(row, activeRows[at].rowElement);
        activeRows.splice(at, 0, fileRow);
      }
      return fileRow;
    }
    files.forEach((file, index) => addRow(file, index));

    // ----------------------------------------------------------- limit rows
    //
    // A separate list: a limits file lands on no slot and asks only which
    // Cases it applies to.
    interface LimitRow {
      file: ImportFile;
      select: HTMLSelectElement;
      targetLine: HTMLElement;
    }
    const limitRows: LimitRow[] = [];
    /** The user's corrections, by index into `limitFiles`. A correction that
     *  becomes invalid (its Case renamed away) is DELETED, so the planner's
     *  default applies again. */
    const limitOverrides: Record<number, LimitScope | undefined> = {};
    let limitPlans: LimitPlan[] = [];
    const SCOPE_ALL = '\u0000all';

    // Built hidden, and shown by the first limits file, dropped or added.
    const limitHeading = document.createElement('p');
    limitHeading.className = 'modal-subtitle';
    modal.appendChild(limitHeading);
    const limitList = document.createElement('div');
    limitList.className = 'modal-list';
    modal.appendChild(limitList);
    const showLimits = (): void => {
      const count = limitFiles.length;
      limitHeading.hidden = limitList.hidden = count === 0;
      limitHeading.textContent =
        `${count} interface limit file${count === 1 ? '' : 's'}. A limits ` +
        'file holds no hourly data and lands on no slot — it says what the paths are operated ' +
        'to. Give it to every Case when one published set of limits is being compared across ' +
        'runs, or to one Case when that run has its own. A Case with its own limits ignores the ' +
        'shared set.';
    };
    /** A limits file's row. `index` is its place in `limitFiles`. */
    function addLimitRow(file: ImportFile, index: number): HTMLElement {
      const row = document.createElement('div');
      row.className = 'modal-row';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';
      row.style.gap = '4px';

      const headline = document.createElement('div');
      headline.style.display = 'flex';
      headline.style.alignItems = 'center';
      headline.style.gap = '8px';
      const name = document.createElement('span');
      name.className = 'modal-row-name';
      name.textContent = file.name;
      const detectedTag = document.createElement('span');
      detectedTag.className = 'modal-row-tag';
      detectedTag.textContent = `detected: interface limits (${file.detected.confidence})`;
      detectedTag.title = file.detected.reason;
      headline.append(name, detectedTag);
      row.appendChild(headline);

      const select = document.createElement('select');
      select.className = 'modal-filter';
      select.addEventListener('change', () => {
        limitOverrides[index] =
          select.value === SCOPE_ALL ? { kind: 'all' } : { kind: 'case', caseName: select.value };
        refresh();
      });
      const controls = document.createElement('div');
      controls.style.display = 'flex';
      controls.style.alignItems = 'center';
      controls.style.gap = '6px';
      controls.appendChild(labelled('Applies to', select));
      row.appendChild(controls);

      const targetLine = document.createElement('div');
      targetLine.className = 'modal-readout';
      row.appendChild(targetLine);

      limitList.appendChild(row);
      limitRows.push({ file, select, targetLine });
      return row;
    }
    limitFiles.forEach((file, index) => addLimitRow(file, index));
    showLimits();

    // What became of the last files added: one line per file that did not join.
    const addNotes = document.createElement('p');
    addNotes.className = 'modal-subtitle import-note';
    addNotes.style.color = 'var(--color-warning, #a15c00)';
    addNotes.style.whiteSpace = 'pre-line';
    addNotes.hidden = true;
    modal.appendChild(addNotes);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    // Button order: cancel, load everything, choose (primary). The primary is
    // the one that opens the pickers.
    const takeAll = document.createElement('button');
    takeAll.type = 'button';
    takeAll.className = 'btn';
    takeAll.textContent = 'Load everything';
    // A very large allocation is confirmed on either exit.
    takeAll.title =
      'Load every entity and every metric these files carry. No picker opens; a very large ' +
      'load is still confirmed first.';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Choose what to load…';
    confirm.title = 'Load these files, asking per file which entities and metrics to keep';
    actions.append(cancel, takeAll, confirm);
    if (intake) {
      // The same way in as a drop on the window.
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.csv,text/csv';
      picker.multiple = true;
      picker.hidden = true;
      picker.addEventListener('change', () => {
        const picked = Array.from(picker.files ?? []);
        picker.value = '';
        if (picked.length > 0) intake.add(picked);
      });
      const addFiles = document.createElement('button');
      addFiles.type = 'button';
      addFiles.className = 'btn import-add';
      addFiles.textContent = 'Add files…';
      addFiles.title = 'Add more exports or limits files to this import. Dropping them works too.';
      addFiles.addEventListener('click', () => picker.click());
      actions.prepend(picker, addFiles);
    }
    modal.appendChild(actions);

    // ---------------------------------------------------------------- state
    /**
     * The user's raw choices in the planner's shape, uninterpreted. An empty
     * box falls back to its seed, so a Case is never named "". Only the case
     * name is a per-file choice.
     */
    function currentParams(): ImportModeParams {
      const overrides: Record<number, FileOverride> = {};
      activeRows.forEach((row, index) => {
        overrides[index] = {
          caseName: row.caseInput.value.trim() || row.seedName,
        };
      });
      return {
        caseName: oneCaseInput.value.trim() || (activeRows[0]?.seedName ?? ''),
        pattern: patternInput.value === '' ? '*' : patternInput.value,
        overrides,
        existingCases,
      };
    }

    /** The plans on screen, or `null` when the planner refused the choices
     *  outright (a caller bug). */
    let plans: ImportPlan[] | null = null;

    function refresh(): void {
      oneCaseWrap.hidden = mode !== 'one-case';
      patternWrap.hidden = mode !== 'derive';

      let refusal = '';
      try {
        plans = planImports(
          activeRows.map((r) => r.file),
          mode,
          currentParams(),
        );
      } catch (error) {
        plans = null;
        refusal = error instanceof Error ? error.message : String(error);
      }

      let conflicts = 0;
      let replaces = 0;
      const caseNames = new Set<string>();
      // A disabled input looks editable until styled, so the caption greys.
      caseHead.classList.toggle('modal-label-computed', mode !== 'individual');
      activeRows.forEach((row, index) => {
        const plan = plans?.[index];
        if (plan) {
          plan.fileIndex = row.originalIndex;
        }
        // The Case box is always the live preview of where the file lands;
        // editable only in individual mode.
        row.caseInput.disabled = mode !== 'individual';
        if (plan && mode !== 'individual') row.caseInput.value = shownAs(plan.caseName);

        row.yearsCell.classList.toggle('import-years-conflict', plan?.spanConflict === true);
        if (!plan) {
          row.conflictLine.textContent = '';
          row.spanLine.hidden = true;
          row.replaceLine.textContent = '';
          return;
        }
        caseNames.add(plan.caseName);
        // Blocking: a same-batch collision, or years the load would refuse.
        // The replace warning has its own line so both can show. A span
        // conflict is said short, its years already red in their column,
        // with the whole account on hover.
        row.conflictLine.textContent = plan.slotConflict ? (plan.conflictReason ?? '') : '';
        row.spanLine.hidden = !plan.spanConflict;
        row.spanLine.title = plan.spanDetail ?? '';
        row.spanText.textContent = plan.spanReason ?? '';
        row.splitButton.hidden = plan.splitTo === undefined;
        row.splitButton.textContent = `Move to Case "${plan.splitTo ?? ''}"`;
        row.replaceLine.textContent = plan.replacesExisting ? (plan.replaceReason ?? '') : '';
        if (plan.slotConflict || plan.spanConflict) conflicts++;
        if (plan.replacesExisting) replaces++;
      });

      // Cases a limits file may be pinned to: every target in row order, then
      // untouched loaded Cases. Read off the PLANS, not the input boxes.
      const scopeNames = [...caseNames];
      for (const existing of existingCases) {
        if (!scopeNames.includes(existing.name)) scopeNames.push(existing.name);
      }
      for (const [key, override] of Object.entries(limitOverrides)) {
        if (override?.kind === 'case' && !scopeNames.includes(override.caseName)) {
          delete limitOverrides[Number(key)];
        }
      }
      limitPlans = planLimits(limitFiles, scopeNames, limitOverrides);
      limitRows.forEach((row, index) => {
        const plan = limitPlans[index];
        const wanted = plan.scope.kind === 'all' ? SCOPE_ALL : plan.scope.caseName;
        const options = [SCOPE_ALL, ...scopeNames].join('\u0001');
        // Rebuilt only when the options change, or the open dropdown closes.
        if (row.select.dataset.options !== options) {
          row.select.dataset.options = options;
          row.select.replaceChildren();
          const all = document.createElement('option');
          all.value = SCOPE_ALL;
          all.textContent = 'All Cases (shared)';
          row.select.appendChild(all);
          for (const caseName of scopeNames) {
            const option = document.createElement('option');
            option.value = caseName;
            option.textContent = `only ${withOriginal(caseName)}`;
            row.select.appendChild(option);
          }
        }
        row.select.value = wanted;
        row.targetLine.textContent =
          plan.scope.kind === 'all'
            ? '→ shared: every Case that has no limits of its own'
            : `→ only Case ${withOriginal(plan.scope.caseName)}`;
      });
      const sharedCount = limitPlans.filter((plan) => plan.scope.kind === 'all').length;

      if (refusal) {
        readout.textContent = refusal;
        confirm.disabled = true;
        takeAll.disabled = true;
        return;
      }
      readout.textContent =
        `${activeRows.length} file${activeRows.length === 1 ? '' : 's'} → ${caseNames.size} Case` +
        `${caseNames.size === 1 ? '' : 's'}` +
        (conflicts > 0
          ? ` · ${conflicts} file${conflicts === 1 ? '' : 's'} cannot be loaded as assigned — ` +
            'change a Case name, or remove one of the files, to clear it'
          : '') +
        (replaces > 0
          ? ` · ${replaces} file${replaces === 1 ? '' : 's'} will REPLACE a table already loaded`
          : '') +
        (limitFiles.length > 0 ? ` · ${limitFiles.length} limit file(s)` : '') +
        // Not blocking (the store replaces by decision), but said out loud.
        (sharedCount > 1
          ? ` · ${sharedCount} limit files are set to ALL Cases, and only the last will survive — ` +
            'pin the others to a Case'
          : '');
      // The one gate: a same-batch slot collision would lose a table to
      // last-write-wins, and a span conflict is a table the load would
      // refuse. A replace of a loaded table does not gate.
      confirm.disabled = conflicts > 0;
      // Both exits gate together; the shortcut would lose the table too.
      takeAll.disabled = conflicts > 0;
    }

    /**
     * Give every row the load would refuse for its years in `caseName` the
     * Case `target`, keeping every other row where it is. Per-file names
     * are the only way to say that, so the dialog moves to individual mode
     * with each box holding the Case it already showed.
     */
    function splitOff(caseName: string, target: string): void {
      const current = plans;
      if (!current) return;
      activeRows.forEach((row, index) => {
        const plan = current[index];
        row.caseInput.value =
          plan.caseName === caseName && plan.splitTo === target ? target : shownAs(plan.caseName);
      });
      mode = 'individual';
      for (const radio of modeRadios) radio.checked = radio.value === mode;
      refresh();
    }

    for (const field of [oneCaseInput, patternInput]) {
      field.addEventListener('input', refresh);
    }

    function close(result: ImportDecision | null): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    // Escape cancels and loads nothing: there is no safe default assignment.
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close(null);
    }
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', () => close(null));
    function submit(button: HTMLButtonElement, everything: boolean): void {
      if (plans && !button.disabled) close({ plans, limits: limitPlans, everything });
    }
    confirm.addEventListener('click', () => submit(confirm, false));
    takeAll.addEventListener('click', () => submit(takeAll, true));

    /** Rows for files that joined the open dialog, highlighted. */
    function take(added: AddedFiles): void {
      const rows = [
        ...added.tables.map(({ file, index }) => addRow(file, index).rowElement),
        ...added.limits.map(({ file, index }) => {
          limitFiles[index] = file;
          return addLimitRow(file, index);
        }),
      ];
      for (const row of rows) row.classList.add('import-row-added');
      rows[0]?.scrollIntoView({ block: 'nearest' });
      addNotes.textContent = added.notes.join('\n');
      addNotes.hidden = added.notes.length === 0;
      showLimits();
      retitle();
      refresh();
    }
    intake?.listen(take, (index) => activeRows.some((row) => row.originalIndex === index));

    retitle();
    refresh();
    document.body.appendChild(backdrop);
    (mode === 'one-case' ? oneCaseInput : (modeRadios[0] ?? oneCaseInput)).focus();
  });
}
