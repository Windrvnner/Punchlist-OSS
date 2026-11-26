// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withoutDraftCredits } from '../../src/backend/draftReply';
import type { Source } from '../../src/domain/model';
import { qid } from './reviewKit';

const source = (name: string): Source => ({ doc: name, loc: 'p. 1' }) as Source;
const [a, b, c] = [source('A'), source('B'), source('C')];
/** the earlier response a draft was shown, by its question's id (#1105) */
const shown = qid(12);

describe('withoutDraftCredits (#286, #1105)', () => {
  it('keeps a quarter and a reply with no earlier responses as they are', () => {
    const reply = { text: 'COD is Q3 2027. [1]', sources: [a] };
    expect(withoutDraftCredits(reply, [])).toBe(reply);
    expect(withoutDraftCredits(reply, [shown, qid(13)])).toEqual(reply);
  });

  it('drops a credit with the source only it cited and renumbers the rest, adjacent markers included', () => {
    const reply = { text: `See ${shown} for it. [1][2] Capex is $5m. [2][3]`, sources: [a, b, c] };
    expect(withoutDraftCredits(reply, [shown])).toEqual({ text: 'Capex is $5m. [1][2]', sources: [b, c] });
  });

  it('keeps a source that a kept sentence also cites, and one listed without any marker', () => {
    const reply = { text: `As in ${shown}. [1] COD is Q3 2027. [1] Capex is $5m. [2]`, sources: [a, b, c] };
    const kept = { text: 'COD is Q3 2027. [1] Capex is $5m. [2]', sources: [a, b, c] };
    expect(withoutDraftCredits(reply, [shown])).toEqual(kept);
  });

  it('leaves nothing when the whole reply is a credit, and ignores a marker with no source', () => {
    const whole = { text: `As in ${shown}. [1]`, sources: [a] };
    expect(withoutDraftCredits(whole, [shown])).toEqual({ text: '', sources: [] });
    expect(withoutDraftCredits({ text: `See ${shown}. [1] Done. [5]`, sources: [a] }, [shown]).text).toBe('Done. [5]');
  });

  it('keeps the model\'s own line breaks and paragraphs around what it drops', () => {
    const text = `COD is Q3 2027. [1]\n\nSee ${shown} for it. [2] Capex is $5m. [3]\n\n  Done.`;
    expect(withoutDraftCredits({ text, sources: [a, b, c] }, [shown]))
      .toEqual({ text: 'COD is Q3 2027. [1]\n\nCapex is $5m. [2]\n\n  Done.', sources: [a, c] });
  });

  it('returns a reply with no credit untouched, line breaks and edges included', () => {
    const reply = { text: ' One. [1]\nTwo.\n\nThree. ', sources: [a] };
    expect(withoutDraftCredits(reply, [shown, qid(13)])).toBe(reply);
  });

  it('drops only a sentence naming a shown id: an R label or an unshown id stays (#1105)', () => {
    const reply = { text: `As in R1. [1] See ${qid(13)}. [2] As in ${shown}. [3]`, sources: [a, b, c] };
    expect(withoutDraftCredits(reply, [shown])).toEqual({ text: `As in R1. [1] See ${qid(13)}. [2]`, sources: [a, b] });
  });
});
