// The hover on "#N on issues list": the list's name, then the point's words. Several points get a line each, so
// every point shows some of its words.
import { describe, it, expect } from 'vitest';
import './keptTextSession';
import { onListTip, onListText } from '../../src/ui/issuesList';

describe('the issues list mark', () => {
  it('one point: its list, then its number and words', () => {
    expect(onListTip([{ doc: 'doc_s', list: 'Sponsor list.pdf', n: '3', text: 'Fees to be agreed.' }])).toBe('Sponsor list\n#3 · Fees to be agreed.');
  });
  it('several points: under each list, a line per point with its words, a long one cut at a word', () => {
    const marks = [{ doc: 'doc_s', list: 'Sponsor list.pdf', n: '1', text: 'A long point. '.repeat(40).trim() }, { doc: 'doc_l', list: 'Lender list.docx', n: '41', text: 'Another.' }, { doc: 'doc_s', list: 'Sponsor list.pdf', n: '7', text: 'More.' }];
    expect(onListText(marks)).toBe('#1, #41, #7 on issues list');
    const lines = onListTip(marks).split('\n');
    expect(lines).toEqual(['Sponsor list', expect.stringMatching(/^#1 · A long point\. A long point\. .*…$/), '#7 · More.', 'Lender list', '#41 · Another.']);
    expect(lines[1].length).toBeLessThanOrEqual(84);
  });
});
