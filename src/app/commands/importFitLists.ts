import { sameIdentifiers, type IdentifierSig } from '../../domain/logWrite';
import type { FitSource } from './importFit';

export interface FitSignature extends IdentifierSig {
  /** The row's identifiers in a fixed order: rows with the same group fit the same questions. */
  group: string;
}

export function fitSignature(signature: IdentifierSig): FitSignature {
  return { ...signature, group: JSON.stringify([...signature.ids].sort()) };
}

export interface FitCandidate {
  id: string;
  signature: FitSignature;
}

/** Candidate lists for one bucket of questions, one shared source per identifier group of rows (#264). */
export class FitLists {
  private readonly sources = new Map<string, FitSource>();

  private readonly plains: ReadonlySet<string>;

  constructor(private readonly questions: FitCandidate[], private readonly taken: ReadonlySet<string>) {
    this.plains = new Set(questions.map(({ signature }) => signature.plain));
  }

  /**
   * Rows share a source when they fit the same questions: the same identifiers, and the same spelling when a
   * question here reads exactly as the row does (an identical spelling fits whatever its identifiers).
   */
  forRow(row: FitSignature): FitSource {
    const key = this.plains.has(row.plain) ? `${row.group}\0${row.plain}` : row.group;
    let source = this.sources.get(key);
    if (!source) {
      source = this.makeSource(row);
      this.sources.set(key, source);
    }
    return source;
  }

  /**
   * The first untaken question that names the row's identifiers is the pick. The tie is proved by the last two, so
   * the questions rows take first (the earliest) do not wake every row waiting on this list.
   */
  private makeSource(row: FitSignature): FitSource {
    let head = 0;
    let tail = this.questions.length;
    let tails: string[] = [];
    const fits = ({ id, signature }: FitCandidate) => !this.taken.has(id) && sameIdentifiers(row, signature);
    return () => {
      while (head < this.questions.length && !fits(this.questions[head])) head++;
      if (head >= this.questions.length) return {};
      tails = tails.filter((id) => !this.taken.has(id));
      while (tails.length < 2 && tail > 0) {
        const candidate = this.questions[--tail];
        if (fits(candidate)) tails.push(candidate.id);
      }
      const best = this.questions[head].id;
      return tails.length === 2 ? { best, tie: [tails[0], tails[1]] } : { best };
    };
  }
}
