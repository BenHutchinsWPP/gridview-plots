# Filter entities by Area Group membership

Choose an optional **Area Groups** column on the regular Area tab, with one
cell listing every authored group containing that area. Its filter and slicer
select individual group names. Selecting West and Coastal keeps the union of
their areas, with each area appearing once per Case and slot key.

This plan also covers the same column on the regular Bus and Generator tabs.
Filtering membership must work for quantities that cannot be aggregated, such
as bus LMP. Group membership describes an entity; it does not authorize a sum.

## Entity-group extension

Generator also offers a hidden **Generator Groups** column and Bus a hidden
**Bus Groups** column. These use the entity’s own authored memberships, with
no reference-list dependency after import identity resolution. Pair-keyed
Generator imports still require GeneratorList, and name-keyed Bus imports
still require BusList. Unresolved sidecar rows match nothing; never guess
their identities. Area Groups still uses the joins below. Each
column uses the same individual categorical accessor, union matching, blank
token, absent-choice handling and scalar display. Cross-column filters
intersect before grouped keep-sets are calculated. None permits group-by.

Use distinct keys `membership.generatorGroups` and `membership.busGroups`.
Pass reverse snapshots from each groups owner through app wiring, preserving
generator identity resolution and numeric bus identity. Exclude synthetic
all-entity groups only, never an explicitly authored group with that name.
Replacing groups or restoring a bundle must invalidate both membership
columns independently of reference-list changes. Missing lists affect Area
Groups only; own authored memberships remain usable.

Extend checks with overlapping own memberships, cross-column intersections,
selected names removed and recreated, generator identity ambiguity, and
filtered aggregate pins frozen across edits to either mapping. Both own-group
columns must work for nonsummable quantities, without changing aggregate tabs.

## Competing designs

Ranked by the requested union behavior, discoverability, reuse of the drawer,
cross-kind support, and the amount of special behavior a maintainer must own.
Effort is relative to the other options, not a delivery estimate.

| Rank | Design | What it gains | Cost or limitation | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Optional Area Groups column with individual membership values | Inspectable membership, ordinary column filtering, slicer support, one row per entity; works through an area lookup on other kinds | Requires a small extension to the shared column contract and careful row remapping | Best match to the full request |
| 2 | "In Area Group" subsection in the Area column filter | Closest to the user's wording; avoids another visible column | One column would carry two independently useful predicates. The dropdown, clear action, indicators, grouped context and slicer need rules distinguishing area-name ticks from group-name ticks | Good location for a later shortcut into the membership column's filter, if users need it |
| 3 | Dedicated Area Groups filter above the table | Obvious and quick to reach; can compute a union without displaying memberships | Adds a separate filter owner outside the column model, with its own chips, reset, export and grouped-build handling | Consider only if the product adopts filters independent of columns |
| 4 | Action on Area Groups: "Show member areas" | Small navigation feature; useful when exploring an aggregate | Navigation alone does not provide a persistent membership slicer or the same interaction on Bus and Generator | Useful companion later, not the main mechanism |
| 5 | One boolean column per group | Ordinary scalar filtering needs little new model behavior | Multiple columns combine with AND, so selecting two groups gives intersection. OR would require another special rule; many groups also crowd the chooser | Reject for this request |
| 6 | Expand an area into one row per membership, or store a joined string as the categorical value | Fits scalar cells superficially | Expanded rows repeat series and statistics. A joined string makes "West; Coastal" a checklist item rather than West and Coastal separately | Reject; neither preserves the requested semantics |

Use option 1, with option 2's vocabulary in the membership control: "In any
selected Area Group". Keep the Area column's existing exact-name filter.
No generic relationship editor, query language, or new dependency is needed.

## Interaction and domain decisions

1. The column is called **Area Groups**, starts hidden, and is available from
   Columns on Area, Bus and Generator. Its filter offers "Show as slicer".
   It is a category with no group-by control. Overlapping memberships do not
   define a partition whose totals can be added together.
