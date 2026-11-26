// @vitest-environment node
// Asking about many things a part at a time, when the service may cut a reply off or refuse a request as too long at
// a limit the app cannot know (parts.ts, decisions: Cut-off output). Tested at deal scale: 2,400 checklist items.
import { describe, it, expect } from 'vitest';
import { inParts, partSize } from '../../src/backend/parts';
import { cutOff, tooLong, saysTooLong } from '../../src/backend/limits';
import { unfinished } from '../../src/backend/lenient';

const range = (n: number) => Array.from({ length: n }, (_, k) => k);
/** a stand-in service whose replies hold at most `fits` items: a longer part comes back cut after `fits` whole items and part of the next */
const capped = (fits: number, sizes: number[]) => async (part: number[]) => {
  sizes.push(part.length);
  if (part.length <= fits) return { got: new Map(part.map((x, k) => [k, `answer ${x}`])) };
  return { got: new Map(part.slice(0, fits).map((x, k) => [k, `answer ${x}`])), cut: range(part.length).slice(fits) };
};

describe('asking in parts', () => {
  it('asks 2,400 items in parts of the size given when nothing is cut off', async () => {
    const sizes: number[] = []; const r = await inParts(range(2400), 120, capped(1000, sizes));
    expect(sizes).toEqual(Array(20).fill(120)); expect(r.got.size).toBe(2400); expect(r.left).toEqual([]); expect(r.stopped).toBeUndefined();
  });
  it('keeps what came back whole from a cut reply, asks the first two things not back alone, and finding them whole, asks the rest in parts half the size, keeping the smaller size for the rest of the run', async () => {
    const sizes: number[] = []; const r = await inParts(range(2400), 120, capped(45, sizes));
    expect(sizes.slice(0, 7)).toEqual([120, 1, 1, 60, 1, 1, 30]);      // 45 kept, items 46 and 47 alone are whole, then 60 asked (45 kept), the same again, then parts of 30
    expect(Math.max(...sizes.slice(6))).toBe(30); expect(r.size).toBe(30);
    expect(r.got.size).toBe(2400); expect([...r.got.keys()].sort((a, b) => a - b)).toEqual(range(2400)); expect(r.got.get(2399)).toBe('answer 2399');
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(2400 * 1.1);   // little is asked twice
  });
  it('a reply cut off with nothing whole in it, as a thrown cut-off, asks its first two items alone, then halves; an item cut off alone is handed back, not guessed', async () => {
    const sizes: number[] = [];
    const r = await inParts(range(10), 8, async (part) => { sizes.push(part.length); if (part.includes(6)) throw cutOff('cut off', '{"items": [{"n": 1'); return { got: new Map(part.map((x, k) => [k, x])) }; });
    expect(r.left).toEqual([6]); expect(r.got.size).toBe(9); expect((r.stopped as { code?: string }).code).toBe('cutoff');
    expect(sizes).toEqual([8, 1, 1, 4, 4, 1, 3]);   // the first part is cut, its first two items alone are whole, so it halves; then 6 alone is cut and set aside, and the rest go on at the same size
  });
  it('one item cut off even alone does not leave the rest of the run asked one at a time', async () => {
    const sizes: number[] = [];
    const r = await inParts(range(400), 20, async (part) => { sizes.push(part.length); const bad = part.indexOf(37); return bad < 0 ? { got: new Map(part.map((x, k) => [k, x])) } : { got: new Map(part.slice(0, bad).map((x, k) => [k, x])), cut: range(part.length).slice(bad) }; });
    expect(r.left).toEqual([37]); expect(r.got.size).toBe(399); expect(r.size).toBe(20);
    expect(sizes.length).toBeLessThan(28); expect(Math.min(...sizes.slice(-5))).toBeGreaterThan(1);
  });
  it('stops asking once three items in a row are cut off even alone with nothing whole between, handing the rest back as not asked, not as cut off', async () => {
    const sizes: number[] = [];
    const r = await inParts(range(2000), 20, async (part) => { sizes.push(part.length); throw cutOff('cut off'); });
    expect(r.got.size).toBe(0); expect(r.left).toEqual([0, 1, 2]); expect(r.unasked).toEqual(range(2000).slice(3)); expect((r.stopped as { code?: string }).code).toBe('cutoff');
    expect(sizes.length).toBeLessThan(10);
  });
  it('a long item costs two calls (its part, then itself alone) and the parts keep their size, however often long items come', async () => {
    for (const every of [5, 10, 50]) {
      const sizes: number[] = [];
      const r = await inParts(range(2000), 20, async (part) => { sizes.push(part.length); const bad = part.findIndex((x) => x % every === every - 1); return bad < 0 ? { got: new Map(part.map((x, k) => [k, x])) } : { got: new Map(part.slice(0, bad).map((x, k) => [k, x])), cut: range(part.length).slice(bad) }; });
      const long = 2000 / every; expect(r.left.length).toBe(long); expect(r.unasked).toEqual([]); expect(r.got.size).toBe(2000 - long);
      expect(sizes.length).toBeLessThanOrEqual(Math.ceil(2000 / 20) + 2 * long + 1); expect(r.size).toBe(20);
    }
  });
  it('a request refused as too long is asked again in smaller parts; one too long even alone ends the run, asking nothing more', async () => {
    const sizes: number[] = [];
    const r = await inParts(range(100), 100, async (part) => { sizes.push(part.length); if (part.length > 30 || part.includes(77)) throw tooLong('too long', 400); return { got: new Map(part.map((x, k) => [k, x])) }; });
    expect(sizes).toEqual([100, 50, 25, 25, 25, 25, 13, 7, 4, 2, 2, 1]); expect(r.left).toEqual(range(100).slice(77)); expect(r.got.size).toBe(77);
    expect((r.stopped as { code?: string }).code).toBe('toolong');
  });
  it('any other error stops the run: what answered is kept, and the rest is handed back with the error', async () => {
    const down = Object.assign(new Error('down'), { code: 'unreachable' }); let n = 0;
    const r = await inParts(range(50), 10, async (part) => { if (++n === 3) throw down; return { got: new Map(part.map((x, k) => [k, x])) }; });
    expect(r.got.size).toBe(20); expect(r.left).toEqual(range(50).slice(20)); expect(r.stopped).toBe(down);
  });
  it('sizes a part to fit about 60% of the output limit, and of the input limit, never past its cap or below one', () => {
    expect(partSize({ cap: 20, out: 250, outLimit: 16000 })).toBe(20);
    expect(partSize({ cap: 20, out: 250, outLimit: 4000 })).toBe(9);
    expect(partSize({ cap: 120, out: 60, outLimit: 1000 })).toBe(10);
    expect(partSize({ cap: 20, out: 50000, outLimit: 1000 })).toBe(1);
    expect(partSize({ cap: 120, out: 80, outLimit: 16000, in: 40, inLimit: 4000 })).toBe(60);   // 60% of the input limit, at 40 tokens an item
  });
});

