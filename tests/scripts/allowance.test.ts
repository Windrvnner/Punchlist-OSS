// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowanceProblems, committedJson, decisionEntries, gitBytes, groupMatches, lowerAllowance, unlistedMatches,
// @ts-expect-error the script is plain JavaScript
} from '../../scripts/allowance.mjs';

const file = 'src/ui/a.tsx';
const line = 'x.filter(Boolean)';
const found = (count = 1) => [{ file, kind: 'list', line, count }];
const entry = (extra: object = {}) => ({ file, kind: 'list', line, count: 1, issue: 7, ...extra });
const problems = (foundNow: object[], allowance: object[], options: object = {}) =>
  allowanceProblems(foundNow, allowance, { decisions: [], verified: [], ...options }) as string[];

describe('groupMatches', () => {
  it('groups identical lines into one entry with a count', () => {
    const match = { file, kind: 'list', line: '  x.filter(Boolean)' };
    expect(groupMatches([match, match])).toEqual(found(2));
  });

  it('carries the line numbers of matches that have them, outside the key', () => {
    const match = { file, kind: 'list', line };
    const grouped = groupMatches([{ ...match, number: 4 }, { ...match, number: 9 }]);
    expect(grouped).toEqual([{ ...found(2)[0], lines: [4, 9] }]);
  });

  it('sorts by file, kind and line', () => {
    const grouped = groupMatches([
      { file: 'b', kind: 'a', line: 'x' },
      { file: 'a', kind: 'b', line: 'x' },
      { file: 'a', kind: 'a', line: 'y' },
      { file: 'a', kind: 'a', line: 'x' },
    ]);
    expect(grouped.map((item: { file: string; kind: string; line: string }) =>
      `${item.file}${item.kind}${item.line}`)).toEqual(['aax', 'aay', 'abx', 'bax']);
  });
});

describe('platform in the key of a skipped entry', () => {
  const skipped = { file: 't.test.ts', kind: 'skipped', line: 'it', count: 1, issue: 7, reason: 'x' };

  it('carries the platform of a match into the grouped entry', () => {
    const match = { file: 't.test.ts', kind: 'skipped', line: 'it', platform: 'linux' };
    expect(groupMatches([match, { ...match, platform: 'win32' }, match])).toEqual([
      { ...match, count: 2 },
      { ...match, platform: 'win32', count: 1 },
    ]);
  });

  it('carries no platform into the entries of any other kind', () => {
    const match = { file, kind: 'list', line, platform: 'linux' };
    expect(groupMatches([match, { ...match, platform: 'win32' }])).toEqual(found(2));
  });

  it('lists the same skipped test once for each platform', () => {
    const seen = [{ ...skipped, platform: 'linux' }, { ...skipped, platform: 'win32' }];
    expect(problems(seen, seen)).toEqual([]);
    expect(problems(seen, [seen[0]]).join('\n')).toContain('1 not listed');
  });
});

describe('decisionEntries', () => {
  it('joins an entry and its indented continuation lines with single spaces', () => {
    const markdown = '# T\n\n- first entry\n  wraps here\n- second\n\ntext\n';
    expect(decisionEntries(markdown)).toEqual(['first entry wraps here', 'second']);
  });
});

describe('allowanceProblems', () => {
  it('accepts matches that equal their entries', () => {
    expect(problems(found(), [entry()])).toEqual([]);
  });

  it('refuses a match with no entry', () => {
    expect(problems(found(), []).join('\n')).toContain('src/ui/a.tsx list "x.filter(Boolean)": 1 not listed');
  });

  it('refuses more matches than the count, and asks to lower a count above the matches', () => {
    expect(problems(found(2), [entry()]).join('\n')).toContain('1 not listed');
    expect(problems(found(1), [entry({ count: 2 })]).join('\n')).toContain('lower the count to 1');
    expect(problems([], [entry()]).join('\n')).toContain('remove this entry');
  });

  it('allows moving one of two identical lines, refuses a third', () => {
    expect(problems(found(2), [entry({ count: 2 })])).toEqual([]);
    expect(problems(found(3), [entry({ count: 2 })]).join('\n')).toContain('1 not listed');
  });

  it('refuses an entry with neither or both of issue and decision', () => {
    expect(problems(found(), [entry({ issue: undefined })]).join('\n')).toContain('exactly one of issue or decision');
    const both = entry({ decision: 'd' });
    expect(problems(found(), [both], { decisions: ['d'], verified: ['d'] }).join('\n'))
      .toContain('exactly one of issue or decision');
  });

  it('refuses an issue that is not a positive integer', () => {
    expect(problems(found(), [entry({ issue: 0 })]).join('\n')).toContain('exactly one of issue or decision');
  });

  it('refuses a decision that is not verified, or not word for word in decisions.md', () => {
    const decided = entry({ issue: undefined, decision: 'A rule.' });
    expect(problems(found(), [decided], { decisions: ['A rule.'], verified: [] }).join('\n'))
      .toContain('decision is not on scripts/verified-decisions.json');
    expect(problems(found(), [decided], { decisions: ['Other.'], verified: ['A rule.'] }).join('\n'))
      .toContain('decision is not word for word in docs/decisions.md');
  });

  it('refuses a decision on a timer, which decides when something happens (#1407)', () => {
    const timer = { file, kind: 'timer', line: 'setTimeout(close, 200)', count: 1 };
    const decided = { ...timer, decision: 'A rule.' };
    const options = { decisions: ['A rule.'], verified: ['A rule.'] };
    expect(problems([timer], [decided], options).join('\n')).toContain('a decision cannot cover a timer');
    expect(problems([timer], [{ ...timer, issue: 7 }], options)).toEqual([]);
  });

  it('refuses a decision that is only a fragment of a decisions.md entry', () => {
    const decided = entry({ issue: undefined, decision: 'A rule' });
    expect(problems(found(), [decided], { decisions: ['A rule that wraps.'], verified: ['A rule'] }).join('\n'))
      .toContain('decision is not word for word in docs/decisions.md');
  });

  it('accepts a verified decision whose decisions.md entry wraps onto a second line', () => {
    const decisions = decisionEntries('- A rule that\n  wraps.\n');
    const decided = entry({ issue: undefined, decision: 'A rule that wraps.' });
    expect(problems(found(), [decided], { decisions, verified: ['A rule that wraps.'] })).toEqual([]);
  });

  it('reports unmatched entries only for entries in scope', () => {
    expect(problems([], [entry()], { scope: () => false })).toEqual([]);
    expect(problems([], [entry()], { scope: () => true }).join('\n')).toContain('remove this entry');
  });

  it('refuses a skipped entry without a reason or a known platform', () => {
    const skipped = { file: 't.test.ts', kind: 'skipped', line: 'it', count: 1, issue: 7 };
    const seen = [{ file: 't.test.ts', kind: 'skipped', line: 'it', count: 1, platform: 'linux' }];
    expect(problems(seen, [{ ...skipped, platform: 'linux', reason: 'x' }])).toEqual([]);
    expect(problems(seen, [{ ...skipped, platform: 'linux', reason: '' }]).join('\n')).toContain('reason');
    expect(problems(seen, [{ ...skipped, platform: 'mac', reason: 'x' }]).join('\n')).toContain('platform');
    expect(problems(seen, [{ ...skipped, reason: 'x' }]).join('\n')).toContain('platform');
  });
});

