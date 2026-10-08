// src/ui/browse-model.ts
//
// FIND, without a DOM: what a browse tab is, how sorting and column filters
// reorder it, and what a ticked row means. Pure data, tested under Node, so it
// imports nothing that touches the document (hence `ui/palette.ts`).
//
//   * **The rows are the lookup table**, not a synthetic stats grid. Sorting
//     and filtering are table interactions over column accessors. There is no
//     query language, and adding one is a design change, not a feature.
//   * **A computed column is marked as computed** and painted differently. A
//     derived number that looks stored misleads the analyst who trusts it.
//   * **A filter a grouped build consumes is a keep-set.** It is evaluated once
//     over the ungrouped rows (the only place its columns exist); the grouped
//     tab restates it as a context column and does not re-ask it of the
//     aggregate.
//   * **Default columns are the adapter's, visibility and order the view's.**
//     Hiding a column clears its filter, so nothing constrains rows from behind
//     a column nobody can see. Order is one list over hidden and shown columns,
//     reconciled (not reset) when the tab's columns change.

import { RANKED, RANKED_FIELDS, type RankedRow } from '../kernels';
import { CASE_GROUP_BY, memberSignature } from '../series/model';
import { CASE_COLORS } from './palette';

/** A cell's value. `null` is blank, whatever the file spelled it. */
export type CellValue = string | number | null;

/**
 * One row of a browse tab: a series that could be drawn, identified as
 * `SeriesSpec` identifies it (case, slot, subject). `axisIndex` is -1 for a
 * row the table does not carry, such as a GeneratorList unit the export never
 * mentioned. It is listed blank rather than dropped, so the import does not
 * look like it lost units.
 */
export interface BrowseRowRef {
  /** Unique across every tab: what a pin stores and what a swatch is keyed on. */
  readonly id: string;
  readonly kind: string;
  /** The Case, by id only: its label is resolved when the row is drawn
   * (`caseLabel`), so a renamed Case relabels rows already built and pinned. */
  readonly caseId: string;
  /** The Case's slot-map key, e.g. `generator Generation (MWh)`. */
  readonly slotKey: string;
  /** The subject on the table's own axis: a generator NAME, a bus NUMBER. A
   * bus id stays a number because bus names can repeat and the id is the
   * identity. */
  readonly entity: string | number;
  /** What a human reads, e.g. `WILLOWBEND (10002)`. Defaults to the entity. */
  readonly label?: string;
  /** The quantity this row would draw, from the table's title line. */
  readonly variable: string;
  readonly unit: string;
  /** Where this row sits on the table's axis, or -1 when it is not on it. */
  readonly axisIndex: number;
  readonly groupBy?: string;
  readonly groupValue?: string;
  /** For a group narrowed by a filter or scope: the member keys, frozen at
   * build time. A pin outlives its view, so its membership cannot be
   * re-derived from a bucket the filters have since rebuilt. Absent means the
   * whole (live) bucket. */
  readonly members?: readonly (string | number)[];
  /** For a group built under column filters: the constraints that chose its
   * members, frozen at build time so a pin's label does not change when the
   * filter moves. */
  readonly filterContext?: readonly FilterContextEntry[];
  /** Whether this row is drawn as "% of range" (`src/series/range.ts`). The
   * field name is bundle wire format: renaming it breaks restoring saved pins. */
  readonly perUnit?: boolean;
}

/** What a row's id is made of: everything two rows can differ in while
 * drawing different lines. */
export type RowIdParts = Pick<
  BrowseRowRef,
  'caseId' | 'slotKey' | 'entity' | 'variable' | 'groupBy' | 'groupValue' | 'members' | 'perUnit'
>;

/**
 * A row's id, built from its parts by every tab and by a restore alike: a tick,
 * a swatch and the Selected tab all match on it, so a restore must produce the
 * same string the live tab builds. The quantity is in every id; the member
 * signature separates one group narrowed two ways; `p.u.` separates a
 * "% of range" line from the same line in MW. Restored pins match on that
 * token, so its spelling is wire format.
 */
