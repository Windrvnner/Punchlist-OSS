// What must never appear in commits, pull requests, issues, comments, docs, or code: AI-tool attribution trailers
// and headers, and links to AI chat sessions. A coding tool's plain "Generated with" footer is allowed: the tool's
// name, with at most a link to its product page (#729). The repository check (check-attribution.mjs) and other
// checks use this list. Patterns work as JavaScript regular expressions and as `git grep -E` (extended) patterns,
// matched ignoring case. Some are written in pieces so this file does not match its own check.
const NAMES = 'Cla' + 'ude|Anthropic|ChatGPT|Copilot|Gemini|Cursor|Sonnet|Opus|Haiku';
const CODING_AGENT = 'Cod' + 'ex';
// The contributor's own coding-agent identity, allowed as a co-author name (#877).
const OWN_AGENT_PREFIX = 'Windrvnner-';

/**
 * What may come just before the coding agent's name in a co-author trailer for it to count as AI attribution: any
 * character but a hyphen, a letter, a digit, or `_`, or a hyphenated prefix other than OWN_AGENT_PREFIX itself.
 * Spelled out letter by letter because `git grep -E` has no lookbehind. `<` is left out everywhere so the match stays
 * in the trailer's name, before its email address.
 */
function notOwnAgentPrefix() {
  const endings = [];
  for (let length = 1; length < OWN_AGENT_PREFIX.length; length += 1) {
    const kept = OWN_AGENT_PREFIX.slice(-length);
    endings.push(`[^<${OWN_AGENT_PREFIX.at(-length - 1)}]${kept}`);
  }
  return `([^-<A-Za-z0-9_]|${endings.join('|')}|[A-Za-z0-9_]${OWN_AGENT_PREFIX})`;
}

// Every path on the chat site except the product page itself: `code`, then only closing punctuation (or a slash),
// then the end of the line, a space, a tab, or a carriage return. Spelled out letter by letter because `git grep -E`
// has no lookahead. `]` is left out of the set because the two expression syntaxes escape it differently.
const CLOSING = ')>"\'/.,;:!_*';
const AFTER_PRODUCT_PAGE = ' \t\r' + CLOSING;
const NOT_PRODUCT_PAGE =
  '($|[^c]|c($|[^o])|co($|[^d])|cod($|[^e])|code[^' + AFTER_PRODUCT_PAGE + ']|code[' + CLOSING + ']+[^' +
  AFTER_PRODUCT_PAGE + '])';

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
  {
    name: 'an AI co-author trailer',
    pattern:
      '^[ >]*Co-Authored-By *:[^<]*(\\b(' + NAMES + ')\\b|' + notOwnAgentPrefix() + CODING_AGENT + '\\b)',
  },
  { name: 'an AI session trailer', pattern: '^[ >]*(' + 'Cla' + 'ude|Cod' + 'ex|AI)-Session *:' },
];
const COMPILED = AI_ATTRIBUTION_PATTERNS.map(({ name, pattern }) => ({ name, regex: new RegExp(pattern, 'i') }));

/**
 * The kinds of AI attribution a text holds, by name; empty when it holds none. Each line is matched on its own, as
 * `git grep` does, so a negated character set never reaches into the next line.
 */
export function aiAttributionIn(text) {
  const lines = text.split('\n');
  return COMPILED.filter(({ regex }) => lines.some((line) => regex.test(line))).map(({ name }) => name);
}
