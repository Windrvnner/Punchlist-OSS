// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LIST_ACCEPT, readListFile } from '../../src/app/listRead';

const file = (name: string) => ({ name, size: 8, arrayBuffer: async () => new ArrayBuffer(8) });

describe('the files a checklist can be brought in from', () => {
  it('takes every Excel format and a CSV, and not an OpenDocument spreadsheet', async () => {
    for (const ext of ['xlsx', 'xlsm', 'xls', 'xlsb', 'csv']) expect(LIST_ACCEPT).toContain(`.${ext}`);
    expect(LIST_ACCEPT).not.toContain('.ods');
    const refused = await readListFile({} as never, file('Checklist.ods'));
    expect(!refused.ok && refused.error.kind).toBe('invalid');
  });
});
