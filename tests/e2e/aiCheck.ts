/**
 * The AI check: sign in, list the models, upload a small file, ask a question about it, delete the file. It runs on any
 * model service behind the shared interface (src/backend/service.ts), whichever backend the control file can choose:
 * on stand-ins in tests/e2e/ai-check.test.ts, and on a live service in tests/e2e/ai-check-live.test.ts
 * (`npm run ai:check -- <backend>`). Each step says what it found. `word` is the code word to look for (random unless given).
 */
import type { ModelService } from '../../src/backend/service';

export async function aiCheck(svc: ModelService & { agentTools?(): Promise<string[]> }, say: (line: string) => void = () => {}, word = `proseware-${Math.random().toString(36).slice(2, 8)}`) {
  // the free sign-in check first, where the service has one, so a refused key fails here and not at the upload
  if (svc.checkSignIn) { await svc.checkSignIn(); say('The service accepts the key'); }
  // a service that cannot say who is signed in is not a failure: the app shows the PC's signed-in user instead
  let who = '';
  try { who = (await svc.whoami()).name; say(`Signed in as ${who || '(no name)'}`); } catch (e) { say(`Signed in; the service does not name the person (${(e as Error).message})`); }
  const m = await svc.models(); say(`Models: ${m.models.map((x) => x.id).join(', ')}; fast ${m.fast}, standard ${m.standard}, thorough ${m.thorough}`);
  const id = await svc.upload({ name: 'doc_000000000000000000000000__Punchlist check.txt', bytes: new TextEncoder().encode(`Punchlist connection check.\nThe code word is ${word}.\n`) });
  say(`Uploaded a small file: ${id}`);
  let reply = '';
  try {
    reply = await svc.complete({ model: m.fast, system: 'Answer with the code word only.', prompt: 'What is the code word in the attached file?', files: [id] });
    say(`Asked about it on ${m.fast}: ${reply.trim().slice(0, 200)}`);
  } finally {
    await svc.remove(id); say('Deleted the file');
  }
  const gone = !(await svc.list()).some((f) => f.id === id);
  // the service's own tools that its agents use, where it has them (North: the names that go in north.hostedTools, so a call with tools still reads its files)
  if (svc.agentTools) { try { const t = await svc.agentTools(); say(`The service's own tools on your agents: ${t.join(', ') || 'none shown'}`); } catch (e) { say(`The service's own tools could not be listed: ${(e as Error).message}`); } }
  return { who, models: m.models.length, found: reply.includes(word), gone };
}
