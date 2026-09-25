// tests/test_detect.mjs — the format classifier, fed plain Uint8Arrays of a
// file's opening bytes. Misdetection is worse than non-detection, so
// truncated and empty input are tested alongside the fixtures.
//

import assert from 'node:assert/strict';
import './test_loader.mjs';
import { exportCsv, groupingsCsv } from './test_fixtures.mjs';
import { exportCsv as interfaceExportCsv } from './test_fixtures_interface.mjs';

const { classify, DETECT_PROBE_BYTES } = await import('../src/detect.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const enc = (s) => new TextEncoder().encode(s);
function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function assertNonEmptyReason(result) {
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'reason must not be empty');
}

// --- 1. A real Area export -------------------------------------------------

check('a real Area export classifies as area, high confidence, variant undefined', () => {
  const result = classify(exportCsv({ days: 1, hours: 1 }), 'export.csv');
  assert.equal(result.kind, 'area');
  assert.equal(result.confidence, 'high');
  assert.equal(result.variant, undefined);
  assertNonEmptyReason(result);
});

// --- 2. A Groupings.csv -----------------------------------------------------

check('a Groupings.csv classifies as groupings, high confidence', () => {
  const result = classify(enc(groupingsCsv()), 'Groupings.csv');
  assert.equal(result.kind, 'groupings');
  assert.equal(result.confidence, 'high');
  assert.equal(result.variant, undefined);
  assertNonEmptyReason(result);
});

check(
  'the Groupings check is case-insensitive and tolerates stray spaces, matching main.ts today',
  () => {
    const result = classify(enc('  Name , Grouping \r\nAREA01,Zone 1\r\n'), 'weird-groupings.csv');
    assert.equal(result.kind, 'groupings');
  },
);

// Each group editor's saved header as the file carries it, so an editor's
// file drops back in. `Name,Grouping` has two writers: the pane asks.
const EDITOR_HEADERS = [
  ['Name,Grouping', ['area', 'generator']],
  ['BusID,Grouping', ['bus']],
  ['Name,Grouping,Direction', ['interface']],
  ['Name,Bus ID,Unit ID,Grouping', ['generator']],
];
for (const [header] of EDITOR_HEADERS) {
  check(`an editor's "${header}" file classifies as groupings`, () => {
    const result = classify(enc(`${header}\r\nSAMPLE_X,SAMPLE_G\r\n`), 'saved.csv');
    assert.equal(result.kind, 'groupings', result.reason);
    assert.equal(result.confidence, 'high');
  });
}
for (const [header, writtenBy] of EDITOR_HEADERS) {
  check(`"${header}" names every kind that writes it: ${writtenBy}`, () => {
    const result = classify(enc(`${header}\r\nSAMPLE_X,SAMPLE_G\r\n`), 'saved.csv');
    assert.deepEqual([...(result.writtenBy ?? [])].sort(), writtenBy);
  });
}

// The whole header must match, not a pattern: a file that merely has a
// `Grouping` column is not one this app wrote.
for (const header of ['BusID,Grouping,Notes', 'Grouping,Name', 'Area,Grouping', 'Name']) {
  check(`"${header}" is not a membership file`, () => {
    assert.notEqual(classify(enc(`${header}\nSAMPLE_X,SAMPLE_G\n`), 'x.csv').kind, 'groupings');
  });
}

const { MEMBERSHIP_HEADERS } = await import('../src/tables/registry.ts');
check("every header a kind's editor declares classifies as that kind's groupings", () => {
  assert.ok(MEMBERSHIP_HEADERS.length >= 4);
  for (const { kind, columns } of MEMBERSHIP_HEADERS) {
    const result = classify(enc(`${columns.join(',')}\n`), 'saved.csv');
    assert.equal(result.kind, 'groupings', `${kind}: ${columns.join(',')}`);
    assert.ok(result.writtenBy.includes(kind), `${kind}: ${columns.join(',')}`);
  }
});

// --- 3. Saved-bundle byte prefixes -------------------------------------

