// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { markerPieces, splitCited } from '../../src/domain/cite';
import { CitedEditor, editorText, tagLabel, TAG_MAX } from '../../src/ui/citedEditor';
import { TEXT_MAX } from '../../src/domain/importExport';
import type { Source } from '../../src/domain/model';

const source = (doc: string): Source => ({ doc, loc: 'p. 1', docId: `doc_${doc.length}` });

describe('markers cut out for the finding editor (#636)', () => {
  it('joined back, the pieces are the text exactly, for any text', () => {
    const texts = ['One. [1] Two. [2]', 'One [1]. Two [2].', '[1] Starts', 'Ends [1][2]', 'clause [4] and [2019]'];
    texts.push('', '  [1]  ');
    for (const text of texts) {
      expect(markerPieces(text, 3).map((p) => p.text).join('')).toBe(text);
    }
  });
  it('only a number naming a source is a marker, the rule the reading view uses', () => {
    const text = 'A [1]. B [4]. C [2019]. D [0]. E [3].';
    const refs = markerPieces(text, 3).flatMap((p) => (p.ref ? [p.ref] : []));
    const read = splitCited(text, 3).flatMap((p) => p.refs);
    expect(refs).toEqual([1, 3]);
    expect(refs).toEqual(read);
    expect(markerPieces('A [1].', 0).some((p) => p.ref)).toBe(false);
  });
});

describe('a tag\'s words', () => {
  it('the title without its file type; at most 30 characters, cut with an ellipsis', () => {
    expect(tagLabel('Technical advisor report.pdf')).toBe('Technical advisor report');
    expect(tagLabel('Financial model.xlsx')).toBe('Financial model');
    const long = tagLabel('Information memorandum (final, as circulated to lenders).pdf');
    expect(long).toBe('Information memorandum (final…');
    expect([...long].length).toBe(TAG_MAX);
  });
  it('never cuts a letter in half or leaves a space before the ellipsis', () => {
    expect(tagLabel(`${'é'.repeat(28)} 👍🏽👍🏽👍🏽.pdf`)).toBe(`${'é'.repeat(28)}…`);
    expect(tagLabel(`${'a'.repeat(28)} bcdef.pdf`)).toBe(`${'a'.repeat(28)}…`);
  });
});

describe('the finding editor', () => {
  const mount = async (text: string, sources: Source[]) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(() => {
      render(<CitedEditor id="fe-body" label="Detail" text={text} sources={sources} onText={() => undefined} />, host);
    });
    return { box: host.querySelector('#fe-body') as HTMLElement };
  };
  it('shows each marker as a tag and gives back the stored text unchanged, at a long finding\'s scale', async () => {
    const sources = Array.from({ length: 40 }, (_, i) => source(`Data room document ${i + 1}.pdf`));
    const sentence = (p: number, s: number) => `Sentence ${s} of paragraph ${p} cites. [${((p * 4 + s) % 40) + 1}]`;
    const paragraph = (p: number) => Array.from({ length: 4 }, (_, s) => sentence(p, s)).join(' ');
    const paragraphs = Array.from({ length: 12 }, (_, p) => paragraph(p));
    const text = `${paragraphs.join('\n\n')} Clause [41] stays words.`;
    const { box } = await mount(text, sources);
    expect(box.querySelectorAll('.ctag').length).toBe(48);
    expect(box.textContent?.replace('[41]', '')).not.toMatch(/\[\d+\]/);
    expect(box.textContent).toContain('Clause [41] stays words.');
    expect(editorText(box)).toBe(text);
  });
  it('reads browser-made line breaks as new lines', () => {
    const box = document.createElement('div');
    box.innerHTML = 'One.<span data-marker="[1]">Doc</span><div>Two.<br></div><div><br></div><p>Three.</p>';
    expect(editorText(box)).toBe('One.[1]\nTwo.\n\n\n\nThree.');
  });

  it.each([
    ['a literal opening bracket', '[see schedule]', 1, 1, '['],
    ['an unfinished number', '[1 left open', 2, 1, '[1'],
    ['an out-of-range number', '[999] in the schedule', 3, 1, '[99'],
    ['a number with no sources', '[1] in the schedule', 2, 0, '[1'],
    ['a partial citation', 'See[1] for the source', 5, 1, 'See'],
    ['a whole citation', 'See[1] for the source', 6, 1, 'See[1]'],
    ['a whole grapheme', '[👍🏽 later', 3, 1, '['],
  ])('fits a paste at the limit with %s', async (_name, pasted, room, sourceCount, expected) => {
    const detail = 'The annual budget accompanies the compliance certificate. ';
    const prefix = detail.repeat(Math.ceil(TEXT_MAX / detail.length));
    const sources = sourceCount ? [source('Facility agreement.pdf')] : [];
    const { box } = await mount(prefix.slice(0, TEXT_MAX - room), sources);
    const inserted = document.createElement('div');
    const exec = vi.fn((_operation: string, _ui: boolean, value: string) => {
      inserted.innerHTML = value;
      return true;
    });
    const previous = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    try {
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: { getData: (type: string) => type === 'text/plain' ? pasted : '' },
      });
      box.dispatchEvent(paste);
      expect(editorText(inserted)).toBe(expected);
      expect(Boolean(inserted.querySelector('.ctag'))).toBe(expected === 'See[1]');
    } finally {
      if (previous) Object.defineProperty(document, 'execCommand', previous);
      else Reflect.deleteProperty(document, 'execCommand');
    }
  });
});
