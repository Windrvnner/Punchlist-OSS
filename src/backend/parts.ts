/**
 * Asking the model about many things a part at a time, so that each request and each reply fits the service's limits
 * (limits.ts; decisions: Cut-off output). A part starts at the size the limits allow. When a reply is cut off at the
 * output limit, what came back whole is kept, and the first thing that did not is asked about alone (and the next, if
 * that one is whole): cut off again, it is that one thing's doing, so it is set aside and the rest go on at the same size;
 * whole, the size was too big, and the rest are asked in parts half the size, down to one, a size kept for the rest of the call (`size` in the result, for the
 * caller to carry on with). Three things in a row cut off alone, with nothing whole between, end the run, and what was
 * not asked yet is handed back as such (`unasked`). A request the service refuses as too long is asked again in parts
 * half the size, and one too long even for one thing ends the run. Nothing is guessed: a thing still cut off on its own is
 * handed back as not done.
 */
import { isCutOff, isTooLong } from './limits';
import { control } from '../control';

/**
 * What one part's call gave: the results it read, by place in the part, and, when its reply was cut off, the places still
 * to ask about (those after the last entry that came back whole). Throw to stop: a cut-off or too-long error stops
 * nothing, since the part is asked again smaller; any other error ends the run.
 */
export interface PartReply<R> { got: Map<number, R>; cut?: number[] }

export interface PartsDone<R> {
  /** each thing's result, by its place in the whole list; empty where there is none */
  got: Map<number, R>;
  /** the places never answered whole: still cut off, or still too long, when asked about alone, and everything not asked after an error */
  left: number[];
  /** the places not asked at all because replies kept being cut off (see `inParts`): not cut off themselves, for the caller to ask again */
  unasked: number[];
  /** why `left` were not answered: the error that stopped the run (a request too long even for one thing stops it too), or a cut-off when only replies cut off even alone remain */
  stopped?: unknown;
  /** the part size the run ended on */
  size: number;
}

/**
 * Ask about `items` in parts of at most `size`. `ask` is given a part and answers for it (see PartReply). Parts are asked
 * in order, one at a time, and everything comes back by its place in `items`. `state`, when given, carries the count of
 * things cut off alone in a row from one call to the next (a caller keeps one per model for a run): once it has stopped
 * a call, each later one asks one part first, and unless something in it comes back whole, hands everything back as
 * unasked. The model is never dropped for the run: every call probes it again, so a service that recovers is used again
 * at once, while one that keeps cutting costs a single call each time. When the model's last word was whole, a probe part
 * with nothing whole may only have a long thing first or second, so those two are asked alone before everything is
 * handed back. `whole` says whether the model's last word was a
 * reply with something whole in it (true) or a probe with nothing whole (false).
 */
