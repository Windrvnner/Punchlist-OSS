// Runs every browser suite in tests/browser, several at a time, against the built app in dist/.
//   node scripts/browser-all.mjs [--jobs 5] [name ...]     e.g.  npm run browser -- --jobs 4 decisions keyboard
//   --shard 2/4 runs only the second of four groups of suites (every fourth suite), for parallel CI jobs
// Each suite starts its own browser and shares nothing with the others, so they can run side by side. A suite that fails
// while others are running is run once more on its own; if it passes then, that is reported as such, not hidden.
// Exit code 0 only if every suite passed (alone or alongside). Logs go to out/browser/<suite>.log.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import http from 'node:http';

const args = process.argv.slice(2); const j = args.indexOf('--jobs'); const jobs = j >= 0 ? Math.max(1, +args[j + 1] || 1) : 5;
const shardAt = args.indexOf('--shard');
const optionValues = [j, shardAt].filter((at) => at >= 0).map((at) => at + 1);
const only = args.filter((a, i) => !a.startsWith('--') && !optionValues.includes(i));
const all = fs.readdirSync('tests/browser').filter((f) => f.endsWith('.spec.mjs')).map((f) => f.replace('.spec.mjs', '')).sort();
const named = only.length ? all.filter((s) => only.includes(s)) : all;
const suites = inShard(named, shardAt >= 0 ? args[shardAt + 1] : null);

/** With `--shard k/n`, the k-th of n groups, taking every n-th suite in name order; otherwise every suite. */
function inShard(names, shard) {
  if (shard === null) return names;
  const [k, n] = (shard ?? '').split('/').map(Number);
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 1 || k > n) {
    console.error(`--shard takes k/n with 1 <= k <= n, not ${shard}`);
    process.exit(2);
  }
  return names.filter((_, index) => index % n === k - 1);
}
const unknown = only.filter((name) => !all.includes(name));
if (unknown.length || !suites.length) {
  console.error(unknown.length ? `Unknown browser suites: ${unknown.join(', ')}` : 'No browser suites were found.');
  process.exit(2);
}
const PORT = +(process.env.PUNCHLIST_PORT || 4178);   // another port lets two copies of the code test side by side
 fs.mkdirSync('out/browser', { recursive: true });
const up = () => new Promise((ok) => { const r = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, (res) => { res.resume(); ok(res.statusCode === 200); }); r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); }); });
// A server left by another checkout must not verify the wrong renderer.
const servesThisBuild = () => new Promise((ok) => {
  const expected = fs.readFileSync('dist/index.html', 'utf8');
  const request = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (part) => { body += part; });
    response.on('end', () => ok(response.statusCode === 200 && body === expected));
    response.on('error', () => ok(false));
  });
  request.on('error', () => ok(false));
  request.on('timeout', () => {
    request.destroy();
    ok(false);
  });
});
let server = null;
let stopped = false;
if (!(await up())) {
  const log = fs.openSync('out/browser/server.log', 'w');
  server = spawn('node', ['tests/browser/serve.mjs', 'dist', String(PORT)], { stdio: ['ignore', log, log] });
  fs.closeSync(log);
  server.on('error', (error) => {
    fs.appendFileSync('out/browser/server.log', `Server could not start: ${error.message}\n`);
  });
  server.on('exit', (code, signal) => {
    fs.appendFileSync('out/browser/server.log', `Server exited: code ${code}, signal ${signal}\n`);
  });
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
}
if (!(await up())) { console.error('The app is not being served on port ' + PORT); process.exit(2); }
if (!(await servesThisBuild())) {
  server?.kill();
  console.error(`The app on port ${PORT} does not serve this checkout's dist. Stop it or set PUNCHLIST_PORT.`);
  process.exit(2);
}

/** A failed server stops the queue, including workers whose earlier probe just returned. */
async function appIsReady() {
  if (stopped) return false;
  const ready = await servesThisBuild().catch(() => false);
  if (stopped) return false;
  if (!ready) {
    stopped = true;
    console.error('The app server stopped or no longer serves this build. See out/browser/server.log.');
  }
  return ready;
}

