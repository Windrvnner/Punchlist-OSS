/**
 * What the app writes back into the deal's Q&A log. The log stays the person's own file, in its own
 * format, columns and look, and is kept up to date as an IB Q&A log is: every column it has is filled in
 * from the app. An empty cell takes the app's value, if it has one; nothing is made up. A filled cell the app changed since
 * it last wrote it is updated, but not one someone else changed in the log since: theirs stands (`deMinimis` decides what
 * counts as a change). Questions the log lacks get rows of their own at the end. The app adds no columns.
 */
import type { Question } from './model';
import type { ReadTable, SheetEdit } from './sheets';
import { sameWords, prepareImport, IMPORT_FIELDS, type Mapping, type ImportField, type ImportRow } from './importExport';
import { key } from './checklist';
import { ROMAN_NUMERAL, NAMING_WORDS, normalizeReferences, setApartParts, isNamedChain } from './references';

/** every field the app keeps up to date in the log, where the log has a column for it */
const FIELDS: ImportField[] = ['n', 'text', 'askedBy', 'received', 'workstream', 'priority', 'status', 'response', 'respondedBy', 'responded'];
const STATUS_LABEL: Record<Question['status'], string> = { open: 'Open', answered: 'Answered', closed: 'Closed' };
/** a date field's step says so, so a workbook gets a real date in the column's own format */
const dated = (k: ImportField) => (k === 'received' || k === 'responded' ? { date: true as const } : {});
/** a question's value for a field, as the app writes it */
export function cellValue(q: Question, k: ImportField): string { return k === 'status' ? STATUS_LABEL[q.status] ?? '' : k === 'n' ? String(q.n) : String((q as unknown as Record<string, unknown>)[k] ?? ''); }

export interface LogWrite {
  steps: SheetEdit[];
  /** questions given a row of their own at the end of the log */
  added: number;
  /** log rows given a response they did not have */
  answered: number;
  /** log rows with a cell brought up to date */
  updated: number;
  /** questions with a cell someone changed in the log since the app wrote it: theirs is left as it is */
  kept: number[];
  /** those cells' fields, by question id */
  keptFields: Record<string, ImportField[]>;
  /** what those cells say in the log, by question id and field: what a person is shown, and keeps or takes */
  keptText: Record<string, Record<string, string>>;
  /** what the log holds of the app's after these steps, by question id and field: what was written, a cell that already said
   * the same (as the log writes it), and for a cell kept as someone wrote it, what the app had sent before. The next update's `sent`. */
  sent: Record<string, Record<string, string>>;
  /**
   * Cells only the log changed since the app last wrote them (the app's value is still what it sent): the log's is the
   * latest, so the app takes it. By question id and field, what the log says. Not written, and not in `kept`.
   */
  taken: Record<string, Record<string, string>>;
}

/**
 * Two texts that differ only where a character was read wrong: text decoded in the wrong encoding ("donâ€™t"
 * for "don't"), a "?" or "\uFFFD" in place of a character a file could not hold, an emoji lost, and the forms Unicode gives one
 * character (a curly or straight quote, a dash shape, a non-breaking space). Spacing and line breaks, which a spreadsheet
 * stores its own way, do not count either. Everything a person types counts: every letter, its case, digits and punctuation.
 */