2. The column dropdown and slicer write the same `values` filter. Within this
   column, ticks mean OR. Across columns, filters mean AND. For example,
   `Area Groups in {West, Coastal}` and `Area in {B, D}` keeps only matching
   B and D rows. No ticks and no text means no membership restriction. In
   the dropdown, clearing the last tick while search text remains activates
   the existing contains filter. Clearing the slicer's ticks clears the
   column filter; its search only narrows the checklist.
3. Filtering changes the active tab's browse rows. It does not unpin rows,
   alter the chart's pinned set, or propagate to another tab. Selecting an
   area's group does not switch to the Area Groups aggregate tab.
4. The cell displays sorted, deduplicated group names, separated by `; `.
   It remains one text cell for sorting, copying and browse CSV export.
   Membership matching never parses that display string. A group name can
   contain the display separator without changing its identity. Existing
   import/editor limitations on group-name syntax are a separate concern.
5. The checklist lists each group once, using memberships on the unfiltered,
   ungrouped rows of this tab. Another column's filter must not erase a group
   from the checklist. Groups with no matching entities in the current tab
   are absent unless already selected. Preserve selected but absent names in
   both controls so the user can untick them after a mapping edit or reload.
   Such names match no rows and must be identified as having no matches.
6. Empty memberships appear as the existing `(blank)` item. It means "no
   resolved authored Area Group", including a missing area lookup. A visible
   tab note distinguishes unavailable reference data from a known area belonging
   to no authored groups. Do not invent a real group named "Ungrouped".
7. Exclude the synthetic `All areas` grouping from memberships: it would make
   every mapped row look assigned and undermine `(blank)`. If the mapping
   explicitly authors a group called `All areas`, include it normally.
   Clearing a filter already provides "all" without a synthetic choice.
8. Membership is session-wide and live. Editing or replacing the mapping
   recalculates the rows and both controls while retaining selected group
   names. A deleted or renamed selected group remains a visible unmatched
   choice; it must not silently become "all areas". Renaming a group does not
   retarget a selection by guessing.
9. Keep authored members even when no Area hourly table carries them. A Bus
   or Generator can resolve such an area from its reference list. The Area
   cube's axis must not determine cross-table membership.

An overlap fixture makes the rule concrete:

| Area | Memberships | Keep for West OR Coastal? |
| --- | --- | --- |
| A | West | Yes |
| B | West; Coastal | Yes, once |
| C | Coastal | Yes |
| D | none | No |

Each Case retains its own A/B/C rows. Union does not merge rows across Cases.

## Implementation seams

### Separate categorical membership from scalar display

Keep scalar `CellValue` and `BrowseColumn.value(row)` for drawing, sorting,
copying and exports. Add one optional column accessor, tentatively
`filterValues(row): readonly string[]`, for columns with multiple categorical
values. The fallback for scalar columns must preserve their existing
display/trim behavior. An empty membership array contributes the existing
empty-string blank token when filtering and enumerating checklist choices.

This keeps array handling out of every renderer and exporter. Widening all
cells to arrays would require unrelated numeric, copy and sort paths to learn
membership semantics. A generic relation framework would add configuration
before a second relationship requires it.

Put the accessor's interpretation behind one shared helper. The checklist's
distinct-values collection and the row predicate must use it. Both
`visibleRows` and `keptRowKeys` must use the same column-aware predicate;
changing only the visible row pass would leave grouped sums unfiltered.

Exact `values` filters intersect the selected names with the cell's individual
memberships. A text filter applies the existing case-insensitive contains-any
rule to individual membership names, never a substring crossing the display
separator. The dropdown search continues to narrow its checklist while ticks
are selected. Scalar text and numeric filters retain their existing behavior.

An accessor indexed by row creates a specific footgun: every transform that
remaps rows must remap it alongside `value`. Cover `withoutEmptyRows` with a
fixture removing a middle row, not merely the last row. Audit other column
projection paths before adding the accessor. The Selected tab need not acquire
this new column; its existing projection must still read source cells safely.

