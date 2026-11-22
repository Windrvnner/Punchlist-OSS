// The Q&A list's marks and filters: which questions are in two versions, which were changed in the Q&A log and not yet
// opened, and which a filter lists.
import { describe, expect, it } from 'vitest';
import { qaChanged, qaListed, qaVersions } from '../../src/app/state';
import type { Question } from '../../src/domain/model';

const q = (id: string, status: string) => ({ id, dealId: 'd', n: 1, text: 'Lock-up ratio?', response: '', askedBy: '', workstream: 'Legal', status }) as unknown as Question;
const at = '2026-11-15T16:02:00.000Z';
const state = (qaSeen: Record<string, string> = {}) => ({
  conflicts: { pc: { kind: 'question', id: 'pc', dealId: 'd', versions: [{ data: { status: 'open' } }, { data: { status: 'answered' } }] } },
  deals: { d: { qaLogs: [{ last: { at, kept: { log: { status: 'Closed ', response: '1.30x' } }, changed: { chg: { response: '1.25x' } } } }] } },
  prefs: { qaSeen },
}) as never;
const F = (status: string) => ({ status, workstream: '', text: '' }) as never;

describe('Q&A marks', () => {
  it('a question in two versions, from another PC or from the Q&A log, says so; others say nothing', () => {
    const s = state();
    expect([qaVersions(s, q('pc', 'answered')), qaVersions(s, q('log', 'open')), qaVersions(s, q('chg', 'open'))]).toEqual(['Two versions', 'Two versions', '']);
  });
  it('Changed lists the fields taken in from the log until the question is opened after that update', () => {
    expect(qaChanged(state(), q('chg', 'open'))).toEqual(['response']);
    expect(qaChanged(state({ chg: at }), q('chg', 'open'))).toEqual([]);
    expect(qaChanged(state({ chg: '2026-11-01T00:00:00.000Z' }), q('chg', 'open'))).toEqual(['response']);   // opened after an earlier update only
  });
  it('a question in two versions is listed under either version’s status, and the Changed and Two versions filters list theirs', () => {
    const s = state(); const pc = q('pc', 'answered'), log = q('log', 'open'), chg = q('chg', 'open'), plain = q('plain', 'closed');
    const listed = (f: string) => [pc, log, chg, plain].filter((r) => qaListed(s, r, F(f))).map((r) => r.id);
    expect(listed('open')).toEqual(['pc', 'log', 'chg']);
    expect(listed('answered')).toEqual(['pc']);
    expect(listed('closed')).toEqual(['log', 'plain']);   // the log's cell says Closed
    expect(listed('versions')).toEqual(['pc', 'log']);
    expect(listed('changed')).toEqual(['chg']);
    expect(listed('all')).toEqual(['pc', 'log', 'chg', 'plain']);
  });
});
