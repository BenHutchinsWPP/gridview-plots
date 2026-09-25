---
name: drive-app
description: Launch GridView Plots in headless Chromium with invented SAMPLE_ data, load Cases, pin rows, edit interface groups, save a .gvmb and restore it, and read the Selected tab and screenshots. Use to confirm a change works in the real app, especially save/restore, pins, the browse drawer or group editing.
---

# Drive the app with invented data

A passing Node test does not prove a restore or a drawer works. This is how to
check it in the real app, on data it generates itself.

## Setup (once per session)

Work in the session scratchpad (`$W` below), never the repo.

```bash
W=<scratchpad>
cp .claude/skills/drive-app/*.mjs "$W"/
cd "$W" && npm init -y >/dev/null && npm i playwright && npx playwright install chromium
node make-sample-data.mjs "$W/data"   # see the header of make-sample-data.mjs for the set
```

Each run starts in the repo root, so pass absolute paths or use `cd "$W" &&`.
The helpers import `playwright` from where they sit, so run them from `$W`.

The invented levels make values easy to check: paths P01/P02/P03 carry
100/40/7 MW in Summer and double that in Winter. Buses 90001–90003 carry
LMP 21/22/23 in Summer and 31/32/33 in Winter. A boundary of all three
paths with P03 reversed is 133.

For groups, `loadGroupStudy` loads one Case, SAMPLE_Summer, with Area load,
Bus load, Generator energy and Interface flow. Each kind's three members are
1000, 100 and 10 (Interface: 100/40/7), so any subset's sum names which members it holds.
Bus LMP is intensive and a group refuses it; Bus load sums.

## Server

```bash
npx vite --port 5199 --strictPort > "$W/vite.log" 2>&1 &   # run_in_background
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://localhost:5199/ | grep -q 200 && break; sleep 1; done
# ...when done:
lsof -ti:5199 -sTCP:LISTEN | xargs -r kill
```

## What `drive.mjs` already knows (rediscovered the hard way)

- **Launch** with `--no-sandbox`. `open()` adds an init script that deletes
  `window.showSaveFilePicker`, so Save falls back to a download you catch with
  `page.waitForEvent('download')`. Headless cannot answer the picker.
- **Feeding files:** `page.setInputFiles('#file-input', [...])`. A lookup-only
  drop, such as a BusList, opens no dialog. A CSV drop opens "Assign N dropped
  files to Cases".
- **The import dialog is not a `<dialog>`.** Click "Assign each file
  individually". The per-file Case inputs are `input.modal-filter:visible`, in
  the listed file order. Fill each one and press Tab, then click "Load
  everything". Wait for the header to say `2 cases`.
- **The drawer** opens on its own after a load and starts closed after a
  restore. `tab()` clicks `#browse-handle` only when the tab button is hidden.
  Checking the handle's visibility races the drawer's animation. Tab buttons
  are `.browse-tab` with text such as `Selected (4)`, so match them anchored:
  "Interface" is a prefix of "Interface Groups".
- **Pin** by checking the row's `input[type=checkbox]` (`pinRow`).
- **The interface group editor:** "Edit Groups…" on the Interface Groups tab,
  "New group…" plus Add, then double-click a path to add it. Each member has a
  `.groups-mark` button reading forward or reversed; click it to flip.
  Double-clicking a member in the middle column removes it. Clicks inside the
  modal must be scoped to `.modal-backdrop .groups-list`, because the drawer
  table underneath has the same text. Finish with "Apply groups".
- **Restore:** drop the `.gvmb` on `#file-input`, in a FRESH context
  (`open(browser)` again) to prove it does not lean on session state. Drop it
  twice into one context to prove a second restore works too.
- **Wait with `idle()`** between drops. A drop made while a load runs is
  refused with "A load is already running", which is easy to miss.
- **A membership file** dropped on the window opens a pane asking which kind
  it groups. A header only one editor writes (`BusID,Grouping`,
  `Name,Grouping,Direction`, `Name,Bus ID,Unit ID,Grouping`) starts on that
  kind, so "Load" takes it. `Name,Grouping` is Area's and Generator's, and
  starts on Areas. A group editor's "Save CSV…" is caught as a download.
- **Limits:** `loadLimits(page, file, caseName)` drops an interface limit
  schedule. A limits-only drop still opens the import dialog, with one
  "Applies to" select per file; `null` shares it with every Case.
- **Group edits:** `editGroup(page, tab, { group, create, add, remove })`
  drives the shared membership editor for any kind. It confirms with the
  modal's primary button, which reads "Apply groupings" for Area and
  "Apply groups" for the others.
- **Stacks:** `stackedSlot(page, n)` puts slot `n` on the stacked chart
  and returns its refusal text, or null when it drew. Use slot 1: slots 3
  and 4 are below the fold in the screenshot. A stack refuses mixed units
  before it checks for overlap, so compare MWh with MWh.
  `loadGroupStudy(page, { sharedArea: true })` loads the lists that put
  units 1 and 2 and buses 90001 and 90002 inside SAMPLE_AREA_1, plus a Bus
  Load (MWh) export, which is what an overlap check needs.
- **Any other study:** `loadCaseFiles(page, files, caseName)` drops the
  named data files into one Case. Two per-column Area files cannot share a
  Case (one metric each), so the Area Groups checks use the long exports
  `SAMPLE_CASEA_AreaLong_WithLoad.csv` and `..._NoLoad.csv`.
- **Load… (origin-private storage)** is per browser context: Save, then
  click `#load-btn` in the SAME context. In a context with nothing stored,
  Load… falls back to a file picker (`page.waitForEvent('filechooser')`).
- **Read results** with `selectedRows()`: Case, Kind, Entity, In scope,
  Average for each pinned row. "In scope: yes" means the pin's row id matched
  a live row. Then LOOK at the screenshot, because the DOM does not show
  whether a line was drawn.

## Worked example

`GV_WORK="$W" node example-save-restore.mjs` loads two Cases, makes a boundary
group, pins two buses, one path and the group across both Cases, saves
`study.gvmb`, then restores it twice in a fresh context. It prints the
Selected tab each time and writes screenshots to `$W`.

To inspect a saved bundle's manifest, `manifestOf(path)` reads it. Bytes 0–3
are `GVMB`, bytes 4–7 are the little-endian manifest length, and the
manifest JSON follows.
