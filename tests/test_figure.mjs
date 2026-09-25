// tests/test_figure.mjs — a pane exported as a print figure
// (src/figure/build.ts), asserted as a report reader would read it: the text
// the SVG carries and where it sits (context line, axis title, legend cell,
// footnote), and what Word needs of the markup.
//
//   * Each fact is stated once: shared facts move up to the context line, an
//     axis title or a footnote; differing facts are legend columns.
//   * One line still gets a one-row legend; the drawer's preview is never
//     drawn.
//   * Word-safe SVG: no class, style, foreignObject, clipPath or
//     dominant-baseline; Aptos first; sized in inches over a point viewBox.
//   * The hours footnote carries a count and is absent at 8,760 hours.
//   * Warnings, weighted means and lines not drawn reach a footnote or the
//     row they concern; long cells and notes wrap; a crowded plot is flagged.
//   * The caption and filename name what every line shares; an edit by id
//     replaces that text and nothing else.
//   * Thinning keeps every pixel column's minimum and maximum and every break.
//   * Limit lines: drawn and named (`limits`, or `summed limits (best case)`)
//     only when the pane draws them; line dashes tell apart lines of one
//     colour, or every line for print, and never equal the limit dash.
//   * Duration: the pane's `% of interval` axis over its zoom window.
//   * Box: the dimension's categories and title on x, outlier counts, value
//     labels only when ticked, one legend row per box colour.
//   * Stacked: bands in stack order, the legend top band first, thinned on
//     shared columns so every band total keeps its extremes.
//   * X-Y: each axis titled by its series' full label, in the pane's order;
//     no legend; the fit and its equation only when on; one mark per pixel.
//   * Heatmap: 24 × 365 vector cells on the pane's colour scale, a colour bar
//     for a legend, the key in the context line, filtered hours footnoted.
//   * A bus key is `number name kV`, the kV only where the BusList states one.
//
// Text is measured at a fixed width per character, so layout is exact here.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { buildFigure, figureLines, FIGURE_SIZES, LIMIT_DASH, LINE_DASHES } =
  await import('../src/figure/build.ts');
const { thinLine, thinShared } = await import('../src/figure/thin.ts');
const { runningTotals } = await import('../src/figure/stacked.ts');
const { HOURS_PER_YEAR: H } = await import('../src/model/calendar.ts');
const { resolveDraws } = await import('../src/app/draw.ts');
const { createSeriesPool } = await import('../src/series/pool.ts');
const { rowKeyOf } = await import('../src/model/case-model.ts');

const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

const measureText = (text, pt) => text.length * pt * 0.5;

const facets = (over) => ({
  caseLabel: 'Summer 2035',
  kind: 'interface',
  variable: 'Power Flow (MW)',
  unit: 'MW',
  subject: 'NORTH_PATH',
  ...over,
});

const flat = (level) => new Float32Array(H).fill(level);

function line(over = {}, level = 100) {
  const f = facets(over.facets);
  return {
    name: f.subject,
    color: over.color ?? '#1f77b4',
    unit: over.unit ?? f.unit,
    values: over.values ?? flat(level),
    ...(over.dashed ? { dashed: true } : {}),
    facets: f,
  };
}

function build(lines, over = {}) {
  return buildFigure({
    pane: 'time',
    lines,
    xWindow: [-0.5, H - 0.5],
    hourFilter: 'all hours',
    size: FIGURE_SIZES.half,
    measureText,
    ...over,
  });
}

/** The text of one id, as drawn. */
const textOf = (figure, id) => figure.texts.find((entry) => entry.id === id)?.text;
const legendCells = (figure) =>
  figure.texts.filter((entry) => /^legend\[\d+\]\[\d+\]$/.test(entry.id)).map((e) => e.text);
const footnotes = (figure) =>
  figure.texts.filter((entry) => entry.id.startsWith('footnote[')).map((e) => e.text);
/** Every `<text>` content in the SVG, unescaped. */
const svgTexts = (svg) =>
  [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  );

// ------------------------------------------------------------ 1. placement

ok('a shared Case is in the context line, not a legend column', () => {
  const figure = build([line(), line({ facets: { subject: 'SOUTH_PATH' }, color: '#ff7f0e' })]);
  assert.match(textOf(figure, 'context'), /^Case: Summer 2035/);
  assert.ok(!legendCells(figure).includes('Summer 2035'), legendCells(figure).join(' | '));
  assert.ok(svgTexts(figure.svg).includes(textOf(figure, 'context')), 'the SVG draws it');
});

ok('Cases that differ are a legend column, first, and leave the context line', () => {
  const figure = build([line(), line({ facets: { caseLabel: 'Winter 2035' }, color: '#ff7f0e' })]);
  assert.ok(!/Case:/.test(textOf(figure, 'context') ?? ''), textOf(figure, 'context'));
  assert.equal(textOf(figure, 'legend[0][0]'), 'Summer 2035');
  assert.equal(textOf(figure, 'legend[1][0]'), 'Winter 2035');
  assert.equal(textOf(figure, 'legend[0][1]'), 'NORTH_PATH', 'then the key');
  for (const cell of ['Summer 2035', 'Winter 2035']) assert.ok(svgTexts(figure.svg).includes(cell));
});

ok('a shared kind is in the context line with the quantity; kinds that differ are a column', () => {
  const same = build([line(), line({ facets: { subject: 'SOUTH_PATH' } })]);
  assert.match(textOf(same, 'context'), /Interface · Power Flow$/);
  const mixed = build([
    line(),
    line({ facets: { kind: 'bus', subject: 'ALDER (101)', variable: 'Power Flow (MW)' } }),
  ]);
  assert.ok(!/Interface|Bus/.test(textOf(mixed, 'context')), textOf(mixed, 'context'));
  assert.ok(legendCells(mixed).includes('Interface') && legendCells(mixed).includes('Bus'));
});

ok('the quantity and unit are the y-axis title, one per scale', () => {
  const one = build([line()]);
  assert.equal(textOf(one, 'axis.y[0]'), 'Power Flow (MW)');
  const two = build([
    line(),
    line({ facets: { variable: 'LMP ($/MWh)', unit: '$/MWh', kind: 'bus', subject: 'ALDER' } }),
  ]);
  assert.equal(textOf(two, 'axis.y[0]'), 'Power Flow (MW)');
  assert.equal(textOf(two, 'axis.y[1]'), 'LMP ($/MWh)');
  assert.ok(!legendCells(two).includes('LMP'), 'two axes: each title names its quantity');
});

ok('two quantities on one unit keep the unit on the axis and add a quantity column', () => {
  const figure = build([
    line(),
    line({ facets: { variable: 'Loop Flow (MW)', subject: 'SOUTH_PATH' }, color: '#ff7f0e' }),
  ]);
  assert.equal(textOf(figure, 'axis.y[0]'), 'MW');
  assert.ok(legendCells(figure).includes('Power Flow'), legendCells(figure).join(' | '));
  assert.ok(legendCells(figure).includes('Loop Flow'));
});

ok('every legend row names its key', () => {
  const figure = build([
    line(),
    line({ facets: { subject: 'SOUTH_PATH' } }),
    line({ facets: { subject: 'EAST_PATH' } }),
  ]);
  const keys = [0, 1, 2].map((row) => textOf(figure, `legend[${row}][0]`));
  assert.deepEqual(keys, ['NORTH_PATH', 'SOUTH_PATH', 'EAST_PATH']);
});

