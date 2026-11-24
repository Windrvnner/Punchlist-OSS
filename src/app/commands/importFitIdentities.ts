function counts(ids: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const id of ids) result.set(id, (result.get(id) ?? 0) + 1);
  return result;
}

export function includesGroup(groups: Uint32Array, group: number): boolean {
  return (groups[group >>> 5] & (1 << (group % 32))) !== 0;
}

export function includeGroup(groups: Uint32Array, group: number): void {
  groups[group >>> 5] |= 1 << (group % 32);
}

/** One bit per identifier inventory. Each mask selects groups with at least that many copies of an identifier. */
export class FitIdentityIndex {
  private readonly all: Uint32Array;
  private readonly byIdentifier = new Map<string, Uint32Array[]>();

  constructor(groups: readonly (readonly string[])[]) {
    const words = Math.ceil(groups.length / 32);
    this.all = new Uint32Array(words).fill(0xffffffff);
    const partial = groups.length % 32;
    if (partial) this.all[words - 1] >>>= 32 - partial;
    for (const [group, ids] of groups.entries()) {
      for (const [id, count] of counts(ids)) {
        const levels = this.byIdentifier.get(id) ?? [];
        while (levels.length < count) levels.push(new Uint32Array(words));
        for (let level = 0; level < count; level++) includeGroup(levels[level], group);
        this.byIdentifier.set(id, levels);
      }
    }
  }

  /** The sameIdentifiers subset rule, applied to all groups together, including repeated identifiers. */
  compatible(ids: readonly string[]): Uint32Array {
    if (!ids.length) return this.all.slice();
    const wanted = counts(ids);
    const noExtras = this.all.slice();
    let excludesGroup = false;
    for (const [id, levels] of this.byIdentifier) {
      const extras = levels[wanted.get(id) ?? 0];
      if (!extras) continue;
      for (let word = 0; word < noExtras.length; word++) noExtras[word] &= ~extras[word];
      excludesGroup = true;
    }
    if (!excludesGroup) return noExtras;

    const allWanted = this.all.slice();
    for (const [id, count] of wanted) {
      const present = this.byIdentifier.get(id)?.[count - 1];
      if (!present) return noExtras;
      for (let word = 0; word < allWanted.length; word++) allWanted[word] &= present[word];
    }
    for (let word = 0; word < noExtras.length; word++) noExtras[word] |= allWanted[word];
    return noExtras;
  }
}