Retain selected-but-absent checklist entries for this column through a small
shared choice-building helper used by the dropdown and slicer. Its choices
must retain both the actual name and whether any base row carries it; a
"no matches" annotation must never become part of the filter value. Rebuild
the slicer when that presence changes, even when the union of current names
and selected names stays identical. Preserve its search and scroll where
possible. Keep this behavior opt-in for membership columns if applying it to
scalar columns would change their interaction. Do not change global
exact-match rules to match display-string fragments. Add membership wording
through shared filter description handling where needed, so frozen context
and CSV descriptors also say "in any of" rather than implying scalar equality.

### Resolve membership once, pass data into kinds

Expose a read-only reverse snapshot of authored membership from the Area
groupings owner: area name to sorted, distinct group names. Build it from
authored pairs, excluding only the synthetic `All areas`, without intersecting
the Area axis. Do not serialize and parse Groupings CSV to construct it, and
do not maintain another mutable membership store.

Pass that snapshot through the root and `app/browse-wiring.ts` to the regular
Area, Bus and Generator tab builders. Each kind resolves its own area name
and emits the same membership column contract. Bus and Generator must never
import the Area kind. No parser, wasm ABI, cube layout, or aggregation rule
changes are needed.

Prefer one snapshot per tab-declaration pass and constant-time row lookup to
scanning every group for every entity. Add a revision-keyed cache only if
measurement justifies it. Any cache must include mapping replacement and
restore, not just editor events. Existing browse freshness inputs are the
place to connect invalidation; add a new owner only if they cannot express it.

### Cross-table joins

| Tab | Join into authored Area membership | Decision |
| --- | --- | --- |
| Area | The row's entity name | No reference list required |
| Generator | Generator identity into GeneratorList, then `Area Name` | Use the direct attribute; no fallback through a bus, which could disagree |
| Bus | Numeric bus identity into BusList, then `LoadArea` | Follow the existing settlement-area choice; `PSSEArea` is a different concept |
| Interface | No single area relationship specified | Defer until endpoint/area semantics are explicitly designed |

Use the same name normalization as existing area joins. Do not add fuzzy,
case-insensitive or alias matching. A missing list, missing column, absent
entity or blank area yields no resolved memberships. The kind supplies a
concise normal tab note for unavailable reference data, deduplicating any
existing lookup note. Do not add visibility-dependent diagnostics: builders
should not need drawer view state just to explain an unavailable join.
Distinguish a nonblank area with zero authored memberships from an unresolved
join. Never silently disable an
active membership filter because the reference data is absent.

Do not make availability depend on `spatialOf` or the Area aggregation rule.
An intensive quantity can be filtered by membership without being summed.
For a supported group-by, evaluate membership on the ungrouped entities,
then pass the survivors through the existing keep-set and frozen filter
context. Case or attribute aggregates must count each surviving entity once.
The authored aggregate tabs keep their own independent view state.

After a Case or attribute group-by consumes this filter, its frozen context
column is informational. Edit the filter through its slicer, which reads the
ungrouped form, or ungroup to reopen the membership dropdown. Ungroup before
hiding the membership column in Columns. Do not turn the context cell into a
second filter editor. Verify both recovery routes when no grouped rows
survive, so a deleted selected group cannot strand an empty view.

### State and bundles

Use a distinct stable column key such as `membership.areaGroups`, separate
from the Area Groups tab's group-name key and from lookup attribute keys.
Hiding the column clears its filter and removes its slicer. Removing only
the slicer leaves the filter. Both clear actions use the normal view state.

Keep view filters and slicer choices at their existing lifecycle. Saving
groups and lookups supplies the data needed to rebuild membership; this
feature does not add drawer-view persistence or a new bundle field. Pins
created from filtered aggregates already need their frozen members and
filter context to round-trip. Preserve that wire format and verify restored
pins against the Cases created by restore.