describe('committedJson', () => {
  const directories: string[] = [];
  const git = (dir: string, ...args: string[]) => execFileSync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args,
  ], { cwd: dir, encoding: 'utf8' });
  function repository() {
    const dir = mkdtempSync(path.join(tmpdir(), 'allowance-'));
    directories.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    return dir;
  }
  function commit(dir: string, name: string, text: string) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'change');
  }
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the file at the merge base with main', () => {
    const dir = repository();
    commit(dir, 'a.json', '[1]');
    git(dir, 'switch', '-q', '-c', 'work');
    commit(dir, 'a.json', '[2]');
    expect(committedJson('a.json', dir)).toEqual([1]);
  });

  it('returns null when the file is absent at the merge base', () => {
    const dir = repository();
    commit(dir, 'other.txt', 'x');
    git(dir, 'switch', '-q', '-c', 'work');
    commit(dir, 'a.json', '[2]');
    expect(committedJson('a.json', dir)).toBeNull();
  });

  it('throws the fetch message when neither origin/main nor main exists', () => {
    const dir = repository();
    git(dir, 'switch', '-q', '-c', 'work');
    commit(dir, 'a.json', '[2]');
    expect(() => committedJson('a.json', dir)).toThrow(/Cannot compare with main\. Run git fetch .* and retry\./);
  });

  it('asks to unshallow when the clone is shallow', () => {
    const source = repository();
    commit(source, 'a.json', '[1]');
    commit(source, 'b.json', '[1]');
    const dir = mkdtempSync(path.join(tmpdir(), 'allowance-'));
    directories.push(dir);
    git(dir, 'clone', '-q', '--depth', '1', `file://${source}`, 'clone');
    const clone = path.join(dir, 'clone');
    git(clone, 'switch', '-q', '-c', 'work');
    git(clone, 'branch', '-q', '-D', 'main');
    git(clone, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(() => committedJson('a.json', clone)).toThrow('Run git fetch --unshallow origin');
  });

  it('returns null outside a Git checkout, as in exported sources', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'allowance-'));
    directories.push(dir);
    expect(committedJson('a.json', dir)).toBeNull();
  });
});

describe('unlistedMatches and lowerAllowance', () => {
  it('reports each group by how many matches it is short of', () => {
    expect(unlistedMatches(found(3), [entry({ count: 1 })])).toEqual([{ ...found(3)[0], missing: 2 }]);
    expect(unlistedMatches(found(1), [entry({ count: 1 })])).toEqual([]);
  });

  it('lowers counts to the matches and drops entries without one', () => {
    const other = entry({ line: 'gone()' });
    expect(lowerAllowance(found(1), [entry({ count: 4 }), other])).toEqual([entry({ count: 1 })]);
  });
});

describe('git failures', () => {
  it('keep git stderr out of the process stderr and name the command, status and cause in the error', () => {
    const module = pathToFileURL(path.resolve('scripts/allowance.mjs')).href;
    const code = `import { git } from ${JSON.stringify(module)};
      try { git('.', 'rev-parse', '--verify', 'no-such-revision'); } catch (e) { console.log(e.message); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('git rev-parse failed (exit 128): fatal: Needed a single revision\n');
  });

  it('names the error code when git wrote nothing to stderr', () => {
    // output larger than the buffer stops git with an empty stderr
    // the exit status depends on when git is stopped, so only the cause is asserted
    expect(() => gitBytes('.', '--version', { maxBuffer: 4 })).toThrow(/ENOBUFS$/);
  });
});
