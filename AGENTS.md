# Agent Notes

`README.md` says what the app does. This file is the rules for changing it,
for every agent. `CLAUDE.md` is a one-line `@AGENTS.md` import, because
Claude Code reads `CLAUDE.md` and most other agents read `AGENTS.md`. Put no
rules in it: a second place for rules is how two copies drift apart.

## Writing

**The code is the source of truth for what the code does.** Do not restate in
prose what can be read off the code: which files exist, what a function does,
what a constant is. Write only what the code cannot carry:

- a decision and its reason, especially a rejected alternative
- a domain rule that looks arbitrary from the code
- a footgun: a change that looks safe and is not

Comments follow the same rule. Most lines need none.

**Every source file opens with a header naming its path and why it exists**
(see `src/detect.ts`). Why, not an inventory. `head -8` should route a task to
the right module. `tests/test_rot_guards.mjs` asserts the header exists and
names its own path.

**No status claims, history or ticket numbers in comments or docs.** "Not yet
built", "this replaced X", "see #12" rot and cannot be looked up. Unbuilt scope
is a GitHub issue. The rejected alternative is worth keeping; the story of how
it was rejected is not.

**Tone.** Describe what an option improves, never what is wrong with a vendor,
library or tool. Commit messages and comments too: say what the change
gains, not what was broken.

**Prefer an executable rule to a written one.** The important invariants below
are asserted in `tests/test_*.mjs`. If you add a rule, add its assertion.

## Footgun: stale wasm

`prebuild`/`predev`/`pretest` run `sync-wasm`, which fails if a committed
`parser/<shape>/block.wasm` is missing. That is an incomplete checkout:
restore the file from git. Do not install a wasm toolchain to work around it.

## Invariants

### Kind is not shape

A table's KIND (area, interface, bus, generator) is its semantics: axis
meaning, aggregation, rules, slot keys, UI. Its SHAPE is the byte layout: W
(entity per column, one metric per file, under a preamble) or L (entity per
row, many metrics, no preamble). They are independent.

- A kind lives in `src/tables/<kind>/` and imports no other kind.
- Shape readers are `src/tables/wide/` and `src/tables/long/`. A kind may
  import them; they never import a kind.
- Routing is (kind, shape): `src/detect.ts` returns both.

Asserted by `tests/test_kernels_bus.mjs` and `tests/test_kernels_generator.mjs`.
Needing an exception means a shape reader is turning into a dispatcher on kind.

### No kind token crosses a parser ABI

Every value passed into wasm is a number describing bytes and offsets. Never
an enum, string or id naming a kind. With no kind argument,
`if (kind == BUS)` is unrepresentable in the shared reader. Anything that
cannot be a number belongs in `src/tables/<kind>/`. Asserted by
`tests/test_wide_abi.mjs`.

### Parsers and ABI versions

`parser/long/block.c` and `parser/wide/block.c` are the two shape readers;
`src/tables/long/` and `src/tables/wide/` are their TypeScript halves.

`parser/common/fields.h` holds the cell readers both include (number, hour,
date, the delimiter walk), so a cell reads the same whichever shape carried
it. **A change there is a change to both binaries**: rebuild and commit both.
To show a C change alters no behaviour, compare the rebuilt code section with
the committed one. Whole files never match, because the build writes its
output filename into the name section.

The long reader says `area` where it means entity (`numAreas`, `rowArea`,
`area_table_put`). Those reach wasm export names, so renaming them is an ABI
change and a binary rebuild.

Each `block.c` declares `ABI_VERSION`, mirrored by `PARSER_ABI` in
`src/tables/long/block.ts` and `src/tables/wide/block.ts`. **Bump both sides
together** when the exported surface or arena layout changes, so a stale
committed binary fails at instantiate instead of misreading rows.
`tests/test_rot_guards.mjs` asserts they agree and that no other file states
an ABI number.

**`rowHour` is the hour within one year's slot (u16, 0..8783), never an index
across a span.** A u16 span index wraps at 65,535 hours, 7.46 years in, and
folds later years onto earlier hours. The year leaves wasm apart, as the u8
`rowYear` offset from `firstYear`. Asserted by `tests/test_long_refusals.mjs`
on a nine-year file.

### Ingest

