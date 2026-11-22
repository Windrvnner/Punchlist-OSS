// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { CreateFinding, DeleteFinding, EditFinding } from '../../src/app/commands/findings';
import { followDeals } from '../../src/app/indexing';
import { ready, change, frames } from './peerRenderKit';

async function list() {
  const app = await ready();
  // Derived replies are independent publications; these controls isolate the record-watch notification.
  vi.spyOn(app.store.services.ai, 'gaps').mockImplementation(() => new Promise(() => {}));
  expect((await app.store.dispatch(CreateFinding, {
    dealId: app.dealId, title: 'Original finding', workstream: 'Legal', body: ['Original detail'],
  })).ok).toBe(true);
  const findingId = Object.keys(app.store.get().findings)[0];
  app.store.ui({ route: { name: 'deal', dealId: app.dealId } });
  return { ...app, findingId };
}

it('applies every finding revision immediately while the list renders only the latest frame', async () => {
  const app = await list();
  const frame = frames();
  const ordinary: string[] = [];
  const rendered: string[] = [];
  app.store.subscribe((state) => ordinary.push(state.findings[app.findingId].title));
  app.store.subscribe((state) => rendered.push(state.findings[app.findingId].title), { peerFrame: true });
  await change(app, 'finding', app.findingId, { title: 'Peer changed it' });
  expect(app.store.get().findings[app.findingId].title).toBe('Peer changed it');
  await change(app, 'finding', app.findingId, { title: 'Original finding' });
  expect(ordinary).toEqual(['Peer changed it', 'Original finding']);
  expect(app.store.get().findings[app.findingId].rev).toBe(3);
  expect(rendered).toEqual([]);
  expect(frame.request).toHaveBeenCalledTimes(1);
  frame.flush();
  expect(rendered).toEqual(['Original finding']);
});

it('renders question changes immediately even while the Findings list is open', async () => {
  const app = await list();
  const frame = frames();
  const rendered: string[] = [];
  app.store.subscribe((state) => rendered.push(state.questions[app.questionId].text), { peerFrame: true });
  await change(app, 'question', app.questionId, { text: 'Peer changed it' });
  await change(app, 'question', app.questionId, { text: 'Original question' });
  expect(rendered).toEqual(['Peer changed it', 'Original question']);
  expect(frame.request).not.toHaveBeenCalled();
});

it('keeps indexing transition observers and views immediate, including their state cleanup', async () => {
  const app = await list();
  const frame = frames();
  const stop = followDeals(app.store);
  app.store.setIndexing(app.dealId, { folders: [], log: ['Working'] });
  const stages: string[] = [];
  app.store.subscribe((state) => {
    const stage = state.deals[app.dealId].stage;
    if (stages.at(-1) !== stage) stages.push(stage);
  });
  const rendered = vi.fn();
  app.store.subscribe(rendered, { peerFrame: true });
  await change(app, 'deal', app.dealId, { stage: 'indexing' });
  expect(app.store.get().indexing[app.dealId]).toBeDefined();
  expect(rendered).toHaveBeenCalled();
  await change(app, 'deal', app.dealId, { stage: 'ready' });
  expect(stages).toEqual(['indexing', 'ready']);
  expect(app.store.get().indexing[app.dealId]).toBeUndefined();
  expect(frame.request).not.toHaveBeenCalled();
  stop();
});

it('renders each finding revision immediately on the actual finding detail route', async () => {
  const app = await list();
  app.store.ui({ route: { name: 'finding', dealId: app.dealId, findingId: app.findingId } });
  const frame = frames();
  const rendered: string[] = [];
  app.store.subscribe((state) => rendered.push(state.findings[app.findingId].title), { peerFrame: true });
  await change(app, 'finding', app.findingId, { title: 'Peer changed it' });
  await change(app, 'finding', app.findingId, { title: 'Original finding' });
  expect(rendered).toEqual(['Peer changed it', 'Original finding']);
  expect(frame.request).not.toHaveBeenCalled();
});

it('flushes a pending list frame on navigation before the next detail revision', async () => {
  const app = await list();
  const frame = frames();
  const rendered: string[] = [];
  app.store.subscribe((state) => rendered.push(`${state.ui.route.name}:${state.findings[app.findingId].title}`),
    { peerFrame: true });
  await change(app, 'finding', app.findingId, { title: 'First peer wording' });
  expect(frame.pending.size).toBe(1);
  app.store.ui({ route: { name: 'finding', dealId: app.dealId, findingId: app.findingId } });
  expect(rendered).toEqual(['finding:First peer wording']);
  expect(frame.pending.size).toBe(0);
  expect(frame.cancel).toHaveBeenCalledTimes(1);
  await change(app, 'finding', app.findingId, { title: 'Second peer wording' });
  frame.flush();
  expect(rendered).toEqual(['finding:First peer wording', 'finding:Second peer wording']);
});