export function deMinimis(a: string, b: string): boolean {
  if (readKey(a) === readKey(b)) return true;
  const x = readKey(a, true), y = readKey(b, true);                                   // an emoji that became "?" is matched below
  // a "?" or "\uFFFD" stands for any one character outside plain ASCII (or a run of them, as an emoji can become "??")
  const lost = (s: string, t: string) => /[?\uFFFD]/.test(s) && new RegExp(`^${s.split(/[?\uFFFD]+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:[^\\x00-\\x7F]+|[?\uFFFD]+)')}$`, 'u').test(t);
  return lost(x, y) || lost(y, x);
}
/** a text with what a misreading changes taken out: its encoding repaired, Unicode's forms of one character made one, emoji and spacing gone */
function readKey(s: string, emoji = false): string {
  const t = mojibake(s).normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-');
  return (emoji ? t : t.replace(/\p{Extended_Pictographic}|\u200D|\uFE0E|\uFE0F/gu, ''))
    .replace(/\s+/g, ' ').trim();
}
/** UTF-8 text that was read as Windows-1252 ("â€™", "Ã©") made what it was; anything else as it is */
const CP1252 = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';
function mojibake(s: string): string {
  if (!/[\u00C2-\u00F4][\u0080-\u00BF\u0152-\u2122]/.test(s)) return s;
  const bytes: number[] = [];
  for (const ch of s) { const c = ch.codePointAt(0)!; const k = CP1252.indexOf(ch); if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) bytes.push(c); else if (k >= 0) bytes.push(0x80 + k); else return s; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch { return s; }
}
const QUESTION_WORD = /[\p{L}\p{M}|]+/gu;
/**
 * The words of a question with what a misreading could change taken out, for matching a log's rows and an import's to the
 * app's questions (not for deciding whose a cell is): spacing, case, quote and dash shapes, punctuation between words, a capital
 * I for an l inside a word, and inside a number the letters a reader takes for digits.
 * Identifiers and combining marks stay distinct.
 */
export function misreadKey(s: string): string {
  return normalizeReferences(s.normalize('NFKC'))
    .replace(/[\u2010-\u2015\u2212]/g, '-')                                             // dash shapes are one dash
    .replace(/[^\s]*\d[^\s]*/g, (t) => t.replace(/[lI|](?=[\d.,]|$)|(?<=[\d.,])[lI|]/g, '1').replace(/[oO](?=[\d.,])|(?<=[\d.,])[oO]/g, '0'))   // l00, 2O24
    .replace(QUESTION_WORD, repairWord)
    .toLowerCase()
    .replace(/(\d)\.(?=\d)/g, '$1\u0000').replace(/(\d),(?=\d)/g, '$1\u0001')            // a point or comma inside a number is kept, each as itself: 1,500 is not 1.500
    .replace(/[^\p{L}\p{M}\p{N}\u0000\u0001\-+()$€£¥<>/%:=|]/gu, '');
}

/** Repair initial I or i before a lowercase word. A period could belong to an abbreviation. */
function isProseI(offset: number, text: string): boolean {
  if (!/^\s*\p{Ll}/u.test(text.slice(offset + 1))) return false;
  const before = text.slice(0, offset).trimEnd();
  if (!/[\p{L}\p{M}\p{N}|]/u.test(before)) return true;
  return /[?!]$/.test(before);
}

/**
 * A misread or mistyped character can turn Is into ls. Roman identifiers keep their letters. The word I, however it was
 * read, is i, so a class L that opens a sentence is not it (#127).
 */
function repairWord(word: string, offset: number, text: string): string {
  if (/^[Iil|]$/.test(word) && isProseI(offset, text)) return 'i';
  if (word.length < 2 || ROMAN_NUMERAL.test(word)) return word;
  return word.replace(/[I|]/g, 'l');
}

/** two wordings of one question: the same words, or differing only as a misreading could make them differ (same words have one key too) */
export const sameQuestion = (a: string, b: string) => sameWords(a, b) || misreadKey(a) === misreadKey(b);

/** a log's question number as it is written ("Q4", "4.", "#004", "A-4"): what comes before the number, the number, and what after */
const numberParts = (v: string) => { const m = /^\s*(\D*?)0*(\d+)\s*([.)]?)\s*$/.exec(v); return m ? { pre: m[1], n: +m[2], post: m[3] } : null; };
/** words that say nothing of what a question is about */
const FILLER = new Set('a an and any are as at be by can did do does for from has have how in is it its of on or please provide the their there this to was what when where which who why will with you your'.split(' '));
/** how alike two wordings are in the words that carry their meaning (shared words over all words): a question reworded a little still scores high */
export function overlap(a: string, b: string): number {
  const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !FILLER.has(w)));
  const x = words(a), y = words(b); if (!x.size || !y.size) return 0;
  let k = 0; for (const w of x) if (y.has(w)) k++; return k / (x.size + y.size - k);
}

/** A number must not undo the wording key's protection of distinct identifiers or marks. */
export function canMatchNumber(a: string, b: string): boolean {
  if (!exactIdentifiers(identifierSig(a), identifierSig(b))) return false;   // Tranche II is not Tranche IV (#125)
  if (key(a) !== key(b) && misreadKey(a) !== misreadKey(b)
    && identifierCollisionKey(a) === identifierCollisionKey(b)) return false;
  return overlap(a, b) >= 0.6;
}