describe('a reply that stops partway', () => {
  it('is told from a whole one, whatever text is around it', () => {
    expect(unfinished('{"items": [{"id": "I1", "result": "ok"}, {"id": "I2", "res')).toBe(true);
    expect(unfinished('```json\n{"a": "a brace } in a string, and [ too"')).toBe(true);
    expect(unfinished('Here it is:\n```json\n{"a": [1, 2], "b": "x"}\n```\nAnything else?')).toBe(false);
    expect(unfinished('[{"n": 1}, {"n": 2}]')).toBe(false);
    expect(unfinished('I cannot help with that.')).toBe(false);
    expect(unfinished('{"text": "he said \\"stop\\" and left"}')).toBe(false);
    expect(unfinished('{"status": "found", "text": "The pipeline is 36" in diameter. [1]", "sources": [{"doc": "D1", "page": 2}]}')).toBe(false);   // a stray quote, for inches
    expect(unfinished('{"items": [{"id": "I1", "quote": "a 36" pipe"}, {"id": "I2", "result": "ok"}')).toBe(true);
    expect(unfinished('{"text": "Under clause 4.2] of the draft the borrower must raise it where the lender may')).toBe(true);   // a bracket in the text, then the cut
    expect(unfinished('{"text": "The template placeholder } is left unfilled, and the margin')).toBe(true);
    expect(unfinished('```json\n{"text": "see 4.2] and 36\" pipe"}\n```')).toBe(false);
    // bracketed words or an aside before the answer do not hide a cut in the answer
    expect(unfinished('{"note": "one aside"}\n{"items": [{"id": "I1", "body": ["The credit agreement sets the mar')).toBe(true);
    expect(unfinished('Using {id, result} per item:\n{"items": [{"id": "I1", "result": "ok"}, {"id": "I2", "result": "mo')).toBe(true);
    expect(unfinished('[1] refers to the credit agreement.\n{"items": [{"id": "I1", "result": "mo')).toBe(true);
    expect(unfinished('In the shape {"items": [...]} you asked for:\n```json\n{"items": [{"n": 3, "text": "The borrower must hold all perm')).toBe(true);
    expect(unfinished('I could not find {the annex. Here is my reply: {"items": [{"id": "I1", "result": "ok"}]}')).toBe(false);   // a stray { in the words before it
    expect(unfinished('I could not find {the annex. Here is my reply: {"items": [{"id": "I1", "result": "o')).toBe(true);
    expect(unfinished('[Note] two need rewording.\n{"items": [{"n": 3, "text": "Hold all permits."}]}\nThat is all {so far}.')).toBe(false);
  });
});

