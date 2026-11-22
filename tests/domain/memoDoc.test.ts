// The deal memo laid out as an OpenDocument text: well formed, in the template's order, escaped, and labeled.
import { describe, it, expect } from 'vitest';
import { memoDocument } from '../../src/domain/memoDoc';
import { sampleMemo } from '../fixtures/memoSample';

const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const text = (doc: Document) => doc.documentElement.textContent ?? '';

describe('the memo document', () => {
  it('is well formed, with the sections in order and the references last', () => {
    const xml = memoDocument(sampleMemo(), 'AI'); const doc = parse(xml);
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    const heads = [...doc.getElementsByTagName('text:h')].map((h) => h.textContent);
    expect(heads).toEqual(['Project Southridge', 'Summary', 'Risk at a glance', 'Key risks', 'Other risks', 'References']);
    expect(xml).toContain('<text:h text:style-name="H" text:outline-level="1">References</text:h>');
    expect(xml).toContain('fo:page-width="8.5in" fo:page-height="11in"');
  });

  it('escapes what the records say', () => {
    const m = sampleMemo(); const xml = memoDocument(m, 'AI');
    expect(xml).toContain('Notice address for the agent differs between drafts &amp; &lt;versions&gt;');
    expect(text(parse(xml))).toContain('drafts & <versions>');
  });

  it('says once, in a disclaimer at the very end, with the AI name it is given, that the model wrote the summary, ratings and key risks, and nowhere names a vendor', () => {
    const t = text(parse(memoDocument(sampleMemo(), 'Assistant')));
    expect(t.trimEnd()).toMatch(/Disclaimer: the summary, the risk ratings and the write-ups of the key risks in this memo were written by Assistant from the deal’s records\.$/);
    expect(t.split('Assistant').length - 1).toBe(1);   // no other mark anywhere
    expect(t).not.toMatch(/North|Cohere|Claude|Anthropic/);
  });

  it('prints the ratings as plain words, with no definition beside them', () => {
    const t = text(parse(memoDocument(sampleMemo(), 'AI')));
    expect(t).not.toMatch(/affects price|affects terms|no effect on terms/i);
  });

  it('leaves out what has nothing in it', () => {
    const m = { ...sampleMemo(), glance: [], risks: [], minor: [], refs: [] };
    const doc = parse(memoDocument(m, 'AI'));
    expect([...doc.getElementsByTagName('text:h')].map((h) => h.textContent)).toEqual(['Project Southridge', 'Summary']);
    expect(text(doc)).not.toContain('References');
  });
});