- The axis is read from the file, never assumed. Column counts and order vary.
- **Row order carries no meaning.** A value-sorted export must load
  byte-identically to a date-ordered one. Do not add an ordering check.
  The one reader of order is the Import Dialog's sample of a long file's
  first and last rows (`src/tables/long/sample-years.ts`): a hint for the
  dialog that never reaches ingest, and a sample out of date order proves
  only the years it shows.
- **Every year is a fixed 8,784-hour slot on the leap calendar** (Feb 29 =
  hours 1416..1439), so a date is the same index in every year and Case and
  overlay, downloads and the date filter need no per-year mapping. Rejected:
  true hours per year, which would make each of those map dates per year. A
  non-leap year's Feb 29 is NaN and flagged phantom in the calendar, with no
  weekday. A Feb 29 dated in a non-leap year is a bad date, refused by both
  `block.c` files, never a blank to fill.
- **The slot is storage, never a count.** Every "N of M hours", coverage check
  and status sentence uses `realHours`, so a non-leap Case reads 8,760 of
  8,760, never 8,760 of 8,784. Asserted by `tests/test_calendar.mjs`,
  `tests/test_long_refusals.mjs`, `tests/test_ingest_interface.mjs`,
  `tests/test_ingest_area.mjs`, `tests/test_drop_load.mjs`,
  `tests/test_render_frame.mjs`, `tests/test_panes.mjs` and
  `tests/test_figure.mjs`.
- Hour is hour-ending 1-24, converted with `hour - 1`. A new kind's parsing
  must state its convention and prove it with a fixture.
- **A Case is a contiguous run of years**, `firstYear` to
  `firstYear + numYears - 1`, one slot each. A year inside the run with no
  rows is refused, naming the year, never read as a year of no data. A long
  file's years come from the axis scan, never its first row, because rows
  are unordered. A wide file's come from the preamble's date line, which
  sizes the table before a row is read and which the parser holds every row
  to; only a file without one takes its first row's year. Asserted by
  `tests/test_long_span.mjs` and `tests/test_wide_span.mjs`.
- One row per (entity, hour). A duplicate is refused with a coverage map,
  never resolved by last-writer-wins. Files merged into one table join their
  years into one contiguous run, and a doubled (entity, hour) across them is
  refused the same way. A union that skips a year is refused, naming it
  (`tests/test_long_span.mjs`, `tests/test_wide_span.mjs`).
- **Every table of a Case states the same span.** A file with another span
  is refused before it attaches, unless it replaces every table holding the
  old one; that includes a long file after its metric picker
  (`keepSpans` in `src/app/batch.ts`). The rule lives in ingest, not the
  Import Dialog, because a long file's years are known only after its scan.
  The dialog blocks only a refusal it is certain of, from a wide file's date
  line or a long file's sample, and offers the Case that clears it. Asserted
  by `tests/test_case_span.mjs` and `tests/test_sample_years.mjs`.
- **One plane's span is contiguous in the cube**:
  `(plane × numYears + yearOff) × 8,784 + slotHour`, a plane being an entity,
  or an entity-metric pair in a long table. Every kernel reads a plane with
  one `subarray`, so a layout that put the year outside the plane would read
  one entity's first year followed by the next entity's. Asserted by
  `tests/test_long_span.mjs` and `tests/test_wide_span.mjs`.
- Every failure a parser can see is counted and reported, and the load is
  refused rather than returning a plausible wrong number.

### Aggregation

- Area sums extensive metrics and weights intensive ones per
  `data/area/aggregation-rules.json`. **A missing weight column means weight
  1**: a plain mean, a warning naming the column, and `weightColumn` left
  undefined so nothing claims a weighting that did not happen. Same when an
  hour's weights sum to zero.
- Do not generalize `applyDerived` / `ColumnRule.derived` across kinds; the
  commutation it relies on is specific to area-axis reduction.
- **Bus and Interface combine by unit class.** `spatialOf` in each kind's
  `rules.ts`: EXTENSIVE and RATE sum, INTENSIVE refuses. The refusal names the
  unit and the arithmetic ("the sum of two buses' $/MWh is not a $/MWh"),
  never the kind.
- **Interface has no attribute group-by, ever.** Two paths across one
  corridor double-count and opposite directions cancel. Only an authored group
  combines.
