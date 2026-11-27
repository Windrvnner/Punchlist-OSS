// @vitest-environment node
// The shown model list names no vendor unless the allowance lists it, and neither does any string in src. Each
// connector is built on its stand-in, and every name its models() returns is matched like a string in src.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeService } from '../../src/backend/claude';
import { northService } from '../../src/backend/north';
import { openAiService } from '../../src/backend/openai';
import { tokenHolder } from '../../src/backend/signInToken';
import { fakeApi } from '../backend/claudeStandIn';
import { northStandIn } from '../backend/northStandIn';
import { fakeServer } from '../backend/openaiStandIn';
import { srcSources, vendorMatchesIn, VENDOR, type VendorMatch } from './vendorNamesKit';
import {
  allowanceProblems, decisionEntries, groupMatches, unlistedMatches,
// @ts-expect-error the script is plain JavaScript
} from '../../scripts/allowance.mjs';

type Names = { models: { id: string; name: string }[] };
const vendorTiers = { fast: 'gpt-fast', standard: 'gpt-standard', thorough: 'gpt-thorough' };

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
  for (const olderNorth of [false, true]) {
    const north = await northStandIn({
      models: Object.values(vendorTiers).map((name) => ({ name, display_name: name.toUpperCase() })),
    });
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

describe('vendor names in src and in the shown model list', () => {
  it('is listed in scripts/vendor-names-allowance.json, every match and every entry', async () => {
    const strings = srcSources().flatMap((file) => vendorMatchesIn(file, readFileSync(file, 'utf8')));
    const names = [...await claudeNames(), ...await openAiNames(), ...await northNames()];
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

  it('records the names each connector shows, including a pass-through of the service\'s own', async () => {
    const lines = (matches: VendorMatch[]) => matches.map((match) => match.line);
    expect(lines(await claudeNames())).toContain('claude-custom');
    expect(lines(await openAiNames())).toEqual(['gpt-fast', 'gpt-standard', 'gpt-thorough']);
    expect(lines(await northNames())).toEqual([
      'GPT-FAST', 'GPT-STANDARD', 'GPT-THOROUGH', 'gpt-fast', 'gpt-standard', 'gpt-thorough',
    ]);
  });
});
