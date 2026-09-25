# GridView Plots

A browser app for comparing GridView hourly CSV exports across study cases:
time series, duration curves, box plots, X-Y scatter, diurnal heatmaps and
summary statistics, for areas, interfaces, buses and generators.

Everything runs locally in the browser. There is no server and nothing is
uploaded.

⚡ Live: **[GridView Plots](https://benhutchinswpp.github.io/gridview-plots/)**

## Use

Drop CSV exports anywhere on the window. The app detects each file's kind and
layout, and the Import Dialog assigns files to Cases. A Case can hold several
tables, such as one Area export and two Interface quantities from the same run.

Find series in the **browse drawer** at the bottom. Sort and filter its
columns, click a row to preview it, and tick it to pin it to the plots. Drag
across cells and press Ctrl+C to copy them, with their column names, for
pasting into Excel: numbers copy at full precision and percentages as 0–1. The
**Selected** tab lists what is pinned. Its Variable dropdown moves every pin
to another quantity at once, and its "% of range" button switches them all.

**Save** writes a `.gvmb` bundle of everything loaded, including groups and
reference lists. **Load** restores one. Older `.gvap` and `.gvip` bundles also
load. The browser keeps a copy of the session between visits, but the `.gvmb`
file is the one to keep.

### What it accepts

| Input | Notes |
|---|---|
| Area, Interface, Bus, Generator hourly exports | Both the wide layout (one column per entity) and the long layout (one row per entity-hour) |
| `BusList`, `GeneratorList` | Reference lists. Their columns become browse-drawer columns and group-by options |
| `Groupings.csv` or another membership CSV | Named groups of areas, buses, generators or interfaces. You map the columns on load |
| `INTERFACELIMITSCHEDULE_MONTHLY` | Monthly MIN/MAX per path, drawn dashed on the time chart, and the divisor for "% of range" (summed across an interface group's members) |

### Rules worth knowing

- **Every case is 8,760 hours.** Feb 29 is dropped at load. Hours are read as
  hour-ending 1-24.
- **Row order does not matter**, but the same entity-hour appearing twice is
  refused. That usually means two exports were concatenated.
- **Files given the same study name load as one table.** This is how a year
  exported in halves goes back together. Drop the halves together.
- **Quantities combine only where their unit allows it.** Energy, cost and
  flow sum across entities. A price or percentage does not, and the control
  says why. Area prices are load-weighted using `data/area/aggregation-rules.json`.
- **Buses are identified by bus number**, not name, because names can repeat.
- **Interfaces never group by attribute**, because an arbitrary set of paths
  is not a boundary. An interface group is one you author, and each member
  counts `forward` or `reversed` (× −1).
- **Bus and generator pickers open with nothing selected.** A full-width
  export is hundreds of megabytes per case, so you choose what to keep.

## Develop

```bash
npm ci
npm run dev      # local server
npm test         # prettier, tsc, then every tests/test_*.mjs
npm run build    # static site in dist/
```

The CSV parsers are C compiled to WebAssembly. The binaries
(`parser/*/block.wasm`) are committed, so a normal build needs no wasm
toolchain. See `parser/*/build.sh` if you change a `.c` file.

`AGENTS.md` holds the architecture rules and footguns for anyone changing the
code, human or agent.

## License

See [LICENSE](LICENSE).

---

Ben Hutchins (WPP) designed and scoped this application; the implementation was done with an AI-assist.