- **An interface group member carries a direction** (`forward`/`reversed`,
  × −1), owned by the group. It applies to every quantity the group sums,
  including non-flows; `isDirectional` is what the UI consults to say so. Do
  not silently drop the sign for a non-flow quantity.
- **A boundary's limits are its members' summed in its directions**
  (`summedLimits`): a reversed member adds −MIN above and −MAX below, and any
  member without a limit that hour leaves the group without one. It is a best
  case and labelled `% of summed limits`, never `% of limit`. Asserted by
  `tests/test_interface_groups.mjs`.
- **"% of range" is divided in one place**, `normalizeToRange` in
  `src/series/range.ts`. A kind hands it limits as numbers and never reads the
  limits store. A missing side divides by the peak or trough over every hour,
  so the hour filter never rescales a line; the label names only the divisors
  the shown hours used. A lower limit ≥ 0 is a floor, not a negative range.
  Asserted by `tests/test_range.mjs` and `tests/test_rot_guards.mjs`.
- **A Generator group divides by the caps of the units its sum took.** A
  summed unit with no max cap stays in the numerator and is named, on the tab
  and on the line, because the result can pass 100%. A group's power with no
  GeneratorList is refused rather than divided by its peak, or one toggle
  would mean two things. Asserted by `tests/test_series.mjs` and
  `tests/test_browse.mjs`.
- **A bus LMP is refused, not weighted.** The load that would weight it is in
  another table and slot. Reopening this means designing that join.

### Save and load

Bundles are `.gvmb`. The OPFS migration from the legacy blob is one-way:
old blobs are upgraded in memory, never written back, never deleted (it may be
the user's only copy).

**A save that did not complete is never reported as saved.** A short or
refused OPFS write fails the save and empties only its own slot: OPFS holds
two slots and a one-byte pointer, moved after the new slot is complete, so
Load… still returns the last complete save. The .gvmb written first is still
named as saved. No slot or the legacy blob is ever deleted; an idle slot is
emptied only by the next save that writes it. OPFS gets
64 MB slices that are copies, transferred: transferring the live cube would
detach it. Asserted by `tests/test_save_slices.mjs` and
`tests/test_save_restore.mjs`.

**A v4 table entry carries `firstYear`/`numYears` beside `year` and
`numYears` × 8,784 hours per plane**, years in order inside each plane.
`year` is still written, as `firstYear`, so a one-year entry is exactly what
an older v4 build wrote, and that build refuses a longer one on its cube
length rather than reading its first year as the whole. A v3 (or legacy)
entry has no `numYears`: `savedHoursOnSlot` inserts a blank Feb 29 inside
every plane, never padding the end, which would put every hour after Feb 28
a day off. v3 is read, never written. Asserted by
`tests/test_storage.mjs`.

**Anything a bundle saves against a Case names it by its index in the
manifest's `cases`, never by a Case id.** Restore mints fresh ids, so id-keyed
entries need a remap on every restore path. A pin's row id is rebuilt at
restore by `rowIdOf`. Older bundles with id-keyed `selections` and
`limits.cases` are migrated on read and never written. Asserted by
`tests/test_storage.mjs`, and by `tests/test_save_restore.mjs` that both
restore paths adopt limits by the Cases made.

A pin's `perUnit` field and the `p.u.` token in its row id are wire format:
renaming either orphans every saved "% of range" pin.
A pane's `boxDims` values (`BOX_DIMS`, `year` among them) are wire format:
renaming one orphans every pane saved on it, and a name this build does not
know starts that pane by Case rather than refusing the bundle.
A filter context entry's `chosenOn` is wire format too: it is what keeps a
switched group pin from reading its "Max ≥ 500" as a fact about the new
variable. Its `case` holds the Case's NAME, not its id, so it needs no remap
on restore; do not "fix" it to an id.
The Contents inventory's session-input keys (`limits (shared)`,
`groups:<kind>`, the lookup variants) are wire format as well. A restore
replaces a session row only when the bundle carried that input and it was
adopted, so the strip never names a file whose content was not taken up.
A manifest's `overlayYears`, one boolean per pane, is wire format: a bundle
without it restores every pane unticked. Asserted by `tests/test_storage.mjs`.