ok('a group key is its figure subject: the counted group, or an interface group by name', () => {
  const figure = build([
    line({
      facets: { groupBy: 'Zone', subject: 'SOUTH', figureSubject: 'Zone = SOUTH (14 buses)' },
    }),
    line({ facets: { groupBy: 'Interface Group', subject: 'WEST', figureSubject: 'WEST' } }),
  ]);
  assert.deepEqual(
    [textOf(figure, 'legend[0][0]'), textOf(figure, 'legend[1][0]')],
    ['Zone = SOUTH (14 buses)', 'WEST'],
  );
});

ok('a shared "% of range" divisor is in the axis title; divisors that differ are a column', () => {
  const shared = build([
    line({ unit: '%', facets: { range: '% of limit' } }),
    line({ unit: '%', facets: { range: '% of limit', subject: 'SOUTH_PATH' } }),
  ]);
  assert.equal(textOf(shared, 'axis.y[0]'), 'Power Flow (% of limit)');
  assert.ok(!legendCells(shared).includes('% of limit'));
  const differ = build([
    line({ unit: '%', facets: { range: '% of limit' } }),
    line({ unit: '%', facets: { range: '% of peak', subject: 'SOUTH_PATH' } }),
  ]);
  assert.equal(textOf(differ, 'axis.y[0]'), 'Power Flow (%)');
  assert.ok(
    legendCells(differ).includes('% of limit') && legendCells(differ).includes('% of peak'),
  );
});

ok('shared group filters are a footnote; filters that differ sit under their row', () => {
  const max = [{ label: 'Max', constraint: '≥ 500' }];
  const shared = build([
    line({ facets: { filters: max } }),
    line({ facets: { filters: max, subject: 'SOUTH_PATH' } }),
  ]);
  assert.ok(footnotes(shared).includes('Group filter: Max ≥ 500'), footnotes(shared).join(' | '));
  assert.equal(textOf(shared, 'legend[0][under]'), undefined);
  const differ = build([
    line({ facets: { filters: max } }),
    line({ facets: { subject: 'SOUTH_PATH' } }),
  ]);
  assert.equal(textOf(differ, 'legend[0][under]'), 'filtered: Max ≥ 500');
  assert.equal(textOf(differ, 'legend[1][under]'), undefined);
  assert.ok(!footnotes(differ).some((note) => /Max/.test(note)));
  assert.ok(svgTexts(differ.svg).includes('filtered: Max ≥ 500'), 'escaped and drawn');
});

ok('two y scales name each row’s axis', () => {
  const figure = build([
    line(),
    line({ facets: { variable: 'LMP ($/MWh)', unit: '$/MWh', subject: 'ALDER' } }),
  ]);
  assert.ok(legendCells(figure).includes('left') && legendCells(figure).includes('right'));
  assert.ok(!legendCells(build([line()])).includes('left'), 'one scale, no axis column');
});

// ------------------------------------------------------------ 2. the legend

ok('one line still gets a one-row legend naming it', () => {
  const figure = build([line()]);
  assert.deepEqual(legendCells(figure), ['NORTH_PATH']);
  assert.equal((figure.svg.match(/<line [^>]*stroke="#1f77b4"/g) ?? []).length, 1, 'one swatch');
});

ok('the drawer’s preview line is never drawn, named or counted', () => {
  const pinned = line();
  const preview = line({ dashed: true, color: '#8a8f98', facets: { subject: 'PREVIEW_PATH' } });
  const figure = build([pinned, preview]);
  assert.ok(!figure.svg.includes('#8a8f98'), 'no grey stroke');
  assert.ok(!figure.svg.includes('PREVIEW_PATH'), 'no preview key');
  assert.ok(!figure.svg.includes('stroke-dasharray'), 'no dashes');
  assert.deepEqual(figureLines([pinned, preview]), [pinned]);
  assert.throws(() => build([preview]), /at least one drawn line/);
});

// ------------------------------------------------------------ 3. the markup

ok('the SVG is Word-safe: presentation attributes only, no clipPath, Aptos first', () => {
  const figure = build([line(), line({ facets: { caseLabel: 'Winter 2035' } })], {
    hourFilter: 'Month: Jul',
  });
  for (const banned of [
    'class=',
    '<style',
    'style=',
    'foreignObject',
    'clipPath',
    'clip-path',
    'dominant-baseline',
    'vector-effect',
    'var(--',
  ]) {
    assert.ok(!figure.svg.includes(banned), `the SVG carries ${banned}`);
  }
  const families = [...figure.svg.matchAll(/font-family="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(families.length > 0);
  for (const family of families) assert.match(family, /^Aptos, Calibri, Arial/);
  assert.ok(figure.svg.includes('<rect x="0" y="0" width="468" height="270" fill="#ffffff"/>'));
});

ok('the size is in inches over a viewBox in points', () => {
  const half = build([line()]);
  assert.match(half.svg, /<svg [^>]*width="6\.5in" height="3\.75in" viewBox="0 0 468 270"/);
  const full = build([line()], { size: FIGURE_SIZES.full });
  assert.match(full.svg, /width="6\.5in" height="5in" viewBox="0 0 468 360"/);
});

ok('data is cropped to the window by the builder: no point falls outside the plot', () => {
  const values = Float32Array.from({ length: H }, (_, h) => h);
  const figure = build([line({ values })], { xWindow: [1000, 1100] });
  const xs = [...figure.svg.matchAll(/<path d="([^"]*)"/g)].flatMap((m) =>
    [...m[1].matchAll(/[ML]([\d.]+) /g)].map((p) => Number(p[1])),
  );
  assert.equal(xs.length, 101, 'hours 1000 to 1100, and no others');
  const axis = figure.svg.match(
    /<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)" [^>]*stroke="#999999"/,
  );
  assert.ok(axis, 'the plot’s baseline is drawn');
  for (const x of xs)
    assert.ok(x >= Number(axis[1]) && x <= Number(axis[2]), `x ${x} off the plot`);
  // A value from outside the window would sit off the plot, and the y axis
  // spans only the window's values.
  const labels = svgTexts(figure.svg);
  assert.ok(!labels.includes('8,000'), 'the y scale was taken over the window alone');
  assert.ok(
    labels.some((label) => /^Feb 1/.test(label)),
    labels.join(' | '),
  );
});

// ------------------------------------------------------------ 4. footnotes

ok('the hours footnote states the filter and a count, and is absent at 8,760 hours', () => {
  assert.deepEqual(footnotes(build([line()])), [], 'every hour shown: no footnote');
  const values = flat(100);
  for (let h = 0; h < H; h++) if (h % 24 < 12) values[h] = NaN;
  const filtered = build([line({ values })], { hourFilter: 'Hour (HE): 13, 14' });
  assert.deepEqual(footnotes(filtered), ['Hours shown: Hour (HE): 13, 14 (4,380 of 8,760 hours)']);
  const zoomed = build([line()], { xWindow: [23.5, 191.5] });
  assert.deepEqual(footnotes(zoomed), ['Hours shown: 168 of 8,760 hours']);
});