export function rowIdOf(parts: RowIdParts): string {
  return [
    parts.caseId,
    parts.slotKey,
    parts.groupBy !== undefined ? `${parts.groupBy}=${parts.groupValue}` : String(parts.entity),
    parts.variable,
    parts.members ? `m=${memberSignature(parts.members)}` : '',
    parts.perUnit ? 'p.u.' : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

/** A row with its id filled in from its own parts -- what a tab builder pushes. */
export function withRowId<T extends RowIdParts>(ref: T): T & { readonly id: string } {
  return { ...ref, id: rowIdOf(ref) };
}

/**
 * What a row's subject reads as now. A by-Case bucket keeps the Case's
 * original name as its group value (it is in the row id, and saved pins match
 * on it), so its label is swapped for the Case's label here, at draw time.
 */
export function rowSubject(
  ref: Pick<BrowseRowRef, 'caseId' | 'entity' | 'label' | 'groupBy' | 'groupValue'>,
  caseLabelOf: (caseId: string) => string,
): string {
  const label = ref.label ?? String(ref.entity);
  const value = ref.groupValue;
  if (ref.groupBy !== CASE_GROUP_BY || value === undefined || !label.startsWith(value))
    return label;
  return caseLabelOf(ref.caseId) + label.slice(value.length);
}

/** A tab's Case labels by Case id, from the scoped tables that carry them. */
export function caseLabelsOf(
  tables: readonly { readonly caseId: string; readonly caseLabel: string }[],
): (caseId: string) => string {
  const labels = new Map(tables.map((table) => [table.caseId, table.caseLabel] as const));
  return (caseId) => labels.get(caseId) ?? caseId;
}

/**
 * A group row's label: its name, plus a member count only when the row
 * FREEZES the members counted. An unnarrowed group redraws from live
 * membership under the same row id, so a count in a pinned label would go
 * stale after the next edit. The tab's count column carries the live count.
 */
export function groupRowLabel(
  name: string,
  frozenCount: number | undefined,
  noun: { readonly one: string; readonly many: string },
): string {
  if (frozenCount === undefined) return name;
  return `${name} (${frozenCount} ${frozenCount === 1 ? noun.one : noun.many})`;
}

/**
 * How a number cell is rounded for display: quantity (whole, separated),
 * ratio (whole percent), count (bare). The class belongs to the COLUMN: the
 * same 0.43 is 43% in one column and 43 MW in another. Default: quantity.
 */
export type CellClass = 'quantity' | 'ratio' | 'count';

export interface BrowseColumn {
  /** Stable across a re-scope: sort and filter state is keyed on it. */
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'number';
  /** True when this app computed the number, false when a file carried it. */
  readonly computed: boolean;
  /** The tab opens without this column; the chooser brings it back. Which
   * columns an analyst reads first is domain knowledge, so the adapter names
   * the default. */
  readonly defaultHidden?: boolean;
  /** A column that restates a constraint (a filter the grouped build consumed)
   * rather than carrying data. Painted as plain text, with no sort, group or
   * filter controls. */
  readonly context?: boolean;
  /** Whether this column supports grouping into collapsed aggregate rows:
   * a category AND a quantity that may be summed across it. */
  readonly groupable?: boolean;
  /** A category: a column whose values name buckets (an enum lookup column,
   * the Case), so it can be shown as a Slicer. Not `groupable`: filtering
   * interfaces by a category sums nothing, so Interface columns are
   * categories that never group. */
  readonly category?: boolean;
  /** Shown as a Slicer when a tab first opens. The Case column is one on
   * every tab without saying so. */
  readonly defaultSlicer?: boolean;
  /** When grouping is not defensible for this column/tab, why it is refused. */
  readonly groupDisabledReason?: string;
  /** The group-by key this column's toggle sets, when the grouped form lists
   * its buckets under another key. A grouped column that reused this
   * column's key would give one filter two meanings: consumed over this
   * column's values, and ticked from the buckets' names. */
  readonly groupsAs?: string;
  /** How a number column's cells are rounded; missing means quantity. May vary
   * per row where one column mixes kinds (the Selected tab's per-unit
   * generator ratio beside a bus's MW). */
  readonly cellClass?: CellClass | ((row: number) => CellClass);
  value(row: number): CellValue;
}

/** The class a column's cell in `row` renders as: the one place the hint is
 * read. */
export function cellClassOf(column: BrowseColumn, row: number): CellClass {
  const hint = column.cellClass;
  if (hint === undefined) return 'quantity';
  return typeof hint === 'function' ? hint(row) : hint;
}

/** One kind's tab, built by that kind's own adapter
 * (`src/tables/generator/ui/browse.ts`). The drawer holds these and knows
 * nothing about what is in them. */
export interface BrowseTab {
  readonly id: string;
  readonly label: string;
  /**
   * Emitted in a DETERMINISTIC order the adapter documents: the drawer sorts
   * on top of it, and identical inputs must produce identical row ids so a
   * re-scope keeps a surviving row's pin and colour.
   */
  readonly rows: readonly BrowseRowRef[];
  readonly columns: readonly BrowseColumn[];
  /** What the tab says about itself (a scope it could not apply, a list it
   * needs). A refusal belongs on the tab that could not do the thing. */
  readonly notes: readonly string[];
  /** e.g. opening editors. */
  readonly actions?: readonly { id: string; label: string }[];
  /** Filter keys the grouped build already applied before aggregating, which
   * `visibleRows` skips: a max bound on units is not a max bound on their
   * sum. Absent on an ungrouped tab. */
  readonly consumedFilters?: ReadonlySet<string>;
  /** Controls that rewrite every row, painted on a header's second line and
   * keyed by the column they sit above (the Selected tab's "Switch all"). */
  readonly switches?: ReadonlyMap<string, SwitchControl>;
  /** Controls that rewrite one row, painted in its cell in place of the
   * text, by column key. */
  readonly rowSwitches?: ReadonlyMap<string, (row: number) => SwitchControl | undefined>;
}

/** One switch: a native `<select>`, so a focused, closed one steps its
 * options with the arrow keys and skips the disabled ones by itself. */
export interface SwitchControl {
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    /** Why this option is off, or undefined when it can be chosen. */
    readonly disabled?: string;
  }[];
  readonly value: string;
  /** Why the whole control is off, or undefined when it answers. */
  readonly refusal?: string;
  readonly title: string;
  onChange(value: string): void;
}

/**
 * The fixed stat columns, in display order. Kind-neutral because the Selected
 * tab finds them by key for every kind. No user-defined threshold columns: a
 * threshold needs a value, unit and comparison, which is a query language.
 */
export const STAT_COLUMNS = [
  { key: 'stat.min', label: 'Min' },
  { key: 'stat.max', label: 'Max' },
  { key: 'stat.mean', label: 'Average' },
  { key: 'stat.sd', label: 'StdDev' },
  { key: 'stat.p25', label: 'p25' },
  { key: 'stat.p75', label: 'p75' },
  { key: 'stat.n', label: 'Hours' },
] as const;

type StatKey = (typeof STAT_COLUMNS)[number]['key'];

/** Whether `key` names one of the fixed stat columns. */
function isStatKey(key: string): key is StatKey {
  return Object.hasOwn(STAT_FIELDS, key);
}

/** Which slot of a ranked-stats row each stat column reads. Kept beside
 * `STAT_COLUMNS` because the two are one fact. */
const STAT_SLOTS: Readonly<Record<StatKey, number>> = {
  'stat.min': RANKED.min,
  'stat.max': RANKED.max,
  'stat.mean': RANKED.mean,
  'stat.sd': RANKED.sd,
  'stat.p25': RANKED.p25,
  'stat.p75': RANKED.p75,
  'stat.n': RANKED.n,
};

/**
 * Which field of a stats object each stat column reads, for grouped tabs,
 * which rank a group per row. A map, so a renamed stat key fails loudly rather
 * than going blank. `StatFields` is exactly the seven fields shown.
 */
export type StatFields = Pick<RankedRow, 'n' | 'mean' | 'min' | 'max' | 'sd' | 'p25' | 'p75'>;

const STAT_FIELDS: Readonly<Record<StatKey, keyof StatFields>> = {
  'stat.min': 'min',
  'stat.max': 'max',
  'stat.mean': 'mean',
  'stat.sd': 'sd',
  'stat.p25': 'p25',
  'stat.p75': 'p75',
  'stat.n': 'n',
};

/**
 * What a pin's line is on the charts: drawn, with the stats of exactly what
 * is drawn under the hour filter, or not drawn and why. The Selected tab
 * greys a row only for the second; a pin its kind's tab does not list under
 * the current view (another variable, a group-by undone, a filter moved) is
 * still drawn and still has numbers.
 */
export type PinLine =
  | { readonly drawn: true; readonly stats: StatFields }
  | { readonly drawn: false; readonly reason: string };

/** A resolved line, as much of it as a pin's answer reads. */
export interface ResolvedLine {
  readonly rowId?: string;
  readonly dashed?: boolean;
  readonly values: Float32Array | null;
  readonly refusal?: string;
  readonly stats: { n: number; mean: number; min: number; max: number; sd: number };
  readonly quantiles: { p25: number; p75: number };
}

/**
 * Each pin's line after a render. `capped` is the series cap's refusal when
 * the render drew nothing; a pin with no line at all had its table removed.
 */
export function pinLines(
  pinIds: readonly string[],
  lines: readonly ResolvedLine[],
  capped?: string,
  /** The click preview took the drawn set past the cap: the pins alone fit,
   * so they are not what to unpin. */
  cappedByPreview = false,
): Map<string, PinLine> {
  const byId = new Map<string, ResolvedLine>();
  for (const line of lines)
    if (!line.dashed && line.rowId !== undefined) byId.set(line.rowId, line);
  const out = new Map<string, PinLine>();
  for (const id of pinIds) {
    const line = byId.get(id);
    if (capped !== undefined) {
      out.set(id, {
        drawn: false,
        reason: cappedByPreview
          ? 'the previewed row takes the charts past the most lines they draw'
          : 'more series are pinned than the charts draw',
      });
    } else if (!line) {
      out.set(id, { drawn: false, reason: 'its table is no longer loaded' });
    } else if (line.values === null) {
      out.set(id, { drawn: false, reason: line.refusal ?? 'refused' });
    } else {
      const { stats, quantiles } = line;
      out.set(id, {
        drawn: true,
        stats: {
          n: stats.n,
          mean: stats.mean,
          min: stats.min,
          max: stats.max,
          sd: stats.sd,
          p25: quantiles.p25,
          p75: quantiles.p75,
        },
      });
    }
  }
  return out;
}

/** One stat column's value in a stats object; NaN is blank. */
export function statValue(stats: StatFields, key: string): number | null {
  if (!isStatKey(key)) return null;
  const value = stats[STAT_FIELDS[key]];
  return Number.isNaN(value) ? null : value;
}

/** The hours count is always a count, whatever the tab's class. */
function statCellClass(stat: { key: string }, cellClass: CellClass): CellClass {
  return stat.key === 'stat.n' ? 'count' : cellClass;
}

/** The hours count starts hidden: it is a whole year on nearly every row and
 * pushes the stats that differ off screen. */
function statHidden(stat: { key: string }): true | undefined {
  return stat.key === 'stat.n' || undefined;
}

/** A ratio's label says it is a percent, so 43 in a Max column is not misread. */
function statLabel(stat: { key: string; label: string }, cellClass: CellClass): string {
  return cellClass === 'ratio' && stat.key !== 'stat.n' ? `${stat.label} (%)` : stat.label;
}

/**
 * The fixed stat columns over one stats object per row, for GROUPED tabs.
 * `statsOf` returning nothing is a blank row, not a zero: a group with no data
 * has no average.
 */
export function statColumnsFrom(
  statsOf: (row: number) => StatFields | null | undefined,
  cellClass: CellClass = 'quantity',
): BrowseColumn[] {
  return STAT_COLUMNS.map((stat) => ({
    key: stat.key,
    label: statLabel(stat, cellClass),
    kind: 'number' as const,
    computed: true,
    cellClass: statCellClass(stat, cellClass),
    defaultHidden: statHidden(stat),
    value: (row: number) => {
      const stats = statsOf(row);
      return stats ? statValue(stats, stat.key) : null;
    },
  }));
}

/**
 * The fixed stat columns over one `rankedStats` result. NaN becomes `null`
 * here: an absent hour and a zero are different answers.
 */
export function statColumns(
  ranked: Float64Array,
  cellClass: CellClass = 'quantity',
): BrowseColumn[] {
  return STAT_COLUMNS.map((stat) => {
    const slot = STAT_SLOTS[stat.key];
    return {
      key: stat.key,
      label: statLabel(stat, cellClass),
      kind: 'number' as const,
      computed: true,
      cellClass: statCellClass(stat, cellClass),
      defaultHidden: statHidden(stat),
      value: (row: number) => {
        const value = ranked[row * RANKED_FIELDS + slot];
        return Number.isNaN(value) ? null : value;
      },
    };
  });
}

export type ColumnFilter =
  /** Case-insensitive substring, over the cell as it is displayed. */
  | { readonly kind: 'text'; readonly text: string }
  /** Exact, case-sensitive, over the trimmed displayed cell: what a tick in
   * the checklist means. Not folded into `text`, where "SAMPLE_HYDRO" would
   * also keep "SAMPLE_HYDRO: Pump 1" and a name holding a comma would split. */
  | { readonly kind: 'values'; readonly values: readonly string[] }
  /** Inclusive bounds; `null` means unbounded. */
  | { readonly kind: 'range'; readonly min: number | null; readonly max: number | null };

export interface SortState {
  readonly key: string;
  readonly direction: 'asc' | 'desc';
}

export interface ViewState {
  readonly sort: SortState | null;
  readonly filters: ReadonlyMap<string, ColumnFilter>;
  /** Columns the user explicitly showed or hid, overriding each default. */
  readonly columnOverrides?: ReadonlyMap<string, boolean>;
  /** Column order over hidden and shown columns; visibility filters it. Keys
   * the tab lost are skipped and new keys append, so a changed tab never
   * resets the arrangement. Absent means the adapter's order. */
  readonly columnOrder?: readonly string[];
  /** The column key currently grouped by, or null/undefined when listing individual entities. */
  readonly groupBy?: string | null;
  /** Columns shown as Slicers. Absent means the tab's defaults
   * (`defaultSlicers`). Not saved in a bundle, like the rest of the view. */
  readonly slicers?: ReadonlySet<string>;
}

// ------------------------------------------------------ column visibility
//
// A context column and the group-by column cannot be hidden: each explains
// what the rows are.

/** Whether one column is on screen under this view: the user's override when
 * there is one, otherwise the column's own default. */
export function columnVisible(column: BrowseColumn, view: ViewState): boolean {
  if (column.context || column.key === view.groupBy) return true;
  const override = view.columnOverrides?.get(column.key);
  return override === undefined ? !column.defaultHidden : override;
}

/** Show or hide one column. Hiding clears its filter, so no hidden column
 * silently constrains the rows, and takes its Slicer with it: a default one
 * too, so showing the column again does not bring it back unasked. */
export function setColumnVisible(
  tab: BrowseTab,
  view: ViewState,
  key: string,
  visible: boolean,
): ViewState {
  const overrides = new Map(view.columnOverrides ?? []);
  overrides.set(key, visible);
  let filters = view.filters;
  if (!visible && filters.has(key)) {
    const next = new Map(filters);
    next.delete(key);
    filters = next;
  }
  const sliced = !visible && isSliced(tab, view, key);
  const unsliced = sliced ? setSliced(tab, view, key, false) : view;
  return { ...unsliced, columnOverrides: overrides, filters };
}

// ---------------------------------------------------------------- slicers
//
// A Slicer IS its column's filter, shown as a standing checklist: there is
// one value per column, written by the slicer and the dropdown alike, so
// there is no precedence to explain. A hidden column shows no slicer, since
// its filter is gone.

/** The keys a tab shows as Slicers when the view has chosen none. */
export function defaultSlicers(tab: BrowseTab): ReadonlySet<string> {
  return new Set(
    tab.columns
      .filter(
        (column) => column.category && (column.key === CASE_COLUMN_KEY || column.defaultSlicer),
      )
      .map((column) => column.key),
  );
}

/** Whether `key` is a Slicer under this view, on screen or not. */
export function isSliced(tab: BrowseTab, view: ViewState, key: string): boolean {
  return (view.slicers ?? defaultSlicers(tab)).has(key);
}

/** The columns shown as Slicers, in column order: categories on screen. */
export function slicerColumns(tab: BrowseTab, view: ViewState): BrowseColumn[] {
  const keys = view.slicers ?? defaultSlicers(tab);
  return orderedColumns(tab, view).filter(
    (column) => column.category && keys.has(column.key) && columnVisible(column, view),
  );
}

/** Show or hide one column as a Slicer. The first choice turns the defaults
 * into an explicit set, so dropping the Case slicer keeps it dropped. */
export function setSliced(tab: BrowseTab, view: ViewState, key: string, on: boolean): ViewState {
  const next = new Set(view.slicers ?? defaultSlicers(tab));
  if (on) next.add(key);
  else next.delete(key);
  return { ...view, slicers: next };
}

/** Empty the filter map. Sort, group-by and the column arrangement stay. */
export function clearFilters(view: ViewState): ViewState {
  return { ...view, filters: new Map() };
}

/**
 * Drop the bounds on the columns "% of range" rescales, which are the ones
 * that depend on the variable shown (`dependsOnVariable`). A bound typed as
 * 500 MW means nothing against 85%, and would silently empty the table. The
 * hours count keeps its bound: it is a count either way. Returns `view` when
 * nothing is dropped.
 */
export function dropRescaledBounds(view: ViewState): ViewState {
  const filters = new Map(
    [...view.filters].filter(([key, filter]) => filter.kind !== 'range' || !dependsOnVariable(key)),
  );
  return filters.size === view.filters.size ? view : { ...view, filters };
}

/**
 * What the stat cells of `rows` are in: each row's variable, unit and "% of
 * range", sorted so an order change reads the same. A stat bound is typed
 * against this, so a view shown as something else drops it
 * (`dropRescaledBounds`): a Variable change or a "% of range" toggle.
 * Undefined with no rows, which shows nothing to type a bound against.
 */
export function statsShownAs(
  rows: readonly Pick<BrowseRowRef, 'variable' | 'unit' | 'perUnit'>[],
): string | undefined {
  if (rows.length === 0) return undefined;
  return rows
    .map((row) => `${row.variable}\u0000${row.unit}\u0000${row.perUnit ? '%' : ''}`)
    .sort()
    .join('\u0001');
}

/** `view` with its stat bounds kept when they were typed against what the
 * rows now show, and dropped when not. `typedOn` undefined keeps them. */
export function boundsFollow(
  view: ViewState,
  typedOn: string | undefined,
  shownOn: string | undefined,
): ViewState {
  if (typedOn === undefined || shownOn === undefined || typedOn === shownOn) return view;
  return dropRescaledBounds(view);
}

/** Group by `key`, or by nothing. Sort resets, since a grouped sort key may
 * not exist on the other form; filters and the column arrangement stay. The
 * header's toggle and the notes-row chip both go through here. */
export function setGroupBy(view: ViewState, key: string | null): ViewState {
  return { ...view, groupBy: key, sort: null };
}

/** One notes-row chip: a view state shaping the rows, and the transform that
 * clears it. */
export interface ViewChip {
  readonly key: 'filters' | 'group';
  readonly label: string;
  readonly clear: (view: ViewState) => ViewState;
}

/**
 * The chips for a BUILT tab under its view: one for the filters that shape
 * the rows, one for a group-by the build honoured (a declined one claims
 * nothing). A filter counts when its column is on screen, or when the grouped
 * build consumed it; a hidden column's does not.
 */
export function viewChips(tab: BrowseTab, view: ViewState): ViewChip[] {
  const chips: ViewChip[] = [];
  const byKey = new Map(tab.columns.map((column) => [column.key, column]));
  let filters = 0;
  for (const key of view.filters.keys()) {
    if (shapesRows(tab, view, key, byKey.get(key))) filters++;
  }
  if (filters > 0) {
    const label = `${filters} filter${filters === 1 ? '' : 's'}`;
    chips.push({ key: 'filters', label, clear: clearFilters });
  }
  const groupBy = builtView(tab, view).groupBy;
  if (groupBy) {
    // As the rows name it (Area's `entity` column is its Grouping).
    const named = byKey.get(groupBy)?.label ?? tab.rows[0]?.groupBy ?? groupBy;
    chips.push({
      key: 'group',
      label: `Grouped by ${named}`,
      clear: (view) => setGroupBy(view, null),
    });
  }
  return chips;
}

/** Whether the filter on `key` shapes the rows: its column is on screen, or
 * the grouped build consumed it. A hidden column's filter does not. */
function shapesRows(
  tab: BrowseTab,
  view: ViewState,
  key: string,
  column: BrowseColumn | undefined,
): boolean {
  return !!tab.consumedFilters?.has(key) || (!!column && columnVisible(column, view));
}

/** Columns in view order: stored order for keys that still exist, then new
 * keys in adapter order. */
export function orderedColumns(tab: BrowseTab, view: ViewState): BrowseColumn[] {
  const stored = view.columnOrder;
  if (!stored || stored.length === 0) return [...tab.columns];
  const byKey = new Map(tab.columns.map((column) => [column.key, column]));
  const ordered: BrowseColumn[] = [];
  for (const key of stored) {
    const column = byKey.get(key);
    if (column) {
      ordered.push(column);
      byKey.delete(key);
    }
  }
  for (const column of tab.columns) if (byKey.has(column.key)) ordered.push(column);
  return ordered;
}

/** The columns a tab shows. Paint, chooser and CSV export all read this. */
export function visibleColumns(tab: BrowseTab, view: ViewState): BrowseColumn[] {
  return orderedColumns(tab, view).filter((column) => columnVisible(column, view));
}

/**
 * What the header is built FROM, as one string, so it moves whenever a
 * rebuild would look different: the VISIBLE keys, plus every cell state such
 * as the group control. Picking Load after LMP keeps the same column keys,
 * so keys alone would leave stale disabled buttons. Sort arrows and filter
 * marks repaint in place and stay out of it. Asserted in
 * `tests/test_browse.mjs`.
 */
export function headerSignature(tab: BrowseTab, view: ViewState): string {
  const parts = [tab.id, view.groupBy ?? ''];
  for (const column of visibleColumns(tab, view)) {
    parts.push(
      column.key,
      column.label,
      column.kind,
      column.computed ? '1' : '0',
      column.context ? '1' : '0',
      column.groupable ? '1' : '0',
      column.groupDisabledReason ?? '',
    );
    const control = tab.switches?.get(column.key);
    if (control) {
      parts.push(control.value, control.refusal ?? '', control.title);
      for (const option of control.options) {
        parts.push(option.value, option.label, option.disabled ?? '');
      }
    }
  }
  // A separator no key, label or sentence contains.
  return parts.join('\u0000');
}

/** Move one column to `at` among the on-screen columns. The written order
 * covers hidden columns too, so an unhidden column returns to its place. */
export function moveColumnTo(tab: BrowseTab, view: ViewState, key: string, at: number): ViewState {
  const full = orderedColumns(tab, view);
  if (!full.some((column) => column.key === key)) return view;
  const rest = full.filter((column) => column.key !== key);
  const shown = rest.filter((column) => columnVisible(column, view));
  const target = Math.max(0, Math.min(at, shown.length));
  const keys: string[] = [];
  let passed = 0;
  for (const column of rest) {
    if (columnVisible(column, view)) {
      if (passed === target) keys.push(key);
      passed++;
    }
    keys.push(column.key);
  }
  if (passed === target) keys.push(key);
  return { ...view, columnOrder: keys };
}

/**
 * The text a cell shows, which is also what a text filter matches: the filter
 * follows what the eye reads. Rounding is paint-only. Separators are pinned to
 * en-US so a filter's match does not depend on the host locale.
 */
export function displayCell(value: CellValue, cellClass: CellClass = 'quantity'): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '';
    if (cellClass === 'ratio') {
      const percent = Math.round(value * 100);
      // Non-zero must not display as 0%.
      if (value !== 0 && percent === 0) return value > 0 ? '<1%' : '>-1%';
      return `${percent}%`;
    }
    if (cellClass === 'count') return String(Math.round(value));
    const whole = Math.round(value);
    // Non-zero must not display as 0.
    if (value !== 0 && whole === 0) return value > 0 ? '<1' : '>-1';
    // -0 (a reversed member's zero) reads as 0; en-US would print "-0".
    return (whole === 0 ? 0 : whole).toLocaleString('en-US');
  }
  return value;
}

