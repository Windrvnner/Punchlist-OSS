/**
 * What the backend gives the third-party reports sweep (reports.ts): the deal's findings as the sweep compares a report
 * with them, the writes it makes to them, the documents it may read, and when it runs.
 */
import type { Repository } from '../ports';
import type { Source } from '../domain/model';
import { derivedId } from '../domain/derivedId';
import type { DocRecord } from './documents';
import { families, inPrecedents } from './families';
import { type Known, type Issue, reportTitleKey, sameReportIssue } from './reportTypes';

/** what the finding writes need beside the store */
export interface FindingWrites {
  repo: Repository;
  clock: () => string;
  /** tell the app a finding was written, so it shows without a refresh */
  announce?: (kind: 'finding', id: string) => void;
}

const failed = (r: { ok: false; error: { message: string } }) => new Error(r.error.message);

interface StoredFinding {
  id?: string;
  title?: string;
  status?: string;
  body?: string[];
  sources?: Source[];
  reportIssueSignature?: string;
}

function issueEvidence(data: unknown): Pick<Known, 'signature' | 'unsigned'> {
  const { title, body, sources, reportIssueSignature } = data as StoredFinding;
  if (reportIssueSignature !== undefined) return { signature: reportIssueSignature };
  if (typeof title === 'string' && Array.isArray(body) && Array.isArray(sources) && sources.every(Boolean)) {
    return { unsigned: { title, body, sources } };
  }
  return {};
}

/** The deal's findings, open, closed and deleted, as a report's issues are compared with them. Throws when unread. */
export async function knownFindings(repo: Repository, dealId: string): Promise<Known[]> {
  const held = await repo.list('finding', dealId);
  if (!held.ok) throw failed(held);
  const notes = await repo.list('tombstone', dealId);
  if (!notes.ok) throw failed(notes);
  const live: Known[] = [];
  for (const l of held.value) {
    const d = l.envelope.data as StoredFinding;
    if (typeof d.id !== 'string' || typeof d.title !== 'string') continue;
    live.push({
      id: d.id, title: d.title, ...issueEvidence(d),
      ...(d.status === 'closed' ? { closed: true } : {}),
    });
  }
  // a finding a person deleted: an issue it covers is not raised again
  type Note = { kind?: string; snapshot?: StoredFinding };
  const gone: Known[] = [];
  for (const l of notes.value) {
    const d = l.envelope.data as Note;
    const { id, title } = d.snapshot ?? {};
    const isFinding = (d.kind ?? 'finding') === 'finding';
    if (isFinding && typeof id === 'string' && typeof title === 'string') {
      gone.push({
        id, title, ...issueEvidence(d.snapshot), deleted: true,
      });
    }
  }
  return [...live, ...gone];
}

/** the saved version of a finding a person deleted */
async function deletedFinding(repo: Repository, dealId: string, id: string) {
  const notes = await repo.list('tombstone', dealId);
  if (!notes.ok) return undefined;
  return notes.value.map(({ envelope }) => (envelope.data as { snapshot?: StoredFinding }).snapshot)
    .find((snapshot) => snapshot?.id === id);
}

/**
 * Write a new finding for an advisor's issue under its fixed id. True when it is there: written now, by another PC, or
 * by this one before a restart. One a person deleted is not written again.
 */
export async function raiseFinding(w: FindingWrites, dealId: string, id: string, f: Issue): Promise<boolean> {
  const had = await w.repo.get('finding', id);
  if (had.ok && had.value) return sameReportIssue(issueEvidence(had.value.envelope.data), f);
  const deleted = await deletedFinding(w.repo, dealId, id);
  if (deleted) return sameReportIssue(issueEvidence(deleted), f);
  const now = w.clock();
  const data = {
    id, dealId, rev: 0, createdAt: now, updatedAt: now,
    title: f.title, workstream: f.workstream, status: 'open', raisedAt: now,
    body: f.body, sources: f.sources,
    origin: 'ai', note: '', reviewed: null, updated: false,
    ...(f.earlier ? { earlier: f.earlier } : {}),
    ...(f.signature ? { reportIssueSignature: f.signature } : {}),
  };
  const index = { dealId, add: [{ kind: 'finding' as const, id }] };
  const wrote = await w.repo.transaction({ writes: [{ kind: 'finding', id, data, expectedRev: null }], index });
  if (!wrote.ok) {
    const again = await w.repo.get('finding', id);
    return !!(again.ok && again.value && sameReportIssue(issueEvidence(again.value.envelope.data), f));
  }
  w.announce?.('finding', id);
  return true;
}

/** a source's place, as two sources are told apart */
const placeOf = (x: Source) => `${x.docId ?? x.doc}|${String(x.loc).replace(/\$/g, '').toLowerCase()}`;

/**
 * Add a report's places to a finding's sources, after its own, so the [n] markers in its detail still point where they
 * did (an advisor's report is always a source). The record is written as it is stored, with only the
 * sources added, as a mark is. True when they are there, or the finding is gone; false when they cannot be added now
 * (a finding in two versions waits for a person, a store that failed): the sweep owes them and adds them later.
 */
