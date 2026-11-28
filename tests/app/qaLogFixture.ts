import { suggestMapping } from '../../src/domain/importExport';
import { ok } from '../../src/domain/result';
import { readCsv } from '../../src/domain/sheets';
import type { QaLogFiles } from '../../src/ports';

export const columns = ['No.', 'Question', 'Response'];
export const headers = columns.map((label, column) => ({ label, column }));
export const PATH = 'X:\\Deals\\Proseware\\Q&A\\Lender A Q&A.xlsx';
/** the log's rows as the import read them */
export const LOG = [['1', 'What is the DSCR?', ''], ['2', 'Who is the EPC contractor?', 'Fabrikam']];
export const importedLog = {
  sheet: 'Log', headerRow: 1, columns, mapping: suggestMapping(columns), make: true, rows: LOG,
};
/** a stand-in for the files: the log on the drive holds two questions; what each read and save was asked */
export function files(over: Partial<QaLogFiles> = {}) {
  const saves: Parameters<QaLogFiles['save']>[0][] = [];
  const reads: Parameters<QaLogFiles['read']>[0][] = [];
  const made: Parameters<QaLogFiles['create']>[0][] = [];
  const f: QaLogFiles = {
    read: async (at) => {
      reads.push(at);
      const created = made.find(({ file, folder }) => file === at.file && folder === at.folder);
      if (created) {
        const table = readCsv(created.bytes);
        return table.ok ? ok({ ...table.value, stamp: 'created' }) : table;
      }
      return ok({
        columns,
        cols: [0, 1, 2],
        lines: [2, 3],
        lastRow: 3,
        rows: [
          ['1', 'What is the DSCR?', ''],
          ['2', 'Who is the EPC contractor?', 'Fabrikam'],
        ],
        stamp: 's1',
      });
    },
    save: async (req) => {
      saves.push(req);
      return ok({ status: 'written' as const, archive: `Lender A Q&A 2026-11-15 100${saves.length}.xlsx` });
    },
    create: async (req) => {
      made.push(req);
      return ok({ file: req.file });
    },
    ...over,
  };
  return { f, saves, reads, made };
}
