/**
 * Rounds: how two or more PCs share one deal's checks without a server (docs/architecture.md, Checks, and how PCs share
 * them).
 *
 * A round is one first pass (`first`), one check of everything (`quick` or `deep`), or a check of only what the last
 * check left out (`rest`) on one deal. The PC that starts it writes the list of pieces once, in the deal's check log;
 * every PC on the deal works that list. Who works which piece is worked out by each PC from the same lines, so no PC
 * has to ask another. This file holds the parts that are worked out from the lines alone, with no model and no clock of
 * another PC: the state of each round, which pieces are done and what each still needs, who owns what, the sample, and
 * finding ids. It has no side effects.
 *
 * Liveness is the one thing that is not read from the lines: each PC judges it by its own clock, from when it saw each
 * other PC's file grow (`Observer`).
 */
import { createHash } from 'node:crypto';

export type RoundKind = 'first' | 'quick' | 'deep' | 'rest';
/**
 * What an item piece needs first:
 *   check   the full check by the standard model;
 *   glance  a quick check's look by the fast model: a pass is not written as a result (it may be sampled);
 *   revisit a first pass's look by the fast model at something a change may have touched: a pass is written as a
 *           result.
 */
export type ItemStage = 'check' | 'glance' | 'revisit';
/**
 * One piece of a round: a checklist item (`item:<id>`, with its wording and why it is looked at) or an open finding
 * (`finding:<id>`, with the arrivals it is read against).
 */
export interface Piece {
  key: string;
  text?: string;
  reason?: string;
  stage?: ItemStage;
  also?: string[];
}
/** The round line: everything every member needs to work the same list. */
export interface RoundDef {
  id: string;
  kind: RoundKind;
  by: string;
  label?: string;
  /** the person at the PC that started it */
  who?: string;
  /** a hash of the documents the starter had, and the list itself (the finisher writes it on `done`) */
  docs: string;
  docList: string[];
  /** the round's core documents, so no member asks for a core of its own */
  core: { key: string; ids: string[] };
  /** how many item pieces make one block; blocks are what members own */
  block: number;
  pieces: Piece[];
  /** findings the starter marked while preparing (a cited document gone, a reworded item, a mark owed) */
  marked?: string[];
  /** for `rest`: the check round whose left-out pieces this one works */
  of?: string;
}
export type Outcome = 'ok' | 'finding' | 'gap' | 'unsettled';
/** A finding's answer from a look: whether it still stands (null: can't tell), and whether it was marked. */
export interface VerifiedFinding { finding: string; stands: boolean | null; marked: boolean }
/** The fields of a check-log line that rounds read. The line type in ai.ts has these and more. */
export interface RLine {
  n?: number;
  at: string;
  pc?: string;
  item?: string;
  result?: Outcome;
  finding?: string;
  round?: string;
  plan?: RoundDef;
  opening?: { id: string; kind: RoundKind; by: string; label?: string; who?: string };
  member?: { round: string; pc: string; label?: string; who?: string; epoch: number; ok: boolean };
  left?: { round: string; pc: string };
  glanced?: { round: string; items: { item: string; same: boolean; was?: Outcome }[] };
  verified?: { round: string; stage: 'fast' | 'standard'; findings: VerifiedFinding[] };
  sample?: { round: string; key: string; before?: Outcome; after?: Outcome };
  skipped?: { round: string; key: string; why: string };
  merged?: { round: string; into: string; extra: Piece[] };
  abandoned?: { round: string };
  due?: { round: string; by: string; docs: string };
  wanted?: { id: string; kind: RoundKind; by: string; label?: string; who?: string };
  done?: {
    items: string[];
    docs?: string[];
    round?: string;
    opening?: string;
    unchecked?: { items: number; findings: number };
  };
  claim?: { keys: string[]; pc: string; label?: string; until: string };
  release?: { keys: string[]; pc: string };
}

const sha = (text: string) => createHash('sha256').update(text).digest();
const hex = (text: string) => sha(text).toString('hex');
/** rendezvous weight of a PC for a unit of work: the live member with the highest weight owns it */
export const weight = (pc: string, unit: string) => hex(`${pc}\u0000${unit}`);
export const docsHash = (ids: string[]) => hex([...ids].sort().join(',')).slice(0, 16);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * A finding raised in a round has a fixed id, from the deal, the round's documents and the item: two PCs that raise the
 * same item over the same documents write the same record, whichever round is kept. ULID-shaped, so it passes as one.
 */
