// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { DocName, splitName, displayName } from '../../src/ui/docName';

describe('long file names', () => {
  it('keeps the last two words with the extension, so two drafts that differ at the end stay distinguishable', () => {
    const base = '4.2.1.17 Project Proseware - Senior Credit Agreement (Execution Version) - Lenders Counsel Comments 2026-10-14 v7 ';
    expect(splitName(base + 'CLEAN.pdf')[1]).toBe(' v7 CLEAN.pdf');
    expect(splitName(base + 'REDLINE.pdf')[1]).toBe(' v7 REDLINE.pdf');
    expect(splitName('Credit_Agreement_Execution_Version_Lenders_Comments_v7_CLEAN.pdf')[1]).toBe('_v7_CLEAN.pdf');
  });
  it('never loses a character: start and end always join back into the name', () => {
    for (const n of ['a.pdf', 'Term sheet (signed).pdf', 'x'.repeat(80) + '.pdf', 'One very long word afterwards ' + 'y'.repeat(60) + '.xlsx', 'Information memorandum - final version for lenders.pdf', 'Short name but exactly thirty1.pdf']) {
      const [a, b] = splitName(n); expect(a + b).toBe(n); expect(a.length).toBeGreaterThan(0);
    }
  });
  it('short names are left whole, and a name with no usable break falls back to a fixed-length end', () => {
    expect(splitName('Term sheet (signed).pdf')).toEqual(['Term sheet (signed).pdf', '']);
    expect(splitName('x'.repeat(80) + '.pdf')[1].length).toBe(18);
  });
  it('the element’s text is the full name (what a screen reader reads and copying gives)', () => {
    const host = document.createElement('div'); const n = 'Senior Credit Agreement (Execution Version) 2026-10-14 v7 CLEAN.pdf';
    render(<DocName name={n} />, host);
    expect(host.textContent).toBe(n); expect(host.querySelector('.docnm')!.getAttribute('title')).toBeNull();
  });
  it('the space where a name is split stays with its start, so a shortened start ends in "…" right against the end', () => {
    const host = document.createElement('div'); const n = 'X:\\Deals\\Wingtip\\Data room export\\08 Environmental';
    render(<DocName name={n} />, host);
    expect(host.textContent).toBe(n); expect(host.querySelector('.dnt')!.textContent).toBe('export\\08 Environmental'); expect(host.querySelector('.dnh')!.textContent!.endsWith(' ')).toBe(true);
  });

  describe('names that are not clean', () => {
    it('no space or underscore anywhere: the end is the last 18 characters', () => {
      const hash = 'a3f9c2e17b5d4406998e1f20c7b6aa51d0e4-FINAL-FINAL-v12(1).PDF';
      expect(splitName(hash)).toEqual([hash.slice(0, -18), hash.slice(-18)]);
      const camel = 'ProjectProsewareSeniorCreditAgreementExecutionVersionV7Clean.docx';
      expect(splitName(camel)[1]).toBe(camel.slice(-18));
    });
    it('a last word too long to keep whole (a hash, a pasted path) also falls back to 18 characters', () => {
      const n = 'Credit agreement ' + '9'.repeat(64) + '.pdf';
      expect(splitName(n)[1].length).toBe(18); expect(splitName(n).join('')).toBe(n);
    });
    it('no extension, several dots, trailing dots and brackets are all just characters', () => {
      for (const n of ['Senior Credit Agreement execution version signed copy', 'proseware.data.room.export.2026.10.14.final.tar.gz.backup', 'Agreement (1) (2) (final) (FINAL) (use this one).....', '....................................................pdf']) {
        const [a, b] = splitName(n); expect(a + b).toBe(n); expect(b.length).toBeGreaterThan(0); expect(b.length).toBeLessThanOrEqual(28);
      }
    });
    it('never cuts a character in half: emoji, accents written as two code points, and scripts without spaces', () => {
      const emoji = '📄'.repeat(40) + '.pdf';                         // each is two UTF-16 units
      const [a, b] = splitName(emoji); expect(a + b).toBe(emoji); expect(/[\uD800-\uDBFF]$/.test(a)).toBe(false); expect(/^[\uDC00-\uDFFF]/.test(b)).toBe(false);
      const combining = 'Cafe\u0301 '.repeat(2) + 'e\u0301'.repeat(40) + '.pdf';
      expect(/^\u0301/.test(splitName(combining)[1])).toBe(false);
      const cjk = '融資契約書最終版貸付人弁護士コメント反映済みクリーン版第七版二千二十六年十月十四日付.pdf';
      expect(splitName(cjk).join('')).toBe(cjk); expect(Array.from(splitName(cjk)[1]).length).toBe(18);
    });
    it('line breaks, tabs and control characters are shown as a space; a blank name says so; the stored name is not changed', () => {
      expect(displayName('Credit\r\nagreement\t(draft)\u0000\u0007.pdf')).toBe('Credit agreement (draft) .pdf');
      expect(displayName('  \n\t ')).toBe('Unnamed file');
      expect(displayName('  padded name.pdf  ')).toBe('  padded name.pdf  ');
      const host = document.createElement('div'); render(<DocName name={'Term\nsheet.pdf'} />, host);
      expect(host.textContent).toBe('Term sheet.pdf');
    });
    it('a name thousands of characters long is still two pieces, and short enough ones are left whole', () => {
      const huge = 'x'.repeat(5000); expect(splitName(huge)[1].length).toBe(18); expect(splitName(huge)[0].length).toBe(4982);
      expect(splitName('👍'.repeat(20))).toEqual(['👍'.repeat(20), '']);     // 40 code units but only 20 characters
    });
  });
});