check('a GVAP-shaped byte prefix classifies as bundle, high confidence', () => {
  // Mirrors storage.ts's on-disk shape: magic, then a 4-byte manifest
  // length, then arbitrary (here: non-UTF8-safe) bytes -- classify() must
  // not choke decoding a binary tail it never looks past the magic for.
  const tail = new Uint8Array([0, 0, 0, 4, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]);
  const result = classify(concatBytes(enc('GVAP'), tail), 'study.gvap');
  assert.equal(result.kind, 'bundle');
  assert.equal(result.confidence, 'high');
  assert.equal(result.variant, undefined);
  assertNonEmptyReason(result);
});

check(
  'a GVMB-prefixed blob classifies as bundle, high confidence (the v3 magic this build writes)',
  () => {
    // `GVMB` must stay in detect.ts's list (it imports storage's
    // `READABLE_MAGICS`), or a saved bundle cannot be reloaded.
    const tail = new Uint8Array([0, 0, 0, 4, 0x7b, 0x22, 0x76, 0x22]); // '{"v'
    const result = classify(concatBytes(enc('GVMB'), tail), 'study.gvmb');
    assert.equal(result.kind, 'bundle');
    assert.equal(result.confidence, 'high');
    assert.equal(result.variant, undefined);
    assertNonEmptyReason(result);
  },
);

check('a GVIP-shaped byte prefix (legacy Interface-only bundle) classifies as bundle', () => {
  // GVIP (legacy) is binary like GVAP and must be recognised, or a .gvip file
  // cannot reach the migration.
  const tail = new Uint8Array([0, 0, 0, 4, 0xff, 0xfe, 0x00, 0x01]);
  const result = classify(concatBytes(enc('GVIP'), tail), 'flows.gvip');
  assert.equal(result.kind, 'bundle');
  assert.equal(result.confidence, 'high');
  assertNonEmptyReason(result);
});

check(
  'a truncated bundle probe (fewer bytes than the magic) is not falsely claimed as bundle',
  () => {
    // Only 3 of "GVAP"'s 4 bytes are present -- a short read must not match.
    const result = classify(enc('GVA'), 'truncated.gvap');
    assert.notEqual(result.kind, 'bundle');
  },
);

// --- 4. Garbage / unrecognized input ----------------------------------------

check('a garbage CSV classifies as unrecognized, low confidence, with a non-empty reason', () => {
  const result = classify(enc('foo,bar,baz\n1,2,3\n'), 'mystery.csv');
  assert.equal(result.kind, 'unrecognized');
  // 'unrecognized' is never a positive identification.
  assert.equal(result.confidence, 'low');
  assert.equal(result.variant, undefined);
  assertNonEmptyReason(result);
});

check('an empty file classifies as unrecognized, low confidence, not a crash', () => {
  const result = classify(new Uint8Array(0), 'empty.csv');
  assert.equal(result.kind, 'unrecognized');
  assert.equal(result.confidence, 'low');
  assertNonEmptyReason(result);
});

check(
  'a header line truncated mid-column (no Name/TOU) classifies as unrecognized, low confidence',
  () => {
    // A cut-off header cannot be told from unknown input: never 'high'.
    const result = classify(enc('Date,Hour,TO'), 'cut-off.csv');
    assert.equal(result.kind, 'unrecognized');
    assert.equal(result.confidence, 'low');
    assertNonEmptyReason(result);
  },
);

check(
  'a single comma with no key columns at all classifies as unrecognized, low confidence',
  () => {
    const result = classify(enc(','), 'blank.csv');
    assert.equal(result.kind, 'unrecognized');
    assert.equal(result.confidence, 'low');
    assertNonEmptyReason(result);
  },
);

// --- 5. Interface exports ----------------------------------------------
//
// SHAPE (line 5 is a Date,Hour,TOU header) says wide; KIND is the title's
// first word. The quoted quantity is variant-only and rejects nothing.

check(
  'a real Interface export classifies as interface, high confidence, with the title-line quantity as variant',
  () => {
    const result = classify(interfaceExportCsv({ days: 1, hours: 1 }), 'flows.csv');
    assert.equal(result.kind, 'interface');
    assert.equal(result.confidence, 'high');
    assert.equal(result.variant, 'Power Flow (MW)');
    // `quantity` is what the dialog shows; `variant` keys the slot. They agree
    // here and diverge for a wide Area export.
    assert.equal(result.quantity, 'Power Flow (MW)');
    assertNonEmptyReason(result);
  },
);

