// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LocalChanges } from '../../src/backend/localChanges';
import { LogRepository } from '../../src/backend/logRepository';
import { isLine, type Line } from '../../src/backend/changeLines';
import { sha256Hex } from '../../src/domain/checklist';
import { Question } from '../../src/domain/model';
import { Mem, quota } from '../adapters/memRepo';

const dealId = 'd_00000000000000000000000001';
const file = `changes-office-${dealId}-0001.jsonl`;
const sidecar = 'pending-changes-office.json';
const at = '2026-11-19T09:00:00.000Z';

function recordLine(seq: number, pc = 'office', count = 1): Line {
  const recs = Array.from({ length: count }, (_, index) => {
    const id = `q_${String(index + 1).padStart(26, '0')}`;
    const data = Question.parse({
      id, dealId, rev: 0, createdAt: at, updatedAt: at, n: index + 1,
      text: `A person’s question ${index + 1}: "Confirm the agreement"`,
    });
    return { kind: 'question' as const, id, ver: `${pc}.${seq}.${index}`, base: [], data, schema: 1 };
  });
  return {
    v: 1, schema: 1, pc, seq, at, by: 'adoe', from: 'Office', recs,
    audit: recs.map(({ id, data }) => ({
      at, actor: 'adoe', kind: 'created', opId: 'op_00000000000000000000000001', recordId: id, dealId, text: data.text,
    })),
  };
}

const raw = JSON.stringify(recordLine(7));

function sizedLine(seq: number, length: number, count = 1): string {
  const line = recordLine(seq, 'office', count);
  const question = line.recs[0].data as Question;
  question.response += 'x'.repeat(length - JSON.stringify(line).length);
  return JSON.stringify(line);
}

/** Web Storage's measured character limit, applied to the entire area rather than each file (#503). */
class Limited extends Mem {
  write(name: string, text: string): void {
    const size = [...this.files].reduce((sum, [key, value]) => sum + (key === name ? 0 : value.length), text.length);
    if (size > 5_242_880) throw quota();
    super.write(name, text);
  }

  append(name: string, text: string): void { this.write(name, (this.read(name) ?? '') + text); }
}

