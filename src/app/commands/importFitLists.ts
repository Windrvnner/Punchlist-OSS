import type { IdentifierSig } from '../../domain/logWrite';
import type { FitSource } from './importFit';
import { FitIdentityIndex, includeGroup, includesGroup } from './importFitIdentities';

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
  index: number;
}

/** The same eligible questions share a source even when the rows have different OCR spellings (#264). */
export class FitLists {
  private readonly groups = new Map<string, IdentifierGroup>();
  private readonly byPlain = new Map<string, Map<string, number>>();
  private readonly matchingGroups = new Map<string, Uint32Array>();
  private readonly sources = new Map<string, FitSource>();
  private readonly identities: FitIdentityIndex;

  constructor(private readonly questions: FitCandidate[], private readonly taken: ReadonlySet<string>) {
    for (const { signature } of questions) {
      const identity = this.groups.get(signature.group) ?? { ids: signature.ids, count: 0, index: this.groups.size };
      identity.count++;
      this.groups.set(signature.group, identity);
      const exactCounts = this.byPlain.get(signature.plain) ?? new Map<string, number>();
      exactCounts.set(signature.group, (exactCounts.get(signature.group) ?? 0) + 1);
      this.byPlain.set(signature.plain, exactCounts);
    }
    this.identities = new FitIdentityIndex([...this.groups.values()].map((group) => group.ids));
  }

  forRow(row: FitSignature): FitSource | undefined {
    const matched = this.groupsFor(row);
    let groups = matched;
    let exact: string | undefined;
    // When an exact wording includes a whole group, share its source with rows that match that group by identifiers.
    for (const [key, count] of this.byPlain.get(row.plain) ?? []) {
      const group = this.groups.get(key)!;
      if (includesGroup(groups, group.index)) continue;
      if (count === group.count) {
        if (groups === matched) groups = matched.slice();
        includeGroup(groups, group.index);
      } else exact = row.plain;
    }
    if (exact === undefined && !groups.some((word) => word !== 0)) return undefined;
    const key = JSON.stringify([groups.join(','), exact]);
    let source = this.sources.get(key);
    if (!source) {
      source = this.makeSource(groups, exact);
      this.sources.set(key, source);
    }
    return source;
  }

  private groupsFor(row: FitSignature): Uint32Array {
    const cached = this.matchingGroups.get(row.group);
    if (cached) return cached;
    const groups = this.identities.compatible(row.ids);
    this.matchingGroups.set(row.group, groups);
    return groups;
  }

  private makeSource(groups: Uint32Array, exact: string | undefined): FitSource {
    let available: string[] = [];
    let next = 0;
    return () => {
      available = available.filter((id) => !this.taken.has(id));
      while (available.length < 2 && next < this.questions.length) {
        const { id, signature } = this.questions[next++];
        if (this.taken.has(id)) continue;
        const index = this.groups.get(signature.group)!.index;
        if (includesGroup(groups, index) || signature.plain === exact) available.push(id);
      }
      return available;
    };
  }
}
