// What must never appear in commits, pull requests, issues, comments, docs, or code: AI-tool attribution trailers
// and headers, and links to AI chat sessions. A coding tool's plain "Generated with" footer is allowed: the tool's
// name, with at most a link to its product page (#729). The repository check (check-attribution.mjs) and other
// checks use this list. Patterns work as JavaScript regular expressions and as `git grep -E` (extended) patterns,
// matched ignoring case. Some are written in pieces so this file does not match its own check.
const NAMES = 'Cla' + 'ude|Anthropic|ChatGPT|Copilot|Cod' + 'ex|Gemini|Cursor|Sonnet|Opus|Haiku';
// Every path on the chat site except the product page itself, `code` followed by the end of the line, a space, a
// carriage return, or closing punctuation. Spelled out letter by letter because `git grep -E` has no lookahead.
const NOT_PRODUCT_PAGE = '($|[^c]|c($|[^o])|co($|[^d])|cod($|[^e])|code[^ )>"\',.\r]|code[,.][^ \r])';

export const AI_ATTRIBUTION_PATTERNS = [
  {
    name: 'a link to an AI chat or session site',
    pattern: '(^|[^A-Za-z0-9.-])(www\\.)?' + 'claude\\.ai/' + NOT_PRODUCT_PAGE,
  },
  {
    name: 'an AI chat share link',
    pattern: '(chatgpt\\.com|chat\\.openai\\.com)/(share|c)/|gemini\\.google\\.com/(share|app)/',
  },
  { name: 'a hidden attribution comment', pattern: 'claude-projects-' + 'attribution' },
  { name: 'a "requested by" header', pattern: '^[ >_]*Requested by +\\*\\*' },
  { name: 'an AI co-author trailer', pattern: '^[ >]*Co-Authored-By *:[^<]*\\b(' + NAMES + ')\\b' },
  { name: 'an AI session trailer', pattern: '^[ >]*(' + 'Cla' + 'ude|Cod' + 'ex|AI)-Session *:' },
];

/** The kinds of AI attribution a text holds, by name; empty when it holds none. */
export function aiAttributionIn(text) {
  return AI_ATTRIBUTION_PATTERNS.filter(({ pattern }) => new RegExp(pattern, 'im').test(text)).map(({ name }) => name);
}