/** Roman identifiers are case-insensitive; ordinary words keep their existing number fallback. */
function identifierCollisionKey(text: string): string {
  const identifiers = text.normalize('NFKC').replace(QUESTION_WORD, collisionWord);
  return misreadKey(identifiers.replace(/[I|]/g, 'l')).replace(/\p{M}/gu, '');
}

/** A word as the collision key reads it: a lone I, i, l or | is L, whichever word it is (#127); i in a numeral is l. */
function collisionWord(word: string): string {
  if (/^[Iil|]$/.test(word)) return 'L';
  return ROMAN_NUMERAL.test(word) ? word.replace(/i/gi, 'l') : word;
}

/** a word or number of a question; a point or comma inside a number stays in it ("I.1", "1,500") */
const QUESTION_TOKEN = /[\p{L}\p{M}\p{N}|]+(?:[.,][\p{L}\p{M}\p{N}|]+)*/gu;

/**
 * The identifiers a question names, as they are compared (#125, #127, #128): anything with a digit, a Roman numeral in
 * capitals, a single capital letter, a code of up to five capitals, and a letter or numeral in parentheses or after a
 * naming word ("(a)", "class b", "tranche ii"). Sorted, so two lists compare in one walk.
 */
export function identifiers(text: string): string[] {
  return identifiersIn(normalizeReferences(text.normalize('NFKC'))).ids;
}

/** The identifiers a normalized text names, and the open ones: a lone letter after a point that may be a word (#778) */
function identifiersIn(text: string): { ids: string[]; open: string[] } {
  const ids: string[] = [];
  const open: string[] = [];
  const setApart = setApartParts(text);
  for (const match of text.matchAll(QUESTION_TOKEN)) {
    const found = setApart.get(match.index);
    const part = found?.length === match[0].length ? found : undefined;   // not a longer token such as a,500
    const form = part ? part.id : identifierForm(match[0], match.index, text);
    if (form === undefined) continue;
    (part?.droppable ? open : ids).push(form);
  }
  return { ids: ids.sort(), open: open.sort() };
}

/**
 * A word as an identifier, or undefined for an ordinary word. A lone I, i, l or | before a lowercase word is the word
 * "I" however it was read ("I understand", "can I send"), unless a naming word comes before it ("Class I shares").
 */
function identifierForm(token: string, offset: number, text: string): string | undefined {
  if (isNamedChain(token, offset, text)) return token.toLowerCase();   // clause 4.b, clause IV.II
  if (/\p{N}/u.test(token)) return numberForm(token);
  if (namedLetter(token, offset, text)) return token.toLowerCase();
  if (/^[Iil|]$/.test(token) && /^\s*\p{Ll}/u.test(text.slice(offset + 1))) return undefined;   // the word I
  const capitals = /^\p{Lu}+$/u.test(token);
  if (capitals && (token.length <= 5 || ROMAN_NUMERAL.test(token))) return token.toLowerCase();
  return undefined;
}

/**
 * A single letter or a Roman numeral in parentheses ("(a)", "( iv )"), or after a naming word ("class b", "part e"),
 * alone or after a number ("clause 4 a"). Not before one: "a schedule" is an article.
 */
function namedLetter(token: string, offset: number, text: string): boolean {
  if (!/^\p{L}$/u.test(token) && !ROMAN_NUMERAL.test(token)) return false;
  const before = text.slice(Math.max(0, offset - 30), offset);
  const after = text.slice(offset + token.length, offset + token.length + 30);
  if (/\(\s*$/.test(before) && /^\s*\)/.test(after)) return true;
  const named = (word: string | undefined) => !!word && NAMING_WORDS.has(word.toLowerCase());
  return named(/(\p{L}+)[\s\-:]+(?:[\p{N}.]+[\s\-:.]*)?$/u.exec(before)?.[1]);
}

