import type { Converter } from '../../src/backend/convert';

/**
 * The converter's `workbook`, made once for each document: later calls get a copy of the same bytes, so related
 * cases share one real LibreOffice conversion and each still has its own bytes to change (#102).
 */
export function cachedWorkbook(lo: Converter): (fods: string) => Promise<Uint8Array> {
  const made = new Map<string, Promise<Uint8Array>>();
  return async (fods) => {
    if (!made.has(fods)) made.set(fods, lo.workbook!(fods));
    return (await made.get(fods)!).slice();
  };
}
