// tests/test_membership_model.mjs
//
// The group-membership rules, which had no test while they lived inside two
// modals' drag handlers.
//
// Both editors are drag-and-drop over three columns; their rules live in
// `src/ui/membership-model.ts`, which imports no DOM, so they can be tested
// here without dragging anything, and a rule cannot silently differ between
// kinds.

import './test_loader.mjs';

import assert from 'node:assert/strict';

const { LoadTracker, MembershipModel } = await import('../src/ui/membership-model.ts');

const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

const seed = () =>
  new MembershipModel(
    new Map([
      ['River', ['UNIT_B', 'UNIT_A']],
      ['Coal', ['UNIT_C']],
    ]),
  );

ok('the first group is selected, and its members come back in file order', () => {
  const model = seed();
  assert.equal(model.selected, 'River');
  assert.deepEqual(model.members(), ['UNIT_B', 'UNIT_A']);
});

ok('display order is sorted; the stored order is not touched', () => {
  const model = seed();
  assert.deepEqual(model.sortedMembers(), ['UNIT_A', 'UNIT_B']);
  // The stored order still reads as the file wrote it.
  assert.deepEqual(model.members(), ['UNIT_B', 'UNIT_A']);
  assert.deepEqual(
    model.ordered().map((entry) => entry.group),
    ['Coal', 'River'],
  );
});

ok('a name may sit in several groups, and the badge counts them', () => {
  // Many-to-many is the whole point: a plant inside a river basin is in both.
  const model = seed();
  model.select('Coal');
  model.add('UNIT_A');
  assert.equal(model.groupsContaining('UNIT_A'), 2);
  assert.equal(model.groupsContaining('UNIT_C'), 1);
  assert.equal(model.groupsContaining('NOBODY'), 0);
});

ok('adding twice is silent and changes nothing', () => {
  const model = seed();
  model.add('UNIT_B');
  assert.deepEqual(model.members(), ['UNIT_B', 'UNIT_A']);
});

ok('adding with nothing selected is a no-op, not a throw', () => {
  // Every group can be deleted, so "no group selected" is a reachable state
  // and a drop still has to land somewhere harmless.
  const model = seed();
  model.deleteGroup('River');
  model.deleteGroup('Coal');
  assert.equal(model.selected, '');
  model.add('UNIT_A');
  assert.equal(model.size, 0);
});

ok('a drop onto a group row files it there, not into the selected group', () => {
  const model = seed();
  assert.equal(model.selected, 'River');
  model.addTo('Coal', 'UNIT_Z');
  assert.equal(model.selected, 'River', 'the selection must not follow the drop');
  model.select('Coal');
  assert.deepEqual(model.members(), ['UNIT_C', 'UNIT_Z']);
});

ok('deleting the selected group moves the selection to what is left', () => {
  const model = seed();
  model.deleteGroup('River');
  assert.equal(model.selected, 'Coal');
});

ok('deleting a group that is not selected leaves the selection alone', () => {
  const model = seed();
  model.deleteGroup('Coal');
  assert.equal(model.selected, 'River');
});

ok('candidates exclude current members, keep axis order, and honour the filter', () => {
  const model = seed();
  const axis = ['UNIT_A', 'UNIT_B', 'UNIT_C', 'OTHER_D'];
  assert.deepEqual(model.candidates(axis, ''), ['UNIT_C', 'OTHER_D']);
  assert.deepEqual(model.candidates(axis, 'unit'), ['UNIT_C'], 'filter is case-insensitive');
  assert.deepEqual(model.candidates(axis, '  c  '), ['UNIT_C'], 'the needle is trimmed');
});

ok('the needle matches a name OR its detail, so a bus number finds a unit', () => {
  // An analyst knows a unit by its bus number and unit ID, not by the Name
  // the GeneratorList keys it on; a name-only match answers "no such unit"
  // to the identifier they typed.
  const model = seed();
  const axis = ['UNIT_C', 'OTHER_D'];
  const detail = (name) => (name === 'OTHER_D' ? 'bus 41234 · unit 1' : '');
  assert.deepEqual(model.candidates(axis, '41234', { detail }), ['OTHER_D']);
  assert.deepEqual(model.candidates(axis, 'BUS 41', { detail }), ['OTHER_D'], 'case-insensitive');
  assert.deepEqual(model.candidates(axis, '41234', {}), [], 'with no detail, nothing matches');
  assert.deepEqual(model.candidates(axis, 'unit_c', { detail }), ['UNIT_C'], 'the name still wins');
});