/** The pieces of a typed text filter, as typed; commas and newlines separate. */
function textPieces(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** The lowercased pieces of a typed text filter. */
export function textTokens(text: string): string[] {
  return textPieces(text).map((t) => t.toLowerCase());
}

/** Whether a cell's displayed text contains any typed piece. No pieces keeps it. */
export function containsAnyToken(tokens: readonly string[], cell: string): boolean {
  if (tokens.length === 0) return true;
  const lower = cell.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

/**
 * A blank cell as a checklist names it. In a `values` filter a blank is the
 * empty string, which is what a blank cell displays, so ticking it keeps the
 * blank rows with no rule of its own.
 */
export const BLANK_LABEL = '(blank)';

/** A checklist value as it is read: the blank named, any other as itself. */
export function valueLabel(value: string): string {
  return value === '' ? BLANK_LABEL : value;
}

/** Filters are replaced, never mutated, so a set or token list per filter
 * object holds. */
const valueSets = new WeakMap<ColumnFilter, ReadonlySet<string>>();
const tokenLists = new WeakMap<ColumnFilter, readonly string[]>();

function passes(
  filter: ColumnFilter,
  value: CellValue,
  cellClass: CellClass = 'quantity',
): boolean {
  if (filter.kind === 'text') {
    let tokens = tokenLists.get(filter);
    if (!tokens) tokenLists.set(filter, (tokens = textTokens(filter.text)));
    return containsAnyToken(tokens, displayCell(value, cellClass));
  }
  if (filter.kind === 'values') {
    let set = valueSets.get(filter);
    if (!set) valueSets.set(filter, (set = new Set(filter.values)));
    return set.has(displayCell(value, cellClass).trim());
  }
  if (filter.min === null && filter.max === null) return true;
  // A blank cell fails a bound rather than sorting in at zero.
  if (typeof value !== 'number' || Number.isNaN(value)) return false;
  // A bound is typed in the units shown: 80 on a ratio column is 80%. The
  // scaling must not move a value off the bound it sits on (0.29 * 100 is
  // 28.999999999999996), so it keeps 12 significant digits. The comparison is
  // with the value, not the rounded cell: rounding is paint-only.
  const shown = cellClass === 'ratio' ? Number((value * 100).toPrecision(12)) : value;
  if (filter.min !== null && shown < filter.min) return false;
  if (filter.max !== null && shown > filter.max) return false;
  return true;
}

/**
 * The filters one pass evaluates. Skipped: keys the build consumed (asking
 * them of the aggregate is a different question), keys with no column (a
 * stale key must not empty the table), and hidden columns.
 */
function activeFilters(
  tab: BrowseTab,
  view: ViewState,
  skip?: ReadonlySet<string>,
): { column: BrowseColumn; filter: ColumnFilter }[] {
  const byKey = new Map(tab.columns.map((column) => [column.key, column]));
  const active: { column: BrowseColumn; filter: ColumnFilter }[] = [];
  for (const [key, filter] of view.filters) {
    if (skip?.has(key)) continue;
    const column = byKey.get(key);
    if (column && columnVisible(column, view)) active.push({ column, filter });
  }
  return active;
}

/**
 * Labels of the column filters removing rows from this tab, so an empty
 * table can say why. Filters are remembered per tab, so switching variable
 * can leave a Case filter that keeps nothing. Unlike `activeFilters`, a key
 * the build consumed is included: it chose which rows exist.
 */
export function filteringColumnLabels(tab: BrowseTab, view: ViewState): string[] {
  const byKey = new Map(tab.columns.map((column) => [column.key, column]));
  const labels: string[] = [];
  for (const key of view.filters.keys()) {
    const column = byKey.get(key);
    if (column && shapesRows(tab, view, key, column)) labels.push(column.label);
  }
  return labels;
}

/**
 * The rows a tab shows, filtered and sorted, as indexes into `tab.rows`.
 * Blanks sort last in both directions, and ties break on row index so the
 * order is stable.
 */
export function visibleRows(tab: BrowseTab, view: ViewState): Int32Array {
  const byKey = new Map(tab.columns.map((column) => [column.key, column]));
  const active = activeFilters(tab, view, tab.consumedFilters);

  const kept: number[] = [];
  outer: for (let row = 0; row < tab.rows.length; row++) {
    for (const { column, filter } of active) {
      if (!passes(filter, column.value(row), cellClassOf(column, row))) continue outer;
    }
    kept.push(row);
  }

  const sortColumn = view.sort ? byKey.get(view.sort.key) : undefined;
  if (view.sort && sortColumn) {
    const sign = view.sort.direction === 'asc' ? 1 : -1;
    const blank = (value: CellValue): boolean =>
      value === null || (typeof value === 'number' && Number.isNaN(value));
    // Each value read once: a grouped column's value is a join or a stats pass.
    const values = new Map(kept.map((row) => [row, sortColumn.value(row)]));
    kept.sort((a, b) => {
      const va = values.get(a) as CellValue;
      const vb = values.get(b) as CellValue;
      const aBlank = blank(va);
      const bBlank = blank(vb);
      if (aBlank || bBlank) return aBlank === bBlank ? a - b : aBlank ? 1 : -1;
      if (typeof va === 'number' && typeof vb === 'number') {
        return va === vb ? a - b : va < vb ? -sign : sign;
      }
      const compared = String(va).localeCompare(String(vb), undefined, { numeric: true });
      return compared === 0 ? a - b : compared < 0 ? -sign : sign;
    });
  }

  return Int32Array.from(kept);
}

// ------------------------------------------- filter context into a group
//
// Grouping drops the columns a filter was written against, and a filter
// must never quietly stop constraining the sums. These three functions are
// the kind-neutral mechanism: no kind learns what a filter is.

/** One constraint a grouped row was built under, as the row itself carries
 * it: the column's key and label, and the text the context cell shows. */
export interface FilterContextEntry {
  readonly key: string;
  readonly label: string;
  readonly constraint: string;
  /** What the filtered column measured when the constraint was chosen, set
   * when a Selected-tab switch moves the pin off it. "Max ≥ 500" on Load
   * says nothing about Generation. `case` is the Case's NAME (the key a
   * by-Case bucket's row id holds, which a rename in Contents leaves alone),
   * not its id: ids are minted fresh on restore and a caption is not worth
   * the remap. Field names are bundle wire format. */
  readonly chosenOn?: {
    readonly variable: string;
    readonly unit: string;
    readonly case?: string;
  };
}

/** How a frozen constraint finds the Case it was chosen in. */
export interface CaseNames {
  /** A Case's name, by id. */
  nameOf(caseId: string): string | undefined;
  /** What the Case with this name reads as now; the name itself when none. */
  labelOfName(name: string): string;
}

/** Whether a filter on this column depends on the variable shown: the stats
 * do; a list attribute, a group count and the hour count do not. By key,
 * so pins frozen before `chosenOn` existed are judged the same way. */
export function dependsOnVariable(key: string): boolean {
  return key === 'stat.cf' || (isStatKey(key) && key !== 'stat.n');
}

/** A frozen constraint as the pin now reads it: with what it was chosen on
 * when that is no longer what the pin shows. One text for the legend, the
 * Selected tab and its CSV. */
export function pinnedConstraint(
  entry: FilterContextEntry,
  ref: Pick<BrowseRowRef, 'variable' | 'unit' | 'caseId'>,
  cases: CaseNames,
): string {
  const chosen = entry.chosenOn;
  if (!chosen) return entry.constraint;
  const parts: string[] = [];
  if (chosen.case !== undefined && chosen.case !== cases.nameOf(ref.caseId)) {
    parts.push(`in ${cases.labelOfName(chosen.case)}`);
  }
  if (chosen.variable !== ref.variable) parts.push(`on ${chosen.variable}`);
  if (chosen.unit !== ref.unit && (chosen.unit === '%' || ref.unit === '%')) {
    parts.push(`in ${chosen.unit}`);
  }
  return parts.length === 0 ? entry.constraint : `${entry.constraint} (chosen ${parts.join(', ')})`;
}

/** The text that states a filter on screen; a range states its bounds. */
export function filterConstraint(filter: ColumnFilter): string {
  if (filter.kind === 'text') {
    const raw = filter.text.trim();
    const tokens = textPieces(raw);
    if (tokens.length <= 1) return `contains ${raw}`;
    return `contains any of (${tokens.join(', ')})`;
  }
  if (filter.kind === 'values') {
    // Ticks are a set (`sameFilter`), so they are stated in one order, or a
    // held build and a fresh one would say one filter two ways. A blank reads
    // last, as the checklist lists it.
    const named = [...new Set(filter.values)]
      .sort((a, b) =>
        a === '' || b === ''
          ? Number(a === '') - Number(b === '')
          : a.localeCompare(b, undefined, { numeric: true }),
      )
      .map(valueLabel);
    if (named.length === 1) return `is ${named[0]}`;
    return `is any of (${named.join(', ')})`;
  }
  if (filter.min !== null && filter.max !== null) return `${filter.min} – ${filter.max}`;
  if (filter.min !== null) return `≥ ${filter.min}`;
  if (filter.max !== null) return `≤ ${filter.max}`;
  return '';
}

/**
 * The column key every kind's Case column carries. `view.groupBy` is a column
 * key while a grouped row's `groupBy` is the bucket name (`CASE_GROUP_BY` in
 * src/series/model.ts): two strings for one thing, so both are constants.
 */
export const CASE_COLUMN_KEY = 'case';

/**
 * The (case, slot, entity) key a grouped build probes a kept row by.
 * NUL-separated because a name may contain any printable character. Not the
 * row id, which carries presentation suffixes both sides would have to strip.
 */
export function browseJoinKey(caseId: string, slotKey: string, entity: string | number): string {
  return `${caseId}\u0000${slotKey}\u0000${entity}`;
}

/** Whether any filter narrows `tab` under `view`: exactly when `keptRowKeys`
 * would return a set. */
export function hasActiveFilter(tab: BrowseTab, view: ViewState): boolean {
  return activeFilters(tab, view).length > 0;
}

/** Two filters that keep the same rows. A checklist's ticks are a set, so
 * the order they were ticked in is not a change. */
export function sameFilter(a: ColumnFilter, b: ColumnFilter): boolean {
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
  if (a.kind === 'values' && b.kind === 'values') {
    const ticked = new Set(a.values);
    return ticked.size === new Set(b.values).size && b.values.every((v) => ticked.has(v));
  }
  if (a.kind === 'range' && b.kind === 'range') return a.min === b.min && a.max === b.max;
  return false;
}

/** Two filter maps that keep the same rows (`sameFilter` per column). */
export function sameFilters(
  a: ReadonlyMap<string, ColumnFilter>,
  b: ReadonlyMap<string, ColumnFilter>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, filter] of a) {
    const other = b.get(key);
    if (!other || !sameFilter(filter, other)) return false;
  }
  return true;
}

