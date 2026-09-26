// src/ui/date-strip.ts
//
// The rail's "Months & days" control: a year strip of day cells, From/To
// fields, ◀ ▶ stepping and Day/Week/Month windows, all writing a set of days
// (`Filters.dates`): one run by a drag, more by Ctrl/Cmd-click. The
// arithmetic is `src/model/date-range.ts`'s; this module is pointer, keys and
// paint.
//
// **A drag moves the dates as it goes, at most once a frame.** Each change
// re-renders every pane and the browse drawer, and a pointer reports far more
// often than a screen repaints.
//
// **Arrow keys stop here.** The shell's one keydown owner skips only inputs
// and selects, and the strip is a focusable div: an arrow let through would
// also reach the section's shortcuts.

import { DAY_NAMES, HOURS_PER_YEAR, MONTH_LENGTHS, MONTH_NAMES } from '../model/calendar';
import {
  DAYS_PER_YEAR,
  MONTH_STARTS,
  addRun,
  dayLabel,
  extendSet,
  hasDay,
  monthRange,
  parseDay,
  rangeOf,
  sameSet,
  setBounds,
  setDays,
  slideSet,
  stepSet,
  toggleDay,
  weekdayOf,
  windowFrom,
  type DateSet,
} from '../model/date-range';

export interface DateStrip {
  /** `years` are the loaded Cases' distinct years: weekends are shaded only
   * when there is exactly one, since a date's weekday is its year's. */
  render(dates: DateSet | null, years: readonly number[]): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

export function createDateStrip(
  host: HTMLElement,
  onChange: (dates: DateSet | null) => void,
): DateStrip {
  host.classList.add('date-strip');

  // --------------------------------------------------------------- build
  const rangeRow = el('div', 'ds-range-row', host);
  const prev = el('button', 'ds-btn ds-step', rangeRow);
  prev.type = 'button';
  prev.textContent = '◀';
  prev.title = "Step back by the window's length (← on the strip; Alt+← slides one day)";
  const field = (name: string): HTMLInputElement => {
    const label = el('label', 'ds-field', rangeRow);
    el('span', '', label).textContent = name;
    const input = el('input', 'ds-input', label);
    input.autocomplete = 'off';
    input.spellcheck = false;
    return input;
  };
  const fromInput = field('From');
  fromInput.placeholder = 'Jan 1';
  const toInput = field('To');
  toInput.placeholder = 'Dec 31';
  const next = el('button', 'ds-btn ds-step', rangeRow);
  next.type = 'button';
  next.textContent = '▶';
  next.title = "Step forward by the window's length (→ on the strip; Alt+→ slides one day)";

  const presets = el('div', 'ds-presets', host);
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', 'Window length');
  const windows = [
    ['day', 'Day'],
    ['week', 'Week'],
    ['month', 'Month'],
  ] as const;
  for (const [length, text] of windows) {
    const button = el('button', 'ds-btn', presets);
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', () =>
      commit([windowFrom(committed ? committed[0].start : 0, length)]),
    );
  }
  el('span', 'ds-hint', presets).textContent = 'from “From”';