**An hourly download's rows are the 8,784-hour slot**, so the same date is the
same row in every year and Case. Wide writes one column per series and year
of its Case, and always writes Feb 29, blank in a non-leap year's column;
long writes a series year after year, a non-leap year with no Feb 29 rows.
`HourOfYear` is the 0-based slot hour (Mar 1 HE 1 is 1440 in every year),
never the real hour of the year. **A file names years only when it holds more
than one** (a multi-year Case, or Cases of different years): each wide header
ends in its year (`ALDER [MW] 2036`) and long gains a `Year` column after
`Series`. A file of one year is the one-year layout byte for byte. The chart
pane's download is the same wide layout over the years its window touches;
under "overlay years", over the slot hours its window covers.
All of it is wire format: spreadsheets are built on these columns. Asserted
by `tests/test_hourly_csv.mjs` and `tests/test_time_span.mjs`.

### UI

- **A groups tab offers only what it can answer.** `TAB_OFFERS` in
  `src/app/browse-wiring.ts` names tabs that answer for some quantities; the predicate is
  the kind's own (`combinesAcrossAreas`, `combinesAcrossBuses`,
  `combinesAcrossGenerators`, `combinesAcrossInterfaces`). A quantity the tab could only refuse is left
  out of its dropdown, so the refusal lands where the choice is made. That
  includes an Area weighted mean whose weight is not in the same table in
  every Case. **What is withheld is said**: the scope reports `withheld` and
  the tab names each metric and the weight it lacks.
- **A group-by has two owners.** Whether the quantity may be summed is the
  kind's (`spatialOf`). Whether a column is a category is the lookup's
  (`isBucketable` in `src/lookups/reduce.ts`: enum only). A column that fails
  the second gets no control rather than a disabled one. The Case column's
  bucket is the table's own axis, so only the quantity can refuse it.
- **Anything a header cell renders is in its repaint signature**
  (`headerSignature` in `src/ui/browse-model.ts`). A variable change moves no
  column keys, so a missing field leaves a stale header. Asserted by
  `tests/test_browse.mjs`.
- **A pin's label states only what the pin froze.** An unfiltered group row
  redraws from live membership under the same row id, so its label names no
  member or direction count (`groupRowLabel` in `src/ui/browse-model.ts`).
- **A Selected-tab switch never goes partway.** The tab's "Switch all" row
  (a control above Case, Variable and Unit) moves every pin at once, and each
  row's own controls move that pin alone. A control offers only what every
  pin it moves can take: the header lists a blocked Case disabled, naming the
  pins that block it, and a row leaves out what its pin cannot take. Pins
  that differ are not a refusal: the header shows "Mixed" and still switches,
  so pins never end up half moved (`src/ui/browse-retarget.ts`).
  **Pins that become one series become one pin.** P pinned in Case A and in
  Case B, switched to C, is one row id, so the switch keeps the first
  (`firstPerId`) and switching back does not split it. A second row for the
  same series would draw one line twice under two colours.
  The toolbar's Variable and % are hidden on that tab, so one widget never
  both lists and rewrites. Switched pins land through `replacePins`;
  `setSelection` is bundle restore only. Asserted by `tests/test_browse.mjs`.
- **A grouped column is keyed on the column that made its buckets**, never on
  a key the ungrouped tab uses for something else. A grouped build consumes
  each filter over the ungrouped rows, so a bucket column under `entity`
  would test a tick on a bucket's name against area or bus names. Where the
  bucket column needs its own key, the ungrouped column's toggle names it
  (`groupsAs`). Asserted by `tests/test_browse.mjs`.
- **A Slicer IS its column's filter**, the dropdown's `values` ticks in the
  rail, never a second filter or a scope. Only a `category` column can be one
  (`isBucketable` for a lookup column, and the Case), not `groupable`, which
  also asks whether the quantity sums. Hiding the column takes the slicer and
  its filter with it. Asserted by `tests/test_browse.mjs` and
  `tests/test_dom_contract.mjs`.
- **Selection and statistics belong to the browse drawer**, which spans every
  kind. A kind gets its own section only for a control the drawer cannot
  express. Do not add a per-kind rail.
- A section mounts one clone of `#section-template`, so kind code looks up
  elements with `within(root, selector)` from `src/ui/dom.ts`, never a global
  id. The browse drawer is global chrome outside the template and keeps its
  ids. Asserted by `tests/test_dom_contract.mjs`.
- Which columns a drop keeps is decided on every drop, visible section or not,
  so it lives in `src/ui/retain-gate.ts`, never on a section.