/**
 * A number as an identifier: a letter read for a digit in it, or an l or | before it, is that digit (l00, 2O24, I00,
 * O.5). An I, l, | or O before a single digit, or an I, l or | before a point and a digit, is a letter, read alike
 * however it was scanned: Facility I1 is Facility l1, but not Facility 11, nor O1 01, nor I.1 1.1 (#128).
 */
function numberForm(token: string): string {
  const lead = /^(?:[IOol|]\d|[Il|]\.\d)(?![\d.,])/.test(token) ? token[0] : '';
  const letter = lead === '' ? '' : /[Oo]/.test(lead) ? 'o' : 'i';
  const digits = token.slice(lead.length)
    .replace(/[lI|](?=[\d.,])|(?<=[\d.,])[lI|]/g, '1')
    .replace(/[oO](?=[\d.,])|(?<=[\d.,])[oO]/g, '0');
  return letter + digits.toLowerCase();
}

/**
 * What two wordings' identifiers are compared on: the identifiers, and the words with only case, spacing and
 * punctuation taken out, which say the same whenever the identifiers do ("FY 2024" and "FY2024", "SPA" and "spa").
 * A point or comma inside a number stays: Section 1.10 is not Section 11.0.
 */
export interface IdentifierSig { plain: string; ids: string[]; open: string[] }
export function identifierSig(text: string): IdentifierSig {
  const normal = normalizeReferences(text.normalize('NFKC'));
  const plain = normal.toLowerCase().replace(/[^\p{L}\p{M}\p{N}.,]|(?<!\p{N})[.,]|[.,](?!\p{N})/gu, '');
  return { plain, ...identifiersIn(normal) };
}

/**
 * Whether two wordings can be one question as far as their identifiers go: not when each names one the other does not
 * (Class I and Class L, Facility I1 and Facility 11). One that only adds an identifier, or drops one, is a rewording.
 * An open identifier counts as named, so the rewording rule never needs it to be a word.
 */
export function sameIdentifiers(a: IdentifierSig, b: IdentifierSig): boolean {
  if (a.plain === b.plain) return true;
  const named = (sig: IdentifierSig) => [...sig.ids, ...sig.open];
  return !(namesOther(named(a), named(b)) && namesOther(named(b), named(a)));
}
/**
 * Whether two wordings name exactly the same identifiers, for a match by number alone: there the words differ, and a
 * row that adds or drops an identifier (Tranche II) may be another question, so it is a question of its own (#125).
 * An open identifier ("each item. I understand") is a word unless the other wording names it too; open ones of both
 * wordings that the other lacks are two different references ("class. a" and "class. i"), not two words.
 */
export function exactIdentifiers(a: IdentifierSig, b: IdentifierSig): boolean {
  if (a.plain === b.plain) return true;
  const reads = (sig: IdentifierSig) => [...sig.ids, ...sig.open];
  const droppedA = namesOther(a.open, reads(b));
  const droppedB = namesOther(b.open, reads(a));
  if (droppedA && droppedB) return false;
  return !namesOther(a.ids, reads(b)) && !namesOther(b.ids, reads(a));
}
/** whether `ids` names an identifier, counted with its repeats, that `others` does not */
function namesOther(ids: readonly string[], others: readonly string[]): boolean {
  const left = new Map<string, number>();
  for (const id of others) left.set(id, (left.get(id) ?? 0) + 1);
  return ids.some((id) => {
    const count = left.get(id) ?? 0;
    left.set(id, count - 1);
    return count <= 0;
  });
}

/**
 * The rows a wording pass of `matchRows` looks in, for a question of wording key `k`, number `n` and party `p`, last
 * written to the log as party `was`: its own number, its party, the party last written, then a row naming no one.
 */
function wordingList(pass: 'own' | 'party' | 'was' | 'blank', k: string, n: number, p: string, was: string) {
  if (pass === 'own') return `n\0${k}\0${n}`;
  if (pass === 'party') return p ? `p\0${k}\0${p}` : undefined;
  if (pass === 'was') return p && was && was !== p ? `p\0${k}\0${was}` : undefined;
  return p ? `p\0${k}\0` : `k\0${k}`;
}

/**
 * Which row of the log stands for each question: the row with the same words, failing that the row with its number; each
 * row stands for one question. By question id, the row's index in `table.rows`.
 */
