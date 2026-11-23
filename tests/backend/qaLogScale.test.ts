// The Q&A log at the size of a real deal: 2,000 questions, of which 150 were changed in the file by someone
// else, 100 changed in the app and 50 the log lacks. Read, worked out, written and checked, each step timed.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { libreOfficeConverter } from '../../src/backend/convert';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { logWrite } from '../../src/domain/logWrite';
import { suggestMapping } from '../../src/domain/importExport';
import type { Question } from '../../src/domain/model';
import { hasOffice as has, soffice } from './officePrerequisites';

const N = 2000; const COLS = ['No.', 'Question', 'Submitted by', 'Response', 'Status'];
const text = (i: number) => `Question ${i}: what is the position on item ${i * 7919 % 10007} of the ${['tax', 'legal', 'technical', 'commercial'][i % 4]} review?`;
const answer = (i: number) => `Answer ${i}, as agreed with counsel on October ${1 + (i % 28)}`;

/** a 2,000-row log as Excel would keep it: one sheet, a header row, text cells */
function bigLog(dir: string): string {
  const x = path.join(dir, 'x'); const put = (n: string, s: string) => { fs.mkdirSync(path.dirname(path.join(x, n)), { recursive: true }); fs.writeFileSync(path.join(x, n), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`); };
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'; const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  put('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  put('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put('xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Log" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  put('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  const c = (col: number, row: number, v: string) => `<c r="${'ABCDE'[col]}${row}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const rows = [`<row r="1">${COLS.map((h, j) => c(j, 1, h)).join('')}</row>`];
  for (let i = 1; i <= N; i++) {
    const theirs = i <= 150 ? `${answer(i)}; confirmed by the sponsor` : i % 3 ? answer(i) : '';   // the first 150 were edited in Excel
    rows.push(`<row r="${i + 1}">${[String(i), text(i), i % 2 ? 'Lender A' : 'Bidder C', theirs, theirs ? 'Answered' : 'Open'].map((v, j) => c(j, i + 1, v)).join('')}</row>`);
  }
  put('xl/worksheets/sheet1.xml', `<worksheet xmlns="${main}"><sheetData>${rows.join('')}</sheetData></worksheet>`);
  execFileSync('zip', ['-q', '-r', path.join(dir, 'Proseware Q&A.xlsx'), '.'], { cwd: x }); return dir;
}

describe('a Q&A log of 2,000 questions', () => {
  it.skipIf(!has)('is read, brought up to date and saved in place in well under a minute, with everyone\'s edits kept', async () => {
    const folder = bigLog(fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-scale-')));
    const files = nodeQaLogs({ convert: libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-scale-lo-')) }) });
    const t: Record<string, number> = {}; let at = Date.now(); const lap = (k: string) => { t[k] = Date.now() - at; at = Date.now(); };
    const r = await files.read({ folder, file: 'Proseware Q&A.xlsx' }, { sheet: 'Log', headerRow: 1 }); lap('read'); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.rows).toHaveLength(N);
    // the app's questions: what it sent last time for each, then 100 answers changed in the app and 50 questions the log lacks
    const qs = Array.from({ length: N + 50 }, (_, k) => { const i = k + 1; return { id: `q${i}`, n: i, text: text(i), askedBy: i % 2 ? 'Lender A' : 'Bidder C', response: i > 150 && i <= 250 ? `${answer(i)}, updated` : i % 3 ? answer(i) : '', status: i % 3 ? 'answered' : 'open' } as unknown as Question; });
    const sent = new Map(qs.slice(0, N).map((q) => [q.id, { response: q.n <= 250 ? answer(q.n) : q.response }]));
    const w = logWrite(r.value, suggestMapping(COLS), qs, sent); lap('work out');
    expect(w.added).toBe(50); expect(Object.keys(w.keptFields).length + Object.keys(w.taken).length).toBe(150);   // the 150 edited in Excel stand: taken in, or in two versions where the app changed them too
    expect([Object.keys(w.keptFields).length, Object.keys(w.taken).length]).toEqual([50, 100]);
    const s = await files.save({ folder, file: 'Proseware Q&A.xlsx', sheet: 'Log', steps: w.steps, stamp: r.value.stamp }); lap('write, check and save');
    expect(s.ok && s.value.status).toBe('written');
    const again = await files.read({ folder, file: 'Proseware Q&A.xlsx' }, { sheet: 'Log', headerRow: 1 }); expect(again.ok && again.value.rows).toHaveLength(N + 50);
    console.log('2,000-question log, ms:', JSON.stringify(t));
    expect(t.read + t['work out'] + t['write, check and save']).toBeLessThan(60_000);
  }, 180_000);
});
