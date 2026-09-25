// src/ui/shell.ts
//
// The kind-neutral shell: section host, the one keydown owner, and the global
// chrome (topbar, status bar, memory readout, drop overlay). Adding a table
// kind does not edit this file.

import type { TableKind } from '../model/case-model';
import { within } from './dom';

/** Ten categorical colours, assigned at drop time and never reshuffled.
 * Declared in `ui/palette.ts` so Node tests can import them (this module adds
 * a keydown listener at import time). */
export { CASE_COLORS } from './palette';

/** A mounted section's keyboard handler, plus the root it owns. */
export interface KeySection {
  root: HTMLElement;
  handle(event: KeyboardEvent): void;
}

const keySections: KeySection[] = [];
/** Where a keystroke goes when it came from outside every section root. */
let focusedSection: KeySection | null = null;

/** The app's ONE keydown listener. Sections register handlers and this
 * dispatches to the right one; two listeners would both fire. */
export function registerKeys(section: KeySection): void {
  keySections.push(section);
  focusedSection ??= section;
  const focus = (): void => {
    focusedSection = section;
  };
  // Capture, so a click on a control inside still focuses the section.
  section.root.addEventListener('pointerdown', focus, true);
  section.root.addEventListener('focusin', focus);
}

let toggleRailAction: (() => void) | null = null;

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // A load refuses input (see the busy overlay in `createChrome`), and a
  // shortcut such as `r` would otherwise re-scope the app under it.
  if (document.body.classList.contains('is-busy')) return;
  if (event.key === '[') {
    event.preventDefault();
    toggleRailAction?.();
    return;
  }
  const from = target ? keySections.find((section) => section.root.contains(target)) : null;
  (from ?? focusedSection)?.handle(event);
});

// -------------------------------------------------------------- registry

/** What a retained-column picker is asked about, computed once per kind per
 * batch. Each kind's picker reads only the fields it needs. */
export interface RetainedBatch {
  /** The union of every dropped file's columns for this kind. */
  union: string[];
  /** How many files of this kind are in the batch. */
  fileCount: number;
  /** Width of the area axis (0 for a kind with no axis pass). */
  axisCount: number;
  /** Column -> the files that carry it ("in 1 of 2 files"). */
  coverage: Map<string, string[]>;
  /** The Import Dialog's "Load everything": no picker opens. */
  everything: boolean;
}

/**
 * Mount a section's shell and own the empty state. A section is mounted ONCE
 * and only shown or hidden: re-mounting would silently reset its focused
 * pane, filter chips and scroll. The app has one section; a second would mean
 * a list here and ORed visibility, not a per-kind descriptor.
 */
export function createSectionHost(
  host: HTMLElement,
  template: HTMLTemplateElement,
): {
  /** Build the section's chrome once and return the root its content mounts
   * into (one clone of `#section-template`). */
  add(id: TableKind, label: string): HTMLElement;
  /**
   * Show the section when anything is loaded, and draw the notes EITHER WAY:
   * this is the one surface for ingest notes and series warnings.
   */
  sync(visible: boolean, notes: readonly string[]): void;
} {
  // The empty state lives here: a hidden section cannot say nothing is loaded.
  const empty = document.createElement('div');
  empty.className = 'sections-empty';
  const emptyLead = document.createElement('p');
  emptyLead.className = 'sections-empty-lead';
  emptyLead.textContent = 'Drop GridView CSV exports anywhere on this window.';
  empty.appendChild(emptyLead);
  host.appendChild(empty);
  // A sibling of the empty state, so notes show with or without a section.
  // One element whose text is rewritten, because this file may not remove
  // children (`tests/test_section_state.mjs`). It floats over the rail's
  // corner so it never takes height from the panes.
  const notesCard = document.createElement('div');
  notesCard.className = 'sections-notes';
  // The header is the collapse control, and collapsed it keeps the count on
  // screen: dismissing notes outright would hide a refusal one click away.
  const notesToggle = document.createElement('button');
  notesToggle.type = 'button';
  notesToggle.className = 'sections-notes-toggle';
  // A speech bubble, not a warning sign: most notes are ordinary accounts, and
  // a hazard glyph on them teaches users to ignore it. Drawn inline so it
  // takes `currentColor` instead of an inconsistent emoji glyph.
  const svg = 'http://www.w3.org/2000/svg';
  const notesIcon = document.createElementNS(svg, 'svg');
  notesIcon.setAttribute('class', 'sections-notes-icon');
  notesIcon.setAttribute('viewBox', '0 0 16 16');
  notesIcon.setAttribute('aria-hidden', 'true');
  const bubble = document.createElementNS(svg, 'path');
  bubble.setAttribute(
    'd',
    'M3 2h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7.2L4 14.2V11H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
  );
  bubble.setAttribute('fill', 'currentColor');
  notesIcon.appendChild(bubble);
  // Its own element, so writing the count does not remove the icon.
  const notesCount = document.createElement('span');
  notesCount.className = 'sections-notes-count';
  notesToggle.append(notesIcon, notesCount);
  const notesLine = document.createElement('p');
  notesLine.className = 'sections-notes-body';
  notesCard.append(notesToggle, notesLine);
  host.appendChild(notesCard);

  // The last text shown and whether THAT text was collapsed: render runs on
  // every interaction, so only new text may reset it. New text arrives
  // collapsed, as the bubble and a fresh count: most notes are ordinary
  // accounts of a load, and an open card covers the rail each time.
  let shownNotes = '';
  let collapsed = true;
  let count = 0;
  const paintNotes = () => {
    notesCard.dataset.collapsed = String(collapsed);
    notesToggle.setAttribute('aria-expanded', String(!collapsed));
    notesCount.textContent = collapsed ? String(count) : `${count} note${count === 1 ? '' : 's'}`;
    notesToggle.title = collapsed ? 'Show these notes' : 'Collapse to the count';
  };
  notesToggle.addEventListener('click', () => {
    collapsed = !collapsed;
    paintNotes();
  });

  let details: HTMLDetailsElement | null = null;

  return {
    add(id, label) {
      // Open by default: a user who just dropped a file wants to see it.
      details = document.createElement('details');
      details.className = 'gv-section-details';
      details.dataset.section = id;
      details.open = true;
      // Hidden until the first `sync`, so it never flashes empty.
      details.hidden = true;

      const summary = document.createElement('summary');
      summary.className = 'gv-section-summary';
      summary.textContent = label;

      const root = document.createElement('div');
      root.appendChild(template.content.cloneNode(true));

      details.append(summary, root);
      host.insertBefore(details, empty);
      return root;
    },

    sync(visible, notes) {
      if (details) details.hidden = !visible;
      empty.hidden = visible;

      notesLine.textContent = notes.join('\n');
      if (notesLine.textContent !== shownNotes) {
        shownNotes = notesLine.textContent;
        collapsed = true;
      }
      count = notes.length;
      paintNotes();
      notesCard.hidden = notes.length === 0;
    },
  };
}