- **A column filter's bound is in the units the cell shows**: 80 on a
  "% of range" column is 80%. A stat bound belongs to what its cells show
  (`statsShownAs`): a kind tab next read as another variable, unit or "% of range"
  drops its stat bounds, since a MW bound against a % empties the table and
  one chosen on Load says nothing about LMP. The Selected tab's column mixes
  units by design, so its bounds go only with a switch that moves a variable
  or unit (`replacePins(…, rescaled)`); a Case switch, even one that merges
  pins, and a new pin keep them.
  A checklist tick is an exact `values` filter and the text box a `contains`
  filter; a tick is never written into the box. Asserted by
  `tests/test_browse.mjs` and `tests/test_dom_contract.mjs`.
- **A load refuses input**: `#app-root` is inert and shortcuts are ignored,
  and `.busy-overlay` sits below `.modal-backdrop` so the load's own dialogs
  still answer. Asserted by `tests/test_busy_repaint.mjs`.

### Figures

- **`src/figure/` imports no table kind and never branches on kind.** A
  figure names a line from its facets; a fact only a kind knows reaches it as
  a facet (`figureSubject`). Asserted by `tests/test_rot_guards.mjs`.
- **The time axis is slot positions from a first year**: x = yearOffset ×
  8,784 + slot hour, so every Case lines up by date and a non-leap Feb 29 is
  a one-day gap, never closed. Its labels and ticks are integer arithmetic on
  the slot (`axisHour` in `src/ui/chart-format.ts`), never a `Date`, whose
  timezone shifts a row by a day. A Figure of a time or stacked pane is
  drawn on the pane's axis, its origin and all. Asserted by
  `tests/test_time_ticks.mjs`, `tests/test_time_span.mjs` and
  `tests/test_rot_guards.mjs`.
- **"Overlay years" keeps a series' colour and makes its years shades of
  it** (`shade` in `src/ui/palette.ts`), the ramp centred on the base colour,
  one rule for pane and figure: the Figure takes each line's colour from the
  capture rather than shading again. The legend lists series, the hover
  lists series × year, and the Figure's key is a row per series followed by
  its year ramp. Its axis is one slot with no year, and its hours footnote
  counts each year's hours out of the drawn years' real hours. Asserted by
  `tests/test_palette.mjs`, `tests/test_time_span.mjs` and
  `tests/test_figure.mjs`.
- **The SVG is the one drawing path**, written for Word: presentation
  attributes only, text on an explicit baseline, data cropped by the builder
  rather than `clipPath`, Aptos first. Asserted by `tests/test_figure.mjs`.
- **Every text a figure draws goes through `say(id, text)`** in the builder,
  so a dialog edit replaces exactly that text. Edits live in the dialog's
  closure and are never remembered: the next figure starts from the app's
  labels. Asserted by `tests/test_figure.mjs`.
- **No line dash equals the limit dash** (`LINE_DASHES`, `LIMIT_DASH` in
  `src/figure/build.ts`): a limit is drawn in its line's colour, so a line in
  that dash would read as a limit. Asserted by `tests/test_figure.mjs`.
- **The four pane headers are one header with the pane number changed.**
  Any pane can hold any chart type, so a control written into one pane only
  is a type that half works. Each pane shows the controls its type's adapter
  names, and a box pane's `by` is that pane's own, saved in a bundle as
  `boxDims`. Asserted by `tests/test_dom_contract.mjs`.
- **A chart type is one adapter** (`PaneAdapter` in `src/ui/panes/`): its
  drawing, refusals, hover, resize, teardown, Figure capture and controls.
  A pane tears the old type down before the new one draws and routes input to
  the drawn type only, so a rule written as a branch on type in `charts.ts`
  is a second owner for it. Asserted by `tests/test_panes.mjs`.
- **Every chart type draws a Case over its whole span**, never its first
  year as the run, so no pane refuses a Case for spanning years. Asserted by
  `tests/test_panes.mjs`.
- **A pane's Figure button reads the pane's refusal banner**, after the
  panes paint, instead of restating each pane's refusal rules. A pane that
  refuses without `banner(body, 'refusal', …)` would still offer a figure.
  Asserted by `tests/test_dom_contract.mjs`.

### Module layout

`src/main.ts` is the only module that holds mutable app state (Case store,
frozen query, notes channels, buffers) and the only one that resolves a global
DOM id. It passes everything else as arguments.