ok('a warning some lines carry is a marked footnote; one every line carries is plain', () => {
  const plain = 'SAMPLE_WARN: "LMP" should be weighted by "Load"; every area weighs 1.';
  const capless = '1 summed unit has no max cap: the line can read over 100%.';
  const figure = build([
    { ...line(), warnings: [plain, capless] },
    { ...line({ facets: { subject: 'SOUTH_PATH' } }), warnings: [plain] },
    line({ facets: { subject: 'EAST_PATH' } }),
  ]);
  const notes = footnotes(figure);
  assert.deepEqual(notes, [`* ${plain}`, `† ${capless}`]);
  // The mark sits on each affected row, in a column after the key.
  assert.equal(textOf(figure, 'legend[0][1]'), '*†');
  assert.equal(textOf(figure, 'legend[1][1]'), '*');
  assert.equal(textOf(figure, 'legend[2][1]'), '');
  const drawn = svgTexts(figure.svg);
  assert.ok(drawn.includes('*†') && drawn.includes('*'), 'marks drawn');
  assert.ok(
    drawn.some((t) => t.startsWith('* SAMPLE_WARN')),
    'the footnote is drawn',
  );
  const shared = build([
    { ...line(), warnings: [plain] },
    { ...line({ facets: { subject: 'SOUTH_PATH' } }), warnings: [plain] },
  ]);
  assert.deepEqual(footnotes(shared), [plain], 'every line: no mark');
  assert.ok(!legendCells(shared).includes('*'));
});

ok('an Area weighted mean is a footnote when shared and a line under the row when not', () => {
  const area = (subject, weightColumn) => ({
    ...line({ facets: { kind: 'area', variable: 'LMP ($/MWh)', unit: '$/MWh', subject } }),
    ...(weightColumn ? { weightColumn } : {}),
  });
  const shared = build([area('ZONE_A', 'Load'), area('ZONE_B', 'Load')]);
  assert.ok(footnotes(shared).includes('Weighted mean by Load'), footnotes(shared).join(' | '));
  assert.equal(textOf(shared, 'legend[0][under]'), undefined);
  const differ = build([area('ZONE_A', 'Load'), area('ZONE_B')]);
  assert.equal(textOf(differ, 'legend[0][under]'), 'weighted mean by Load');
  assert.equal(textOf(differ, 'legend[1][under]'), undefined);
  assert.ok(!footnotes(differ).some((note) => /eighted/.test(note)));
  assert.ok(svgTexts(differ.svg).includes('weighted mean by Load'));
  // With a filter that differs too, both share the line under the row.
  const both = build([
    {
      ...area('ZONE_A', 'Load'),
      facets: { ...area('ZONE_A').facets, filters: [{ label: 'Max', constraint: '≥ 5' }] },
    },
    area('ZONE_B'),
  ]);
  assert.equal(textOf(both, 'legend[0][under]'), 'filtered: Max ≥ 5 · weighted mean by Load');
});

ok('a pinned line the pane left out is named in a footnote with its reason', () => {
  const refused = {
    ...line({ facets: { subject: 'WEST_PATH', caseLabel: 'Winter 2035' } }),
    values: null,
    refusal: 'Winter 2035 has no data for "Power Flow" on WEST_PATH.',
  };
  const zero = line({ facets: { subject: 'EAST_PATH' } }, 0);
  const figure = build([line(), zero, refused]);
  const notes = footnotes(figure);
  assert.ok(
    notes.includes(
      'Not drawn: Winter 2035 · WEST_PATH. Winter 2035 has no data for "Power Flow" on WEST_PATH.',
    ),
    notes.join(' | '),
  );
  assert.ok(notes.includes('Zero in every hour shown: EAST_PATH.'), notes.join(' | '));
  assert.ok(!legendCells(figure).includes('WEST_PATH'), 'a refused line has no legend row');
  assert.ok(legendCells(figure).includes('EAST_PATH'), 'a zero line is drawn and keyed');
  // Zero over the window is what counts, not over the year.
  const values = flat(0);
  values[5000] = 3;
  const zoomed = build([line(), line({ values, facets: { subject: 'EAST_PATH' } })], {
    xWindow: [23.5, 191.5],
  });
  assert.ok(footnotes(zoomed).includes('Zero in every hour shown: EAST_PATH.'));
  assert.ok(!footnotes(build([line({ values })])).some((note) => /Zero/.test(note)));
});

ok('a long footnote wraps inside the figure', () => {
  const long = 'A caveat '.repeat(40).trim();
  const figure = build([{ ...line(), warnings: [long] }]);
  const parts = svgTexts(figure.svg).filter((t) => /A caveat/.test(t));
  assert.ok(parts.length > 1, 'more than one line');
  assert.equal(parts.join(' '), long, 'nothing lost');
  for (const part of parts) assert.ok(measureText(part, 7.5) * 1.12 <= 468 - 12, part);
  assert.equal(footnotes(figure).length, 1, 'still one footnote id');
});

// ------------------------------------------------------------ 2b. legend overflow

ok('a legend cell wider than its column wraps; narrow columns keep their width', () => {
  const key = 'ZONE = A_GROUP_NAME_THAT_IS_LONG WITH SEVERAL WORDS IN IT (14 buses)';
  const figure = build([
    line({ facets: { figureSubject: key } }),
    line({ facets: { caseLabel: 'Winter 2035', figureSubject: key } }),
  ]);
  assert.equal(textOf(figure, 'legend[0][1]'), key, 'the edit id holds the whole cell');
  const drawn = svgTexts(figure.svg);
  assert.ok(!drawn.includes(key), 'not drawn on one line');
  const pieces = drawn.filter((t) => key.includes(t) && t.length > 1);
  assert.ok(pieces.length >= 4, `two rows of two or more lines: ${pieces.join(' | ')}`);
  assert.ok(drawn.includes('Summer 2035') && drawn.includes('Winter 2035'), 'Case kept whole');
  // Every legend text stays inside its half of the figure.
  const half = (468 - 12 - 14) / 2;
  const cells = [...figure.svg.matchAll(/<text x="([\d.]+)" [^>]*font-size="8.5"[^>]*>([^<]*)</g)];
  assert.ok(cells.length >= 6, `${cells.length} legend texts`);
  for (const match of cells) {
    const x = Number(match[1]);
    const start = x < 6 + half ? 6 : 6 + half + 14;
    assert.ok(x + measureText(match[2], 8.5) <= start + half + 0.01, `${match[2]} overflows`);
  }
});

ok('a name too long for its column breaks after an underscore before mid-word', () => {
  const figure = build([
    line({ facets: { figureSubject: 'SAMPLE_BUS_WITH_A_VERY_LONG_NAME_ALDERWOOD_JUNCTION' } }),
    line({ facets: { caseLabel: 'Winter 2035', figureSubject: 'SHORT' } }),
    line({ facets: { caseLabel: 'Autumn 2035', figureSubject: 'SHORT', kind: 'bus' } }),
  ]);
  const pieces = svgTexts(figure.svg).filter((t) => /^[A-Z_]+$/.test(t) && t !== 'SHORT');
  assert.ok(pieces.length > 1, pieces.join(' | '));
  for (const piece of pieces.slice(0, -1)) assert.match(piece, /_$/, `${piece} ends at a joint`);
  assert.equal(pieces.join(''), 'SAMPLE_BUS_WITH_A_VERY_LONG_NAME_ALDERWOOD_JUNCTION');
});

