// scripts/run-tests.mjs
//
// Test runner: finds every `tests/test_*.mjs` file, runs each one as its
// own `node` process, and stops at the first failure. This exists so a new
// test suite is protected the moment its file lands -- no `package.json`
// edit required -- rather than the previous hand-maintained list of `node
// tests/test_x.mjs && node tests/test_y.mjs && ...` (rot-guard:allow: x and y
// stand for any suite, they are not files) that had to be extended
// task by task.
//
// `test_loader.mjs` and `test_fixtures*.mjs` are skipped: they are imported
// by the suites, not suites themselves, and have no `checks`/assertions of
// their own to run standalone.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tests');

const files = readdirSync(dir)
  .filter((name) => /^test_.*\.mjs$/.test(name))
  .filter((name) => name !== 'test_loader.mjs' && !name.startsWith('test_fixtures'))
  .sort();

// This script is the sole test gate for the project -- an empty glob match (a
// bad cwd, a rename that missed the `test_*.mjs` pattern, files deleted by
// mistake) must be a hard failure, not a silent, misleadingly cheerful
// "All 0 test file(s) passed."
if (files.length === 0) {
  console.error(
    `\nNo test_*.mjs files found under ${dir} -- refusing to report success on zero tests.`,
  );
  process.exit(1);
}

for (const file of files) {
  console.log(`\n--- ${file} ---`);
  const result = spawnSync(process.execPath, [join(dir, file)], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${file}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${files.length} test file(s) passed.`);
