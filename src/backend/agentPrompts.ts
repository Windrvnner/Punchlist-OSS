/**
 * What the chat agent (agent.ts) tells the models: its tools, as the JSON blocks of a reply (`inlineTools`) or as the
 * service's own function tools (`NATIVE_TOOLS` and `toolSpecs`), the prompts for a search and for a folder batch, and
 * the small text helpers its messages to the main session share.
 */
import type { ToolSpec } from './service';

/** a text on one line, its runs of white space made single spaces */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
/** a text cut to at most `max` characters, ending in "…" when it was cut */
export const shorten = (text: string, max: number) =>
  (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** a text as the agent's steps and messages quote it: on one line, in quotation marks, at most 80 characters */
export const quoted = (text: string) => `“${shorten(oneLine(text), 80)}”`;
/** a noun for a count: `many` when the count is not one */
export const noun = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);

const ROLE = 'You are researching a question about a project-finance deal from its data room, its findings and its Q&A '
  + 'log. You work in turns.';
const CITE_RULE = 'Cite only documents listed under "Documents opened so far", by their tag. A finding or a response '
  + 'from the Q&A log is not a document: say what it is in words and give it no marker.';
const SEARCH_HELP = 'A helper searches the documents by their words, file names and folder paths, opens the likeliest, '
  + 'and returns passages with document and page. "findings" and "qa" search the deal\'s findings and its questions '
  + 'and responses. Search in other words, or for a document by the name it is likely to have, when a search finds '
  + 'nothing useful.';
const readHelp = (width: number) => `Have up to ${width} documents attached to your next turn, by tag or by path, so `
  + 'that you can look through them yourself. Do this when the passages a search returned are not enough to answer.';
const FOLDER_WHEN = 'Have every document in a folder read, the most important first, when you are asked to read or '
  + 'review a folder, or when the answer needs all of a folder rather than a few documents from it.';
const FOLDER_NAMED = 'Name the folder as it is named in the data room, or as the question names it.';
const FOLDER_RESULT = 'You get what each batch of its documents says, with document and page. A large folder is read '
  + 'only once the person has agreed: you are told when to ask them, and then';

/** the tools as JSON blocks in the reply (`inline`): the system prompt of every turn */
export const inlineTools = (width: number) => [
  `${ROLE} Each turn, reply with one JSON object and nothing else, one of these:`,
  '{"tool": "search", "what": "documents" | "findings" | "qa" | "all", "query": "a few words to search for", '
    + '"notes": "what you have learned so far, with document and page"}',
  `  ${SEARCH_HELP}`,
  '{"tool": "read", "docs": ["D3", "D7"], "notes": "…"}',
  `  ${readHelp(width)}`,
  '{"tool": "folder", "folder": "Permits", "lookFor": "what to look for in it", "notes": "…"}',
  `  ${FOLDER_WHEN} ${FOLDER_NAMED} ${FOLDER_RESULT} add "all": true once they have.`,
  '{"text": "the answer, with [n] markers", "sources": [{"doc": "D3", "page": 12, "quote": "a few words from that '
    + 'page"}]}',
  `  Your answer, once you have what you need. ${CITE_RULE}`,
  '"notes" carry what you have learned from one turn to the next: only your notes and the results listed below are '
    + 'kept.',
].join('\n');

/** the same tools, called natively (`native` and `hybrid`): the model calls one each turn */
export const NATIVE_TOOLS = [
  `${ROLE} Each turn, call one tool: search, read, folder or answer.`,
  CITE_RULE,
  '"notes" carry what you have learned from one turn to the next.',
].join('\n');

const notes = { type: 'string', description: 'What you have learned so far, with document and page.' };
const text = (description: string) => ({ type: 'string', description });

/** one source of the answer tool */
const answerSource = {
  type: 'object',
  properties: {
    doc: text('The document\'s tag.'),
    page: { type: 'integer' },
    sheet: { type: 'string' },
    cell: { type: 'string' },
    quote: text('A few words from that page.'),
  },
  required: ['doc'],
};

/** the tools as the service's own function tools */
export const toolSpecs = (width: number): ToolSpec[] => [
  {
    name: 'search',
    description: SEARCH_HELP,
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['documents', 'findings', 'qa', 'all'] },
        query: text('A few words to search for.'),
        notes,
      },
      required: ['what', 'query'],
    },
  },
  {
    name: 'read',
    description: readHelp(width),
    parameters: {
      type: 'object',
      properties: { docs: { type: 'array', items: { type: 'string' }, description: 'Tags (D3) or paths.' }, notes },
      required: ['docs'],
    },
  },
  {
    name: 'folder',
    description: `${FOLDER_WHEN} ${FOLDER_RESULT} set "all" once they have.`,
    parameters: {
      type: 'object',
      properties: {
        folder: text('The folder, as it is named in the data room or as the question names it.'),
        lookFor: text('What to look for in it.'),
        all: { type: 'boolean', description: 'True once the person has agreed to have a large folder read whole.' },
        notes,
      },
      required: ['folder'],
    },
  },
  {
    name: 'answer',
    description: 'Your answer, once you have what you need, with [n] markers for its sources.',
    parameters: {
      type: 'object',
      properties: {
        text: text('The answer, with [n] markers.'),
        sources: { type: 'array', items: answerSource },
      },
      required: ['text', 'sources'],
    },
  },
];

/**
 * What a model reading documents is asked to find, for a question: `whose` names the documents ("these documents" or
 * "they"). A reply with nothing in it says they say nothing about it.
 */
export function findAsk(whose: string, about: string, question: string): string {
  return `Find what ${whose} say about: ${about}\nIt is wanted to answer this question: ${question}\n`
    + 'In "text", say in a few sentences what they say about it, citing each sentence, and quote the exact words in '
    + '"quote". If they say nothing about it, reply {"text": "", "sources": []}.';
}

/** what one batch of a folder read asks of the fast model; `first` and `last` are the batch's places in the folder */
export function batchAsk(at: { listing: string; first: number; last: number; count: number; label: string },
  lookFor: string, question: string): string {
  return `Documents:\n${at.listing}\n\nThese are documents ${at.first} to ${at.last} of the ${at.count} in `
    + `${at.label}, which is being read a batch at a time, the most important first. `
    + `${findAsk('they', lookFor, question)}\n`
    + 'Reply as JSON: {"text": "what they say, with [n] markers", "sources": [{"doc": "D3", "page": 2, "quote": "a '
    + 'few words from that page"}]}';
}
