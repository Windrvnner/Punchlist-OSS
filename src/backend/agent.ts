/**
 * The chat agent (decisions page, Conversations). A conversation's answer is worked out in turns by the
 * model the person chose (the main session), which has four tools:
 *   - search: what (documents, findings, Q&A or all), a query and a page. Every kind is ranked by the same keyword
 *     scoring and comes a page at a time. A document page is the next `width` documents of the keyword ranking
 *     (folder paths and file names included), which a search helper on the fast model reads on the model service,
 *     returning passages with document and page. Findings and Q&A are records the app holds, `searchPage` a page,
 *     each whole, with no model call (agentSearch.ts).
 *   - read: documents named by tag or path, at most eight in one call, attached to the main session's next turn.
 *   - folder: a folder named as the person says it, and what to look for. The documents in it are put in the
 *     order to read them (ai.ts: a keyword and core-document ranking, then the fast model's order of its top), and the
 *     fast model reads them a batch at a time (`width` documents, the per-call cap), a few batches at once, most
 *     important first, each batch a step of its own. The whole folder is read, never part of it. A
 *     folder of more than `folderDocs` documents is not started until the person has said to: the main session is told
 *     to ask them, once, saying how many documents there are, and reads it with "all" once they agree (agentFolder.ts).
 *   - brief: each deal's catch-up, the deal brief on its open findings (ai.ts dealBrief), for "catch me up on the deal"
 *     (agentSearch.ts).
 * An attached document is not put into the prompt in full: the model service searches inside it for what the turn asks
 * (North reads attached files through its own search: My files and the chat API's file_ids). So attaching
 * a document again on each turn costs no tokens for its text, and a long document is no dearer than a short one.
 * A tool is called natively where the service allows it (below), and otherwise asked for in the reply as a small JSON
 * block, the answer being a JSON block of its own (agentPrompts.ts). The main session can search and read as often as
 * it needs, up to `turns` (about 25), and is then asked to answer with what it has. One search run makes at most about
 * eight calls (a pick and a read, and one more of each when the helper says what is still missing, plus a repair
 * each), under the 15 a search run may make.
 *
 * Before the first turn the question itself is searched for in everything, so that the first turn (on the dearer
 * model) already has something to go on, and the person's attachments and a finding's own documents are attached from
 * the first turn.
 *
 * The person can stop an answer while it is worked on (`stop`): no new batch of a folder read and no new
 * tool is started, and the main session is asked at once to answer from what it has found so far.
 *
 * What the agent did is kept as steps (`Research`), which the window asks for while it works (`progress`) and which go
 * back with the answer. A citation is kept only if it names a document a model was given in this conversation (by the
 * search helper or attached) and a page that document has: the same rule as every other answer.
 *
 * Where the model service keeps conversations (`talk`), a chat is one conversation there (decisions: Long
 * conversations): the first turn of a new conversation is asked in full, and each later turn sends only what is
 * new (the results of the last tool, documents opened or attached since, the turn count), so what was said before is
 * not sent again. The conversation goes back with the answer (`thread`), with the documents' tags, so the next
 * question carries it on and numbers on from them. When it holds `compactAt` tokens (125k, or less for a model that
 * takes less), or the service no longer has it or refuses it as too long, or the person changed model, it is
 * compacted: the whole conversation so far is put in the service's store as a transcript file, a new conversation
 * starts with that file attached and the turn asked in full, and the transcript of the last compaction is deleted.
 * Without `talk`, every turn is asked afresh with the conversation's last messages as text (agentTalk.ts).
 *
 * In a kept conversation the tools are called one of three ways (`toolMode`, the control file's models.toolCalls):
 *   - inline: asked for as the JSON block in the reply;
 *   - hybrid: search, read and answer are the service's own function tools, and a tool's result goes back in the next
 *     user message, since some services reject a role:tool result; on North, its own tools named
 *     in north.hostedTools go with them, so that the attached files are still read;
 *   - native: tool calls, and each result sent back as the result of its call.
 * A reply in text is read as the JSON block in every mode. A model that refuses tool results steps down from native to
 * hybrid, in the same conversation; one that refuses tool calls steps down to inline, in a new conversation. ai.ts
 * keeps the step for the rest of the app's run; a refusal of tool results that could be a passing error (a 500) only
 * once it comes twice with no tool results taken between.
 */
