// A Merge cell that only lost characters never replaces the saved one; a real edit always does (#256).
import { describe, it, expect } from 'vitest';
import { damagedImportText } from '../../src/domain/importDamage';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const cp1252 = (text: string) => new TextDecoder('windows-1252').decode(new TextEncoder().encode(text));
const latin1 = (text: string) => Buffer.from(text, 'utf8').toString('latin1');

describe('damagedImportText: single kinds of damage', () => {
  it.each([
    ['question marks for quotes and dashes', 'What’s the ratio — tested when?', 'What?s the ratio ? tested when?'],
    ['replacement characters', 'It’s 1.25x — tested', 'It�s 1.25x � tested'],
    ['flattened punctuation', 'The “lender’s” reserve — capped', 'The "lender\'s" reserve - capped'],
    ['Windows-1252 misreading', 'The lender’s reserve', 'The lenderâ€™s reserve'],
    ['Latin-1 misreading', 'The café’s fees', latin1('The café’s fees')],
    ['a run for one character', 'Paid in Kč', 'Paid in K??'],
    ['one mark for a run', 'at 2½–¾ months', 'at 2? months'],
    ['a lost narrow space', 'USD 2 million', 'USD 2?million'],
    ['a vanished emoji', 'Done ✅ today', 'Done today'],
  ])('keeps the saved text for %s', (_name, saved, incoming) => {
    expect(damagedImportText(saved, incoming)).toBe(true);
  });

  it.each([
    ['a changed word', 'It’s 1.25x tested', 'It’s 1.25x reviewed'],
    ['a changed digit next to lost marks', 'It’s 1.25x — tested', 'It?s 1.30x ? tested'],
    ['a literal question mark that was dropped', 'Pending: 2½?', 'Pending: 2?'],
    ['an amount edit before a literal question mark', 'Confirm 2½?', 'Confirm 3?'],
    ['an added character', 'It’s tested', 'It?s tested!'],
    ['a clean file over a damaged value', 'What?s the ratio', 'What’s the ratio'],
    ['a curly quote over a straight one', 'It\'s tested', 'It’s tested'],
    ['spacing only', 'It’s  tested', 'It’s tested'],
    ['an ASCII-only change', 'Provide the plan', 'Provide the plans'],
  ])('imports %s', (_name, saved, incoming) => {
    expect(damagedImportText(saved, incoming)).toBe(false);
  });
});

describe('damagedImportText: combined damage in one cell', () => {
  it.each([
    ['flattened quotes with different-length runs', 'The lender’s reserve — capped at 2½ months.',
      "The lender's reserve ?? capped at 2? months."],
    ['runs that offset each other', 'The lender’s reserve — capped at 2½–¾ months.',
      "The lender's reserve ??? capped at 2? months."],
    ['misread bytes beside an unreadable one', 'The lender’s reserve is payable in Kč.',
      cp1252('The lender’s reserve is payable in Kč.').replace(/[\u0081\u008D\u008F\u0090\u009D]/g, '�')],
    ['a misread letter, a flattened quote and a lost symbol', 'The café’s fees are in € per month.',
      "The cafÃ©'s fees are in � per month."],
    ['a Latin-1 misreading with a lost symbol', 'The café’s fees are in € per month.',
      latin1('The café’s fees are in € per month.')],
  ])('keeps the saved text for %s', (_name, saved, incoming) => {
    expect(damagedImportText(saved, incoming)).toBe(true);
  });
});

/** A seeded random channel: each saved character is damaged independently, as a file of mixed history would. */
function damage(text: string, seed: number): string {
  let state = seed;
  const pick = (count: number) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return (state >> 8) % count; };
  return Array.from(text).map((char) => {
    if (char.charCodeAt(0) < 0x80) return char;
    const readings = [char, char.normalize('NFKC'), '?', '�', '??', cp1252(char), latin1(char),
      char.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')];
    return readings[pick(readings.length)];
  }).join('');
}

describe('damagedImportText: every output of the channel is recognised, no edit is', () => {
  const saved = portfolioQuestions().slice(0, 400).map((ask, index) =>
    `Re: the lender’s “${ask}” — see §${index} (€ ${index}½m, Kč ${index}) ✅`);

  it('accepts text damaged character by character in any mix', () => {
    // a draw that happens to damage nothing is the same text, which Merge already skips
    const damaged = saved.map((text, index) => [text, damage(text, index + 1)]).filter(([text, read]) => text !== read);
    expect(damaged.length).toBeGreaterThan(300);
    const missed = damaged.filter(([text, read]) => !damagedImportText(text, read)).map(([text]) => text);
    expect(missed).toEqual([]);
  });

  it('rejects the same damage once one ASCII word or digit is edited', () => {
    const accepted = saved.filter((text, index) => {
      const edited = damage(text, index + 1).replace(/\b(Provide|Confirm|What|Has|List|Describe|\d)/, 'X$1');
      return damagedImportText(text, edited);
    });
    expect(accepted).toEqual([]);
  });

  it('stays fast on a long response of lost characters', () => {
    const long = '你好'.repeat(3000);
    const started = Date.now();
    expect(damagedImportText(long, '?'.repeat(6000))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
