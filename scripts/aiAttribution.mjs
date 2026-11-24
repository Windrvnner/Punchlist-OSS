// What must never appear in commits, pull requests, issues, comments, docs, or code: AI-tool attribution trailers
// and headers, and links to AI chat sessions. A coding tool's plain "Generated with" footer is allowed: the tool's
// name, with at most a link to its product page (#729). The repository check (check-attribution.mjs) and other
// checks use this list. Patterns work as JavaScript regular expressions and as `git grep -E` (extended) patterns,
// matched ignoring case. Some are written in pieces so this file does not match its own check.
const NAMES = 'Cla' + 'ude|Anthropic|ChatGPT|Copilot|Gemini|Cursor|Sonnet|Opus|Haiku';
const CODING_AGENT = 'Cod' + 'ex';
// The repository's own coding-agent identity, the one co-author name for the agent that is allowed (#877).
const OWN_AGENT_PREFIX = 'Windrvnner-';

/**
 * The name part of a co-author trailer, from just after its colon, that names the coding agent as anything other
 * than exactly OWN_AGENT_PREFIX + the agent's name (#877). That is the agent's name after nothing but the colon or a
 * non-word character other than a hyphen, after a hyphenated prefix that is not OWN_AGENT_PREFIX, after
 * OWN_AGENT_PREFIX with anything but spaces before it, or the exact name with more after it than spaces or an email.
 * Spelled out letter by letter because `git grep -E` has no lookbehind or lookahead. `<` is left out everywhere so
 * the match stays in the name, before its email address.
 */
function codingAgentNameOtherThanOwn() {
  const agent = `${CODING_AGENT}\\b`;
  const forms = [`([^<]*[^-<A-Za-z0-9_])?${agent}`];
  for (let length = 1; length < OWN_AGENT_PREFIX.length; length += 1) {
    const kept = OWN_AGENT_PREFIX.slice(-length);
    forms.push(`([^<]*[^<${OWN_AGENT_PREFIX.at(-length - 1)}])?${kept}${agent}`);
  }
  forms.push(`[^<]*[^< \t][^<]*${OWN_AGENT_PREFIX}${agent}`);
  forms.push(`[ \t]*${OWN_AGENT_PREFIX}${CODING_AGENT}[ \t]*[^ \t\r<]`);
  return `(${forms.join('|')})`;
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
      '^[ >]*Co-Authored-By *:([^<]*\\b(' + NAMES + ')\\b|' + codingAgentNameOtherThanOwn() + ')',
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
