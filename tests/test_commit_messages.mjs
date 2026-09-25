// tests/test_commit_messages.mjs — no commit carries AI authorship.
//
// AGENTS.md: the README discloses AI assistance once, and a commit is authored
// by the human who owns it. A tool's attribution default adds a trailer to
// every commit it writes, so the rule is checked over the history `npm test`
// can see, before a push rather than after one. CI's shallow clone sees only
// the tip, which is the commit it was asked about.
//
// Run:  node tests/test_commit_messages.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

let log;
try {
  log = execFileSync('git', ['log', '--format=%H%n%B%x00'], { encoding: 'utf8' });
} catch {
  // Not a checkout (a tarball build): there is no history to hold to it.
  console.log('ok - no git history here, nothing to check');
  process.exit(0);
}

const AUTHORSHIP = [
  /^co-authored-by:.*\b(claude|anthropic|copilot|openai|gpt|gemini)\b/im,
  /^claude-session:/im,
  /generated with \[?claude/i,
];
const offenders = log
  .split('\0')
  .map((entry) => entry.trim())
  .filter((entry) => AUTHORSHIP.some((pattern) => pattern.test(entry)))
  .map((entry) => entry.split('\n').slice(0, 2).join(' '));
assert.deepEqual(offenders, [], `commits carrying AI authorship:\n${offenders.join('\n')}`);
console.log('ok - no commit carries an AI authorship trailer or credit line');