export async function citeFinding(w: FindingWrites, id: string, add: Source[]): Promise<boolean> {
  for (let again = 0; again < 2; again++) {
    const r = await w.repo.get('finding', id);
    if (!r.ok) return false;
    if (!r.value) return true;                 // gone: nothing to add to
    if (r.value.conflict?.length) return false;
    const d = r.value.envelope.data as Record<string, unknown> & { sources?: Source[] };
    const had = d.sources ?? [];
    const have = new Set(had.map(placeOf));
    const fresh = add.filter((x) => !have.has(placeOf(x)) && (have.add(placeOf(x)), true));
    if (!fresh.length) return true;
    const data = { ...d, sources: [...had, ...fresh], updatedAt: w.clock() };
    const write = { kind: 'finding' as const, id, data, expectedRev: r.value.rev, keepsSchema: true };
    const wrote = await w.repo.transaction({ writes: [write] });
    if (wrote.ok) {
      w.announce?.('finding', id);
      return true;
    }
    if (wrote.error.kind !== 'conflict') return false;   // changed a moment ago elsewhere: read it again, once
  }
  return false;
}

/** a report's finding's fixed id: the same on every PC for the same deal, report and issue title */
export const reportFindingId = (dealId: string, doc: string, title: string, n: number) =>
  derivedId('f', [dealId, 'report', doc, reportTitleKey(title), String(n)]);

/** what tells which of a deal's documents the sweep may read */
export interface Candidates {
  where: (rec: DocRecord) => string;
  /** documents in a folder this person may not open */
  shut: { has: (docId: string) => boolean };
  /** blacklines: a comparison of two drafts */
  blacklines: { has: (docId: string) => boolean };
}

/**
 * The documents that may be reports, and each newest draft's earlier drafts. Only the newest draft of a report is read,
 * compared with what an earlier draft raised; a blackline, another project's precedent and a document in a closed
 * folder are not read.
 */
export function reportCandidates(all: DocRecord[], c: Candidates) {
  const earlier = new Map<string, string[]>();
  const older = new Set<string>();
  const paths = all.map((r) => ({ docId: r.docId, path: c.where(r), ...(r.seen ? { seen: r.seen } : {}) }));
  for (const f of families(paths)) {
    const drafts = f.drafts.slice(1).map((d) => d.docId);
    earlier.set(f.drafts[0].docId, drafts);
    for (const d of drafts) older.add(d);
  }
  const readable = (r: DocRecord) => !c.shut.has(r.docId) && !c.blacklines.has(r.docId) && !older.has(r.docId);
  return { docs: all.filter((r) => readable(r) && !inPrecedents(c.where(r))), earlier };
}

/** what running sweeps in the background needs */
export interface SweepRunner {
  /** run work in the background, as the backend's other background work runs */
  later: (work: () => Promise<void>) => void;
  /** one sweep of a deal; throws when it could not finish */
  sweep: (dealId: string) => Promise<void>;
  /** the service out of reach, or this PC signed out */
  unreachable: (e: unknown) => boolean;
  /** the first wait before a failed sweep is tried again */
  retryEvery: () => number;
}

/**
 * Sweeps of each deal's reports in the background. One sweep at a time per deal; one asked for meanwhile follows it. A
 * sweep that fails is tried again while the app is open, as a check is: every `retryEvery` at first, then twice as long
 * after each failure in a row, up to 32 times as long, so a document the service never takes costs a call now and then.
 * The service out of reach costs nothing to try, so it is tried every `retryEvery` and does not lengthen the wait.
 */
export class ReportSweeps {
  /** a deal being swept now, and whether a sweep was asked for again meanwhile */
  private sweeping = new Map<string, { again: boolean }>();
  /** a sweep that failed, waiting to be tried again */
  private retry = new Map<string, ReturnType<typeof setTimeout>>();
  /** sweeps of a deal that failed in a row, which space out the next try */
  private fails = new Map<string, number>();
  /** the deals swept once since the app started */
  private sweptOnce = new Set<string>();
  private closed = false;

  constructor(private run: SweepRunner) {}

  /** sweep a deal's reports soon */
  soon(dealId: string) {
    const waiting = this.retry.get(dealId);
    if (waiting) {
      clearTimeout(waiting);
      this.retry.delete(dealId);
    }
    const now = this.sweeping.get(dealId);
    if (now) {
      now.again = true;
      return;
    }
    const st = { again: false };
    this.sweeping.set(dealId, st);
    this.run.later(() => this.sweepWhileAsked(dealId, st));
  }

  /** sweep a deal once since the app started, so a deal checked before and unchanged since is swept */
  once(dealId: string) {
    if (this.sweptOnce.has(dealId)) return;
    this.sweptOnce.add(dealId);
    this.soon(dealId);
  }

  /** stop trying failed sweeps again */
  close() {
    this.closed = true;
    for (const t of this.retry.values()) clearTimeout(t);
    this.retry.clear();
  }

  private async sweepWhileAsked(dealId: string, st: { again: boolean }) {
    let failure: { away: boolean } | undefined;
    try {
      do {
        st.again = false;
        try {
          await this.run.sweep(dealId);
        } catch (e) {
          failure = { away: this.run.unreachable(e) };
        }
      } while (st.again && !failure);
    } finally {
      this.sweeping.delete(dealId);
    }
    if (!failure) this.fails.delete(dealId);
    else if (!this.closed) this.tryAgain(dealId, failure.away);
  }

  private tryAgain(dealId: string, away: boolean) {
    const n = away ? 1 : (this.fails.get(dealId) ?? 0) + 1;
    if (!away) this.fails.set(dealId, n);
    const every = this.run.retryEvery();
    const wait = Math.min(every * 2 ** (n - 1), every * 32);
    const t = setTimeout(() => {
      this.retry.delete(dealId);
      this.soon(dealId);
    }, wait);
    (t as { unref?: () => void }).unref?.();
    this.retry.set(dealId, t);
  }
}
