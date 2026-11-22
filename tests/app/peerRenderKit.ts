import fs from 'node:fs';
import { afterEach, expect, vi } from 'vitest';
import { pcApp, tmp, StandInService, type PcApp } from '../e2e/kit';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion } from '../../src/app/commands/questions';
import type { LogRepository } from '../../src/backend/logRepository';

const apps: PcApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.backend.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

export async function ready() {
  const root = tmp();
  roots.push(root);
  const app = await pcApp(root, 'Office', { service: new StandInService(() => '', '') });
  apps.push(app);
  expect((await app.store.dispatch(CreateDeal, { name: 'Peer view', folders: [] })).ok).toBe(true);
  const dealId = Object.keys(app.store.get().deals)[0];
  expect((await app.store.dispatch(CreateQuestion, { dealId, text: 'Original question' })).ok).toBe(true);
  await app.store.loadDeal(dealId, { gaps: false });
  const questionId = Object.keys(app.store.get().questions)[0];
  return { ...app, dealId, questionId };
}
export type App = Awaited<ReturnType<typeof ready>>;

/** Backend announcements use the peer-record watch path without an independent sync-status publication. */
export async function change(
  app: App, kind: 'deal' | 'question' | 'finding', id: string, patch: Record<string, unknown>,
) {
  const bucket = kind === 'deal' ? 'deals' : kind === 'finding' ? 'findings' : 'questions';
  const current = app.store.get()[bucket][id];
  const saved = await app.backend.repo.transaction({
    writes: [{ kind, id, data: { ...current, ...patch }, expectedRev: current.rev }],
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const observed = new Promise<void>((resolve) => {
    const off = app.store.subscribe((state) => {
      const record = state[bucket][id];
      if (record?.rev !== saved.value[id]) return;
      off();
      resolve();
    });
  });
  (app.backend.repo as LogRepository).announce(kind, id);
  await observed;
}

export function frames() {
  let next = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    pending.set(++next, callback);
    return next;
  });
  const cancel = vi.fn((id: number) => pending.delete(id));
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  const flush = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(0);
  };
  return { request, cancel, pending, flush };
}