Only cross-directory primitives sit beside it at the top of `src/`. A module
with a collaborator gets a directory.

`src/app/` holds sequences long enough to read on their own. **A module there
that imported the store would be the root with extra steps.** The ingest
engines take an `IngestHost` for that reason; `tests/test_integration.mjs`
asserts neither reaches `attachTable`. A part of the root that reads on its
own moves there the same way: handed the store instances and accessors it
reads, holding at most a cache or a dialog's lifetime, never state a restore
would have to put back.

**One ingest sequence per shape, not per kind.** A kind states its nouns,
entity set and slot as a `WideBatch`/`AreaLongBatch`/`EntityLongBatch` value
in `src/app/ingest-kinds.ts`, which takes its readers from the root so
`tests/test_ingest_kinds.mjs` runs each kind's batch without a Worker. A new
kind needing a new step gets a hook, never a copy of the sequence or a flag
the engine branches on.

**The Contents inventory records a table only at the ingest host's
`attach`**, which is handed the files behind it. Axis widening re-attaches
every Area table through the Case store and must not record, or each widening
would log its tables as freshly loaded. Notes reach a file's record by the
`File` objects the engine's outcome names, never by a filename in the text.
A drop (`src/app/drop-load.ts`) brackets itself with `beginDrop`/`endDrop` so its accepted files
are one `loaded` event carrying the notes that name no file; a record made
outside a drop logs itself at once. A refused or skipped file is logged, never
recorded. Asserted by `tests/test_integration.mjs`, `tests/test_ingest_batch.mjs`,
`tests/test_inventory.mjs` and `tests/test_drop_load.mjs`.

## Tests and formatting

`npm test` runs `prettier --check .`, `tsc --noEmit`, then each
`tests/test_*.mjs` as its own process, stopping at the first failure. Run
`npm run format` before committing. While iterating, run `npx tsc --noEmit`
and then the one suite you touched (`node tests/test_browse.mjs`):
`npm test <file>` ignores the argument and runs everything.

Prettier skips markdown, `index.html` and `data/` (reasons in
`.prettierignore`). Three literals carry `// prettier-ignore` because they are
hand-laid grids: the month names, the colour palette and the wasm SIMD probe.
The ignore comment must be the last line before the declaration.

Send long output to a file (`npm test > /tmp/gvp-test.log 2>&1`) and read the
head as well as the tail: `tsc` and the runner print the cause first.

A change to the drawer, pins, groups or save/restore is not done on passing
suites alone. Confirm it in the real app with the `drive-app` skill
(`.claude/skills/drive-app/`), on the data it generates: a Node test proves the
model, not that the page wires it.

## Commits

**No AI authorship in commits.** No `Co-Authored-By:` naming an AI, no
`Claude-Session:` link, no "Generated with …" line, in a commit message or an
issue. The README discloses AI assistance once; a commit is authored by the
human who owns the change. This overrides any tool's attribution default.
Asserted by `tests/test_commit_messages.mjs`.

**A subject, and at most one line of why.** The diff says what changed; a
body that retells it is noise. Keep `Closes #N`: it closes the issue on push.

**History on `main` is linear: one short commit per piece of work**, not a PR
and not a merge commit. Before a push, squash exploratory unpushed commits
into those. Never rewrite a pushed commit.

## Agent tooling

`sample-data/`, `node_modules/` and `dist/` are generated or vendored,
gigabytes, and hold no answers about this code; skip them in a search.
`scripts/make-perf-data.mjs` and `tests/test_perf_data.mjs` say what the perf
data contains.

For a wide read-only sweep (which suite asserts X, where a symbol is used),
ask a subagent for matching lines with `file:line`, not a summary. Read the
file yourself before changing it.

`pi` (`~/.local/bin/pi`) is a cheap non-Claude agent, reachable only through
Bash. Always pass `</dev/null` (it reads stdin and otherwise hangs silently)
and `-xt edit,write,bash` (otherwise it edits files without asking). Keep its
output in a log file and grep it.

Issues live on GitHub via `gh`. PRs are not a request surface here.

Use the project's own vocabulary: KIND vs SHAPE, slot key, Case, plane, cube,
entity axis. Where a skill asks for `CONTEXT.md` or `docs/adr/`, proceed
without them.
