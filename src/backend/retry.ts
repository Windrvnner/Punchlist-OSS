/**
 * Every AI call is asked again, quietly, before a failure is shown (decisions: Retries).
 * One policy for every feature, applied where the backend calls
 * the model service (ai.ts: `complete` and `converse`), so drafting, checks, imports, search, the memo and chat all get it.
 *
 * What is asked again: a call that failed for a reason sending it again can cure (a server error, a reply that could not
 * be read off the wire, a refusal), and a reply with nothing in it. Up to `limits.aiRetries` times, waiting
 * `timings.aiRetryWait` before the first and twice as long before each next one.
 *
 * What is not, because it has a path of its own: a service that cannot be reached (`code: 'unreachable'`: each connector
 * has already waited out a busy service, and the checks and the start screen wait for it and carry on later), a reply cut
 * off or a request too long (asked again in smaller parts), a conversation the service no
 * longer has, a search out of calls, a sign-in that is waited for, and a request the service rejected (a 4xx status:
 * the same request would be rejected again). In a chat, only a turn that begins a conversation is asked again (ai.ts).
 * Every call gets its retries, however many calls before it failed (#1057).
 */
import { control } from '../control';

export interface RetryOptions {
  /** how many times a call is asked again (control: limits.aiRetries) */
  retries?: number;
  /** the wait before the first retry; it doubles each time (control: timings.aiRetryWait) */
  waitMs?: number;
  /** for tests: how the wait is waited */
  sleep?: (ms: number) => Promise<void>;
}

/** whether sending a failed call again could cure it (above: what is not asked again, and why) */
export function curable(e: unknown): boolean {
  const x = (e ?? {}) as { code?: unknown; status?: unknown; signedOut?: unknown };
  if (x.signedOut) return false;
  if (x.code !== undefined) return false;                                        // unreachable, cutoff, toolong, gone, spent, tools: each has its own path
  if (typeof x.status === 'number' && x.status >= 400 && x.status < 500) return false;
  return true;
}

/**
 * The retry policy. `go` makes one try. `empty` says whether a reply has nothing in it; after the last try an empty
 * reply is returned as it is, for the caller to treat as it always has.
 */
export function retrier(o: RetryOptions = {}) {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** how many times a failed call is asked again: the same for every call */
  const retries = () => o.retries ?? control.limits.aiRetries;
  /** `tried`: tries this call has already had elsewhere */
  async function retried<T>(go: () => Promise<T>, empty: (reply: T) => boolean = () => false, tried = 0): Promise<T> {
    const wait = o.waitMs ?? control.timings.aiRetryWait;
    const tries = Math.max(1, 1 + retries() - tried);
    // its try elsewhere failed: this one is its retry, and waits as one
    if (tried > 0 && retries() > 0) await sleep(wait * 2 ** Math.min(tried - 1, 2));
    for (let i = 0; ; i++) {
      try {
        const reply = await go();
        if (!empty(reply) || i + 1 >= tries) return reply;
      } catch (e) {
        if (!curable(e)) throw e;
        if (i + 1 >= tries) throw e;
      }
      await sleep(wait * 2 ** Math.min(i + tried, 2));                             // 2, 4, then 8 seconds at most between tries
    }
  }
  return Object.assign(retried, { retries });
}
