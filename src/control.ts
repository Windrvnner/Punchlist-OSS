/**
 * The control file: every value an end user may change, in one place, like the inputs tab of a model.
 *
 * Each value sits beside a one-line note and the range it may take. The app checks every value when it starts
 * (`assertControl`, called by the shell, the desktop main process and `composeBackend`), and so does the build, so a
 * typo stops the app with a message naming the value instead of running on it. Changing a value means rebuilding.
 *
 * This file imports nothing, so any layer may read it. Code reads the plain values from `control`, never the notes.
 * The three base colors are worked out into every color of the app in src/palette.ts. Windows High Contrast is not
 * here: in it, colors come from the system (the forced-colors block in src/styles.css).
 */

/** One value: what it is now, a one-line note for whoever edits it, and what is wrong with a value outside its range
 * (null when fine). */
interface Entry<T> { value: T; note: string; problem(v: T): string | null }   // a method, so any Entry<T> counts as an Entry<unknown>

// ---- the kinds of value, each with its allowed range ---------------------------------------------------------------

/** a whole number from `min` to `max` */
const count = (value: number, note: string, min: number, max: number): Entry<number> => ({
  value, note, problem: (v) => Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}`,
});
const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** how a span of time is said in a message: "15 minutes", "5 seconds" */
const span = (ms: number) => ms % DAY === 0 ? `${ms / DAY} days` : ms % HOUR === 0 ? `${ms / HOUR} h` : ms % MINUTE === 0 ? `${ms / MINUTE} min` : `${ms / SECOND} s`;
/** a span of time in milliseconds, from `min` to `max` */
const time = (value: number, note: string, min: number, max: number): Entry<number> => ({
  value, note, problem: (v) => Number.isInteger(v) && v >= min && v <= max ? null : `must be a time in milliseconds from ${span(min)} to ${span(max)}`,
});
/** text of `min` to `max` characters, with no spaces at either end */
const text = (value: string, note: string, min: number, max: number, also?: (v: string) => string | null): Entry<string> => ({
  value, note, problem: (v) => typeof v !== 'string' || v.length < min || v.length > max ? `must be text of ${min} to ${max} characters` : v.trim() !== v ? 'must not start or end with a space' : also?.(v) ?? null,
});
/** one of a few choices */
const choice = <T extends string>(value: T, note: string, allowed: readonly T[]): Entry<T> => ({
  value, note, problem: (v) => allowed.includes(v) ? null : `must be one of ${allowed.map((a) => `'${a}'`).join(', ')}`,
});
/** on or off */
const flag = (value: boolean, note: string): Entry<boolean> => ({ value, note, problem: (v) => typeof v === 'boolean' ? null : 'must be true or false' });
/** a name shown on screen; never stops the app: a value that cannot be shown is replaced by the default (see `shownName`) */
const label = (value: string, note: string): Entry<string> => ({ value, note, problem: () => null });
/** a web address of the form https://host (no path), or '' while it is not set */
const site = (value: string, note: string): Entry<string> => ({
  value, note, problem: (v) => {
    if (v === '') return null;
    try { const u = new URL(v); return u.protocol === 'https:' && u.origin === v ? null : 'must be https:// and a host name only, with no path or slash at the end, like https://north.example.com'; }
    catch { return 'must be a web address like https://north.example.com, or empty while not set'; }
  },
});
/** a full https:// web address (a path is fine), or '' while it is not set */
const link = (value: string, note: string): Entry<string> => ({
  value, note, problem: (v) => {
    if (v === '') return null;
    try { return new URL(v).protocol === 'https:' ? null : 'must start with https://'; } catch { return 'must be a web address starting with https://, or empty while not set'; }
  },
});
/** a list of words or phrases, each written once; `also` checks each entry further (null when fine) */
const words = (value: string[], note: string, min: number, max: number, also?: (w: string) => string | null): Entry<string[]> => ({
  value, note, problem: (v) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) return `must list ${min} to ${max} entries`;
    const bad = v.find((w) => typeof w !== 'string' || !w.trim() || w.trim() !== w); if (bad !== undefined) return typeof bad === 'string' ? `has an empty entry or one with spaces at an end: '${bad}'` : `has an entry that is not text: ${String(bad)}`;
    const seen = new Set<string>(); for (const w of v) { const k = w.toLowerCase(); if (seen.has(k)) return `lists '${w}' twice`; seen.add(k); }
    for (const w of v) { const p = also?.(w); if (p) return p; }
    // a pick list also refuses two that read as one ("Légal" and "Legal"), which would show side by side
    if (also) for (let i = 0; i < v.length; i++) for (let j = 0; j < i; j++) if (same(v[i], v[j])) return `lists '${v[j]}' and '${v[i]}', which read as one`;
    return null;
  },
});
/**
 * single words too ordinary to stand for a thing in the synonyms library (they may sit inside a phrase). 'licence' here
 * and in instrumentWords is the UK spelling on purpose: other parties' documents use it, and they must still match.
 */
const ORDINARY = ['consent', 'letter', 'policy', 'model', 'case', 'rights', 'security', 'charge', 'approval', 'memorandum', 'account', 'sheet', 'agreement', 'contract', 'report', 'lease', 'permit', 'license', 'licence', 'certificate', 'opinion', 'insurance', 'notice', 'schedule'];
/** abbreviations with more than one common meaning in project finance, left out of the library (a deal's own paths can still spell one out) */
const AMBIGUOUS = ['TSA', 'DA', 'CTA', 'APA', 'BOP', 'MRA', 'LMA', 'REC', 'ITC', 'IE', 'LC', 'CP', 'FA', 'EP', 'HoT'];
/** groups of names for one thing (the synonyms library): each name in one group at most, no ordinary single word, no abbreviation known to mean two things */
const groups = (value: string[][], note: string, ordinary: readonly string[], ambiguous: readonly string[]): Entry<string[][]> => ({
  value, note, problem: (v) => {
    if (!Array.isArray(v)) return 'must list groups of names';
    const seen = new Map<string, number>(); const plain = new Set(ordinary.map((w) => w.toLowerCase())); const twoWays = new Set(ambiguous);
    for (const [i, g] of v.entries()) {
      if (!Array.isArray(g) || g.length < 2) return `group ${i + 1} must list two names or more`;
      for (const w of g) {
        if (typeof w !== 'string' || !w.trim() || w.trim() !== w) return `group ${i + 1} has an empty name or one with spaces at an end`;
        const k = w.toLowerCase(); if (seen.has(k)) return `'${w}' is in group ${seen.get(k)! + 1} and group ${i + 1}: a name may be in one group only`; seen.set(k, i);
        if (!/\s/.test(w) && plain.has(k)) return `'${w}' is an ordinary word: a group may hold it only within a phrase`;
        if (twoWays.has(w)) return `'${w}' means more than one thing in project finance and is left out`;
      }
    }
    return null;
  },
});
/** a name a person picks from a list: short enough for a pick list, on one line, and not the list's own "No …" option */
const pickName = (none: string) => (w: string) => w.length > 40 ? `has '${w}', longer than 40 characters` : /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff<>]/.test(w) ? `has '${w}', with a line break, an unseen or control character, or an angle bracket` : same(w, none) ? `must not list '${w}': the app shows it for a record with none` : null;
/** two names a person would read as one: case, accents and ligatures aside, as the pick lists sort them (src/domain/order.ts) */
const same = (a: string, b: string) => new Intl.Collator('en-US', { sensitivity: 'base' }).compare(a.normalize('NFKC'), b.normalize('NFKC')) === 0;
/** a base color, #rrggbb */
const color = (value: string, note: string): Entry<string> => ({ value, note, problem: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? null : 'must be a hex color like #2e4a63' });
/** a folder name Windows accepts */
const folderName = (v: string) => /[\\/:*?"<>|]/.test(v) || v === '.' || v === '..' ? 'must be a folder name: none of \\ / : * ? " < > |, and not . or ..' : null;

export type CloudProvider = 'gateway' | 'azure' | 'bedrock' | 'vertex';
export type ModelProvider = 'claude' | 'north' | 'openai' | CloudProvider;

const cloudProviders: readonly CloudProvider[] = ['gateway', 'azure', 'bedrock', 'vertex'];
export const isCloudProvider = (provider: ModelProvider): provider is CloudProvider =>
  cloudProviders.some((name) => name === provider);

/** API roots and OAuth endpoints may have paths, but must not carry credentials or query parameters. */
const endpoint = (note: string) => text('', note, 0, 500, (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (value.startsWith('https://') && !url.username && !url.password && !url.search && !url.hash) return null;
  } catch { /* the address is malformed */ }
  return 'must be an HTTPS address without credentials, a query or a fragment';
});

const uuidProblem = (value: string) => !value || /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  ? null : 'must be a UUID';
const awsRegionProblem = (value: string) => !value || /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(value)
  ? null : 'must be an AWS region such as us-east-1';

const modelTiers = {
  fast: text('', 'Model ID for fast sorting and search.', 0, 200),
  standard: text('', 'Model ID for answers and drafts.', 0, 200),
  thorough: text('', 'Model ID for the thorough fallback.', 0, 200),
};

// ---- the values -----------------------------------------------------------------------------------------------------

const SPEC = {
  firm: {
    name: text(
      '[firm name]',
      'The firm name: questions the firm asks and responses it gives are stamped with it, ' +
        'and the deal memo carries it. Not set in Settings.',
      1,
      80,
    ),
    workstreams: words(
      [
        'Technical', 'Legal', 'Commercial', 'Financial', 'Structure', 'Insurance', 'Tax', 'Regulatory & permits',
        'Real estate', 'HR & benefits', 'IT & cyber', 'Antitrust & FDI', 'Compliance', 'Environmental & social',
      ],
      'The workstreams a person and the model pick from, for findings and questions. Every list of them is A to Z ' +
        'whatever the order here, with "No workstream" last. A record keeps a name taken off this list.',
      1,
      40,
      pickName('No workstream'),
    ),
  },
  names: {
    service: label('Intelligence', 'What screens, messages and exports call the model service ("Intelligence sign-in", "Intelligence could not be reached"). Never a vendor\'s name. Empty or unusable: "Intelligence".'),
    aiContent: label('AI', 'What marks text the model wrote ("Drafted by AI", "AI draft, accepted by …", the AI tag, and the same in exports). Empty or unusable: "AI".'),
  },
  memo: {
    high: text(
      'Affects price, structure or whether the deal can close',
      'What a High risk means in the deal memo; ' +
        'the model rates each open finding against these three, not printed in the memo.',
      1,
      160,
    ),
    medium: text('Affects terms in the documents or the base case', 'What a Medium risk means in the deal memo.', 1, 160),
    low: text('No effect on terms', 'What a Low risk means in the deal memo.', 1, 160),
    keyRisks: count(8, 'Most High and Medium risks written out in the body of the deal memo; every High risk is, and the rest go to its appendix.', 1, 20),
  },
  north: {
    address: site('', "The North instance's address, like https://north.example.com. Empty until set."),
    ssoSite: site('', 'The exact site whose sign-in cookie the app takes as the North token. Empty until set.'),
    hostedTools: words([], "North's own tools, by their registry names, sent with the chat agent's tools in hybrid and native modes, so that North still reads the attached files: a call that lists tools does not use North's default tools. North's reference does not name them; `npm run ai:check -- north` lists the ones its agents show.", 0, 20),
  },
  openai: {
    address: link(
      '',
      "The OpenAI-compatible server's API root, like https://models.example.com/v1, for " +
        "models.service 'openai'. Empty until set.",
    ),
    api: choice<'responses' | 'chat'>('responses', "How the app asks that server: 'responses' (the Responses API, which keeps a chat's conversation on the server and reads documents of any kind by file id) or 'chat' (chat completions, for a server without it: the app keeps the conversation and resends it, and documents other than PDFs go in the message as text).", ['responses', 'chat']),
  },
  gateway: {
    address: endpoint('The organization’s OpenAI-compatible API root.'),
    api: choice<'responses' | 'chat'>('chat', 'The OpenAI-compatible inference API.', ['responses', 'chat']),
    authorize: endpoint('The organization’s OAuth authorization endpoint.'),
    token: endpoint('The organization’s OAuth token endpoint.'),
    clientId: text('', 'The public OAuth client ID.', 0, 300),
    scope: text('', 'The OAuth scope or scopes that grant gateway access, separated by spaces.', 0, 500),
    ...modelTiers,
  },
  azure: {
    address: endpoint('The Azure OpenAI Responses API root, ending in /openai/v1.'),
    tenant: text('', 'The Microsoft Entra directory tenant ID.', 0, 36, uuidProblem),
    clientId: text('', 'The Microsoft Entra public client application ID.', 0, 36, uuidProblem),
    ...modelTiers,
  },
  bedrock: {
    address: site('', 'The Bedrock Runtime HTTPS origin for the inference region.'),
    region: text('', 'The AWS region of the Bedrock Runtime endpoint.', 0, 32, awsRegionProblem),
    probeModel: text('', 'An in-region Claude model supporting CountTokens. Empty uses bedrock.standard.', 0, 200),
    ssoRegion: text('', 'The AWS region that hosts IAM Identity Center.', 0, 32, awsRegionProblem),
    startUrl: endpoint('The IAM Identity Center AWS access portal start URL.'),
    account: text('', 'The 12-digit AWS account ID assigned to the user.', 0, 12,
      (value) => !value || /^\d{12}$/.test(value) ? null : 'must be a 12-digit AWS account ID'),
    role: text('', 'The IAM Identity Center role or permission set assigned to the user.', 0, 64,
      (value) => !value || /^[\w+=,.@-]+$/.test(value) ? null : 'must be an AWS role name'),
    ...modelTiers,
  },
  vertex: {
    address: endpoint('The Vertex AI project and location URL, ending in /publishers/anthropic/models.'),
    clientId: text('', 'The Google Cloud Desktop app OAuth client ID.', 0, 300),
    ...modelTiers,
  },
  models: {
    service: choice<ModelProvider>(
      'claude',
      'The model service: direct Claude or OpenAI, North, a gateway, Azure OpenAI, Bedrock, or Vertex AI.',
      ['claude', 'north', 'openai', ...cloudProviders],
    ),
    northFast: text(
      '',
      "North's name for the fast model: the many cheap sorting jobs, and the search helper. Empty until set.",
      0,
      100,
    ),
    northStandard: text(
      '',
      "North's name for the standard model: answering, drafts, " +
        'confirming what the fast model flags. Empty until set.',
      0,
      100,
    ),
    northThorough: text(
      '',
      "North's name for the thorough model: used only after the standard model fails twice. Empty until set.",
      0,
      100,
    ),
    claudeFast: text('claude-haiku-5-5', 'The fast model on the Claude API.', 1, 100),
    claudeStandard: text('claude-sonnet-5-5', 'The standard model on the Claude API.', 1, 100),
    claudeThorough: text('claude-opus-5-5', 'The thorough model on the Claude API.', 1, 100),
    openaiFast: text('', "The OpenAI-compatible server's name for the fast model. Empty until set.", 0, 100),
    openaiStandard: text('', "Its name for the standard model. Empty until set.", 0, 100),
    openaiThorough: text('', "Its name for the thorough model. Empty until set.", 0, 100),
    toolCalls: choice<'inline' | 'hybrid' | 'native'>(
      'inline',
      "How the chat agent calls its tools: 'inline' (asked for as JSON in the reply; the default), 'hybrid' (the " +
        "service's own tool calls, each result sent back as a user message, for a service that rejects tool results) " +
        "or 'native' (tool calls and tool results both). A model that refuses one steps down to the next.",
      ['inline', 'hybrid', 'native'],
    ),
  },
  picker: {
    fast: flag(true, 'Offer Fast in the model picker (conversations, and Default model in Settings). The model behind it is models.claudeFast, models.northFast or models.openaiFast.'),
    standard: flag(true, 'Offer Standard in the model picker. The model behind it is models.claudeStandard, models.northStandard or models.openaiStandard.'),
    thorough: flag(true, 'Offer Thorough in the model picker. The model behind it is models.claudeThorough, models.northThorough or models.openaiThorough.'),
  },
  signIn: {
    sso: flag(true, "Offer single sign-on: available on North and the configured gateway or cloud providers."),
    apiKey: flag(true, 'Offer signing in with a provider API key or a North developer token.'),
  },
  blackline: {
    pipeline: choice<'A' | 'B'>(
      'A',
      "A: for a model that may not see a blackline's strike-through and colors. B: for one that does.",
      ['A', 'B'],
    ),
  },
  limits: {
    docsPerCall: count(
      8,
      'Documents given to one model call; a model reads only a handful of named documents well. ' +
        'A folder review reads this many at a time.',
      1,
      20,
    ),
    shortlist: count(100, 'Best-ranked documents the fast model picks a call\'s documents from.', 8, 1000),
    itemsPerCall: count(20, 'Checklist items checked in one call.', 1, 50),
    inputTokens: count(180_000, 'Most tokens one model call may send, documents included. Batches of items are '
      + 'sized to fit and a chat is compacted before it outgrows it. Documents are read by the service, so the app '
      + 'cannot count them: a call the service refuses as too long is asked again with fewer of its drafts\' tracked '
      + 'changes listed, while it lists any, then with fewer documents or items, whatever this says.',
      4_000, 2_000_000),
    outputTokens: count(32_000, 'Most tokens one model reply may hold. Sent with every call; work asked in batches is '
      + 'sized to fit, and a reply cut off anyway is asked again in smaller parts. A temporary hold until real reply '
      + 'sizes are measured (docs/decisions.md).', 1_000, 200_000),
    storedFiles: count(500,
      "The app's own stored or locally cached model files. The least recently used go first.",
      10, 5000),
    compactAt: count(125_000, 'Tokens at which a long conversation is compacted into a file.', 20_000, 180_000),
    compactShare: count(80, 'Percent of limits.inputTokens at which a long conversation is compacted, when that comes before limits.compactAt.', 30, 95),
    partShare: count(60, 'Percent of limits.outputTokens, and of limits.inputTokens, that a batch of items is sized to fill. The rest is margin: what an item takes is only estimated, and the prompt\'s own words and documents also count.', 20, 95),
    checkReplyTokens: count(250, 'About how many tokens the standard model\'s reply on one checklist item takes (a place and its quote, or a finding written up), to size a check\'s batches.', 10, 5_000),
    glanceReplyTokens: count(
      20,
      'The same for the fast model\'s quick look at one item, and for the standard model\'s check of one ' +
        'Already Asked? pair.',
      5,
      1_000,
    ),
    rewordReplyTokens: count(80, 'The same for one item\'s new wording on import.', 10, 2_000),
    phraseReplyTokens: count(80, 'The same for one question to the counterparty drafted by Add all unresolved.', 10, 2_000),
    ratingReplyTokens: count(25, 'The same for one finding\'s risk rating in the memo.', 5, 500),
    charsPerToken: count(3, 'Characters taken as one token when the app counts the text it sends (English averages about four, so three counts on the high side).', 1, 8),
    chatTurns: count(25,
      'About how many turns one run of the chat agent, in a chat or in the checks\' gap search, '
      + 'takes before it answers with what it has.', 1, 100),
    aiRetries: count(2, 'Times an AI call that failed, or gave an empty reply, is asked again quietly before the failure is shown. A service that cannot be reached is waited for instead.', 0, 5),
    askedCutoff: count(
      80,
      "Percent of an unresolved point's words (as the search index keeps them) that an open question must name " +
        "before the model is asked whether it already asks for the point (Add All Unresolved's Already Asked?). " +
        'Below it no call is made and ' +
        'nothing is offered; at 0 every point that shares a word with a question is checked, ' +
        'at 100 only a point whose words a question names all of.',
      0,
      100,
    ),
    searchCalls: count(15,
      'About how many calls one search run, in a chat or in the checks, makes before it returns what it found.',
      1, 50),
    sameFolder: count(70, "Percent of what is recorded in a deal folder that a PC must find unchanged in its copy before what it does not find there (deleted, or a new version saved over it) leaves the deal for every PC. Below it, the PC takes away only what it had seen itself, so a PC with part of a folder takes nothing from the others.", 51, 100),
    searchPage: count(
      25,
      'Findings or questions one search of them gives the chat at a time; the chat asks for the next page. ' +
        'Documents come limits.docsPerCall a page.',
      5,
      200,
    ),
    folderDocs: count(200, 'A folder the chat is asked to read is always read whole, a batch of limits.docsPerCall at a time; one with more documents than this is started only once the person says so.', 8, 5000),
  },
  timings: {
    roundLapse: time(15 * MINUTE, 'A PC in a shared check that is quiet this long has gone; the others take its work.', 1 * MINUTE, 2 * HOUR),
    roundRenew: time(5 * MINUTE, 'How often a PC in a shared check says it is still there.', 10 * SECOND, 1 * HOUR),
    roundWatch: time(10 * SECOND, 'How often a PC in a shared check looks at the shared log.', 1 * SECOND, 5 * MINUTE),
    roundRetryFirst: time(5 * SECOND, 'First wait before a failed piece of a shared check is tried again.', 1 * SECOND, 5 * MINUTE),
    roundRetryMax: time(1 * MINUTE, 'Longest wait between tries of a failed piece of a shared check.', 1 * SECOND, 1 * HOUR),
    modelWait: time(2 * MINUTE, 'How long a check, or start-up, keeps the person waiting while the model service does not answer, and how long a shared check waits on a sign-in before handing its part to the other PCs. Start-up and calls a person makes wait for a sign-in until it is done.', 10 * SECOND, 30 * MINUTE),
    modelCall: time(10 * MINUTE, 'How long one request to the model service may take, reply included, before it counts as the service not being reached (the check then carries on later). No connector streams, so a long reply on a slow model must arrive whole within it.', 2 * MINUTE, 30 * MINUTE),
    modelRetryEvery: time(5 * MINUTE, 'After that, how often the check tries again in the background.', 30 * SECOND, 2 * HOUR),
    aiRetryWait: time(2 * SECOND, 'Wait before a failed AI call is asked again; it doubles each time (limits.aiRetries).', 1 * SECOND, 1 * MINUTE),
    describeLapse: time(15 * MINUTE, "A PC's claim to describe a document lapses after this, unless renewed.", 1 * MINUTE, 2 * HOUR),
    describeRenew: time(5 * MINUTE, 'How often a PC renews its claim while it describes.', 10 * SECOND, 1 * HOUR),
    indexRetryFirst: time(5 * SECOND, 'First wait before indexing tries an unreachable data room again; it doubles each time.', 1 * SECOND, 5 * MINUTE),
    folderIdle: time(30 * DAY, "A PC that has not read a deal folder this long counts as no longer used: another PC that reads the folder (limits.sameFolder) then takes out what that PC saw there and is gone, deleted or replaced. A PC that reads a folder says so at most once a day when nothing is new.", 1 * DAY, 365 * DAY),
    indexRetryMax: time(15 * MINUTE, 'Longest wait between indexing tries.', 10 * SECOND, 2 * HOUR),
    folderWait: time(2 * MINUTE, "As the app opens, how long it keeps looking for deal folders it cannot open (a slow network drive) before it says so.", 10 * SECOND, 30 * MINUTE),
    folderRetryEvery: time(15 * SECOND, 'How often it looks again during that wait.', 1 * SECOND, 5 * MINUTE),
    folderCheck: time(5 * MINUTE, "How often each PC lists the folders of its deals (names, sizes and dates; nothing is opened) to find documents added, changed or removed since they were read; closed deals are left out. Also done when a deal is opened and before each check.", 1 * MINUTE, 24 * HOUR),
    checkFolderWait: time(2 * MINUTE, 'How long a check waits for documents it has just found in the data room to be read before it starts without them; they are checked once they are read.', 10 * SECOND, 30 * MINUTE),
  },
  lists: {
    searchFiller: words([
      'the', 'and', 'for', 'are', 'was', 'were', 'not', 'any', 'has', 'had', 'its', 'all', 'can', 'did', 'how', 'who', 'why', 'but', 'you', 'our', 'out', 'say', 'says', 'said',
      'each', 'more', 'most', 'some', 'than', 'then', 'them', 'they', 'been', 'being', 'will', 'still', 'what', 'which', 'where', 'when', 'does', 'have', 'that', 'this', 'with',
      'from', 'about', 'please', 'confirm', 'provide', 'there', 'their', 'would', 'should', 'could', 'into', 'under', 'between', 'document', 'documents', 'of', 'to', 'in', 'on',
      'at', 'by', 'is', 'it', 'as', 'an', 'or', 'be', 'we', 'no', 'do', 'if', 'so', 'up', 'us', 'he', 'me', 'my', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'csv', 'ppt', 'pptx',
    ], 'Filler words left out when a question is matched to documents (lower case).', 0, 2000),
    indexFiller: words(`a about above after again against all also am an and any are aren as at be because been before being below between both but by
can cannot could couldn did didn do does doesn doing don down during each either else etc ever every few for from further had hadn has hasn have haven having he her here hers herself him himself his how however
i if in into is isn it its itself just let ll may me might more most much must mustn my myself no nor not now of off on once one only onto or other others ought our ours ourselves out over own per
re same shan she should shouldn so some such than that the their theirs them themselves then there these they this those through thus to too under until up upon us ve very was wasn we were weren what when where
whether which while who whom whose why will with within without won would wouldn yes yet you your yours yourself yourselves
shall hereby herein hereof hereto hereunder thereof thereto therein thereby thereunder whereas whereby pursuant including include includes included
page pages www http https com pdf doc docx xls xlsx`.split(/\s+/), "Filler words left out of a document's most-used words when it is indexed (lower case).", 0, 2000),
    askWords: words(['executed', 'execution', 'copy', 'copies', 'provided', 'provide', 'confirm', 'confirmed', 'party', 'parties', 'term', 'terms', 'lender', 'lenders', 'consent', 'consents',
      'default', 'evidence', 'required', 'requirement', 'requirements', 'satisfactory', 'relevant', 'material', 'applicable', 'full', 'force', 'effect', 'valid', 'place', 'review', 'details', 'summary', 'list', 'other'],
      "Words checklist items use to ask for something (\"an executed copy of\"), which say nothing about what a document is: left out when an item is matched to documents for the core set (lower case).", 0, 500),
    synonyms: groups([
      ['PPA', 'power purchase agreement', 'offtake agreement', 'energy purchase agreement'],
      ['EPC', 'EPC contract', 'engineering procurement and construction contract', 'turnkey construction contract'],
      ['O&M', 'O&M agreement', 'operation and maintenance agreement', 'operations and maintenance agreement'],
      ['LTSA', 'long-term service agreement', 'long term services agreement'],
      ['SHA', 'shareholders agreement', "shareholders' agreement"],
      ['JVA', 'joint venture agreement'],
      ['SPA', 'share purchase agreement', 'stock purchase agreement'],
      ['MIPA', 'membership interest purchase agreement'],
      ['ECCA', 'equity capital contribution agreement'],
      ['ICA', 'intercreditor agreement', 'intercreditor deed'],
      ['facility agreement', 'facilities agreement', 'credit agreement', 'loan agreement'],
      ['direct agreement', 'consent and agreement', 'consent to collateral assignment'],
      ['ISDA', 'ISDA master agreement', 'hedging agreement', 'swap agreement'],
      ['DSRA', 'debt service reserve account'],
      ['DSCR', 'debt service cover ratio', 'debt service coverage ratio'],
      ['LLCR', 'loan life cover ratio', 'loan life coverage ratio'],
      ['PLCR', 'project life cover ratio', 'project life coverage ratio'],
      ['conditions precedent', 'condition precedent', 'CP checklist'],
      ['COD', 'commercial operation date', 'commercial operations date'],
      ['liquidated damages', 'delay liquidated damages', 'performance liquidated damages'],
      ['NTP', 'notice to proceed'],
      ['information memorandum', 'offering memorandum', 'confidential information memorandum'],
      ['independent engineer', "lenders' technical advisor", 'lenders technical adviser'],
      ['insurance advisor', "lenders' insurance advisor", 'insurance adviser', 'insurance consultant'],
      ['market advisor', 'market adviser', 'market consultant'],
      ['market study', 'market report'],
      ['ESIA', 'environmental and social impact assessment'],
      ['EIA', 'environmental impact assessment'],
      ['ESAP', 'environmental and social action plan'],
      ['KYC', 'know your customer'],
      ['NDA', 'non-disclosure agreement', 'confidentiality agreement'],
      ['term sheet', 'heads of terms'],
      ['PCG', 'parent company guarantee', 'parent company guaranty', 'parent guarantee'],
      ['letter of credit', 'standby letter of credit', 'SBLC'],
      ['LGIA', 'large generator interconnection agreement', 'interconnection agreement', 'grid connection agreement'],
      ['ground lease', 'land lease', 'solar lease', 'wind lease', 'lease agreement'],
      ['financial model', 'base case model', 'banking case'],
      ['model audit report', 'model audit'],
      ['legal opinion', 'capacity opinion', 'enforceability opinion'],
      ['tax equity', 'partnership flip', 'tax equity investment agreement'],
      ['PTC', 'production tax credit'],
      ['renewable energy certificate', 'renewable energy credit'],
      ['PILOT', 'payment in lieu of taxes'],
      ['FERC', 'Federal Energy Regulatory Commission'],
      ['MBR', 'market-based rate authority'],
      ['QF', 'qualifying facility'],
      ['articles of association', 'memorandum and articles', 'constitutional documents'],
      ['certificate of incorporation', 'certificate of formation'],
      ['LLC agreement', 'limited liability company agreement'],
      ['board minutes', 'board resolutions'],
      ['security agreement', 'security and pledge agreement'],
      ['pledge agreement', 'equity pledge'],
      ['mortgage', 'deed of trust'],
      ['accounts agreement', 'account bank agreement', 'depositary agreement'],
      ['energy yield assessment', 'wind resource assessment', 'solar resource assessment', 'resource assessment'],
      ['technical due diligence report', "independent engineer's report"],
      ['legal due diligence report', 'legal DD report'],
      ['insurance due diligence report', 'insurance report'],
    ], 'The synonyms and abbreviations library: each group names one thing. ' +
      'A phrase matches only whole and in order; an abbreviation only as a word in capitals. ' +
      'Used to match checklist items to documents for the core set, ' +
      'and an abbreviation also searches as its long form.', ORDINARY, AMBIGUOUS),
    relationWords: words(['schedule', 'sch', 'sched', 'exhibit', 'exh', 'ex', 'annex', 'annexure', 'appendix', 'app', 'attachment', 'att', 'amendment', 'amend', 'amdt', 'supplement', 'supp',
      'supplemental indenture', 'side letter', 'joinder', 'waiver', 'novation', 'addendum', 'rider', 'change order', 'co', 'pco', 'variation order', 'variation', 'vo', 'signature page',
      'omnibus amendment', 'waiver and amendment', 'deed of amendment', 'deed of variation', 'amendment agreement', 'amendment and restatement agreement', 'supplemental agreement',
      'supplemental deed', 'deed of novation', 'novation agreement', 'joinder agreement'],
      'Words that name a part of an agreement or a change to it, abbreviations included (lower case, singular): a document named with one (Schedule 3, First Amendment, Side Letter re PPA) joins its agreement in the core set and is never in a series (docs/core-families-design.md).', 1, 200),
    instrumentWords: words(['agreement', 'contract', 'lease', 'deed', 'guarantee', 'guaranty', 'policy', 'permit', 'license', 'licence', 'bond', 'opinion', 'easement', 'mortgage', 'indenture',
      'debenture', 'charge', 'note', 'fee letter', 'letter of credit', 'confirmation', 'certificate of incorporation', 'certificate of formation', 'estoppel', 'consent', 'notice to proceed'],
      'Words that make a document an instrument (lower case, singular): one other documents can belong to, and never a series member, so "Lease Agreement - Parcel 12" stays its own document.', 1, 200),
    seriesWords: words(['report', 'minutes', 'log', 'statement', 'accounts', 'invoice', 'notice of borrowing', 'borrowing request', 'drawdown request', 'request for information', 'rfi', 'letter',
      'correspondence', 'return', 'certificate of insurance', 'newsletter', 'update', 'sheet', 'photo', 'photograph', 'drawing'],
      'Kinds of periodic or running records (lower case, singular): only these make a series, whose newest member alone is core (monthly reports, board minutes, notices of borrowing).', 1, 200),
    partWords: words(['phase', 'parcel', 'tract', 'lot', 'unit', 'site', 'block', 'wtg', 'turbine', 'holdco', 'project', 'plant', 'investor', 'title', 'register', 'account', 'pad', 'building',
      'area', 'zone', 'trade', 'landowner', 'lender', 'bank', 'spv'],
      'Words after which a number names a part, not a period (Parcel 12, WTG 07, Phase 2): such documents are never folded into a series (lower case).', 1, 200),
  },
  colors: {
    neutral: color('#606469', 'The cool slate gray every background, text, glass, line, shadow and document page '
      + 'is worked out from, in both themes, the accent (light gray in the dark theme, graphite in the light one), '
      + 'and the gray for done. Only its hue and strength are used: each theme sets how light each part is.'),
    accent: color('#d9c5a3', 'The highlight and mark on a document page, in both themes. The accent itself (the main '
      + 'action, what is chosen, in progress, focus, links and AI marks) is a gray worked out from the neutral.'),
    red: color('#a8392a', 'Needs you: open findings, flagged items, failures and warnings, worked out for each theme from this one color.'),
  },
  desktop: {
    sharedFolder: text('Punchlist', "The folder inside the person's OneDrive that holds the team's shared records; every PC must use the same name.", 1, 64, folderName),
    teamFolderLink: link('', "The share link of the team's Punchlist folder (Share > Copy link in OneDrive). When set, a PC with no Punchlist folder offers to open it, so the person can choose Add shortcut to My files. Empty until set."),
    trimEvery: time(10 * MINUTE, "How often each PC checks the model service's file store and removes the least recently used files over the limit.", 1 * MINUTE, 24 * HOUR),
  },
};

const ssoFields = {
  gateway: ['authorize', 'token', 'clientId', 'scope'],
  azure: ['tenant', 'clientId'],
  bedrock: ['ssoRegion', 'startUrl', 'account', 'role'],
  vertex: ['clientId'],
} as const;

/**
 * What a cloud service's saved sign-in belongs to: the service, its address and its sign-in fields. A change to any of
 * them asks the person to sign in again; a change to anything else, such as a model ID, does not.
 */
export function signInBinding(c: Control): string | undefined {
  const provider = c.models.service;
  if (!isCloudProvider(provider)) return undefined;
  const settings = c[provider] as Record<string, unknown>;
  const fields = ['address', ...ssoFields[provider]].map((field) => [field, settings[field]]);
  return JSON.stringify({ provider, ...Object.fromEntries(fields) });
}

function cloudProblem(c: Control): string | null {
  const provider = c.models.service;
  if (!isCloudProvider(provider)) return null;
  const settings = c[provider];
  const required = ['address', 'fast', 'standard', 'thorough'];
  if (provider === 'bedrock') required.push('region');
  if (c.signIn.sso) required.push(...ssoFields[provider]);
  const missing = required.filter((key) => !(settings as Record<string, unknown>)[key]);
  if (missing.length) {
    const fields = missing.map((key) => `${provider}.${key}`).join(', ');
    return `models.service '${provider}' needs ${fields} set`;
  }
  const path = new URL(settings.address).pathname.replace(/\/$/, '');
  if (provider === 'azure' && path !== '/openai/v1') return 'azure.address must end in /openai/v1';
  const vertexRoot = /^\/v1\/projects\/[\w-]+\/locations\/[\w-]+\/publishers\/anthropic\/models$/;
  if (provider === 'vertex' && !vertexRoot.test(path)) {
    return 'vertex.address must include /v1/projects/PROJECT/locations/LOCATION/publishers/anthropic/models';
  }
  return null;
}

/** Checks between values, which no one value can make alone. Each returns what is wrong, or null. */
const ACROSS: ((c: Control) => string | null)[] = [
  (c) => c.picker.fast || c.picker.standard || c.picker.thorough ? null : 'picker.fast, picker.standard and picker.thorough cannot all be off: the model picker needs one',
  (c) => c.signIn.sso || c.signIn.apiKey ? null : 'signIn.sso and signIn.apiKey cannot both be off, or nobody could sign in',
  cloudProblem,
  // Direct services still require a key.
  (c) => c.models.service === 'north' || isCloudProvider(c.models.service) || c.signIn.apiKey ? null
    : `signIn.apiKey cannot be off with models.service '${c.models.service}': that service requires an API key`,
  (c) => c.models.service !== 'north' || c.north.address ? null : "models.service 'north' needs north.address set",
  // North's model names differ from one instance to the next, so they have no default
  (c) => c.models.service !== 'north' || (c.models.northFast && c.models.northStandard && c.models.northThorough) ? null
    : "models.service 'north' needs models.northFast, models.northStandard and models.northThorough set",
  (c) => c.models.service !== 'openai' || (c.openai.address && c.models.openaiFast && c.models.openaiStandard && c.models.openaiThorough) ? null : "models.service 'openai' needs openai.address, models.openaiFast, models.openaiStandard and models.openaiThorough set",
  (c) => c.models.service !== 'north' || !c.signIn.sso || c.north.ssoSite ? null : "signIn.sso on North needs north.ssoSite set (or turn signIn.sso off)",
  (c) => c.limits.outputTokens < c.limits.inputTokens ? null : 'limits.outputTokens must be less than limits.inputTokens',
  (c) => c.limits.shortlist >= c.limits.docsPerCall ? null : 'limits.shortlist must be at least limits.docsPerCall',
  (c) => c.timings.roundRenew < c.timings.roundLapse ? null : 'timings.roundRenew must be shorter than timings.roundLapse, or a live PC would be taken for gone',
  (c) => c.timings.describeRenew < c.timings.describeLapse ? null : 'timings.describeRenew must be shorter than timings.describeLapse',
  (c) => c.timings.roundRetryMax >= c.timings.roundRetryFirst ? null : 'timings.roundRetryMax must be at least timings.roundRetryFirst',
  (c) => c.timings.indexRetryMax >= c.timings.indexRetryFirst ? null : 'timings.indexRetryMax must be at least timings.indexRetryFirst',
];

// ---- reading and checking -------------------------------------------------------------------------------------------

type Spec = Record<string, Record<string, Entry<unknown>>>;
type Values<S extends Spec> = { readonly [G in keyof S]: { readonly [K in keyof S[G]]: S[G][K] extends Entry<infer T> ? T : never } };
export type Control = Values<typeof SPEC>;

/** the plain values of a spec, frozen so no code changes one while the app runs */
function valuesOf<S extends Spec>(spec: S): Values<S> {
  const deepFreeze = <T>(v: T): T => { if (v && typeof v === 'object') { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); } return v; };
  return deepFreeze(Object.fromEntries(Object.entries(spec).map(([g, entries]) => [g, Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, e.value]))]))) as Values<S>;
}

/** Every value the app reads from this file. */
export const control: Control = valuesOf(SPEC);

/** a name from the control file as it can be shown: trimmed, 1 to 40 characters, no line breaks, control characters or
 * angle brackets; anything else gives the default, so a slip in the control file never shows broken text */
export function shownName(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const t = v.trim();
  return t.length >= 1 && t.length <= 40 && !/[\u0000-\u001f\u007f<>]/.test(t) ? t : fallback;
}
/** what the model service is called on screen (control: names.service) */
export const SERVICE = shownName(control.names.service, 'Intelligence');
/** what marks text the model wrote (control: names.aiContent) */
export const AI_LABEL = shownName(control.names.aiContent, 'AI');

/** The one-line note on each value, by its path ("limits.docsPerCall"), for anyone who wants to show them. */
export const notes: Record<string, string> = Object.fromEntries(Object.entries(SPEC as Spec).flatMap(([g, entries]) => Object.entries(entries).map(([k, e]) => [`${g}.${k}`, e.note])));

/**
 * What is wrong with the control file, one line per value: empty when every value is in range. `values` stands in for
 * the file's own in tests; a value missing from it, or of the wrong kind, is reported like one out of range.
 */
export function checkControl(values: Control = control): string[] {
  const out: string[] = [];
  for (const [g, entries] of Object.entries(SPEC as Spec)) for (const [k, e] of Object.entries(entries)) {
    const v = (values as unknown as Record<string, Record<string, unknown> | undefined>)[g]?.[k];
    let p: string | null; try { p = v === undefined ? 'is missing' : e.problem(v); } catch { p = 'is not the right kind of value'; }
    if (p) out.push(`${g}.${k} ${p}.`);
  }
  if (!out.length) for (const rule of ACROSS) { const p = rule(values); if (p) out.push(`${p}.`); }
  return out;
}

/** Stop with every problem in the control file named, or do nothing when it is fine. Call first thing at start. */
export function assertControl(values: Control = control): void {
  const problems = checkControl(values);
  if (problems.length) throw new Error(`The control file (src/control.ts) has ${problems.length === 1 ? 'a value' : 'values'} out of range. Fix and rebuild:\n${problems.map((p) => `- ${p}`).join('\n')}`);
}
