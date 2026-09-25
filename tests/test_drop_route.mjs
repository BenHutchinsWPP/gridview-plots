// tests/test_drop_route.mjs — where a classified file goes.
//
// `test_detect.mjs` proves what a dropped file IS. This proves where it GOES,
// which until now nothing did: both decisions lived inside a 300-line async
// function that needed a worker pool and two dialogs before a single line of
// them would run, so the two `never` guards their own comments call
// load-bearing were the only thing standing behind a misroute.
//
// The verdicts here are hand-built objects rather than real classifications.
// That is deliberate: this suite is about the ROUTE, and building verdicts by
// hand is what lets it cover a shape combination the detector may not emit
// today and an unknown kind it cannot emit at all.
//
// Run: node test_drop_route.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { routeDrop, splitPlans } = await import('../src/app/drop-route.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** One classified drop. The payload is a bare string so a bucket's contents
 *  read as the names that landed in it. */
const file = (name, verdict) => ({ name, item: name, verdict });
const verdict = (kind, extra = {}) => ({ kind, confidence: 'high', reason: `${kind}`, ...extra });

const names = (entries) => entries.map((entry) => entry.item);
const actions = (entries) => entries.map((entry) => entry.action);

// --- 1. every verdict kind reaches its destination -------------------------

check('a bundle becomes an auxiliary bundle step', () => {
  const route = routeDrop([file('study.gvmb', verdict('bundle'))]);
  assert.deepEqual(route.auxiliary, [{ action: 'bundle', item: 'study.gvmb' }]);
  assert.deepEqual(route.tables, []);
  assert.deepEqual(route.limits, []);
});

check('a groupings mapping becomes an auxiliary groupings step', () => {
  const route = routeDrop([file('Groupings.csv', verdict('groupings'))]);
  assert.deepEqual(route.auxiliary, [{ action: 'groupings', item: 'Groupings.csv' }]);
  assert.deepEqual(route.tables, []);
});

check('an interface limit file goes to limits, not tables', () => {
  const route = routeDrop([file('PathLimits.csv', verdict('interfacelimit'))]);
  assert.deepEqual(names(route.limits), ['PathLimits.csv']);
  assert.deepEqual(route.tables, []);
  assert.deepEqual(route.auxiliary, []);
});

check("an unrecognized file carries detect.ts's own reason, verbatim, and the file", () => {
  const reason = 'mystery.csv: matches no known export (header read 3 columns).';
  const route = routeDrop([
    file('mystery.csv', { kind: 'unrecognized', confidence: 'low', reason }),
  ]);
  // The file travels with its reason, so the root can log it refused.
  assert.deepEqual(route.auxiliary, [{ action: 'message', item: 'mystery.csv', text: reason }]);
  assert.deepEqual(route.tables, []);
});

check('a kind this build has no route for is reported as a bug, not dropped', () => {
  // Reachable only from a verdict a NEWER build emitted. The `never` in the
  // router makes adding a kind a compile error there; this is what the user
  // sees if one arrives at runtime anyway.
  const route = routeDrop([file('future.csv', verdict('sometime-kind'))]);
  assert.equal(route.auxiliary.length, 1);
  assert.equal(route.auxiliary[0].action, 'message');
  assert.equal(route.auxiliary[0].item, 'future.csv');
  assert.match(route.auxiliary[0].text, /^future\.csv: classified as "sometime-kind"/);
  assert.match(route.auxiliary[0].text, /This is a bug/);
  assert.deepEqual(route.tables, []);
  assert.deepEqual(route.limits, []);
});

// --- 2. shape R is a reference list, not a table ---------------------------

check('a shape-R file of every table kind goes to auxiliary as a lookup', () => {
  for (const kind of ['area', 'interface', 'bus', 'generator']) {
    const route = routeDrop([file(`${kind}list.csv`, verdict(kind, { shape: 'R' }))]);
    assert.deepEqual(
      route.auxiliary,
      [{ action: 'lookup', item: `${kind}list.csv` }],
      `${kind} shape R`,
    );
    assert.deepEqual(route.tables, [], `${kind} shape R must not reach the dialog`);
  }
});

check('shape W and shape L both go to tables, for every table kind', () => {
  for (const kind of ['area', 'interface', 'bus', 'generator']) {
    for (const shape of ['W', 'L']) {
      const route = routeDrop([file(`${kind}-${shape}.csv`, verdict(kind, { shape }))]);
      assert.deepEqual(names(route.tables), [`${kind}-${shape}.csv`], `${kind} shape ${shape}`);
      assert.deepEqual(route.auxiliary, [], `${kind} shape ${shape}`);
    }
  }
});

check('a table kind with NO shape still goes to tables', () => {
  const route = routeDrop([file('shapeless.csv', verdict('interface'))]);
  assert.deepEqual(names(route.tables), ['shapeless.csv']);
});

// --- 3. drop order survives ------------------------------------------------
//
// The order these are emitted in is the order the user reads them. An
// unrecognized file dropped ahead of a bundle has always had its reason
// printed ahead of the restore's account; sorting the messages into a channel
// of their own would move every one of them to the front.

check('auxiliary steps stay in drop order, messages interleaved', () => {
  const route = routeDrop([
    file('a.csv', { kind: 'unrecognized', confidence: 'low', reason: 'a.csv: unknown' }),
    file('study.gvmb', verdict('bundle')),
    file('BusList.csv', verdict('bus', { shape: 'R' })),
    file('b.csv', { kind: 'unrecognized', confidence: 'low', reason: 'b.csv: unknown' }),
  ]);
  assert.deepEqual(actions(route.auxiliary), ['message', 'bundle', 'lookup', 'message']);
  assert.equal(route.auxiliary[0].text, 'a.csv: unknown');
  assert.equal(route.auxiliary[3].text, 'b.csv: unknown');
});

