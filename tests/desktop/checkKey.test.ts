// @vitest-environment node
// A pasted key is checked with the model service before it is taken (decisions: "Intelligence sign-in"): only a key the
// service confirms is taken; a refused one is said to be refused, and no answer, a slow one or an answer that is not the
// service's leaves the key untaken, with Retry. Run against a stand-in of the service's key check on this PC (never a real one).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
vi.mock('electron', () => ({ BrowserWindow: class {}, safeStorage: {} }));
import { checkKey } from '../../src/desktop/signin';
import { claudeService } from '../../src/backend/claude';

let answer: 'ok' | 'refused' | 'error' | 'html' | 'slow' = 'ok';
const server = http.createServer((req, res) => {
  if (answer === 'slow') return;                                         // never answers
  if (answer === 'refused') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid key"}}'); return; }
  if (answer === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"api_error","message":"internal"}}'); return; }
  if (answer === 'html') { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html>Sign in to the proxy</html>'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[],"has_more":false,"first_id":null,"last_id":null}');
});
let was: string | undefined;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  was = process.env.ANTHROPIC_BASE_URL; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); if (was === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = was; });
const probe = (token: Parameters<typeof claudeService>[0]['key']) => claudeService({ key: token, maxRetries: 0 });

describe('checking a pasted key', () => {
  it('takes only a key the service confirms', async () => {
    answer = 'ok'; expect(await checkKey('good-key', probe)).toBe('ok');
    answer = 'refused'; expect(await checkKey('bad-key', probe)).toBe('refused');
  });
  it('a server error or a page that is not the service does not confirm the key', async () => {
    answer = 'error'; expect(await checkKey('some-key', probe)).not.toBe('ok');
    answer = 'html'; expect(await checkKey('some-key', probe)).toBe('unchecked');
  });
  it('no answer in time is as good as none', async () => {
    answer = 'slow'; expect(await checkKey('some-key', probe, 200)).toBe('unreachable');
  });
  it('any other failure of the check (a fault on the way) leaves the key untaken', async () => {
    expect(await checkKey('some-key', () => ({ checkSignIn: async () => { throw new SyntaxError('Unexpected token <'); } }))).toBe('unchecked');
  });
});