ok('a subset predicate narrows the column, and stacks with the needle', () => {
  const model = seed();
  const axis = ['UNIT_C', 'OTHER_D', 'OTHER_E'];
  const withData = new Set(['OTHER_D']);
  assert.deepEqual(model.candidates(axis, '', { keep: (n) => withData.has(n) }), ['OTHER_D']);
  assert.deepEqual(model.candidates(axis, '', { keep: (n) => !withData.has(n) }), [
    'UNIT_C',
    'OTHER_E',
  ]);
  assert.deepEqual(
    model.candidates(axis, 'other', { keep: (n) => withData.has(n) }),
    ['OTHER_D'],
    'both gates apply, not whichever is set last',
  );
});

ok('a member is never a candidate, whatever the subset says', () => {
  // The middle column and the right one are disjoint by construction; a
  // subset that re-offered a name already filed would let one gesture add it
  // twice and read as a duplicate that is not there.
  const model = seed();
  assert.deepEqual(model.candidates(['UNIT_A', 'UNIT_C'], '', { keep: () => true }), ['UNIT_C']);
});

ok('a group name is refused for the four reasons, each named', () => {
  const model = new MembershipModel(new Map([['River', []]]), new Set(['ALL AREAS']));
  assert.equal(model.refuseName('   '), 'empty');
  // A comma would split into two columns on the way back out to CSV.
  assert.equal(model.refuseName('Coal, Gas'), 'comma');
  assert.equal(model.refuseName('ALL AREAS'), 'reserved');
  assert.equal(model.refuseName('River'), 'duplicate');
  assert.equal(model.refuseName('  Gas  '), null, 'a name is trimmed before it is judged');
});

ok('a refused name creates nothing; an accepted one is created and selected', () => {
  const model = new MembershipModel(new Map([['River', []]]), new Set(['ALL AREAS']));
  assert.equal(model.addGroup('ALL AREAS'), false);
  assert.equal(model.size, 1);
  assert.equal(model.addGroup('  Gas  '), true);
  assert.equal(model.selected, 'Gas', 'a new group is the one you are now editing');
  assert.deepEqual(model.members(), []);
});

ok('a load replaces everything and reselects the first group', () => {
  const model = seed();
  model.replace(new Map([['Wind', ['UNIT_W']]]));
  assert.equal(model.size, 1);
  assert.equal(model.selected, 'Wind');
  assert.deepEqual(model.members(), ['UNIT_W']);
});

ok('a snapshot does not share the model mutable state', () => {
  // The caller applies this to a session-wide store; an alias would let a
  // later drag edit what had already been applied.
  const model = seed();
  const taken = model.snapshot();
  model.add('UNIT_LATER');
  assert.deepEqual(taken.get('River'), ['UNIT_B', 'UNIT_A']);
});

ok('the CSV is one row per pair, in INSERTION order, under the given header', () => {
  // Insertion order and not sorted: a saved file that reorders its own rows
  // on every save is a diff nobody asked for.
  const model = seed();
  assert.equal(
    model.toCsv('Name,Grouping'),
    'Name,Grouping\nUNIT_B,River\nUNIT_A,River\nUNIT_C,Coal\n',
  );
});

ok('a group with no members writes no rows, and an empty model writes a header', () => {
  const model = new MembershipModel(new Map([['Empty', []]]));
  assert.equal(model.toCsv('Name,Grouping'), 'Name,Grouping\n');
});

// ------------------------------------------------------------ the marks
//
// A per-member setting the editor shows as a button. Interface groups are
// what it exists for: a member counts forward or reversed into its group.
// Everything below is about the one property that makes it correct -- the
// mark belongs to a (group, member) PAIR, not to a member.

ok('a mark is per (group, member), so one name may be marked in one group only', () => {
  const model = new MembershipModel(
    new Map([
      ['River', ['UNIT_B', 'UNIT_A']],
      ['Coal', ['UNIT_A']],
    ]),
    new Set(),
    [['River', 'UNIT_A']],
  );
  assert.equal(model.isMarked('River', 'UNIT_A'), true);
  assert.equal(model.isMarked('Coal', 'UNIT_A'), false, 'the same name, the other group');
  assert.equal(model.markedIn('River'), 1);
  assert.equal(model.markedIn('Coal'), 0);
});

