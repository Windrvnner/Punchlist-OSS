/**
 * What the check line says while other PCs share a check with this one (docs/architecture.md, Checks, and how PCs share
 * them). Another PC is named by the person signed in at it, as whoami gives it ("jdoe"); when two PCs in the check have
 * the same person name (two people of that name, or one person on two PCs), the device id is added: "jdoe (LAPTOP-7Q4M)".
 * More than one other is "three others", and who they are is shown on hover (`who`).
 */
import { SERVICE } from '../control';
import type { CheckState, Someone } from '../ports';
import type { State } from './state';
import type { Store } from './store';

/** Follow a local or shared check while the caller is showing it. */
export function watchCheck(store: Pick<Store, 'get' | 'subscribe' | 'refreshChecked'>, dealId: string): () => void {
  let busy = false;
  let shared = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const update = (state: State) => {
    const check = state.checks[dealId];
    const nextBusy = !!check?.busy;
    const nextShared = !!check?.checking;
    if (nextBusy === busy && nextShared === shared) return;
    busy = nextBusy;
    shared = nextShared;
    clearInterval(timer);
    if (busy || shared) timer = setInterval(() => void store.refreshChecked(dealId), 3000);
  };
  const unsubscribe = store.subscribe(update);
  update(store.get());
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const count = (n: number) => WORDS[n] ?? String(n);
/** a PC as the person is told of it: the person, with the device id when it is needed to tell two apart; the device id alone when no person is known */
export const nameOf = (x: Someone) => (!x.who ? x.pc : x.same ? `${x.who} (${x.pc})` : x.who);
/** names in a sentence: "A", "A and B", "A, B and C" */
export const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** "2:05 PM", with a no-break space so a wrapped line never leaves "PM" on its own */
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s(?=[AP]M$)/, '\u00a0');

/**
 * The line, and the names behind "others" for the hover, or null when there is nothing to add to the plain "Checking …".
 * In order: waiting for sign-in, retrying after a failure, a PC that stopped responding, waiting behind another PC's check,
 * checking with others. A part that waits names why, so the line never says the service is out of reach when it is the
 * sign-in that is missing.
 */
export function checkingSays(c: CheckState['checking'] | undefined, deep = false): { text: string; who?: string } | null {
  if (!c) return null;
  if (c.signIn) return { text: `Waiting for ${SERVICE} sign-in. The check resumes once someone signs in` };
  if (c.retryUntil) return { text: `${SERVICE} can’t be reached. Retrying until ${time(c.retryUntil)}` };
  if (c.away) return { text: `${SERVICE} can’t be reached. The check resumes once ${SERVICE} is back` };
  if (c.quiet.length === 1) { const q = c.quiet[0]; return { text: `${!q.who ? q.pc : q.same ? `${q.who}’s PC ${q.pc}` : `${q.who}’s PC`} stopped responding at ${time(q.since)}. This PC is taking over its share` }; }
  if (c.quiet.length > 1) { const n = count(c.quiet.length); return { text: `${n.charAt(0).toUpperCase()}${n.slice(1)} other PCs stopped responding. This PC is taking over their share`, who: listOf(c.quiet.map(nameOf)) }; }
  if (c.waitingFor) { const w = c.waitingFor; return { text: !w.who ? `Waiting for the check on ${w.pc} to finish` : w.same ? `Waiting for ${w.who}’s check on ${w.pc} to finish` : `Waiting for ${w.who}’s check to finish` }; }
  const what = `Checking the checklist and findings${deep ? ' in depth' : ''}`;
  if (c.with.length === 1) return { text: `${what} with ${nameOf(c.with[0])}` };
  if (c.with.length > 1) return { text: `${what} with ${count(c.with.length)} others`, who: listOf(c.with.map(nameOf)) };
  return null;
}