export function matchRows(table: Pick<ReadTable, 'rows'>, mapping: Mapping, questions: Question[], sent: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map()): Map<string, number> {
  const cell = (r: string[], k: ImportField) => (mapping[k] == null ? '' : String(r[mapping[k]!] ?? ''));
  const taken = new Set<number>(); const rowOf = new Map<string, number>();
  const numOf = (r: string[]) => numberParts(cell(r, 'n'))?.n;
  // Each row's wording key, number and party are worked out once, and the rows are looked up by them, so a log of
  // thousands of rows, many in the same words, is matched in a moment (deals run to 2,000 questions).
  // Same words always share a wording key.
  // Party (rows are matched on everything available, the party included): a row whose
  // Submitted by names a party is never another party's question (capitals, spaces and a final period aside), so a log
  // sorted or renumbered by party outside the app never has one party's response written into another's row. A row or a
  // question naming no one matches either way, after the rows of the question's own party.
  const keyOf = table.rows.map((r) => misreadKey(cell(r, 'text')));
  const partyOf = table.rows.map((r) => key(cell(r, 'askedBy')));
  const qParty = (q: Question) => key(q.askedBy);
  // the party the app last wrote into the log for a question: its row still names it after a person corrects the party in
  // the app, and is still that question's row (the update then writes the new name into it)
  const sentParty = (q: Question) => key(sent.get(q.id)?.askedBy ?? '');
  const sameParty = (i: number, q: Question) => !partyOf[i] || !qParty(q) || partyOf[i] === qParty(q) || (!!sentParty(q) && partyOf[i] === sentParty(q));
  // lists of rows in the log's order, each walked past the rows already taken
  const lists = new Map<string, { rows: number[]; at: number }>();
  const add = (k: string, i: number) => { const l = lists.get(k); if (l) l.rows.push(i); else lists.set(k, { rows: [i], at: 0 }); };
  const byNumber = new Map<number, number[]>();
  table.rows.forEach((r, i) => {
    if (!cell(r, 'text').trim()) return;
    const n = numOf(r); add(`k\0${keyOf[i]}`, i); add(`p\0${keyOf[i]}\0${partyOf[i]}`, i);
    if (n !== undefined) { add(`n\0${keyOf[i]}\0${n}`, i); const l = byNumber.get(n); if (l) l.push(i); else byNumber.set(n, [i]); }
  });
  const firstFree = (k: string, ok: (i: number) => boolean = () => true) => { const l = lists.get(k); if (!l) return; while (l.at < l.rows.length && taken.has(l.rows[l.at])) l.at++; for (let j = l.at; j < l.rows.length; j++) if (!taken.has(l.rows[j]) && ok(l.rows[j])) return l.rows[j]; };
  const take = (q: Question, i: number | undefined) => { if (i !== undefined) { taken.add(i); rowOf.set(q.id, i); } };
  // by the words first, so a log renumbered by the counterparty still lines up: a row of the same words with the
  // question's own number first (so an earlier question of those words never takes the row that names another's number),
  // then a row of its own party, then a row naming no one (any row, for a question naming no one)
  // (a row still naming the party the app last wrote for a question is tried only once every question has had its own
  // party's rows, so it never takes another question's row)
  // a row of the question's words that names another identifier is not its row (#127, #128)
  const rowSigs = table.rows.map((r) => identifierSig(cell(r, 'text')));
  for (const pass of ['own', 'party', 'was', 'blank'] as const) for (const q of questions) {
    if (rowOf.has(q.id)) continue;
    const list = wordingList(pass, misreadKey(q.text), q.n, qParty(q), sentParty(q));
    const sig = identifierSig(q.text);
    const fits = (i: number) => (pass !== 'own' || sameParty(i, q)) && sameIdentifiers(rowSigs[i], sig);
    take(q, list === undefined ? undefined : firstFree(list, fits));
  }
  // then by number, but only a row of the question's party whose meaningful words are mostly the question's (in doubt,
  // no match: the question gets a row of its own): the counterparty's own question 4 is not the app's question 4
  for (const q of questions) {
    if (rowOf.has(q.id)) continue;
    take(q, (byNumber.get(q.n) ?? []).find((i) => !taken.has(i) && sameParty(i, q)
      && canMatchNumber(cell(table.rows[i], 'text'), q.text)));
  }
  return rowOf;
}