export async function inParts<I, R>(items: readonly I[], size: number, ask: (part: I[]) => Promise<PartReply<R>>, state?: { stuck: number; whole?: boolean }): Promise<PartsDone<R>> {
  let room = Math.max(1, Math.floor(size));
  let wary = !!state && state.stuck >= STUCK;                                               // an earlier call stopped: one part decides whether to go on
  // after a cut part, `cutFrom` is its size while the things not back whole are asked alone, `probes` more of them at most
  // (two: a caller may hand back the last whole entry before a cut too, to be safe, so the cause may be the second);
  // `stuck` counts things cut off alone with nothing whole between
  let cutFrom: number | undefined, probes = 0, stuck = state?.stuck ?? 0;
  // things still to ask alone after a wary part came back with nothing whole while the model's last word was whole: a long
  // thing first or second in it does that too, so the first two are asked alone before the model is taken to cut everything
  let rescue = 0;
  const got = new Map<number, R>(); const left: number[] = []; const unasked: number[] = []; let todo = items.map((_, k) => k); let stopped: unknown;
  while (todo.length) {
    const places = todo.slice(0, cutFrom !== undefined ? 1 : room);
    let r: PartReply<R>;
    try { r = await ask(places.map((k) => items[k])) }
    catch (e) {
      if (isTooLong(e)) {
        if (places.length > 1) { room = Math.ceil(places.length / 2); continue; }            // the same things, in smaller parts
        left.push(...todo); stopped = e; break;                                               // too long even alone: the rest would be too, so none is asked
      }
      if (isCutOff(e)) { r = { got: new Map(), cut: places.map((_, k) => k) }; }            // nothing in it could be kept
      else { left.push(...todo); stopped = e; break; }
    }
    for (const [k, v] of r.got) if (k >= 0 && k < places.length) got.set(places[k], v);
    const again = (r.cut ?? []).filter((k) => k >= 0 && k < places.length && !r.got.has(k)).map((k) => places[k]);
    todo = todo.slice(places.length);
    if (rescue && places.length === 1) {
      if (again.length) {                                                                     // cut off alone too: set aside, and the next asked alone
        left.push(...again); stopped ??= Object.assign(new Error('cut off'), { code: 'cutoff' });
        // both cut off alone: the rest are handed back; `whole` stands, since two long things say nothing of the model cutting every reply, and one that does never set it
        if (--rescue === 0) { unasked.push(...todo); break; }
        continue;
      }
      if (rescue < 2) { cutFrom = undefined; probes = 0; }                                   // whole after one cut off alone: that one was the cause, and the rest go on at the same size
      rescue = 0;
    }
    if (again.length < places.length) { stuck = 0; wary = false; if (state) state.whole = true; }   // something in it was dealt with whole
    else if (wary && state?.whole && places.length > 1) { wary = false; rescue = 2; }        // its first things are asked alone below, as after any cut part
    else if (wary) { if (state) state.whole = false; unasked.push(...again, ...todo); stopped ??= Object.assign(new Error('cut off'), { code: 'cutoff' }); break; }   // still nothing whole: ask no more
    if (places.length === 1 && cutFrom !== undefined) {
      // a thing asked alone after a cut part: cut off again, it was the cause, and the rest go on at the same size; whole,
      // the next is asked alone too, and once both are whole the part was too big, and the rest go on in parts half its size
      if (again.length) cutFrom = undefined;
      else if (--probes <= 0) { room = Math.max(1, Math.min(room, Math.ceil(cutFrom / 2))); cutFrom = undefined; }
    }
    if (!r.cut) continue;
    if (places.length === 1) {                                                                 // cut off even alone
      if (again.length) {
        left.push(...again); stopped ??= Object.assign(new Error('cut off'), { code: 'cutoff' });
        // several in a row and nothing whole between: replies are being cut whatever is asked, and asking on would only repeat it
        if (++stuck >= STUCK) { unasked.push(...todo); break; }
      }
      continue;
    }
    todo = [...again, ...todo]; if (again.length) { cutFrom = places.length; probes = 2; }   // what was cut off goes first, its first things alone
  }
  if (state) state.stuck = stuck;
  return { got, left: left.sort((a, b) => a - b), unasked, ...(stopped !== undefined ? { stopped } : {}), size: room };
}
/** things cut off even alone, one after another with nothing whole between, after which a run stops asking */
const STUCK = 3;

/**
 * How many things fit in one part: as many as leave a reply of `out` tokens each within `limits.partShare` (60%) of the
 * output limit, and, with `in`, a request of `in` tokens each within that share of the input limit (the rest is left for the prompt's
 * own words and any documents, which the app cannot count); never more than `cap`, never fewer than one. The estimates
 * are rough, so the margins are wide; a cut-off or a refusal still halves the size.
 */
export function partSize(o: { cap: number; out: number; outLimit: number; in?: number; inLimit?: number }): number {
  const share = control.limits.partShare / 100;
  const byOut = Math.floor((o.outLimit * share) / Math.max(1, o.out));
  const byIn = o.in && o.inLimit ? Math.floor((o.inLimit * share) / o.in) : Infinity;
  return Math.max(1, Math.min(o.cap, byOut, byIn));
}
