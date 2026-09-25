# Slicers

A Slicer pane in the left rail, under the time filters, that shows a
category column's filter as a standing checklist, the way an Excel slicer
shows a Table column's filter. It narrows the browse tables only. Pins and
the chart are untouched.

## Decisions

**A slicer IS the column's filter, not a second one.** Ticking in the slicer
writes the same `{ kind: 'values' }` filter the column's dropdown writes, and
either one shows the other's change. There is no precedence to explain because
there is one value.
Rejected: a rail scope through `query.cases`. `browse.scope` drops rows before
a tab sees them, so an unticked value would vanish from the dropdown's
checklist, which lists `tab.rows`, and could not be ticked back from there.

**A hidden slicer hides nothing.** The column header and the drawer's chips
row (`viewChips`) already show an active filter and clear it, so the slicer
toggle is display only and needs no "active slicers stay shown" rule. The
rule is needed only once a filter reaches a tab with no column for it (see
Out of scope).

**The toggle lives in the column's filter dropdown**, as a "Show as slicer"
button on category columns. `toggleFilterPopover` in
`src/ui/browse-popovers.ts` builds the dropdown for every column of every
tab, so one change covers every kind. Rejected: the Columns menu. It works,
but the toggle belongs on the column being filtered, and one toggle in two
places is two things to keep in sync.

**A slicer renders the dropdown's checklist, not the time filters' chip
grid.** `src/ui/chips.ts` fits 4 to 24 values. County and City run to
hundreds, and the checklist already searches and caps at 100 with the cap
stated.

**Which columns can be sliced is their own flag, `category`, not
`groupable`.** `groupable` means "a category AND the quantity may be summed
across it". Interface columns are never groupable, but filtering interfaces by
a category sums nothing. The flag is the lookup's half of the group-by's two
owners: `isBucketable` (enum only) for lookup columns, and always true for the
Case column.

## Steps

1. **Extract the checklist.** Move the search box, distinct values,
   Select All / Clear, the count badge and the capped list out of the text
   branch of `toggleFilterPopover` into a shared renderer, e.g.
   `mountValueChecklist(container, values, ticked, onChange)`. The dropdown
   calls it and behaves exactly as before.
2. **`category` on `BrowseColumn`** (`src/ui/browse-model.ts`). Each kind's
   browse adapter sets it: from `isBucketable` for lookup columns, true for
   `CASE_COLUMN_KEY`, absent otherwise. Assert in `tests/test_browse.mjs` that
   an Interface category column is `category` while not `groupable`.
3. **Slicer toggle in `ViewState`**, per tab, beside `columnOverrides`: a
   set of column keys. Put it in `headerSignature` if the header shows it.
4. **"Show as slicer" in the dropdown**, offered only when `column.category`.
5. **The Slicer pane** in `#section-template`'s left rail under FILTERS. For
   the active tab it mounts one checklist per toggled column, reading and
   writing that column's filter through the drawer's `viewOf`/`setView`.
   Elements are found with `within(root, …)` (`tests/test_dom_contract.mjs`).
   It repaints when the active tab or its view changes.
6. **Confirm in the real app** with the `drive-app` skill: tick in the slicer
   and see the dropdown agree, and the reverse; switch tabs and see the pane
   follow; clear a chip and see the slicer empty.

## Footguns

- **Hiding a column clears its filter** (`setColumnVisible`). A slicer on a
  hidden column would lose its filter on the next hide. Decide which way it
  goes (Open questions) and assert it.
- **The Case column's values are labels** (`caseLabel`), which can be edited
  in the Contents panel. A `values` filter holding a label stops matching when
  the Case is renamed. That is already true of the dropdown; a slicer makes it
  easier to hit.
- **With a group-by, the text box applies on commit** (`commitOnly`) and
  ticks apply at once. The extracted renderer must keep both behaviours.
- **The rail is cloned per section**; the pane must not resolve a global id.

## Open questions

1. When a column with a slicer is hidden, does the slicer go too (and the
   filter clear, as today), or does the slicer keep the column's filter alive?
2. Are tab views, and so slicer toggles, saved in a `.gvmb`? If so, the
   toggles are saved too, keyed by column key.
3. Defaults: which slicers are on when a tab first opens? Proposed: Case on
   every tab, FuelType on Generator, PSSEArea on Bus.
4. Should the slicer checklist grey out values the tab's other filters have
   emptied (Excel does)? It costs one pass over the rows per slicer on every
   change.

## Out of scope

- **Cross-table slicers.** One filter narrowing several kinds' tabs. Matching
  by column name joins the wrong columns: PSSEArea is only on BusList and
  reaches Generator only through `Bus ID`, and Generator's `Area Name`, Bus's
  `LoadArea` and the Area kind's entities are different names that may be one
  list. That needs a declared list of shared dimensions and its joins, plus a
  chip on every tab a dimension filters without a column for it. Case, on
  every tab under one key and one set of ids, is the obvious first dimension.
- **The Selected tab's Case switcher**, which moves pins from one Case to
  another like the variable switcher. It is independent of slicers.
