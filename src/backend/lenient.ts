/**
 * Reading what a model sends back. Models are asked for one JSON object and often send something near it: a code fence
 * around it, words before or after, trailing commas, single or curly quotes, bare keys, a line break inside a string,
 * True and None, a reply cut off before its closing brackets, a bare list where an object was asked for. All of that is
 * read here, so that only a reply with nothing usable in it counts as a failed call.
 *
 * This is about form only. What a reply says is still checked by the caller: a citation must name a document that was
 * sent and a page it has, whatever shape it arrived in.
 */
import { jsonrepair } from 'jsonrepair';

export const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** JSON as written, or as repaired; undefined when neither can be read */
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { /* try it repaired */ }
  try { return JSON.parse(jsonrepair(text)); } catch { return undefined; }
}

/** every stretch of the reply that opens with `{` and closes at its own level, in order; quotes inside strings are respected */
function blocks(reply: string): string[] {
  const out: string[] = []; let depth = 0, start = -1, inString = false;
  for (let i = 0; i < reply.length; i++) {
    const ch = reply[i];
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { if (depth) inString = true; } else if (ch === '{') { if (!depth) start = i; depth++; } else if (ch === '}' && depth) { depth--; if (!depth) out.push(reply.slice(start, i + 1)); }
  }
  return out;
}

/**
 * The object in a reply. `keys` are the fields that were asked for: of the objects found, the first that has one of them
 * is the answer, so an aside in braces is not mistaken for it. A reply that is nothing but a list is taken as the
 * first key's list. A caller checking reply shape may ask for the first unkeyed object when no keyed answer was found.
 * Null when there is nothing to read.
 */
export function readJson(reply: string, keys: string[], allowUnkeyed = false): Record<string, unknown> | null {
  const text = String(reply ?? '').replace(/^﻿/, '').trim(); if (!text) return null;
  const fenced = [...text.matchAll(/```[a-zA-Z0-9]*\s*([\s\S]*?)(?:```|$)/g)].map((m) => m[1].trim()).filter(Boolean);
  // a reply that is a list and nothing else
  for (const whole of [text, ...fenced]) if (whole.startsWith('[')) { const v = parse(whole); if (Array.isArray(v)) return { [keys[0]]: v }; }
  const open = text.indexOf('{'); const close = text.lastIndexOf('}');
  const candidates = [...fenced.filter((f) => f.startsWith('{')), ...blocks(text), ...(open >= 0 && close > open ? [text.slice(open, close + 1)] : []), ...(open >= 0 ? [text.slice(open)] : [])];   // the last is a reply cut off before it closed
  let fallback: Record<string, unknown> | null = null;
  for (const c of candidates.filter((x, i, all) => all.indexOf(x) === i)) {
    const v = parse(c); if (!isObject(v)) continue;
    if (keys.some((k) => k in v)) return v;
    fallback ??= v;
  }
  return keys.length && !allowUnkeyed ? null : fallback;
}

/** The closed values at the root or in its lists, before repair can complete a cut-off row. */
function closedPrefix(text: string) {
  // Match complete strings first, so that brackets and escaped quotes inside them are ignored.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|["'{}\[\]]/g;
  const closing: Record<string, string> = { ']': '[', '}': '{' };
  const stack: string[] = [];
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token.length > 1) continue;
    if (token === '"' || token === "'") break;
    if (!closing[token]) {
      stack.push(token);
      continue;
    }
    if (stack.pop() !== closing[token]) break;
    if (stack.length <= 1 || (stack.length === 2 && stack.at(-1) === '[')) end = match.index + 1;
    if (!stack.length) break;
  }
  return text.slice(0, end);
}