ok('toggling flips one pair and returns its new state', () => {
  const model = seed();
  assert.equal(model.toggleMark('River', 'UNIT_A'), true);
  assert.equal(model.isMarked('River', 'UNIT_A'), true);
  assert.equal(model.toggleMark('River', 'UNIT_A'), false);
  assert.equal(model.isMarked('River', 'UNIT_A'), false);
});

ok('a pair the group does not hold cannot be marked', () => {
  // A mark on a non-member is state nothing can show, and it would surface
  // the moment the name was added -- wearing a setting nobody chose.
  const model = seed();
  assert.equal(model.toggleMark('River', 'NOBODY'), false);
  assert.equal(model.isMarked('River', 'NOBODY'), false);
  assert.equal(model.toggleMark('NO SUCH GROUP', 'UNIT_A'), false);
});

ok('removing a member drops its mark, so re-adding it starts clean', () => {
  const model = seed();
  model.toggleMark('River', 'UNIT_A');
  model.remove('UNIT_A');
  model.add('UNIT_A');
  assert.equal(model.isMarked('River', 'UNIT_A'), false);
});

ok('deleting a group drops its marks and leaves another group’s alone', () => {
  const model = new MembershipModel(
    new Map([
      ['River', ['UNIT_A']],
      ['Coal', ['UNIT_A']],
    ]),
    new Set(),
    [
      ['River', 'UNIT_A'],
      ['Coal', 'UNIT_A'],
    ],
  );
  model.deleteGroup('River');
  assert.equal(model.isMarked('Coal', 'UNIT_A'), true);
  model.addGroup('River');
  model.addTo('River', 'UNIT_A');
  assert.equal(model.isMarked('River', 'UNIT_A'), false, 'a rebuilt group starts unmarked');
});

ok('a load replaces the marks with the file’s own, never keeping the old ones', () => {
  // A file that carried directions must not land wearing the previous
  // membership's: the marks describe THAT membership and nothing else.
  const model = seed();
  model.toggleMark('River', 'UNIT_A');
  model.replace(new Map([['Wind', ['UNIT_W', 'UNIT_X']]]), [['Wind', 'UNIT_X']]);
  assert.equal(model.isMarked('Wind', 'UNIT_X'), true);
  assert.equal(model.isMarked('Wind', 'UNIT_W'), false);
  assert.equal(model.markedIn('Wind'), 1);
  model.replace(new Map([['Wind', ['UNIT_W']]]));
  assert.equal(model.markedIn('Wind'), 0, 'a load with no marks clears them');
});

ok('the mark snapshot walks membership order and names its pairs', () => {
  const model = seed();
  model.toggleMark('River', 'UNIT_A');
  model.select('Coal');
  model.toggleMark('Coal', 'UNIT_C');
  assert.deepEqual(model.markSnapshot(), [
    ['River', 'UNIT_A'],
    ['Coal', 'UNIT_C'],
  ]);
});

ok('the CSV gains a third column only when one is asked for', () => {
  const model = seed();
  model.toggleMark('River', 'UNIT_A');
  assert.equal(
    model.toCsv('Name,Grouping,Direction', (name, group, marked) => [
      name,
      group,
      marked ? 'reversed' : 'forward',
    ]),
    'Name,Grouping,Direction\n' +
      'UNIT_B,River,forward\n' +
      'UNIT_A,River,reversed\n' +
      'UNIT_C,Coal,forward\n',
  );
  // The kinds with no columns of their own write the two-column file they
  // always did.
  assert.equal(
    model.toCsv('Name,Grouping'),
    'Name,Grouping\nUNIT_B,River\nUNIT_A,River\nUNIT_C,Coal\n',
  );
});

// --------------------------------------------- the columns a kind adds
//
// A kind states the WHOLE row rather than a suffix, because column ORDER is
// the file's meaning: a generator's bus number and unit ID belong beside the
// name they qualify, and a mark belongs after the group it applies to.

ok('a kind writes its own columns in its own order, not appended', () => {
  const model = seed();
  const ids = new Map([
    ['UNIT_A', ['101', '1']],
    ['UNIT_B', ['101', '2']],
  ]);
  assert.equal(
    model.toCsv('Name,Bus ID,Unit ID,Grouping', (name, group) => [
      name,
      ...(ids.get(name) ?? ['', '']),
      group,
    ]),
    'Name,Bus ID,Unit ID,Grouping\n' +
      'UNIT_B,101,2,River\n' +
      'UNIT_A,101,1,River\n' +
      // A member the kind knows no identifiers for writes blank cells, never a
      // placeholder a reload would read as an id.
      'UNIT_C,,,Coal\n',
  );
});

