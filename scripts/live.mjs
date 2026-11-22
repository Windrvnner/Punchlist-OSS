// The live runs on Claude, which make paid calls; the only other one is npm run ai:check -- claude (scripts/ai-check.mjs).
// Every other script, check and test ignores the key, even when the shell holds it: a run asks for live calls with
// PUNCHLIST_LIVE=1, which only this script sets.
//   npm run e2e:live                                   the live pipeline test (tests/e2e/live.test.ts)
//   npm run e2e:live -- tests/e2e/live-agent.test.ts   another live test, or several
//   npm run desktop:live                               the desktop app, signed in with the key when none is entered
// The key comes from PUNCHLIST_AI_KEY, a file named in PUNCHLIST_AI_KEY_FILE, or the project's .env (git ignores it); it is never written anywhere.
// Light by default (every call to Haiku, with a cap on calls). PUNCHLIST_LIVE_ROUTING=1 tests the three tiers on three models.
import { spawnSync } from 'node:child_process';
import { aiKey } from './aiKey.mjs';
const key = aiKey();
if (!key) { console.error('Put the key in .env (see .env.example), or set PUNCHLIST_AI_KEY.'); process.exit(2); }
const env = { ...process.env, PUNCHLIST_LIVE: '1', PUNCHLIST_AI_KEY: key, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? (process.env.HTTPS_PROXY ? '1' : '') };
const args = process.argv.slice(2);
// with no live test named (no arguments, or only vitest flags), the pipeline test alone: never the whole suite on the key
const files = args.some((a) => /live[\w-]*\.test\.ts$/.test(a)) ? [] : ['tests/e2e/live.test.ts'];
const [cmd, cmdArgs] = args[0] === '--desktop' ? ['npm', ['run', 'desktop']] : ['npx', ['vitest', 'run', ...files, ...args, '--reporter=verbose']];
const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
