import { distinguishingWords } from '../../src/app/dealLabel';
// Deals with the same name are told apart by their counterparty and the day they were made.
import { describe, it, expect } from 'vitest';
import { dealTwin } from '../../src/app/state';
import type { Deal } from '../../src/domain/model';

const deal = (id: string, name: string, counterparty: string, createdAt: string) => ({ id, name, counterparty, createdAt }) as unknown as Deal;

describe('telling same-named deals apart', () => {
  it('says nothing when no other deal has the name', () => {
    const a = deal('d_a', 'Project Coho', 'Northwind LP', '2026-11-15T12:00:00.000Z'); const b = deal('d_b', 'Project Nod', '', '2026-11-15T12:00:00.000Z');
    expect(dealTwin({ deals: { [a.id]: a, [b.id]: b } as any }, a)).toBe('');
  });
  it('gives the counterparty and the day it was made when another deal has the name, in any capitals', () => {
    const a = deal('d_a', 'Project Coho', 'Northwind LP', '2026-11-15T12:00:00.000Z'); const b = deal('d_b', 'project coho', '', '2025-03-02T12:00:00.000Z');
    const s = { deals: { [a.id]: a, [b.id]: b } as any };
    expect(dealTwin(s, a)).toBe('Northwind LP · Nov 15, 2026'); expect(dealTwin(s, b)).toBe('Mar 2, 2025');
  });
  it('in the sidebar, gives only what tells it apart: the counterparty when no other has it, else the day when no other was made that day, else both', () => {
    const a = deal('d_a', 'Project Coho', 'Northwind LP', '2026-11-15T12:00:00.000Z'), b = deal('d_b', 'Project Coho', 'Tailwind', '2026-11-15T13:00:00.000Z');
    const c = deal('d_c', 'Project Coho', 'Tailwind', '2025-03-02T12:00:00.000Z'), e = deal('d_e', 'Project Coho', 'Tailwind', '2025-03-02T15:00:00.000Z');
    const s = { deals: { [a.id]: a, [b.id]: b, [c.id]: c } as any };
    expect([dealTwin(s, a, true), dealTwin(s, b, true), dealTwin(s, c, true)]).toEqual(['Northwind LP', 'Tailwind · Nov 15, 2026', 'Mar 2, 2025']);
    expect(dealTwin({ deals: { [c.id]: c, [e.id]: e } as any }, c, true)).toBe('Tailwind · Mar 2, 2025');   // nothing short tells them apart: the whole of it
  });
});

it('keeps the later distinguishing occurrence of a repeated phrase (#492)', () => {
  const prefix = 'Fund IV Fund V Example Infrastructure Partners ';
  const labels = [prefix + 'Fund IV (Lux) SCSp', prefix + 'Fund V (Lux) SCSp'];
  for (const [index, label] of labels.entries()) {
    const focus = distinguishingWords(label, labels);
    expect(focus?.start).toBe(prefix.length);
    expect(label.slice(focus?.start, focus?.end)).toBe(index ? 'Fund V' : 'Fund IV');
  }
});
