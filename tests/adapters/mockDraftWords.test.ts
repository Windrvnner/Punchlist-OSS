// The stand-in for drafting finds a finding by the words the search index keeps, so a number or a short token such as
// DSCR is a word that counts (#1220).
import { describe, it, expect } from 'vitest';
import { mockAi } from '../../src/adapters/mocks';
import type { Repository } from '../../src/ports';

const finding = (title: string) => ({
  envelope: { data: { status: 'open', title, body: [title], sources: [{ docId: 'doc1' }] } },
});
const repoOf = (...titles: string[]) =>
  ({ list: async () => ({ ok: true, value: titles.map(finding) }) }) as unknown as Repository;
const draft = (repo: Repository, questionText: string) =>
  mockAi({ latency: [0, 0] }, repo).draft!({ dealId: 'd1', questionText } as never);

describe('the stand-in draft finds a finding by the index words', () => {
  it('a short token and a number are words that match', async () => {
    const r = await draft(repoOf('EPC 42'), 'Is the EPC 42 signed?');
    expect(r.ok && r.value.status).toBe('found');
  });
  it('words the control file lists as filler still do not match', async () => {
    const r = await draft(repoOf('the and of'), 'the and of');
    expect(r.ok && r.value.status).toBe('none');
  });
  it('the demo filler words still do not match once folded', async () => {
    for (const word of ['terms', 'details']) {
      const r = await draft(repoOf(word), word);
      expect(r.ok && r.value.status).toBe('none');
    }
  });
});
