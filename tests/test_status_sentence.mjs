// tests/test_status_sentence.mjs — the status bar's sentence
// (src/ui/status-sentence.ts). Panes are screenshotted into decks with it, so
// it must state every active hour filter and nothing that is not one: an
// unfiltered hour, season or TOU says nothing, a filtered one says which.

import './test_loader.mjs';
import assert from 'node:assert/strict';

const { statusSentence, summarise } = await import('../src/ui/status-sentence.ts');
const { rangeLabel } = await import('../src/model/date-range.ts');

let checks = 0;
function check(what, fn) {
  fn();
  checks++;
  console.log(`ok - ${what}`);
}

const NO_FILTERS = Object.freeze({
  dates: null,
  hoursOfDay: null,
  daysOfWeek: null,
  seasons: null,
  tou: null,
});
const view = (filters, cases = ['c1']) => ({ filters: { ...NO_FILTERS, ...filters }, cases });
const n = (x) => x.toLocaleString();
const parts = (sentence) => sentence.split(' · ');

check('unfiltered: kept hours, all dates, all days, the case count, nothing else', () => {
  assert.equal(
    statusSentence(view({}), 8760),
    `${n(8760)} of ${n(8760)} h · all dates · all days · 1 case`,
  );
});

check('the case count is pluralised', () => {
  assert.equal(parts(statusSentence(view({}, []), 8760)).at(-1), '0 cases');
  assert.equal(parts(statusSentence(view({}, ['a', 'b']), 8760)).at(-1), '2 cases');
});

check('the kept hours are the figure given, not recomputed', () => {
  assert.equal(parts(statusSentence(view({}), 1234))[0], `${n(1234)} of ${n(8760)} h`);
});

check('a date set names its runs, at most four and then a count', () => {
  const two = [
    { start: 10, end: 12 },
    { start: 40, end: 40 },
  ];
  assert.equal(
    parts(statusSentence(view({ dates: two }), 96))[1],
    `${rangeLabel(two[0])}, ${rangeLabel(two[1])}`,
  );
  const six = Array.from({ length: 6 }, (_, i) => ({ start: i * 10, end: i * 10 + 2 }));
  const said = parts(statusSentence(view({ dates: six }), 96))[1];
  assert.ok(said.startsWith(six.slice(0, 4).map(rangeLabel).join(', ')), said);
  assert.ok(said.endsWith(' and 2 more runs'), said);
});

check('days of week collapse into runs', () => {
  assert.equal(
    parts(statusSentence(view({ daysOfWeek: new Set([0, 1, 2, 3, 4]) }), 100))[2],
    'Mon–Fri',
  );
  assert.equal(
    parts(statusSentence(view({ daysOfWeek: new Set([5, 6, 0]) }), 100))[2],
    'Mon, Sat–Sun',
  );
});

check('hours are hour-ending and follow the days', () => {
  const said = parts(statusSentence(view({ hoursOfDay: new Set([7, 8, 9, 10, 18]) }), 100));
  assert.equal(said[3], 'HE 7–10, 18');
  assert.equal(said.length, 5, said.join(' · '));
});

check('seasons and TOU are named only when filtered, in that order', () => {
  const said = parts(
    statusSentence(
      view({ seasons: new Set(['Summer', 'Winter']), tou: new Set(['OnPeak']) }, ['a', 'b']),
      100,
    ),
  );
  assert.deepEqual(said.slice(3), ['Winter, Summer', 'OnPeak', '2 cases']);
});

check('a full selection reads as no constraint, an empty one as nothing', () => {
  assert.equal(summarise(new Set([1, 2, 3]), [1, 2, 3], String, 'all'), 'all');
  assert.equal(summarise(new Set(), [1, 2, 3], String, 'all'), 'nothing');
  assert.equal(summarise(null, [1, 2, 3], String, 'all'), 'all');
  assert.equal(summarise(new Set([1, 2, 3, 7]), [1, 2, 3, 4, 5, 6, 7], String, 'all'), '1–3, 7');
});

console.log(`\n${checks} status sentence checks passed`);
