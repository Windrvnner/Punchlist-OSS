/** Per-process document IDs for APIs that take complete PDFs and text inline. */
import { randomUUID } from 'node:crypto';
import { SERVICE } from '../control';
import { storable } from './claude';
import type { Converter } from './convert';

export function inlineDocuments(convert?: Converter) {
  const files = new Map<string, { name: string; type: string; data: string }>();
  return {
    async upload(file: { name: string; bytes: Uint8Array }) {
      const { bytes, type } = await storable(file, convert);
      const data = Buffer.from(bytes).toString(type === 'application/pdf' ? 'base64' : 'utf8');
      const id = `inline_${randomUUID()}`;
      files.set(id, { name: file.name.replace(/[\\/]/g, '_'), type, data });
      return id;
    },
    async remove(id: string) { files.delete(id); },
    async list() { return Array.from(files, ([id, file]) => ({ id, name: file.name })); },
    parts<T>(ids: string[] | undefined, part: (file: { name: string; type: string; data: string }) => T) {
      return (ids ?? []).map((id) => {
        const file = files.get(id);
        if (!file) throw new Error(`${SERVICE} no longer has this document.`);
        return part(file);
      });
    },
  };
}
