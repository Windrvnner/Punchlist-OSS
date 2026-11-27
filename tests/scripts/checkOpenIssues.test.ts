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
function githubServing(pages: object[][], status = 200, headers: Record<string, string> = {}) {
  const requested: URL[] = [];
  const fetch = async (url: URL) => {
    requested.push(new URL(url));
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status, headers });
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

  it.each([429, 500, 503])('fails when GitHub answers %i on all three attempts', async (status) => {
    const github = githubServing([[{ number: 5 }]], status);
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    const result = await checkOpenIssues({ env: goodEnv, fetch: github.fetch, root: repoNaming([5]), wait });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the issues the allowances name (GitHub answered ${status})`);
    expect(github.requested).toHaveLength(3);
    expect(waits).toHaveLength(2);
  });

  // Waits for each answer; `headers` are the answer's rate-limit headers.
  async function waitsFor(status: number, headers: Record<string, string>) {
    const github = githubServing([[{ number: 5 }]], status, headers);
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    const result = await checkOpenIssues({ env: goodEnv, fetch: github.fetch, root: repoNaming([5]), wait });
    return { result, waits, requested: github.requested };
  }

  it('fails at once on a 403 that is not a rate limit', async () => {
    const { result, requested } = await waitsFor(403, {});
    expect(result.stderr).toContain('GitHub answered 403');
    expect(requested).toHaveLength(1);
  });

  it('waits until the rate limit resets on a 403 with no requests left', async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 30);
    const { waits, requested } = await waitsFor(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset });
    expect(requested).toHaveLength(3);
    for (const ms of waits) expect(ms).toBeGreaterThan(25_000);
    for (const ms of waits) expect(ms).toBeLessThanOrEqual(31_000);
  });

  it('waits the seconds that retry-after gives, and 2 seconds on a server error', async () => {
    expect((await waitsFor(429, { 'retry-after': '7' })).waits).toEqual([7000, 7000]);
    expect((await waitsFor(403, { 'retry-after': '3' })).waits).toEqual([3000, 3000]);
    expect((await waitsFor(502, {})).waits).toEqual([2000, 2000]);
    // GitHub sends the rate-limit headers with every answer; they set the wait only when no requests are left.
    const reset = String(Math.ceil(Date.now() / 1000) + 3600);
    const spare = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': reset };
    expect((await waitsFor(502, spare)).waits).toEqual([2000, 2000]);
  });

  it('fails without waiting when GitHub asks for a wait longer than five minutes', async () => {
    const { result, waits, requested } = await waitsFor(429, { 'retry-after': '3600' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('GitHub asked to wait 3600 seconds, longer than 300');
    expect(waits).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  it('fails without waiting when the rate limit resets more than five minutes away', async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 3600);
    const { result, waits } = await waitsFor(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^GitHub asked to wait \d+ seconds, longer than 300$/);
    expect(waits).toEqual([]);
  });

  it('waits exactly five minutes when GitHub asks for that', async () => {
    expect((await waitsFor(429, { 'retry-after': '300' })).waits).toEqual([300_000, 300_000]);
  });

  it('waits 2 seconds when retry-after or x-ratelimit-reset cannot be read', async () => {
    expect((await waitsFor(429, { 'retry-after': 'soon' })).waits).toEqual([2000, 2000]);
    const unread = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'later' };
    expect((await waitsFor(403, unread)).waits).toEqual([2000, 2000]);
  });

  it('reads a retry-after header given as an HTTP date', async () => {
    const at = new Date(Date.now() + 20_000).toUTCString();
    const { waits } = await waitsFor(429, { 'retry-after': at });
    expect(waits).toHaveLength(2);
    for (const ms of waits) expect(ms).toBeGreaterThan(15_000);
    for (const ms of waits) expect(ms).toBeLessThanOrEqual(20_000);
  });

  it('retries a server error or rate limit and passes once GitHub answers', async () => {
    const statuses = [502, 429, 200, 200];
    const requested: URL[] = [];
    const fetch = async (url: URL) => {
      requested.push(new URL(url));
      const body = requested.length === 3 ? [{ number: 5 }] : [];
      return new Response(JSON.stringify(body), { status: statuses[requested.length - 1] });
    };
    const wait = async () => {};
    const result = await checkOpenIssues({ env: goodEnv, fetch, root: repoNaming([5]), wait });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(requested).toHaveLength(4);
  });

  it('fails at once on another answer such as 404', async () => {
    const github = githubServing([[{ number: 5 }]], 404);
    const wait = async () => {};
    const result = await checkOpenIssues({ env: goodEnv, fetch: github.fetch, root: repoNaming([5]), wait });
    expect(result.stderr).toContain('GitHub answered 404');
    expect(github.requested).toHaveLength(1);
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