export function findingIdFor(dealId: string, docs: string, item: string): string {
  const hash = sha(`${dealId}\u0000${docs}\u0000${item}`);
  let bits = '';
  for (const byte of hash) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < 26; i++) out += CROCKFORD[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  // a ULID's first character is 0–7
  return `f_${'01234567'[parseInt(bits.slice(0, 3), 2)]}${out.slice(1)}`;
}

export const isItem = (p: Piece) => p.key.startsWith('item:');
export const itemOf = (p: Piece) => p.key.slice(5);
export const findingOf = (p: Piece) => p.key.slice(8);

/** A round as the lines show it. `ids` are this round and any merged into it: their lines count for it. */
export interface RoundState {
  def: RoundDef;
  n: number;
  ids: Set<string>;
  pieces: Piece[];
  members: Map<string, { label?: string; who?: string; epoch: number; ok: boolean; n: number }>;
  left: Set<string>;
  end: null | { kind: 'done'; at: string; line: RLine } | { kind: 'merged'; into: string } | { kind: 'abandoned' };
}
export interface View {
  rounds: Map<string, RoundState>;
  openings: Map<string, { kind: RoundKind; by: string; label?: string; who?: string; n: number; ended: boolean }>;
  wanted: { id: string; kind: RoundKind; by: string; label?: string; n: number }[];
  dues: { round: string; by: string; docs: string; n: number }[];
  lines: RLine[];
}

/** the state of every round, from the deal's lines in order */
export function view(lines: RLine[]): View {
  const out: View = { rounds: new Map(), openings: new Map(), wanted: [], dues: [], lines };
  for (const line of lines) readRoundLine(out, line);
  return out;
}

/** What one line says about the rounds. A line says one thing: the first of these it has is the one read. */
function readRoundLine(out: View, line: RLine) {
  const n = line.n ?? 0;
  if (line.opening) {
    if (!out.openings.has(line.opening.id)) out.openings.set(line.opening.id, { ...line.opening, n, ended: false });
  } else if (line.plan) {
    readPlan(out, line.plan, n);
  } else if (line.member) {
    readMember(out, line.member, n);
  } else if (line.left) {
    out.rounds.get(line.left.round)?.left.add(line.left.pc);
  } else if (line.merged) {
    readMerged(out, line.merged);
  } else if (line.abandoned) {
    endOpening(out, line.abandoned.round);
    const round = out.rounds.get(line.abandoned.round);
    if (round && !round.end) round.end = { kind: 'abandoned' };
  } else if (line.done) {
    readDone(out, line, line.done);
  } else if (line.wanted) {
    out.wanted.push({ ...line.wanted, n });
  } else if (line.due) {
    out.dues.push({ ...line.due, n });
  }
}

const endOpening = (out: View, id: string) => {
  const opening = out.openings.get(id);
  if (opening) opening.ended = true;
};

function readPlan(out: View, plan: RoundDef, n: number) {
  endOpening(out, plan.id);
  if (out.rounds.has(plan.id)) return;
  const round: RoundState = {
    def: plan,
    n,
    ids: new Set([plan.id]),
    pieces: [...plan.pieces],
    members: new Map(),
    left: new Set(),
    end: null,
  };
  out.rounds.set(plan.id, round);
}

function readMember(out: View, member: NonNullable<RLine['member']>, n: number) {
  const round = out.rounds.get(member.round);
  if (!round) return;
  const { label, who, epoch, ok } = member;
  round.members.set(member.pc, { label, who, epoch, ok, n });
  round.left.delete(member.pc);
}

/** a round merged into another: its lines count for that one, and its extra pieces join that one's list */
function readMerged(out: View, merged: NonNullable<RLine['merged']>) {
  endOpening(out, merged.round);
  const round = out.rounds.get(merged.round);
  if (round && !round.end) round.end = { kind: 'merged', into: merged.into };
  const into = out.rounds.get(merged.into);
  if (!into) return;
  into.ids.add(merged.round);
  for (const piece of merged.extra ?? []) {
    if (!into.pieces.some((x) => x.key === piece.key)) into.pieces.push(piece);
  }
}

function readDone(out: View, line: RLine, done: NonNullable<RLine['done']>) {
  if (done.opening) endOpening(out, done.opening);
  const round = done.round ? out.rounds.get(done.round) : undefined;
  if (round && !round.end) round.end = { kind: 'done', at: line.at, line };
}