/**
 * What the log holds for each question it has a row for, field by field, as written, where the app already says the same
 * (as logWrite judges it): when a file becomes the deal's log this is recorded as what the app last wrote, so the next
 * update brings those cells up to date with what a person changes in the app. A cell that says something else (a file
 * imported as new questions beside the app's own) is not the app's: it stays theirs, and an update keeps it.
 */
export function logHolds(table: Pick<ReadTable, 'rows'>, mapping: Mapping, questions: Question[]): Record<string, Record<string, string>> {
  const rows = table.rows; const width = Math.max(0, ...rows.map((r) => r.length));
  const w = logWrite({ rows, cols: Array.from({ length: width }, (_, i) => i), lines: rows.map((_, i) => i + 2), lastRow: rows.length + 1 }, mapping, questions);
  const out: Record<string, Record<string, string>> = {};
  for (const [id, i] of matchRows(table, mapping, questions)) {
    const now: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.sent[id] ?? {})) { const c = mapping[k as ImportField]; if (k !== 'n' && c != null && String(rows[i][c] ?? '').trim() && v === String(rows[i][c] ?? '')) now[k] = v; }   // only what the file holds, not what an update would fill in
    out[id] = now;
  }
  return out;
}

/**
 * The steps that bring `questions` into the log `table` was read from. A question is the log's row with the same words,
 * failing that the row with its number; each row stands for one question. `mapping` gives each field's column in `table`.
 * `sent`: what the app last wrote into the log, by question id and field.
 */
