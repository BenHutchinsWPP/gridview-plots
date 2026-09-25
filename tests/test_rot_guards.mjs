// tests/test_rot_guards.mjs
//
// Guards against a written claim that was true when written and is false now.
// AGENTS.md's rule is that a fact readable off the code is never restated in
// prose; where prose must name one anyway (an ABI number, a path, a symbol),
// the naming is checked here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import './test_loader.mjs';

const registry = await import('../src/tables/registry.ts');
const listSchemas = await import('../src/lookups/schema.ts');
const limitsStore = await import('../src/limits/store.ts');

const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

// Paths here are repo-root-relative, resolved once so moving this file does
// not break thirty `../` prefixes.
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

// The prose a guard reads: a comment line. In markdown `*` opens a bullet, so
// the only comment marker there is `<!--`.
const isProse = (file, line) =>
  /\.md$/.test(file) ? /^\s*<!--/.test(line) : /^\s*(\/\/|\*|\/\*|#|<!--)/.test(line);
const unmark = (line) => line.replace(/^\s*(?:\/\/|\*|\/\*|#|<!--)\s*/, ' ');

/** Every tracked text file that can carry a comment or a doc reference. */
function sources(dir = '.', out = []) {
  for (const e of readdirSync(new URL(dir + '/', ROOT), { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'sample-data', 'public'].includes(e.name)) continue;
    const p = `${dir}/${e.name}`;
    // Skip a nested checkout (e.g. an agent's git worktree): walking a second
    // copy of the repo would trip every duplication and header check at once.
    if (e.isDirectory() && existsSync(new URL(`${p}/.git`, ROOT))) continue;
    if (e.isDirectory()) sources(p, out);
    // Extension-less config files carry prose and rot like any other file.
    else if (
      /\.(ts|mjs|js|c|h|sh|html|md|json|css|yml)$/.test(e.name) ||
      /^\.(?:git|prettier)ignore$/.test(e.name)
    )
      out.push(p.replace(/^\.\//, ''));
  }
  return out;
}
const FILES = sources();

// ---------------------------------------------------------------- 1. the ABI
//
// The ABI number exists in exactly two places per parser and must match.

ok('each parser ABI_VERSION matches its TypeScript PARSER_ABI', () => {
  for (const [c, ts] of [
    ['parser/long/block.c', 'src/tables/long/block.ts'],
    ['parser/wide/block.c', 'src/tables/wide/block.ts'],
  ]) {
    const inC = read(c).match(/#define\s+ABI_VERSION\s+(\d+)/);
    const inTs = read(ts).match(/export const PARSER_ABI = (\d+)/);
    assert.ok(inC, `${c} declares no ABI_VERSION`);
    assert.ok(inTs, `${ts} declares no PARSER_ABI`);
    assert.equal(
      inC[1],
      inTs[1],
      `${c} is ABI ${inC[1]} but ${ts} speaks ${inTs[1]}. Bump both together.`,
    );
  }
});

// Naming a version in passing is fine. What rots is ASSERTING one: a parser
// path and a version on the same line.
ok('nothing outside the parsers asserts which ABI a parser is at', () => {
  const allowed = new Set([
    'parser/long/block.c',
    'src/tables/long/block.ts',
    'parser/wide/block.c',
    'src/tables/wide/block.ts',
    'tests/test_rot_guards.mjs',
  ]);
  const offenders = [];
  for (const f of FILES) {
    if (allowed.has(f)) continue;
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (/parser\/(?:long|wide)/.test(line) && /\bABI\s*(?:version\s*)?v?\d/i.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    "this states a parser's ABI and will drift from it. Cite the file, not the number:\n  " +
      offenders.join('\n  '),
  );
});

// ------------------------------------------------------- 2. doc references
//
// A citation of a file that no longer exists teaches the reader to distrust
// the next one.

ok('every docs/ path named in the tree exists', () => {
  const missing = [];
  for (const f of FILES) {
    // The character class includes a DOT so `<thing>.plan.md` matches.
    for (const m of read(f).matchAll(/\bdocs\/[\w/.-]+\.md\b/g)) {
      if (!existsSync(new URL(m[0], ROOT))) missing.push(`${f} -> ${m[0]}`);
    }
  }
  assert.deepEqual(missing, [], 'dangling doc references:\n  ' + missing.join('\n  '));
});

// A path into the tree rots the same way. A glob or a `<placeholder>` names a
// FAMILY of paths, not one file, and is skipped.
ok('every source path named in the tree exists', () => {
  const missing = [];
  for (const f of FILES) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('rot-guard:allow')) return;
        // The lookbehind is load-bearing: without it `sample-data/perf/x.csv`
        // matches from its `data/` and is reported as a missing `data/` path.
        for (const m of line.matchAll(
          /(?<![\w/-])(?:src|parser|scripts|tests|data)\/[\w/<>*.-]+\.\w+\b/g,
        )) {
          if (/[<>*]/.test(m[0])) continue;
          if (!existsSync(new URL(m[0], ROOT))) missing.push(`${f}:${i + 1}: ${m[0]}`);
        }
      });
  }
  assert.deepEqual(
    missing,
    [],
    'these name a file that is not there -- usually a move that left the prose behind:\n  ' +
      missing.join('\n  '),
  );
});

// ----------------------------------------------------- 3. the kind inventory
//
// Which kinds exist is derived, never listed in prose: a new kind is a
// directory, and this says what a directory must contain to be one. A section
// is not required: a kind earns one only for controls the browse drawer cannot
// express.

const KIND_DIRS = readdirSync(new URL('src/tables/', ROOT), { withFileTypes: true })
  .filter((e) => e.isDirectory() && !['wide', 'long'].includes(e.name))
  .map((e) => e.name);

ok('every table kind carries the full adapter set', () => {
  assert.ok(KIND_DIRS.length >= 4, `found only ${KIND_DIRS.length} kinds`);
  const required = [
    'types.ts',
    'rules.ts',
    'kernels.ts',
    'series.ts',
    'ui/browse.ts',
    'ui/picker.ts',
    'ui/retain.ts',
  ];
  const missing = [];
  for (const kind of KIND_DIRS) {
    for (const part of required) {
      if (!existsSync(new URL(`src/tables/${kind}/${part}`, ROOT))) {
        missing.push(`src/tables/${kind}/${part}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'a kind is missing part of the adapter set:\n  ' + missing.join('\n  '),
  );
});

ok('every kind is registered for storage, drawing and column retention', () => {
  const registry = read('src/tables/registry.ts');
  const map = registry.match(/const REGISTRY: Record<TableKind, KindAdapter> = \{([\s\S]*?)\n\};/);
  assert.ok(map, 'src/tables/registry.ts no longer declares REGISTRY');
  for (const kind of KIND_DIRS) {
    const entry = map[1].match(new RegExp(`\\b${kind}: \\{([\\s\\S]*?)\\n  \\},`));
    assert.ok(entry, `src/tables/${kind}/ exists but the registry has no entry for it`);
    for (const capability of ['storage', 'resolve', 'retain']) {
      assert.match(
        entry[1],
        new RegExp(`\\b${capability}:`),
        `the registry's ${kind} entry declares no ${capability}. A kind missing one of these ` +
          `loads and then does nothing -- it cannot be saved, drawn, or asked about its columns.`,
      );
    }
  }
});

// The Contents panel's column tooltips are how a blank column says what the
// app would take. A kind registered with an empty line would be a column that
// teaches nothing.
ok('every kind, group file, reference list and limits says what loading it enables', () => {
  const lines = [
    ...registry.TABLE_KINDS.flatMap((kind) => [
      [`the registry's ${kind} enables`, registry.KIND_ENABLES[kind]],
      [`the registry's ${kind} groupsEnables`, registry.GROUPS_ENABLES[kind]],
    ]),
    ...listSchemas.LIST_SCHEMAS.map((schema) => [`the ${schema.label} schema`, schema.enables]),
    ['src/limits/store.ts LIMITS_ENABLES', limitsStore.LIMITS_ENABLES],
  ];
  for (const [where, line] of lines) {
    assert.equal(typeof line, 'string', `${where} line is missing`);
    assert.ok(line.trim().length > 0, `${where} line is empty`);
  }
});

// "% of range" is divided in `src/series/range.ts` alone. A kind hands it
// limits as numbers; a kind reading the limits store, or a resolver dividing
// without the normalizer, is a second copy of the arithmetic to drift.
ok('"% of range" is divided by the one normalizer, and no kind reads the limits store', () => {
  const readers = FILES.filter(
    (f) => f.startsWith('src/tables/') && /from '[./]*limits\/store'/.test(read(f)),
  );
  assert.deepEqual(readers, [], 'a kind imports the limits store; hand it numbers instead');
  for (const kind of KIND_DIRS) {
    const series = read(`src/tables/${kind}/series.ts`);
    if (!/spec\.perUnit/.test(series)) continue;
    assert.match(
      series,
      /import \{[^}]*\bnormalizeToRange\b[^}]*\} from '\.\.\/\.\.\/series\/range'/,
      `src/tables/${kind}/series.ts draws "% of range" without normalizeToRange`,
    );
  }
});

// The map is DERIVED from the registry; a hand-written copy is a second list
// to forget a kind from.
ok('the resolver map is derived from the registry, not restated', () => {
  const registry = read('src/tables/registry.ts');
  assert.match(
    registry,
    /export const SERIES_RESOLVERS = Object\.fromEntries\(/,
    'SERIES_RESOLVERS is built from REGISTRY',
  );
  const offenders = FILES.filter(
    (f) => f !== 'src/tables/registry.ts' && f !== 'tests/test_rot_guards.mjs',
  ).filter((f) => /SERIES_RESOLVERS\s*[:=]\s*\{/.test(read(f)));
  assert.deepEqual(
    offenders,
    [],
    'this writes out a second resolver map:\n  ' + offenders.join('\n  '),
  );
});

// The files that may enumerate the kind set as literals, each a map that
// cannot be a registry entry:
//
//   * the registry itself;
//   * the `TableKind` union it is keyed by (derived, the key becomes `string`);
//   * `detect.ts`'s `DetectKind`, which is WIDER than `TableKind` (groupings,
//     bundles and limits are verdicts with no table);
//   * `storage/legacy.ts`: the legacy formats hold only area and interface;
//   * the two dispatchers in `src/app/`, whose branches genuinely differ;
//   * `main.ts`, the composition root;
//   * `ui/groupings-mapping.ts`, whose four answers are about what a
//     membership FILE says (names, pairs, ids, directions), which belongs to
//     each `tables/<kind>/groups.ts`, not to the table registry.
//
// Anything else naming all four should be a registry entry. Add one there
// rather than an exemption here.
const KIND_MAP_FILES = new Set([
  'src/tables/registry.ts',
  'src/model/case-model.ts',
  'src/detect.ts',
  'src/storage/legacy.ts',
  'src/app/draw.ts',
  'src/app/drop-route.ts',
  'src/main.ts',
  'src/ui/groupings-mapping.ts',
]);

ok('no file outside the registry keeps a kind map of its own', () => {
  const literal = new RegExp(`'(${KIND_DIRS.join('|')})'`, 'g');
  const offenders = [];
  for (const f of FILES) {
    if (!f.startsWith('src/') || KIND_MAP_FILES.has(f)) continue;
    const named = new Set();
    for (const line of read(f).split('\n')) {
      // Comments discuss kinds by name constantly; only CODE keeps a map.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      for (const m of line.split('//')[0].matchAll(literal)) named.add(m[1]);
    }
    if (named.size === KIND_DIRS.length) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    'this names every table kind as a literal, which is a per-kind map outside the registry. ' +
      'Register the fact in src/tables/registry.ts and read it back:\n  ' +
      offenders.join('\n  '),
  );
});

// -------------------------------------------------------- 4. status claims
//
// "Not yet built" and its kin send agents to build what already exists. Scope
// with a state belongs in a GitHub issue.

const STATUS = [
  /\bnot yet (?:built|written|implemented|exist)/i,
  /\bdoes not (?:yet )?exist yet\b/i,
  /\bis not built\b/i,
  // The same claim with the words the other way round.
  /\bnot (?:built|written|implemented) yet\b/i,
  /\bare missing on purpose\b/i,
  /\buntil #\d+\b/i,
  /\bwhen (?:the slots|step \d) lands?\b/i,
  /\bstep \d+ (?:of the plan|lands|later)/i,
];

ok('no comment claims something is unbuilt', () => {
  const offenders = [];
  for (const f of FILES) {
    if (f === 'tests/test_rot_guards.mjs') continue;
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (!isProse(f, line)) return;
        if (line.includes('rot-guard:allow')) return;
        if (STATUS.some((re) => re.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    'status claims rot; move the scope to a GitHub issue and delete the comment:\n  ' +
      offenders.join('\n  '),
  );
});

// JSON has no comments, so the rules files carry prose as strings (a
// `contract` above all). Every string in data/ is held to the patterns above,
// plus a bare "yet": a rules file states what is.
ok('no rules file under data/ makes a status claim in its prose', () => {
  const offenders = [];
  const walk = (value, where) => {
    if (typeof value === 'string') {
      if ([...STATUS, /\byet\b/i].some((re) => re.test(value))) offenders.push(where);
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${where}.${key}`);
    }
  };
  const data = FILES.filter((f) => f.startsWith('data/') && f.endsWith('.json'));
  assert.ok(data.length > 0, 'the walk found the rules files');
  for (const f of data) walk(JSON.parse(read(f)), f);
  assert.deepEqual(
    offenders,
    [],
    'status claims rot; say what the file decides, not when:\n  ' + offenders.join('\n  '),
  );
});

// ------------------------------------------------- 5. dangling roadmap ids
//
// Bare ids like `T01`, `D4`, `F15`, `footgun 17`, a `§` mark or an issue
// number like `#42` point into something nobody can look up from the code.
// State the rule instead. (CSS is skipped: `#123` there is a colour.)

ok('no comment cites a roadmap id, section mark or issue number', () => {
  const offenders = [];
  for (const f of FILES) {
    if (f === 'tests/test_rot_guards.mjs' || f === 'AGENTS.md') continue;
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (!isProse(f, line)) return;
        if (line.includes('rot-guard:allow')) return;
        // Any bare `T01`/`D4`/`F15`/`Q6` token: parenthesised, colon-led, or
        // loose in prose.
        if (
          /(?:^|[^A-Za-z0-9_`'"/])[TDFQ]\d{1,2}[a-z]?(?![A-Za-z0-9_])/.test(unmark(line)) ||
          /\bfootgun \d+/i.test(line) ||
          // Any bare section mark: "§12", "§5.2".
          /§\s*\d/.test(line) ||
          // An issue or PR number: "#42", "(#42)", "issue #7".
          (!f.endsWith('.css') && /(?:^|[\s(])#\d{1,4}(?![\w-])/.test(unmark(line)))
        ) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    'these cite an id nobody can look up from the code. State the rule instead:\n  ' +
      offenders.join('\n  '),
  );
});

// -------------------------------------------------- 6. the file header
//
// Every module opens by naming itself and saying why it exists, so `head -8`
// can route a task. What the header says is the writing policy's business;
// that there is one is checkable.

ok('every source file opens with a comment', () => {
  const offenders = FILES.filter(
    (f) =>
      /\.(ts|mjs|c)$/.test(f) &&
      f !== 'vite.config.ts' &&
      !/^\s*(\/\/|\/\*)/.test(read(f).split('\n')[0]),
  );
  assert.deepEqual(
    offenders,
    [],
    'these open with code. Say what the file is for first:\n  ' + offenders.join('\n  '),
  );
});

// The header's path is the one restatement the writing policy permits, and a
// move invalidates it first, so it gets the one assertion.

ok('every source file header names its own path', () => {
  const offenders = [];
  for (const f of FILES) {
    if (!/\.(ts|mjs|c)$/.test(f) || f === 'vite.config.ts') continue;
    const first = read(f).split('\n')[0];
    if (!first.includes(f)) offenders.push(`${f}: ${first.trim()}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these headers name a path that is not their own -- usually a move that ' +
      'left the header behind:\n  ' +
      offenders.join('\n  '),
  );
});

// ------------------------------------------------------- 7. dead CSS rules
//
// A dead rule fails and warns about nothing, and looks authoritative to the
// next reader. A descendant selector cannot match if ANY class in it is never
// applied, so the test is per comma-separated alternative. A class built at
// runtime (`'case-' + state`) needs its literal in a comment beside the code
// that builds it; this scans source text.

ok('every CSS class styled is one the markup or the code names', () => {
  const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const named = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) named.add(m[1]);

  const users =
    read('index.html') +
    FILES.filter((f) => /^src\/.*\.ts$/.test(f))
      .map((f) => read(f))
      .join('\n');

  const dead = [...named].filter((c) => !users.includes(c)).sort();
  assert.deepEqual(dead, [], 'these classes are styled and never applied:\n  ' + dead.join('\n  '));
});

// ------------------------------------ 8. symbols named in prose that are gone
//
// A rename commonly leaves its prose behind. A line that deliberately names a
// deleted symbol is marked `rot-guard:allow`.

ok('every code symbol named in the docs still exists', () => {
  const DOCS = ['AGENTS.md', 'README.md', 'parser/long/README.md', 'parser/wide/README.md'];
  const code = FILES.filter((f) => /\.(ts|mjs|c|h|sh|json|html|css|yml)$/.test(f))
    .map((f) => read(f))
    .join('\n');

  const dangling = [];
  for (const doc of DOCS) {
    read(doc)
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('rot-guard:allow')) return;
        for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?`/g)) {
          const name = m[1];
          // Short or all-lowercase words are English, not identifiers.
          if (name.length < 4 || !/[A-Z_]/.test(name)) continue;
          if (!code.includes(name)) dangling.push(`${doc}:${i + 1}: ${name}`);
        }
      });
  }
  assert.deepEqual(
    dangling,
    [],
    'these name a symbol the code no longer has:\n  ' + dangling.join('\n  '),
  );
});

// ------------------------------ 8b. symbols named in a HEADER that are gone
//
// The same check for source headers, which route tasks to modules. It cannot
// catch prose naming a LOCATION (a switch that moved to another file) rather
// than a symbol. `rot-guard:allow` works as in check 8.

ok('every code symbol named in a source header still exists', () => {
  const SOURCE = FILES.filter((f) => /\.(ts|mjs|c|h)$/.test(f));
  // NON-COMMENT lines only: the scanned file is in the corpus, so a citation
  // would otherwise always find itself.
  const code = FILES.filter((f) => /\.(ts|mjs|c|h|sh|json|html|css|yml)$/.test(f))
    .map((f) =>
      read(f)
        .split('\n')
        .filter((line) => !isProse(f, line))
        .join('\n'),
    )
    .join('\n');

  const dangling = [];
  for (const file of SOURCE) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (!isProse(file, line)) return;
        if (line.includes('rot-guard:allow')) return;
        for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?`/g)) {
          const name = m[1];
          // Short or all-lowercase words are English, not identifiers.
          if (name.length < 4 || !/[A-Z_]/.test(name)) continue;
          if (!code.includes(name)) dangling.push(`${file}:${i + 1}: ${name}`);
        }
      });
  }
  assert.deepEqual(
    dangling,
    [],
    'these comments name a symbol the code no longer has:\n  ' + dangling.join('\n  '),
  );
});

// ----------------------------- 8c. DOM hooks named in prose that are gone
//
// A DOM hook is the commonest LOCATION check 8b cannot see, and the cheapest
// to verify: an id or `data-` attribute is a literal the markup has or lacks.
// Recognised forms: `#an-id` or `data-thing` in backticks, and a bare rot-guard:allow -- the forms, not real hooks
// `data-thing` before `=` or the word "attribute" or "hook". Prose rot-guard:allow -- ditto
// hyphenations such as "data-shaped" are left alone. The corpus is
// non-comment lines, as in 8b.

ok('every DOM hook named in a comment is one the markup or the code carries', () => {
  const SOURCE = FILES.filter((f) => /\.(ts|mjs|c|h)$/.test(f));
  const markup = FILES.filter((f) => /\.(ts|mjs|html|css)$/.test(f))
    .map((f) =>
      read(f)
        .split('\n')
        .filter((line) => !isProse(f, line))
        .join('\n'),
    )
    .join('\n');

  const HOOK =
    /`(#[a-z][a-z0-9-]*|data-[a-z][a-z0-9-]*)`|\b(data-[a-z][a-z0-9-]*)(?=\s*=|\s+(?:attribute|attributes|hook|hooks)\b)/g;

  const dangling = [];
  for (const file of SOURCE) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (!isProse(file, line)) return;
        if (line.includes('rot-guard:allow')) return;
        for (const m of line.matchAll(HOOK)) {
          const hook = m[1] ?? m[2];
          if (!markup.includes(hook.startsWith('#') ? hook.slice(1) : hook)) {
            dangling.push(`${file}:${i + 1}: ${hook}`);
          }
        }
      });
  }
  assert.deepEqual(
    dangling,
    [],
    'these comments name a DOM hook nothing carries:\n  ' + dangling.join('\n  '),
  );
});

// A figure is built from facets, which every kind already builds. A figure
// module importing a kind would be the first step to a figure that branches
// on one.
ok('the figure directory imports no table kind', () => {
  const figureFiles = FILES.filter((f) => f.startsWith('src/figure/'));
  assert.ok(figureFiles.includes('src/figure/build.ts'), 'the scan found the figure builder');
  const offenders = figureFiles.filter((f) => /from '[./]*tables\//.test(read(f)));
  assert.deepEqual(
    offenders,
    [],
    'these figure modules import a kind:\n  ' + offenders.join('\n  '),
  );
});

// ------------------------------------------------- 9. the composition root
//
// `src/main.ts` holds the mutable app state and resolves the global DOM ids;
// beside it sits only what every directory uses. A new name at the top of
// `src/` must be a decision, so it fails here until someone makes it.

ok('the top of src/ is the composition root and the cross-kind primitives', () => {
  const root = readdirSync(new URL('src/', ROOT), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(
    root,
    ['detect.ts', 'ingest.ts', 'kernels.ts', 'main.ts', 'styles.css'],
    'src/ gained or lost a top-level file. The root is main.ts plus the format classifier ' +
      'and the two cross-kind primitive sets; a module with a collaborator earns a ' +
      'directory instead. If the change is deliberate, record it in this list.',
  );
});

// ------------------------------------------ 10. the same rule, written twice
//
// A rule stated in several files drifts, and the stale copies read exactly
// like the fresh one. Kinds may not import each other, so their CODE is
// legitimately parallel; their PROSE is not. A rule worth stating twice
// belongs in AGENTS.md with the code citing it. Prose is normalised, so
// re-wrapping does not launder a copy. Mark a deliberate twin with
// `rot-guard:allow` on any line of the run.

/** Prose runs in one file, as normalised lines. A run breaks at any code. */
function proseRuns(file) {
  const runs = [];
  let run = [];
  for (const line of read(file).split('\n')) {
    if (isProse(file, line)) {
      run.push(line);
      continue;
    }
    if (run.length) runs.push(run);
    run = [];
  }
  if (run.length) runs.push(run);
  return runs
    .filter((r) => !r.some((l) => l.includes('rot-guard:allow')))
    .map((r) =>
      r
        .map((l) => unmark(l).replace(/\s+/g, ' ').trim().toLowerCase())
        // A divider or a bare separator is punctuation, not a claim.
        .filter((l) => l.replace(/[^a-z0-9]/g, '').length > 12),
    );
}

const PROSE_FILES = FILES.filter((f) => /\.(ts|mjs|js|c|h)$/.test(f));

// The one exempt pair: the two block.c files carry their own copies of the
// same freestanding helpers, and the prose follows the code. Sharing them
// would mean rebuilding two committed `.wasm` binaries.
const TWINS = ['parser/long/block.c', 'parser/wide/block.c'].join();
const areTwins = (at) => [...at].sort().join() === TWINS;
const groupKey = (at) => [...at].sort().join(' ');

// ---------------------------------------- 10c. the duplication that is left
//
// A RATCHET, not an exception list: a new copy fails the checks above, and a
// fixed entry fails the check below until it is deleted from the list. Do not
// add to either list; fix the copy.
const KNOWN_COPIED_PARAGRAPHS = [];
const KNOWN_COPIED_SENTENCES = [];

ok('no paragraph of prose is copied into a second file', () => {
  // Two consecutive matching lines of real text is a paste; one can coincide.
  const seen = new Map();
  for (const file of PROSE_FILES)
    for (const run of proseRuns(file))
      for (let i = 0; i + 1 < run.length; i++) {
        const pair = `${run[i]} ${run[i + 1]}`;
        if (pair.length < 100) continue;
        const at = seen.get(pair) ?? new Set();
        at.add(file);
        seen.set(pair, at);
      }
  const known = new Set(KNOWN_COPIED_PARAGRAPHS);
  const copied = [...seen]
    .filter(([, at]) => at.size > 1 && !areTwins(at) && !known.has(groupKey(at)))
    .map(([pair, at]) => `  ${[...at].join(', ')}\n    "${pair.slice(0, 90)}..."`);
  assert.equal(
    copied.length,
    0,
    `prose copied between files. State it once and cite it, or put the rule in ` +
      `AGENTS.md:\n${copied.join('\n')}`,
  );
});

ok('no sentence of prose stands in three or more files', () => {
  // The single-line form: one sentence pasted into a family of files. Three,
  // because two files sharing a sentence is usually a shared citation.
  const seen = new Map();
  for (const file of PROSE_FILES)
    for (const run of proseRuns(file))
      for (const line of run) {
        if (line.length < 55) continue;
        const at = seen.get(line) ?? new Set();
        at.add(file);
        seen.set(line, at);
      }
  const known = new Set(KNOWN_COPIED_SENTENCES);
  const spread = [...seen]
    .filter(([, at]) => at.size > 2 && !areTwins(at) && !known.has(groupKey(at)))
    .map(
      ([line, at]) => `  ${at.size} files: "${line.slice(0, 80)}..."\n    ${[...at].join(', ')}`,
    );
  assert.equal(
    spread.length,
    0,
    `one sentence, many files. Delete the copies; a fact every file of a family ` +
      `restates is a fact none of them needs to:\n${spread.join('\n')}`,
  );
});

// The half of the ratchet that makes it shrink: a cleaned group must leave
// the lists above.
ok('the duplication baseline names only groups that are still duplicated', () => {
  const groups = (minSize, keyOf) => {
    const seen = new Map();
    for (const file of PROSE_FILES)
      for (const run of proseRuns(file))
        for (const key of keyOf(run)) {
          const at = seen.get(key) ?? new Set();
          at.add(file);
          seen.set(key, at);
        }
    return new Set([...seen].filter(([, at]) => at.size > minSize).map(([, at]) => groupKey(at)));
  };
  const paragraphs = groups(1, (run) =>
    run.flatMap((_, i) =>
      i + 1 < run.length && `${run[i]} ${run[i + 1]}`.length >= 100
        ? [`${run[i]} ${run[i + 1]}`]
        : [],
    ),
  );
  const sentences = groups(2, (run) => run.filter((l) => l.length >= 55));
  const fixed = [
    ...KNOWN_COPIED_PARAGRAPHS.filter((g) => !paragraphs.has(g)).map((g) => `paragraphs: ${g}`),
    ...KNOWN_COPIED_SENTENCES.filter((g) => !sentences.has(g)).map((g) => `sentences: ${g}`),
  ];
  assert.deepEqual(
    fixed,
    [],
    'these are no longer duplicated -- delete them from the baseline in this file, ' +
      'which is the only way the list is allowed to change:\n  ' +
      fixed.join('\n  '),
  );
});

// ------------------------------------------- 11. a timing with no provenance
//
// A TIMING is a measurement from one machine on one day; without the command
// that produced it, nobody can confirm or refute it. So a timing must name
// the script that measured it, or not be written. Byte figures are usually
// redoable arithmetic and are left alone.

ok('every timing in prose names what measured it', () => {
  const PROVENANCE = /bench-ingest|make-perf-data|sample-tab-rss|perf-ladder|docs\/roadmap/;
  // A duration, not a version or an identifier. rot-guard:allow -- the
  // examples this pattern is written against are themselves timings.
  const TIMING = /(?:^|[^\w.])\d+(?:\.\d+)?\s?(?:ms|milliseconds|seconds)\b/;
  const offenders = [];
  for (const file of PROSE_FILES)
    for (const run of proseRuns(file)) {
      const text = run.join(' ');
      if (TIMING.test(text) && !PROVENANCE.test(text))
        offenders.push(`  ${file}\n    "${run.find((l) => TIMING.test(l))?.slice(0, 90)}"`);
    }
  assert.equal(
    offenders.length,
    0,
    `a timing no one can reproduce. Cite the script that measured it, or delete ` +
      `the figure and keep the decision:\n${offenders.join('\n')}`,
  );
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
