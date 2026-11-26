// The stand-in for the model's check of an Already Asked? pair (#1218), which needs no credentials: a question covers a
// point when it names every one of the point's words; a pair naming most of them is refused.
import { describe, it, expect } from 'vitest';
import { mockAi } from '../../src/adapters/mocks';

describe('the stand-in covers check', () => {
  it('says true for a question that names most of the point’s words and false for one that does not', async () => {
    const out = await mockAi({ latency: [0, 0] }).covers!({ dealId: 'd1', checks: [
      { point: 'Insurance advisor report (final)', question: 'Has the insurance advisor issued its final report yet?' },
      { point: 'Insurance advisor report (final)', question: 'Who audited the model, and when was the report issued?' },
      { point: 'Insurance advisor report (final)', question: 'Please send the insurance advisor report.' },
    ] });
    expect(out).toEqual({ ok: true, value: [true, false, false] });
  });
  it('answers an empty list with an empty list', async () => {
    expect(await mockAi({ latency: [0, 0] }).covers!({ dealId: 'd1', checks: [] })).toEqual({ ok: true, value: [] });
  });
});