/** rounds not yet ended, oldest first */
export const openRounds = (v: View) => [...v.rounds.values()].filter((r) => !r.end).sort((a, b) => a.n - b.n);
/**
 * whether a round of kind `have` can do what a request of kind `want` needs: a first pass joins anything; a quick check
 * a quick or deep one; a deep check only a deep one; a check of what was left out any check, since every check covers
 * it
 */
export function serves(have: RoundKind, want: RoundKind): boolean {
  if (want === 'first') return true;
  if (want === 'quick') return have === 'quick' || have === 'deep';
  if (want === 'deep') return have === 'deep';
  return want === 'rest' && have !== 'first';
}

/**
 * Of two lines that settle the same piece in the same round, the one that counts: the one whose effect was written (a
 * finding raised, a mark made), otherwise the one from the PC whose id sorts first. The same everywhere, so every PC
 * shows the same.
 */
export function counts<T extends RLine>(a: T, b: T, effect: (l: T) => boolean): T {
  const effectA = effect(a);
  const effectB = effect(b);
  if (effectA !== effectB) return effectA ? a : b;
  return (a.pc ?? '') <= (b.pc ?? '') ? a : b;
}

type Verdict = { stands: boolean | null; marked: boolean; pc?: string };
/** Everything the round's lines say about each piece, resolved. */
export interface PieceFacts {
  result?: RLine;
  glance?: { same: boolean; was?: Outcome; pc?: string };
  sample?: RLine;
  skipped?: RLine;
  fast?: Verdict;
  standard?: Verdict;
}
/** whether PC id `a` sorts no later than `b` (a missing id sorts first) */
const sortsFirst = (a?: string, b?: string) => (a ?? '') <= (b ?? '');

export function factsOf(v: View, r: RoundState): Map<string, PieceFacts> {
  const out = new Map<string, PieceFacts>();
  const factsFor = (key: string) => {
    let facts = out.get(key);
    if (!facts) {
      facts = {};
      out.set(key, facts);
    }
    return facts;
  };
  for (const line of v.lines) readFacts(line, r, factsFor);
  return out;
}

/**
 * What one line of the round says about its pieces. A line says one thing: the first of these it has is the one read.
 */
function readFacts(line: RLine, r: RoundState, factsFor: (key: string) => PieceFacts) {
  if (line.item && line.result && line.round && r.ids.has(line.round)) {
    const facts = factsFor(`item:${line.item}`);
    facts.result = facts.result ? counts(facts.result, line, (y) => y.result === 'finding') : line;
  } else if (line.glanced && r.ids.has(line.glanced.round)) {
    readGlances(line, line.glanced.items, factsFor);
  } else if (line.verified && r.ids.has(line.verified.round)) {
    readVerified(line, line.verified, factsFor);
  } else if (line.sample && r.ids.has(line.sample.round)) {
    const facts = factsFor(line.sample.key);
    facts.sample = facts.sample ? counts(facts.sample, line, () => false) : line;
  } else if (line.skipped && r.ids.has(line.skipped.round)) {
    const facts = factsFor(line.skipped.key);
    facts.skipped ??= line;
  }
}

type Glanced = NonNullable<RLine['glanced']>['items'];
function readGlances(line: RLine, glances: Glanced, factsFor: (key: string) => PieceFacts) {
  for (const glance of glances) {
    const facts = factsFor(`item:${glance.item}`);
    // of two PCs' looks, the one from the PC whose id sorts first counts, the same on every PC
    const replaces = !facts.glance || (sortsFirst(line.pc, facts.glance.pc) && facts.glance.pc !== line.pc);
    if (replaces) facts.glance = { same: glance.same, was: glance.was, pc: line.pc };
  }
}

function readVerified(line: RLine, verified: NonNullable<RLine['verified']>, factsFor: (key: string) => PieceFacts) {
  for (const answer of verified.findings) {
    const facts = factsFor(`finding:${answer.finding}`);
    const now = { stands: answer.stands, marked: answer.marked, pc: line.pc };
    facts[verified.stage] = verdictThatCounts(facts[verified.stage], now);
  }
}

/**
 * Of two answers on the same finding at the same stage, the one that counts: the one that marked, else the first PC's.
 */
function verdictThatCounts(had: Verdict | undefined, now: Verdict): Verdict {
  if (!had) return now;
  if (had.marked !== now.marked) return had.marked ? had : now;
  return sortsFirst(had.pc, now.pc) ? had : now;
}

