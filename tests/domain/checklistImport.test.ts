import { describe, it, expect } from 'vitest';
import { suggestChecklistColumns, prepareChecklist, sameWording, earlierRewordings } from '../../src/domain/checklistImport';

describe('reading a checklist from a table', () => {
  it('finds the item and section columns by their headings', () => {
    const area = suggestChecklistColumns(['#', 'Area', 'Requirement', 'Owner']);
    expect(area).toEqual({ item: 2, section: 1, subsection: null });
    expect(suggestChecklistColumns(['Section', 'Sub-section', 'Item'])).toEqual({ item: 2, section: 0, subsection: 1 });
    expect(suggestChecklistColumns(['Ref', 'Checklist item'])).toEqual({ item: 1, section: null, subsection: null });
  });
  it('without a known heading, picks no item column, whatever the cells hold', () => {
    const none = suggestChecklistColumns(['No', 'Document', 'Notes']);
    expect(none).toEqual({ item: null, section: null, subsection: null });
  });
  it('turns rows into items, carries a section down to the rows under it, and counts empty rows', () => {
    const rows = [['Insurance', 'Insurance is in place'], ['', 'Insurer is rated A- or better'], ['', '  '], ['Model', 'The model is audited']];
    expect(prepareChecklist(rows, { item: 1, section: 0 })).toEqual({ skipped: 1, items: [
      { text: 'Insurance is in place', section: 'Insurance' }, { text: 'Insurer is rated A- or better', section: 'Insurance' }, { text: 'The model is audited', section: 'Model' }] });
  });
  it('carries a subsection down within its section, and starts each new section with none', () => {
    const rows = [['Finance', 'Model', 'The model is audited'], ['', '', 'Reserves are funded'], ['Legal', '', 'Approvals are in place'], ['', 'Security', 'Shares are pledged']];
    expect(prepareChecklist(rows, { item: 2, section: 0, subsection: 1 }).items).toEqual([
      { text: 'The model is audited', section: 'Finance', subsection: 'Model' }, { text: 'Reserves are funded', section: 'Finance', subsection: 'Model' },
      { text: 'Approvals are in place', section: 'Legal' }, { text: 'Shares are pledged', section: 'Legal', subsection: 'Security' }]);
  });
  it('lists items worded the same, whatever their case, spacing or final period', () => {
    expect(sameWording([{ text: 'Insurance is in place' }, { text: 'Model audited' }, { text: 'insurance  is in place.' }])).toEqual([[0, 2]]);
  });
});

describe('rewordings taken when a list was last brought in', () => {
  const before = [{ text: 'Audited financial statements for the last three years', was: 'Audited financials, last 3 yrs' }, { text: 'Insurance is in place' }];
  it('offers each again for a row that still reads as the file did, matched without case, spacing or a final period', () => {
    expect(earlierRewordings([{ text: 'Insurance is in place' }, { text: 'audited financials,  last 3 yrs.' }], before)).toEqual([{ at: 1, text: 'Audited financial statements for the last three years' }]);
  });
  it('offers nothing for a new list, a row already in the new wording, or a row the file has changed', () => {
    expect(earlierRewordings([{ text: 'Audited financials, last 3 yrs' }], undefined)).toEqual([]);
    expect(earlierRewordings([{ text: 'Audited financial statements for the last three years' }, { text: 'Audited financials, last 2 yrs' }], before)).toEqual([]);
  });
  it('offers an item split in two again as its two items, in their order', () => {
    const split = [{ text: 'Wetlands delineation complete (if applicable).', was: 'Wetlands delineation complete; any Section 404 permit in hand' }, { text: 'Section 404 permit in hand (if applicable).', was: 'Wetlands delineation complete; any Section 404 permit in hand' }];
    expect(earlierRewordings([{ text: 'Wetlands delineation complete; any Section 404 permit in hand' }], split)).toEqual([{ at: 0, text: 'Wetlands delineation complete (if applicable).', also: ['Section 404 permit in hand (if applicable).'] }]);
    // a row the file had twice, reworded alike both times, is one rewording, not a split
    const twice = [{ text: 'Long-term service agreement in place.', was: 'LTSA in place', section: 'A' }, { text: 'Long-term service agreement in place.', was: 'LTSA in place', section: 'B' }];
    expect(earlierRewordings([{ text: 'LTSA in place' }, { text: 'LTSA in place' }], twice)).toEqual([{ at: 0, text: 'Long-term service agreement in place.' }, { at: 1, text: 'Long-term service agreement in place.' }]);
  });
});
