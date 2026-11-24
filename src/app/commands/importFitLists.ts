import { compatibleIdentifierSets, type IdentifierSig } from '../../domain/logWrite';
import type { FitSource } from './importFit';

export interface FitSignature extends IdentifierSig {
  group: string;
}

export function fitSignature(signature: IdentifierSig): FitSignature {
  return { ...signature, group: JSON.stringify([...signature.ids].sort()) };
}

export interface FitCandidate {
  id: string;
  signature: FitSignature;
}

interface IdentifierGroup {
  ids: readonly string[];
  count: number;
}

/** The same eligible questions share a source even when the rows have different OCR spellings (#264). */
export class FitLists {
  private readonly groups = new Map<string, IdentifierGroup>();
  private readonly byPlain = new Map<string, Map<string, number>>();
  private readonly matchingGroups = new Map<string, Set<string>>();
  private readonly sources = new Map<string, FitSource>();

  constructor(private readonly questions: FitCandidate[], private readonly taken: ReadonlySet<string>) {
    for (const { signature } of questions) {
      const identity = this.groups.get(signature.group) ?? { ids: signature.ids, count: 0 };
      identity.count++;
      this.groups.set(signature.group, identity);
      const exactCounts = this.byPlain.get(signature.plain) ?? new Map<string, number>();
      exactCounts.set(signature.group, (exactCounts.get(signature.group) ?? 0) + 1);
      this.byPlain.set(signature.plain, exactCounts);
    }
  }

  forRow(row: FitSignature): FitSource | undefined {
    const groups = new Set(this.groupsFor(row));
    let exact: string | undefined;
    // When an exact wording includes a whole group, share its source with rows that match that group by identifiers.
    for (const [group, count] of this.byPlain.get(row.plain) ?? []) {
      if (groups.has(group)) continue;
      if (count === this.groups.get(group)!.count) groups.add(group);
      else exact = row.plain;
    }
    if (!groups.size && exact === undefined) return undefined;
    const key = JSON.stringify([[...groups].sort(), exact]);
    let source = this.sources.get(key);
    if (!source) {
      source = this.makeSource(groups, exact);
      this.sources.set(key, source);
    }
    return source;
  }

  private groupsFor(row: FitSignature): Set<string> {
    const cached = this.matchingGroups.get(row.group);
    if (cached) return cached;
    const groups = new Set<string>();
    for (const [group, identity] of this.groups) {
      if (compatibleIdentifierSets(row.ids, identity.ids)) groups.add(group);
    }
    this.matchingGroups.set(row.group, groups);
    return groups;
  }

  private makeSource(groups: ReadonlySet<string>, exact: string | undefined): FitSource {
    let available: string[] = [];
    let next = 0;
    return () => {
      available = available.filter((id) => !this.taken.has(id));
      while (available.length < 2 && next < this.questions.length) {
        const { id, signature } = this.questions[next++];
        if (this.taken.has(id)) continue;
        if (groups.has(signature.group) || signature.plain === exact) available.push(id);
      }
      return available;
    };
  }
}
