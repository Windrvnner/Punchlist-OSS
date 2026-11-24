// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { mockAi } from '../../src/adapters/mocks';
import { capabilities } from '../../src/app/capabilities';
import { ok, fail } from '../../src/domain/result';
import type { Services } from '../../src/ports';
import { make } from './importKit';

const aiOffered = {
  checklist: true,
  phrase: true,
  checkAll: true,
  memo: true,
  issuesList: true,
  addresses: true,
  merge: true,
  layout: true,
  research: true,
  stop: true,
  reword: true,
  sameMeaning: true,
};
const demoOffered = { ...aiOffered, qaLogs: false, signin: false, place: false };
const optionalPorts = ['qaLogs', 'signin', 'place'] as const;

const notUsed = async () => fail({ kind: 'failed', message: 'Unexpected call while reading capability state' });
const ports = {
  qaLogs: { read: notUsed, save: notUsed, create: notUsed },
  signin: { status: notUsed, signIn: notUsed, paste: notUsed },
  place: { get: notUsed, pick: notUsed, use: notUsed },
} satisfies Pick<Services, typeof optionalPorts[number]>;

it('publishes the mock model capabilities in Store state and leaves absent ports off', () => {
  const { store } = make();
  expect(store.get().can).toEqual(demoOffered);
});

const aiMethods = Object.keys(aiOffered) as (keyof typeof aiOffered)[];

it.each(aiMethods)('turns only %s off when its method is absent', (method) => {
  const ai = mockAi();
  delete ai[method];
  expect(capabilities({ ai })).toEqual({ ...demoOffered, [method]: false });
});

it.each(optionalPorts)('reflects the %s port appearing and disappearing after Store construction', (port) => {
  const { store } = make();
  Object.assign(store.services, ports);
  const allOffered = { ...aiOffered, qaLogs: true, signin: true, place: true };
  expect(store.get().can).toEqual(allOffered);
  delete store.services[port];
  expect(store.get().can).toEqual({ ...allOffered, [port]: false });
});

it('refreshes checklist rows only where the service is available', async () => {
  const { store } = make();
  const dealId = 'Project Fern';
  const checklist = vi.fn(async () => ok([]));
  store.services.ai.checklist = checklist;
  await store.refreshChecklist(dealId);
  expect(checklist).toHaveBeenCalledExactlyOnceWith(dealId);
  expect(store.get().checklists[dealId]).toEqual([]);
  delete store.services.ai.checklist;
  await store.refreshChecklist('Project Larch');
  expect(store.get().checklists).toEqual({ [dealId]: [] });
});
