// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { StoreContext, useAppState } from '../../src/ui/hooks';

/** The smallest store the hook needs. */
function fakeStore() { let state: any = { n: 0 }; const ls = new Set<(s: any) => void>(); return { get: () => state, subscribe: (f: any) => { ls.add(f); return () => ls.delete(f); }, set: (n: number) => { state = { n }; for (const l of ls) l(state); }, listeners: ls }; }
const Show = () => <b>{(useAppState() as any).n}</b>;

describe('useAppState', () => {
  it('a change made straight after a component first renders is not missed', async () => {
    const store = fakeStore(); const host = document.createElement('div');
    render(<StoreContext.Provider value={store as any}><Show /></StoreContext.Provider>, host);
    store.set(1);                                        // before any passive effect could have run
    await new Promise((r) => setTimeout(r, 30));
    expect(host.textContent).toBe('1');
    store.set(2); await new Promise((r) => setTimeout(r, 30));
    expect(host.textContent).toBe('2');
    render(null, host); expect(store.listeners.size).toBe(0);
  });
});