check('a mixed drop fills all three buckets at once', () => {
  const route = routeDrop([
    file('flows.csv', verdict('interface', { shape: 'W' })),
    file('PathLimits.csv', verdict('interfacelimit')),
    file('GeneratorList.csv', verdict('generator', { shape: 'R' })),
    file('areas.csv', verdict('area', { shape: 'L' })),
  ]);
  assert.deepEqual(names(route.tables), ['flows.csv', 'areas.csv']);
  assert.deepEqual(names(route.limits), ['PathLimits.csv']);
  assert.deepEqual(actions(route.auxiliary), ['lookup']);
});

check('an empty drop routes to three empty buckets', () => {
  const route = routeDrop([]);
  assert.deepEqual(route.tables, []);
  assert.deepEqual(route.limits, []);
  assert.deepEqual(route.auxiliary, []);
});

// --- 4. splitPlans: seven buckets ------------------------------------------

const plan = (name, kind, shape) => ({ name, kind, shape, drop: name });

check('the seven (kind, shape) combinations land in seven distinct buckets', () => {
  const split = splitPlans([
    plan('area-w.csv', 'area', 'W'),
    plan('area-l.csv', 'area', 'L'),
    plan('bus-w.csv', 'bus', 'W'),
    plan('bus-l.csv', 'bus', 'L'),
    plan('gen-w.csv', 'generator', 'W'),
    plan('gen-l.csv', 'generator', 'L'),
    plan('flows.csv', 'interface', 'W'),
  ]);
  assert.deepEqual(split.wide.get('area'), ['area-w.csv']);
  assert.deepEqual(split.long.get('area'), ['area-l.csv']);
  assert.deepEqual(split.wide.get('bus'), ['bus-w.csv']);
  assert.deepEqual(split.long.get('bus'), ['bus-l.csv']);
  assert.deepEqual(split.wide.get('generator'), ['gen-w.csv']);
  assert.deepEqual(split.long.get('generator'), ['gen-l.csv']);
  assert.deepEqual(split.wide.get('interface'), ['flows.csv']);
  assert.deepEqual(split.long.get('interface'), undefined);
  assert.deepEqual(split.bugs, []);
});

check('a kind with no drops is absent, never an empty array', () => {
  const split = splitPlans([plan('flows.csv', 'interface', 'W')]);
  assert.equal(split.wide.has('area'), false);
  assert.equal(split.long.has('area'), false);
  assert.equal(split.long.has('interface'), false);
});

check('drops of one kind keep their plan order', () => {
  const split = splitPlans([
    plan('one.csv', 'bus', 'W'),
    plan('two.csv', 'bus', 'W'),
    plan('three.csv', 'bus', 'W'),
  ]);
  assert.deepEqual(split.wide.get('bus'), ['one.csv', 'two.csv', 'three.csv']);
});

// --- 5. the shapeless fallback is per kind, and is not tidy ----------------
//
// Area falls back to LONG because the long parser was Area's original and only
// reader; Bus and Generator fall back to WIDE because theirs was. Making these
// agree would silently re-point one kind's shapeless plans at a parser that has
// never read them, which is why it is asserted rather than left to read like an
// oversight.

check('a shapeless AREA plan falls back to the long reader', () => {
  const split = splitPlans([plan('areas.csv', 'area', undefined)]);
  assert.deepEqual(split.long.get('area'), ['areas.csv']);
  assert.equal(split.wide.has('area'), false);
});

check('a shapeless BUS or GENERATOR plan falls back to the wide reader', () => {
  const split = splitPlans([
    plan('bus.csv', 'bus', undefined),
    plan('gen.csv', 'generator', undefined),
  ]);
  assert.deepEqual(split.wide.get('bus'), ['bus.csv']);
  assert.deepEqual(split.wide.get('generator'), ['gen.csv']);
  assert.equal(split.long.has('bus'), false);
  assert.equal(split.long.has('generator'), false);
});

check('INTERFACE goes wide whatever shape the plan claims', () => {
  // Interface has only a wide reader. Consulting a field nothing sets is how a
  // default starts looking like a decision, so shape L must not divert it.
  const split = splitPlans([
    plan('a.csv', 'interface', 'L'),
    plan('b.csv', 'interface', undefined),
  ]);
  assert.deepEqual(split.wide.get('interface'), ['a.csv', 'b.csv']);
  assert.equal(split.long.has('interface'), false);
});

// --- 6. an unknown kind is a bug message, not a bucket and not a throw -----

check('a plan naming a kind with no ingest is reported, and the rest still split', () => {
  const split = splitPlans([
    plan('good.csv', 'bus', 'W'),
    plan('future.csv', 'sometime-kind', 'W'),
    plan('also-good.csv', 'area', 'L'),
  ]);
  assert.deepEqual(split.wide.get('bus'), ['good.csv']);
  assert.deepEqual(split.long.get('area'), ['also-good.csv']);
  assert.equal(split.bugs.length, 1);
  assert.match(split.bugs[0], /^future\.csv: confirmed as "sometime-kind"/);
  assert.match(split.bugs[0], /never parsed/);
  // It reached no bucket at all -- the whole point of naming it.
  for (const map of [split.wide, split.long]) {
    for (const bucket of map.values()) assert.equal(bucket.includes('future.csv'), false);
  }
});

check('no plans splits to two empty maps', () => {
  const split = splitPlans([]);
  assert.equal(split.wide.size, 0);
  assert.equal(split.long.size, 0);
  assert.deepEqual(split.bugs, []);
});

console.log(`\n${passed} checks passed`);