describe('a refusal that says the request is too long', () => {
  it('is told from a refusal of something else', () => {
    for (const m of ['prompt is too long: 210000 tokens > 200000 maximum', "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.", 'Input exceeds the context window of this model', 'Request too large for model',
      'input length and `max_tokens` exceed context limit: 188240 + 16000 > 200000, decrease input length or `max_tokens` and try again',
      "This model's maximum context length is 32768 tokens. However, you requested 34000 tokens (18000 in the messages, 16000 in the completion). Please reduce the length of the messages or completion.",
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 30000 `inputs` tokens and 16000 `max_new_tokens`',
      'Input validation error: `inputs` must have less than 4096 tokens. Given: 5000'])   // not checked against the server's source
      expect(saysTooLong(400, m)).toBe(true);
    expect(saysTooLong(413, '<html><head><title>413 Request Entity Too Large</title></head></html>')).toBe(true);
    for (const m of ["Invalid 'tools[0].function.description': string too long", 'file name too long', 'max_tokens is too large: 64000', 'max_tokens: 64000 > 8192, which is the maximum allowed number of output tokens',
      // the reply limit is what is wrong, though the input is named too; a rate limit; a field of a tool
      "'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 8192 tokens and your request has 120 input tokens",
      "This model's maximum context length is 4096 tokens. However, you requested 16100 tokens (100 in the messages, 16000 in the completion).",
      'Rate limit: too many tokens per minute', 'The request exceeds the maximum number of tokens for the tool description',
      'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 120 `inputs` tokens and 64000 `max_new_tokens`'])
      expect(saysTooLong(400, m)).toBe(false);
    expect(saysTooLong(413, 'File too large: maximum upload size is 32 MB', true)).toBe(false);   // an upload refused is about the file
    expect(saysTooLong(500, 'prompt is too long')).toBe(false);
  });
});

describe('the limits of a model the service describes', () => {
  it('are the control file\'s unless the model allows less, and a reply never takes more than half of a small context', async () => {
    const { limitsOf } = await import('../../src/backend/limits');
    expect(limitsOf()).toEqual({ output: 32000, input: 180000 });
    expect(limitsOf({ maxTokens: 4000, contextLength: 128000 })).toEqual({ output: 4000, input: 124000 });
    expect(limitsOf({ contextLength: 8192 })).toEqual({ output: 4096, input: 4096 });
    expect(limitsOf({ maxTokens: null, contextLength: null })).toEqual({ output: 32000, input: 180000 });
  });
});

describe('a whole reply with words around it', () => {
  it('is not taken as cut off for a bracket in those words', () => {
    expect(unfinished('{"a": 1}\nNote [draft')).toBe(false);                    // words after it has closed are not looked at
    expect(unfinished('Reading [D1 and D2: {"a": 1}')).toBe(false);              // nor words before it
    expect(unfinished('I looked at [D1 and could not tell.')).toBe(false);
    expect(unfinished('[{"n": 1}, {"n": 2')).toBe(true);                          // a reply that is nothing but a list, cut
  });
});
