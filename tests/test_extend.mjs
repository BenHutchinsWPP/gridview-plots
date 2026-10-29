// tests/test_extend.mjs — whether a table's years fit its Case: `judgeSpan`
// for one table landing on one slot, by its resulting span (the slot's years
// joined with the file's on an add, the file's alone on a replace), and
// `settleSpans` for a Case's held extensions when the drop ends.
//
// Run: node tests/test_extend.mjs

import './test_loader.mjs';

import assert from 'node:assert/strict';

const { judgeSpan, settleSpans, settleRefusal } = await import('../src/app/extend.ts');

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`ok - ${name}`);
}

const span = (firstYear, numYears = 1) => ({ firstYear, numYears });
const held = (s, holder = "S's Area table") => ({ span: s, holder });

check('judgeSpan: one table on one slot, by its resulting span', () => {
  // [label, group, slotSpan, caseSpan, mode, expected]
  const rows = [
    ['no Case span accepts', span(2035), null, null, 'add', { accept: true }],
    ['equal to the Case span', span(2034, 2), null, span(2034, 2), 'replace', { accept: true }],
    [
      'a replace strictly containing the Case extends it',
      span(2034, 3),
      span(2034, 2),
      span(2034, 2),
      'replace',
      { accept: true, extendsTo: span(2034, 3) },
    ],
    [
      'an add joins the slot: a later year extends',
      span(2036),
      span(2034, 2),
      span(2034, 2),
      'add',
      { accept: true, extendsTo: span(2034, 3) },
    ],
    [
      'an add joins the slot: an earlier year extends',
      span(2033),
      span(2034, 2),
      span(2034, 2),
      'add',
      { accept: true, extendsTo: span(2033, 3) },
    ],
    [
      'an add inside the slot leaves the span as it is',
      span(2035),
      span(2034, 2),
      span(2034, 2),
      'add',
      { accept: true },
    ],
    [
      'an add onto an empty slot is the file alone, equal',
      span(2034, 2),
      null,
      span(2034, 2),
      'add',
      { accept: true },
    ],
  ];
  for (const [label, group, slotSpan, caseSpan, mode, expected] of rows) {
    assert.deepEqual(
      judgeSpan(group, slotSpan, caseSpan && held(caseSpan), mode, ['x.csv']),
      expected,
      label,
    );
  }
});

check('judgeSpan refuses a span that does not contain the Case span', () => {
  const short = judgeSpan(span(2034), null, held(span(2034, 3)), 'replace', ['x.csv']);
  assert.deepEqual(short, {
    accept: false,
    note:
      "x.csv spans 2034, but S's Area table spans 2034-2036. One Case holds one run of " +
      'years; load it as its own Case.',
  });
  // Overlapping but neither containing: 2035-2036 against 2034-2035.
  assert.equal(
    judgeSpan(span(2035, 2), null, held(span(2034, 2)), 'replace', ['x.csv']).accept,
    false,
  );
  // The same file as a replace of the slot that set the span is judged
  // against what the rest of the Case states, which the caller passes.
  assert.equal(judgeSpan(span(2034), span(2034, 3), null, 'replace', ['x.csv']).accept, true);
  // A replace is the file alone: a slot of 2034-2036 does not lend its years.
  assert.equal(
    judgeSpan(span(2034), span(2034, 3), held(span(2034, 3)), 'replace', ['x.csv']).accept,
    false,
  );
  const two = judgeSpan(span(2034), null, held(span(2034, 3)), 'replace', ['a.csv', 'b.csv']);
  assert.match(two.note, /^a\.csv and b\.csv together span 2034, but .*load them as their own/);
});

check('judgeSpan names the joined span when an add still falls short', () => {
  // The slot is Generator 2035; the Case's Area table states 2034-2036.
  const verdict = judgeSpan(span(2036), span(2035), held(span(2034, 3)), 'add', ['g.csv']);
  assert.deepEqual(verdict, {
    accept: false,
    note:
      "g.csv spans 2036, 2035-2036 with the table it adds to, but S's Area table spans " +
      '2034-2036. One Case holds one run of years; load it as its own Case.',
  });
});

check('judgeSpan refuses an add that skips a year, or runs too long', () => {
  const gap = judgeSpan(span(2037), span(2034, 2), held(span(2034, 2)), 'add', ['x.csv']);
  assert.equal(gap.accept, false);
  assert.match(
    gap.note,
    /^x\.csv and the table it adds to have rows for 2034-2035 and 2037 but none for 2036\./,
  );
  const long = judgeSpan(span(2036, 255), span(2034, 2), held(span(2034, 2)), 'add', ['x.csv']);
  assert.equal(long.accept, false);
  assert.match(long.note, /cover 2034-2290, 257 years\. A Case spans at most 256 years/);
  // A replace is the file alone: the same files raise neither.
  assert.equal(judgeSpan(span(2037), span(2034, 2), null, 'replace', ['x.csv']).accept, true);
});

const entry = (slot, s, holder = `S's ${slot.trim()} table`) => ({ slot, span: s, holder });

check('settleSpans: every held and committed table must state the target', () => {
  // Area and Generator both extended to 2034-2036: accept.
  assert.deepEqual(
    settleSpans(
      [entry('area ', span(2034, 2)), entry('generator ', span(2034, 2))],
      [entry('area ', span(2034, 3)), entry('generator ', span(2034, 3))],
    ),
    { accept: true, span: span(2034, 3) },
  );
  // A one-table Case: the committed table on the held slot is not judged.
  assert.deepEqual(settleSpans([entry('area ', span(2034, 2))], [entry('area ', span(2034, 3))]), {
    accept: true,
    span: span(2034, 3),
  });
  // An Area-only extension of a two-kind Case: the Generator table differs.
  assert.deepEqual(
    settleSpans(
      [entry('area ', span(2034, 2)), entry('generator ', span(2034, 2))],
      [entry('area ', span(2034, 3))],
    ),
    {
      accept: false,
      target: span(2034, 3),
      differ: [{ holder: "S's generator table", span: span(2034, 2) }],
    },
  );
  // Two held extensions in opposite directions: the target is their union,
  // and each held table that does not state it differs.
  const both = settleSpans([], [entry('area ', span(2033, 3)), entry('generator ', span(2034, 3))]);
  assert.deepEqual(both, {
    accept: false,
    target: span(2033, 4),
    differ: [
      { holder: "S's area table", span: span(2033, 3) },
      { holder: "S's generator table", span: span(2034, 3) },
    ],
  });
});

check('settleRefusal names the files, the run and each table that differs', () => {
  assert.equal(
    settleRefusal(['area-2036.csv'], span(2034, 3), [
      { holder: "S's Generator table", span: span(2034, 2) },
    ]),
    "area-2036.csv would make this Case 2034-2036, but S's Generator table spans 2034-2035. " +
      'Every table of a Case states the same years, so it is refused and the loaded tables ' +
      "are kept. Drop the other tables' years in the same drop, or load it as its own Case.",
  );
  assert.match(
    settleRefusal(['a.csv', 'b.csv'], span(2034, 3), [
      { holder: "S's Bus LMP table", span: span(2034, 2) },
      { holder: "S's Generator table", span: span(2035, 1) },
    ]),
    /but S's Bus LMP table spans 2034-2035 and S's Generator table spans 2035\. .*they are refused/,
  );
});

console.log(`\n${checks} extend checks passed.`);
