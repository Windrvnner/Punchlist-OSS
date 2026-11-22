// @vitest-environment node
// The AI check (tests/e2e/aiCheck.ts) on a stand-in for each backend the control file can choose, built the way the app
// and `npm run ai:check -- <backend>` build it (src/desktop/model.ts), so the command is known to work before it is run
// against a real service. No network and no key: real services are never reached from here.
import { it, expect, vi } from 'vitest';

// North's model names have no default (an end user sets them), so the check names the stand-in's models
vi.mock('../../src/control', async (orig) => {
  const m = await orig<typeof import('../../src/control')>();
  const names = { northFast: 'model-fast', northStandard: 'model-standard', northThorough: 'model-thorough' };
  return { ...m, control: { ...m.control, models: { ...m.control.models, ...names } } };
});
const { modelService } = await import('../../src/desktop/model');
import { tokenHolder } from '../../src/backend/signInToken';
import { northStandIn } from '../backend/northStandIn';
import { fakeApi } from '../backend/claudeStandIn';
import { fakeServer } from '../backend/openaiStandIn';
import { aiCheck } from './aiCheck';

const WORD = 'proseware-test';
const codeWord = (text: string) => /code word is (\S+)\./.exec(text)?.[1] ?? 'none';
const answerCodeWord = ({ files }: { files: string }) => ({ text: codeWord(files) });
const token = () => tokenHolder({ waitMs: 1000, token: 'good-token' });

it('north: signs in, lists the models, uploads a file, asks about it, deletes it and lists its own tools', async () => {
  const north = await northStandIn({
    processAfter: 2, answer: (_b, files) => codeWord(new TextDecoder().decode(files[0]?.bytes)),
  });
  try {
    const { service } = modelService({ service: 'north', address: north.address, token: token() });
    const lines: string[] = [];
    expect(await aiCheck(service, (l) => lines.push(l))).toEqual({ who: 'jdoe', models: 4, found: true, gone: true });
    expect(lines).toHaveLength(7); expect(lines[6]).toBe("The service's own tools on your agents: file_reader, web_search"); expect(north.files.size).toBe(0);
  } finally { await north.close(); }
});

it('claude: the same check, where the service does not name the person', async () => {
  const api = fakeApi({ answer: answerCodeWord });
  const lines: string[] = [];
  const { service } = modelService({ service: 'claude', token: token(), fetch: api.fetch, env: {} });
  expect(await aiCheck(service, (l) => lines.push(l), WORD)).toEqual({ who: '', models: 1, found: true, gone: true });
  expect(lines[1]).toMatch(/^Signed in; the service does not name the person/); expect(lines).toHaveLength(6); expect(api.files.size).toBe(0);
});

it('claude: an uploaded file omitted from the request does not reveal the code word', async () => {
  const api = fakeApi({ answer: answerCodeWord });
  const { service } = modelService({ service: 'claude', token: token(), fetch: api.fetch, env: {} });
  expect(await aiCheck({
    ...service,
    complete: (input) => service.complete({ ...input, files: [] }),
  }, () => {}, WORD)).toMatchObject({ found: false, gone: true });
});

it('openai: the same check on an OpenAI-compatible server, reading the file it was given', async () => {
  const api = fakeServer({ answer: answerCodeWord }); const lines: string[] = [];
  const address = 'https://models.example/v1';
  const { service } = modelService({ service: 'openai', address, token: token(), fetch: api.fetch });
  expect(await aiCheck(service, (l) => lines.push(l))).toMatchObject({ found: true, gone: true });
  expect(lines).toHaveLength(6); expect(api.files.size).toBe(0);
});

it('a refused key fails at the first step, before anything is uploaded', async () => {
  const api = fakeApi(); const real = api.fetch;
  const refusing = (async (url: string | URL | Request, init?: RequestInit) => new URL(new Request(url, init).url).pathname === '/v1/models' ? new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } }) : real(url, init)) as typeof fetch;
  const { service } = modelService({ service: 'claude', token: tokenHolder({ waitMs: 50, token: 'bad-key' }), fetch: refusing, env: {} });
  await expect(aiCheck(service, () => {}, WORD)).rejects.toThrow(); expect(api.files.size).toBe(0);
});

it('a wrong answer is reported, not passed', async () => {
  const api = fakeApi([{ text: 'no idea' }]);
  const { service } = modelService({ service: 'claude', token: token(), fetch: api.fetch, env: {} });
  expect(await aiCheck(service, () => {}, WORD)).toMatchObject({ found: false, gone: true });
});
