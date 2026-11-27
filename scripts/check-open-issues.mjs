// Fails when an allowance names an issue that is not open, so a closed issue cannot keep an exception alive.
// It reads GitHub, so only CI runs it (the static job, with GITHUB_TOKEN).
import { existsSync, readFileSync } from 'node:fs';
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

function issuesNamed() {
  const numbers = [];
  for (const file of ALLOWANCE_FILES.filter(existsSync)) {
    const entries = readEntries(file);
    for (const { issue } of Array.isArray(entries) ? entries : []) {
      if (issue !== undefined) numbers.push(issue);
    }
  }
  return [...new Set(numbers)];
}

async function openIssuesPage(page) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = process.env;
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const response = await fetch(`${api}/repos/${repository}/issues?state=open&per_page=100&page=${page}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

async function main() {
  let named;
  try {
    named = issuesNamed();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  try {
    const closed = await closedIssues(named, openIssuesPage);
    for (const number of closed) console.error(`#${number} is not an open issue`);
    if (closed.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Cannot reach GitHub to check the issues the allowances name (${error.message})`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
