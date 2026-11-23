// Rewrites the CI time of each browser suite in tests/browser/suite-times.json from the suite times a local
// npm run check:all recorded, so the CI groups stay balanced as suites are added or slow down (#95):
//   node scripts/browser-times.mjs [out/gate/<time>]     (npm run browser:times; default: the latest run)
// This machine is not as fast as a CI job, so its times are scaled by the middle ratio of kept CI time to local time
// over the suites that have both. A suite that failed, or passed only on its own, keeps its kept time; a new suite
// with no time takes the middle time; a suite that no longer exists is dropped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typicalTime } from './browser-shard.mjs';
import { GATE_ROOT, insideGate } from './gate-dir.mjs';

export const SUITE_TIMES = 'tests/browser/suite-times.json';

/** The middle of the numbers, or null when there are none. */
function middle(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

const isPositive = (secs) => Number.isFinite(secs) && secs > 0;

/**
 * The local time of each suite that passed alongside the others in a run's browser.json entries. A failed suite, or
 * one that passed only when run again on its own, would rank shorter than it is, so it gives no time.
 */
export function measuredTimes(entries) {
  const measured = {};
  for (const entry of entries ?? []) {
    const passed = entry.total > 0 && entry.passed === entry.total && !entry.rerun;
    if (passed && isPositive(entry.secs)) measured[entry.name] = entry.secs;
  }
  return measured;
}

/** How much slower a CI job is than this machine: the middle ratio over suites with both times, 1 with none. */
export function ciScale(kept, measured) {
  const shared = Object.keys(measured).filter((name) => isPositive(kept[name]));
  const ratios = shared.map((name) => kept[name] / measured[name]);
  return middle(ratios) ?? 1;
}

/** The new CI times for exactly `suites`, in name order, and the scale used. */
export function updatedTimes(kept, measured, suites) {
  const scale = ciScale(kept, measured);
  const times = {};
  for (const name of suites) {
    if (isPositive(measured[name])) times[name] = Math.max(1, Math.round(measured[name] * scale));
    else if (isPositive(kept[name])) times[name] = kept[name];
  }
  // a new suite that did not pass in this run has no time yet; the middle time keeps it in one group
  const guess = typicalTime(times);
  const sorted = {};
  for (const name of [...suites].sort()) sorted[name] = times[name] ?? guess;
  return { times: sorted, scale };
}

/** The latest check:all run folder that holds a browser.json, or null. */
function latestRun() {
  if (!fs.existsSync(GATE_ROOT)) return null;
  const runs = fs.readdirSync(GATE_ROOT).sort().reverse();
  const found = runs.find((run) => fs.existsSync(path.join(GATE_ROOT, run, 'browser.json')));
  return found ? path.join(GATE_ROOT, found) : null;
}

/** Each line that differs between the kept and new times, for a person to check before committing. */
function changes(kept, times) {
  const names = [...new Set([...Object.keys(kept), ...Object.keys(times)])].sort();
  return names.filter((name) => kept[name] !== times[name])
    .map((name) => `  ${name.padEnd(14)} ${kept[name] ?? 'new'} -> ${times[name] ?? 'removed'}`);
}

/** Rewrites the kept CI times from the named run, or the latest one, and lists what changed. */
function main(arg) {
  const run = arg ? insideGate(arg) : latestRun();
  const file = run && path.join(run, 'browser.json');
  if (!file || !fs.existsSync(file)) {
    console.error(`No browser.json in ${arg ?? 'out/gate/'}: run npm run check:all first, or name a run in out/gate/`);
    process.exit(2);
  }
  const kept = JSON.parse(fs.readFileSync(SUITE_TIMES, 'utf8'));
  const measured = measuredTimes(JSON.parse(fs.readFileSync(file, 'utf8')).suites);
  const specs = fs.readdirSync('tests/browser').filter((file) => file.endsWith('.spec.mjs'));
  const suites = specs.map((file) => file.replace('.spec.mjs', ''));
  const { times, scale } = updatedTimes(kept, measured, suites);
  const lines = changes(kept, times);
  fs.writeFileSync(SUITE_TIMES, `${JSON.stringify(times, null, 2)}\n`);
  console.log(`${Object.keys(measured).length} suite times from ${path.relative(process.cwd(), run)}, scaled by`
    + ` ${scale.toFixed(2)} to CI speed; ${lines.length ? `changed in ${SUITE_TIMES}:` : 'no changes.'}`);
  for (const line of lines) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv[2]);