ok('the builder flags a plot left less than half the height, and not otherwise', () => {
  assert.equal(build([line()]).crowded, false);
  const many = Array.from({ length: 10 }, (_, i) => ({
    ...line({ facets: { subject: `PATH_${i}`, caseLabel: `Case ${i}` } }),
    warnings: [`Caveat number ${i} about this line, long enough to take a line of its own.`],
  }));
  const half = build(many);
  assert.equal(half.crowded, true);
  assert.ok(half.plotHeight < 270 / 2);
  assert.equal(build(many.slice(0, 2), { size: FIGURE_SIZES.full }).crowded, false);
});

// ------------------------------------------------------------ 5. caption, filename, edits

ok('the caption names the pane, kind, quantity, keys, Case and hours, and is in the SVG', () => {
  const figure = build([line(), line({ facets: { subject: 'SOUTH_PATH' } })]);
  assert.equal(
    figure.caption,
    'Hourly Interface Power Flow for NORTH_PATH and SOUTH_PATH, Case Summer 2035.',
  );
  assert.ok(figure.svg.includes(`<title>${figure.caption}</title>`));
  assert.ok(figure.svg.includes(`<desc>${figure.caption}</desc>`));
  assert.ok(!svgTexts(figure.svg).includes(figure.caption), 'no title inside the figure');
  const mixed = build(
    [
      line({ unit: '%', facets: { range: '% of limit' } }),
      line({ unit: '%', facets: { range: '% of limit', caseLabel: 'Winter 2035' } }),
    ],
    { hourFilter: 'Month: Jul' },
  );
  assert.equal(
    mixed.caption,
    'Hourly Interface Power Flow as % of limit for NORTH_PATH, Cases Summer 2035 and ' +
      'Winter 2035; hours: Month: Jul.',
  );
  const many = build(
    ['A', 'B', 'C', 'D', 'E'].map((subject) => line({ facets: { subject: `PATH_${subject}` } })),
  );
  assert.match(many.caption, / for 5 series, /);
});

ok('the filename folds kind, quantity, Case and pane, and leaves out a facet that differs', () => {
  assert.equal(build([line()]).fileStem, 'interface-power-flow_summer-2035_time');
  const cases = build([line(), line({ facets: { caseLabel: 'Winter 2035' } })]);
  assert.equal(cases.fileStem, 'interface-power-flow_time', 'Cases differ: no Case');
  const kinds = build([
    line(),
    line({ facets: { kind: 'bus', subject: 'ALDER (101)', variable: 'Load (MW)' } }),
  ]);
  assert.equal(kinds.fileStem, 'summer-2035_time', 'kind and quantity differ');
  const odd = build([line({ facets: { caseLabel: '2030 HL: v3 (final) ≥ “x”' } })]);
  assert.equal(odd.fileStem, 'interface-power-flow_2030-hl-v3-final-x_time');
  assert.match(odd.fileStem, /^[a-z0-9_-]+$/);
});

ok('a filename is at most 80 characters with its extension, and keeps its pane type', () => {
  const long = build([line({ facets: { caseLabel: 'A Very Long Case Name '.repeat(8) } })]);
  assert.ok(`${long.fileStem}.jpg`.length <= 80, `${long.fileStem}.jpg`);
  assert.match(long.fileStem, /^interface-power-flow_a-very-long-case-name-/);
  assert.match(long.fileStem, /[a-z0-9]_time$/, 'no dangling separator, pane type kept');
});

ok('an edit by id replaces exactly that text, caption included, and nothing else', () => {
  const lines = [line(), line({ facets: { caseLabel: 'Winter 2035' }, color: '#ff7f0e' })];
  const plain = build(lines, { xWindow: [23.5, 191.5] });
  const ids = plain.texts.map((entry) => entry.id);
  for (const id of ['context', 'legend[0][0]', 'footnote[0]', 'axis.y[0]', 'caption']) {
    assert.ok(ids.includes(id), `${id} among ${ids.join(', ')}`);
    const edited = build(lines, { xWindow: [23.5, 191.5], edits: { [id]: 'EDITED TEXT' } });
    for (const entry of edited.texts) {
      const before = plain.texts.find((other) => other.id === entry.id).text;
      assert.equal(entry.text, entry.id === id ? 'EDITED TEXT' : before, `${id} moved ${entry.id}`);
    }
    const drawn = svgTexts(edited.svg).filter((text) => text === 'EDITED TEXT').length;
    assert.equal(drawn, id === 'caption' ? 0 : 1, `${id} drawn once`);
    if (id === 'caption') assert.ok(edited.svg.includes('<title>EDITED TEXT</title>'));
  }
  assert.equal(build(lines).caption, plain.caption, 'the next figure starts from the app labels');
});

// ------------------------------------------------------------ 6. thinning

ok('thinning keeps every column’s minimum and maximum and every NaN break', () => {
  const values = Float32Array.from({ length: H }, (_, h) => Math.sin(h * 1.7) * 100 + (h % 97));
  for (const gap of [500, 501, 502, 4000]) values[gap] = NaN;
  const columns = 700;
  const runs = thinLine(values, 0, H - 1, -0.5, H - 0.5, columns);

  // Every break is kept: no run spans a NaN hour.
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      for (let h = run[i - 1][0] + 1; h < run[i][0]; h++) {
        assert.ok(!Number.isNaN(values[h]), `a run bridges the NaN at hour ${h}`);
      }
    }
  }
  assert.equal(runs.length, 3, 'two gaps make three runs');

  // Every column's extremes, per unbroken stretch, are among the points kept.
  const kept = new Set(runs.flat().map(([h]) => h));
  const columnOf = (h) => Math.min(columns - 1, Math.floor(((h + 0.5) / H) * columns));
  const extremes = new Map();
  let stretch = 0;
  for (let h = 0; h < H; h++) {
    if (Number.isNaN(values[h])) {
      stretch++;
      continue;
    }
    const key = `${stretch}:${columnOf(h)}`;
    const seen = extremes.get(key) ?? { low: h, high: h };
    if (values[h] < values[seen.low]) seen.low = h;
    if (values[h] > values[seen.high]) seen.high = h;
    extremes.set(key, seen);
  }
  for (const { low, high } of extremes.values()) {
    assert.ok(kept.has(low) && kept.has(high), `column extremes at ${low}/${high} kept`);
  }
  assert.ok(kept.size <= 2 * extremes.size, 'and nothing else');
  // A value's y is its own: every kept point is the hour's value.
  for (const run of runs) for (const [h, v] of run) assert.equal(v, values[h]);
});

ok('a figure of a year is thinned to its output columns, not 8,760 points', () => {
  const values = Float32Array.from({ length: H }, (_, h) => (h % 2 ? 1 : 0) * 100);
  const figure = build([line({ values })]);
  const points = (figure.svg.match(/[ML][\d.]+ [\d.]+/g) ?? []).length;
  assert.ok(points < H / 2, `${points} points drawn`);
  assert.ok(points > 1000, 'but every column keeps its low and high');
});

// ------------------------------------------------------------ 7. limits and dashes

/** Every `stroke-dasharray` on a path (a drawn line), in drawing order. */
const pathDashes = (svg) =>
  [...svg.matchAll(/<path [^>]*\/>/g)].map(
    (m) => m[0].match(/stroke-dasharray="([^"]*)"/)?.[1] ?? '',
  );
const dashText = (dash) => dash.join(' ');

