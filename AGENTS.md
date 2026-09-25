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

The long reader says `area` where it means entity (`numAreas`, `rowArea`,
`area_table_put`). Those reach wasm export names, so renaming them is an ABI
change and a binary rebuild.

Each `block.c` declares `ABI_VERSION`, mirrored by `PARSER_ABI` in
`src/tables/long/block.ts` and `src/tables/wide/block.ts`. **Bump both sides
together** when the exported surface or arena layout changes, so a stale
committed binary fails at instantiate instead of misreading rows.
`tests/test_rot_guards.mjs` asserts they agree and that no other file states
an ABI number.

### Ingest

- The axis is read from the file, never assumed. Column counts and order vary.
- **Row order carries no meaning.** A value-sorted export must load
  byte-identically to a date-ordered one. Do not add an ordering check.
- Feb 29 is dropped, so every case is 8,760 hours. Both `block.c` files
  enforce it; no kind derives it differently.
- Hour is hour-ending 1-24, converted with `hour - 1`. A new kind's parsing
  must state its convention and prove it with a fixture.
- One row per (entity, hour). A duplicate is refused with a coverage map,
  never resolved by last-writer-wins.
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

**Anything a bundle saves against a Case names it by its index in the
manifest's `cases`, never by a Case id.** Restore mints fresh ids, so id-keyed
entries need a remap on every restore path. A pin's row id is rebuilt at
restore by `rowIdOf`. Older bundles with id-keyed `selections` and
`limits.cases` are migrated on read and never written. Asserted by
`tests/test_storage.mjs`, including that both restore paths in `main.ts` adopt
limits.

A pin's `perUnit` field and the `p.u.` token in its row id are wire format:
renaming either orphans every saved "% of range" pin.
A filter context entry's `chosenOn` is wire format too: it is what keeps a
switched group pin from reading its "Max ≥ 500" as a fact about the new
variable. Its `case` holds the Case's NAME, not its id, so it needs no remap
on restore; do not "fix" it to an id.
The Contents inventory's session-input keys (`limits (shared)`,
`groups:<kind>`, the lookup variants) are wire format as well. A restore
replaces a session row only when the bundle carried that input and it was
adopted, so the strip never names a file whose content was not taken up.

### UI

- **A groups tab offers only what it can answer.** `TAB_OFFERS` in
  `src/main.ts` names tabs that answer for some quantities; the predicate is
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
  (a control above Case, Variable and Unit) moves every pin at once. The Case
  and Variable dropdowns offer only what every pin can take; a blocked Case is
  listed disabled, naming the pins that block it. The % control refuses when
  one pin cannot be drawn as %. So pins never end up half moved and
  A → B → A returns the pins you started with (`src/ui/browse-retarget.ts`).
  The toolbar's Variable and % are hidden on that tab, so one widget never
  both lists and rewrites. Switched pins land through `replacePins`;
  `setSelection` is bundle restore only. Asserted by `tests/test_browse.mjs`.
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
  "% of range" column is 80%. Toggling "% of range" drops the bounds on the
  stat columns it rescales, since a MW bound against a % empties the table.
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
asserts neither reaches `attachTable`.

**One ingest sequence per shape, not per kind.** A kind states its nouns,
entity set and slot as a `WideBatch`/`AreaLongBatch`/`EntityLongBatch` value
in `main.ts`. A new kind needing a new step gets a hook, never a copy of the
sequence or a flag the engine branches on.

**The Contents inventory records a table only at the ingest host's
`attach`**, which is handed the files behind it. Axis widening re-attaches
every Area table through the Case store and must not record, or each widening
would log its tables as freshly loaded. Notes reach a file's record by the
`File` objects the engine's outcome names, never by a filename in the text.
`loadFiles` brackets a drop with `beginDrop`/`endDrop` so its accepted files
are one `loaded` event carrying the notes that name no file; a record made
outside a drop logs itself at once. A refused or skipped file is logged, never
recorded. Asserted by `tests/test_integration.mjs`, `tests/test_ingest_batch.mjs`
and `tests/test_inventory.mjs`.

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

**A finished branch merges into `main` with `--no-ff`**, not a PR, and the
merge subject names the feature. Never rewrite a pushed commit.

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
