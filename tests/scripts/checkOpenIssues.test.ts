// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error the script is plain JavaScript
import { ALLOWANCE_FILES, checkOpenIssues, closedIssues } from '../../scripts/check-open-issues.mjs';

const script = path.resolve('scripts/check-open-issues.mjs');
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake fetch serving the given open-issue pages, then an empty page; it records every requested URL.
function githubServing(pages: object[][], status = 200) {
  const requested: URL[] = [];
  const fetch = async (url: URL) => {
    requested.push(new URL(url));
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status });
  };
  return { fetch, requested };
}

const goodEnv = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };

function repoNaming(issues: number[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'open-issues-'));
  directories.push(dir);
  mkdirSync(path.join(dir, 'scripts'));
  const entries = issues.map((issue) => ({ file: 'a.ts', kind: 'x', line: 'y', count: 1, issue }));
  writeFileSync(path.join(dir, ALLOWANCE_FILES[0]), JSON.stringify(entries));
  return dir;
}

function runCli(cwd: string, env: Record<string, string>) {
  return new Promise<{ status: number | null; stderr: string }>((done) => {
    const child = spawn(process.execPath, [script], { cwd, env: { PATH: process.env.PATH, ...env } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => done({ status, stderr }));
  });
}

describe('issues named by the allowances', () => {
  it('reports a closed issue and a pull request number', async () => {
    const open = [{ number: 5 }, { number: 8, pull_request: {} }];
    expect(await closedIssues([5, 6, 8], async () => [])).toEqual([5, 6, 8]);
    expect(await closedIssues([5, 6, 8], async (page: number) => (page === 1 ? open : []))).toEqual([6, 8]);
  });

  it('reads every page', async () => {
    const pages = [[{ number: 1 }], [{ number: 2 }], []];
    const asked: number[] = [];
    const fetchPage = async (page: number) => {
      asked.push(page);
      return pages[page - 1] ?? [];
    };
    expect(await closedIssues([1, 2, 3], fetchPage)).toEqual([3]);
    expect(asked).toEqual([1, 2, 3]);
  });

  it('only ever requests the GitHub API origin', async () => {
    const github = githubServing([[{ number: 5 }]]);
    const env = { ...goodEnv, GITHUB_API_URL: 'http://127.0.0.1:1' };
    await checkOpenIssues({ env, fetch: github.fetch, root: repoNaming([5]) });
    expect(github.requested.length).toBeGreaterThan(0);
    for (const url of github.requested) expect(url.origin).toBe('https://api.github.com');
    expect(github.requested[0].pathname).toBe('/repos/o/r/issues');
  });

  it('fails when the token is missing or the request fails', async () => {
    const dir = repoNaming([5]);
    const failing = async () => {
      throw new Error('connect refused');
    };
    const noToken = await checkOpenIssues({ env: { GITHUB_REPOSITORY: 'o/r' }, fetch: failing, root: dir });
    const failedRequest = await checkOpenIssues({ env: goodEnv, fetch: failing, root: dir });
    for (const result of [noToken, failedRequest]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cannot reach GitHub to check the issues the allowances name');
    }
  });

  it('says an allowance file is malformed, not that GitHub cannot be reached', async () => {
    const dir = repoNaming([5]);
    writeFileSync(path.join(dir, ALLOWANCE_FILES[0]), '[{');
    const result = await checkOpenIssues({ env: goodEnv, fetch: githubServing([[{ number: 5 }]]).fetch, root: dir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${ALLOWANCE_FILES[0]} is not valid JSON`);
    expect(result.stderr).not.toContain('Cannot reach GitHub');
  });

  it.each([403, 500])('fails when GitHub answers %i', async (status) => {
    const fetch = githubServing([[{ number: 5 }]], status).fetch;
    const result = await checkOpenIssues({ env: goodEnv, fetch, root: repoNaming([5]) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the issues the allowances name (GitHub answered ${status})`);
  });

  it.each(['owner', 'owner/name/extra', 'own er/name', 'owner/na?me', '../name', ''])(
    'refuses GITHUB_REPOSITORY %j',
    async (repository) => {
      const github = githubServing([]);
      const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: repository };
      const result = await checkOpenIssues({ env, fetch: github.fetch, root: repoNaming([5]) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('GITHUB_REPOSITORY must be owner/name');
      expect(result.stderr).not.toContain('Cannot reach GitHub');
      expect(github.requested).toEqual([]);
    },
  );

  it('names each issue that is not open and passes when all are open', async () => {
    const fetch = githubServing([[{ number: 5 }]]).fetch;
    const closed = await checkOpenIssues({ env: goodEnv, fetch, root: repoNaming([5, 6]) });
    expect(closed.status).toBe(1);
    expect(closed.stderr).toContain('#6 is not an open issue');
    expect(closed.stderr).not.toContain('#5 ');
    expect((await checkOpenIssues({ env: goodEnv, fetch, root: repoNaming([5]) })).status).toBe(0);
  });

  it('runs as a command and refuses a bad GITHUB_REPOSITORY without the network', async () => {
    const result = await runCli(repoNaming([5]), { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'owner' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GITHUB_REPOSITORY must be owner/name');
  });
});
