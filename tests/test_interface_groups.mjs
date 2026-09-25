// tests/test_interface_groups.mjs — the interface group map and member
// DIRECTIONS.
//
//   * A member is a name AND a direction.
//   * Direction cells match a STATED list; anything else refuses the row.
//   * A blank cell, or no direction column, means forward.
//   * One name cannot hold both directions in one group.
//   * The bundle carries directions and refuses an unknown one.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  INTERFACE_GROUP_BY,
  EDITOR_CSV_HEADERS,
  EDITOR_MAPPING,
  adoptInterfaceGroups,
  chosenInterfaceGroupMapping,
  clearInterfaceGroups,
  coefficientsOfGroup,
  directionOf,
  directionSpellings,
  exportInterfaceGroups,
  hasInterfaceGroups,
  interfaceGroupNames,
  loadInterfaceGroups,
  membersOfGroup,
  planInterfaceGroups,
  readSavedInterfaceGroups,
  setInterfaceMembership,
  signOf,
  summarizeInterfaceGroups,
} = await import('../src/tables/interface/groups.ts');

let checks = 0;
function ok(what) {
  checks++;
  console.log(`ok - ${what}`);
}

const MAPPING = { nameColumn: 'Name', groupColumn: 'Grouping', directionColumn: 'Direction' };
const NO_DIRECTION = { nameColumn: 'Name', groupColumn: 'Grouping' };
const AXIS = ['SYN-P01', 'SYN-P02', 'SYN-P03'];

// ------------------------------------------------------------- the cell

{
  clearInterfaceGroups();
  assert.equal(hasInterfaceGroups(), false);
  assert.equal(INTERFACE_GROUP_BY, 'Interface Group');
  assert.equal(signOf('forward'), 1);
  assert.equal(signOf('reversed'), -1);

  for (const cell of ['-1', 'reverse', 'Reversed', ' REV ', 'r', 'negative']) {
    assert.equal(directionOf(cell), 'reversed', cell);
  }
  for (const cell of ['', '  ', '1', '+1', 'forward', 'FWD', 'f', 'positive']) {
    assert.equal(directionOf(cell), 'forward', cell);
  }
  // Not a guess. Every one of these is a plausible cell somebody could write,
  // and reading any of them as a direction would silently flip a sign.
  for (const cell of ['0', 'yes', 'no', 'true', 'N->S', '-2', 'backward']) {
    assert.equal(directionOf(cell), undefined, cell);
  }
  // The pane shows these rather than leaving them to be found by refusal.
  const spellings = directionSpellings();
  assert.ok(spellings.forward.includes('forward'));
  assert.ok(spellings.reversed.includes('reversed'));
  assert.ok(!spellings.forward.includes(''), 'the blank is a default, not a spelling to print');
  ok('a direction cell is read from a stated list; anything else states no direction');
}

// ------------------------------------------------------------- ingest

{
  clearInterfaceGroups();
  const load = loadInterfaceGroups(
    [
      'Name,Grouping,Direction',
      'SYN-P01,West SYN,forward',
      'SYN-P02,West SYN,-1',
      'SYN-P03,West SYN,',
      'SYN-P01,East SYN,reversed',
      'SYN-P99,West SYN,forward',
      ',West SYN,forward',
      'SYN-P02,,forward',
      'SYN-P03,East SYN,sideways',
    ].join('\n'),
    MAPPING,
    AXIS,
  );

  assert.deepEqual(interfaceGroupNames(), ['West SYN', 'East SYN']);
  assert.deepEqual(membersOfGroup('West SYN'), [
    { name: 'SYN-P01', direction: 'forward' },
    { name: 'SYN-P02', direction: 'reversed' },
    { name: 'SYN-P03', direction: 'forward' },
    { name: 'SYN-P99', direction: 'forward' },
  ]);
  ok('a blank direction cell is forward, and -1 is reversed');

  // The same path counts forward in one boundary and reversed in another,
  // which is the case a per-name direction could not express.
  assert.deepEqual(membersOfGroup('East SYN'), [{ name: 'SYN-P01', direction: 'reversed' }]);
  ok('one path may count forward in one group and reversed in another');

  assert.deepEqual(
    coefficientsOfGroup('West SYN'),
    new Map([
      ['SYN-P01', 1],
      ['SYN-P02', -1],
      ['SYN-P03', 1],
      ['SYN-P99', 1],
    ]),
  );
  ok('the reduce takes the map as name -> +1 or -1');

  const reasons = load.refusals.map((entry) => entry.reason).join(' ');
  assert.equal(
    load.refusals.reduce((sum, entry) => sum + entry.rows, 0),
    3,
  );
  assert.match(reasons, /blank interface cell/);
  assert.match(reasons, /blank group cell/);
  assert.match(reasons, /"sideways" is not a direction/);
  assert.match(reasons, /a blank cell is forward/, 'and the refusal says what to write instead');
  ok('a row naming no direction is refused by quoting the cell, never read as forward');

  const summary = summarizeInterfaceGroups(AXIS);
  assert.equal(summary.groups, 2);
  assert.equal(summary.mapped, 3, 'P01, P02 and P03');
  assert.deepEqual(summary.offAxis, ['SYN-P99']);
  assert.equal(summary.reversed, 2, 'P02 in West and P01 in East');
  assert.equal(load.memberships, 5, 'five (path, group) pairs over four distinct paths');
  ok('the summary counts reversed members: a boundary cannot be read without that figure');
}

