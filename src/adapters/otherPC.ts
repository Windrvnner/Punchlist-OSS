/**
 * Another PC writing to the shared folder, for the browser demo's test hooks (`window.__peer` in shell/main.tsx) and for
 * tests. It appends lines to change files under an install id of its own, made from its name, as a real PC does, so the
 * repository reads its changes as it reads any other PC's (backend/logRepository.ts, backend/changeLog.ts). Nothing here
 * changes what is stored by any other means; the repository takes the lines in at its next look (`sync`).
 */
import { Combined, isLine, type Line } from '../backend/changeLog';
import type { Folder } from '../backend/logRepository';
import { CURRENT_SCHEMA, type RecordKind } from '../domain/model';

/** who made a change, on which PC (by its name), and when */
export interface Who { by: string; from: string; at: string }
const CHANGES = /^changes-.+\.jsonl$/;
/** the install id of the PC of this name */
const idOf = (from: string) => `pc-${from.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other'}`;
/** stands for a line that has not arrived (see `hold`): a record of a kind the app never reads from the shared folder, so only the wait it causes shows */
const held = (dealId: string) => `${dealId}~held`;

export class OtherPC {
  constructor(private shared: Folder) {}

  private lines(): Line[] {
    const out: Line[] = [];
    for (const n of this.shared.list()) if (CHANGES.test(n)) for (const raw of (this.shared.read(n) ?? '').split('\n')) { try { const x = JSON.parse(raw); if (isLine(x)) out.push(x); } catch { /* not a whole line */ } }
    return out;
  }
  private view() { const v = new Combined(); for (const l of this.lines()) v.add(l); return v; }
  private nextSeq(pc: string) { return Math.max(0, ...this.lines().filter((l) => l.pc === pc).map((l) => l.seq)) + 1; }
  /** Append one line from this PC, to the deal's file (or the general one): `make` is given the line's number. */
  private write(who: Who, deal: string | undefined, make: (seq: number, pc: string) => Partial<Line>, seq?: number): Line {
    const pc = idOf(who.from); const n = seq ?? this.nextSeq(pc);
    const line: Line = { v: 1, schema: CURRENT_SCHEMA, pc, seq: n, at: who.at, by: who.by, from: who.from, recs: [], ...make(n, pc) };
    const part = deal && /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(deal) ? deal : '_';
    this.shared.append(`changes-${pc}-${part}-0001.jsonl`, JSON.stringify(line) + '\n');
    return line;
  }
  /** What a PC that has not seen this PC's latest change had in front of it: whatever the current versions were based on. */
  private knew(v: Combined, kind: RecordKind, id: string) { return [...new Set(v.state(kind, id).tips.flatMap((t) => v.version(t)?.base ?? []))]; }
  private dealOf(v: Combined, kind: RecordKind, id: string, data?: unknown) {
    return kind === 'deal' ? undefined : (data as { dealId?: string } | undefined)?.dealId ?? (v.state(kind, id).heads[0]?.data as { dealId?: string } | undefined)?.dealId;
  }
  private missing(v: Combined, kind: RecordKind, id: string) { const h = v.state(kind, id).heads; return !h.length || (h.length === 1 && !!h[0].del); }

