// The AI check on a live model service: npm run ai:check -- <claude|north|openai>
// Signs in, lists the models, uploads a small file, asks about it and deletes it (tests/e2e/ai-check-live.test.ts).
// The key comes from PUNCHLIST_AI_KEY or PUNCHLIST_AI_KEY_FILE (scripts/aiKey.mjs): an API key for claude or openai, or for
// north the token from "Retrieve your token" at <your North>/developer. On claude only, .env is read too, as the live tests
// do: it holds the Claude key, which must never go to another service. The address comes
// from the control file (north.address, openai.address), or PUNCHLIST_AI_ADDRESS. On claude every call goes to the light
// model unless PUNCHLIST_LIVE_ROUTING=1. The key is never written anywhere.
import { spawnSync } from 'node:child_process';
import { aiKey } from './aiKey.mjs';
const BACKENDS = ['claude', 'north', 'openai'];
const backend = process.argv[2];
if (!BACKENDS.includes(backend)) { console.error(`${backend ? `Unknown backend "${backend}". ` : ''}Name the backend: npm run ai:check -- <${BACKENDS.join('|')}>`); process.exit(2); }
const key = aiKey({ envFile: backend === 'claude' });
if (!key) { console.error(`Set PUNCHLIST_AI_KEY to the ${backend === 'north' ? 'token from <your North>/developer' : 'API key'}${backend === 'claude' ? ', or put it in .env' : ''}.`); process.exit(2); }
// a Claude key (sk-ant-…) goes to Claude only, never to North or an OpenAI-compatible server
if (backend !== 'claude' && key.includes('sk-ant-')) { console.error(`PUNCHLIST_AI_KEY holds a Claude key: set it to the ${backend === 'north' ? 'North token' : 'API key'} for ${backend}.`); process.exit(2); }
if (backend === 'claude' && process.env.PUNCHLIST_AI_ADDRESS?.trim()) { console.error('PUNCHLIST_AI_ADDRESS is for north or openai; the Claude API has a fixed address. Unset it.'); process.exit(2); }
const env = { ...process.env, PUNCHLIST_AI_CHECK: backend, PUNCHLIST_AI_KEY: key, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? (process.env.HTTPS_PROXY ? '1' : '') };
const r = spawnSync('npx', ['vitest', 'run', 'tests/e2e/ai-check-live.test.ts', '--reporter=verbose'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