{
  clearInterfaceGroups();
  // No direction column at all: every member forward, stated rather than
  // inferred from anything in the file.
  loadInterfaceGroups(
    ['Name,Grouping', 'SYN-P01,West SYN', 'SYN-P02,West SYN'].join('\n'),
    NO_DIRECTION,
    AXIS,
  );
  assert.deepEqual(membersOfGroup('West SYN'), [
    { name: 'SYN-P01', direction: 'forward' },
    { name: 'SYN-P02', direction: 'forward' },
  ]);
  assert.equal(summarizeInterfaceGroups(AXIS).reversed, 0);
  ok('a file with no direction column loads every member forward');
}

{
  clearInterfaceGroups();
  // Repeated with the SAME direction is idempotent, as every membership row
  // is. Repeated with the OPPOSITE direction is the file contradicting
  // itself, and neither row is taken over the other.
  const plan = planInterfaceGroups(
    [
      'Name,Grouping,Direction',
      'SYN-P01,West SYN,forward',
      'SYN-P01,West SYN,forward',
      'SYN-P02,West SYN,forward',
      'SYN-P02,West SYN,reversed',
    ].join('\n'),
    MAPPING,
  );
  assert.deepEqual(plan.members.get('West SYN'), [
    { name: 'SYN-P01', direction: 'forward' },
    { name: 'SYN-P02', direction: 'forward' },
  ]);
  assert.equal(plan.memberships, 2, 'the repeat added nothing');
  assert.match(
    plan.refusals.map((entry) => entry.reason).join(' '),
    /both directions/,
    'and the contradiction is counted, not resolved',
  );
  ok('a repeated member is idempotent; the same member both ways round refuses');
}

{
  clearInterfaceGroups();
  assert.throws(
    () => planInterfaceGroups('Name,Grouping\nSYN-P01,West SYN', MAPPING),
    /does not carry/,
    'the mapping names a direction column this file lacks',
  );
  assert.throws(
    () => planInterfaceGroups('Name,Grouping,Direction\nSYN-P01,West SYN,sideways', MAPPING),
    /produced no group membership/,
  );
  assert.equal(hasInterfaceGroups(), false, 'and nothing moved');
  ok('a refused file leaves the loaded map exactly as it was');
}

// ------------------------------------------------------------- the editor

{
  clearInterfaceGroups();
  setInterfaceMembership(
    new Map([
      [
        'Hand SYN',
        [
          { name: 'SYN-P01', direction: 'forward' },
          { name: 'SYN-P02', direction: 'reversed' },
        ],
      ],
    ]),
  );
  assert.equal(membersOfGroup('Hand SYN')[1].direction, 'reversed');
  // Hand-built groups still record a provenance, and it names the direction
  // column -- a file this editor saves must reload as the same boundary.
  assert.equal(chosenInterfaceGroupMapping().directionColumn, 'Direction');
  assert.throws(() => setInterfaceMembership(new Map()), /leaves no groups/);
  assert.equal(interfaceGroupNames().length, 1, 'and the refusal changed nothing');
  ok('the editor may replace the map with directions, and cannot empty it');

  // A caller cannot reach in and flip a direction through the array it was
  // handed: the map answers with copies.
  const handed = membersOfGroup('Hand SYN');
  handed[0].direction = 'reversed';
  assert.equal(membersOfGroup('Hand SYN')[0].direction, 'forward');
  ok('membersOfGroup hands out copies, so a boundary cannot be redefined by accident');
}

