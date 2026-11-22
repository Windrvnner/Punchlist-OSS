/**
 * Which model service the desktop app talks to, as `models.service` in the control file says. With 'north', it is the
 * North connector (src/backend/north.ts) on the North instance, signed in through `token` (src/desktop/signin.ts). With
 * 'openai', it is the OpenAI-compatible connector (src/backend/openai.ts) on the OpenAI-compatible server at
 * openai.address, with the API key from the same sign-in. With
 * 'claude' (the default), the app runs on Claude with the key from the person's sign-in
 * (`token`), or from the environment as PUNCHLIST_AI_KEY when the run asks for it with PUNCHLIST_LIVE=1 (`envKey`);
 * with neither, on the in-memory stand-in, which answers
 * nothing but lets every screen open. Every tier goes to the fast model
 * (Haiku) unless PUNCHLIST_LIVE_ROUTING=1 sends each tier to its own. The key is read from the
 * environment only, never written anywhere.
 */
import { StandInService, type ModelService } from '../backend/service';
import { claudeService } from '../backend/claude';
import { northService } from '../backend/north';
import { openAiService } from '../backend/openai';
import { cloudClaudeService } from '../backend/cloudClaude';
import type { SignInToken } from '../backend/signInToken';
import type { Converter } from '../backend/convert';
import { control, isCloudProvider, type CloudProvider, type Control, type ModelProvider } from '../control';

/**
 * The Claude key from the environment, only on a run that asks for live calls with PUNCHLIST_LIVE=1 (npm run e2e:live or
 * desktop:live). A key that is merely set in the shell is never used, so tests and checks make no paid calls.
 */
export function envKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PUNCHLIST_LIVE === '1' ? env.PUNCHLIST_AI_KEY?.trim() || undefined : undefined;
}

/**
 * `address` stands in for north.address or openai.address (the AI check, tests/e2e/ai-check-live.test.ts, takes it from
 * PUNCHLIST_AI_ADDRESS); `fetch` is for tests on a stand-in service.
 */
interface ModelOptions {
  env?: NodeJS.ProcessEnv;
  convert?: Converter;
  token?: SignInToken;
  service?: ModelProvider;
  address?: string;
  fetch?: typeof fetch;
  config?: Control;
}

export function modelService(o: ModelOptions = {}): { service: ModelService } {
  const env = o.env ?? process.env;
  const c = o.config ?? control;
  const service = o.service ?? c.models.service;
  const m = c.models;
  if (isCloudProvider(service)) return cloudModelService(service, o, c);
  if (service === 'north') {
    if (!o.token) throw new Error('The model service needs a sign-in token holder');
    return {
      service: northService({
        address: o.address || c.north.address, fetch: o.fetch, token: o.token,
        models: { fast: m.northFast, standard: m.northStandard, thorough: m.northThorough },
        hostedTools: c.north.hostedTools, timeoutMs: c.timings.modelCall,
      }),
    };
  }
  if (service === 'openai') {
    if (!o.token) throw new Error('The model service needs a sign-in token holder');
    return {
      service: openAiService({
        base: o.address || c.openai.address, fetch: o.fetch, api: c.openai.api, key: o.token,
        models: { fast: m.openaiFast, standard: m.openaiStandard, thorough: m.openaiThorough },
        convert: o.convert, timeoutMs: c.timings.modelCall,
      }),
    };
  }
  // on Claude, the key comes from the person's sign-in when there is one (src/desktop/signin.ts), else from the environment
  const key = o.token ?? envKey(env);
  if (key) {
    const models = { fast: m.claudeFast, standard: m.claudeStandard, thorough: m.claudeThorough };
    const routing = env.PUNCHLIST_LIVE_ROUTING === '1';
    return { service: claudeService({ key, convert: o.convert, fetch: o.fetch, routing, models }) };
  }
  // the stand-in names nobody, so the person shown is the PC's signed-in user (no guessed identities)
  return { service: new StandInService(() => '', '') };
}

function cloudModelService(provider: CloudProvider, o: ModelOptions, c: Control) {
  if (!o.token) throw new Error('The model service needs a sign-in token holder');
  const settings = c[provider];
  const models = { fast: settings.fast, standard: settings.standard, thorough: settings.thorough };
  const address = o.address || settings.address;
  const options = { models, key: o.token, convert: o.convert, fetch: o.fetch };
  if (provider === 'gateway' || provider === 'azure') {
    const api = provider === 'gateway' ? c.gateway.api : 'responses';
    return {
      service: openAiService({ ...options, base: address, route: provider, api, timeoutMs: c.timings.modelCall }),
    };
  }
  const route = provider === 'bedrock' ? { provider, region: c.bedrock.region } as const : { provider } as const;
  const probeModel = provider === 'bedrock' ? c.bedrock.probeModel : undefined;
  return {
    service: cloudClaudeService({ ...options, route, address, probeModel }),
  };
}
