// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error the script is plain JavaScript
import { ALLOWANCE_FILES, closedIssues } from '../../scripts/check-open-issues.mjs';

const script = path.resolve('scripts/check-open-issues.mjs');
const directories: string[] = [];
const servers: Server[] = [];
const unreachable = 'http://127.0.0.1:1';

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

// Serves the given open-issue pages at /repos/o/r/issues, then an empty page; returns its address.
async function githubServing(pages: object[][], status = 200) {
  const server = createServer((request, response) => {
    response.statusCode = status;
    const page = Number(new URL(request.url ?? '', 'http://x').searchParams.get('page'));
    response.end(JSON.stringify(pages[page - 1] ?? []));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

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

  it('fails when GitHub cannot be reached', async () => {
    const dir = repoNaming([5]);
    const noToken = await runCli(dir, { GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: unreachable });
    const withToken = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: unreachable };
    const failedRequest = await runCli(dir, withToken);
    for (const result of [noToken, failedRequest]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cannot reach GitHub to check the issues the allowances name');
    }
  });

  it.each([403, 500])('fails when GitHub answers %i', async (status) => {
    const api = await githubServing([[{ number: 5 }]], status);
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: api };
    const result = await runCli(repoNaming([5]), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the issues the allowances name (GitHub answered ${status})`);
  });

  it('names each issue that is not open and passes when all are open', async () => {
    const api = await githubServing([[{ number: 5 }]]);
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: api };
    const closed = await runCli(repoNaming([5, 6]), env);
    expect(closed.status).toBe(1);
    expect(closed.stderr).toContain('#6 is not an open issue');
    expect(closed.stderr).not.toContain('#5 ');
    expect((await runCli(repoNaming([5]), env)).status).toBe(0);
  });
});
