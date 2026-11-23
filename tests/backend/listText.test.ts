// @vitest-environment node
// A list brought in from a document: its text, line by line, through LibreOffice (Word, OpenDocument, RTF) or
// PDF.js (a PDF), as the app does it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { libreOfficeConverter } from '../../src/backend/convert';
import { libreOfficeSheets } from '../../src/backend/spreadsheets';
import { hasOffice as has, soffice } from './officePrerequisites';

const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-list-test-lo-')) });
const LIST = ['Proseware Solar checklist', '1. Site', '1.1 Title report for the whole site', '1.2 Leases cover the array', '2. Permits', '2.1 Conditional use permit issued'];

describe.skipIf(!has)('a list in a document, as lines', () => {
  it('reads a Word file and a PDF made from the same list, a line for each paragraph', async () => {
    // the list as an OpenDocument text, then made into a .docx and a .pdf by LibreOffice
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-list-doc-'));
    const fodt = `<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text>${LIST.map((l) => `<text:p>${l}</text:p>`).join('')}</office:text></office:body></office:document>`;
    const src = path.join(dir, 'list.fodt'); fs.writeFileSync(src, fodt);
    const { execFileSync } = await import('node:child_process');
    for (const to of ['docx:MS Word 2007 XML', 'pdf:writer_pdf_Export']) execFileSync(soffice, [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', to, '--outdir', dir, src], { stdio: 'ignore', timeout: 120_000 });
    const codec = libreOfficeSheets(lo);
    for (const name of ['list.docx', 'list.pdf']) {
      const r = await codec.text!(new Uint8Array(fs.readFileSync(path.join(dir, name))), name);
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.value.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(LIST);
    }
  }, 240_000);

  it('says so when the file cannot be read', async () => {
    const codec = libreOfficeSheets(lo);
    for (const name of ['broken.docx', 'broken.pdf']) {
      const r = await codec.text!(new Uint8Array([1, 2, 3, 4]), name);
      expect(r.ok).toBe(false);
    }
  }, 120_000);
});
