// tests/test_drop_routing.mjs — every kind `src/detect.ts` can return has a
// route in `src/app/drop-route.ts`, and every routed action has a sink in
// main.ts. A text scan (main.ts cannot load in Node). An unrouted kind makes
// a dropped file do NOTHING, silently; the `never` default makes that a
// compile error, and this names the kind in plain words and catches the
// guard being deleted. Behaviour is tested in test_drop_route.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

// ---------------------------------------------------------------- the kinds

const detect = read('src/detect.ts');
const union = /export type DetectKind =([^;]+);/.exec(detect);
assert.ok(union, 'src/detect.ts must declare `export type DetectKind = ...;`');

const kinds = [...union[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
assert.ok(kinds.length >= 5, `DetectKind should list several kinds, found ${kinds.join(', ')}`);
ok(`DetectKind declares ${kinds.length} kinds: ${kinds.join(', ')}`);

// ---------------------------------------------------------------- the switch

const router = read('src/app/drop-route.ts');
const start = router.indexOf('switch (verdict.kind)');
assert.ok(start > 0, 'src/app/drop-route.ts must switch on `verdict.kind` when routing a file');

// From the switch to the end of `routeDrop`, bounded by the return that closes
// it. Matched on the returned shape rather than a brace count, which no static
// scan gets right for long.
const end = router.indexOf('return { tables, limits, auxiliary };', start);
assert.ok(end > start, 'the drop switch must still be closed by `routeDrop`’s own return');
const block = router.slice(start, end);

const missing = kinds.filter((kind) => !block.includes(`case '${kind}':`));
assert.deepEqual(
  missing,
  [],
  `src/detect.ts can return ${missing.map((k) => `"${k}"`).join(', ')}, but routeDrop ` +
    `has no case for ${missing.length === 1 ? 'it' : 'them'}. A file classified as a kind ` +
    `with no case falls through every branch and the drop returns without rendering -- the file ` +
    `does nothing at all. Route it, or say why it is refused.`,
);
ok('every DetectKind has a case in the drop switch');

// ---------------------------------------------------------------- the guard

assert.match(
  block,
  /default: \{/,
  'the drop switch must keep its `default:` branch -- it is what turns the next unrouted kind ' +
    'into a compile error instead of a silent no-op.',
);
assert.match(
  block,
  /const \w+: never = verdict\.kind;/,
  'the `default:` branch must assign `verdict.kind` to a `never`. Without that assignment the ' +
    'branch is just a runtime message, and adding a kind to DetectKind compiles clean again.',
);
ok('the default branch still pins the union to `never`, so the next kind is a compile error');

// --------------------------------------------------- the auxiliary apply loop
//
// Every auxiliary action needs a branch in main.ts's apply loop.

const main = read('src/main.ts');
const applyStart = main.indexOf('for (const step of route.auxiliary)');
assert.ok(applyStart > 0, 'src/main.ts must apply the auxiliary steps routeDrop returned');
// Guard the bound: an unmatched sentinel (-1) would widen the slice to the
// rest of main.ts and pass vacuously.
const applyEnd = main.indexOf('\n    }', applyStart);
assert.ok(applyEnd > applyStart, 'the auxiliary apply loop must be closed at its own indentation');
const applyBlock = main.slice(applyStart, applyEnd);
for (const action of ['message', 'bundle', 'groupings', 'lookup']) {
  assert.ok(
    applyBlock.includes(`case '${action}':`),
    `routeDrop can emit an auxiliary '${action}' step, but src/main.ts's apply loop has no ` +
      `branch for it -- the step is produced and then matched by nothing.`,
  );
}
assert.match(
  applyBlock,
  /const \w+: never = step;/,
  'the apply loop must pin its step union to `never`, or the next auxiliary action is a silent ' +
    'no-op rather than a compile error.',
);
ok('every auxiliary action the router emits has an apply branch, pinned to `never`');

// ---------------------------------------------------------------- the sinks

// A kind that reaches the table list must also reach an ingest. The second half
// of the same bug would be routing a kind into the dialog and then dropping it
// at the plan split, which is just as silent.
const split = router.indexOf('switch (plan.kind)');
assert.ok(split > 0, "src/app/drop-route.ts must split the dialog's plans into per-kind drops");
const splitEnd = router.indexOf('return { wide, long, bugs };', split);
assert.ok(splitEnd > split, '`splitPlans` must still be closed by its own return');
const splitBlock = router.slice(split, splitEnd);

// `interfacelimit` reaches the dialog but is not a table; its own sink is
// asserted below.
const importable = kinds.filter(
  (kind) => !['groupings', 'bundle', 'unrecognized', 'interfacelimit'].includes(kind),
);
const unrouted = importable.filter((kind) => !splitBlock.includes(`'${kind}'`));
assert.deepEqual(
  unrouted,
  [],
  `${unrouted.map((k) => `"${k}"`).join(', ')} reach(es) the Import Dialog but ${
    unrouted.length === 1 ? 'is' : 'are'
  } not named in the plan split, so the confirmed file is never ingested.`,
);
ok('every importable kind is named in the plan split that feeds the per-kind ingests');

// The plan split has a `never` of its own, and it is the one that caught a bus
// file going missing between the dialog and the ingest.
assert.match(
  splitBlock,
  /const \w+: never = plan\.kind;/,
  'the plan split must pin `plan.kind` to a `never`, or a kind confirmed in the dialog can be ' +
    'accepted and then never parsed.',
);
ok('the plan split pins its kind union to `never` as well');

// The limits file's own sink. Same bug, second door: routed onto the dialog,
// confirmed by the user, and then never installed -- which looks exactly like
// a limits file that matched no interface.
assert.match(
  router,
  /case 'interfacelimit':/,
  "a limits file must be routed off the drop switch into the Import Dialog's own list",
);
assert.match(
  main,
  /applyLimitDrops\(/,
  'the limits the dialog returned must be installed by `applyLimitDrops`, or a confirmed limits ' +
    'file is read and thrown away.',
);
assert.ok(
  main.indexOf('applyLimitDrops(') > main.indexOf('interfaceDrops.length > 0'),
  'limits must be installed AFTER the ingests: a limits file pinned to a Case is resolved by ' +
    'name, and that Case may not exist until its own export has landed.',
);
ok('a limits file reaches the dialog and is installed after the ingests it depends on');

// ------------------------------------------- shape L for bus and generator
//
// A long bus or generator export must reach the LONG ingest, split by shape
// in `splitPlans` (the dialog decides the final kind).
for (const kind of ['bus', 'generator']) {
  assert.match(
    splitBlock,
    new RegExp(`plan\\.shape === 'L'[\\s\\S]{0,80}'${kind}'`, 'i'),
    `a long ${kind} export must be split off to its own batch: without a shape test, ` +
      `case '${kind}' hands it to the wide adapter.`,
  );
}
ok('long bus and generator exports are split by shape, not handed to the wide adapter');

// Area's shapeless fallback is LONG (its original reader); unifying the
// fallbacks would re-point plans at a parser that never read them.
assert.match(
  splitBlock,
  /plan\.shape === 'W'[\s\S]{0,80}'area'/,
  "Area's split must test for shape W, falling back to the long reader -- the opposite of the " +
    'bus and generator fallback, and not an oversight.',
);
ok('a shapeless Area plan still falls back to the long reader');

// And the routing loop must NOT still refuse them: the refusal that stood
// between "recognised" and "readable" is now the thing that would be wrong.
assert.doesNotMatch(
  block,
  /cannot read yet/,
  'the long bus/generator refusal is obsolete now that the long reader is configured with a ' +
    'key-column count -- it would refuse files that load.',
);
ok('long bus and generator exports are routed, not refused');

console.log(`\n${checks} checks passed.`);