  const strip = el('div', 'ds-strip', host);
  strip.tabIndex = 0;
  strip.setAttribute('role', 'group');
  strip.setAttribute(
    'aria-label',
    "Year strip: drag to pick days, Ctrl-click to add or remove one, click a month's name for the whole month",
  );
  strip.title =
    'Drag or shift-click to pick days; Ctrl-click (⌘ on a Mac) adds or removes a day, Ctrl-drag adds a run. ' +
    '← → step, Alt+← → slide a day, Shift+← → move the end.';
  const names: HTMLButtonElement[] = [];
  const cells: HTMLElement[] = [];
  for (let m = 0; m < 12; m++) {
    const name = el('button', 'ds-month', strip);
    name.type = 'button';
    name.textContent = MONTH_NAMES[m];
    name.title = `All of ${MONTH_NAMES[m]} (shift-click to run to it, Ctrl-click to add or remove it)`;
    name.tabIndex = -1;
    name.addEventListener('click', (event) => {
      const whole = monthRange(m);
      if (event.ctrlKey || event.metaKey) {
        // A month already picked in full comes out; otherwise it goes in.
        const picked = committed?.some((run) => run.start <= whole.start && run.end >= whole.end);
        let next: DateSet | null = committed;
        if (picked) {
          for (let day = whole.start; day <= whole.end; day++) next = toggleDay(next, day);
        } else {
          next = addRun(committed, whole);
        }
        commit(next);
      } else if (event.shiftKey && committed) {
        const bounds = setBounds(committed);
        commit([rangeOf(Math.min(bounds.start, whole.start), Math.max(bounds.end, whole.end))]);
      } else {
        anchor = whole.start;
        commit([whole]);
      }
    });
    names.push(name);
    const row = el('div', 'ds-days', strip);
    for (let i = 0; i < MONTH_LENGTHS[m]; i++) {
      const cell = el('div', 'ds-day', row);
      cell.dataset.day = String(MONTH_STARTS[m] + i);
      cells.push(cell);
    }
  }

  const readout = el('div', 'ds-readout', host);
  const summary = el('span', '', readout);
  const hover = el('span', '', readout);
  const yearNote = el('p', 'ds-note', host);
  yearNote.hidden = true;

  // --------------------------------------------------------------- state
  let committed: DateSet | null = null;
  /** What the strip paints: the committed set, or a drag in progress. */
  let shown: DateSet | null = null;
  let anchor = 0;
  let dragging = false;
  /** A Ctrl/Cmd press: adds to `base` rather than replacing it. A press that
   * never leaves its day toggles that day; one that moves adds a run. */
  let adding: { base: DateSet | null; start: number; moved: boolean } | null = null;
  let years: readonly number[] = [];
  let hovered: number | null = null;

  function commit(set: DateSet | null): void {
    shown = set;
    if (sameSet(set, committed)) {
      paint();
      return;
    }
    onChange(set);
  }

  // ------------------------------------------------------------- pointer
  function dayAt(event: PointerEvent): number | null {
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const day = target?.dataset.day;
    return day === undefined || !strip.contains(target) ? null : Number(day);
  }