// ---------------------------------------------------------------- chrome

/** What the topbar and status bar show, composed by main.ts across sections. */
export interface ChromeState {
  /** The status sentence, or the busy message while a load is running. */
  status: string;
  /** Whether a load is running: the message alone reads like an idle
   * sentence, and a narrow window hides the status bar. */
  busy: boolean;
  /** Total across every loaded table of every kind. */
  bytes: number;
  /** How many Cases are loaded, for the memory readout. */
  cases: number;
  /** How many distinct files are behind what is loaded. */
  files: number;
}

export interface ChromeHandlers {
  onFiles(files: File[]): void;
  onAddCases(): void;
  onSave(): void;
  /** Open a saved bundle from disk. */
  onLoad(): void;
  /** Open the Contents panel, from the memory readout. */
  onContents(): void;
}

/**
 * Wire the global chrome ONCE, from main.ts, never per section: two bindings
 * of `#save-btn` would open two dialogs, and two `drop` listeners would load
 * every file twice.
 */
export function createChrome(
  chrome: HTMLElement,
  handlers: ChromeHandlers,
): { render(state: ChromeState): void } {
  const statusText = within(chrome, '#status-text');
  const statusSpinner = within(chrome, '#status-spinner');
  const busyBar = within(chrome, '#busy-bar');
  const memoryReadout = within(chrome, '#memory-readout');

  within(chrome, '#add-cases-btn').addEventListener('click', () => handlers.onAddCases());
  within(chrome, '#save-btn').addEventListener('click', () => handlers.onSave());
  within(chrome, '#load-btn').addEventListener('click', () => handlers.onLoad());
  memoryReadout.addEventListener('click', () => handlers.onContents());

  const railToggleBtn = within<HTMLButtonElement>(chrome, '#rail-toggle-btn');
  const toggleRail = (): void => {
    const isCollapsed = chrome.classList.toggle('rail-collapsed');
    railToggleBtn.textContent = isCollapsed ? '▶ Filters' : '◀ Filters';
    railToggleBtn.title = isCollapsed
      ? 'Show filters sidebar (or press [)'
      : 'Hide filters sidebar (or press [)';
  };
  railToggleBtn.addEventListener('click', toggleRail);
  toggleRailAction = toggleRail;

  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.textContent = 'Drop GridView CSV exports to load them';
  document.body.appendChild(dropOverlay);

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth++;
    dropOverlay.classList.add('visible');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropOverlay.classList.remove('visible');
    }
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('visible');
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) handlers.onFiles(files);
  });

  // A load is refused input rather than raced: anything clicked while it runs
  // (a pin, a variable) is made against tables the load is still replacing.
  // `inert` also stops focus and keys, which a click shield alone would not.
  // The load's own dialogs are appended to <body>, outside `chrome`, and sit
  // above this, so they stay live.
  const busyOverlay = document.createElement('div');
  busyOverlay.className = 'busy-overlay';
  busyOverlay.hidden = true;
  const busyCard = document.createElement('div');
  busyCard.className = 'busy-overlay-card';
  busyCard.setAttribute('role', 'status');
  const busySpinner = document.createElement('span');
  busySpinner.className = 'status-spinner';
  busySpinner.setAttribute('aria-hidden', 'true');
  const busyMessage = document.createElement('span');
  busyCard.append(busySpinner, busyMessage);
  busyOverlay.appendChild(busyCard);
  document.body.appendChild(busyOverlay);

  return {
    render(state) {
      statusText.textContent = state.status;
      chrome.inert = state.busy;
      busyOverlay.hidden = !state.busy;
      if (state.busy) busyMessage.textContent = state.status;
      busyBar.hidden = !state.busy;
      statusSpinner.hidden = !state.busy;
      document.body.classList.toggle('is-busy', state.busy);
      memoryReadout.textContent =
        `${(state.bytes / (1024 * 1024)).toFixed(0)} MB · ` +
        `${state.cases} case${state.cases === 1 ? '' : 's'} · ` +
        `${state.files} file${state.files === 1 ? '' : 's'} ⓘ`;
    },
  };
}
