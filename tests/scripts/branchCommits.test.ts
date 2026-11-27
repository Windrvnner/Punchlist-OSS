// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error the script is plain JavaScript
import { addedFiles, addedText, branchRange } from '../../scripts/branch-commits.mjs';

const directories: string[] = [];

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'branch-commits-'));
  directories.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const commit = (file: string, text: string) => {
    writeFileSync(path.join(dir, file), text);
    git('add', '-f', file);
    git('commit', '-q', '-m', `edit ${file}`);
  };
  commit('base.txt', 'base\n');
  return { dir, git, commit };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the branch commits', () => {
  it('lists the lines a branch commit adds', () => {
    const { dir, git, commit } = repo();
    git('checkout', '-q', '-b', 'feature');
    commit('a.txt', 'one\ntwo\n');
    const range = branchRange(dir);
    expect(range).toMatch(/^[0-9a-f]+\.\.HEAD$/);
    const added = addedText(range, dir);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ file: 'a.txt', text: 'one\ntwo' });
    expect(added[0].sha).toBe(git('rev-parse', 'HEAD').trim());
  });

  it('keeps a line added in one commit and removed in the next', () => {
    const { dir, git, commit } = repo();
    git('checkout', '-q', '-b', 'feature');
    commit('a.txt', 'secret line\n');
    commit('a.txt', 'clean\n');
    const texts = addedText(branchRange(dir), dir).map((item: { text: string }) => item.text);
    expect(texts).toContain('secret line');
  });

  it('lists a line a merge resolution adds', () => {
    const { dir, git, commit } = repo();
    git('checkout', '-q', '-b', 'feature');
    commit('a.txt', 'feature\n');
    git('checkout', '-q', 'main');
    commit('a.txt', 'main\n');
    git('checkout', '-q', 'feature');
    try {
      git('merge', '-q', 'main');
    } catch {
      // the conflict is resolved by hand below
    }
    writeFileSync(path.join(dir, 'a.txt'), 'resolved by hand\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'merge');
    const texts = addedText(branchRange(dir), dir).map((item: { text: string }) => item.text);
    expect(texts.some((text: string) => text.includes('resolved by hand'))).toBe(true);
  });

  it('lists a file a branch commit adds even when a later commit deletes it', () => {
    const { dir, git, commit } = repo();
    git('checkout', '-q', '-b', 'feature');
    commit('.env', 'X=1\n');
    git('rm', '-q', '-f', '.env');
    git('commit', '-q', '-m', 'remove');
    expect(addedFiles(branchRange(dir), dir).map((item: { file: string }) => item.file)).toEqual(['.env']);
  });

  it('returns null on main', () => {
    expect(branchRange(repo().dir)).toBeNull();
  });

  it('throws with the fetch command without main', () => {
    const { dir, git } = repo();
    git('checkout', '-q', '-b', 'feature');
    git('branch', '-q', '-D', 'main');
    expect(() => branchRange(dir)).toThrow(/git fetch .*origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
  });
});
