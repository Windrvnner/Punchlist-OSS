// Fails when an allowance names an issue that is not open, so a closed issue cannot keep an exception alive.
// It reads GitHub, so only CI runs it (the static job, with GITHUB_TOKEN).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALLOWANCE_FILES } from './allowance.mjs';

export { ALLOWANCE_FILES };

// The numbers, among `numbers`, that are not an open issue (a pull request number is not an issue).
export async function closedIssues(numbers, fetchPage) {
  const open = new Set();
  for (let page = 1; ; page += 1) {
    const items = await fetchPage(page);
    if (items.length === 0) break;
    for (const item of items) {
      if (!item.pull_request) open.add(item.number);
    }
  }
  return numbers.filter((number) => !open.has(number));
}

function readEntries(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

function issuesNamed(root) {
  const numbers = [];
  for (const file of ALLOWANCE_FILES.map((name) => path.join(root, name)).filter(existsSync)) {
    const entries = readEntries(file);
    for (const { issue } of Array.isArray(entries) ? entries : []) {
      if (issue !== undefined) numbers.push(issue);
    }
  }
  return [...new Set(numbers)];
}

// The issues endpoint for the environment's repository. The host is fixed, so the token only ever goes to GitHub.
function issuesEndpoint(repository) {
  const ownerAndName = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
  if (!ownerAndName.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY must be owner/name');
  return new URL(`https://api.github.com/repos/${repository}/issues`);
}

async function openIssuesPage({ endpoint, token, fetch }, page) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ state: 'open', per_page: '100', page: String(page) }).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

// Runs the check; `fetch` is a parameter so tests need no network. Returns the exit status and what it printed.
export async function checkOpenIssues({ env, fetch, root = '.' }) {
  const lines = [];
  const result = (status) => ({ status, stderr: lines.join('\n') });
  let named;
  let endpoint;
  try {
    named = issuesNamed(root);
    endpoint = issuesEndpoint(env.GITHUB_REPOSITORY);
  } catch (error) {
    lines.push(error.message);
    return result(1);
  }
  try {
    const source = { endpoint, token: env.GITHUB_TOKEN, fetch };
    const closed = await closedIssues(named, (page) => openIssuesPage(source, page));
    for (const number of closed) lines.push(`#${number} is not an open issue`);
    return result(closed.length ? 1 : 0);
  } catch (error) {
    lines.push(`Cannot reach GitHub to check the issues the allowances name (${error.message})`);
    return result(1);
  }
}

async function main() {
  const { status, stderr } = await checkOpenIssues({ env: process.env, fetch });
  if (stderr) console.error(stderr);
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