import { ok, fail, type Result } from '../domain/result';
import type { ModelThread, Research } from '../ports';
import type { Source } from '../domain/model';
import type { DocRecord } from './documents';
import { strings, prose, list as listOf, int } from './lenient';
import { TOO_LONG_ASK, TOO_LONG_REPLY, UNREAD_REPLY } from './limits';
import { control, SERVICE } from '../control';
import { codeOf, type AgentKit, type AgentOptions, type AgentQuestion } from './agentKit';
import type { Cited, Run, Sent } from './agentKit';
import { AgentRun } from './agentRun';
import { catchUp, pageNumber, search, type What } from './agentSearch';
import { FolderMemory, FolderReader } from './agentFolder';
import { KeptConversation, type Turn } from './agentTalk';
import { inlineTools } from './agentPrompts';

export type { AgentKit, AgentOptions, AgentQuestion, Cited, Sent, ToolMode } from './agentKit';

type Answered = {
  text: string;
  sources: Source[];
  read: { docs: number; of: number };
  research: Research;
  thread?: ModelThread;
  /** the action the model offers under its answer, as it gave it: the app checks it (app/answerOffer.ts) */
  offer?: unknown;
};
/** the agent's limits, its options with their defaults */
type Limits = {
  turns: number; width: number; folderDocs: number; searchPage: number; compactAt: (model: string) => number;
};

/**
 * the most characters a page of findings or questions may hold: half of what the kept conversation holds before it is
 * compacted, so that a search of everything, which gives a page of each in one result, never outgrows what one call
 * may send; the same whichever is searched, so that a page asked for by kind starts where a search of everything's
 * page of that kind stopped (recordSearch.ts `pageOf`, #1091)
 */
const pageChars = (limits: Limits, model: string) => (limits.compactAt(model) * control.limits.charsPerToken) / 2;

const SEARCHES: readonly What[] = ['documents', 'findings', 'qa', 'all'];
const REPLY_SHAPE = '{"tool": …} or {"text": "…", "sources": […], "offer": {…}}';

export function chatAgent(kit: AgentKit, opts: AgentOptions = {}) {
  const limits: Limits = {
    turns: Math.max(1, opts.turns ?? 25),
    width: Math.max(1, opts.width ?? 8),
    folderDocs: Math.max(1, opts.folderDocs ?? 200),
    searchPage: Math.max(1, opts.searchPage ?? 25),
    compactAt: (model) => (typeof opts.compactAt === 'function' ? opts.compactAt(model) : opts.compactAt ?? 125_000),
  };
  /**
   * the steps of answers being worked on now, by run id, for the window to ask about; dropped when the answer is
   * given
   */
  const running = new Map<string, Run>();
  /** what the folder reads of earlier answers had read, and the large folders they asked the person about */
  const folders = new FolderMemory();

  async function answer(question: AgentQuestion): Promise<Result<Answered>> {
    const progress: Run = { steps: [], t0: kit.now(), stopped: false };
    if (question.runId) running.set(question.runId, progress);
    try {
      return await new Answering(kit, question, progress, limits, folders).work();
    } finally {
      if (question.runId) running.delete(question.runId);
    }
  }

  return {
    answer,
    /** the steps an answer being worked on has taken so far; null when none is being worked on by that name */
    progress(runId: string): Research | null {
      const progress = running.get(runId);
      return progress ? { steps: progress.steps.map((s) => ({ ...s })), ms: kit.now() - progress.t0 } : null;
    },
    /**
     * the person stops an answer being worked on: it answers at once from what it has; false when none is being worked
     * on by that name
     */
    stop(runId: string): boolean {
      const progress = running.get(runId);
      if (!progress) return false;
      progress.stopped = true;
      return true;
    },
  };
}

/** one answer, worked out in turns of the main session */
class Answering {
  private readonly run: AgentRun;
  private readonly folders: FolderReader;
  private readonly conversation: KeptConversation;