ok('rows the model does not hold are written last, so a save loses nothing', () => {
  // The generator case: a (bus, unit) pair no loaded list claims is not
  // editable membership and rides beside the map. A save that left it out
  // would be the silently shorter fleet.
  const model = new MembershipModel(new Map([['River', ['UNIT_A']]]));
  assert.equal(
    model.toCsv('Name,Bus ID,Unit ID,Grouping', (name, group) => [name, '', '', group], [
      ['', '909', '1', 'River'],
      ['', '909', '2', 'Coal'],
    ]),
    'Name,Bus ID,Unit ID,Grouping\n' + 'UNIT_A,,,River\n' + ',909,1,River\n' + ',909,2,Coal\n',
  );
});

ok('an empty model still writes the rows it does not hold', () => {
  const model = new MembershipModel(new Map());
  assert.equal(
    model.toCsv('Name,Bus ID,Unit ID,Grouping', undefined, [['', '909', '1', 'River']]),
    'Name,Bus ID,Unit ID,Grouping\n,909,1,River\n',
  );
});

// ------------------------------------------------ a file loaded in the editor
//
// The Contents strip names the file whose content became the membership, and
// says "edited in app" when it was changed before Apply. A load that replaced
// nothing (a cancelled mapping, a refused file) is not a source.

const loaded = new Map([
  ['North', ['UNIT_A', 'UNIT_B']],
  ['South', ['UNIT_C']],
]);

ok('a load that replaced the membership is the source, unedited', () => {
  const model = seed();
  const loads = new LoadTracker(model);
  loads.begin('SAMPLE_groups.csv');
  model.replace(loaded);
  loads.replaced();
  loads.end('SAMPLE_groups.csv');
  assert.deepEqual(loads.applied(), {
    source: { file: 'SAMPLE_groups.csv', editedInApp: false },
    changed: true,
  });
});

ok('an edit between the load and Apply is "edited in app"; undoing it is not', () => {
  const model = seed();
  const loads = new LoadTracker(model);
  loads.begin('SAMPLE_groups.csv');
  model.replace(loaded);
  loads.replaced();
  loads.end('SAMPLE_groups.csv');
  model.select('South');
  model.add('UNIT_D');
  assert.equal(loads.applied().source.editedInApp, true);
  model.remove('UNIT_D');
  assert.equal(loads.applied().source.editedInApp, false, 'the same membership as the file');
});

ok('a mark flipped after the load is an edit', () => {
  const model = new MembershipModel(new Map());
  const loads = new LoadTracker(model);
  loads.begin('SAMPLE_paths.csv');
  model.replace(new Map([['Boundary', ['P01', 'P02']]]));
  loads.replaced();
  loads.end('SAMPLE_paths.csv');
  model.toggleMark('Boundary', 'P02');
  assert.equal(loads.applied().source.editedInApp, true);
});

ok('a load that replaced nothing leaves the last source standing', () => {
  const model = seed();
  const loads = new LoadTracker(model);
  loads.begin('SAMPLE_cancelled.csv');
  loads.end('SAMPLE_cancelled.csv');
  assert.deepEqual(loads.applied(), { source: null, changed: false });
  loads.begin('SAMPLE_good.csv');
  model.replace(loaded);
  loads.replaced();
  loads.end('SAMPLE_good.csv');
  loads.begin('SAMPLE_refused.csv');
  loads.end('SAMPLE_refused.csv');
  assert.equal(loads.applied().source.file, 'SAMPLE_good.csv');
});

ok('closed mid-load (a load that hands its file straight to Apply) is that file, unedited', () => {
  const model = seed();
  const loads = new LoadTracker(model);
  model.add('UNIT_Z');
  loads.begin('SAMPLE_area.csv');
  assert.deepEqual(loads.applied().source, { file: 'SAMPLE_area.csv', editedInApp: false });
});

ok('with no load, Apply says only whether the membership changed', () => {
  const model = seed();
  const loads = new LoadTracker(model);
  assert.deepEqual(loads.applied(), { source: null, changed: false });
  model.addGroup('East');
  assert.deepEqual(loads.applied(), { source: null, changed: true });
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}\n  ${e.message}`);
  }
}
console.log(`\n${checks.length - failed} checks passed.`);
if (failed) process.exit(1);
