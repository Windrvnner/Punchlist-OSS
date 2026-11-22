// @vitest-environment node
// The AI check on a live model service: `npm run ai:check -- <backend>`, where the backend is claude, north or openai.
// Runs only from that command (vitest.config.ts leaves it out of every other run and hides the token from it). The
// service is built the way the app builds it (src/desktop/model.ts): models and address from the control file
// (src/control.ts), or PUNCHLIST_AI_ADDRESS for the address; the token, an API key or a North token from
// "Retrieve your token" at <your North>/developer, from PUNCHLIST_AI_KEY. It is never printed or written anywhere.
import { it, expect } from 'vitest';
import { modelService } from '../../src/desktop/model';
import { control } from '../../src/control';
import { tokenHolder } from '../../src/backend/signInToken';
import { aiCheck } from './aiCheck';

const BACKENDS = ['claude', 'north', 'openai'] as const;
const backend = process.env.PUNCHLIST_AI_CHECK as (typeof BACKENDS)[number] | undefined;
const token = process.env.PUNCHLIST_AI_KEY?.trim();
// a backend the app cannot choose would quietly fall back to Claude in modelService: refuse it instead
if (backend && !BACKENDS.includes(backend)) throw new Error(`PUNCHLIST_AI_CHECK must be one of ${BACKENDS.join(', ')}`);
// a Claude key goes to Claude only, never to North or an OpenAI-compatible server, however this file was started
if (backend && backend !== 'claude' && token?.includes('sk-ant-')) throw new Error(`PUNCHLIST_AI_KEY holds a Claude key: set it to the key for ${backend}`);
const address = process.env.PUNCHLIST_AI_ADDRESS?.trim() || undefined;
// North and an OpenAI-compatible server are wherever the end user runs them: without an address there is nothing to check
if ((backend === 'north' && !(address || control.north.address)) || (backend === 'openai' && !(address || control.openai.address))) throw new Error(`Set PUNCHLIST_AI_ADDRESS, or ${backend}.address in the control file`);

it.skipIf(!backend || !token)(`a live ${backend ?? 'model'} service: sign in, models, upload, ask, delete`, async () => {
  const { service } = modelService({ service: backend, token: tokenHolder({ waitMs: 1000, token }), address });
  console.log(`Backend: ${backend}`);
  const r = await aiCheck(service, (l) => console.log(l));
  expect(r.models).toBeGreaterThan(0); expect(r.found).toBe(true); expect(r.gone).toBe(true);
}, 5 * 60_000);
