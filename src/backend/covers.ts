/**
 * The model's check of an Already Asked? pair (#1218): whether an open question already asks for what an unresolved
 * point lacks. The prompt names each pair by a neutral tag and shows the texts only; the reply is a proposal that code
 * reads here: an answer counts only for a tag that was offered, named once, with true or false.
 */
import { list as listOf } from './lenient';

export type CoverPair = { point: string; question: string };

/** a text on one line, as the prompt shows it */
const oneLine = (text: string) => text.replace(/\s+/g, ' ');

/**
 * n tags of three consonants, different from each other, to name the pairs of one covers call: a pair has no record
 * id of its own, so each is named by a tag drawn at random, so they do not run in order, and with no vowel, so none is
 * a word
 */
export function tagsFor(n: number): string[] {
  const consonants = 'bcdfghjkmnpqrstvwxz';
  const seen = new Set<string>();
  while (seen.size < n) {
    seen.add(Array.from({ length: 3 }, () => consonants[Math.floor(Math.random() * consonants.length)]).join(''));
  }
  return [...seen];
}

/** The prompt for one part: each pair under its own tag. */
export function coversPrompt(tags: string[], pairs: CoverPair[]): string {
  const shown = pairs.map((pair, k) => {
    return `${tags[k]}:\nPoint: ${oneLine(pair.point)}\nQuestion: ${oneLine(pair.question)}`;
  });
  return [
    'Each pair below holds an unresolved point in the due diligence of a project-finance deal (a checklist item no',
    'document settles yet, or an open finding) and a question already asked of the counterparty. Say for each pair',
    'whether the question already asks for what the point lacks: whether the answer to it would settle the point.',
    'Say true only when it clearly would; a question on the same subject that asks for something else is false.',
    '',
    shown.join('\n\n'),
    '',
    `Reply as JSON: {"items": [{"id": "${tags[0]}", "covers": true}]}`,
  ].join('\n');
}

/**
 * The answers a reply gives, by place in the part: only a tag of this part, named once, with a true or false. The last
 * entry of a reply cut off is left out, as it may be cut short.
 */
export function readCovers(items: unknown, tags: string[], cut: boolean): Map<number, boolean> {
  const place = new Map(tags.map((tag, k) => [tag, k]));
  const named = (listOf(items) as { id?: unknown; covers?: unknown }[]).map((entry) => ({
    place: typeof entry?.id === 'string' ? place.get(entry.id.trim().toLowerCase()) : undefined,
    covers: entry?.covers,
  }));
  const kept = cut ? named.slice(0, -1) : named;
  const twice = new Set(kept.filter((x, j) => kept.findIndex((y) => y.place === x.place) !== j).map((x) => x.place));
  const answers = new Map<number, boolean>();
  for (const { place: k, covers } of kept) {
    if (k !== undefined && !twice.has(k) && typeof covers === 'boolean') answers.set(k, covers);
  }
  return answers;
}