/** A successful exit without a positive, complete suite summary is missing coverage. */
function suiteResult(name, code, out, started) {
  const summary = [...out.matchAll(/^(\d+)\/(\d+) passed\r?$/gm)].at(-1);
  const passed = summary ? Number(summary[1]) : 0;
  const total = summary ? Number(summary[2]) : 0;
  const valid = Number.isSafeInteger(passed) && Number.isSafeInteger(total) && total > 0 && passed <= total;
  if (!valid) out += `\nFAIL ${name}: missing or invalid positive test summary\n`;
  fs.writeFileSync(`out/browser/${name}.log`, out);
  return {
    name, code: code === 0 && valid && passed === total ? 0 : code || 1,
    passed: valid ? passed : 0, total: valid ? total : 0,
    fails: out.split('\n').filter((line) => line.startsWith('FAIL')),
    // every check line, kept whole for a person comparing two runs (IDs hold spaces and many carry notes)
    lines: out.split('\n').filter((line) => /^(PASS|FAIL) /.test(line)),
    secs: Math.round((Date.now() - started) / 1000),
  };
}

const run = async (name) => {
  if (!(await appIsReady())) return null;
  return new Promise((done) => {
    const started = Date.now();
    let out = '';
    const child = spawn('node', [`tests/browser/${name}.spec.mjs`], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (part) => (out += part));
    child.stderr.on('data', (part) => (out += part));
    child.on('error', (error) => { out += `\nFAIL ${name}: could not start: ${error.message}\n`; });
    child.on('close', (code, signal) => {
      if (signal) out += `\nBrowser suite terminated by signal ${signal}\n`;
      else if (code) out += `\nBrowser suite exited with code ${code}\n`;
      done(suiteResult(name, code, out, started));
    });
  });
};
const started = Date.now(); const queue = [...suites]; const results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (!stopped) {
    const name = queue.shift();
    if (!name) return;
    const result = await run(name);
    if (!result) return;
    results.push(result);
    console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(14)}`
      + ` ${result.passed}/${result.total}  ${result.secs}s`);
  }
}));
for (const result of results.filter((entry) => entry.code !== 0)) {
  if (stopped) break;
  fs.copyFileSync(`out/browser/${result.name}.log`, `out/browser/${result.name}.first.log`);
  const again = await run(result.name);
  if (!again) break;
  const first = result.fails.map((failure) => failure.split(' ')[1]).join(', ') || 'no result';
  console.log(`${again.code === 0 ? 'ok  ' : 'FAIL'} ${again.name.padEnd(14)} ${again.passed}/${again.total}`
    + `  ${again.secs}s  (on its own, after failing alongside others: ${first})`);
  Object.assign(result, again, { rerun: true, firstFails: result.fails });
}
server?.kill();
const completed = new Set(results.map((result) => result.name));
const unrun = suites.filter((name) => !completed.has(name));
if (unrun.length) console.error(`Not run (${unrun.length}/${suites.length} suites): ${unrun.join(', ')}`);
writeGateResult();
const bundle = fs.readdirSync('dist/assets').find((f) => /^index-.*\.js$/.test(f)); const bad = results.filter((r) => r.code !== 0); const rerun = results.filter((r) => r.rerun && r.code === 0);
console.log(`\n${results.reduce((a, r) => a + r.passed, 0)}/${results.reduce((a, r) => a + r.total, 0)} checks passed in ${results.length} suites · ${bundle} · ${Math.round((Date.now() - started) / 1000)}s with ${jobs} at a time`);
if (rerun.length) console.log(`Passed only on their own: ${rerun.map((r) => r.name).join(', ')}`);
if (bad.length) {
  const failed = bad.map((result) => {
    const names = result.fails.map((failure) => failure.split(' ')[1]).join(', ');
    return `${result.name} (${names || `exit ${result.code}`})`;
  });
  console.log(`Failed: ${failed.join('; ')}`);
}
if (stopped) process.exit(2);
if (bad.length) process.exit(1);

/** Under check:all, each requested suite's result for scripts/gate-compare.mjs; an unrun suite has total 0. */
function writeGateResult() {
  const dir = process.env.PUNCHLIST_GATE_DIR;
  if (!dir) return;
  const byName = new Map(results.map((result) => [result.name, result]));
  const entries = suites.map((name) => {
    const result = byName.get(name);
    if (!result) return { name, passed: 0, total: 0, secs: 0, rerun: false, firstFails: [], lines: [] };
    const { passed, total, secs, lines } = result;
    return { name, passed, total, secs, rerun: !!result.rerun, firstFails: result.firstFails ?? [], lines };
  });
  const secs = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(`${dir}/browser.json`, JSON.stringify({ jobs, secs, suites: entries }, null, 2));
}