check(
  'an Interface export whose title line carries no readable quantity is still interface, but low confidence with variant undefined',
  () => {
    // Keep the real preamble length and the real (valid) header on line 5 --
    // only line 1 changes, to an unquoted title parseTitleLine cannot read
    // (header.ts:93-101 -- it never throws, it just yields '').
    const full = new TextDecoder('utf-8').decode(interfaceExportCsv({ days: 1, hours: 1 }));
    const rows = full.split('\r\n');
    rows[0] = 'Interface Hourly Report -- no quoted quantity here';
    const result = classify(enc(rows.join('\r\n')), 'unlabeled-flows.csv');
    assert.equal(result.kind, 'interface');
    assert.equal(result.confidence, 'low');
    assert.equal(result.variant, undefined);
    assert.match(result.reason, /title line/i, 'reason must name the unreadable title line');
    assertNonEmptyReason(result);
  },
);

// --- the wide shape is not the Interface kind ----------------------------
//
// Every wide kind is structurally identical, so only the title's first word
// separates them. An entity word no adapter claims must be refused BY NAME,
// never fall through to a neighbouring kind. `Zone` and `Reserve` stand in
// for such a word.

/** A wide export of any kind, in the real four-line-preamble layout. */
function wideExportCsv(entityWord, quantity, names) {
  return [
    `${entityWord} Hourly '${quantity}' Data for Year 2035`,
    '',
    `(From the first hour of 1/1/2035 to the last hour of 12/31/2035. Column identifier -- ${entityWord} Name)`,
    '',
    ['Date', ' Hour', ' TOU', ...names].join(','),
    ['1/1/2035', '1', 'OffPeak', ...names.map(() => '1.5')].join(','),
  ].join('\r\n');
}

for (const [entityWord, quantity, names] of [
  ['Zone', 'Load (MWh)', ['ZONE_A', 'ZONE_B']],
  ['Reserve', 'Spinning (MW)', ['RES_1', 'RES_2']],
]) {
  check(
    `a wide ${entityWord} export is NOT classified as interface, and its reason names "${entityWord}"`,
    () => {
      const result = classify(
        enc(wideExportCsv(entityWord, quantity, names)),
        `wide-${entityWord.toLowerCase()}.csv`,
      );
      assert.notEqual(
        result.kind,
        'interface',
        `a wide ${entityWord} export must never route to the Interface parser`,
      );
      assert.equal(result.kind, 'unrecognized');
      assert.equal(result.confidence, 'low');
      assert.equal(result.variant, undefined, 'a refused file must not carry a slot variant');
      assert.match(
        result.reason,
        new RegExp(entityWord),
        'the reason must name the entity kind that was found',
      );
      assertNonEmptyReason(result);
    },
  );
}

// --- bus and generator route too, and bus's header is on line 6 ---------
check(
  'a wide Generator export classifies as generator/W, with its quantity as the slot variant',
  () => {
    const result = classify(
      enc(wideExportCsv('Generator', 'Generation (MWh)', ['2018 G40 1 PV-T', '2021 G2 1 PV-T'])),
      'generators.csv',
    );
    assert.equal(result.kind, 'generator');
    assert.equal(result.shape, 'W');
    assert.equal(result.confidence, 'high');
    assert.equal(result.variant, 'Generation (MWh)');
    assert.equal(
      result.quantity,
      'Generation (MWh)',
      'variant and quantity agree for a slot-keyed kind',
    );
  },
);

check(
  'a wide Bus export classifies as bus/W, with its header found on LINE 6 under the id row',
  () => {
    // The id row is what makes bus different, and it is the whole difference:
    // five preamble lines instead of four, which is a NUMBER.
    const result = classify(
      enc(
        [
          `Bus Hourly 'LMP ($/MWh)' Data for Year 2035`,
          '',
          '(From the first hour of 1/1/2035 to the last hour of 12/31/2035. Column identifier -- BusName)',
          '',
          ',,BusNumber,10001,10002',
          'Date, Hour, TOU,HAWTHORNE,ASPENDALE',
          '1/1/2035,1,OffPeak,1.5,2.5',
        ].join('\r\n'),
      ),
      'buses.csv',
    );
    assert.equal(result.kind, 'bus');
    assert.equal(result.shape, 'W');
    assert.equal(result.confidence, 'high');
    assert.equal(result.variant, 'LMP ($/MWh)');
    assert.match(result.reason, /line 6/, 'the reason names the line the header was actually on');
  },
);

