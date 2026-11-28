import { csvCodec } from '../../src/adapters/spreadsheet';
import { readCsv } from '../../src/domain/sheets';
import type { SpreadsheetCodec } from '../../src/ports';

// Test table bytes stand in for a worksheet flattened by LibreOffice.
export const checklistSpreadsheet: SpreadsheetCodec = {
  ...csvCodec,
  async read(bytes, _name, options) {
    return readCsv(bytes, options);
  },
};

export async function portfolioFile(questions: string[]) {
  const workstream = 'Project agreements';
  const rows = questions.map((text) => [workstream, text, 'Financing']);
  const encoded = await checklistSpreadsheet.write('Sheet1', [
    ['Portfolio', 'Financing', 'Checklist'],
    ['Section', 'Requirement', 'Subsection'],
    ...rows,
    [workstream, '', 'Outstanding'],
    rows[0],
  ]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return new File([encoded.value.bytes.slice().buffer], 'Portfolio checklist.ods');
}
