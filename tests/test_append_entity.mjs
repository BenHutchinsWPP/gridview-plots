// tests/test_append_entity.mjs
//
// The entity kinds' joins onto a loaded table (src/tables/{generator,interface,bus}/append.ts):
//   - a generator export split by region joins to the union, values in place
//   - Bus joins on id: two buses sharing a name stay apart, an empty old name
//     takes the file's, new ids take the file's names
//   - an empty or differing quantity is refused, and an Interface unit too
//   - a merged table survives the kind's save round trip
//
// Run:  node test_append_entity.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { appendGeneratorTable, generatorAppendSize } =
  await import('../src/tables/generator/append.ts');
const { appendInterfaceTable, interfaceAppendSize } =
  await import('../src/tables/interface/append.ts');
const { appendBusTable, busAppendSize } = await import('../src/tables/bus/append.ts');
const { serializeGeneratorTable, deserializeGeneratorTable } =
  await import('../src/tables/generator/types.ts');
const { serializeBusTable, deserializeBusTable } = await import('../src/tables/bus/types.ts');
const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`  ok  ${label}`);
}

function base(n, value, extra = {}) {
  const cube = new Float32Array(n * H);
  for (let p = 0; p < n; p++) for (let h = 0; h < H; h++) cube[p * H + h] = value(p, h);
  return {
    cube,
    presence: new Uint8Array(n).fill(1),
    tou: new Uint8Array(H).fill(1),
    hoursPresent: new Uint8Array(H).fill(1),
    firstYear: 2030,
    numYears: 1,
    quantity: 'Generation (MW)',
    ...extra,
  };
}
const gen = (names, src, base0 = 0) => ({
  ...base(names.length, (p, h) => base0 + p * 1000 + h),
  generators: names,
  sourceColumns: src ?? names,
});
const bus = (ids, names, v) => ({
  ...base(ids.length, (p, h) => v + p * 1000 + h),
  buses: Int32Array.from(ids),
  names,
  sourceColumns: ids.slice(),
});
const itf = (names, unit = 'MW') => ({
  ...base(names.length, (p, h) => p + h),
  interfaces: names,
  sourceColumns: names,
  quantity: `Flow (${unit})`,
  unit,
});

// generator split by region
const west = gen(['A', 'B'], ['A', 'B', 'X'], 0);
const east = gen(['C'], ['C', 'Y'], 5000);
const g = appendGeneratorTable(west, east);
assert.deepEqual(g.table.generators, ['A', 'B', 'C']);
assert.deepEqual(g.added, ['C']);
assert.equal(g.noun, 'generator');
assert.deepEqual(g.table.sourceColumns, ['A', 'B', 'X', 'C', 'Y']);
assert.equal(g.table.cube.length, 3 * H);
assert.equal(g.table.cube[1 * H + 7], 1007);
assert.equal(g.table.cube[2 * H + 7], 5007);
assert.deepEqual(Array.from(g.table.presence), [1, 1, 1]);
assert.equal(g.table.quantity, 'Generation (MW)');
assert.deepEqual(generatorAppendSize(west, east), {
  factors: [{ count: 3, one: 'generator', many: 'generators' }],
  numYears: 1,
});
ok('generator split by region joins to the union');

// bus: id is the key
const b0 = bus([1, 2], ['SAME', ''], 0);
const b1 = bus([2, 3, 4], ['TWO', 'SAME', ''], 9000);
const b = appendBusTable(b0, b1);
assert.ok(b.table.buses instanceof Int32Array);
assert.deepEqual(Array.from(b.table.buses), [1, 2, 3, 4]);
assert.deepEqual(b.table.names, ['SAME', 'TWO', 'SAME', '']);
assert.equal(b.table.cube[0 * H + 5], 5);
assert.equal(b.table.cube[2 * H + 5], 9000 + 1000 + 5);
assert.deepEqual(b.overlapping, ['2']);
ok('two buses sharing a name stay apart; names fill by id');

const lo = bus([1], ['A'], 0);
const lf = bus([1, 2], ['', ''], 0);
assert.deepEqual(appendBusTable(lo, lf).table.names, ['A', '']);
const lf2 = bus([1, 2], ['A2', 'N'], 0);
assert.deepEqual(appendBusTable(bus([1], [''], 0), lf2).table.names, ['A2', 'N']);
assert.equal(busAppendSize(b0, b1).factors[0].count, 4);
ok('empty fresh names stay empty; empty old name filled');

// refusals
const noq = { ...west, quantity: '' };
assert.throws(() => appendGeneratorTable(noq, east), /no quantity/);
assert.throws(() => appendGeneratorTable(west, noq), /no quantity/);
assert.throws(() => appendBusTable({ ...b0, quantity: '' }, b1), /no quantity/);
assert.throws(
  () => appendInterfaceTable({ ...itf(['I']), quantity: '' }, itf(['J'])),
  /no quantity/,
);
assert.throws(
  () => appendGeneratorTable(west, { ...east, quantity: 'Capacity (MW)' }),
  /Generation \(MW\).*Capacity \(MW\)/,
);
assert.throws(() => appendBusTable(b0, { ...b1, quantity: 'LMP ($/MWh)' }), /Generation \(MW\)/);
const imw = itf(['I']);
assert.throws(
  () => appendInterfaceTable(imw, { ...itf(['J'], 'MWh'), quantity: imw.quantity }),
  /in MW and the file is in MWh/,
);
const ij = appendInterfaceTable(imw, itf(['J']));
assert.deepEqual(ij.table.interfaces, ['I', 'J']);
assert.equal(ij.table.unit, 'MW');
assert.equal(interfaceAppendSize(imw, itf(['J'])).factors[0].count, 2);
ok('empty quantity, quantity mismatch and unit mismatch are refused');

// save round trip
function trip(t, ser, de) {
  const { fields, cube } = ser(t);
  const wire = JSON.parse(
    JSON.stringify(fields, (k, v) => (v instanceof Uint8Array ? { u8: Array.from(v) } : v)),
    (k, v) => (v && v.u8 ? Uint8Array.from(v.u8) : v),
  );
  return de(wire, cube.slice().buffer);
}
assert.deepEqual(trip(g.table, serializeGeneratorTable, deserializeGeneratorTable), g.table);
assert.deepEqual(trip(b.table, serializeBusTable, deserializeBusTable), b.table);
ok('a merged table round-trips through save');

// registry: every kind's join is reachable, and the registered function is the
// kind's own (a mutation registering Area's join under generator must fail).
{
  const { appendTableOf, appendSizeOf, TABLE_KINDS } = await import('../src/tables/registry.ts');
  for (const kind of TABLE_KINDS) {
    assert.equal(typeof appendTableOf(kind), 'function', kind);
    assert.equal(typeof appendSizeOf(kind), 'function', kind);
  }
  assert.deepEqual(appendTableOf('generator')(west, east), appendGeneratorTable(west, east));
  assert.deepEqual(appendSizeOf('generator')(west, east), generatorAppendSize(west, east));
  ok('registry: every kind has append and appendSize; generator matches the direct call');
}

console.log(`${checks} checks passed`);
