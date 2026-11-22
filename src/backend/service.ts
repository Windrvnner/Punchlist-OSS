/**
 * The model service, as much of it as this backend needs. This is the one thing to write against the real API:
 * six small calls. Everything else in src/backend runs on top of them and is tested against the stand-in below.
 *
 * The service parses the files it is given; this backend never reads inside a document.
 */
export interface ModelService {
  /** who is signed in. A failure here is not fatal: the PC's signed-in user is used instead. */
  whoami(): Promise<{ name: string }>;
  /**
   * The models on offer to a person, and which of them the backend uses when it is the one choosing: `fast` for the many
   * cheap sorting jobs, `standard` for answering, `thorough` only when the standard model's reply cannot be used.
   * `default` is the one preselected for a person.
   */
  models(): Promise<{ models: { id: string; name: string }[]; default: string; fast: string; standard: string; thorough: string }>;
  /**
   * Text in, text out. `files` are ids returned by upload(); the service reads those files itself.
   * Throw when the call fails; give the error `code: 'unreachable'` when the service could not be reached at all, so the
   * app shows that it is retrying rather than that one answer failed.
   */
  complete(input: { model: string; system?: string; prompt: string; files?: string[] }): Promise<string>;
  /**
   * Put a file in the service's store; returns the store's id for it. Resolve only when the file can be read by `complete`:
   * a store that indexes after upload has to be waited on here.
   */
  upload(file: { name: string; bytes: Uint8Array }): Promise<string>;
  /**
   * Optional. The most tokens one reply from this model may hold, as far as the connector knows: the control file's
   * limits.outputTokens, or less where the service says the model allows less. The backend sizes its batches to fit.
   * A reply cut off at the limit throws with `code: 'cutoff'`, from `complete` and `converse` alike.
   */
  outputLimit?(model: string): number;
  /**
   * Optional. The most tokens one call to this model may send, documents included, as far as the connector knows: the
   * control file's limits.inputTokens, or less where the service says the model takes less. A call the service refuses
   * as too long throws with `code: 'toolong'`.
   */
  inputLimit?(model: string): number;
  /** take a file out of the store. Removing one that is already gone is not an error. */
  remove(fileId: string): Promise<void>;
  /** everything in this person's store right now, whoever put it there */
  list(): Promise<{ id: string; name: string }[]>;
  /**
   * Optional. One turn of a conversation the service keeps, so that a follow-up is not sent from scratch (decisions:
   * Long conversations): North keeps it on its side; the Claude connector resends it from its prompt cache.
   * `conversation` names one to carry on; left out, a new one is started with `system`. Returns the reply, the
   * conversation's id, and how many tokens it now holds, when the service says. Throws with `code: 'gone'` when the
   * service no longer has that conversation. Without this method the chat sends its history as text.
   */
  converse?(input: ConverseInput): Promise<Conversed>;
  /**
   * Optional. One small call that needs a sign-in and costs nothing (no model is run), so a key can be checked before it
   * is taken (decisions: "Intelligence sign-in"). Resolves when the service accepts the token; a refused token goes to
   * the token holder's `refused`, as on any call; no connection throws with `code: 'unreachable'`.
   */
  checkSignIn?(): Promise<void>;
}

/**
 * One turn of a kept conversation. With `tools`, the model may call them (native tool calling, `tools` on North's Chat
 * page) and must call one; `results` answer the calls of the turn before, by id, ahead of `prompt`. A service or model
 * that cannot call tools throws, without `code: 'unreachable'` or `'gone'`, and the chat goes back to asking for tools
 * in the text.
 */
export interface ConverseInput { model: string; system?: string; prompt: string; files?: string[]; conversation?: string; tools?: ToolSpec[]; results?: { id: string; text: string }[] }
/** a tool the model may call: its name, what it is for, and its arguments as a JSON schema */
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
/** what a turn of a kept conversation gives back; `calls`, the tools the model called, by id, with their arguments */
export interface Conversed { text: string; conversation: string; tokens?: number; calls?: { id: string; name: string; args: Record<string, unknown> }[] }

/** a call of the third-party reports sweep (reports.ts): sorting paths, a look at first pages, or reading a report */
export const isReportAsk = (prompt: string) =>
  prompt.includes('reports by a third-party advisor') || prompt.includes('is a report by an outside advisor');
/** what the stand-in says to the reports sweep when nothing answers it: no document is a report */
const NO_REPORTS = '{"reports": [], "unsure": []}';

