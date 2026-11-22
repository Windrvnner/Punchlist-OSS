import { describe, it, expect } from 'vitest';
import { Deal } from '../../src/domain/model';
import { likelyTwin } from '../../src/app/dupes';

const at = (day: number) => new Date(Date.UTC(2026, 10, day)).toISOString();
const deal = (n: number, name: string, counterparty = '', folders: string[] = [], day = 1) => Deal.parse({ id: `d_${String(n).padStart(26, '0')}`, rev: 0, createdAt: at(day), updatedAt: at(day), name, counterparty, folders: folders.map((path) => ({ path, label: 'VDR', files: 10, size: '1 MB', indexed: 10, reviewed: 0 })) });
/** a team's worth of deals, many of them sharing a code name, as deals do */
const deals = () => {
  const list = Array.from({ length: 300 }, (_, i) => deal(i + 10, `Project ${['Lucerne', 'Proseware', 'Bellows', 'Nod'][i % 4]} ${Math.floor(i / 4)}`, `Sponsor ${i % 17}`, [`\\\\fs\\deals\\${i}\\VDR`], 1 + (i % 28)));
  list.push(deal(1, 'Project Lucerne', 'Northwind Partners', ['\\\\fs\\deals\\lucerne\\VDR'], 2), deal(2, 'Project Lucerne', 'Litware Capital', [], 9));
  return Object.fromEntries(list.map((d) => [d.id, d]));
};
const room = (dealId: string, matched = 188) => ({ dealId, files: 200, matched, printed: 5, same: 5 });

describe('a likely duplicate deal', () => {
  it('never takes a shared name alone, or a shared folder, for a duplicate', () => {
    expect(likelyTwin({ deals: deals() }, { name: 'Lucerne' })).toBeNull();
    expect(likelyTwin({ deals: deals() }, { name: 'Lucerne', counterparty: 'Someone new' })).toBeNull();
    expect(likelyTwin({ deals: deals() }, { name: 'Proseware', counterparty: 'Northwind Partners' })).toBeNull();   // the counterparty of another deal, not of a Proseware
  });
  it('takes the same name with the same counterparty, however it is spelled', () => {
    const t = likelyTwin({ deals: deals() }, { name: ' project  lucerne', counterparty: 'northwind partners ' });
    expect(t?.deal.counterparty).toBe('Northwind Partners'); expect(t).toMatchObject({ named: true });
    expect(t?.room).toBeUndefined();
  });
  it('puts the data room first, and the closest data room among several', () => {
    const d = deals(); const ids = Object.keys(d);
    const t = likelyTwin({ deals: d }, { name: 'Lucerne', counterparty: 'Northwind Partners' }, [room(ids[5], 150), room(ids[7], 190)]);
    expect(t?.deal.id).toBe(ids[7]); expect(t?.room?.matched).toBe(190); expect(t?.named).toBe(false);
    const both = likelyTwin({ deals: d }, { name: 'Lucerne', counterparty: 'Northwind Partners' }, [room('d_00000000000000000000000001')]);
    expect(both).toMatchObject({ named: true, room: { matched: 188 } });
  });
});