it('checks the current route after a held peer read, rather than the route where it began', async () => {
  const app = await list();
  const frame = frames();
  const read = app.store.services.repo.get.bind(app.store.services.repo);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(app.store.services.repo, 'get').mockImplementation(async (kind, id) => {
    const result = await read(kind, id);
    if (kind === 'finding' && id === app.findingId) {
      entered();
      await held;
    }
    return result;
  });
  const rendered = vi.fn();
  app.store.subscribe(rendered, { peerFrame: true });
  const arrival = change(app, 'finding', app.findingId, { title: 'Arrived after navigation' });
  await reading;
  app.store.ui({ route: { name: 'finding', dealId: app.dealId, findingId: app.findingId } });
  rendered.mockClear();
  release();
  await arrival;
  expect(rendered).toHaveBeenCalledTimes(1);
  expect(rendered.mock.calls[0][0].findings[app.findingId].title).toBe('Arrived after navigation');
  expect(frame.request).not.toHaveBeenCalled();
});

it('flushes a local finding save immediately and cancels the pending peer render', async () => {
  const app = await list();
  const frame = frames();
  const rendered: string[] = [];
  app.store.subscribe((state) => rendered.push(state.findings[app.findingId].title), { peerFrame: true });
  await change(app, 'finding', app.findingId, { title: 'Peer wording' });
  expect(frame.pending.size).toBe(1);
  expect((await app.store.dispatch(EditFinding, {
    dealId: app.dealId, findingId: app.findingId, title: 'A newer local title', workstream: 'Legal',
    body: ['Original detail'],
  })).ok).toBe(true);
  expect(app.store.get().findings[app.findingId].title).toBe('A newer local title');
  expect(rendered.at(-1)).toBe('A newer local title');
  expect(frame.pending.size).toBe(0);
  expect(frame.cancel).toHaveBeenCalledTimes(1);
  const before = rendered.length;
  frame.flush();
  expect(rendered).toHaveLength(before);
});

it('keeps a local finding deletion and latest tombstone while a peer frame was pending', async () => {
  const app = await list();
  const frame = frames();
  const rendered: (string | null)[] = [];
  app.store.subscribe((state) => rendered.push(state.findings[app.findingId]?.title ?? null), { peerFrame: true });
  await change(app, 'finding', app.findingId, { title: 'Keep this peer wording in Deleted' });
  expect(frame.pending.size).toBe(1);
  expect((await app.store.dispatch(DeleteFinding, {
    dealId: app.dealId, findingId: app.findingId,
  })).ok).toBe(true);
  expect(app.store.get().findings[app.findingId]).toBeUndefined();
  expect(app.store.get().tombstones[app.findingId].snapshot).toMatchObject({
    title: 'Keep this peer wording in Deleted',
  });
  expect(rendered.at(-1)).toBeNull();
  expect(frame.pending.size).toBe(0);
  frame.flush();
  expect(app.store.get().findings[app.findingId]).toBeUndefined();
  expect(rendered.at(-1)).toBeNull();
});

it('cancels the last unsubscribed view without notifying it or reusing its queued frame', async () => {
  const app = await list();
  const frame = frames();
  const oldView = vi.fn();
  const stop = app.store.subscribe(oldView, { peerFrame: true });
  await change(app, 'finding', app.findingId, { title: 'First arrival' });
  expect(frame.pending.size).toBe(1);
  stop();
  expect(frame.pending.size).toBe(0);
  expect(frame.cancel).toHaveBeenCalledTimes(1);
  const nextView = vi.fn();
  app.store.subscribe(nextView, { peerFrame: true });
  frame.flush();
  expect(oldView).not.toHaveBeenCalled();
  expect(nextView).not.toHaveBeenCalled();
  await change(app, 'finding', app.findingId, { title: 'Second arrival' });
  frame.flush();
  expect(oldView).not.toHaveBeenCalled();
  expect(nextView).toHaveBeenCalledTimes(1);
  expect(nextView.mock.calls[0][0].findings[app.findingId].title).toBe('Second arrival');
});

it('needs no animation-frame globals for ordinary non-UI Stores on the Findings list', async () => {
  const app = await list();
  vi.stubGlobal('requestAnimationFrame', undefined);
  vi.stubGlobal('cancelAnimationFrame', undefined);
  const observed: string[] = [];
  app.store.subscribe((state) => observed.push(state.findings[app.findingId].title));
  await change(app, 'finding', app.findingId, { title: 'Available in Node too' });
  expect(observed).toEqual(['Available in Node too']);
  expect(app.store.get().findings[app.findingId].title).toBe('Available in Node too');
});