export function logWrite(table: Pick<ReadTable, 'rows' | 'lines' | 'cols' | 'lastRow'>, mapping: Mapping, questions: Question[], sent: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map()): LogWrite {
  const col = (k: ImportField) => (mapping[k] == null ? null : table.cols[mapping[k]!] ?? null);
  const cell = (r: string[], k: ImportField) => (mapping[k] == null ? '' : String(r[mapping[k]!] ?? ''));
  const out: LogWrite = { steps: [], added: 0, answered: 0, updated: 0, kept: [], keptFields: {}, keptText: {}, sent: {}, taken: {} };
  const rowOf = matchRows(table, mapping, questions, sent);
  const fresh = questions.filter((q) => !rowOf.has(q.id));
  // new rows are numbered as the log numbers its own: "Q4", "4.", "#4" or plain 4
  const style = table.rows.map((r) => numberParts(cell(r, 'n'))).find((x) => x) ?? { pre: '', post: '' };
  // each row as the import reads it (dates, statuses and priorities in the app's terms), so a cell written another way
  // ("11/12/2026", "Outstanding", "H") that says what the app holds is not taken for a change
  const read = new Map(prepareImport(table.rows, mapping, table.rows.map((_, i) => i)).rows.map((r) => [r.line!, r] as const));
  // a value as the import reads it against the app's: a status or priority in the app's terms, whatever case it is written in
  const same = (k: ImportField, a: string, b: string) => (k === 'status' || k === 'priority' ? a.toLowerCase() === b.toLowerCase() : deMinimis(a, b));
  const sameAs = (k: ImportField, i: number, v: string) => { const r = read.get(i) as ImportRow | undefined; const was = r ? String((r as unknown as Record<string, unknown>)[k] ?? '') : cell(table.rows[i], k); if (k === 'n') return numberParts(cell(table.rows[i], 'n'))?.n === Number(v);
    if ((k === 'received' || k === 'responded') && !was && cell(table.rows[i], k).trim()) return true;   // a date the import could not settle (11/02 either way) is left as the log writes it
    return same(k, was, v) || deMinimis(cell(table.rows[i], k), v); };
  // a log cell's value as the import reads it ("11/12/2026" as 2026-11-12, "Outstanding" as open), else as written
  const readAs = (k: ImportField, i: number) => { const r = read.get(i) as ImportRow | undefined; return r ? String((r as unknown as Record<string, unknown>)[k] ?? '') : ''; };
  for (const q of questions) {
    const i = rowOf.get(q.id); if (i === undefined) continue;
    const r = table.rows[i]; const before = sent.get(q.id) ?? {}; const now: Record<string, string> = {}; let filled = false, changed = false, theirs = false;
    for (const k of FIELDS) {
      const c = col(k); if (c == null) continue; const v = cellValue(q, k); const has = cell(r, k);
      if (k === 'n') { if (has.trim()) now.n = has; continue; }                       // a row keeps the number the log gave it
      // a value the app never wrote is skipped; one it cleared after writing it clears the log's too (#39)
      if (!v.trim() && before[k] === undefined) continue;
      if (sameAs(k, i, v)) { now[k] = has; continue; }                                 // the log says it already, its own way: kept as the log writes it
      // the cell still holds what the app last put there, as written or as the import reads it
      const ours = before[k] !== undefined && (deMinimis(has, before[k]) || (!!readAs(k, i) && same(k, readAs(k, i), before[k])));
      // someone changed it in the log; where the app still holds what it last sent, only the log changed: the app takes it
      if (has.trim() && !ours && before[k] !== undefined && (deMinimis(v, before[k]) || same(k, v, before[k]))) { (out.taken[q.id] ??= {})[k] = has; now[k] = has; continue; }
      if (has.trim() && !ours) { theirs = true; (out.keptFields[q.id] ??= []).push(k); (out.keptText[q.id] ??= {})[k] = has; if (before[k] !== undefined) now[k] = before[k]; continue; }   // someone else's: never overwritten
      // a blank Priority stays blank: the app's High on a question that came in with none is its default, not a value anyone gave
      if (k === 'priority' && !has.trim() && v === 'High' && before[k] === undefined) continue;
      out.steps.push({ kind: 'cell', row: table.lines[i] - 1, col: c, value: v, ...dated(k) }); now[k] = v;
      if (k === 'response' && !has.trim()) filled = true; else changed = true;
    }
    out.sent[q.id] = now;
    if (filled) out.answered++; else if (changed) out.updated++;
    if (theirs) out.kept.push(q.n);
  }
  if (fresh.length) {
    const last = table.lastRow - 1;                                                   // new rows go below the last row the log uses, styled like it
    out.steps.push({ kind: 'rows', after: last, count: fresh.length });
    fresh.sort((a, b) => a.n - b.n).forEach((q, j) => {
      const now: Record<string, string> = {};
      for (const k of FIELDS) { const c = col(k); const v = k === 'n' ? (style.pre || style.post ? `${style.pre}${q.n}${style.post}` : q.n) : cellValue(q, k); if (c != null && v !== '') { out.steps.push({ kind: 'cell', row: last + 1 + j, col: c, value: v, ...dated(k) }); now[k] = String(v); } }
      out.sent[q.id] = now;
    });
    out.added = fresh.length;
  }
  return out;
}

/**
 * A question's cells as the log writes them, in the app's terms, as the import reads them: a status of "Outstanding" as
 * open, a date of 11/20/2026 as 2026-11-20. A cell the import cannot read stays as written. `today` settles a date
 * written without its year, as the import does.
 */
export function readLogCells(q: Question, cells: Record<string, string>, today?: string): Record<string, string> {
  const keys = Object.keys(cells) as ImportField[]; if (!keys.length) return {};
  const cols: ImportField[] = keys.includes('text') ? keys : [...keys, 'text'];   // a row is read only with its question
  const mapping = Object.fromEntries(IMPORT_FIELDS.map(([k]) => [k, cols.indexOf(k) < 0 ? null : cols.indexOf(k)])) as Mapping;
  const read = prepareImport([cols.map((k) => cells[k] ?? q.text)], mapping, [2], today ? { today } : {}).rows[0] as unknown as Record<string, unknown> | undefined;
  return Object.fromEntries(keys.map((k) => [k, read?.[k] == null || read[k] === '' && cells[k].trim() ? cells[k] : String(read[k])]));
}
/** whether a question's field already says `value` (in the app's terms, as readLogCells gives it); words as deMinimis compares them */
export function holds(q: Question, k: string, value: string): boolean {
  const app = String((q as unknown as Record<string, unknown>)[k] ?? '');
  return k === 'status' || k === 'priority' || k === 'received' || k === 'responded' ? app.toLowerCase() === value.trim().toLowerCase() : deMinimis(app, value);
}
