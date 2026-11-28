import { csvCodec } from '../../src/adapters/spreadsheet';
import { importKey, saveImport } from '../../src/app/keptImports';
import type { Store } from '../../src/app/store';
import { readImportBytes } from '../../src/app/transfer';
import { readCsv } from '../../src/domain/sheets';
import type { SpreadsheetCodec } from '../../src/ports';

// Test table bytes stand in for a worksheet flattened by LibreOffice.
export const checklistSpreadsheet: SpreadsheetCodec = {
  ...csvCodec,
  async read(bytes, _name, options) {
    return readCsv(bytes, options);
  },
};

export async function readChecklistTable(store: Store, file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await readImportBytes(store, file.name, bytes, { headerRow: 1 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export async function keepChecklistTable(store: Store, file: File) {
  const table = await readChecklistTable(store, file);
  if (!await saveImport(importKey.checklist(), { table })) throw new Error('Could not keep the checklist fixture');
}

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
