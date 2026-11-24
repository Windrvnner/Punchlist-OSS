export type FitSource = () => readonly string[];

type Candidates = readonly [string, string];

interface Witness {
  candidates: Candidates;
  source?: FitSource;
}

export interface FitChoice {
  first: string;
  witness?: Witness;
}

interface WaitingRows extends Witness {
  rows: Set<number>;
}

/** Rows with one candidate choose in file order, including rows made sure by an earlier choice. */
class SureRows {
  private readonly heap: number[] = [];

  add(row: number): void {
    let position = this.heap.length;
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (this.heap[parent] <= row) break;
      this.heap[position] = this.heap[parent];
      position = parent;
    }
    this.heap[position] = row;
  }

  take(): number | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (last === undefined || !this.heap.length) return first;
    let position = 0;
    while (position * 2 + 1 < this.heap.length) {
      const left = position * 2 + 1;
      const right = left + 1;
      const child = right < this.heap.length && this.heap[right] < this.heap[left] ? right : left;
      if (this.heap[child] >= last) break;
      this.heap[position] = this.heap[child];
      position = child;
    }
    this.heap[position] = last;
    return first;
  }
}

/** Two available questions prove a tie. Rows can share a watch on a list that still contains two (#264). */
class FitWorklist {
  private readonly byQuestion = new Map<string, Set<WaitingRows>>();
  private readonly bySource = new Map<FitSource, WaitingRows>();
  private readonly byRow = new Map<number, WaitingRows>();
  readonly sure = new SureRows();

  watch(row: number, choice: FitChoice | undefined): void {
    if (!choice) return;
    const witness = choice.witness;
    if (!witness) {
      this.sure.add(row);
      return;
    }
    let waiting = witness.source && this.bySource.get(witness.source);
    if (!waiting) {
      waiting = { ...witness, rows: new Set() };
      this.register(waiting);
      if (waiting.source) this.bySource.set(waiting.source, waiting);
    }
    waiting.rows.add(row);
    this.byRow.set(row, waiting);
  }

  remove(row: number): void {
    const waiting = this.byRow.get(row);
    if (!waiting) return;
    this.byRow.delete(row);
    waiting.rows.delete(row);
    if (waiting.rows.size) return;
    this.unregister(waiting);
    if (waiting.source) this.bySource.delete(waiting.source);
  }

  affected(question: string): number[] {
    const affected: number[] = [];
    const watchers = this.byQuestion.get(question);
    if (!watchers) return affected;
    this.byQuestion.delete(question);
    for (const waiting of watchers) {
      this.unregister(waiting);
      const candidates = waiting.source?.();
      if (candidates?.length === 2) {
        waiting.candidates = [candidates[0], candidates[1]];
        this.register(waiting);
        continue;
      }
      if (waiting.source) this.bySource.delete(waiting.source);
      for (const row of waiting.rows) {
        this.byRow.delete(row);
        affected.push(row);
      }
    }
    return affected;
  }

  private register(waiting: WaitingRows): void {
    for (const question of waiting.candidates) {
      const watchers = this.byQuestion.get(question) ?? new Set<WaitingRows>();
      watchers.add(waiting);
      this.byQuestion.set(question, watchers);
    }
  }

  private unregister(waiting: WaitingRows): void {
    for (const question of waiting.candidates) this.byQuestion.get(question)?.delete(waiting);
  }
}

export function matchFitTier(
  rowCount: number,
  find: (row: number) => FitChoice | undefined,
  take: (row: number, question: string) => void,
): void {
  const worklist = new FitWorklist();
  for (let row = 0; row < rowCount; row++) worklist.watch(row, find(row));

  const claim = (row: number, question: string) => {
    worklist.remove(row);
    take(row, question);
    for (const affected of worklist.affected(question)) worklist.watch(affected, find(affected));
  };
  const settle = () => {
    for (let row = worklist.sure.take(); row !== undefined; row = worklist.sure.take()) {
      const choice = find(row);
      if (choice) claim(row, choice.first);
    }
  };

  settle();
  for (let row = 0; row < rowCount; row++) {
    const choice = find(row);
    if (!choice) continue;
    claim(row, choice.first);
    settle();
  }
}