  strip.addEventListener('pointerdown', (event) => {
    const day = dayAt(event);
    if (day === null) return;
    event.preventDefault();
    strip.focus({ preventScroll: true });
    adding = null;
    if (event.ctrlKey || event.metaKey) {
      anchor = day;
      adding = { base: committed, start: day, moved: false };
      shown = toggleDay(committed, day);
    } else if (event.shiftKey && committed) {
      shown = [rangeOf(anchor, day)];
    } else {
      anchor = day;
      shown = [rangeOf(day, day)];
    }
    dragging = true;
    strip.setPointerCapture(event.pointerId);
    paint();
    live();
  });
  strip.addEventListener('pointermove', (event) => {
    const day = dayAt(event);
    showHover(day);
    if (dragging && day !== null) {
      if (adding && day !== adding.start) adding.moved = true;
      const set = !adding
        ? [rangeOf(anchor, day)]
        : adding.moved
          ? addRun(adding.base, rangeOf(anchor, day))
          : toggleDay(adding.base, day);
      if (!sameSet(set, shown)) {
        shown = set;
        paint();
        live();
      }
    }
  });
  let frame = 0;
  /** Commit the dragged range on the next frame, dropping any in between. */
  function live(): void {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (dragging && !sameSet(shown, committed)) onChange(shown);
    });
  }
  const release = (): void => {
    if (!dragging) return;
    dragging = false;
    adding = null;
    cancelAnimationFrame(frame);
    frame = 0;
    commit(shown);
  };
  strip.addEventListener('pointerup', release);
  strip.addEventListener('pointercancel', release);
  strip.addEventListener('pointerleave', () => showHover(null));
  // Ctrl-click is a right-click on macOS: no menu over the strip.
  strip.addEventListener('contextmenu', (event) => event.preventDefault());

  // ---------------------------------------------------------------- keys
  strip.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    if (!committed) return;
    const dir = event.key === 'ArrowRight' ? 1 : -1;
    if (event.altKey) commit(slideSet(committed, dir));
    else if (event.shiftKey) commit(extendSet(committed, dir));
    else commit(stepSet(committed, dir));
  });
  prev.addEventListener('click', () => committed && commit(stepSet(committed, -1)));
  next.addEventListener('click', () => committed && commit(stepSet(committed, 1)));

  // --------------------------------------------------------------- typed
  for (const [input, end] of [
    [fromInput, false],
    [toInput, true],
  ] as const) {
    const enter = (): void => {
      const parsed = parseDay(input.value);
      const refused = 'refusal' in parsed;
      input.classList.toggle('ds-bad', refused);
      input.title = refused ? parsed.refusal : '';
      if (refused) return;
      const day = parsed.day;
      input.value = dayLabel(day);
      // Typing makes one run from the set's first or last day.
      const range = committed ? setBounds(committed) : { start: 0, end: DAYS_PER_YEAR - 1 };
      if (end) {
        commit([rangeOf(Math.min(range.start, day), day)]);
      } else {
        anchor = day;
        commit([rangeOf(day, Math.max(day, range.end))]);
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') enter();
    });
    input.addEventListener('change', enter);
  }

  // --------------------------------------------------------------- paint
  function showHover(day: number | null): void {
    if (hovered !== null) cells[hovered].classList.remove('ds-hover');
    hovered = day;
    if (day === null) {
      hover.textContent = '';
      return;
    }
    cells[day].classList.add('ds-hover');
    hover.textContent =
      years.length === 0
        ? dayLabel(day)
        : years.length === 1
          ? `${DAY_NAMES[weekdayOf(years[0], day)]} ${dayLabel(day)}`
          : `${dayLabel(day)} · ` +
            years.map((year) => `${DAY_NAMES[weekdayOf(year, day)]} in ${year}`).join(', ');
  }

  function paint(): void {
    const set = shown;
    const range = set === null ? null : setBounds(set);
    cells.forEach((cell, day) => {
      const inside = set !== null && hasDay(set, day);
      cell.classList.toggle('ds-in', inside);
      cell.classList.toggle(
        'ds-edge',
        inside && set!.some((run) => day === run.start || day === run.end),
      );
    });
    names.forEach((name, m) => {
      const whole = monthRange(m);
      name.classList.toggle(
        'ds-whole',
        set !== null && set.some((run) => run.start <= whole.start && run.end >= whole.end),
      );
    });
    if (document.activeElement !== fromInput) {
      fromInput.value = range ? dayLabel(range.start) : '';
      fromInput.classList.remove('ds-bad');
    }
    if (document.activeElement !== toInput) {
      toInput.value = range ? dayLabel(range.end) : '';
      toInput.classList.remove('ds-bad');
    }
    prev.disabled = !set || sameSet(stepSet(set, -1), set);
    next.disabled = !set || sameSet(stepSet(set, 1), set);

    const days = set ? setDays(set) : DAYS_PER_YEAR;
    const bold = document.createElement('b');
    bold.textContent = set
      ? `${days} day${days === 1 ? '' : 's'}${set.length > 1 ? ` in ${set.length} runs` : ''}`
      : 'All dates';
    summary.replaceChildren(
      bold,
      ` · ${(days * 24).toLocaleString('en-US')} of ${HOURS_PER_YEAR.toLocaleString('en-US')} h`,
    );
  }

  function shade(): void {
    const one = years.length === 1 ? years[0] : null;
    cells.forEach((cell, day) => {
      const weekday = one === null ? -1 : weekdayOf(one, day);
      cell.classList.toggle('ds-weekend', weekday >= 5);
    });
    yearNote.textContent =
      years.length > 1
        ? `No weekends shaded: ${years.join(' and ')} put them on different dates. Hover a day for its weekday in each year.`
        : '';
    yearNote.hidden = years.length <= 1;
  }

  return {
    render(dates, loadedYears) {
      committed = dates;
      if (!dragging) shown = dates;
      if (loadedYears.join() !== years.join()) {
        years = [...loadedYears];
        shade();
      }
      paint();
    },
  };
}
