// What must never appear in tracked files or commit messages, beside AI-tool attribution (aiAttribution.mjs): a
// decision credited to a person ("the owner wants") and an email address. Example and no-reply addresses are allowed.
// The phrase is allowed right after a double quote, so the rule can quote it. JavaScript only: check-attribution.mjs
// is its one user.

const VERBS = 'wants?|wanted|asks?|asked|says|said|decides?|decided|prefers?|preferred|requested';
// Any run of spaces or a line break may separate the words, since docs are wrapped at 120 characters.
const ROLE_VERB = new RegExp(`(?<!")\\bthe\\s+(owner|maintainer|user)('s)?\\s+(${VERBS})\\b`, 'i');
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
// example.com, .org, .net and their subdomains, and GitHub's no-reply addresses.
const ALLOWED_DOMAIN = /(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com)$/i;
// The top-level names reserved for tests and examples (RFC 2606).
const RESERVED_TOP_LEVEL = /\.(test|example|invalid|localhost)$/i;
// Files written by a tool, not a person: the lockfile repeats third-party package notices.
const GENERATED_FILES = new Set(['package-lock.json']);

function hasPersonalEmail(text) {
  const personal = (domain) => !ALLOWED_DOMAIN.test(domain) && !RESERVED_TOP_LEVEL.test(domain);
  return [...text.matchAll(EMAIL)].some((match) => personal(match[1]));
}

/** The kinds of person attribution a text holds, by name; empty when it holds none. `file`: where it came from. */
export function personAttributionIn(text, file = '') {
  const found = [];
  if (ROLE_VERB.test(text)) found.push('a decision credited to a person');
  if (!GENERATED_FILES.has(file) && hasPersonalEmail(text)) found.push('an email address');
  return found;
}
