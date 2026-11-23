/**
 * Liveness of the PCs working a deal's rounds (see rounds.ts): the one thing about a round that is not read from the
 * lines, since each PC judges it by its own clock.
 */
import type { RLine } from './rounds';

/** the round a line did a piece's work in, if it did any */
export const roundOfWork = (line: RLine) =>
  (line.item && line.result ? line.round : undefined) ??
  line.glanced?.round ??
  line.verified?.round ??
  line.sample?.round ??
  line.skipped?.round;
/** how many lines a PC has written, and when this PC saw that count change */
type Seen = { count: number; at: number };

/**
 * Liveness, judged by this PC's own clock: when it last saw each PC's lines grow, and each PC's lines in a round.
 * What it saw is kept in this PC's local folder, so after a restart a PC that went quiet long ago gets no fresh grace.
 */
export class Observer {
  private seen = new Map<string, Seen>();
  private progress = new Map<string, Seen>();
  private joined = new Map<string, number>();
  private dirty = false;
  constructor(
    private now: () => number,
    private keep?: { read(): string | null; write(text: string): void },
  ) {
    this.load();
  }
  /** what this PC saw before it last stopped; a damaged record is passed over, and this PC starts afresh */
  private load() {
    try {
      const text = this.keep?.read();
      if (!text) return;
      for (const [pc, seen] of Object.entries(JSON.parse(text) as Record<string, Seen>)) {
        if (typeof seen?.count === 'number' && typeof seen?.at === 'number') this.seen.set(pc, seen);
      }
    } catch {
      // starts afresh
    }
  }
  /**
   * Look at the deal's lines. With `frozen`, nothing ages: a PC out of touch keeps its view of the others as it last
   * saw them in touch.
   */
  observe(lines: RLine[], frozen = false) {
    const now = this.now();
    const { byPc, work } = this.tally(lines, now);
    for (const [pc, count] of byPc) {
      const seen = this.seen.get(pc);
      if (seen && seen.count === count) continue;
      this.seen.set(pc, { count, at: frozen && seen ? seen.at : now });
      this.dirty = true;
    }
    for (const [key, count] of work) {
      const seen = this.progress.get(key);
      if (!seen || seen.count !== count) this.progress.set(key, { count, at: now });
    }
    // out of touch: nobody goes quiet in this PC's eyes
    if (frozen) for (const seen of this.seen.values()) seen.at = Math.max(seen.at, now - 1);
    this.save();
  }
  /**
   * how many lines each PC wrote, and how many piece lines each wrote in each round; notes when a PC first joined a
   * round
   */
  private tally(lines: RLine[], now: number) {
    const byPc = new Map<string, number>();
    const work = new Map<string, number>();
    for (const line of lines) {
      if (!line.pc) continue;
      byPc.set(line.pc, (byPc.get(line.pc) ?? 0) + 1);
      const round = roundOfWork(line);
      if (round) {
        const key = `${round}\u0000${line.pc}`;
        work.set(key, (work.get(key) ?? 0) + 1);
      }
      if (line.member) {
        const key = `${line.member.round}\u0000${line.member.pc}`;
        if (!this.joined.has(key)) this.joined.set(key, now);
      }
    }
    return { byPc, work };
  }
  private save() {
    if (!this.dirty || !this.keep) return;
    try {
      this.keep.write(JSON.stringify(Object.fromEntries(this.seen)));
      this.dirty = false;
    } catch {
      // kept next time
    }
  }
  /** since when this PC has seen nothing new from `pc` (by this PC's clock); undefined if it has never seen it */
  quietSince(pc: string) {
    return this.seen.get(pc)?.at;
  }
  live(pc: string, lapse: number) {
    const seen = this.seen.get(pc);
    return !!seen && this.now() - seen.at < lapse;
  }
  /**
   * when this PC last saw `pc` write a piece line in the round, or first saw it join the round, whichever is later:
   * renewals alone do not count as work
   */
  lastWork(round: string, pc: string) {
    const key = `${round}\u0000${pc}`;
    return Math.max(this.progress.get(key)?.at ?? 0, this.joined.get(key) ?? 0);
  }
}
