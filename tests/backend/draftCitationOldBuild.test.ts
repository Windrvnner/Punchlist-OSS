// @vitest-environment node
// A build that predates the draft citation boundary (#287) reads a log written by this build. Only the records that
// carry the boundary are kept from it; the regular questions around them, at deal scale, stay editable.
import { describe, it, expect, vi } from 'vitest';
import { LogRepository, type Folder } from '../../src/backend/logRepository';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const build = vi.hoisted(() => ({ schema: 2 }));
vi.mock('../../src/domain/model', async (original) => ({
  ...(await original<typeof import('../../src/domain/model')>()),
  get CURRENT_SCHEMA() { return build.schema; },
}));

class Memory implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(name: string) { const text = this.files.get(name); return text == null ? -1 : Buffer.byteLength(text); }
  read(name: string) { return this.files.get(name) ?? null; }
  append(name: string, text: string) { this.files.set(name, (this.files.get(name) ?? '') + text); }
  write(name: string, text: string) { this.files.set(name, text); }
}

const newer = 'This was last changed on a newer version of Punchlist. Update this PC to change it.';
const stamp = '2026-11-20T09:00:00.000Z';
const source = { doc: 'Credit Agreement.pdf', docId: 'doc1', loc: 'p. 14', draftCitationPrefixLength: 83 };
const mixed = {
  id: 'q_mixed',
  dealId: 'd1',
  n: 1,
  text: 'Which lock-up ratio applies from financial close?',
  status: 'answered',
  response: 'The ratio is set in Schedule [1] of the facility agreement.\n\nThe agreement prescribes 1.35x. [1]',
  provenance: { origin: 'ai', sources: [source], actor: 'pc', at: stamp },
};
const regular = portfolioQuestions().map((text, index) => ({
  id: `q_${index}`,
  dealId: 'd1',
  n: index + 100,
  text,
  status: 'open',
  response: '',
}));

function repository(shared: Memory, label: string) {
  let counter = 0;
  const newId = () => `${label}${counter++}`;
  return new LogRepository({ shared, local: new Memory(), label, user: () => label, clock: () => stamp, newId });
}
const write = (data: { id: string; [field: string]: unknown }, expectedRev: number | null) =>
  ({ kind: 'question' as const, id: data.id, data, expectedRev });
const lineSchemas = (shared: Memory) => [...shared.files.values()].join('').split('\n').filter(Boolean)
  .map((text) => JSON.parse(text).schema);

describe('a build without the draft citation boundary reading this build\'s log (#287)', () => {
  it('keeps the questions that carry the boundary as they are and still edits every other question', async () => {
    const shared = new Memory();
    build.schema = 2;
    const writer = repository(shared, 'new');
    const add = (rows: { id: string }[]) =>
      ({ dealId: 'd1', add: rows.map(({ id }) => ({ kind: 'question' as const, id })) });
    await writer.transaction({ writes: regular.map((q) => write(q, null)), index: add(regular) });
    await writer.transaction({ writes: [write(mixed, null)], index: add([mixed]) });
    await writer.transaction({ writes: [write({ ...regular[5], response: 'Provided.' }, 1)] });
    expect(regular.length).toBeGreaterThan(2000);
    expect(lineSchemas(shared)).toEqual([1, 2, 1]);

    build.schema = 1;
    const older = repository(shared, 'old');
    await older.sync();
    const kept = await older.get('question', 'q_mixed');
    expect(kept.ok && kept.value?.envelope.schema).toBe(2);
    const edit = await older.transaction({ writes: [write({ ...mixed, response: 'edited' }, 1)] });
    expect(!edit.ok && edit.error).toEqual({ kind: 'rejected', message: newer });
    const deletes = [{ kind: 'question' as const, id: 'q_mixed', expectedRev: 1 }];
    const removal = await older.transaction({ writes: [], deletes });
    expect(removal.ok).toBe(false);
    const plain = await older.get('question', 'q_7');
    const rev = plain.ok ? plain.value!.rev : 0;
    const edited = { ...regular[7], response: 'Done.' };
    const change = await older.transaction({ writes: [write(edited, rev)] });
    expect(change.ok).toBe(true);
    const unchanged = await older.get('question', 'q_mixed');
    expect(unchanged.ok && unchanged.value?.envelope.data).toEqual(mixed);
  });
});