  constructor(
    private readonly kit: AgentKit,
    private readonly question: AgentQuestion,
    progress: Run,
    private readonly limits: Limits,
    folderMemory: FolderMemory,
  ) {
    const { width, searchPage } = limits;
    this.run = new AgentRun(kit, question, progress, { width, searchPage, chars: pageChars(limits, question.model) });
    this.folders = new FolderReader(this.run, folderMemory, limits);
    this.conversation = new KeptConversation(this.run, limits.compactAt, limits.width);
  }

  /** whether the person has stopped the answer: read afresh each time, since they can stop it at any moment */
  private get stopped(): boolean {
    return this.run.progress.stopped;
  }

  async work(): Promise<Result<Answered>> {
    try {
      await this.firstSteps();
      for (let turnNumber = 1; turnNumber <= this.limits.turns; turnNumber++) {
        const answered = await this.turn(turnNumber);
        if (answered) return answered;
      }
      return fail({ kind: 'failed', message: UNREAD_REPLY });      // not reached: the last turn always ends above
    } catch (e) {
      return failure(e);
    }
  }

  /**
   * What the person gave (attachments, a finding's own documents) is attached from the first turn, and the question
   * itself is searched for in everything.
   */
  private async firstSteps(): Promise<void> {
    const { kit, question, run } = this;
    const must = question.deals.flatMap((dealId) => (question.must[dealId] ?? [])
      .map((docId) => kit.records(dealId).find((r) => r.docId === docId))
      .filter((r): r is DocRecord => !!r)
      .map((rec) => run.tagOf(dealId, rec).tag));
    if (must.length) run.done.push(run.read(must, this.limits.width));
    if (!this.stopped) run.done.push(await search(run, 'all', question.message));
  }

  /** one turn of the main session: the answer when it gives one, else null once its tool has been used */
  private async turn(turnNumber: number): Promise<Result<Answered> | null> {
    const { kit, question, run } = this;
    // stopped by the person: answered now, from what was found
    const last = turnNumber === this.limits.turns || this.stopped;
    if (this.stopped && !run.steps.some((x) => x.text === 'Stopped')) {
      run.steps.push({ kind: 'stop', text: 'Stopped', result: 'answered from what was found', done: true });
    }
    const { files, listing, got } = await kit.send(run.whole);
    // a document that cannot be opened on this PC was not read
    if (got.length < run.whole.length) run.whole = got;
    const turn = this.turnOf(turnNumber, last, files, listing);
    const reply = kit.talk
      ? await this.conversation.ask(turn)
      : await kit.askJson(
        { kind: 'answer', model: question.model, system: turn.system, prompt: turn.full(true), files },
        turn.keys,
        turn.shape,
      );
    if (!reply) return fail({ kind: 'failed', message: UNREAD_REPLY });
    const tool = typeof reply.tool === 'string' ? reply.tool.trim().toLowerCase() : '';
    if (strings(reply.notes).length) run.notes = strings(reply.notes).join(' ');
    if (!tool || (last && !strings(reply.text).length)) return this.answered(reply, last);
    run.done.push(await this.useTool(tool, reply));
    return null;
  }

  /** the pieces of this turn's prompt */
  private turnOf(turnNumber: number, last: boolean, files: string[], listing: string): Turn {
    const { kit, question } = this;
    const docLine = (s: Sent) => {
      const pages = s.rec.pages ? ` (${s.rec.pages} pages)` : '';
      return `${s.tag}: ${kit.where(s.rec)}${pages}${question.withDeal ? ` [deal ${s.dealId}]` : ''}`;
    };
    const ending = this.stopped
      ? ' The person stopped the research: answer now from what you have, with no tool, and say what was not looked at.'
      : last ? ' It is your last: answer now from what you have, with no tool.' : '';
    const turnLine = `This is turn ${turnNumber} of at most ${this.limits.turns}.${ending}`;
    return {
      full: (history) => this.prompt(history, listing, turnLine, docLine),
      files,
      listing,
      turnLine,
      docLine,
      system: `${inlineTools(this.limits.width)}\n\n${kit.rules}`,
      keys: ['tool', 'text'],
      shape: REPLY_SHAPE,
    };
  }

