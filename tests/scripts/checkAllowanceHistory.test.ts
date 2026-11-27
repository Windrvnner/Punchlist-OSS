// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { staticCommands } from './staticSteps';

const script = path.resolve('scripts/check-allowance-history.mjs');
const baselineFile = 'scripts/pane-of-glass-baseline.json';
const vendorFile = 'scripts/vendor-names-allowance.json';
const verifiedFile = 'scripts/verified-decisions.json';
const screen = 'src/ui/Screen.tsx';
const directories: string[] = [];
type Entry = { file: string; kind: string; line: string; count: number; issue?: number; decision?: string };

const entry = (count: number, extra: Partial<Entry> = {}): Entry =>
  ({ file: screen, kind: 'services', line: 'store.services.ai', count, issue: 7, ...extra });

function git(dir: string, ...args: string[]) {
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
  return execFileSync('git', [...identity, ...args], { cwd: dir, encoding: 'utf8' });
}

const check = (cwd: string) => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });

// A repository whose `main` holds the given files; `write` changes the working tree afterwards.
function repository(committed: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'allowance-history-'));
  directories.push(dir);
  function write(file: string, content: unknown) {
    const destination = path.join(dir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, typeof content === 'string' ? content : JSON.stringify(content));
  }
  write(screen, 'store.services.ai');
  write(verifiedFile, []);
  for (const [file, content] of Object.entries(committed)) write(file, content);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Record main');
  git(dir, 'switch', '-qc', 'topic');
  return { dir, write, run: () => check(dir) };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('allowance history', () => {
  it('runs after the pane-of-glass check in the static check', () => {
    const commands = staticCommands();
    const paneOfGlass = commands.indexOf('node scripts/check-pane-of-glass.mjs');
    expect(commands.indexOf('node scripts/check-allowance-history.mjs')).toBeGreaterThan(paneOfGlass);
  });

  it.each([true, false])('rejects a manual increase when main has a baseline (%s)', (hasBaseline) => {
    const repo = repository(hasBaseline ? { [baselineFile]: [entry(1)] } : { [baselineFile]: {} });
    repo.write(screen, 'store.services.ai\nstore.services.ai');
    repo.write(baselineFile, [entry(2)]);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${screen} services "store.services.ai": count 2 is above main's 1`);
  });

  it('keeps, lowers and removes entries of main without a problem', () => {
    const repo = repository({ [baselineFile]: [entry(2), entry(1, { line: 'other' })] });
    repo.write(baselineFile, [entry(1)]);
    const result = repo.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('accepts every entry of a vendor file that main does not have yet', () => {
    const repo = repository({ [baselineFile]: [] });
    repo.write(vendorFile, [entry(3)]);
    expect(repo.run().status).toBe(0);
  });

  it('rejects an issue entry added to a vendor file main already has', () => {
    const repo = repository({ [baselineFile]: [], [vendorFile]: [] });
    repo.write(vendorFile, [entry(1)]);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('count 1 is above main\'s 0');
  });

  it('refuses a decision that main does not verify, even if the pull request verifies it', () => {
    const repo = repository({ [baselineFile]: [] });
    repo.write(verifiedFile, ['A decision.']);
    repo.write(baselineFile, [entry(1, { issue: undefined, decision: 'A decision.' })]);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('decision is not on main\'s scripts/verified-decisions.json');
  });

  it('rejects an entry moved to another issue or to a decision', () => {
    const repo = repository({ [baselineFile]: [entry(1)], [verifiedFile]: ['A decision.'] });
    repo.write(baselineFile, [entry(1, { issue: 8 })]);
    const swapped = repo.run();
    expect(swapped.status).toBe(1);
    expect(swapped.stderr).toContain("issue 8 replaces main's issue 7");
    repo.write(baselineFile, [entry(1, { issue: undefined, decision: 'A decision.' })]);
    const decided = repo.run();
    expect(decided.status).toBe(1);
    expect(decided.stderr).toContain("decision replaces main's issue 7");
  });

  describe('an entry moved to the new text of an edited line', () => {
    const filler = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;'];
    const before = ['import x from "y";', 'store.services.ai', ...filler].join('\n');
    const renamed = entry(1, { line: 'state.services.ai' });
    // main lists `store.services.ai` once, by issue, or (with no array baseline) by main's own screens.
    const edited = (onMain: unknown = [entry(1)]) => repository({ [baselineFile]: onMain, [screen]: before });

    it.each([['a list', [entry(1)]], ['no list', {}]])('accepts a renamed line (main has %s)', (_, onMain) => {
      const repo = edited(onMain);
      repo.write(screen, before.replace('store.services.ai', 'state.services.ai'));
      repo.write(baselineFile, [renamed]);
      const result = repo.run();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it('rejects a new line elsewhere when the listed line is deleted in another hunk', () => {
      const repo = edited();
      repo.write(screen, [...before.split('\n').filter((row) => row !== 'store.services.ai'), 'state.services.ai']
        .join('\n'));
      repo.write(baselineFile, [renamed]);
      const result = repo.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${screen} services "state.services.ai": count 1 is above main's 0`);
    });

    it('rejects a moved entry whose count is above the old count', () => {
      const repo = edited();
      repo.write(screen, before.replace('store.services.ai', 'state.services.ai'));
      repo.write(baselineFile, [entry(2, { line: 'state.services.ai' })]);
      const result = repo.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("count 2 is above main's 1");
    });

    it('rejects two entries that take more than the old count', () => {
      const repo = edited();
      repo.write(screen, before.replace('store.services.ai', 'state.services.ai\nstate.services.ai2'));
      repo.write(baselineFile, [renamed, entry(1, { line: 'state.services.ai2' })]);
      const result = repo.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${screen} services "state.services.ai2": count 1 is above main's 0`);
    });

    it('rejects a moved entry while the old line is still in the file', () => {
      const repo = edited();
      repo.write(screen, before.replace('store.services.ai', 'store.services.ai\nstate.services.ai'));
      repo.write(baselineFile, [entry(1), renamed]);
      const result = repo.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("state.services.ai\": count 1 is above main's 0");
    });

    it('rejects a moved entry that cites another issue', () => {
      const repo = edited();
      repo.write(screen, before.replace('store.services.ai', 'state.services.ai'));
      repo.write(baselineFile, [entry(1, { line: 'state.services.ai', issue: 8 })]);
      expect(repo.run().status).toBe(1);
    });
  });

  it('reports an allowance file that is not an array', () => {
    const repo = repository({ [baselineFile]: [] });
    repo.write(baselineFile, {});
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${baselineFile} must be a JSON array of entries`);
  });

  it('accepts a decision that main verifies on an entry main already has', () => {
    const decided = entry(1, { issue: undefined, decision: 'A decision.' });
    const repo = repository({ [baselineFile]: [decided], [verifiedFile]: ['A decision.'] });
    repo.write(screen, 'store.services.ai\nother');
    expect(repo.run().status).toBe(0);
  });

  const mainBaselines: [string, unknown][] = [['a list', []], ['no list', {}]];
  it.each(mainBaselines)('rejects a new line listed under a decision (main has %s)', (_, onMain) => {
    const repo = repository({ [baselineFile]: onMain, [verifiedFile]: ['A decision.'] });
    repo.write(screen, 'store.services.ai\nrows.filter(keep).slice(0, 3)');
    const decided = { kind: 'list', line: 'rows.filter(keep).slice(0, 3)', issue: undefined, decision: 'A decision.' };
    repo.write(baselineFile, [entry(2, decided)]);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('list "rows.filter(keep).slice(0, 3)": count 2 is above main\'s 0');
  });

  it('keeps and lowers a decision entry of main without a problem', () => {
    const decided = { issue: undefined, decision: 'A decision.' };
    const repo = repository({ [baselineFile]: [entry(2, decided)], [verifiedFile]: ['A decision.'] });
    repo.write(baselineFile, [entry(2, decided)]);
    expect(repo.run().stderr).toBe('');
    repo.write(baselineFile, [entry(1, decided)]);
    expect(repo.run().stderr).toBe('');
  });

  it('rejects a raised decision entry', () => {
    const decided = { issue: undefined, decision: 'A decision.' };
    const repo = repository({ [baselineFile]: [entry(1, decided)], [verifiedFile]: ['A decision.'] });
    repo.write(baselineFile, [entry(2, decided)]);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("count 2 is above main's 1");
  });

  it('accepts a decision entry of main moved to an issue', () => {
    const decided = entry(1, { issue: undefined, decision: 'A decision.' });
    const repo = repository({ [baselineFile]: [decided], [verifiedFile]: ['A decision.'] });
    repo.write(baselineFile, [entry(1)]);
    const result = repo.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('requires main to verify a committed increase in a shallow single-branch clone', () => {
    const repo = repository({ [baselineFile]: [entry(1)] });
    repo.write(baselineFile, [entry(2)]);
    git(repo.dir, 'commit', '-qam', 'Raise the allowance');
    const clone = path.join(repo.dir, 'shallow');
    git(repo.dir, 'clone', '-q', '--depth=1', '--single-branch', pathToFileURL(repo.dir).href, clone);
    const fetch = ['fetch', '--unshallow', 'origin', '+refs/heads/main:refs/remotes/origin/main'];
    const missing = check(clone);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(['git', ...fetch].join(' '));

    git(clone, ...fetch);
    const result = check(clone);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("count 2 is above main's 1");
  });

  it('names the missing reference when a repository has no committed baseline or main', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'allowance-history-'));
    directories.push(dir);
    git(dir, 'init', '-q', '-b', 'topic');
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('git fetch origin +refs/heads/main:refs/remotes/origin/main');
  });
});