/**
 * When the round's work was finished, read from its lines the same way on every PC: the time of the last step any piece
 * needed, each step timed by the first line that took it (a later line doing the same step again, written within a sync
 * delay, does not move it). Undefined for a round with no work. Two PCs that both see the round finish and both write
 * `full` so give it the same time, and each says the same about how the check ended.
 */
export function finishedAt(v: View, r: RoundState): string | undefined {
  const first = new Map<string, string>();
  for (const line of v.lines) {
    for (const step of stepsOf(line, r)) {
      const was = first.get(step);
      if (!was || line.at < was) first.set(step, line.at);
    }
  }
  return [...first.values()].reduce<string | undefined>((a, at) => (!a || at > a ? at : a), undefined);
}

/** the steps of the round's pieces a line took, each named by its stage and piece */
function stepsOf(line: RLine, r: RoundState): string[] {
  if (line.item && line.result && line.round && r.ids.has(line.round)) return [`item:${line.item}`];
  if (line.glanced && r.ids.has(line.glanced.round)) return line.glanced.items.map((g) => `glance:${g.item}`);
  if (line.verified && r.ids.has(line.verified.round)) {
    const stage = line.verified.stage;
    return line.verified.findings.map((g) => `${stage}:${g.finding}`);
  }
  if (line.sample && r.ids.has(line.sample.round)) return [`sample:${line.sample.key}`];
  if (line.skipped && r.ids.has(line.skipped.round)) return [`skipped:${line.skipped.key}`];
  return [];
}

/**
 * Blocks: the round's item pieces of each first stage, in list order, cut into blocks of `def.block`. Items that start
 * with a look and items that start with the full check are blocked apart, so a block is one call, as today's batches
 * are.
 */
export function blockOf(r: RoundState): Map<string, number> {
  const out = new Map<string, number>();
  const countByStage = new Map<string, number>();
  for (const piece of r.pieces) {
    if (!isItem(piece)) continue;
    const stage = piece.stage ?? 'check';
    const index = countByStage.get(stage) ?? 0;
    countByStage.set(stage, index + 1);
    out.set(piece.key, Math.floor(index / Math.max(1, r.def.block)));
  }
  return out;
}
/** the unit a piece is owned by: its block for an item, itself for a finding */
export const unitOf = (blocks: Map<string, number>, p: Piece) =>
  isItem(p) ? `block:${p.stage ?? 'check'}:${blocks.get(p.key)}` : p.key;

/**
 * Which pieces a quick check samples: of everything the fast model passed (items it agreed with, and findings it let
 * stand), a tenth and at least five, as before, but chosen by hash from the round's id rather than at random, so every
 * PC draws the same sample whoever did the work. The sample is known once every look and every fast answer is in; null
 * means not known yet.
 */
export function sampled(r: RoundState, facts: Map<string, PieceFacts>, key: string): boolean | null {
  if (r.def.kind !== 'quick') return false;
  const drawn = sampleOf(r, facts);
  return drawn === null ? null : drawn.has(key);
}
/**
 * What is worked out once for a round and its facts and kept with them: `need` asks for every piece on every pass, and
 * working it out each time (hashing the whole pool for the sample, counting every look) took minutes at 2,000 items.
 * Facts are never changed once `factsOf` has made them, and a merge adds pieces only inside `view`, before any facts
 * exist; a kept answer is still checked against the round and its pieces, in case a caller passes another round or
 * changes them.
 */