/** A built tab's rows by id and columns by key. */
export interface TabIndex {
  readonly rows: ReadonlyMap<string, number>;
  readonly columns: ReadonlyMap<string, BrowseColumn>;
}

const tabIndexes = new WeakMap<BrowseTab, TabIndex>();

/** `tab`'s index, made once per build and held as long as the build is, so
 * a lookup by pin costs the pins, not the rows. A row id listed twice
 * answers with its last row. */
export function tabIndex(tab: BrowseTab): TabIndex {
  let index = tabIndexes.get(tab);
  if (!index) {
    const rows = new Map<string, number>();
    tab.rows.forEach((row, at) => rows.set(row.id, at));
    index = { rows, columns: new Map(tab.columns.map((column) => [column.key, column])) };
    tabIndexes.set(tab, index);
  }
  return index;
}

/** The keep-set a grouped build consumes: join keys of the ungrouped rows
 * that pass the filters. Undefined when no filter applies. */
export function keptRowKeys(base: BrowseTab, view: ViewState): ReadonlySet<string> | undefined {
  const active = activeFilters(base, view);
  if (active.length === 0) return undefined;
  const kept = new Set<string>();
  outer: for (let row = 0; row < base.rows.length; row++) {
    for (const { column, filter } of active) {
      if (!passes(filter, column.value(row), cellClassOf(column, row))) continue outer;
    }
    kept.add(browseJoinKey(base.rows[row].caseId, base.rows[row].slotKey, base.rows[row].entity));
  }
  return kept;
}

