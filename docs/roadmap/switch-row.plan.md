# Switch row

A row of controls on the Selected tab, directly under the headers and aligned
with the columns they change, labelled "Switch all". Each one moves every pin
at once:

```
 Case          Kind   Entity        Variable          Unit       Min    Max
 [Case B  ▾]                        [Generation ▾]    [MW|%]
 ─────────────────────────────────────────────────────────────────────────
 Case B        gen    WILLOWBEND    Generation        MW         0      412
 Case B        gen    SOLAR_7       Generation        MW         0      180
```

- **Case ▾** moves every pin to another Case. New.
- **Variable ▾** is the variable switch, moved from the drawer toolbar.
- **MW|%** is the "% of range" switch, moved from the toolbar to sit above
  Unit.

## Decisions

**The switches leave the toolbar.** On a kind tab the toolbar's Variable
dropdown and % toggle choose what is listed. On the Selected tab the same
widgets rewrite the pins. One widget with two meanings is what the row
removes. On the Selected tab the toolbar hides both.

**A switch rewrites the pins; it is not an override layer.** Bundles, restore
and row ids stay untouched, as `browse-retarget.ts` already requires.
Rejected: a layer that leaves pins as they are and changes only what is drawn.
Pin ids would stop matching what is drawn, which breaks the tick on the kind
tabs, the Selected stats and "In scope", and the layer would need saving.
"Override" is not used as a name because it promises that clearing it
restores the start.

**The Case switch offers only Cases every pin can move to**, the same rule as
the variable switch. No pin is ever dropped, so stepping through Cases with
the arrow keys is lossless (A → B → C → A returns the pins you started with)
and AGENTS.md's "never goes partway" stays as written.
Rejected: dropping pins that cannot move. The dropped pins would not come
back on the way back, and the choice would need kept counts and a list of
what was lost.

**A blocked Case is listed disabled, with the pins that block it**, e.g.
`Base (no data: SOLAR_NEW_1, BESS_4)`. What is withheld is said, and the
analyst can see which pin to unpin. A native `<select>` skips disabled options
under the arrow keys, so stepping visits only safe Cases.

**Every control is a native `<select>`, the MW|% one included** (options
`MW` and `% of range`). A focused, closed `<select>` already steps its options
with Up/Down, fires `change` on each step and skips disabled options (Chrome,
Edge and Firefox on Windows; macOS Chrome opens the list instead). So
arrow-key stepping through an available switch needs no key handling of our
own. Rejected: a custom keydown handler, which would reimplement what the
element already does.

**The Case switch needs one Case, not one kind or one variable.** Area and
Generator pins from Case A move together. The variable switch keeps its own
refusals (one kind, one variable).

**A group pin's rule is the variable switch's rule:** it moves when at least
one member has data in the target Case (`subjectIn`). A frozen-member group
moved to a Case missing some members sums fewer, exactly as it does after a
variable switch.

**A switched group says which Case chose its members.** A group pinned in
Case A under "Max ≥ 500" keeps the same members when switched to Case B, but
B's numbers did not choose them. Without a note the label reads as a fact
about B, so it reads "Max ≥ 500 (chosen in Case A)". Switch back to A and the
note goes. `chosenOn` gains an optional `case`, holding the Case's original
name: the key by-Case buckets already put in row ids, which a rename in
Contents does not change. It is shown through the current display name.
Rejected: the Case id or manifest index. A caption does not need the remap
every restore path would then owe it. A plain name needs none, and an older
bundle without the field needs no migration. This is to be judged in use.

## Steps

1. **`targetOf` takes a target Case** (`src/ui/browse-retarget.ts`), defaulting
   to `ref.caseId`. It looks for the holder in that Case instead of the pin's
   own. The variable and % switches are unchanged.
2. **`caseSwitch(pins, kinds, cases)`**, beside `variableSwitch`. It returns
   every loaded Case in load order: offered when `targetOf` places every pin,
   otherwise disabled with the pins that fail. It refuses when the pins span
   Cases or none are pinned.
3. **`retargetCase(entries, caseId, caseName, kinds)`**, beside
   `retargetVariable`. It sets `caseId`, `slotKey`, `unit`, `axisIndex`,
   `label`, and rebuilds the id with `withRowId`. A by-Case bucket pin
   (`groupBy === CASE_GROUP_BY`) also gets `groupValue = caseName`, because
   the Case name is in its row id. Colour and order are kept, and
   `firstPerId` still guards against collisions.
4. **Stamp the Case in the filter context.** `stamped()` stamps
   `chosenOn.case` on the entries `dependsOnVariable` selects, the first time
   the Case changes. Variable and Case are stamped independently: today an
   entry with any `chosenOn` is skipped, which would never record the Case of
   a pin that switched variable first. `pinnedConstraint` adds
   `chosen in <Case>` when the stamped name differs from the pin's Case, so it
   takes a name lookup. Name `chosenOn.case` as wire format in AGENTS.md
   beside `chosenOn`.
5. **Handler in `main.ts`** beside `onSelectedVariableChange`: it lands
   through `browseDrawer.replacePins`, never `setSelection`. Add `case` to
   `selectedSwitches`.
6. **The row.** The headers already paint through Tabulator's
   `titleFormatter` (`src/ui/browse-table.ts`). On the Selected tab, the Case,
   Variable and Unit headers get a second line holding their control, so
   Tabulator keeps them aligned through resizing and reordering. A "Switch
   all" label goes on the first column's second line.
7. **Remove the Selected branches** from the toolbar's `variableSelect` and
   `perUnitToggle` handlers in `src/ui/browse-drawer.ts`.
8. **Tests** in `tests/test_browse.mjs`, next to the variable-switch suite:
   - only safe Cases are offered, and blocked ones name their pins;
   - Case A → B → A returns the same ids and colours;
   - a mixed-kind pin set moves;
   - a by-Case bucket pin's id takes the new name;
   - pins across two Cases refuse;
   - a filtered group moved A → B reads "chosen in A", moved back reads plain;
   - variable then Case records both, each once.
   Update AGENTS.md's Selected-tab rule to name the Case switch and the row.
9. **Confirm in the real app** with `drive-app`: pin in Case A, switch to B,
   save a `.gvmb`, restore it, and see the B pins come back.

## Footguns

- **`headerSignature`** must carry each control's options, its selected value
  and its disabled reasons, or the header repaints stale after a pin changes
  (AGENTS.md, UI). Test it.
- **A step rebuilds the header and loses focus.** Each `change` rewrites the
  pins, which moves `headerSignature`, which rebuilds the header and destroys
  the focused `<select>`, so the second arrow press lands nowhere. After a
  header rebuild, if a switch control held focus, focus the new one with the
  same column key. Confirm in `drive-app` that Down, Down, Down steps three
  Cases.
- **Clicking a header sorts.** A control inside a header must stop its
  click and keydown from reaching Tabulator's sort and column drag.
- **A by-Case bucket's row id carries the Case name.** A switch that forgets
  `groupValue` produces a pin no tab ticks and no restore matches.
- **`chosenOn.case` is a name, not a Case reference.** Do not "fix" it to a
  Case id: ids are minted fresh on restore and would need a remap on both
  restore paths.
- **"% of range" limits are per Case** (`interfaceRange(caseId, …)`). A %
  pin moves only if `percentRefusal` passes in the target Case, which
  `targetOf` already checks.