  /**
   * A change to an existing record, made without knowledge of this PC's latest version of it. Content that is the same as
   * the version here is not a clash; anything else stands beside it, on that record only, until a person chooses.
   */
  edit(kind: RecordKind, id: string, data: unknown, who: Who): 'same' | 'conflict' | 'missing' {
    const v = this.view(); if (this.missing(v, kind, id)) return 'missing';
    const base = this.knew(v, kind, id);
    v.add(this.write(who, this.dealOf(v, kind, id, data), (seq, pc) => ({ recs: [{ kind, id, ver: `${pc}.${seq}.0`, base, data, schema: CURRENT_SCHEMA }] })));
    return v.state(kind, id).heads.length > 1 ? 'conflict' : 'same';
  }
  /** An ordinary change to an existing record, made after this PC's latest version of it had arrived, by a build whose records have `schema`. */
  change(kind: RecordKind, id: string, data: unknown, who: Who, schema = CURRENT_SCHEMA) {
    const v = this.view(); const base = v.state(kind, id).tips;
    this.write(who, this.dealOf(v, kind, id, data), (seq, pc) => ({ schema, recs: [{ kind, id, ver: `${pc}.${seq}.0`, base, data, schema }] }));
  }
  /** A delete made without knowledge of this PC's latest version: both stand until a person chooses. */
  remove(kind: RecordKind, id: string, who: Who): 'conflict' | 'missing' {
    const v = this.view(); if (this.missing(v, kind, id)) return 'missing';
    const base = this.knew(v, kind, id); const dealId = this.dealOf(v, kind, id);
    // as the app does: a question or finding deleted leaves a deletion note in the same line, holding the record as that PC had it
    const had = base.map((b) => v.version(b)).find((x) => x && !x.del)?.data as { text?: string; title?: string } | undefined;
    const note = had && (kind === 'question' || kind === 'finding') && dealId ? { kind, dealId, id, title: String(had.text ?? had.title ?? '').slice(0, 120), at: who.at, actor: who.by, snapshot: had } : null;
    this.write(who, dealId, (seq, pc) => ({ recs: [{ kind, id, ver: `${pc}.${seq}.0`, base, del: true }, ...(note ? [{ kind: 'tombstone' as RecordKind, id, ver: `${pc}.${seq}.1`, base: v.bases('tombstone', id), data: note, schema: CURRENT_SCHEMA }] : [])],
      ...(note && dealId ? { index: { dealId, remove: [{ kind, id }], add: [{ kind: 'tombstone' as RecordKind, id }] } } : {}) }));
    return 'conflict';
  }
  /** A record created on this PC, filed under its deal. */
  create(kind: RecordKind, id: string, data: unknown, dealId: string, who: Who) {
    this.write(who, dealId, (seq, pc) => ({ recs: [{ kind, id, ver: `${pc}.${seq}.0`, base: [], data, schema: CURRENT_SCHEMA }], index: { dealId, add: [{ kind, id }] } }));
  }
  /**
   * A person deletes a whole deal on this PC (DeleteDeal): the deal and everyone's place on it go, with everything filed under
   * it. `seen` is what this PC had taken in of everyone's changes (Line.seen): by default all that is in the shared folder
   * now; less stands for changes still on their way here, which their own PC then keeps as a copy.
   */
  deleteDeal(dealId: string, who: Who, seen?: Line['seen']) {
    const v = this.view(); const live = (kind: RecordKind, id: string) => v.state(kind, id).heads.some((h) => !h.del);
    const members = v.ids('member').filter((id) => id.startsWith(`m_${dealId}_`) && live('member', id));
    this.write(who, undefined, (seq, pc) => ({
      recs: [{ kind: 'deal' as const, id: dealId, base: v.state('deal', dealId).tips }, ...members.map((id) => ({ kind: 'member' as const, id, base: v.state('member', id).tips }))].map((r, i) => ({ ...r, ver: `${pc}.${seq}.${i}`, del: true as const })),
      index: { dealId: '_', remove: [{ kind: 'deal', id: dealId }], add: [{ kind: 'tombstone', id: dealId }] }, purge: dealId, seen: seen ?? v.seenNow(),
    }));
  }
  /** A line that changes nothing: the other PCs learn this one's name, who uses it and when it last wrote. */
  seen(who: Who) { this.write(who, undefined, () => ({})); }
  /**
   * A change to a deal that depends on one of this PC's that has not arrived: it is held back wherever it is read, and the
   * PC that reads it shows it is waiting, until `release` delivers the missing line. Its number is skipped meanwhile, as a
   * line still syncing leaves a gap.
   */
  hold(dealId: string, who: Who) {
    if (this.holding().includes(dealId)) return;
    const pc = idOf(who.from); const gap = this.nextSeq(pc);
    this.write(who, dealId, () => ({ recs: [{ kind: 'op', id: held(dealId), ver: `${pc}.${gap + 1}.0`, base: [`${pc}.${gap}.0`], data: { dealId } }] }), gap + 1);
  }
  /** The line a held deal was waiting for arrives. */
  release(dealId: string) {
    const v = this.view();
    for (const { line, missing } of v.waiting()) if (line.recs.some((r) => r.kind === 'op' && r.id === held(dealId))) for (const b of missing) {
      this.write({ by: line.by, from: line.from, at: line.at }, dealId, () => ({ recs: [{ kind: 'op', id: held(dealId), ver: b, base: [], data: { dealId } }] }), Number(b.split('.')[1]));
    }
  }
  /** the deals held by `hold` and not yet released */
  holding(): string[] { return this.view().waiting().flatMap(({ line }) => line.recs.filter((r) => r.kind === 'op' && r.id.endsWith('~held')).map((r) => r.id.slice(0, -'~held'.length))); }
}
