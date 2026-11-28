// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { cutOff } from '../../src/backend/limits';
import { StandInService, newDeal, pcApp, pdf, put, tmp, until } from './kit';

it('exposes an exhausted advisor report through deal progress and after restarting (#1212)', async () => {
  const root = tmp();
  const folder = path.join(root, 'vdr');
  const name = 'Independent Engineer Report.pdf';
  put(folder, name, pdf('The independent engineer reviewed construction and the base case.'));
  const service = new StandInService();
  let finishFirstRead = () => {};
  const firstRead = new Promise<void>((resolve) => { finishFirstRead = resolve; });
  let calls = 0;
  service.reports = async ({ files, prompt }) => {
    if (!files.length) {
      const doc = /^doc_[0-9a-f]{24}(?=:)/m.exec(prompt)?.[0];
      return JSON.stringify({ reports: doc ? [doc] : [], unsure: [] });
    }
    if (++calls === 1) await firstRead;
    throw cutOff('The reply reached the output limit', '{"issues":[{"title":"The observation stops');
  };
  const options = { service, checklist: () => ({ broad: [], product: [], sector: [] }) };
  let pc: Awaited<ReturnType<typeof pcApp>> | undefined;
  let indexed: Promise<string> | undefined;
  try {
    pc = await pcApp(root, 'Office', options);
    indexed = newDeal(pc, 'Cutoff', folder);
    await until('the first advisor report read', () => calls === 1);
    const dealId = Object.keys(pc.store.get().deals)[0];
    const reportReads = async () => {
      const result = await pc!.backend.ai.progress?.(dealId);
      return result?.ok ? result.value.incompleteReports : undefined;
    };
    expect(await reportReads()).toBeUndefined();
    finishFirstRead();
    await indexed;
    expect(await reportReads()).toMatchObject([{ name }]);
    expect(Object.values(pc.store.get().findings)).toEqual([]);
    expect(calls).toBe(3);
    await pc.backend.close();

    pc = await pcApp(root, 'Office', options);
    expect((await reportReads())?.map((document) => document.name)).toEqual([name]);
    await pc.backend.idle();
    expect(calls).toBe(3);
  } finally {
    finishFirstRead();
    await indexed?.catch(() => undefined);
    await pc?.backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