ok('limit lines are drawn and named only when the pane draws them', () => {
  const limit = { color: '#1f77b4', unit: 'MW', values: flat(400) };
  const without = build([line()]);
  assert.ok(!legendCells(without).includes('limits'));
  assert.ok(!without.svg.includes(`stroke-dasharray="${dashText(LIMIT_DASH)}"`));
  assert.deepEqual(legendCells(build([line()], { limits: [] })), ['NORTH_PATH'], 'box unticked');

  const figure = build([line(), line({ facets: { subject: 'SOUTH_PATH' } })], {
    limits: [limit, { ...limit, values: flat(-400) }],
  });
  assert.equal(textOf(figure, 'legend[0][0]'), 'NORTH_PATH', 'line rows keep their ids');
  assert.equal(textOf(figure, 'legend[2][0]'), 'limits', 'one row after the lines');
  assert.equal(legendCells(figure).filter((cell) => cell === 'limits').length, 1);
  const drawn = figure.svg.match(
    new RegExp(`<path [^>]*stroke="#1f77b4"[^>]*stroke-dasharray="${dashText(LIMIT_DASH)}"`, 'g'),
  );
  assert.equal(drawn?.length, 2, 'both sides drawn in the line’s colour');
  // The y scale covers the limits, not just the lines.
  const labels = svgTexts(figure.svg);
  assert.ok(labels.includes('400') && labels.includes('−400'), labels.join(' | '));

  // A limit with no value in the window is neither drawn nor named.
  const gone = new Float32Array(H).fill(NaN);
  gone[8000] = 400;
  const zoomed = build([line()], {
    xWindow: [23.5, 191.5],
    limits: [{ ...limit, values: gone }],
  });
  assert.ok(!legendCells(zoomed).includes('limits'));
});

ok('a boundary’s limits are named as summed limits, a best case', () => {
  const summed = { color: '#1f77b4', unit: 'MW', values: flat(400), summed: true };
  const figure = build([line({ facets: { figureSubject: 'WEST' } })], { limits: [summed] });
  assert.equal(textOf(figure, 'legend[1][0]'), 'summed limits (best case)');
  assert.ok(!legendCells(figure).includes('limits'));
  const both = build([line(), line({ facets: { figureSubject: 'WEST' }, color: '#ff7f0e' })], {
    limits: [
      { color: '#1f77b4', unit: 'MW', values: flat(300) },
      { ...summed, color: '#ff7f0e' },
    ],
  });
  assert.deepEqual(
    [textOf(both, 'legend[2][0]'), textOf(both, 'legend[3][0]')],
    ['limits', 'summed limits (best case)'],
  );
});

ok('lines that share a colour get distinct dashes; print dashes give every line its own', () => {
  const shared = build([
    line(),
    line({ facets: { subject: 'SOUTH_PATH' } }),
    line({ facets: { subject: 'EAST_PATH' }, color: '#ff7f0e' }),
  ]);
  // The plot's paths come first, in pane order; legend swatches are lines.
  const plot = pathDashes(shared.svg).slice(0, 3);
  assert.equal(plot[0], '', 'the first of a colour is solid');
  assert.notEqual(plot[1], plot[0], 'the second of that colour is dashed');
  assert.equal(plot[2], '', 'another colour starts solid again');

  const lines = Array.from({ length: 10 }, (_, i) =>
    line({ facets: { subject: `PATH_${i}` }, color: `#00000${i}` }),
  );
  assert.ok(
    pathDashes(build(lines).svg).every((dash) => dash === ''),
    'colours alone',
  );
  const print = pathDashes(build(lines, { printDashes: true }).svg).slice(0, 10);
  assert.equal(new Set(print).size, 10, `every line its own dash: ${print.join(' | ')}`);
});

ok('no line dash ever equals the limit dash', () => {
  const texts = LINE_DASHES.map(dashText);
  assert.equal(new Set(texts).size, LINE_DASHES.length, 'the dashes are distinct');
  assert.ok(!texts.includes(dashText(LIMIT_DASH)));
  const figure = build(
    Array.from({ length: 10 }, (_, i) => line({ facets: { subject: `PATH_${i}` } })),
    { printDashes: true, limits: [{ color: '#1f77b4', unit: 'MW', values: flat(400) }] },
  );
  const limitDashes = pathDashes(figure.svg).filter((dash) => dash === dashText(LIMIT_DASH));
  assert.equal(limitDashes.length, 1, 'only the limit line is drawn in the limit dash');
});

// ------------------------------------------------------------ 8. duration and stacked

/** The x tick labels: 8 pt text on the line below the plot. */
const tickLabels = (figure) =>
  [...figure.svg.matchAll(/<text [^>]*font-size="8" [^>]*text-anchor="middle"[^>]*>([^<]*)</g)].map(
    (m) => m[1],
  );

ok('a duration figure keeps the pane’s % of interval axis and its zoom window', () => {
  const values = Float32Array.from({ length: H }, (_, h) => h);
  const full = build([line({ values })], { pane: 'duration', xWindow: [0, 100] });
  assert.equal(textOf(full, 'axis.x'), '% of interval');
  assert.ok(svgTexts(full.svg).includes('% of interval'));
  const labels = tickLabels(full);
  assert.equal(labels[0], '0%');
  assert.equal(labels[labels.length - 1], '100%');
  assert.ok(
    labels.every((label) => /^\d+%$/.test(label)),
    labels.join(' | '),
  );
  assert.match(full.caption, /^Duration curve of Interface Power Flow for NORTH_PATH/);
  assert.match(full.fileStem, /_duration$/);
  assert.deepEqual(footnotes(full), [], 'every hour is on the curve');

  // Zoomed to the lowest half: the ticks stop at 50% and the y scale reads
  // only the values in it (sorted ascending, as the pane draws them).
  const zoomed = build([line({ values })], { pane: 'duration', xWindow: [0, 50] });
  const zoomedLabels = tickLabels(zoomed);
  assert.equal(zoomedLabels[zoomedLabels.length - 1], '50%');
  assert.ok(!zoomedLabels.includes('100%'));
  assert.ok(svgTexts(zoomed.svg).includes('4,000'), svgTexts(zoomed.svg).join(' | '));
  assert.ok(!svgTexts(zoomed.svg).includes('8,000'), 'the upper half is off the scale');

  // The curve rises left to right, from the lowest hour to the highest.
  const path = full.svg.match(/<path d="([^"]*)"/)[1];
  const ys = [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(ys[0] > ys[ys.length - 1], 'lowest value at 0%');
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] <= ys[i - 1] + 1e-9, 'monotonic');

  // A filtered line: the footnote counts its kept hours, whatever the zoom.
  const kept = flat(5);
  for (let h = 0; h < H; h++) if (h % 2) kept[h] = NaN;
  const filtered = build([line({ values: kept })], {
    pane: 'duration',
    xWindow: [0, 25],
    hourFilter: 'Every other hour',
  });
  assert.deepEqual(footnotes(filtered), ['Hours shown: Every other hour (4,380 of 8,760 hours)']);
});