// ------------------------------------------------------------- the bundle

{
  clearInterfaceGroups();
  loadInterfaceGroups(
    ['Name,Grouping,Direction', 'SYN-P01,West SYN,forward', 'SYN-P02,West SYN,reversed'].join('\n'),
    MAPPING,
    AXIS,
  );
  const saved = exportInterfaceGroups();
  assert.deepEqual(saved.mapping, MAPPING);
  assert.deepEqual(saved.members, [
    [
      'West SYN',
      [
        { name: 'SYN-P01', direction: 'forward' },
        { name: 'SYN-P02', direction: 'reversed' },
      ],
    ],
  ]);

  const roundTripped = readSavedInterfaceGroups(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(roundTripped, saved);

  clearInterfaceGroups();
  assert.equal(exportInterfaceGroups(), null, 'a session with no map writes no field');
  adoptInterfaceGroups(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(
    coefficientsOfGroup('West SYN'),
    new Map([
      ['SYN-P01', 1],
      ['SYN-P02', -1],
    ]),
  );
  ok('the map round-trips through the manifest shape with its directions intact');

  assert.throws(() => readSavedInterfaceGroups(null), /not an object/);
  assert.throws(() => readSavedInterfaceGroups({ ...saved, members: 'West SYN' }), /not a list/);
  assert.throws(
    () => readSavedInterfaceGroups({ ...saved, members: [['West SYN', ['SYN-P01']]] }),
    /not an object/,
    'a member saved as a bare name carries no direction and is refused',
  );
  // The one that matters: defaulting an unknown direction to forward would
  // turn a saved difference back into a sum, in silence.
  assert.throws(
    () =>
      readSavedInterfaceGroups({
        ...saved,
        members: [['West SYN', [{ name: 'SYN-P01', direction: 'sideways' }]]],
      }),
    /neither forward nor reversed/,
  );
  ok('a saved direction that is neither word is refused rather than defaulted');
}

{
  const { buildManifest } = await import('../src/storage/envelope.ts');
  clearInterfaceGroups();
  const { manifest: without } = buildManifest([], {});
  assert.equal(without.interfaceGroups, undefined);

  loadInterfaceGroups('Name,Grouping,Direction\nSYN-P01,West SYN,reversed', MAPPING, AXIS);
  const { manifest: with_ } = buildManifest([], { interfaceGroups: exportInterfaceGroups() });
  assert.deepEqual(with_.interfaceGroups.members, [
    ['West SYN', [{ name: 'SYN-P01', direction: 'reversed' }]],
  ]);
  assert.equal(with_.version, without.version, 'and the version integer does not move');
  ok('the bundle carries the map only when there is one, at the same manifest version');
  clearInterfaceGroups();
}

// -- InterfaceGroups.csv, as the editor saves it, dropped back on the window

{
  const { MembershipModel } = await import('../src/ui/membership-model.ts');
  const { classify } = await import('../src/detect.ts');
  const model = new MembershipModel(
    new Map([['SAMPLE_BOUNDARY', ['SAMPLE_P01', 'SAMPLE_P03']]]),
    new Set(),
    [['SAMPLE_BOUNDARY', 'SAMPLE_P03']],
  );
  // The direction cell as the editor's mark writes it.
  // InterfaceGroups.csv's header, as the file carries it.
  const saved = model.toCsv('Name,Grouping,Direction', (name, group, marked) => [
    name,
    group,
    marked ? 'reversed' : 'forward',
  ]);
  const verdict = classify(new TextEncoder().encode(saved), 'InterfaceGroups.csv');
  assert.equal(verdict.kind, 'groupings', verdict.reason);
  assert.deepEqual(
    EDITOR_CSV_HEADERS,
    [['Name', 'Grouping', 'Direction']],
    'and it is what the editor writes',
  );
  assert.deepEqual(
    verdict.writtenBy,
    ['interface'],
    'only the interface editor writes this header',
  );
  assert.deepEqual(planInterfaceGroups(saved, EDITOR_MAPPING).members.get('SAMPLE_BOUNDARY'), [
    { name: 'SAMPLE_P01', direction: 'forward' },
    { name: 'SAMPLE_P03', direction: 'reversed' },
  ]);
  ok("the interface editor's saved file is a groupings drop, and reloads with its directions");
}

// ------------------------------------------ a boundary's summed limits
//
// A reversed member's flow counts × −1, so its sides swap and change sign:
// its MIN bounds the group from above as −MIN, its MAX from below as −MAX.
{
  const { summedLimits } = await import('../src/tables/interface/limits.ts');
  const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');
  const f = (sign, upper, lower) => ({
    sign,
    limits: {
      ...(upper === undefined ? {} : { upper }),
      ...(lower === undefined ? {} : { lower }),
    },
  });

  const forward = summedLimits([f(1, 100, -40), f(1, 50, -10)]);
  assert.equal(forward.upper[0], 150);
  assert.equal(forward.lower[0], -50);
  ok('an all-forward boundary is the plain sum of its paths’ limits');

  const swapped = summedLimits([f(1, 100, -40), f(-1, 50, -10)]);
  assert.equal(swapped.upper[0], 110, "100 + the reversed path's −MIN (10)");
  assert.equal(swapped.lower[0], -90, "−40 + the reversed path's −MAX (−50)");
  ok("a reversed member's MIN becomes upper and its MAX lower, both negated");

  // A MIN ≥ 0 is a floor; reversed it is a ceiling below zero, never |MIN|.
  const floor = summedLimits([f(-1, 200, 30)]);
  assert.equal(floor.upper[0], -30);
  assert.equal(floor.lower[0], -200);
  ok('the swap is signed arithmetic: a positive MIN reversed stays signed');

  // Hourly sides: one member unlimited in hour 1 makes that hour NaN only.
  const monthly = new Float32Array(HOURS_PER_YEAR).fill(80);
  monthly[1] = NaN;
  const gap = summedLimits([f(1, monthly, -20), f(1, 20, -5)]);
  assert.equal(gap.upper[0], 100);
  assert.ok(Number.isNaN(gap.upper[1]), 'the hour the member has no limit');
  assert.equal(gap.upper[2], 100);
  assert.equal(gap.lower[1], -25, 'the other side is untouched');
  ok('a member with no limit in an hour leaves that side unlimited in that hour only');

  // A member with no MIN at all: the lower side has no hour, so it is absent.
  const oneSided = summedLimits([f(1, 100, -40), f(1, 50, undefined)]);
  assert.equal(oneSided.upper[0], 150);
  assert.equal(oneSided.lower, undefined);
  assert.deepEqual(summedLimits([f(1, undefined, undefined), f(-1, 50, -10)]), {});
  assert.deepEqual(summedLimits([]), {});
  ok('a member with no limits leaves the side unlimited, never rated zero');

  // A drawn boundary sums the members its table carries with hours, frozen
  // set applied, signs from the map.
  const { boundaryLimits } = await import('../src/tables/interface/limits.ts');
  const { boundaryCoefficients } = await import('../src/tables/interface/groups.ts');
  setInterfaceMembership(
    new Map([
      [
        'SAMPLE_WEST',
        [
          { name: 'SAMPLE_P01', direction: 'forward' },
          { name: 'SAMPLE_P02', direction: 'reversed' },
          { name: 'SAMPLE_P03', direction: 'forward' },
        ],
      ],
    ]),
  );
  const data = {
    interfaces: ['SAMPLE_P01', 'SAMPLE_P02', 'SAMPLE_P03'],
    presence: new Uint8Array([1, 1, 0]),
  };
  const rated = { SAMPLE_P01: { upper: 100, lower: -40 }, SAMPLE_P02: { upper: 50, lower: -10 } };
  const asked = [];
  const rangeOf = (name) => {
    asked.push(name);
    return rated[name] ?? {};
  };
  const whole = boundaryLimits(data, boundaryCoefficients('SAMPLE_WEST'), rangeOf);
  assert.deepEqual(asked, ['SAMPLE_P01', 'SAMPLE_P02'], 'P03 has no hours, so no limit is read');
  assert.equal(whole.upper[0], 110);
  assert.equal(whole.lower[0], -90);
  const frozen = boundaryLimits(data, boundaryCoefficients('SAMPLE_WEST', ['SAMPLE_P02']), rangeOf);
  assert.equal(frozen.upper[0], 10, 'P02 alone, reversed: its −MIN');
  assert.equal(frozen.lower[0], -50);
  ok('a drawn boundary sums the limits of the members its sum took, frozen set applied');
  clearInterfaceGroups();
}

console.log(`\n${checks} checks passed.`);