/** A model service that lives in memory and answers from a script. For tests and for running the app with no service. */
export class StandInService implements ModelService {
  files = new Map<string, { name: string; bytes: Uint8Array }>();
  calls: { model: string; system?: string; prompt: string; files?: string[] }[] = [];
  uploads = 0; removed: string[] = [];
  /** set to stand in for a service that reports its limits (limits.ts); left out, the control file's apply */
  outputLimit?: (model: string) => number; inputLimit?: (model: string) => number;
  /**
   * set to answer the third-party reports sweep's calls (reports.ts); left out, it finds no reports. They do not go to
   * `script`, so a test of something else is not asked them
   */
  reports?: (input: StandInInput) => string | Promise<string>;
  private n = 0;
  constructor(
    public script: (input: {
      model: string;
      system?: string;
      prompt: string;
      files: { id: string; name: string; text: string }[];
    }) => string | Promise<string> = () => '',
    public who = 'adoe',
    public offered = {
      models: [
        { id: 'fast', name: 'Fast' },
        { id: 'standard', name: 'Standard' },
        { id: 'thorough', name: 'Thorough' },
      ],
      default: 'standard',
      fast: 'fast',
      standard: 'standard',
      thorough: 'thorough',
    },
    public capacity = Infinity,
  ) {}
  async whoami() { return { name: this.who }; }
  async models() { return this.offered; }
  async complete(input: { model: string; system?: string; prompt: string; files?: string[] }) {
    this.calls.push(input);
    const files = (input.files ?? []).map((id) => { const f = this.files.get(id); if (!f) throw new Error(`no such file in the store: ${id}`); return { id, name: f.name, text: new TextDecoder().decode(f.bytes) }; });
    if (isReportAsk(input.prompt)) return this.reports ? this.reports({ ...input, files }) : NO_REPORTS;
    return this.script({ ...input, files });
  }
  async upload(file: { name: string; bytes: Uint8Array }) {
    if (this.files.size >= this.capacity) throw new Error('the store is full');
    const id = `file_${++this.n}`; this.files.set(id, file); this.uploads++; return id;
  }
  async remove(fileId: string) { if (this.files.delete(fileId)) this.removed.push(fileId); }
  async list() { return [...this.files.entries()].map(([id, f]) => ({ id, name: f.name })); }
  /** the conversations it keeps: their system as they started, and each turn's prompt and reply in order */
  conversations = new Map<string, { system?: string; said: string[] }>();
  /** about how many tokens a conversation holds: a character is counted as a quarter of a token */
  tokensPerChar = 0.25;
  /** set to make tool calls fail, as a service or model without them does; `noToolResults`, tool results, as North does */
  noTools = false; noToolResults = false;
  async converse(input: ConverseInput): Promise<Conversed> {
    if (input.tools && this.noTools) throw Object.assign(new Error('this model does not call tools'), { status: 400 });
    if (input.results?.length && this.noToolResults) throw new Error('tool results are not taken');
    let id = input.conversation; let c = id ? this.conversations.get(id) : undefined;
    if (id && !c) throw Object.assign(new Error(`no such conversation: ${id}`), { code: 'gone' });
    if (!c || !id) { id = `conv_${this.conversations.size + 1}`; c = { ...(input.system ? { system: input.system } : {}), said: [] }; this.conversations.set(id, c); }
    const prompt = [...(input.results ?? []).map((r) => r.text), input.prompt].filter(Boolean).join('\n\n');
    const text = await this.complete({ model: input.model, ...(c.system ? { system: c.system } : {}), prompt, ...(input.files ? { files: input.files } : {}) });
    c.said.push(prompt, text);
    const tokens = Math.round([c.system ?? '', ...c.said].join('').length * this.tokensPerChar);
    // the script answers in text: with tools, a reply naming one ({"tool": …}) is that tool called, and an answer ({"text": …}) is "answer" called
    const call = input.tools ? callOf(text, input.tools.map((t) => t.name)) : null;
    return { text: call ? '' : text, conversation: id, tokens, ...(call ? { calls: [{ id: `call_${++this.n}`, ...call }] } : {}) };
  }
}

/** what the stand-in's script is asked */
interface StandInInput {
  model: string;
  system?: string;
  prompt: string;
  files: { id: string; name: string; text: string }[];
}

/** a scripted reply read as a tool call, for the stand-ins: {"tool": "search", …} calls search, {"text": …} calls answer */
export function callOf(text: string, tools: string[]): { name: string; args: Record<string, unknown> } | null {
  let r: unknown; try { r = JSON.parse(text); } catch { return null; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const { tool, ...args } = r as Record<string, unknown>;
  const name = typeof tool === 'string' ? tool : 'text' in args ? 'answer' : '';
  return tools.includes(name) ? { name, args } : null;
}
