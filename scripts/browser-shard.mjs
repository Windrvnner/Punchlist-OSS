// How the browser runner splits its suites into groups of about equal time, for parallel CI jobs, and orders a
// group's suites; shared by scripts/browser-all.mjs and its tests.

/** The middle of the known times, which stands in for a suite with no time yet; 1 when no time is known. */
export function typicalTime(times) {
  const known = Object.values(times).filter((secs) => Number.isFinite(secs) && secs > 0).sort((a, b) => a - b);
  return known.length ? known[Math.floor(known.length / 2)] : 1;
}

/** Each suite's time from `times`, or the typical time when it has none. */
function timeOf(times, typical) {
  return (name) => (Number.isFinite(times[name]) && times[name] > 0 ? times[name] : typical);
}

/** The suites ordered longest first by `times` (a missing or invalid time counts as the typical time), ties by name. */
export function longestFirst(names, times) {
  const secs = timeOf(times, typicalTime(times));
  return [...names].sort((a, b) => secs(b) - secs(a) || (a < b ? -1 : 1));
}

/**
 * The k-th of n groups of suites whose summed times are about equal: longest first, each suite goes to the group with
 * the least time so far (the lowest-numbered group on a tie). The same names and times give every CI job the same
 * split, and each suite lands in exactly one group.
 */
export function shardOf(names, k, n, times) {
  const secs = timeOf(times, typicalTime(times));
  const groups = Array.from({ length: n }, () => ({ total: 0, names: [] }));
  for (const name of longestFirst(names, times)) {
    const lightest = groups.reduce((least, group) => (group.total < least.total ? group : least));
    lightest.names.push(name);
    lightest.total += secs(name);
  }
  return groups[k - 1].names;
}