/**
 * Whether a build asked for a group-by answered with ungrouped rows, as it
 * does for a quantity that cannot be summed (the group-by stays remembered).
 * Treating that as grouped would skip the filters, freeze a false context
 * into pins and label the CSV "Grouped by". An empty tab answers false.
 */
export function declinedGroupBy(tab: BrowseTab): boolean {
  return tab.rows.length > 0 && !tab.rows.some((row) => row.groupBy !== undefined);
}

/** The view a tab was actually built under: a declined group-by dropped, so
 * paint and export match the rows. The remembered view is left unchanged. */
export function builtView(tab: BrowseTab, view: ViewState): ViewState {
  return view.groupBy && declinedGroupBy(tab) ? { ...view, groupBy: null } : view;
}

/**
 * Restate on a grouped tab the filters its build consumed: a context column
 * per filter, frozen onto each row for pins, plus `consumedFilters` so the
 * post-pass skips them. `base` is the ungrouped tab. A filter on a
 * grouped-only column stays with the post-pass.
 */
export function carryFilterContext(tab: BrowseTab, base: BrowseTab, view: ViewState): BrowseTab {
  const consumed = activeFilters(base, view);
  if (consumed.length === 0) return tab;
  const context: FilterContextEntry[] = consumed.map(({ column, filter }) => ({
    key: column.key,
    label: column.label,
    constraint: filterConstraint(filter),
  }));
  const contextColumns: BrowseColumn[] = context.map((entry) => ({
    // Prefixed: grouping BY a filtered column puts that column's key on the
    // grouped tab already.
    key: `context.${entry.key}`,
    label: `${entry.label} (filter)`,
    kind: 'text',
    computed: true,
    context: true,
    value: () => entry.constraint,
  }));
  return {
    ...tab,
    rows: tab.rows.map((row) => ({ ...row, filterContext: context })),
    columns: [...tab.columns, ...contextColumns],
    consumedFilters: new Set(consumed.map(({ column }) => column.key)),
  };
}

