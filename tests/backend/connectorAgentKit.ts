// The same chat agent and PDF fixture for the Claude and OpenAI-compatible connectors.
import { nodeAi, type AiOptions } from '../../src/backend/ai';
import type { ModelService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo, Mem } from '../adapters/memRepo';

const DOCUMENT = {
  docId: 'doc_1', hash: 'h', name: 'Credit Agreement.pdf', folder: 'vdr', rel: 'Credit Agreement.pdf',
  size: 1, pages: 3,
};
const PDF = '%PDF-1.7 The lock-up ratio is 1.25x.';
const CLOCK = () => '2026-11-16T09:00:00.000Z';
export const AGENT_ANSWER = `Read: ${PDF}`;
export const SEARCH_RESULT = 'You searched documents for “ratio”';
export const HYBRID_RESULT = 'Its result is in the message that follows.';

export type SeenTurn = { system: string; said: string; files: string; tools: boolean };

export function agentReply(seen: SeenTurn) {
  if (!seen.system.includes('You work in turns')) return { text: '{"text": "", "sources": []}' };
  const reply = seen.said.includes(SEARCH_RESULT)
    ? { text: `Read: ${seen.files || 'nothing'}`, sources: [] }
    : { tool: 'search', what: 'documents', query: 'ratio' };
  if (!seen.tools) return { text: JSON.stringify(reply) };
  const { tool, ...args } = reply;
  return { call: { name: tool ?? 'answer', args } };
}

export function answerOn(service: ModelService, mode: NonNullable<AiOptions['toolCalls']>) {
  const ai = nodeAi({
    service,
    docs: {
      records: () => [DOCUMENT],
      wanted: async () => [{
        docId: DOCUMENT.docId, name: DOCUMENT.name, read: () => new TextEncoder().encode(PDF),
      }],
    },
    keeper: new StoreKeeper(service, new Mem(), { recheckMs: 0, clock: CLOCK }),
    repo: memRepo(CLOCK),
    clock: CLOCK,
    toolCalls: mode,
  });
  return ai.answer({
    dealId: 'd1', message: 'What is the lock-up ratio?', history: [], model: 'standard',
    attachments: [{ doc: DOCUMENT.name, docId: DOCUMENT.docId }],
  });
}
