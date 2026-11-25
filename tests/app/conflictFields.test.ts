// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { comparedFields } from '../../src/app/conflictView';
import type { Conflict, ConflictVersion } from '../../src/app/state';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

/** a question's fields in the order the two-versions view reads them */
const QUESTION_FIELDS = [
  'text', 'response', 'status', 'workstream', 'priority', 'askedBy', 'received', 'respondedBy', 'responded',
  'provenance', 'draft', 'linkedFinding', 'n',
];
const at = '2026-11-15T10:00:00.000Z';

function question(n: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    id: `q_${n}`, n, text, response: '', status: 'open', workstream: 'Financing', priority: 'High',
    askedBy: 'Reviewer', received: '2026-11-02', ...extra,
  } as unknown as ConflictVersion['data'];
}

function version(id: string, data: ConflictVersion['data'], deleted = false): ConflictVersion {
  return { id, from: id === 'here' ? 'This PC' : 'Office desktop', by: 'Reviewer', at, data, raw: data, deleted };
}

const clash = (versions: ConflictVersion[]): Pick<Conflict, 'versions'> => ({ versions });

describe('the fields compared across two versions of a record', () => {
  it('shows only what differs, in reading order, across 104 questions changed on two PCs', () => {
    const texts = portfolioQuestions().slice(0, 104);
    for (const [at, text] of texts.entries()) {
      const answered = { response: `Lender consent received for ${text}`, status: 'answered', respondedBy: 'Counsel' };
      const here = version('here', question(at + 1, text, answered));
      const there = version('there', question(at + 1, text, { priority: 'Medium' }));
      expect(comparedFields(clash([here, there]), QUESTION_FIELDS)).toEqual({
        shown: ['response', 'status', 'priority', 'respondedBy'], statusOnLine: false,
      });
    }
  });

  it('shows nothing when the versions read the same, and nothing when only one can be read', () => {
    const text = portfolioQuestions()[7];
    const same = [version('here', question(8, text)), version('there', question(8, text))];
    expect(comparedFields(clash(same), QUESTION_FIELDS).shown).toEqual([]);
    const unreadable = [version('here', question(8, text)), version('there', null)];
    expect(comparedFields(clash(unreadable), QUESTION_FIELDS).shown).toEqual([]);
  });

  it('with a delete, shows the question and response each choice keeps, and puts the status on the line', () => {
    const text = portfolioQuestions()[12];
    const answered = { response: 'See the amended credit agreement', status: 'answered' };
    const kept = version('here', question(13, text, answered));
    const deletedCopy = version('there', question(13, text), true);
    expect(comparedFields(clash([kept, deletedCopy]), QUESTION_FIELDS))
      .toEqual({ shown: ['text', 'response'], statusOnLine: true });
    const noResponse = version('here', question(13, text, { response: '   ' }));
    expect(comparedFields(clash([noResponse, version('there', null, true)]), QUESTION_FIELDS).shown).toEqual(['text']);
  });

  it('with a delete and no words in any version, shows no fields', () => {
    const blank = version('here', question(1, ' ', { response: '' }));
    expect(comparedFields(clash([blank, version('there', null, true)]), QUESTION_FIELDS))
      .toEqual({ shown: [], statusOnLine: true });
  });
});