// ---------------------------------------------------------------- selection

/**
 * What is drawn, and in what colour. A click PREVIEWS (transient) and the
 * checkbox PINS. A pin's colour is held for its life: unpinning one series
 * must never recolour others, so the store hands out the lowest free palette
 * colour and reclaims it on unpin.
 */
export interface SelectionEntry {
  readonly ref: BrowseRowRef;
  readonly color: string;
}

export interface SelectionStore {
  /** Pinned rows in pin order, which is the order they were found in. */
  list(): SelectionEntry[];
  previewed(): BrowseRowRef | null;
  isPinned(id: string): boolean;
  colorOf(id: string): string | undefined;
  /** Pin a row. Any change to the pinned set drops the preview. */
  pin(ref: BrowseRowRef): void;
  unpin(id: string): void;
  toggle(ref: BrowseRowRef): void;
  /** Replace the preview. Previewing a pinned row clears the preview instead. */
  preview(ref: BrowseRowRef | null): void;
  restore(entries: readonly SelectionEntry[]): void;
}

/**
 * A pin as a bundle stores it: by index into the manifest's `cases`, never a
 * live Case id (a restore mints fresh ids). The row id is rebuilt from the
 * restored Case.
 */
export interface SavedPin {
  /** Index into the bundle manifest's `cases`. */
  readonly case: number;
  readonly ref: Omit<BrowseRowRef, 'id' | 'caseId'>;
  readonly color: string;
}

