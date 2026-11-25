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
    for (const [index, text] of texts.entries()) {
      const answered = { response: `Lender consent received for ${text}`, status: 'answered', respondedBy: 'Counsel' };
      const here = version('here', question(index + 1, text, answered));
      const there = version('there', question(index + 1, text, { priority: 'Medium' }));
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

  it('with a delete, shows the words only the deleted copy holds', () => {
    const text = portfolioQuestions()[30];
    const cleared = version('here', question(31, text, { response: '' }));
    const deletedCopy = version('there', question(31, text, { response: 'Covered by the title policy' }), true);
    expect(comparedFields(clash([cleared, deletedCopy]), QUESTION_FIELDS).shown).toEqual(['text', 'response']);
  });

  it('leaves the status out of the rows with a delete, wherever it falls in the order', () => {
    const fields = ['status', 'text', 'response'];
    const kept = version('here', question(5, portfolioQuestions()[4], { response: 'Yes' }));
    expect(comparedFields(clash([kept, version('there', null, true)]), fields).shown).toEqual(['text', 'response']);
  });

  it('compares findings, checklist items and deals in their own reading order', () => {
    const findingFields = ['title', 'body', 'status', 'workstream', 'note', 'reviewed', 'sources', 'updated', 'origin'];
    const finding = { title: 'Lender consent missing for the holdco loan', body: ['No consent in the data room'],
      status: 'open', workstream: 'Financing' };
    const asData = (data: object) => data as unknown as ConflictVersion['data'];
    const deletedFinding = version('there', asData({ ...finding, status: 'closed' }), true);
    expect(comparedFields(clash([version('here', asData(finding)), deletedFinding]), findingFields))
      .toEqual({ shown: ['title', 'body'], statusOnLine: true });

    const item = (off: boolean) => ({ text: portfolioQuestions()[3], off }) as unknown as ConflictVersion['data'];
    expect(comparedFields(clash([version('here', item(true)), version('there', item(false))]), ['off', 'text']).shown)
      .toEqual(['off']);

    const dealFields = ['name', 'group', 'counterparty', 'product', 'sector', 'technology', 'folders', 'milestone'];
    const deal = (extra: Record<string, unknown>) => ({ name: 'Lucérne', group: 'live',
      counterparty: 'Northwind Infrastructure', sector: 'Solar', ...extra }) as unknown as ConflictVersion['data'];
    const here = deal({ milestone: 'Signing', group: 'monitor' });
    const there = deal({ milestone: 'Closing', sector: 'Wind' });
    expect(comparedFields(clash([version('here', here), version('there', there)]), dealFields))
      .toEqual({ shown: ['group', 'sector', 'milestone'], statusOnLine: false });
  });

  it('compares two versions of a firm list by its items, and a deleted one by what it held', () => {
    const items = portfolioQuestions().slice(0, 2000).map((text) => ({ text }));
    const list = (extra: object) => ({ name: 'Solar', file: 'Solar checklist.xlsx', items, ...extra }) as
      unknown as ConflictVersion['data'];
    const reordered = list({ items: [...items].reverse() });
    expect(comparedFields(clash([version('here', list({})), version('there', reordered)]), ['items', 'file']).shown)
      .toEqual(['items']);
    // an empty list holds no words, so only the deleted copy's items and file are shown
    const emptied = version('here', list({ items: [], file: '' }));
    expect(comparedFields(clash([emptied, version('there', list({}), true)]), ['items', 'file']).shown)
      .toEqual(['items', 'file']);
    expect(comparedFields(clash([emptied, version('there', null, true)]), ['items', 'file']).shown).toEqual([]);
  });
});