// --- a wide Area export ROUTES, and says which shape it is --------------
check(
  'a wide Area export classifies as area with shape W, not as interface and not as unrecognized',
  () => {
    const result = classify(
      enc(wideExportCsv('Area', 'Load (MWh)', ['AREA_AE', 'AREA_AV', 'AREA_AZ'])),
      'All Areas Full Year Single Characteristic.csv',
    );
    assert.equal(result.kind, 'area', 'the entity word routes it to the Area kind');
    assert.equal(result.shape, 'W', 'and the shape tells the router which parser reads it');
    assert.equal(result.confidence, 'high');
    // The quantity is REPORTED but is not a slot key: one Case holds one Area
    // table. The Import Dialog shows it, because for a wide Area export it is
    // the cube's single metric and the user needs to see it was read.
    assert.equal(
      result.quantity,
      'Load (MWh)',
      'the title line names the metric, and it is reported',
    );
    assert.equal(result.variant, undefined, 'but it is NOT the Area slot variant');
    assert.match(result.reason, /wide Area export/, 'the reason says which shape it matched');
    assertNonEmptyReason(result);
  },
);

check('a LONG Area export still classifies as area, and carries shape L', () => {
  const result = classify(
    enc(['Date,Hour,TOU,Name,Load (MWh)', '1/1/2035,1,OffPeak,AREA_AE,1.5'].join('\r\n')),
    'Area ful year multiple characteristics.csv',
  );
  assert.equal(result.kind, 'area');
  assert.equal(result.shape, 'L', 'kind is not shape: the same kind, the other layout');
  assert.equal(result.confidence, 'high');
});

check(
  'a wide Area export whose title line carries no quantity is area/W but LOW confidence',
  () => {
    // Detection still routes a wide Area file with no quantity;
    // `src/tables/area/wide.ts` refuses it at the case-plan read.
    const rows = wideExportCsv('Area', 'Load (MWh)', ['AREA_AE', 'AREA_AV']).split('\r\n');
    rows[0] = 'Area Hourly Data for Year 2035';
    const result = classify(enc(rows.join('\r\n')), 'no-quantity.csv');
    assert.equal(result.kind, 'area');
    assert.equal(result.shape, 'W');
    assert.equal(result.confidence, 'low', 'an unreadable quantity is reported, never guessed');
  },
);

check(
  'a wide export whose title line has no readable entity word degrades to unrecognized, not to interface',
  () => {
    // The real files pad every preamble line out with the row's commas, so a
    // title line that lost its text is `,,,,` -- not empty, and with no leading
    // word. It must fail the gate rather than fall through it.
    const full = new TextDecoder('utf-8').decode(interfaceExportCsv({ days: 1, hours: 1 }));
    const rows = full.split('\r\n');
    rows[0] = ',,,,,,,';
    const result = classify(enc(rows.join('\r\n')), 'no-title.csv');
    assert.notEqual(result.kind, 'interface');
    assert.equal(result.kind, 'unrecognized');
    assert.equal(result.confidence, 'low');
    assert.equal(result.variant, undefined);
    assert.match(
      result.reason,
      /entity kind/i,
      'the reason must say the entity word was unreadable',
    );
    assertNonEmptyReason(result);
  },
);

check(
  'an Interface-shaped 4-line preamble with no header line at all is unrecognized, naming the preamble count',
  () => {
    // Real preamble (title, blank, date-range note, blank) -- but the file
    // stops before line 5's column header, so the only positive Interface
    // signal never fires.
    const full = new TextDecoder('utf-8').decode(interfaceExportCsv({ days: 1, hours: 1 }));
    const preambleOnly = full.split('\r\n').slice(0, 4).join('\r\n');
    const result = classify(enc(preambleOnly), 'truncated-preamble.csv');
    assert.equal(result.kind, 'unrecognized');
    assert.equal(result.confidence, 'low');
    assert.match(result.reason, /4 line/, 'reason must name how many lines were actually present');
    assert.match(result.reason, /preamble/i, 'reason must name the preamble expectation');
    assertNonEmptyReason(result);
  },
);

