// @vitest-environment node
// The shown model list names no vendor unless the allowance lists it, and neither does any string in src/ui or
// src/app. Each connector is built on its stand-in, and every name its models() returns is matched like such a
// string.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeService } from '../../src/backend/claude';
import { northService } from '../../src/backend/north';
import { openAiService } from '../../src/backend/openai';
import { tokenHolder } from '../../src/backend/signInToken';
import { fakeApi } from '../backend/claudeStandIn';
import { northStandIn } from '../backend/northStandIn';
import { fakeServer } from '../backend/openaiStandIn';
import { screenVendorMatches, srcSources, VENDOR, type VendorMatch } from './vendorNamesKit';
// @ts-expect-error the script is plain JavaScript
import { allowanceProblems, decisionEntries, groupMatches, keyOf, unlistedMatches } from '../../scripts/allowance.mjs';

type Names = { models: { id: string; name: string }[] };
// One vendor-named id for every tier, so each pass-through route shows one name.
const vendorTiers = { fast: 'gpt-model', standard: 'gpt-model', thorough: 'gpt-model' };

/** The names the model list shows, as `model name` matches in the connector's source file. */
function modelNameMatches(file: string, listed: Names): VendorMatch[] {
  return listed.models
    .filter((model) => VENDOR.test(model.name))
    .map((model) => ({ file, kind: 'model name', line: model.name }));
}

async function claudeNames(): Promise<VendorMatch[]> {
  const file = 'src/backend/claude.ts';
  const service = (more: object) => claudeService({ key: 'test', fetch: fakeApi().fetch, maxRetries: 0, ...more });
  const routed = await service({ routing: true }).models();
  const light = await service({}).models();
  // a model id the connector has no name for is shown as its raw id
  const raw = await service({ models: { fast: 'claude-custom', standard: 'claude-custom', thorough: 'claude-custom' } })
    .models();
  return [routed, light, raw].flatMap((listed) => modelNameMatches(file, listed));
}

async function openAiNames(): Promise<VendorMatch[]> {
  const service = openAiService({
    base: 'https://models.example/v1/', key: 'k1', models: vendorTiers, fetch: fakeServer().fetch, maxRetries: 0,
  });
  return modelNameMatches('src/backend/openai.ts', await service.models());
}

async function northNames(): Promise<VendorMatch[]> {
  const found: VendorMatch[] = [];
  // the second model has no display name, so its name is the id (`display_name || name`)
  const models = [{ name: 'gpt-model', display_name: 'GPT Model' }, { name: 'gpt-plain' }];
  for (const olderNorth of [false, true]) {
    const north = await northStandIn({ models });
    if (olderNorth) north.faults.push({ path: '/v2/models', status: 404 });
    const token = tokenHolder({ waitMs: 2000, token: 'good-token' });
    const service = northService({
      address: north.address, token, models: vendorTiers, sleep: async () => {}, pollMs: 1,
    });
    found.push(...modelNameMatches('src/backend/north.ts', await service.models()));
    await north.close();
  }
  return found;
}

/** One match per connector file and name, however many times the test asked for it. */
let modelNames: Promise<VendorMatch[]> | undefined;
function shownModelNames(): Promise<VendorMatch[]> {
  modelNames ??= Promise.all([claudeNames(), openAiNames(), northNames()]).then((each) => {
    const all = each.flat();
    return all.filter((one, at) => all.findIndex((other) => keyOf(other) === keyOf(one)) === at);
  });
  return modelNames;
}

describe('vendor names in screen code and in the shown model list', () => {
  it('is listed in scripts/vendor-names-allowance.json, every match and every entry', async () => {
    const strings = screenVendorMatches(srcSources(), (file) => readFileSync(file, 'utf8'));
    const names = await shownModelNames();
    const found = groupMatches([...strings, ...names]);
    const allowance = JSON.parse(readFileSync('scripts/vendor-names-allowance.json', 'utf8'));
    const options = {
      decisions: decisionEntries(readFileSync('docs/decisions.md', 'utf8')),
      verified: JSON.parse(readFileSync('scripts/verified-decisions.json', 'utf8')),
    };
    const unlisted = unlistedMatches(found, allowance)
      .map(({ file, kind, line, missing }: VendorMatch & { missing: number }) =>
        ({ file, kind, line, count: missing }));
    const message = 'Unlisted matches, to add to scripts/vendor-names-allowance.json:\n'
      + JSON.stringify(unlisted, null, 2);
    expect(allowanceProblems(found, allowance, options), message).toEqual([]);
  });

  it('shows exactly these names, one for each route a connector passes through', async () => {
    const shown = (await shownModelNames()).map((match) => `${match.file} ${match.line}`);
    expect(shown.sort()).toEqual([
      'src/backend/claude.ts Claude Haiku 5.5',
      'src/backend/claude.ts Claude Opus 5.5',
      'src/backend/claude.ts Claude Sonnet 5.5',
      'src/backend/claude.ts claude-custom',
      'src/backend/north.ts GPT Model',
      'src/backend/north.ts gpt-model',
      'src/backend/north.ts gpt-plain',
      'src/backend/openai.ts gpt-model',
    ]);
  });
});