/** Drop the fields a restore rebuilds, so a saved ref cannot carry them. */
function storedRef(ref: BrowseRowRef): SavedPin['ref'] {
  // A saved ref never carries `caseName`: the Case is the pin's index.
  const { id, caseId, caseName, ...rest } = ref as BrowseRowRef & { caseName?: string };
  return rest;
}

/** Live pins as a bundle stores them. `caseIds` is the bundle's case list in
 * manifest order; a pin whose Case the bundle does not carry is not saved,
 * since nothing could restore it. */
export function savePins(
  entries: readonly SelectionEntry[],
  caseIds: readonly string[],
): SavedPin[] {
  const out: SavedPin[] = [];
  for (const entry of entries) {
    const index = caseIds.indexOf(entry.ref.caseId);
    if (index >= 0) out.push({ case: index, ref: storedRef(entry.ref), color: entry.color });
  }
  return out;
}

/**
 * Saved pins resolved against the Cases a restore made (index i is the Case
 * from `manifest.cases[i]`): the ONE place a saved pin meets a live id.
 */
export function restorePins(
  saved: readonly SavedPin[],
  cases: readonly { readonly id: string }[],
): SelectionEntry[] {
  const out: SelectionEntry[] = [];
  for (const pin of saved) {
    const owner = cases[pin.case];
    if (!owner) continue;
    const ref = { ...pin.ref, caseId: owner.id };
    out.push({ ref: withRowId(ref), color: pin.color });
  }
  return out;
}