ok('a stacked figure draws bands in stack order and its legend top band first', () => {
  // Bottom band first, as the pane stacks them: the larger total at the base.
  const lines = [
    line({ facets: { subject: 'BASE_PATH' }, color: '#1f77b4' }, 300),
    line({ facets: { subject: 'MIDDLE_PATH' }, color: '#ff7f0e' }, 200),
    line({ facets: { subject: 'TOP_PATH' }, color: '#2ca02c' }, 100),
  ];
  const figure = build(lines, { pane: 'stacked' });
  assert.deepEqual(
    [0, 1, 2].map((row) => textOf(figure, `legend[${row}][0]`)),
    ['TOP_PATH', 'MIDDLE_PATH', 'BASE_PATH'],
  );
  assert.match(figure.caption, /^Stacked hourly Interface Power Flow/);
  assert.match(figure.fileStem, /_stacked$/);
  // The scale covers the whole stack and starts at zero.
  const labels = svgTexts(figure.svg);
  assert.ok(labels.includes('600') && labels.includes('0'), labels.join(' | '));
  // One fill per band, tinted, drawn before any edge.
  const fills = [...figure.svg.matchAll(/<path d="[^"]*Z" fill="(#[0-9a-f]{6})"/g)].map(
    (m) => m[1],
  );
  assert.equal(fills.length, 3);
  assert.ok(!fills.includes('#1f77b4'), 'a band is a tint of its line, not the line');
  assert.ok(
    figure.svg.indexOf('fill="none"') > figure.svg.lastIndexOf('Z" fill="'),
    'edges on top',
  );
  // Each band's top edge is its running total: 300, 500, 600.
  const edges = [...figure.svg.matchAll(/<path d="M[\d.]+ ([\d.]+)[^"]*" fill="none"/g)].map((m) =>
    Number(m[1]),
  );
  assert.equal(edges.length, 3);
  const [y300, y500, y600] = edges;
  assert.ok(y300 > y500 && y500 > y600, 'each total above the last');
  assert.ok(Math.abs((y300 - y500) / (y500 - y600) - 2) < 0.01, 'at their totals’ heights');
});

ok('a stacked figure’s thinning keeps every band total’s column extremes, at shared hours', () => {
  const a = Float32Array.from({ length: H }, (_, h) => 50 + 40 * Math.sin(h * 0.9));
  const b = Float32Array.from({ length: H }, (_, h) => 30 + 25 * Math.cos(h * 1.3));
  for (const gap of [700, 701, 5000]) {
    a[gap] = NaN;
    b[gap] = NaN;
  }
  b[3000] = NaN; // one line's missing hour adds nothing; the stack goes on
  const totals = runningTotals([a, b]);
  assert.equal(totals[1][3000], a[3000], 'the missing hour adds nothing');
  assert.ok(Number.isNaN(totals[0][700]) && Number.isNaN(totals[1][700]));

  const columns = 600;
  const runs = thinShared(totals, 0, H - 1, -0.5, H - 0.5, columns);
  assert.equal(runs.length, 3, 'two gaps, three runs');
  const kept = new Set(runs.flat());
  const columnOf = (h) => Math.min(columns - 1, Math.floor(((h + 0.5) / H) * columns));
  for (const total of totals) {
    const extremes = new Map();
    let stretch = 0;
    for (let h = 0; h < H; h++) {
      if (Number.isNaN(total[h])) {
        stretch++;
        continue;
      }
      const key = `${stretch}:${columnOf(h)}`;
      const seen = extremes.get(key) ?? { low: h, high: h };
      if (total[h] < total[seen.low]) seen.low = h;
      if (total[h] > total[seen.high]) seen.high = h;
      extremes.set(key, seen);
    }
    for (const { low, high } of extremes.values()) {
      assert.ok(kept.has(low) && kept.has(high), `band total extremes at ${low}/${high} kept`);
    }
  }
  assert.ok(kept.size < H / 3, `${kept.size} hours kept`);

  // Through the builder: both bands' edges are drawn at the same x values.
  const figure = build(
    [
      line({ values: a, facets: { subject: 'A_PATH' } }),
      line({ values: b, color: '#ff7f0e', facets: { subject: 'B_PATH' } }),
    ],
    { pane: 'stacked' },
  );
  const edges = [...figure.svg.matchAll(/<path d="([^"]*)" fill="none"/g)].map((m) =>
    [...m[1].matchAll(/[ML]([\d.]+) /g)].map((p) => p[1]).join(','),
  );
  assert.equal(edges.length, 6, 'three runs, two bands');
  assert.equal(edges[0], edges[3], 'the bands share their columns');
});

ok('a stacked figure footnotes its lines’ warnings, marked on the band they concern', () => {
  const caveat = 'SAMPLE_WARN: one unit in this group has no max cap.';
  const figure = build(
    [
      { ...line({ facets: { subject: 'BASE_PATH' } }, 300), warnings: [caveat] },
      line({ facets: { subject: 'TOP_PATH' }, color: '#ff7f0e' }, 100),
    ],
    { pane: 'stacked' },
  );
  assert.deepEqual(footnotes(figure), [`* ${caveat}`]);
  // The legend is top band first, and the mark follows its band.
  assert.equal(textOf(figure, 'legend[1][0]'), 'BASE_PATH');
  assert.equal(textOf(figure, 'legend[1][1]'), '*');
  assert.equal(textOf(figure, 'legend[0][1]'), '');
});

// ------------------------------------------------------------ 9. box

const quantiles = (base, outliers = 0) => ({
  n: 100,
  min: base - 40,
  lowerWhisker: outliers ? base - 20 : base - 40,
  p25: base - 10,
  median: base,
  p75: base + 10,
  upperWhisker: outliers ? base + 20 : base + 40,
  max: base + 40,
  outliers,
});

function boxFigure(over = {}) {
  const lines = over.lines ?? [
    line({ facets: { subject: 'NORTH_PATH' } }),
    line({ facets: { subject: 'SOUTH_PATH' }, color: '#ff7f0e' }),
  ];
  return build(lines, {
    pane: 'box',
    xWindow: [0, 1],
    boxes: {
      dimension: 'month',
      values: over.values ?? false,
      groups: over.groups ?? [
        {
          label: 'Jan',
          boxes: [
            { line: 0, quantiles: quantiles(100, 12) },
            { line: 1, quantiles: quantiles(300) },
          ],
        },
        {
          label: 'Feb',
          boxes: [
            { line: 0, quantiles: quantiles(120) },
            { line: 1, quantiles: quantiles(320) },
          ],
        },
      ],
    },
  });
}

