/**
 * The conversation the model service keeps for a chat (agent.ts, `talk`; decisions: Long conversations): the
 * first turn of a new conversation is asked in full, and each later turn sends only what is new. It is compacted into
 * a new conversation, with the transcript attached, when it is full, gone or refused as too long; and it steps down to
 * a plainer way of calling tools when the model refuses one.
 */
import type { ModelThread } from '../ports';
import { curable } from './retry';
import { dealDocKey, type AgentRun } from './agentRun';
import { codeOf, type Sent, type TalkAsk, type ToolMode, type Unusable } from './agentKit';
import { NATIVE_TOOLS, toolSpecs } from './agentPrompts';

/** one turn of the main session, as the agent's loop puts it together */
export interface Turn {
  /**
   * the turn's whole prompt; `history`: with the conversation's last messages and its transcript, for a new
   * conversation
   */
  full(history: boolean): string;
  /** the documents attached to the main session, as the store has them, and as listed for its prompt */
  files: string[];
  listing: string;
  /** the turn's number, and whether it is the last */
  turnLine: string;
  /** a document as listed to the main session, to be cited by its id */
  docLine(sent: Sent): string;
  /** the system prompt with the tools as JSON blocks, and what a reply must hold */
  system: string;
  keys: string[];
  shape: string;
  /** a reply the answer cannot use however it reads: a failed reply, asked again (#1105) */
  unusable: Unusable;
}

/** a turn's message to the kept conversation */
type Message = { prompt: string; results?: { id: string; text: string }[]; files: string[] };

export class KeptConversation {
  /** the service's conversation: carried on unless it is full or the person changed model */
  private id: string | undefined;
  /** how many tokens the conversation holds */
  private tokens: number;
  /** the store's file with the transcript of the last compaction */
  transcript: string | undefined;
  /** whether this run has put the conversation so far in the store as a transcript */
  private kept = false;
  /** how much of the run's results the conversation has been told; -1 before its first turn in this run */
  private told = -1;
  /** how many of the opened documents the conversation has been told of */
  private listed = 0;
  /** the documents attached to it last, by deal and docId */
  private attached = '';
  /** how tools are called; it steps down when the model refuses */
  private mode: ToolMode;
  /** the model's tool calls still to be answered: the last answer's, at first */
  private calls: string[];

  constructor(
    private readonly run: AgentRun,
    private readonly compactAt: (model: string) => number,
    private readonly width: number,
  ) {
    const { kit, question } = run;
    const was = kit.talk && question.thread?.model === question.model ? question.thread : undefined;
    this.id = was && was.tokens < compactAt(question.model) ? was.id : undefined;
    this.tokens = this.id ? was!.tokens : 0;
    this.transcript = kit.talk ? question.thread?.transcript : undefined;
    this.mode = kit.talk ? kit.toolMode?.(question.model) ?? 'inline' : 'inline';
    this.calls = this.id && was?.call ? [was.call] : [];
  }

  /** one turn in the kept conversation: in full when it is new (or this question is), else only what is new since */
  async ask(turn: Turn, tried = 0): Promise<Record<string, unknown> | null> {
    const { kit, question } = this.run;
    // full: carried on in a new conversation
    if (this.id && this.tokens >= this.compactAt(question.model)) this.id = undefined;
    const fresh = !this.id;
    const now = this.run.whole.map(dealDocKey).join(',');
    if (fresh) await this.keepTranscript();
    const message = this.message(turn, fresh, now);
    const system = this.mode !== 'inline' ? `${NATIVE_TOOLS}\n\n${kit.rules}` : turn.system;
    const input: TalkAsk = {
      kind: 'answer',
      model: question.model,
      ...(fresh ? { system } : { conversation: this.id }),
      prompt: message.prompt,
      ...(message.files.length ? { files: message.files } : {}),
      ...(this.mode !== 'inline' ? { tools: toolSpecs(this.width) } : {}),
      ...(message.results ? { results: message.results } : {}),
      ...(tried ? { tried } : {}),
      unusable: turn.unusable,
    };
    try {
      const talked = await kit.talk!(input, turn.keys, turn.shape);
      this.id = talked.conversation;
      if (talked.tokens !== undefined) this.tokens = talked.tokens;
      this.told = this.run.done.length;
      this.listed = this.run.opened.length;
      this.attached = now;
      this.calls = talked.calls ?? [];
      return talked.reply;
    } catch (e) {
      return this.afterFailure(e, turn, fresh, !!message.results, tried);
    }
  }