/** Read only the structurally complete entries of a raw cut-off array or object. */
export function readCutJson(reply: string, keys: string[]): Record<string, unknown> | null {
  const fence = /^\s*```[a-zA-Z0-9]*\s*([\[{])/m.exec(reply);
  const line = /^[\t ]*[\[{]/m.exec(reply);
  const at = (match: RegExpExecArray | null) => match ? match.index + match[0].length - 1 : -1;
  const openings = [at(fence), reply.search(/[\[{]/), at(line)];
  for (const open of new Set(openings)) {
    if (open < 0) continue;
    const raw = parse(closedPrefix(reply.slice(open)));
    if (Array.isArray(raw) && raw.some(isObject)) return { [keys[0]]: raw };
    if (isObject(raw) && keys.some((key) => key in raw)) return raw;
  }
  return null;
}

/**
 * Whether a reply stops inside its JSON: some bracket of its last block is still open at the end (quotes inside strings
 * respected). A block is the first `{"` (or else the first `{`, or a `[` that leads the reply) and, once one has closed, any later `{"` or `[{`,
 * so that bracketed words or an aside before the answer do not hide a cut in the answer itself. A reply cut short by a
 * service that does not say so looks like this; `readJson` would still read what came before the cut, so the caller has
 * to ask about the rest (limits.ts).
 */
export function unfinished(reply: string): boolean {
  // words before the first block, between blocks and after the last one has closed are not looked at
  const text = String(reply ?? ''); const lead = /^\s*(```[a-zA-Z0-9]*\s*)?\[/.test(text); const keyed = text.search(/\{\s*"/); const start = lead ? text.indexOf('[') : keyed >= 0 ? keyed : text.indexOf('{'); if (start < 0) return false;   // an object with a key, so a stray { in words before it is passed over
  // counted twice, minding quotes and not: a stray quote in a whole reply (36" for inches) throws the first count off but
  // not the second, while a reply cut off leaves a bracket open in both
  let depth = 0, inString = false, bare = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (!depth) { if (i === start || /^(\{\s*"|\[\s*\{)/.test(text.slice(i, i + 40))) { depth = 1; bare = 1; } continue; }   // between blocks: only an object with a key, or a list of objects, opens another
    if (ch === '{' || ch === '[') bare++; else if ((ch === '}' || ch === ']') && bare) bare--;
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true; else if (ch === '{' || ch === '[') depth++; else if ((ch === '}' || ch === ']') && !--depth) bare = 0;   // it closed: this block is whole
  }
  // a closing bracket inside a string can balance the second count by chance: then a reply that does not end on one is cut off all the same
  return depth > 0 && (bare > 0 || !/[}\]]\s*(```)?\s*$/.test(text));
}

/** a list, whatever was sent: a list as it is, one thing as a list of one, nothing as an empty list */
export const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
/** the non-empty strings in a list, trimmed (handles, terms, search words); one string counts as a list of one */
export const strings = (x: unknown): string[] => (
  list(x).filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim())
);
/** the strings of a reply that say something, as given (edge spaces and tabs kept): text that is stored or shown */
export const prose = (x: unknown): string[] => (
  list(x).filter((s): s is string => typeof s === 'string' && !!s.trim())
);
/** a whole number given as a number or as its digits ("3", " 12 ", "3*"); null for anything else */
export function int(x: unknown): number | null {
  if (typeof x === 'number') return Number.isInteger(x) ? x : null;
  const m = typeof x === 'string' ? /^\s*(\d{1,9})\s*\*?\s*$/.exec(x) : null; return m ? +m[1] : null;
}
/** a page number: 12, "12", "p. 12", "page 12", or the first page of "12-14". A clause or section number is not a page. */
export function pageOf(x: unknown): number | null {
  if (typeof x === 'number') return Number.isInteger(x) ? x : null;
  const m = typeof x === 'string' ? /^\s*(?:pp?\.?|pages?)?\s*(\d{1,6})(?:\s*[-–—]\s*\d{1,6})?\s*$/i.exec(x) : null; return m ? +m[1] : null;
}
/** a word chosen from a few, however it was capitalized or spaced */
export const word = (x: unknown): string => (typeof x === 'string' ? x.trim().toLowerCase() : '');
/** the number in a tag like "E7", "e7", "[E7]", "E7: text" or plain 7; `letter` is its letter (#1162) */
export function tagNumber(x: unknown, letter: string): number | null {
  if (typeof x === 'number') return Number.isInteger(x) && x > 0 ? x : null;
  if (typeof x !== 'string') return null;
  const said = x.trim(); const tagged = new RegExp(`^\\W*(?:${letter}|doc(?:ument)?|item)\\s*#?\\s*(\\d{1,6})(?!\\d)`, 'i').exec(said) ?? /^\W*#?(\d{1,6})\W*$/.exec(said);   // a number with its letter, or a number and nothing else
  return tagged ? +tagged[1] : null;
}
/** what joins a reply's paragraphs for `fit` and splits them again afterwards: no white space of the model's is lost */
export const PARAGRAPH_SEAM = '\n\u0000\n';