  /** the turn's whole prompt; `history`: with the conversation's last messages and its transcript */
  private prompt(history: boolean, listing: string, turnLine: string, docLine: (s: Sent) => string): string {
    const { question, run } = this;
    const transcript = this.conversation.transcript;
    const shown = run.shown();
    const doneSoFar = run.done.map((x, i) => `${i + 1}. ${x}`).join('\n\n');
    return [
      question.about ? `${question.about}\n` : '',
      history && question.history ? `Earlier in this conversation:\n${question.history}\n\n` : '',
      history && transcript
        ? 'The whole conversation so far is in the attached transcript: search it when the question refers to '
          + 'something said earlier.\n\n'
        : '',
      `Question: ${question.message}\n\n`,
      shown.length ? `Documents opened so far (cite them by tag):\n${shown.map(docLine).join('\n')}\n\n` : '',
      run.whole.length ? `Given to you whole with this message:\n${listing}\n\n` : '',
      `What you have done so far:\n${doneSoFar}`,
      run.notes ? `\n\nYour notes so far: ${run.notes}` : '',
      `\n\n${turnLine}`,
    ].join('');
  }

  /** the tool the main session asked for, used; what it found, for the next turn */
  private async useTool(tool: string, reply: Record<string, unknown>): Promise<string> {
    if (this.stopped) return 'The person stopped the research before this tool was used.';
    if (tool === 'search') {
      const asked = String(reply.what ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
      const what = SEARCHES.find((w) => w === asked) ?? 'documents';
      const query = strings(reply.query).join(' ');
      if (!query) return 'You asked for a search without a query: give "query".';
      return search(this.run, what, query, pageNumber(reply.page));
    }
    if (tool === 'read') {
      const named = listOf(reply.docs).map((x) => (int(x) !== null ? `D${x}` : String(x)));
      return this.run.read(named, this.limits.width);
    }
    if (tool === 'folder') {
      const said = strings(reply.folder ?? reply.path ?? reply.name).join(' ');
      const lookFor = strings(reply.lookFor ?? reply.lookfor ?? reply.query ?? reply.focus).join(' ')
        || this.question.message;
      const agreed = reply.all === true || String(reply.all).toLowerCase() === 'true';
      if (!said) return 'You asked for a folder without naming it: give "folder".';
      return this.folders.read(said, lookFor, agreed);
    }
    if (tool === 'brief') return catchUp(this.run);
    return `There is no tool "${tool}": use "search", "read", "folder" or "brief", or answer.`;
  }

  /** the main session's answer, with the citations that can be stood behind; on the last turn, its notes if no text */
  private answered(reply: Record<string, unknown>, last: boolean): Result<Answered> {
    const { kit, question, run } = this;
    const text = prose(reply.text).join('\n\n') || (last ? run.notes : '');
    if (!text) return fail({ kind: 'failed', message: UNREAD_REPLY });
    const fitted = kit.fit(text, reply.sources as Cited[], run.opened, question.withDeal);
    this.showCitedPlaces(fitted.sources);
    const read = { docs: run.touched.size, of: question.deals.reduce((sum, d) => sum + kit.records(d).length, 0) };
    const thread = this.conversation.thread();
    const research = { steps: run.steps.map((s) => ({ ...s })), ms: kit.now() - run.progress.t0, read };
    const offer = reply.offer === undefined ? {} : { offer: reply.offer };
    return ok({ ...fitted, read, research, ...(thread ? { thread } : {}), ...offer });
  }

  /** an attached document's step shows the places the answer cites in it */
  private showCitedPlaces(sources: Source[]): void {
    for (const step of this.run.steps) {
      if (step.kind !== 'read') continue;
      const places = sources.filter((s) => step.text === `Reviewed ${s.doc}`).map((s) => s.loc);
      if (places.length) step.result = [...new Set(places)].join(', ');
    }
  }
}

/** what the person is told when an answer failed */
function failure(error: unknown): Result<Answered> {
  const code = codeOf(error);
  if (code === 'unreachable') return fail({ kind: 'unreachable', message: `${SERVICE} could not be reached.` });
  if (code === 'cutoff') return fail({ kind: 'failed', message: TOO_LONG_REPLY });
  if (code === 'toolong') return fail({ kind: 'failed', message: TOO_LONG_ASK });
  return fail({ kind: 'failed', message: 'The documents could not be read' });
}
