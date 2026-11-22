// The deal memo made into a Word file and a PDF by LibreOffice, as the app does it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { libreOfficeConverter, pdfText } from '../../src/backend/convert';
import { libreOfficeSheets } from '../../src/backend/spreadsheets';
import { memoDocument } from '../../src/domain/memoDoc';
import { sampleMemo } from '../fixtures/memoSample';
import { scaleMemo } from '../fixtures/memoScale';

const soffice = '/usr/bin/soffice'; const has = fs.existsSync(soffice);
const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-memo-test-lo-')) });

describe.skipIf(!has)('the deal memo through LibreOffice', () => {
  it('makes a Word file and a PDF with every section: the summary page alone, then the memo, then the references', async () => {
    const r = await libreOfficeSheets(lo).document!(memoDocument(sampleMemo(), 'AI'));
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect([...r.value.docx.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);            // a zip, as a .docx is
    const pages = await pdfText(r.value.pdf);
    const all = pages.join('\n');
    for (const s of ['Project Southridge', 'Summary', 'Risk at a glance', 'Key risks', 'Other risks', 'References']) expect(all).toContain(s);
    // nothing else at the back
    for (const s of ['Diligence coverage', 'Appendix', 'Checklist gaps']) expect(all).not.toContain(s);
    expect(pages[0]).toContain('Risk at a glance'); expect(pages[0]).not.toContain('Key risks');   // the summary page holds the summary alone
    expect(pages[1]).toMatch(/^Key risks/); expect(pages.at(-1)).toMatch(/Disclaimer: .*records\.$/);
  }, 120_000);

  it('at 2,000 checklist items and 42 findings grouped into risks, keeps the summary to page 1 and writes each key risk out after it', async () => {
    const r = await libreOfficeSheets(lo).document!(memoDocument(scaleMemo(), 'AI'));
    expect(r.ok).toBe(true); if (!r.ok) return;
    const pages = await pdfText(r.value.pdf);
    expect(pages[0]).toContain('Risk at a glance'); expect(pages[0]).not.toContain('affects price'); expect(pages[0]).not.toContain('Key risks');
    expect(pages[1]).toMatch(/^Key risks/);
    const all = pages.join('\n');
    expect(all.indexOf('Other risks')).toBeGreaterThan(all.indexOf('Tax equity flip date and credit adder'));
    expect(all).not.toMatch(/\b[A-Z]{2,}(?: [A-Z]{2,})+\b/);   // no line of capitals
  }, 120_000);

  it('says so when LibreOffice cannot make it', async () => {
    const broken = libreOfficeConverter({ soffice: '/nonexistent/soffice', timeoutMs: 5000 });
    const r = await libreOfficeSheets(broken).document!('<x/>');
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.message).toBe('Couldn’t make the deal memo');
  });
});