export function createSelection(
  palette: readonly string[] = CASE_COLORS,
  resolveSemanticColor?: (ref: BrowseRowRef) => string | undefined,
): SelectionStore {
  const pinned = new Map<string, SelectionEntry>();
  let previewRef: BrowseRowRef | null = null;

  const nextColor = (ref: BrowseRowRef): string => {
    const semantic = resolveSemanticColor?.(ref);
    if (semantic) return semantic;
    const taken = new Set([...pinned.values()].map((entry) => entry.color));
    const free = palette.find((color) => !taken.has(color));
    // Past ten pins the palette repeats. Stated, not prevented: the tool does
    // not limit what an analyst may look at.
    return free ?? palette[pinned.size % palette.length];
  };

  return {
    list: () => [...pinned.values()],
    previewed: () => previewRef,
    isPinned: (id) => pinned.has(id),
    colorOf: (id) => pinned.get(id)?.color,
    // A change to the pinned set ends the preview: a preview has no swatch
    // or Selected row, so leaving it drawn would show an unexplained line.
    pin(ref: BrowseRowRef): void {
      if (pinned.has(ref.id)) return;
      pinned.set(ref.id, { ref, color: nextColor(ref) });
      previewRef = null;
    },
    unpin(id: string): void {
      if (pinned.delete(id)) previewRef = null;
    },
    toggle(ref: BrowseRowRef): void {
      if (pinned.delete(ref.id)) {
        previewRef = null;
      } else {
        this.pin(ref);
      }
    },
    preview(ref: BrowseRowRef | null): void {
      previewRef = ref && !pinned.has(ref.id) ? ref : null;
    },
    restore(entries: readonly SelectionEntry[]): void {
      pinned.clear();
      for (const entry of entries) pinned.set(entry.ref.id, entry);
      previewRef = null;
    },
  };
}
