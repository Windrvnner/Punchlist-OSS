/** Claude Messages on Bedrock Runtime and Vertex publisher models. */
import aws4 from 'aws4';
import { setTimeout as sleep } from 'node:timers/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { SERVICE, control } from '../control';
import { claudeService } from './claude';
import type { Converter } from './convert';
import { inlineDocuments } from './inlineDocuments';
import { saysTooLong, tooLong } from './limits';
import { retryDroppedRequest } from './requestRetry';
import { credentialFrom, type Credential, type SignInToken } from './signInToken';

type Route = { provider: 'bedrock'; region: string } | { provider: 'vertex' };

interface CloudClaudeOptions {
  route: Route;
  address: string;
  key: SignInToken;
  models: { fast: string; standard: string; thorough: string };
  convert?: Converter;
  fetch?: typeof fetch;
  probeModel?: string;
  retryMs?: number;
}

const VERSIONS = { bedrock: 'bedrock-2023-05-31', vertex: 'vertex-2023-10-16' };
const unreachable = (message: string) => Object.assign(new Error(message), { code: 'unreachable' });

export function cloudClaudeService(o: CloudClaudeOptions) {
  const documents = inlineDocuments(o.convert);
  const transport = {
    upload: documents.upload,
    list: documents.list,
    remove: documents.remove,
    parts: (ids: string[] | undefined) => documents.parts(ids, documentPart),
    messages: (input: Anthropic.MessageCreateParamsNonStreaming) => {
      const { model, ...payload } = input;
      return request<Anthropic.Message>(o, model, payload);
    },
    async checkSignIn() {
      // Both providers have token-count endpoints that authorize the caller without running inference.
      await request(o, o.probeModel || o.models.standard, { messages: [{ role: 'user', content: 'Hello' }] }, true);
    },
  };
  return claudeService({ key: o.key, models: o.models, routing: true, transport });
}

function documentPart(file: { name: string; type: string; data: string }):
  Anthropic.DocumentBlockParam | Anthropic.TextBlockParam {
  if (file.type !== 'application/pdf') return { type: 'text', text: `Document "${file.name}":\n${file.data}` };
  return {
    type: 'document', title: file.name,
    source: { type: 'base64', media_type: 'application/pdf', data: file.data },
  };
}

function endpointAndBody(o: CloudClaudeOptions, model: string, payload: object, count: boolean) {
  const root = o.address.replace(/\/$/, '');
  const version = VERSIONS[o.route.provider];
  const modelId = encodeURIComponent(model);
  const messages = { ...payload, anthropic_version: version };
  if (o.route.provider === 'vertex') {
    const path = count ? 'count-tokens' : modelId;
    const body = JSON.stringify(count ? { ...payload, model } : messages);
    return { url: new URL(`${root}/${path}:rawPredict`), body };
  }
  const path = count ? 'count-tokens' : 'invoke';
  const body = count ? bedrockCountBody(messages) : messages;
  return { url: new URL(`${root}/model/${modelId}/${path}`), body: JSON.stringify(body) };
}

function bedrockCountBody(messages: object) {
  const body = Buffer.from(JSON.stringify({ ...messages, max_tokens: 1 })).toString('base64');
  return { input: { invokeModel: { body } } };
}

function authHeaders(route: Route, url: URL, body: string, credential: Credential): Headers {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (route.provider === 'bedrock' && credential.kind === 'sso') {
    const role = JSON.parse(credential.token) as aws4.Credentials;
    const signed = aws4.sign({
      host: url.host, path: url.pathname, method: 'POST', service: 'bedrock', region: route.region, headers, body,
    }, role);
    return new Headers(Object.entries(signed.headers ?? {}).map(([key, value]) => [key, String(value)]));
  }
  const name = route.provider === 'vertex' && credential.kind === 'apiKey' ? 'x-goog-api-key' : 'authorization';
  const value = name === 'authorization' ? `Bearer ${credential.token}` : credential.token;
  return new Headers({ ...headers, [name]: value });
}

async function request<T>(o: CloudClaudeOptions, model: string, payload: object, count = false): Promise<T> {
  const { url, body } = endpointAndBody(o, model, payload, count);
  const go = o.fetch ?? fetch;
  for (let retries = 0; ; ) {
    const credential = await credentialFrom(o.key);
    const headers = authHeaders(o.route, url, body, credential);
    const reply = await go(url, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(control.timings.modelCall),
    }).catch((error: unknown) => {
      if (retryDroppedRequest(error, 'POST')) return undefined;
      throw unreachable(`${SERVICE} could not be reached.`);
    });
    // A failed connection can be retried before an inference request went out.
    if (!reply || busy(reply.status)) {
      await waitForService(reply, retries, o.retryMs ?? 1000);
      retries++;
      continue;
    }
    const raw = await reply.text().catch(() => { throw unreachable(`${SERVICE} stopped answering.`); });
    if (reply.ok) return JSON.parse(raw) as T;
    if (refused(reply, raw)) {
      o.key.refused(credential.token);
      retries = 0;
      continue;
    }
    if (saysTooLong(reply.status, raw)) throw tooLong(`${SERVICE} said the request is too long.`, reply.status);
    throw Object.assign(new Error(`${SERVICE} said ${reply.status}.`), { status: reply.status });
  }
}

const busy = (status: number) => status === 408 || status === 429 || status >= 500;

async function waitForService(reply: Response | undefined, retries: number, retryMs: number) {
  const delay = reply?.headers.get('retry-after');
  void reply?.body?.cancel().catch(() => undefined);
  if (retries === 2) throw unreachable(`${SERVICE} could not be reached.`);
  await sleep(delay && +delay >= 0 ? Math.min(+delay * 1000, 60_000) : retryMs * 2 ** retries);
}

function refused(reply: Response, body: string): boolean {
  if (reply.status === 401 || reply.status === 403) return true;
  if (reply.status !== 400) return false;
  // AWS and Google can report invalid or expired credentials as a 400.
  const code = reply.headers.get('x-amzn-errortype') ?? body;
  return /ExpiredToken|UnrecognizedClient|API_KEY_INVALID/.test(code);
}