describe('compact pending ownership (#503)', () => {
  it('returns only the receipt file for the requested operation (#565)', () => {
    const local = new Mem();
    const old = JSON.stringify({ proof: 1, pc: 'office', seq: 5, sha256: sha256Hex(raw) });
    const oldFile = 'changes-office-old-0001.jsonl';
    local.write(sidecar, JSON.stringify([{ file: oldFile, text: old }]));
    const changes = new LocalChanges(local, 'office');
    changes.append(file, JSON.stringify({ ...recordLine(9), op: 'saved-action' }) + '\n');
    const restarted = new LocalChanges(local, 'office');
    expect(restarted.pendingFiles('saved-action')).toEqual(new Set([file]));
    expect(restarted.pendingFiles('different-action')).toEqual(new Set());
  });

  it('keeps the measured large append within the same area and confirms it only from shared evidence', () => {
    const local = new Limited();
    local.write('changes-office-d0-0001.jsonl', sizedLine(6, 1_608_453) + '\n');
    local.write('changes-office-_-0001.jsonl', sizedLine(5, 232_577) + '\n');
    const line = sizedLine(7, 1_608_453, 2000);
    expect(line.length + 1).toBe(1_608_454);
    expect(isLine(JSON.parse(line))).toBe(true);
    expect(JSON.parse(line).recs).toHaveLength(2000);
    const legacySize = JSON.stringify([{ file, text: line + '\n' }]).length;
    const committedSize = [...local.files.values()].reduce((sum, value) => sum + value.length, line.length + 1);
    expect(committedSize + legacySize).toBeGreaterThan(5_242_880);
    const changes = new LocalChanges(local, 'office');
    changes.append(file, line + '\n');
    const pending = local.read(sidecar)!;
    expect(pending.length).toBeLessThan(300);
    expect(local.read(file)).toBe(line + '\n');
    expect(changes.ownLines('office')).not.toContain(line);
    const restarted = new LocalChanges(local, 'office');
    expect(restarted.seq).toBe(7);
    expect(restarted.ownLines('office')).not.toContain(line);
    const shared = new Mem();
    restarted.heal(shared, file);
    expect(shared.read(file)).toBeNull();
    shared.write(file, line + '\n');
    expect(restarted.confirm(shared.read(file)!.slice(0, -1))).toBe(true);
    expect(local.read(sidecar)).toBe('[]');
    expect(new LocalChanges(local, 'office').ownLines('office')).toContain(line);
  });

  for (const owner of ['office', 'previous']) for (const copied of ['none', 'partial', 'whole']) {
    it(`reads ${owner}'s legacy payload with ${copied} local bytes without replaying it`, () => {
      const local = new Mem();
      const name = `pending-changes-${owner}.json`;
      const ownFile = `changes-${owner}-${dealId}-0001.jsonl`;
      const line = JSON.stringify(recordLine(7, owner));
      const legacy = JSON.stringify([{ file: ownFile, text: line + '\n' }]);
      local.write(name, legacy);
      if (copied !== 'none') local.write(ownFile, copied === 'whole' ? line + '\n' : line.slice(0, 30));
      const changes = new LocalChanges(local, 'office');
      expect(local.read(name)).toBe(legacy);
      expect(changes.seq).toBe(owner === 'office' ? 7 : 0);
      const shared = new Mem();
      changes.heal(shared, ownFile, true);
      expect(shared.read(ownFile)).toBeNull();
      shared.write(ownFile, line + '\n');
      expect(changes.confirm(shared.read(ownFile)!.slice(0, -1))).toBe(true);
      expect(local.read(ownFile)).toBe(line + '\n');
      expect(local.read(name)).toBe('[]');
    });
  }

  it('never heals or confirms a same-identity line whose compact digest disagrees', () => {
    const local = new Mem();
    const proof = JSON.stringify({ proof: 1, pc: 'office', seq: 7, sha256: '0'.repeat(64) });
    const pending = JSON.stringify([{ file, text: proof }]);
    local.write(sidecar, pending);
    local.write(file, raw + '\n');
    const changes = new LocalChanges(local, 'office');
    expect(() => changes.ownLines('office')).toThrow('Pending change ownership could not be read');
    const shared = new Mem();
    expect(() => changes.heal(shared, file, true)).toThrow('Pending change ownership could not be read');
    expect(shared.read(file)).toBeNull();
    expect(() => changes.confirm(raw)).toThrow('Pending change ownership could not be read');
    expect(local.read(sidecar)).toBe(pending);
  });

  it('refuses startup rather than healing or reusing a sequence when the same-identity proof disagrees', () => {
    const shared = new Mem();
    const local = new Mem();
    const options = { local, shared, label: 'Office', user: () => 'adoe', newId: () => 'office' };
    const first = new LogRepository(options);
    expect(first.id).toBe('office');
    const proof = JSON.stringify({ proof: 1, pc: 'office', seq: 7, sha256: '0'.repeat(64) });
    const pending = JSON.stringify([{ file, text: proof }]);
    local.write(sidecar, pending);
    local.write(file, raw + '\n' + JSON.stringify(recordLine(8)) + '\n');
    expect(() => new LogRepository(options)).toThrow('Pending change ownership could not be read');
    expect(shared.list()).toEqual([]);
    expect(local.read(sidecar)).toBe(pending);
  });

  it('rejects conflicting identity proofs and unknown proof versions before touching canonical data', () => {
    const local = new Mem();
    const proof = { proof: 1, pc: 'office', seq: 7, sha256: sha256Hex(raw) };
    const entry = { file, text: JSON.stringify(proof) };
    local.write(sidecar, JSON.stringify([entry, { file, text: JSON.stringify({ ...proof, sha256: '0'.repeat(64) }) }]));
    expect(() => new LocalChanges(local, 'office')).toThrow('Pending change ownership could not be read');
    local.write(sidecar, JSON.stringify([{ file, text: JSON.stringify({ ...proof, proof: 2 }) }]));
    expect(() => new LocalChanges(local, 'office')).toThrow('Pending change ownership could not be read');
    expect(local.read(file)).toBeNull();
  });
});