ok('a box figure labels its categories and the dimension they are cut on', () => {
  const figure = boxFigure();
  assert.deepEqual(tickLabels(figure), ['Jan', 'Feb']);
  assert.equal(textOf(figure, 'axis.x'), 'Month');
  assert.match(figure.caption, /^Box plot of Interface Power Flow by month for NORTH_PATH/);
  assert.match(figure.fileStem, /_box$/);
  // Categories, not a scale: no vertical grid runs through the boxes.
  const verticalGrid = /<line x1="([\d.]+)" y1="[\d.]+" x2="\1" [^>]*stroke="#dddddd"/;
  assert.ok(verticalGrid.test(build([line()]).svg), 'a time figure has one');
  assert.ok(!verticalGrid.test(figure.svg));
  // A box per line under its own name (the pane's `case` cut) names no
  // dimension: the capture hands none.
  const perLine = build([line()], {
    pane: 'box',
    xWindow: [0, 1],
    boxes: {
      dimension: '',
      values: false,
      groups: [{ label: 'NORTH_PATH', boxes: [{ line: 0, quantiles: quantiles(100) }] }],
    },
  });
  assert.equal(textOf(perLine, 'axis.x'), undefined);
  assert.match(perLine.caption, /^Box plot of Interface Power Flow for NORTH_PATH/);
  // One box per line per category, filled with a tint of its line's colour.
  const boxes = [...figure.svg.matchAll(/<rect [^>]*stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.equal(boxes.filter((c) => c === '#1f77b4').length, 3, 'two boxes and a swatch');
  assert.equal(boxes.filter((c) => c === '#ff7f0e').length, 3);
  // Long labels wrap in their category rather than run into the next.
  const long = boxFigure({
    groups: [
      { label: 'A_VERY_LONG_CATEGORY_NAME_ONE', boxes: [{ line: 0, quantiles: quantiles(1) }] },
      { label: 'A_VERY_LONG_CATEGORY_NAME_TWO', boxes: [{ line: 1, quantiles: quantiles(2) }] },
      { label: 'A_VERY_LONG_CATEGORY_NAME_SIX', boxes: [{ line: 1, quantiles: quantiles(3) }] },
      { label: 'A_VERY_LONG_CATEGORY_NAME_TEN', boxes: [{ line: 0, quantiles: quantiles(4) }] },
    ],
  });
  const parts = tickLabels(long);
  assert.ok(parts.length > 4, parts.join(' | '));
  assert.ok(parts.join('').includes('A_VERY_LONG_CATEGORY_NAME_SIX'), 'nothing lost');
});

ok('a box figure counts its outliers as the pane marks them, and says how to read them', () => {
  const figure = boxFigure();
  const counts = [
    ...figure.svg.matchAll(/<text [^>]*font-size="6.5" [^>]*text-anchor="middle"[^>]*>([^<]*)</g),
  ].map((m) => m[1]);
  assert.deepEqual(counts, ['12'], 'one box has outliers');
  // A dot at each extreme beyond a whisker.
  assert.equal((figure.svg.match(/<circle [^>]*fill="#1f77b4"/g) ?? []).length, 2);
  assert.ok(
    footnotes(figure).some((note) => /1\.5 × IQR/.test(note) && /beyond its whiskers/.test(note)),
    footnotes(figure).join(' | '),
  );
  const none = boxFigure({
    groups: [{ label: 'Jan', boxes: [{ line: 0, quantiles: quantiles(100) }] }],
  });
  assert.ok(!none.svg.includes('<circle'));
  assert.ok(!footnotes(none).some((note) => /IQR/.test(note)), 'no outliers, no note');
});

ok('a box figure writes each box’s values only when the pane’s values box is ticked', () => {
  const values = (figure) =>
    [...figure.svg.matchAll(/<text (?![^>]*text-anchor)[^>]*font-size="6.5"[^>]*>([^<]*)</g)].map(
      (m) => m[1],
    );
  assert.deepEqual(values(boxFigure()), [], 'unticked: no numbers');
  const ticked = values(boxFigure({ values: true }));
  // Jan's first box: max, p75, median, p25, min, then its two whiskers.
  assert.deepEqual(ticked.slice(0, 7), ['140', '110', '100', '90', '60', '120', '80']);
  assert.ok(ticked.includes('300') && ticked.includes('320'), 'every box');
});

ok('a box figure has one legend row per box colour, placed like the line legend', () => {
  const figure = boxFigure({
    lines: [
      line({ facets: { subject: 'NORTH_PATH' } }),
      line({ facets: { subject: 'NORTH_PATH', caseLabel: 'Winter 2035' }, color: '#ff7f0e' }),
      line({ dashed: true, color: '#8a8f98', facets: { subject: 'PREVIEW_PATH' } }),
    ],
    groups: [
      {
        label: 'Jan',
        boxes: [
          { line: 0, quantiles: quantiles(100) },
          { line: 1, quantiles: quantiles(200) },
          { line: 2, quantiles: quantiles(300) },
        ],
      },
    ],
  });
  assert.deepEqual(legendCells(figure), ['Summer 2035', 'NORTH_PATH', 'Winter 2035', 'NORTH_PATH']);
  assert.match(textOf(figure, 'context'), /^Interface · Power Flow$/);
  assert.ok(!figure.svg.includes('#8a8f98'), 'the preview’s box is not drawn');
  // The swatch is a filled box, not a stroke.
  assert.equal(
    (figure.svg.match(/<line [^>]*stroke="#1f77b4" stroke-width="1.25"/g) ?? []).length,
    0,
  );
  assert.throws(() => build([line()], { pane: 'box', xWindow: [0, 1] }), /boxes/);
});

// ------------------------------------------------------------ 10. X-Y

function xyFigure(pair, over = {}) {
  return build(pair, { pane: 'xy', xWindow: [0, 1], xy: { fit: over.fit ?? false }, ...over });
}

const xyPair = () => {
  const xs = Float32Array.from({ length: H }, (_, h) => h % 10);
  const ys = Float32Array.from({ length: H }, (_, h) => 2 * (h % 10) + 5);
  return [
    line({ values: xs, facets: { subject: 'NORTH_PATH' } }),
    line({
      values: ys,
      color: '#ff7f0e',
      facets: { subject: 'ALDER (101)', kind: 'bus', variable: 'LMP', unit: '$/MWh' },
    }),
  ];
};
const saysAny = (figure, pattern) => figure.texts.some((entry) => pattern.test(entry.text));
/** Points drawn: the X-Y pane's opaque squares. */
const xyPoints = (figure) => (figure.svg.match(/<rect [^>]*fill="#adadad"\/>/g) ?? []).length;

ok('an X-Y figure titles each axis with its series’ full label, and a swap reverses them', () => {
  const [a, b] = xyPair();
  const figure = xyFigure([a, b]);
  assert.equal(textOf(figure, 'axis.x'), 'Summer 2035 · Interface · Power Flow (MW) · NORTH_PATH');
  assert.equal(textOf(figure, 'axis.y[0]'), 'Summer 2035 · Bus · LMP ($/MWh) · ALDER (101)');
  assert.ok(svgTexts(figure.svg).includes(textOf(figure, 'axis.x')));
  assert.deepEqual(legendCells(figure), [], 'no legend: the axes name the pair');
  assert.equal(textOf(figure, 'context'), undefined, 'the axis titles state every fact');
  assert.equal(textOf(figure, 'axis.y[1]'), undefined, 'one y axis, whatever the units');
  const swapped = xyFigure([b, a]);
  assert.equal(textOf(swapped, 'axis.x'), textOf(figure, 'axis.y[0]'));
  assert.equal(textOf(swapped, 'axis.y[0]'), textOf(figure, 'axis.x'));
  // A title longer than the plot is tall wraps rather than running off it.
  const long = xyFigure([a, b], { size: { width: 6.5, height: 2.5 } });
  const rotated = [...long.svg.matchAll(/<text [^>]*rotate\(-90[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(rotated.length > 1, rotated.join(' | '));
  assert.equal(rotated.join(' '), textOf(long, 'axis.y[0]'));
  assert.match(figure.fileStem, /_xy$/);
  assert.match(figure.caption, /^X-Y scatter of /);
});

ok('an X-Y figure draws the fit and its equation with R² only when the pane’s fit is on', () => {
  const fitLines = (figure) =>
    (figure.svg.match(/<line [^>]*stroke="#ff7f0e" stroke-width="1.25"\/>/g) ?? []).length;
  const off = xyFigure(xyPair());
  assert.equal(fitLines(off), 0);
  assert.ok(!saysAny(off, /R²/));
  const on = xyFigure(xyPair(), { fit: true });
  assert.equal(fitLines(on), 1, 'the fit line, in the Y series’ colour');
  assert.equal(textOf(on, 'context'), 'y = 2·x + 5, R² = 1.0000');
  assert.ok(svgTexts(on.svg).includes('y = 2·x + 5, R² = 1.0000'));
});

ok('an X-Y figure merges points on one output pixel and counts only hours both hold', () => {
  const figure = xyFigure(xyPair());
  assert.equal(xyPoints(figure), 10, '8,760 pairs on ten distinct points');
  const [a, b] = xyPair();
  const gappy = Float32Array.from(b.values);
  gappy.fill(NaN, 0, 760);
  const kept = xyFigure([a, { ...b, values: gappy }], { hourFilter: 'hours 761-8760' });
  assert.deepEqual(footnotes(kept), ['Hours shown: hours 761-8760 (8,000 of 8,760 hours)']);
});

ok('an X-Y figure leaves the preview out of the pair', () => {
  const [a, b] = xyPair();
  assert.throws(() => xyFigure([a, { ...b, dashed: true }]), /both series/);
});

// ------------------------------------------------------------ 11. heatmap

function heatmapFigure(lines, over = {}) {
  return build(lines, { pane: 'heatmap', xWindow: [0, 1], ...over });
}
/** Fill-only rectangles: the background, the cells and the colour bar. */
const fills = (svg) => [...svg.matchAll(/<rect [^>]*fill="(#[0-9a-f]{6})"\/>/g)].map((m) => m[1]);
const BAR_STEPS = 64;

ok('a heatmap figure draws 24 × 365 cells as rectangles, and its key in the context line', () => {
  const values = Float32Array.from({ length: H }, (_, h) => 10 + (h % 24));
  const figure = heatmapFigure([line({ values })]);
  assert.equal(fills(figure.svg).length, 1 + 24 * 365 + BAR_STEPS);
  assert.ok(!/<image/.test(figure.svg), 'vector, never a bitmap');
  assert.equal(
    textOf(figure, 'context'),
    'Case: Summer 2035 · Interface · Power Flow · NORTH_PATH',
  );
  assert.deepEqual(legendCells(figure), [], 'a colour bar, not a line legend');
  assert.equal(textOf(figure, 'axis.color'), 'Power Flow (MW)');
  assert.equal(textOf(figure, 'axis.y[0]'), 'Hour ending');
  assert.deepEqual(tickLabels(figure).slice(0, 3), ['Jan', 'Feb', 'Mar']);
  assert.match(figure.caption, /^Diurnal heatmap of Interface Power Flow for NORTH_PATH/);
  assert.match(figure.fileStem, /_heatmap$/);
  assert.deepEqual(footnotes(figure), [], 'every hour has a value');
});

ok(
  'a heatmap figure’s colour bar is diverging about zero or sequential, as the pane paints',
  () => {
    const spans = Float32Array.from({ length: H }, (_, h) => (h % 24) - 15);
    const diverging = heatmapFigure([line({ values: spans })]);
    // The pane's cool-warm ends, and its scale symmetric about zero.
    assert.ok(fills(diverging.svg).includes('#2166ac'), 'the most negative cell is blue');
    assert.ok(!fills(diverging.svg).includes('#440154'), 'no viridis');
    for (const label of ['−15', '0', '15']) {
      assert.ok(
        svgTexts(diverging.svg).includes(label),
        svgTexts(diverging.svg).slice(-6).join(' | '),
      );
    }
    const positive = Float32Array.from({ length: H }, (_, h) => 10 + (h % 24));
    const sequential = heatmapFigure([line({ values: positive })]);
    assert.ok(fills(sequential.svg).includes('#440154'), 'viridis from the lowest value');
    assert.ok(!fills(sequential.svg).includes('#2166ac'));
    for (const label of ['10', '22', '33']) {
      assert.ok(svgTexts(sequential.svg).includes(label), label);
    }
  },
);

ok('a heatmap figure paints filtered hours grey and says so, and names lines it leaves out', () => {
  const values = Float32Array.from({ length: H }, (_, h) => (h < 744 ? 50 + (h % 24) : NaN));
  const figure = heatmapFigure(
    [
      line({ values }),
      {
        ...line({ facets: { subject: 'SOUTH_PATH' } }),
        values: null,
        refusal: 'A heatmap paints one series.',
      },
    ],
    { hourFilter: 'Jan' },
  );
  assert.equal(fills(figure.svg).filter((fill) => fill === '#f0f0f0').length, H - 744);
  assert.deepEqual(footnotes(figure), [
    'Grey cells are hours with no value (filtered out or missing), not zero.',
    'Not drawn: SOUTH_PATH. A heatmap paints one series.',
    'Hours shown: Jan (744 of 8,760 hours)',
  ]);
});

// ------------------------------------------------------------ 12. bus kV

/** One invented bus drawn through the app's own resolve, with `kv` as the
 * BusList's BaseKV for it (null: no list, or a blank). */
function busDrawn(kv) {
  const bus = {
    cube: new Float32Array(H).fill(21),
    presence: new Uint8Array(1).fill(1),
    buses: Int32Array.from([90001]),
    names: ['SAMPLE_BUS_A'],
    tou: new Uint8Array(H),
    sourceColumns: [90001],
    year: 2035,
    quantity: 'LMP ($/MWh)',
  };
  const context = {
    filters: {
      months: null,
      daysOfMonth: null,
      hoursOfDay: null,
      daysOfWeek: null,
      seasons: null,
      tou: null,
    },
    caseLabel: () => 'Summer 2035',
    areaCases: () => [],
    interfaceRows: () => [],
    busRows: () => [
      { key: rowKeyOf('c1', 'bus'), caseId: 'c1', slotKey: 'bus', label: 'Summer 2035', data: bus },
    ],
    generatorRows: () => [],
    busNames: () => new Map([[90001, 'SAMPLE_BUS_A']]),
    busKv: () => kv,
    interfaceRange: () => ({}),
    lines: createSeriesPool(),
  };
  const ref = {
    caseId: 'c1',
    kind: 'bus',
    slotKey: 'bus',
    entity: 90001,
    variable: bus.quantity,
    unit: '$/MWh',
    axisIndex: 0,
  };
  const [drawn] = resolveDraws(context, [{ ref, color: '#1f77b4', dashed: false }]);
  return { ...drawn, values: drawn.values.slice() };
}

ok('a bus figure key reads `number name kV`, and states no kV the BusList does not', () => {
  const key = (kv) => textOf(build([busDrawn(kv)]), 'legend[0][0]');
  assert.equal(key(230), '90001 SAMPLE_BUS_A 230 kV');
  assert.equal(key(13.8), '90001 SAMPLE_BUS_A 13.8 kV');
  assert.equal(key(null), '90001 SAMPLE_BUS_A', 'no BusList, or a blank kV');
  assert.equal(key(0), '90001 SAMPLE_BUS_A', 'a kV of 0 is no voltage to state');
  // The app's own label is the one pins save, and never carries the kV.
  const drawn = busDrawn(230);
  assert.equal(drawn.facets.subject, 'SAMPLE_BUS_A (90001)');
  assert.ok(!/kV/.test(drawn.detail), drawn.detail);
});

let passed = 0;
for (const [name, fn] of checks) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}
console.log(`\n${passed} checks passed`);
