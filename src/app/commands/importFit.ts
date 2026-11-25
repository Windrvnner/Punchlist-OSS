/** The question a list would give now, and two available ones if it has that many (they prove a tie). */
export interface FitView {
  best?: string;
  tie?: Candidates;
}

export type FitSource = () => FitView;

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

/** Two available questions prove a tie. Rows can share a watch on a list that still contains two (#264). */
class FitWorklist {
  private readonly byQuestion = new Map<string, Set<WaitingRows>>();
  private readonly bySource = new Map<FitSource, WaitingRows>();
  private readonly byRow = new Map<number, WaitingRows>();
  private sure: number[] = [];

  takeSure(): number[] {
    const rows = this.sure;
    this.sure = [];
    return rows.sort((left, right) => left - right);
  }

  watch(row: number, choice: FitChoice | undefined): void {
    if (!choice) return;
    const witness = choice.witness;
    if (!witness) {
      this.sure.push(row);
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
      const tie = waiting.source?.().tie;
      if (tie) {
        waiting.candidates = tie;
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
    // Finish each pass before giving rows made sure by those choices a turn in file order.
    for (let rows = worklist.takeSure(); rows.length; rows = worklist.takeSure()) {
      for (const row of rows) {
        const choice = find(row);
        if (choice) claim(row, choice.first);
      }
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