check('a 5-line file whose line 5 is not Date,Hour,TOU is unrecognized', () => {
  const full = new TextDecoder('utf-8').decode(interfaceExportCsv({ days: 1, hours: 1 }));
  const preamble = full.split('\r\n').slice(0, 4);
  const badHeader = 'Foo,Bar,Baz,Qux';
  const result = classify(enc([...preamble, badHeader].join('\r\n')), 'bad-header.csv');
  assert.equal(result.kind, 'unrecognized');
  assert.equal(result.confidence, 'low');
  assertNonEmptyReason(result);
});

check(
  'a file matching BOTH an Area header (line 1) and an Interface header (line 5) is unrecognized -- never pick',
  () => {
    const lines = [
      'Date,Hour,TOU,Name,M01', // a valid Area header
      '',
      '',
      '',
      'Date,Hour,TOU,P01', // a valid Interface header, on line 5
    ];
    const result = classify(enc(lines.join('\r\n')), 'ambiguous.csv');
    assert.equal(result.kind, 'unrecognized');
    assert.equal(result.variant, undefined);
    assert.match(result.reason, /both/i, 'reason must name the ambiguity');
    assertNonEmptyReason(result);
  },
);

check(
  'a BOM-prefixed Interface export still classifies as interface, with an unpolluted variant',
  () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const result = classify(
      concatBytes(bom, interfaceExportCsv({ days: 1, hours: 1 })),
      'flows-bom.csv',
    );
    assert.equal(result.kind, 'interface');
    assert.equal(result.confidence, 'high');
    // The exact string, not trimmed: `.trim()` would eat a leaked U+FEFF.
    assert.equal(result.variant, 'Power Flow (MW)');
  },
);

// --- 6. A BOM-prefixed Area CSV ----------------------------------------

check('a BOM-prefixed Area export still classifies as area, high confidence', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const result = classify(concatBytes(bom, exportCsv({ days: 1, hours: 1 })), 'export-bom.csv');
  assert.equal(result.kind, 'area');
  assert.equal(result.confidence, 'high');
  assertNonEmptyReason(result);
});

check('a BOM-prefixed Groupings.csv still classifies as groupings', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const result = classify(concatBytes(bom, enc(groupingsCsv())), 'groupings-bom.csv');
  assert.equal(result.kind, 'groupings');
});

check('a BOM-prefixed garbage file that is still unrecognized says so, naming the BOM', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  // The filename avoids "bom" so the match can only come from classify().
  const result = classify(concatBytes(bom, enc('nope,nope,nope\n')), 'garbage-x.csv');
  assert.equal(result.kind, 'unrecognized');
  assert.equal(result.confidence, 'low');
  assert.match(
    result.reason,
    /BOM/i,
    'reason must name the stripped BOM, not just echo the filename',
  );
});

// --- 7. The truncation-safe rule -----------------------------------------
//
// A bus-width header (~136 KB) exceeds DETECT_PROBE_BYTES (64 KiB), so every
// branch must decide from a prefix. These cut a wider-than-probe header at
// the probe size and assert the routing holds; each width guard ensures the
// cut really happens.

/** `count` synthetic entity names of the length the perf ladder measures (22
 * characters), so the header line here is the same size per column as the one
 * the report weighed. */
