// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, SetFindingStatus } from '../../src/app/commands/findings';
import { registry } from '../../src/app/commands/undo';
import { dealFindings } from '../../src/app/state';
import './keptTextSession';
import { StoreContext } from '../../src/ui/hooks';
import { FindingOpening } from '../../src/ui/findings';

const COMMANDS = [CreateDeal, CreateFinding, SetFindingStatus];
for (const c of COMMANDS) registry.set(c.name, c);
// Dates are built from local time so the test holds in every time zone
const local = (day: number) => new Date(2026, 10, day, 12);
let at = local(16);
let tick = 0;
const clock = { now: () => new Date(at.getTime() + tick++).toISOString() };
let seq = 0;
const ids = { next: (p: string) => `${p}_01HWWWWWWWWWWWWWWWC${String(seq++).padStart(7, '0')}` };
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

/** A deal with one AI finding raised and closed on day 16; the clock then moves to `readOn` and the finding opens. */
async function opened(readOn: number, closedOn = 16) {
  at = local(16);
  const opts = { latency: [0, 0] as [number, number] };
  const repo = memRepo(clock.now, disk());
  const store = new Store({
    repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), sheets: csvCodec,
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
    session: mockSession(opts), local: new MemoryLocal(), clock, ids,
  }, COMMANDS);
  await store.boot();
  await store.dispatch(CreateDeal, { name: 'Meta', folders: [] });
  const dealId = Object.values(store.get().deals)[0].id;
  await store.loadDeal(dealId);
  await store.dispatch(CreateFinding, { dealId, title: 'Reserve shortfall', workstream: 'Legal' });
  const findingId = dealFindings(store.get(), dealId)[0].id;
  // no command makes an AI finding, so the record is marked as one in the store's state
  store.get().findings[findingId].origin = 'ai';
  at = local(closedOn);
  await store.dispatch(SetFindingStatus, { dealId, findingId, status: 'closed' });
  at = local(readOn);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(() => {
    render(
      <StoreContext.Provider value={store}>
        <FindingOpening dealId={dealId} findingId={findingId} onOpen={() => {}} />
      </StoreContext.Provider>,
      host,
    );
  });
  await settle();
  return host.querySelector('.fmeta')!.textContent!;
}

describe('the finding’s meta line', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps a date as a date: "Nov 16", never "nov 16", in both the identified and the last-event text', async () => {
    const meta = await opened(26);
    expect(meta).toContain('identified Nov 16');
    expect(meta).toMatch(/closed by \S+ · Nov 16/);
    expect(meta).not.toContain('nov');
  });
  it('is lower case when recent', async () => {
    const meta = await opened(26, 23);
    expect(meta).toMatch(/closed by \S+ · 3 days ago/);
    expect(meta).toContain('identified Nov 16');
  });
});
