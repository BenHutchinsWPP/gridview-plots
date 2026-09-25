// tests/test_perf_data.mjs — the perf-fixture generator, through its
// manifest (never opening a large CSV):
//
//   1. The manifest is the contract.
//   2. DETERMINISM: one seed, byte-identical output, or benchmarks compare
//      different inputs.
//   3. The ladder's rungs and their entity, row and metric counts hold.
//   4. scripts/file-blob.mjs reads the same bytes as a whole-file read.
//
// No timing assertions, and only the smallest rung is ever generated.

import './test_loader.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  generate,
  writeHead,
  RUNGS,
  ALL_RUNGS,
  DROPS,
  DROP_CASES,
  CONTROL_RUNG,
  DEFAULT_SEED,
  entityName,
} = await import('../scripts/make-perf-data.mjs');
const { fileBlob } = await import('../scripts/file-blob.mjs');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** The one rung this suite is allowed to generate. */
const control = RUNGS.find((rung) => rung.name === CONTROL_RUNG);
assert.ok(control, `the ladder must carry its control rung "${CONTROL_RUNG}"`);
ok(`the ladder declares its control rung ${CONTROL_RUNG}`);

const workspace = mkdtempSync(join(tmpdir(), 'gv-perf-'));

try {
  // ------------------------------------------------------------ the manifest

  const first = await generate({ out: join(workspace, 'a'), seed: DEFAULT_SEED, rungs: [control] });

  assert.equal(first.files.length, 1, 'one rung in, one file out');
  const entry = first.files[0];

  assert.equal(entry.name, CONTROL_RUNG);
  assert.equal(entry.shape, 'wide');
  assert.equal(entry.entities, control.entities);
  assert.equal(entry.metrics, control.metrics);
  ok(
    `manifest records the control rung's shape, ${entry.entities} entities and ${entry.metrics} metric`,
  );

  // 8,760 and not 8,784: the generator writes a non-leap year so no rung's
  // cost is inflated by Feb 29 rows both parsers drop anyway.
  assert.equal(entry.rows, first.hoursPerYear);
  assert.equal(entry.rows, 8760, 'a full year is exactly 8,760 hours');
  ok('manifest records 8,760 data rows -- one full non-leap year');

  // The byte count is a claim about a file, so check it against the file's
  // size. This is a stat, not a read: nothing here opens the CSV.
  const onDisk = statSync(join(workspace, 'a', entry.file)).size;
  assert.equal(entry.bytes, onDisk, 'the manifest byte count must be the real file size');
  ok(`manifest byte count matches the file on disk (${(entry.bytes / 1e6).toFixed(1)} MB)`);

  // Header-line size is the number the interface kind's fixed 256 KB head
  // probe is spent against, so it is recorded per rung rather than recomputed
  // later from a width and a guess.
  assert.ok(entry.headerBytes > 0, 'the header line has a recorded size');
  assert.ok(
    entry.headerBytes > entry.entities * entityName(control.kind, 1).length,
    'entity names are of realistic length, not e1/e2',
  );
  ok(`manifest records the header line at ${entry.headerBytes.toLocaleString()} B`);

  // ------------------------------------------------------- obviously synthetic
  //
  // The manifest declares the synthetic name prefix, so a generated file is
  // never mistaken for a real export, nor the reverse.
  assert.equal(first.synthetic, true, 'the manifest must declare its output synthetic');
  assert.equal(first.generator, 'scripts/make-perf-data.mjs');
  assert.ok(entityName(control.kind, 1).startsWith(first.namePrefix));
  ok(`generated names carry the ${first.namePrefix}_ prefix and the manifest says so`);

  // ------------------------------------------------------------ determinism

  const second = await generate({
    out: join(workspace, 'b'),
    seed: DEFAULT_SEED,
    rungs: [control],
  });
  assert.ok(entry.sha256, 'the smallest rung carries a content hash');
  assert.equal(
    second.files[0].sha256,
    entry.sha256,
    'two runs at one seed must produce byte-identical output',
  );
  assert.equal(second.files[0].bytes, entry.bytes);
  ok('two runs at the same seed are byte-identical');

  const other = await generate({
    out: join(workspace, 'c'),
    seed: DEFAULT_SEED + 1,
    rungs: [control],
  });
  assert.notEqual(
    other.files[0].sha256,
    entry.sha256,
    'a different seed must produce different bytes, or --seed does nothing',
  );
  ok('a different seed produces different bytes');

  // ----------------------------------------------------------- the Blob shim

  {
    const path = join(workspace, 'a', entry.file);
    const whole = readFileSync(path);
    const file = fileBlob(path);
    try {
      assert.equal(file.size, whole.length, 'the shim reports the real file size');
      assert.equal(file.name, entry.file);

      const ranges = [
        [0, 1024], // the head probe's first bytes
        [4096, 4096 + 65536], // an interior block
        [whole.length - 4096, whole.length], // the last whole rows
        [whole.length - 128, whole.length + 65536], // spans the end -- every
        // file's last block asks past EOF by design, so a shim that did not
        // clamp would either throw or hand back uninitialised memory
        [whole.length, whole.length + 10], // entirely past the end
        [512, 512], // empty
      ];
      for (const [from, to] of ranges) {
        const slice = file.slice(from, to);
        const got = Buffer.from(await slice.arrayBuffer());
        const want = whole.subarray(Math.max(0, from), Math.min(whole.length, to));
        assert.equal(got.length, want.length, `slice(${from}, ${to}) length`);
        assert.ok(got.equals(want), `slice(${from}, ${to}) bytes`);
      }
      ok(
        `the Blob shim matches a whole-file read over ${ranges.length} ranges, including past EOF`,
      );
    } finally {
      file.close();
    }
  }

  // ------------------------------------------------------------- the ladder
  //
  // Rung names index every result, so a rename or drop must fail here.
  const names = RUNGS.map((rung) => rung.name);
  assert.equal(new Set(names).size, names.length, 'rung names are unique');
  for (const rung of RUNGS) {
    assert.ok(rung.entities > 0 && Number.isInteger(rung.entities), `${rung.name} has a width`);
    assert.ok(rung.proves, `${rung.name} states what it proves`);
  }
  // Only the smallest rung is hashed, so the suite never has to read a
  // half-gigabyte file to prove determinism.
  const hashed = RUNGS.filter((rung) => rung.hashed);
  assert.deepEqual(
    hashed.map((rung) => rung.name),
    [CONTROL_RUNG],
    'only the smallest rung is hashed',
  );
  ok(`the ladder declares ${RUNGS.length} rung(s), each with a stated purpose`);

  // ------------------------------------------------------- the worst drop
  //
  // A missing or duplicated case would silently shrink the drop.
  const allNames = ALL_RUNGS.map((rung) => rung.name);
  assert.equal(
    new Set(allNames).size,
    allNames.length,
    'rung names are unique across ladder and drops',
  );
  for (const drop of DROPS) {
    assert.ok(drop.cases.length >= 2, `${drop.name} holds more than one case`);
    assert.ok(drop.proves, `${drop.name} states what it proves`);
    for (const name of drop.cases) {
      const rung = ALL_RUNGS.find((candidate) => candidate.name === name);
      assert.ok(rung, `${drop.name} names a rung "${name}" this script can write`);
      assert.equal(rung.entities, drop.entities, `${name} is at the drop's width`);
    }
    // Distinct, non-zero seed offsets, or cases would be identical bytes.
    const offsets = drop.cases.map(
      (name) => ALL_RUNGS.find((rung) => rung.name === name).seedOffset,
    );
    assert.ok(
      offsets.every((offset) => Number.isInteger(offset) && offset !== 0),
      `${drop.name}: every case carries a non-zero seed offset`,
    );
    assert.equal(new Set(offsets).size, offsets.length, `${drop.name}: seed offsets are distinct`);
  }
  assert.equal(DROPS[0].cases.length, DROP_CASES, 'the worst drop holds DROP_CASES cases');
  ok(`the worst drop declares ${DROP_CASES} bus-width cases, each at its own seed`);

  // The worst drop has two quantities per Case (two cubes), which must
  // differ or the files collide on one slot.
  const worst = DROPS.reduce((a, b) => (b.quantitiesPerCase > a.quantitiesPerCase ? b : a));
  assert.ok(worst.quantitiesPerCase >= 2, 'some drop carries more than one quantity per Case');
  assert.equal(
    worst.cases.length,
    DROP_CASES * worst.quantitiesPerCase,
    `${worst.name}: file count`,
  );
  for (let c = 0; c < DROP_CASES; c++) {
    const files = worst.cases.slice(c * worst.quantitiesPerCase, (c + 1) * worst.quantitiesPerCase);
    const quantities = files.map((name) => ALL_RUNGS.find((rung) => rung.name === name).quantity);
    assert.equal(
      new Set(quantities).size,
      quantities.length,
      `${worst.name} case ${c + 1}: quantities`,
    );
  }
  ok(`${worst.name} holds ${DROP_CASES} cases of ${worst.quantitiesPerCase} distinct quantities`);

  // ------------------------------------------- a rung is its title's export
  //
  // A Bus or Generator rung is dropped into the app, which routes by title,
  // so each head must pass its own kind's plan reader.
  const planReaders = {
    Bus: (await import('../src/tables/bus/wide.ts')).readCasePlan,
    Generator: (await import('../src/tables/generator/wide.ts')).readCasePlan,
  };
  const titled = ALL_RUNGS.filter((rung) => rung.shape === 'wide' && rung.kind !== 'Interface');
  assert.ok(titled.length > 0, 'the ladder carries rungs titled as a non-interface kind');
  for (const rung of titled) {
    const readPlan = planReaders[rung.kind];
    assert.ok(readPlan, `${rung.name}: no plan reader for kind ${rung.kind}`);
    const head = await writeHead(rung, { limit: 1024 * 1024 });
    const plan = await readPlan(new File([head], `${rung.name}.csv`));
    assert.equal(plan.header.entityNames.length, rung.entities, `${rung.name}: every column read`);
  }
  ok(`${titled.length} rung(s) titled Bus or Generator are laid out as that kind's export`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\n${checks} checks passed.`);