function wideNames(count, prefix) {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}${String(i + 1).padStart(22 - prefix.length, '0')}`,
  );
}

const BUS_WIDTH = 5900;

check(
  'an Interface header line too wide for the probe still routes to interface, with its variant',
  () => {
    const names = wideNames(BUS_WIDTH, 'SYNTH_BUS_');
    const header = ['Date', ' Hour', ' TOU', ...names].join(',');
    assert.ok(
      header.length > DETECT_PROBE_BYTES,
      `header line (${header.length} B) must exceed the ${DETECT_PROBE_BYTES} B probe, or this check proves nothing`,
    );

    const file = [
      "Interface Hourly 'Power Flow (MW)' Data for Year 2034",
      '',
      '(From the first hour of 1/1/2034 to the last hour of 12/31/2034. Column identifier -- InterfaceName)',
      '',
      header,
      ['1/1/2034', '1', 'OffPeak', ...names.map(() => '1.5')].join(','),
    ].join('\r\n');

    // Exactly what src/main.ts hands classify(): the file's first
    // DETECT_PROBE_BYTES bytes, cut mid-header-line.
    const probe = enc(file).slice(0, DETECT_PROBE_BYTES);
    assert.equal(probe.length, DETECT_PROBE_BYTES);

    const result = classify(probe, 'bus-width-flows.csv');
    assert.equal(result.kind, 'interface');
    assert.equal(result.confidence, 'high');
    assert.equal(
      result.variant,
      'Power Flow (MW)',
      'the variant comes from line 1, which truncation never reaches',
    );
    assertNonEmptyReason(result);
  },
);

check(
  'the entity gate reads the title of a bus-width file whose header line the probe truncates',
  () => {
    // Shape comes from the (truncated) header, kind from line 1 (never
    // truncated). An unclaimed word yields a refusal naming it, which only
    // line 1 can produce.
    const names = wideNames(BUS_WIDTH, 'SYNTH_ZONE_');
    const file = wideExportCsv('Zone', 'LMP ($/MWh)', names);
    const probe = enc(file).slice(0, DETECT_PROBE_BYTES);
    assert.equal(probe.length, DETECT_PROBE_BYTES, 'this check needs a genuinely truncated probe');

    const result = classify(probe, 'zone-width.csv');
    assert.equal(result.kind, 'unrecognized');
    assert.match(
      result.reason,
      /Zone/,
      'the entity word survives a cut that removes most of line 5',
    );
  },
);

check('a bus-width BUS file whose header line the probe truncates still routes to bus', () => {
  // Same truncation, an entity word that IS claimed: the verdict is positive
  // and the variant comes off line 1. A bus export at this width is the
  // realistic case; other ceilings are about how much can be HELD, not read.
  const names = wideNames(BUS_WIDTH, 'SYNTH_BUS_');
  const file = wideExportCsv('Bus', 'LMP ($/MWh)', names);
  const probe = enc(file).slice(0, DETECT_PROBE_BYTES);
  assert.equal(probe.length, DETECT_PROBE_BYTES, 'this check needs a genuinely truncated probe');

  const result = classify(probe, 'bus-width.csv');
  assert.equal(result.kind, 'bus');
  assert.equal(result.shape, 'W');
  assert.equal(
    result.variant,
    'LMP ($/MWh)',
    'the variant comes from line 1, which truncation never reaches',
  );
});

check('an Area header line too wide for the probe still routes to area', () => {
  const metrics = wideNames(BUS_WIDTH, 'SYNTH_METRIC_');
  const header = ['Date', ' Hour', ' TOU', ' Name', ...metrics].join(',');
  assert.ok(
    header.length > DETECT_PROBE_BYTES,
    `header line (${header.length} B) must exceed the ${DETECT_PROBE_BYTES} B probe, or this check proves nothing`,
  );

  const file = [
    header,
    ['1/1/2034', '1', 'OffPeak', 'AREA_01', ...metrics.map(() => '1.5')].join(','),
  ].join('\r\n');
  const probe = enc(file).slice(0, DETECT_PROBE_BYTES);
  assert.equal(probe.length, DETECT_PROBE_BYTES);

  const result = classify(probe, 'bus-width-export.csv');
  assert.equal(result.kind, 'area');
  assert.equal(result.confidence, 'high');
  assert.equal(result.variant, undefined);
  assertNonEmptyReason(result);
});

// --- shape L, and which KIND its key columns say it is -------------------
//
// A long export's only evidence of kind is its key columns; without a
// signature a long Bus file would misclassify as a malformed Area file.

const LONG_BUS_HEADER = 'Date, Hour, TOU, BusID, BusName, Area , LMP ($/MWh),Load (MW)';
const LONG_GEN_HEADER = 'Date, Hour, TOU, UnitName, BusID, UnitID,LMP ($/MWh),Generation (MWh)';

check('a long BUS export classifies as bus with shape L, from its key columns alone', () => {
  const file = [LONG_BUS_HEADER, '1/1/2035,1,OffPeak,40001,A9,AREA_BP,0.38,0.02'].join('\r\n');
  const result = classify(enc(file), 'area_bp-buses.csv');
  assert.equal(result.kind, 'bus');
  assert.equal(
    result.shape,
    'L',
    'kind is not shape: the same kind the wide branch reads, the other layout',
  );
  assert.equal(result.confidence, 'high');
  assert.equal(
    result.variant,
    undefined,
    'a long export carries many metrics, so no one quantity keys a slot',
  );
  assert.match(result.reason, /BusID,BusName,Area/, 'the reason quotes the signature it matched');
});

check('a long GENERATOR export classifies as generator with shape L', () => {
  const file = [LONG_GEN_HEADER, '1/1/2035,1,OffPeak,WestTEC ICE 1,46169,1,0.77,0.37'].join('\r\n');
  const result = classify(enc(file), 'grant-gens.csv');
  assert.equal(result.kind, 'generator');
  assert.equal(result.shape, 'L');
  assert.equal(result.confidence, 'high');
  assertNonEmptyReason(result);
});

check('the signatures are matched on TRIMMED names, because exports pad some of them', () => {
  // ` Area ` can carry a trailing space where ` BusID` does not. A
  // positional-bytes match would refuse such a file.
  const padded = 'Date ,  Hour , TOU ,  BusID  ,BusName , Area ,LMP ($/MWh)';
  const file = [padded, '1/1/2035,1,OffPeak,40001,A9,AREA_BP,0.38'].join('\n');
  assert.equal(classify(enc(file), 'padded.csv').kind, 'bus');
});

check('a long bus export does NOT classify as a malformed Area file', () => {
  // `BusName` is not `Name`, and the area branch is tried last by
  // construction.
  const file = [LONG_BUS_HEADER, '1/1/2035,1,OffPeak,40001,A9,AREA_BP,0.38,0.02'].join('\n');
  assert.notEqual(classify(enc(file), 'area_bp-buses.csv').kind, 'area');
});

check('a long Area export still classifies as area: the shorter signature is not shadowed', () => {
  const result = classify(exportCsv({ days: 1, hours: 1 }), 'area.csv');
  assert.equal(result.kind, 'area');
  assert.equal(result.shape, 'L');
});

check('a Date,Hour,TOU header whose key columns match no kind is still unrecognized', () => {
  // The absence of a signature is never itself a signature: a match on
  // absence would claim this file.
  const file = [
    'Date, Hour, TOU, ZoneId, ZoneName, LMP ($/MWh)',
    '1/1/2035,1,OffPeak,7,Z7,0.4',
  ].join('\n');
  const result = classify(enc(file), 'zones.csv');
  assert.equal(result.kind, 'unrecognized');
  assert.equal(result.confidence, 'low');
});

check('an interface limit schedule is a high-confidence verdict off line 1, cell 1', () => {
  const file = [
    'INTERFACELIMITSCHEDULE_MONTHLY,a title,a path',
    ',a note',
    ',word,another note',
    'Interface Name,Year,Type,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec',
    'PATH_A,2035,MAX,1,2,3,4,5,6,7,8,9,10,11,12',
  ].join('\n');
  const result = classify(enc(file), 'limits.csv');
  assert.equal(result.kind, 'interfacelimit');
  assert.equal(result.confidence, 'high');
  // No shape. W and L are hourly layouts and this is neither; 'R' is the
  // reference lists, which have no per-Case assignment to make and this does.
  assert.equal(result.shape, undefined);
});

check('a limits file is not mistaken for a reference list, and vice versa', () => {
  // Near neighbours: a limits line 1 has more cells, so `isBannerLine`
  // rejects it; this pins the verdict, not the branch order.
  const notABanner = [
    'INTERFACELIMITSCHEDULE_MONTHLY',
    ',a note',
    ',word,another note',
    'Interface Name,Year,Type,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec',
    'PATH_A,2035,MAX,1,2,3,4,5,6,7,8,9,10,11,12',
  ].join('\n');
  assert.equal(classify(enc(notABanner), 'limits.csv').kind, 'interfacelimit');
});

console.log(`\n${passed} checks passed.`);
