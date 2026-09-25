// tests/test_import_plan.mjs — Import Dialog logic, fed plain objects. Above
// all: two Interface files with unreadable titles (`variant: undefined`) on
// one Case are a real slot collision, never last-write-wins, and a
// `variantOverride` can clear it.
//

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { planImports, planLimits, deriveCaseName, slotKeyFor } =
  await import('../src/app/import-plan.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

function detected(kind, overrides = {}) {
  return {
    kind,
    confidence: 'high',
    reason: `synthetic fixture (${kind})`,
    ...overrides,
  };
}

// --- 1. one-case mode -------------------------------------------------------

check('one-case mode assigns every file to the same, new case with no conflicts', () => {
  const files = [
    { name: 'area1.csv', detected: detected('area') },
    { name: 'iface1.csv', detected: detected('interface', { variant: 'Power Flow (MW)' }) },
  ];
  const plans = planImports(files, 'one-case', { caseName: 'Study A' });

  assert.equal(plans.length, 2);
  for (const p of plans) {
    assert.equal(p.caseName, 'Study A');
    assert.equal(p.caseIsNew, true);
    assert.equal(p.slotConflict, false);
    assert.equal(p.conflictReason, undefined);
  }
  assert.equal(plans[0].kind, 'area');
  assert.equal(plans[0].variant, undefined);
  assert.equal(plans[1].kind, 'interface');
  assert.equal(plans[1].variant, 'Power Flow (MW)');
});

// --- 2. derive-pattern mode with a multi-file preview -----------------------

check('derive mode captures the case name from a filename pattern, per file', () => {
  // deriveCaseName in isolation, including its fallback rules.
  assert.equal(deriveCaseName('Plant1_2024_PF.csv'), 'Plant1_2024_PF');
  assert.equal(deriveCaseName('Plant1_2024_PF.csv', '*_2024_PF.csv'), 'Plant1');
  assert.equal(deriveCaseName('Plant2_2024_PF.csv', '*_2024_PF.csv'), 'Plant2');
  assert.equal(
    deriveCaseName('no-star-here.csv', 'literal.csv'),
    'no-star-here',
    'no "*" in pattern falls back to the stem',
  );
  assert.equal(
    deriveCaseName('Plant1_2024_PF.csv', '*_2023_PF.csv'),
    'Plant1_2024_PF',
    'a pattern that does not match the filename falls back to the stem rather than guessing',
  );

  // The same pattern applied to a batch, as the dialog's live preview would.
  const files = [
    { name: 'Plant1_2024_PF.csv', detected: detected('interface', { variant: 'Power Flow (MW)' }) },
    { name: 'Plant2_2024_PF.csv', detected: detected('interface', { variant: 'Power Flow (MW)' }) },
  ];
  const plans = planImports(files, 'derive', { pattern: '*_2024_PF.csv' });

  assert.equal(plans[0].caseName, 'Plant1');
  assert.equal(plans[1].caseName, 'Plant2');
  // Distinct case names -> no collision even though kind+variant match.
  assert.equal(plans[0].slotConflict, false);
  assert.equal(plans[1].slotConflict, false);
});

// --- 3. individual mode, per-file overrides ---------------------------------

check(
  "individual mode takes each file's own case name, with kind/variant overrides applied",
  () => {
    const files = [
      { name: 'a.csv', detected: detected('interface', { variant: undefined, confidence: 'low' }) },
      { name: 'b.csv', detected: detected('area') },
    ];
    const plans = planImports(files, 'individual', {
      overrides: {
        0: { caseName: 'Case One', variantOverride: 'Congestion Cost ($)' },
        1: { caseName: 'Case Two', kindOverride: 'area' },
      },
    });

    assert.equal(plans[0].caseName, 'Case One');
    assert.equal(plans[0].kind, 'interface');
    assert.equal(plans[0].variant, 'Congestion Cost ($)');
    assert.equal(plans[0].slotConflict, false);

    assert.equal(plans[1].caseName, 'Case Two');
    assert.equal(plans[1].kind, 'area');
    assert.equal(plans[1].slotConflict, false);

    assert.throws(
      () => planImports(files, 'individual', { overrides: { 0: { caseName: 'Case One' } } }),
      /individual.*requires a caseName override/,
      'a file missing its individual-mode caseName override is refused, not guessed',
    );
  },
);

// --- 4. same-batch collision (not the empty-variant shape below) -----------

check(
  'two files landing on the same (case, kind, variant) slot in one batch both report a conflict',
  () => {
    // Two SHAPES for one slot: a merge needs one reader, so this is the
    // collision that survives allowing same-shape merges.
    const files = [
      { name: 'first.csv', detected: detected('area', { shape: 'L' }) },
      { name: 'second.csv', detected: detected('area', { shape: 'W' }) },
    ];
    const plans = planImports(files, 'one-case', { caseName: 'Shared Case' });

    assert.equal(plans[0].slotConflict, true);
    assert.equal(plans[1].slotConflict, true);
    // Only the overlapping file: the row, box and summary say the rest.
    assert.equal(plans[0].conflictReason, 'Overlaps with "second.csv".');
    assert.equal(plans[1].conflictReason, 'Overlaps with "first.csv".');
  },
);

// A study exported in halves is the outcome the user asked for by giving both
// files the same study name, and the row-per-reading reader can read them as
// one table. So it is a MERGE, not a collision, and nothing blocks.
check('two long-shape files for one study merge rather than collide', () => {
  const files = [
    { name: 'jan.csv', detected: detected('bus', { shape: 'L' }) },
    { name: 'jul.csv', detected: detected('bus', { shape: 'L' }) },
  ];
  const plans = planImports(files, 'one-case', { caseName: 'AREA_BP 2035' });

  assert.equal(plans[0].merges, true);
  assert.equal(plans[1].merges, true);
  assert.equal(plans[0].slotConflict, false, 'a merge must not block the dialog');
  assert.equal(plans[0].conflictReason, undefined);
});

// The column-per-entity reader merges too, so those two files are a merge on
// exactly the same terms.
check('two wide-shape files for one study merge as well', () => {
  const files = [
    { name: 'jan.csv', detected: detected('bus', { shape: 'W' }) },
    { name: 'jul.csv', detected: detected('bus', { shape: 'W' }) },
  ];
  const plans = planImports(files, 'one-case', { caseName: 'AREA_BP 2035' });

  assert.equal(plans[0].merges, true);
  assert.equal(plans[1].merges, true);
  assert.equal(plans[0].slotConflict, false, 'a merge must not block the dialog');
  assert.equal(plans[0].conflictReason, undefined);
});

// One cube is read by ONE reader, so two halves in two shapes cannot be one
// table -- and the refusal says so rather than naming a shape that cannot.
check('two files of DIFFERENT shapes for one study still collide', () => {
  const files = [
    { name: 'jan.csv', detected: detected('bus', { shape: 'L' }) },
    { name: 'jul.csv', detected: detected('bus', { shape: 'W' }) },
  ];
  const plans = planImports(files, 'one-case', { caseName: 'AREA_BP 2035' });

  assert.equal(plans[0].merges, false);
  assert.equal(plans[0].slotConflict, true);
  assert.equal(plans[0].conflictReason, 'Overlaps with "jul.csv".');
});

// A single file is never a merge, whatever its shape.
check('one file on its own is not a merge', () => {
  const plans = planImports(
    [{ name: 'only.csv', detected: detected('bus', { shape: 'L' }) }],
    'one-case',
    { caseName: 'AREA_BP 2035' },
  );
  assert.equal(plans[0].merges, false);
});

// --- 5. existing-case replace detection -------------------------------------
//
// A replace is non-blocking: `replacesExisting` only, never `slotConflict`.

check(
  'a target case that already has a table at the target slot is reported as a replace, not a blocking conflict',
  () => {
    const files = [{ name: 'update.csv', detected: detected('area') }];
    const plans = planImports(files, 'one-case', {
      caseName: 'Existing Study',
      existingCases: [{ name: 'Existing Study', occupiedSlots: [slotKeyFor('area', undefined)] }],
    });

    assert.equal(plans[0].caseIsNew, false);
    assert.equal(plans[0].replacesExisting, true);
    assert.ok(plans[0].replaceReason.includes('Replaces'));
    // The whole point of the fix: a replace alone must NOT raise the blocking
    // flag -- it is a normal, confirmable "update a case I already loaded"
    // action, not a same-batch collision.
    assert.equal(plans[0].slotConflict, false, 'a replace alone must not be blocking');
    assert.equal(plans[0].conflictReason, undefined);

    // Targeting an existing case at a FREE slot is neither a replace nor a
    // conflict.
    const freeSlotPlans = planImports(
      [{ name: 'new-kind.csv', detected: detected('interface', { variant: 'Power Flow (MW)' }) }],
      'one-case',
      {
        caseName: 'Existing Study',
        existingCases: [{ name: 'Existing Study', occupiedSlots: [slotKeyFor('area', undefined)] }],
      },
    );
    assert.equal(freeSlotPlans[0].caseIsNew, false);
    assert.equal(freeSlotPlans[0].slotConflict, false);
    assert.equal(freeSlotPlans[0].replacesExisting, false);
  },
);

check(
  'replacing a HALF-year table says so; a full year and an unknown record say nothing about coverage',
  () => {
    const files = [{ name: 'mar apr.csv', detected: detected('area') }];
    const half = planImports(files, 'one-case', {
      caseName: 'Existing Study',
      existingCases: [
        {
          name: 'Existing Study',
          occupiedSlots: [slotKeyFor('area', undefined)],
          slotHours: { [slotKeyFor('area', undefined)]: 4344 },
        },
      ],
    });
    assert.equal(half[0].replacesExisting, true);
    assert.ok(
      half[0].replaceReason.includes('4,344 of 8,760'),
      'names what the replaced table covers',
    );
    assert.ok(half[0].replaceReason.includes('TOGETHER'), 'says how to get one table instead');
    assert.ok(
      !half[0].replaceReason.includes('mar apr.csv'),
      'the file is not named back at a row that already shows it',
    );

    // A whole year replaced loses nothing a re-export cannot bring back.
    const full = planImports(files, 'one-case', {
      caseName: 'Existing Study',
      existingCases: [
        {
          name: 'Existing Study',
          occupiedSlots: [slotKeyFor('area', undefined)],
          slotHours: { [slotKeyFor('area', undefined)]: 8760 },
        },
      ],
    });
    assert.ok(full[0].replaceReason.includes('Replaces'));
    assert.ok(
      !full[0].replaceReason.includes('8,760 hours'),
      'a full year earns no coverage sentence',
    );

    // A table from a bundle written before the record existed: unknown, and
    // unknown must not be described as a partial year OR as a full one.
    for (const hours of [undefined, { [slotKeyFor('area', undefined)]: null }]) {
      const unknown = planImports(files, 'one-case', {
        caseName: 'Existing Study',
        existingCases: [
          {
            name: 'Existing Study',
            occupiedSlots: [slotKeyFor('area', undefined)],
            slotHours: hours,
          },
        ],
      });
      assert.equal(unknown[0].replacesExisting, true);
      assert.ok(!unknown[0].replaceReason.includes('covers'), 'unknown coverage is not reported');
    }
  },
);

check('a same-batch collision alone raises the blocking flag but not a replace', () => {
  const files = [
    { name: 'first.csv', detected: detected('area', { shape: 'L' }) },
    { name: 'second.csv', detected: detected('area', { shape: 'W' }) },
  ];
  const plans = planImports(files, 'one-case', { caseName: 'Fresh Case' });

  for (const p of plans) {
    assert.equal(p.slotConflict, true, 'same-batch collision must block');
    assert.equal(
      p.replacesExisting,
      false,
      'no existing case was involved -- this is not a replace',
    );
    assert.equal(p.replaceReason, undefined);
  }
});

check(
  'a plan can be BOTH a same-batch collision AND a replace, and the blocking flag still blocks',
  () => {
    const files = [
      { name: 'first.csv', detected: detected('area', { shape: 'L' }) },
      { name: 'second.csv', detected: detected('area', { shape: 'W' }) },
    ];
    const plans = planImports(files, 'one-case', {
      caseName: 'Existing Study',
      existingCases: [{ name: 'Existing Study', occupiedSlots: [slotKeyFor('area', undefined)] }],
    });

    // Each names the other, and both name the replace: a row can carry the
    // blocking line and the warning line at once without either standing in
    // for the other.
    assert.ok(plans[0].conflictReason.includes('second.csv'));
    assert.ok(plans[1].conflictReason.includes('first.csv'));
    for (const p of plans) {
      assert.equal(p.caseIsNew, false);
      assert.equal(p.slotConflict, true, 'the same-batch collision still blocks');
      assert.equal(p.replacesExisting, true, 'the target slot really is already occupied too');
      assert.ok(p.replaceReason.includes('Replaces'));
    }
  },
);

// --- 6/7. double-undefined-variant collision, then cleared ------------------

const f9Files = [
  {
    name: 'unreadable1.csv',
    detected: detected('interface', {
      confidence: 'low',
      variant: undefined,
      reason:
        'unreadable1.csv: line 5 matches Interface, but the title line carries no readable quoted quantity.',
    }),
  },
  {
    name: 'unreadable2.csv',
    detected: detected('interface', {
      confidence: 'low',
      variant: undefined,
      reason:
        'unreadable2.csv: line 5 matches Interface, but the title line carries no readable quoted quantity.',
    }),
  },
];

check('F9 (1/2): two Interface files with unreadable title lines collide on one Case', () => {
  const collided = planImports(f9Files, 'one-case', { caseName: 'One Case' });
  assert.equal(collided[0].variant, undefined);
  assert.equal(collided[1].variant, undefined);
  assert.equal(collided[0].slotConflict, true, 'F9: first file must report the collision');
  assert.equal(collided[1].slotConflict, true, 'F9: second file must report the collision');
  // The ordinary collision sentence. It must never point at a control that
  // does not exist (there is no quantity field); the real recovery is named
  // in the summary (pinned in tests/test_dom_contract.mjs).
  assert.ok(
    !/variant\s+override/i.test(collided[0].conflictReason),
    'the message must not instruct the user to give a file a variant override',
  );
  // The counterpart, not the pair -- the row names its own file already.
  assert.equal(collided[0].conflictReason, 'Overlaps with "unreadable2.csv".');
  assert.equal(collided[1].conflictReason, 'Overlaps with "unreadable1.csv".');
  assert.equal(
    slotKeyFor(collided[0].kind, collided[0].variant),
    slotKeyFor(collided[1].kind, collided[1].variant),
    'both files land on the SAME slot key before the override clears it',
  );
});

check(
  'F9 (2/2): a variantOverride on one file clears the collision for BOTH, yielding two distinct slot keys',
  () => {
    const cleared = planImports(f9Files, 'one-case', {
      caseName: 'One Case',
      overrides: { 0: { variantOverride: 'Power Flow (MW)' } },
    });
    assert.equal(
      cleared[0].slotConflict,
      false,
      "F9: overriding one file's variant clears its own collision",
    );
    assert.equal(
      cleared[1].slotConflict,
      false,
      "F9: ...and clears the OTHER file's collision too",
    );
    assert.equal(cleared[0].conflictReason, undefined);
    assert.equal(cleared[1].conflictReason, undefined);
    assert.equal(cleared[0].variant, 'Power Flow (MW)');
    assert.equal(cleared[1].variant, undefined);

    const slotA = slotKeyFor(cleared[0].kind, cleared[0].variant);
    const slotB = slotKeyFor(cleared[1].kind, cleared[1].variant);
    assert.notEqual(slotA, slotB, 'F9: the override yields two DISTINCT slot keys');
  },
);

// --- 8. same-filename overrides are applied per ROW, not collapsed ---------
//
// Overrides are keyed by file index, so same-named files keep their own.

check(
  "individual mode applies each row's override independently even when two files share a name",
  () => {
    const files = [
      { name: 'run.csv', detected: detected('area') },
      { name: 'run.csv', detected: detected('area') },
    ];
    const plans = planImports(files, 'individual', {
      overrides: {
        0: { caseName: 'Case A', kindOverride: 'area' },
        1: { caseName: 'Case B', kindOverride: 'interface', variantOverride: 'Power Flow (MW)' },
      },
    });

    assert.equal(
      plans[0].caseName,
      'Case A',
      "row 0's own caseName must survive, not be overwritten by row 1's",
    );
    assert.equal(plans[0].kind, 'area');
    assert.equal(plans[1].caseName, 'Case B');
    assert.equal(plans[1].kind, 'interface');
    assert.equal(plans[1].variant, 'Power Flow (MW)');
    // Distinct case names -> no collision, even though both files are named
    // 'run.csv' and a name-keyed implementation would have collapsed them.
    assert.equal(plans[0].slotConflict, false);
    assert.equal(plans[1].slotConflict, false);
  },
);

check('planImports populates fileIndex on each plan', () => {
  const files = [
    { name: 'area1.csv', detected: detected('area') },
    { name: 'area2.csv', detected: detected('area') },
  ];
  const plans = planImports(files, 'one-case', { caseName: 'Study A' });
  assert.equal(plans[0].fileIndex, 0);
  assert.equal(plans[1].fileIndex, 1);
});

// ------------------------------------------------- interface limits (scope)
//
// The scope DEFAULT, which is what the analyst gets without clicking.

check('one limits file in a batch defaults to every Case', () => {
  const plans = planLimits(
    [{ name: 'Limits.csv', detected: detected('interfacelimit') }],
    ['Run A', 'Run B'],
  );
  assert.deepEqual(plans[0].scope, { kind: 'all' });
  assert.equal(plans[0].fileIndex, 0);
});

check(
  'two limits files default to a Case each, matched by name where the name is in the file',
  () => {
    const plans = planLimits(
      [
        { name: 'Limits_HighLoad.csv', detected: detected('interfacelimit') },
        { name: 'Limits_LowLoad.csv', detected: detected('interfacelimit') },
      ],
      ['LowLoad', 'HighLoad'],
    );
    assert.deepEqual(plans[0].scope, { kind: 'case', caseName: 'HighLoad' });
    assert.deepEqual(plans[1].scope, { kind: 'case', caseName: 'LowLoad' });
  },
);

check(
  'a filename matching no Case falls back to the first, where it is visible and correctable',
  () => {
    const plans = planLimits(
      [
        { name: 'a.csv', detected: detected('interfacelimit') },
        { name: 'b.csv', detected: detected('interfacelimit') },
      ],
      ['Run A', 'Run B'],
    );
    assert.deepEqual(plans[0].scope, { kind: 'case', caseName: 'Run A' });
  },
);

check('with no Cases to point at, every limits file is shared', () => {
  const plans = planLimits(
    [
      { name: 'a.csv', detected: detected('interfacelimit') },
      { name: 'b.csv', detected: detected('interfacelimit') },
    ],
    [],
  );
  assert.deepEqual(plans[0].scope, { kind: 'all' });
  assert.deepEqual(plans[1].scope, { kind: 'all' });
});

check("the user's correction wins over the derived default", () => {
  const plans = planLimits(
    [{ name: 'Limits.csv', detected: detected('interfacelimit') }],
    ['Run A'],
    {
      0: { kind: 'case', caseName: 'Run A' },
    },
  );
  assert.deepEqual(plans[0].scope, { kind: 'case', caseName: 'Run A' });
});

check('a limits file never becomes an ImportPlan, so it can never claim a slot', () => {
  // The refusal is the planner's, by name: `planImports` narrows to TableKind
  // and refuses anything else rather than mis-typing it as one.
  assert.throws(
    () =>
      planImports([{ name: 'Limits.csv', detected: detected('interfacelimit') }], 'one-case', {
        caseName: 'Run A',
      }),
    /not an importable table kind/,
  );
});

check("a drop naming a Case's original name or its display name joins that Case", () => {
  const existingCases = [
    { name: '2030_HL_v3', displayName: 'High Load', occupiedSlots: [slotKeyFor('area')] },
  ];
  const files = [
    { name: 'a.csv', detected: detected('area') },
    { name: 'b.csv', detected: detected('interface', { variant: 'Power Flow (MW)' }) },
  ];
  for (const typed of ['2030_HL_v3', 'High Load']) {
    const plans = planImports(files, 'one-case', { caseName: typed, existingCases });
    for (const plan of plans) {
      assert.equal(plan.caseName, '2030_HL_v3', `${typed}: planned under the Case's name`);
      assert.equal(plan.caseIsNew, false, `${typed}: an existing Case`);
    }
    assert.equal(plans[0].replacesExisting, true, `${typed}: its occupied slot is a replace`);
  }
  // Two files in one batch, one typed each way, are ONE Case: one slot.
  const both = planImports(
    [files[0], { name: 'c.csv', detected: detected('area') }],
    'individual',
    {
      overrides: { 0: { caseName: 'High Load' }, 1: { caseName: '2030_HL_v3' } },
      existingCases,
    },
  );
  assert.ok(
    both.every((plan) => plan.merges),
    'both halves land on the same slot',
  );
});

console.log(`\n${passed} check(s) passed.`);