type Kept<T> = { r: RoundState; pieces: Piece[]; count: number; value: T };
function keptFor<T>(cache: WeakMap<Map<string, PieceFacts>, Kept<T>>, r: RoundState, facts: Map<string, PieceFacts>,
  work: () => T): T {
  const kept = cache.get(facts);
  if (kept && kept.r === r && kept.pieces === r.pieces && kept.count === r.pieces.length) return kept.value;
  const value = work();
  cache.set(facts, { r, pieces: r.pieces, count: r.pieces.length, value });
  return value;
}
/** the sample, drawn once for a round and its facts (`keptFor`) */
const drawnFor = new WeakMap<Map<string, PieceFacts>, Kept<Set<string> | null>>();
function sampleOf(r: RoundState, facts: Map<string, PieceFacts>): Set<string> | null {
  return keptFor(drawnFor, r, facts, () => draw(r, facts));
}
/** the round's item pieces that start with a look, leaving out skipped ones */
function lookPieces(r: RoundState, facts: Map<string, PieceFacts>): Piece[] {
  return r.pieces.filter((p) => isItem(p) && p.stage === 'glance' && !facts.get(p.key)?.skipped);
}
const lookedFor = new WeakMap<Map<string, PieceFacts>, Kept<boolean>>();
/** whether every look in the round is in, worked out once for a round and its facts (`keptFor`) */
function allLooked(r: RoundState, facts: Map<string, PieceFacts>): boolean {
  return keptFor(lookedFor, r, facts, () => lookPieces(r, facts).every((p) => facts.get(p.key)?.glance));
}
function draw(r: RoundState, facts: Map<string, PieceFacts>): Set<string> | null {
  const looks = lookPieces(r, facts);
  const findings = r.pieces.filter((p) => !isItem(p) && !facts.get(p.key)?.skipped);
  if (!allLooked(r, facts)) return null;
  if (findings.some((p) => !facts.get(p.key)?.fast)) return null;
  const pool = [
    ...looks.filter((p) => facts.get(p.key)!.glance!.same),
    ...findings.filter((p) => facts.get(p.key)!.fast!.stands === true),
  ];
  const size = Math.min(pool.length, Math.max(5, Math.ceil(pool.length / 10)));
  const hashed = pool.map((p) => ({ key: p.key, hash: hex(`${r.def.id}\u0000${p.key}`) }));
  hashed.sort((a, b) => (a.hash < b.hash ? -1 : 1));
  return new Set(hashed.slice(0, size).map((x) => x.key));
}

/** What a piece needs next: a stage to run, `wait` while something else must come first, or null when it is done. */
export type Need = 'check' | 'glance' | 'sample' | 'fast' | 'standard' | 'wait' | null;
export function need(r: RoundState, facts: Map<string, PieceFacts>, p: Piece): Need {
  const known = facts.get(p.key) ?? {};
  if (known.skipped) return null;
  return isItem(p) ? itemNeed(r, facts, p, known) : findingNeed(r, facts, p, known);
}

function itemNeed(r: RoundState, facts: Map<string, PieceFacts>, p: Piece, known: PieceFacts): Need {
  const kind = r.def.kind;
  if (kind === 'first') return firstPassItemNeed(p, known);
  if (kind === 'deep' || p.stage !== 'glance') return known.result ? null : 'check';
  if (!known.glance) return 'glance';
  if (!known.glance.same) return flaggedNeed(r, facts, known);
  const inSample = sampled(r, facts, p.key);
  if (inSample === null) return 'wait';
  return inSample && !known.sample ? 'sample' : null;
}

/**
 * An item its look flagged gets its full check only once every look in the round is in, so each PC sends the flagged
 * items it owns together rather than one call per block as the looks arrive from either PC (#131).
 */
function flaggedNeed(r: RoundState, facts: Map<string, PieceFacts>, known: PieceFacts): Need {
  if (known.result) return null;
  return allLooked(r, facts) ? 'check' : 'wait';
}

/** a first pass checks each item, after a look first at one a change may have touched */
function firstPassItemNeed(p: Piece, known: PieceFacts): Need {
  if (known.result) return null;
  return p.stage === 'revisit' && !known.glance ? 'glance' : 'check';
}

function findingNeed(r: RoundState, facts: Map<string, PieceFacts>, p: Piece, known: PieceFacts): Need {
  const kind = r.def.kind;
  if (kind === 'deep') return known.standard ? null : 'standard';
  if (!known.fast) return 'fast';
  if (known.fast.stands !== true) return known.standard ? null : 'standard';
  // no spot check on what a first pass or a check of what was left out let stand
  if (kind === 'first' || kind === 'rest') return null;
  const inSample = sampled(r, facts, p.key);
  if (inSample === null) return 'wait';
  return inSample && !known.standard ? 'standard' : null;
}
export const undone = (r: RoundState, facts: Map<string, PieceFacts>) =>
  r.pieces.filter((p) => need(r, facts, p) !== null);

/** the owner of a unit: the eligible live member with the highest weight */
export function owner(unit: string, members: string[]): string | undefined {
  let best: string | undefined;
  let bestWeight = '';
  for (const pc of members) {
    const pcWeight = weight(pc, unit);
    if (best === undefined || pcWeight > bestWeight) {
      best = pc;
      bestWeight = pcWeight;
    }
  }
  return best;
}

export { Observer } from './roundsObserver';
