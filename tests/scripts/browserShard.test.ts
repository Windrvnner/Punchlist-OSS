// @vitest-environment node
// How the browser runner splits its suites into CI groups of about equal time and orders them longest first.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { longestFirst, shardOf, typicalTime } from '../../scripts/browser-shard.mjs';

const ciTimes: Record<string, number> = JSON.parse(fs.readFileSync('tests/browser/suite-times.json', 'utf8'));
const suites = fs.readdirSync('tests/browser').filter((file) => file.endsWith('.spec.mjs'))
  .map((file) => file.replace('.spec.mjs', '')).sort();
const sum = (names: string[]) => names.reduce((total, name) => total + ciTimes[name], 0);
const groupsOf = (names: string[], count: number, times: Record<string, number>) =>
  Array.from({ length: count }, (_, index) => shardOf(names, index + 1, count, times));

describe('the CI times kept in the repo', () => {
  it('give a positive time for every browser suite and for nothing else', () => {
    expect(Object.keys(ciTimes).sort()).toEqual(suites);
    for (const secs of Object.values(ciTimes)) expect(secs).toBeGreaterThan(0);
  });
});

describe('splitting the suites into CI groups', () => {
  it('puts every suite in exactly one group, for any number of groups', () => {
    for (const count of [1, 2, 3, 4, 6, 8, suites.length, suites.length + 3]) {
      const placed = groupsOf(suites, count, ciTimes).flat();
      expect(placed.sort()).toEqual(suites);
    }
  });

  it('keeps the four CI groups within the longest suite of each other', () => {
    const totals = groupsOf(suites, 4, ciTimes).map(sum);
    const longest = Math.max(...Object.values(ciTimes));
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(longest);
    // the round-robin split by name it replaces put 1,194 s in one group and 474 s in another
    expect(Math.max(...totals)).toBeLessThan(sum(suites) / 4 + longest / 2);
  });

  it('splits only the named suites, and the same way on every call', () => {
    const named = ['checklist', 'lostwork', 'qapanel', 'keyboard', 'toolbars'];
    const groups = groupsOf(named, 2, ciTimes);
    expect(groups.flat().sort()).toEqual([...named].sort());
    expect(groupsOf(named, 2, ciTimes)).toEqual(groups);
    expect(groups).toEqual([['checklist', 'keyboard'], ['lostwork', 'qapanel', 'toolbars']]);
  });

  it('gives a suite with no CI time the middle time, so it still lands in a group', () => {
    const times = { long: 300, middle: 100, short: 10 };
    expect(typicalTime(times)).toBe(100);
    const groups = groupsOf(['long', 'middle', 'short', 'newcomer'], 2, times);
    expect(groups).toEqual([['long'], ['middle', 'newcomer', 'short']]);
    expect(typicalTime({})).toBe(1);
  });
});

describe('ordering a group', () => {
  it('starts the longest first, with ties in name order', () => {
    expect(longestFirst(['b', 'a', 'c', 'd'], { a: 5, b: 5, c: 50, d: 1 })).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores times that are not positive numbers', () => {
    const times = { a: 10, b: Number.NaN, c: -4, d: 30, e: 20 } as Record<string, number>;
    expect(longestFirst(['a', 'b', 'c', 'd', 'e'], times)).toEqual(['d', 'b', 'c', 'e', 'a']);
  });
});
