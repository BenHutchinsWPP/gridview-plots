// scripts/sample-tab-rss.mjs
//
// Samples a browser tab's resident memory from /proc and stamps a mark each
// time you press Enter, to measure the per-case RISE across a multi-case drop.
// `performance.memory` sees only JS heap, while the cost is mostly worker wasm
// memory and cubes, and the task manager cannot catch a peak. The process is
// picked by watching which one moves during a drop, or given with --pid.
//
// Usage:
//   node scripts/sample-tab-rss.mjs                 # auto-pick the busiest tab process
//   node scripts/sample-tab-rss.mjs --pid 12345
//   node scripts/sample-tab-rss.mjs --hz 10 --pid 12345
//
// Enter stamps a mark; Ctrl-C prints the table. Linux only: it reads the same
// /proc source as bench-ingest.mjs's VmHWM, so both figures share one
// instrument.

import { readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

function parseArgs(argv) {
  const args = { pid: null, hz: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pid') args.pid = Number(argv[++i]);
    else if (argv[i] === '--hz') args.hz = Number(argv[++i]);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!(args.hz > 0)) throw new Error('--hz must be positive');
  return args;
}

/** Resident bytes for one pid, or null if it is gone. */
function rssOf(pid) {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null; // Exited between readdir and read. Not an error.
  }
}

/** Candidate tab processes: a browser's content children (matched by command
 * line, since they share the parent's name). */
function tabPids() {
  const pids = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'latin1');
      if (/-contentproc/.test(cmdline) || /--type=renderer/.test(cmdline)) {
        pids.push(Number(entry));
      }
    } catch {
      // Gone, or not ours to read.
    }
  }
  return pids;
}

const mb = (bytes) => (bytes / 1e6).toFixed(1);

const args = parseArgs(process.argv.slice(2));

// Peak per pid, so the interesting process can be identified after the fact by
// which one actually moved. Auto-picking up front would pick whichever tab was
// biggest when this started, which is usually not the app's.
const peak = new Map();
const first = new Map();
const marks = [];

function sample() {
  const pids = args.pid ? [args.pid] : tabPids();
  for (const pid of pids) {
    const rss = rssOf(pid);
    if (rss === null) continue;
    if (!first.has(pid)) first.set(pid, rss);
    peak.set(pid, Math.max(peak.get(pid) ?? 0, rss));
  }
}

/** The process that GREW the most since sampling began -- the app's tab. */
function busiest() {
  let best = null;
  for (const [pid, high] of peak) {
    const grew = high - (first.get(pid) ?? high);
    if (!best || grew > best.grew) best = { pid, grew, peak: high };
  }
  return best;
}

const timer = setInterval(sample, 1000 / args.hz);
sample();

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(
  `sampling ${args.pid ? `pid ${args.pid}` : `${tabPids().length} content process(es)`} ` +
    `at ${args.hz} Hz\n` +
    `Enter = stamp a mark (do one after the baseline and one after each drop), Ctrl-C = report`,
);

rl.on('line', (line) => {
  const pid = args.pid ?? busiest()?.pid;
  if (pid === undefined || pid === null) {
    console.log('  no candidate process yet');
    return;
  }
  const now = rssOf(pid);
  const mark = {
    label: line.trim() || `mark ${marks.length + 1}`,
    pid,
    rss: now,
    peak: peak.get(pid) ?? now,
  };
  marks.push(mark);
  const prev = marks.length > 1 ? marks[marks.length - 2] : null;
  console.log(
    `  ${mark.label}: pid ${pid}  RSS ${mb(mark.rss)} MB  peak ${mb(mark.peak)} MB` +
      (prev ? `  rise ${mb(mark.rss - prev.rss)} MB` : ''),
  );
});

process.on('SIGINT', () => {
  clearInterval(timer);
  rl.close();
  const best = args.pid ? { pid: args.pid, peak: peak.get(args.pid) } : busiest();
  console.log('');
  if (best) {
    console.log(
      `tab process ${best.pid}: started ${mb(first.get(best.pid) ?? 0)} MB, ` +
        `peaked ${mb(peak.get(best.pid) ?? 0)} MB`,
    );
  }
  if (marks.length) {
    console.log('');
    console.log('| mark | RSS MB | peak MB | rise over previous MB |');
    console.log('|---|---:|---:|---:|');
    marks.forEach((m, i) => {
      const rise = i === 0 ? null : m.rss - marks[i - 1].rss;
      console.log(
        `| ${m.label} | ${mb(m.rss)} | ${mb(m.peak)} | ${rise === null ? '—' : mb(rise)} |`,
      );
    });
    console.log('');
    console.log('Paste that into the Browser confirmation section of');
    console.log('sample-data/perf-ladder-report.md — a --ladder re-run carries it across.');
  }
  process.exit(0);
});