## Delivery plan

1. Add the optional categorical accessor and shared matching/enumeration
   behavior, with scalar regression checks. Update row remapping and the
   dropdown/slicer choice builder together. Prove union, blank, exact-name,
   text and selected-but-absent behavior through their shared interfaces.
2. Add the authored reverse-membership snapshot and Area column. Wire live
   mapping edits, CSV replacement, restore, column visibility and slicers.
   Verify a membership-filtered Case aggregate and its frozen pin before
   extending to other kinds.
3. Add Generator Groups and Bus Groups reverse snapshots from canonical
   stored names and numeric IDs, preserving every authored name. Test
   export-only identities without lists and unresolved sidecars matching
   nothing. Supply the same snapshot to Bus and Generator through app wiring. Add
   each kind's area resolver and diagnostics. Prove direct GeneratorList
   joins, BusList `LoadArea` joins, missing references and membership of areas
   outside the Area cube's axis. Exercise a nonsummable variable as well as
   an ordinary quantity.
4. Filter both membership columns before pinning a Case or attribute
   aggregate. Assert their intersection is frozen, both constraints survive
   restore, and independent edits to either map leave the pin unchanged.
   Keep selected-but-absent names separate even when columns share a name.
   Validate the complete interaction with the generated `drive-app` study.
   Extend its invented fixture with overlapping Area Groups and one unmapped
   entity. Check the dropdown and slicer agree, neither duplicates rows,
   switching tabs preserves independent filters, and mapping edits repaint
   both. Copy and export the membership column, pin survivors, save and
   restore, then check restored lines and frozen membership context.

Each implementation step should leave one reviewable local commit. Run
`npx tsc --noEmit` and the relevant focused suite while iterating. Before
committing, run `npm run format` and the full `npm test`, with long output
in a log whose head and tail are inspected. Follow the repository's
`drive-app` skill for real-app confirmation of drawer, pin and restore work.

## Acceptance checks and footguns

- Overlapping West/Coastal membership keeps A, B and C exactly once per Case
  and slot. Another column's filter intersects that result.
- Ticking West must not match a group called West Coast. Deduplicate repeated
  source pairs. Treat semicolons in a group name as part of the name.
- Ticking `(blank)` keeps unmapped and unresolved rows, with diagnostics
  explaining missing reference data. No ticks and no text keeps all rows.
  Unticking the dropdown's last item while text remains uses its contains
  filter; clearing the slicer clears the column filter regardless of search.
- Dropdown and slicer enumerate group names rather than membership
  combinations. A selected deleted name remains removable in both controls,
  including when it produces zero rows. Removing and recreating the same
  group updates its "no matches" annotation without changing its tick.
- Removing an empty middle row preserves the memberships of subsequent
  rows. Hour and variable changes must not attach groups to the wrong row.
- A Case group-by consumes the same union as the visible row pass. A pinned
  filtered aggregate freezes the actual surviving entity keys; later mapping
  edits cannot rewrite its members. An ordinary entity pin keeps its identity.
  An empty grouped view remains recoverable through its slicer or by ungrouping.
- A membership filter works on bus LMP without offering a new aggregation.
  Bus `PSSEArea` and generator bus attributes cannot override the chosen join.
- Group-file replacement under the same filename and bundle restore refresh
  the reverse map and cached tabs. Lookup replacement refreshes joins too.
- Hiding the column removes its filter and slicer; hiding only the slicer
  keeps the filter. CSV descriptors name the applied membership constraint,
  and copy/export uses one correctly escaped scalar cell per row.
- Old bundles need no migration. New filtered aggregate pins restore their
  existing frozen members/context; browse filters follow their existing
  session-only behavior.

Add assertions for the new membership rules in the existing browse and tab
suites, plus architecture guards for cross-kind imports if the present guards
do not cover them. Add storage assertions only for frozen context behavior
that existing tests do not already prove. The browser check is required even
when the pure model tests pass.
