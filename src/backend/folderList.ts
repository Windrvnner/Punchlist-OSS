/**
 * Which folder of a data room a person means when they ask the chat to read or review one ("review the permits
 * folder"). Folders are compared by name as a person says them: case and punctuation aside, without "the" or
 * the word "folder", and with or without a leading number ("04. Permits" is "permits"). Nothing here asks a model.
 */

import { tokens } from './words';

/** a leading folder number ("04. ", "04.1 ", or "04 1 " once tokenized) */
const LEADING_NUMBER = /^\d+(?:[.\s]+\d+)*[.\s-]+/;

/** a folder's name as a person says it: lower case, without a leading number, "the" or the word "folder", spaces collapsed */
export const folderKey = (s: string) => plain(s).replace(LEADING_NUMBER, '').replace(/^the /, '').trim();
/**
 * a folder's name in the search index's words (letters of any alphabet), without "the" and the word "folder",
 * but with its number: "07. Permits" and "07 permits" are the same
 */
const plain = (s: string) => ` ${tokens(s).join(' ')} `
  .replace(/ folders? /g, ' ')
  .replace(/^ the /, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** every folder that holds a document, given the documents' paths from the data room ("VDR/Permits/A.pdf" gives "VDR" and "VDR/Permits") */
export function foldersOf(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/')); }
  return [...out];
}

/** a name as written: lower case, without a leading number, "the" or the word "folder"; punctuation such as "&" kept */
const asWritten = (s: string) => s.trim().toLowerCase().replace(LEADING_NUMBER, '').replace(/^the\s+/, '')
  .replace(/\s+folders?$/, '');

/**
 * The one folder whose last name is the name typed, compared as written (#1154): the words compare "O&M" and "OM" as
 * one, so a folder named exactly as typed wins over the other. Several equal names, or none, leave it to the words.
 */
const namedAsTyped = (dirs: string[], typed: string) => {
  const same = dirs.filter((d) => asWritten(d.split('/').at(-1)!) === asWritten(typed));
  return same.length === 1 ? same : [];
};

/**
 * The folders that a person's words name, among `dirs` (paths from the data room, "VDR/04. Permits/Environmental").
 * A folder matches when its last names are the ones said ("Permits", or "Permits/Environmental"); failing any, when its
 * own name has every word said ("environmental permits" finds "Permits - Environmental"). A folder inside another that
 * matches is left out, since it is read with it.
 */
export function matchFolders(dirs: string[], said: string): string[] {
  const parts = said.split(/\s*[/\\>]\s*/);
  /** the folders whose last names are the ones said, both compared by `key` */
  const ending = (key: (s: string) => string) => { const want = parts.map(key).filter(Boolean); return !want.length ? [] : dirs.filter((d) => { const k = d.split('/').map(key); return k.length >= want.length && want.every((w, i) => k[k.length - want.length + i] === w); }); };
  // a number said picks that folder alone ("07. Permits"), else any folder of that name with or without one; then by the words of its own name
  const numbered = parts.some((p) => /^\d/.test(plain(p)));
  const words = parts.map(folderKey).join(' ').split(' ').filter(Boolean);
  const byWords = () => (!words.length ? [] : dirs.filter((d) => { const own = plain(d.split('/').at(-1)!).split(' '); return words.every((w) => own.includes(w)); }));
  const typed = parts.length === 1 ? namedAsTyped(dirs, said) : [];
  const byName = () => [...(numbered ? [ending(plain)] : []), ending(folderKey)].find((x) => x.length) ?? byWords();
  const found = typed.length ? typed : byName();
  return found.filter((d) => !found.some((x) => x !== d && d.startsWith(`${x}/`))).sort();
}

/** whether a document's path is inside one of these folders */
export const inside = (path: string, dirs: string[]) => dirs.some((d) => path.startsWith(`${d}/`));