  /** the conversation as the answer leaves it, for the next question to carry on; none where the service keeps none */
  thread(): ModelThread | undefined {
    if (!this.id) return undefined;
    const { opened, gone, question } = this.run;
    const kept = [...opened.map((s) => ({ dealId: s.dealId, docId: s.rec.docId })), ...gone];
    return {
      id: this.id,
      model: question.model,
      tokens: this.tokens,
      opened: kept,
      ...(this.transcript ? { transcript: this.transcript } : {}),
      ...(this.calls[0] ? { call: this.calls[0] } : {}),
    };
  }

  /** compacted: the conversation so far goes in the store as a file, once a run, and the last one's is taken out */
  private async keepTranscript(): Promise<void> {
    const { kit, question } = this.run;
    if (this.kept || !question.transcript?.trim() || !kit.keepTranscript) return;
    this.kept = true;
    try {
      const old = this.transcript;
      this.transcript = await kit.keepTranscript(question.transcript);
      if (old && old !== this.transcript) await kit.drop?.(old).catch(() => {});
    } catch (e) {
      if (codeOf(e) === 'unreachable') throw e;   // the transcript of the last compaction still holds most of it
    }
  }

  /**
   * What the turn sends: in full in a new conversation (or on this question's first turn), else what the last tool
   * found and what is new; natively, what the last tool found is that call's result. The conversation keeps what was
   * attached to it: a document goes again only in a new conversation or a new read.
   */
  private message(turn: Turn, fresh: boolean, now: string): Message {
    const found = this.told < 0 ? '' : this.run.done.slice(this.told).join('\n\n');
    const asResult = this.mode === 'native' && !fresh && this.calls.length > 0;
    const results = asResult ? this.results(found) : undefined;
    const rest = this.newSince(turn, now);
    const prompt = fresh ? turn.full(true) : this.told < 0 ? turn.full(false) : asResult ? rest : `${found}\n\n${rest}`;
    const documents = fresh || now !== this.attached ? turn.files : [];
    const files = [...documents, ...(fresh && this.transcript ? [this.transcript] : [])];
    return { prompt, files, ...(results ? { results } : {}) };
  }

  /** the results of the model's tool calls: what the last tool found, for the first; one tool is run at a time */
  private results(found: string): { id: string; text: string }[] {
    const text = (i: number) =>
      this.told < 0 ? 'The answer was shown to the person.' : i ? 'Not run: one tool at a time.' : found;
    return this.calls.map((id, i) => ({ id, text: text(i) }));
  }

  /** what is new since the last turn besides what the last tool found: documents opened and attached, and the turn */
  private newSince(turn: Turn, now: string): string {
    const { opened, quiet } = this.run;
    const newDocs = opened.slice(this.listed).filter((s) => !quiet.has(s));
    const opensSince = newDocs.length
      ? `Documents opened since (cite them by id):\n${newDocs.map(turn.docLine).join('\n')}\n\n`
      : '';
    const attaching = now && now !== this.attached ? `Given to you whole with this message:\n${turn.listing}\n\n` : '';
    return `${opensSince}${attaching}${turn.turnLine}`;
  }

  /** a turn that failed: asked again the way the failure calls for, or thrown on */
  private async afterFailure(error: unknown, turn: Turn, fresh: boolean, hadResults: boolean, tried: number) {
    const { kit, question } = this.run;
    const code = codeOf(error);
    // tool results refused: sent as a message, in the same conversation. A 500 may be a passing error rather than a
    // refusal (North answers both with one), so it moves this answer to hybrid, and the model for the run only when it
    // comes again before the model has taken tool results
    if (code === 'tools' && hadResults) {
      const sure = [400, 422].includes((error as { status?: number })?.status as number);
      this.mode = 'hybrid';
      kit.steppedDown?.(question.model, this.mode, sure);
      return this.ask(turn, tried + 1);   // the turn's try in the conversation
    }
    if (code === 'tools' && this.mode !== 'inline') {
      // tool calls refused: the JSON block, in a new conversation
      this.mode = 'inline';
      kit.steppedDown?.(question.model, this.mode);
      this.forget();
      return this.ask(turn, tried);
    }
    if (!fresh && curable(error) && tried < (kit.retries?.() ?? 0)) {
      // a passing failure inside the conversation (decisions: Retries): the service may already hold the failed turn,
      // so it is asked again as a new conversation, in full, as when the service has lost one; that one is retried as
      // any call is, counting the tries made here, and only while the retry policy has retries (none when set to 0)
      this.forget();
      return this.ask(turn, tried + 1);
    }
    if ((code !== 'gone' && code !== 'toolong') || fresh) throw error;
    // no longer kept, or grown past what one call may send: compacted into a new one
    this.forget();
    return this.ask(turn, tried);
  }

  /** start a new conversation at the next turn */
  private forget(): void {
    this.id = undefined;
    this.tokens = 0;
    this.calls = [];
  }
}
