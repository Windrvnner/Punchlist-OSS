/**
 * Writing into a CSV log in place of LibreOffice: only the lines given values are written anew, in the file's own
 * quoting; every other line, the line endings and the byte-order mark stay as they were. The text encoding is kept by
 * the caller. Commas only, as the reader (parseCsv) reads them.
 */
import { parseCsv, type SheetEdit } from './sheets';

/** each record's text as it is in the file, and the line ending after it ('' for a last line with none) */
function records(text: string): { raw: string; end: string }[] {
  const out: { raw: string; end: string }[] = []; let start = 0; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;                                                  // "" inside quotes flips twice, so it changes nothing
    else if (!quoted && (c === '\n' || c === '\r')) { const end = c === '\r' && text[i + 1] === '\n' ? '\r\n' : c; out.push({ raw: text.slice(start, i), end }); i += end.length - 1; start = i + 1; }
  }
  if (start < text.length) out.push({ raw: text.slice(start), end: '' });
  return out;
}

/** Excel runs a CSV cell that starts with = + - or @ as a formula: a space in front keeps such text as text (a plain number stays) */
export const csvSafe = (v: string) => (/^[=+\-@]/.test(v) && !/^[+-]?\d[\d.,]*%?$/.test(v) ? ` ${v}` : v);

/** a record's fields as they are written in the file, quotes and all */
function rawFields(raw: string): string[] {
  const out: string[] = []; let start = 0; let quoted = false;
  for (let i = 0; i < raw.length; i++) { if (raw[i] === '"') quoted = !quoted; else if (raw[i] === ',' && !quoted) { out.push(raw.slice(start, i)); start = i + 1; } }
  out.push(raw.slice(start)); return raw ? out : [];
}

/** `text` with the steps made; `text` is the file decoded, without its byte-order mark */
export function editCsv(text: string, steps: SheetEdit[]): string {
  const recs = records(text);
  const eol = recs.find((r) => r.end)?.end ?? '\r\n';
  const all = recs.every((r) => !r.raw || /^".*"$/s.test(r.raw));                       // a file that quotes every field keeps doing so
  const quote = (v: string) => (all || /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const width = Math.max(1, ...recs.map((r) => parseCsv(r.raw)[0]?.length ?? 0));
  const rows: (string[] | null)[] = recs.map(() => null);                                  // null: the line is left as it is
  // a line given a value keeps every other field exactly as the file writes it; only the fields set are written anew
  const fields = (i: number) => { rows[i] ??= rawFields(recs[i].raw); return rows[i]!; };
  for (const s of steps) {
    if (s.kind === 'rows') {
      if (recs.slice(s.after + 1).some((r) => r.raw.replace(/[",\s]/g, ''))) throw new Error(`row ${s.after + 2} of the file is not empty`);
      if (recs[s.after] && !recs[s.after].end) recs[s.after].end = eol;                   // the last line had no line ending: it gets one before the new rows
      recs.splice(s.after + 1, recs.length, ...Array.from({ length: s.count }, () => ({ raw: '', end: eol }))); rows.splice(s.after + 1, rows.length, ...Array.from({ length: s.count }, () => Array(width).fill('')));
    } else {
      while (recs.length <= s.row) { recs.push({ raw: '', end: eol }); rows.push(null); }
      const f = fields(s.row); while (f.length <= s.col) f.push(''); f[s.col] = quote(String(s.value));
    }
  }
  return recs.map((r, i) => (rows[i] ? rows[i]!.map((f) => (f === '' && all ? '""' : f)).join(',') : r.raw) + r.end).join('');
}
