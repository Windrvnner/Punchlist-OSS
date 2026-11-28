// @vitest-environment node
import { expect, it } from 'vitest';
import { cutOff } from '../../src/backend/limits';
import { derivedId } from '../../src/domain/derivedId';
import type { Finding } from '../../src/domain/model';
import { stateOf, type ReportLine } from '../../src/backend/reports';
import type { Repository } from '../../src/ports';
import { checkLines, deal, doc, Mem, setup, val, type Call } from './reviewKit';
import { refuse } from '../adapters/memRepo';

const report = doc(832, 'Independent Engineer Report.pdf', { pages: 60 });
const docId = report.docId;

interface Row {
  title: string;
  workstream: string;
  body: string[];
  sources: { doc: string; page: number; quote: string }[];
}

function row(title: string, page = 1): Row {
  return {
    title, workstream: 'Technical', body: [`The independent engineer reports that ${title}. [1]`],
    sources: [{ doc: docId, page, quote: title }],
  };
}

function cutAfter(
  rows: object[], complete: number, fragment = '{"title":"The next observation stops', preface = '',
): never {
  const prefix = JSON.stringify(rows.slice(0, complete)).slice(1, -1);
  const text = `${preface}{"issues":[${prefix}${prefix ? ',' : ''}${fragment}`;
  throw cutOff('The reply reached the output limit', text);
}

async function reader(reply: (call: Call, count: number) => string, use?: { shared: Mem; repo: Repository }) {
  const shared = use?.shared ?? new Mem();
  const s = setup(() => ({}), { d1: [report] }, { shared, installId: 'office', repo: use?.repo });
  if (!use) await deal(s.repo);
  const calls: Call[] = [];
  s.svc.reports = (call) => {
    if (!call.files.length) return JSON.stringify({ reports: [docId], unsure: [] });
    calls.push(call);
    return reply(call, calls.length);
  };
  return {
    ...s,
    shared,
    calls,
    state: () => {
      const lines: ReportLine[] = checkLines(shared).flatMap((line) => line.report ? [line.report] : []);
      return stateOf(lines);
    },
    async sweep() {
      val(await s.ai.firstPass('d1'));
      await s.ai.settled();
    },
  };
}

function reportIssues() {
  const facilities = [
    'Alder Ridge', 'Beacon Fell', 'Brookmere', 'Cedar Bluff', 'Clifton Heath', 'Dunwich Moor', 'Elmgate',
    'Fairhaven', 'Gannet Bay', 'Hawthorn Point', 'Ivy Downs', 'Juniper Hill', 'Kestrel Vale', 'Longwater',
    'Maple Ford', 'Northfield', 'Oakmere', 'Pine Rigg', 'Quarry Bank', 'Redcliff',
  ];
  const equipment = ['storage system', 'main transformer', 'substation', 'switchgear', 'control system'];
  const observations = [
    'has no commissioning acceptance record', 'is excluded from the maintenance agreement',
    'has overdue factory-test documentation', 'has a warranty that expires before debt maturity',
    'has no spare parts allocation in the base case', 'falls outside the current replacement budget',
  ];
  return facilities.flatMap((site) => equipment.flatMap((asset) => observations.map((observation) =>
    `the ${site} ${asset} ${observation}`,
  ))).map((title, index) => row(title, 1 + Math.floor(index / 10)));
}

it('keeps the complete rows in a 600-issue report across two cutoffs (#1212)', async () => {
  const rows = reportIssues();
  const s = await reader((_call, attempt) => {
    const remaining = rows.slice((attempt - 1) * 200);
    if (attempt === 1) cutAfter(remaining, 200, undefined, 'Here are the issues in the report:\n');
    if (attempt === 2) {
      cutAfter(remaining, 200, `{"title":"spare cable routing","sources":[{"doc":"${docId}","page":41},`);
    }
    return JSON.stringify({ issues: remaining });
  });
  try {
    await s.sweep();
    expect(s.calls).toHaveLength(3);
    expect(s.calls.every((call) => call.files[0].text === s.calls[0].files[0].text)).toBe(true);
    expect(s.calls[1].prompt).toContain('remaining issues');
    expect(s.calls[1].prompt).toContain(rows[199].title);
    expect(s.calls[2].prompt).toContain(rows[399].title);
    const findings = val(await s.repo.list('finding', 'd1')).map(({ envelope }) => envelope.data) as Row[];
    expect(findings.map((finding) => finding.title).sort()).toEqual(rows.map(({ title }) => title).sort());
    expect(s.state().read.get(docId)?.issues).toHaveLength(600);
    expect(s.state().tries('read', docId)).toBe(2);
  } finally {
    await s.ai.close();
  }
});

it('reopens a checkpoint and preserves same-title issues at separate places (#1212)', async () => {
  const first = row('the inverter warranty ends before debt maturity', 2);
  const another = row(first.title, 4);
  const initial = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter([first], 1);
    throw Object.assign(new Error('The service cannot be reached'), { code: 'unreachable' });
  });
  try {
    await initial.sweep();
    expect(initial.state().tries('read', docId)).toBe(1);
    expect(initial.state().read.has(docId)).toBe(false);
    expect(val(await initial.repo.list('finding', 'd1'))).toHaveLength(1);
    expect(val(await initial.ai.progress('d1')).incompleteReports).toBeUndefined();
  } finally {
    await initial.ai.close();
  }
  const reopened = await reader(() => JSON.stringify({ issues: [first, another] }), initial);
  try {
    await reopened.sweep();
    expect(reopened.calls).toHaveLength(1);
    expect(reopened.calls[0].prompt).toContain('remaining issues');
    expect(reopened.calls[0].prompt).toContain(first.title);
    const findings = val(await reopened.repo.list('finding', 'd1')).map(({ envelope }) => envelope.data) as {
      sources: { loc: string }[];
    }[];
    expect(findings.flatMap(({ sources }) => sources.map(({ loc }) => loc)).sort()).toEqual(['p. 2', 'p. 4']);
    expect(reopened.state().read.get(docId)?.issues).toHaveLength(2);
  } finally {
    await reopened.ai.close();
  }
});

it.each([false, true])('preserves distinct issues with the same title and citation (cutoff: %s)', async (cut) => {
  const first = row('the inverter contract excludes replacement costs', 16);
  const other = { ...first, body: ['The exclusion also leaves transport and crane hire unbudgeted. [1]'] };
  const s = await reader((_call, attempt) => {
    if (cut && attempt === 1) cutAfter([first, other], 2);
    return JSON.stringify({ issues: cut ? [] : [first, other] });
  });
  try {
    await s.sweep();
    const saved = val(await s.repo.list('finding', 'd1')).map(({ envelope }) => envelope.data as Finding);
    expect(saved.map(({ body }) => body[0]).sort()).toEqual([first.body[0], other.body[0]].sort());
    expect(s.state().read.get(docId)?.issues).toHaveLength(2);
  } finally {
    await s.ai.close();
  }
});

it.each([true, false])('preserves differing report titles as written (cutoff: %s)', async (cut) => {
  const first = row('the inverter contract omits replacement costs', 16);
  const other = { ...first, title: 'the inverter contract omits  replacement costs' };
  const s = await reader((_call, attempt) => {
    if (cut && attempt === 1) cutAfter([first, other], 2);
    return JSON.stringify({ issues: cut ? [] : [first, other] });
  });
  try {
    await s.sweep();
    const saved = val(await s.repo.list('finding', 'd1')).map(({ envelope }) => envelope.data as Finding);
    expect(saved.map(({ title }) => title).sort()).toEqual([first.title, other.title].sort());
    expect(s.state().read.get(docId)?.issues).toHaveLength(2);
  } finally {
    await s.ai.close();
  }
});

it('rejects a cut prefix that names an unshown document (#1212)', async () => {
  const valid = row('the substation transformer has no test record', 2);
  const invalid = row('the maintenance schedule has expired', 3);
  invalid.sources[0].doc = doc(833, 'Another report.pdf').docId;
  const s = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter([valid, invalid], 2);
    return JSON.stringify({ issues: [valid] });
  });
  try {
    await s.sweep();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1].prompt).toContain('remaining issues');
    expect(s.calls[1].prompt).not.toContain(valid.title);
    expect(s.state().read.get(docId)?.issues.map(({ title }) => title)).toEqual([valid.title]);
  } finally {
    await s.ai.close();
  }
});

it('recovers when the finding write succeeds before the cutoff checkpoint append fails (#1212)', async () => {
  const issues = [row('the replacement allowance excludes transformers', 2), row('the switchgear is not tested', 4)];
  const initial = await reader(() => cutAfter(issues, 1));
  const restore = refuse(initial.shared, (text) => text.includes('"cut":'), () => new Error('Disk full'), 1);
  try {
    await initial.sweep();
    expect(initial.state().tries('read', docId)).toBe(0);
    expect(val(await initial.repo.list('finding', 'd1'))).toHaveLength(1);
  } finally {
    restore();
    await initial.ai.close();
  }
  const resumed = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter(issues, 2);
    return '{"issues":[]}';
  }, initial);
  try {
    await resumed.sweep();
    const findings = val(await resumed.repo.list('finding', 'd1'));
    expect(findings).toHaveLength(2);
    expect(resumed.state().read.get(docId)?.issues.map(({ title }) => title)).toEqual(issues.map(({ title }) => title));
    expect(resumed.state().tries('read', docId)).toBe(1);
  } finally {
    await resumed.ai.close();
  }
});

it('honors a deletion after an interrupted cutoff while retaining a distinct issue (#1212)', async () => {
  const first = row('the EPC contractor omits the winter maintenance warranty', 3);
  const another = { ...first, body: ['The agreement excludes emergency on-site repairs from the warranty. [1]'] };
  const initial = await reader(() => cutAfter([first], 1));
  const restore = refuse(initial.shared, (text) => text.includes('"cut":'), () => new Error('Disk full'), 1);
  try {
    await initial.sweep();
    expect(initial.state().tries('read', docId)).toBe(0);
    const [saved] = val(await initial.repo.list('finding', 'd1'));
    const data = saved.envelope.data as Finding;
    const edited = { ...data, body: ['The advisor confirmed this concern during review.'] };
    val(await initial.repo.transaction({ writes: [{
      kind: 'finding', id: data.id, data: edited, expectedRev: saved.rev,
    }] }));
    const changed = val(await initial.repo.get('finding', data.id))!;
    const deleted = { id: data.id, dealId: data.dealId, kind: 'finding', snapshot: changed.envelope.data };
    val(await initial.repo.transaction({
      writes: [{ kind: 'tombstone', id: data.id, data: deleted, expectedRev: null }],
      deletes: [{ kind: 'finding', id: data.id, expectedRev: changed.rev }],
      index: { dealId: 'd1', add: [{ kind: 'tombstone', id: data.id }], remove: [{ kind: 'finding', id: data.id }] },
    }));
    expect(val(await initial.repo.list('finding', 'd1'))).toHaveLength(0);
  } finally {
    restore();
    await initial.ai.close();
  }
  const resumed = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter([first, another], 2);
    return '{"issues":[]}';
  }, initial);
  try {
    await resumed.sweep();
    const saved = val(await resumed.repo.list('finding', 'd1')).map(({ envelope }) => envelope.data as Finding);
    expect(saved.map(({ body }) => body)).toEqual([another.body]);
    expect(val(await resumed.repo.list('tombstone', 'd1'))).toHaveLength(1);
  } finally {
    await resumed.ai.close();
  }
});

it('asks again for a refused write while keeping an independent issue from the same prefix (#1212)', async () => {
  const first = row('the substation transformer has no test record', 2);
  const next = row('the maintenance agreement expires during the loan term', 3);
  const s = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter([first, next], 2);
    return JSON.stringify({ issues: [first] });
  });
  const transact = s.repo.transaction.bind(s.repo);
  let refused = false;
  s.repo.transaction = async (tx) => {
    const issue = tx.writes.find((write) => write.kind === 'finding')?.data as Row | undefined;
    if (!refused && issue?.title === first.title) {
      refused = true;
      return { ok: false, error: { kind: 'storageFull', message: 'Disk full' } };
    }
    return transact(tx);
  };
  try {
    await s.sweep();
    expect(refused).toBe(true);
    expect(s.calls[1].prompt).toContain(next.title);
    expect(s.calls[1].prompt).not.toContain(first.title);
    const complete = s.state().read.get(docId)?.issues.map(({ title }) => title).sort();
    expect(complete).toEqual([first.title, next.title].sort());
  } finally {
    await s.ai.close();
  }
});

it('consumes the existing attempt budget across a cutoff and unusable replies (#1212)', async () => {
  const first = row('the inverter warranty ends before debt maturity');
  let corrections = 0;
  const s = await reader(({ prompt }, attempt) => {
    if (attempt === 1) cutAfter([first], 1);
    if (prompt.includes('provide an issues array')) corrections++;
    return '{"report":true}';
  });
  try {
    await s.sweep();
    expect(corrections).toBe(2);
    expect(s.state().tries('read', docId)).toBe(3);
    expect(s.state().read.has(docId)).toBe(false);
    expect(val(await s.repo.list('finding', 'd1'))).toHaveLength(1);
    expect(val(await s.ai.progress('d1')).incompleteReports).toEqual([{ docId, name: report.name }]);
    await s.sweep();
    expect(s.calls).toHaveLength(5);
  } finally {
    await s.ai.close();
  }
});

it('keeps a continued report incomplete after a contradictory reply and an uncitable final issue (#1212)', async () => {
  const kept = row('the inverter warranty ends before debt maturity');
  const uncitable = row('the replacement budget excludes transformers', 61);
  const s = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter([kept], 1);
    if (attempt === 2) return '{"report":false}';
    return JSON.stringify({ issues: [uncitable] });
  });
  try {
    await s.sweep();
    expect(s.calls).toHaveLength(3);
    expect(s.state().verdict.get(docId)).toBe(true);
    expect(s.state().read.has(docId)).toBe(false);
    expect(s.state().tries('read', docId)).toBe(3);
    expect(val(await s.ai.progress('d1')).incompleteReports).toEqual([{ docId, name: report.name }]);
    expect(val(await s.repo.list('finding', 'd1'))).toHaveLength(1);
  } finally {
    await s.ai.close();
  }
});

it('settles separate cutoff citation obligations across 100 finding conflicts (#1212)', async () => {
  const findings = reportIssues().slice(0, 100).map(({ title, workstream, body }) => ({
    id: derivedId('f', [title]), dealId: 'd1', title, workstream, body, status: 'open', sources: [],
  }));
  const covers = (page: number) => findings.map(({ id }) => ({ covered: id, sources: [{ doc: docId, page }] }));
  const unavailable = () => Object.assign(new Error('The service cannot be reached'), { code: 'unreachable' });
  const first = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter(covers(12), findings.length);
    throw unavailable();
  });
  const repo = first.repo;
  try {
    val(await repo.transaction({
      writes: findings.map((data) => ({
        kind: 'finding', id: data.id, data, expectedRev: null, alongside: [{ ...data, note: 'Further review' }],
      })),
      index: { dealId: 'd1', add: findings.map(({ id }) => ({ kind: 'finding', id })) },
    }));
    await first.sweep();
    const conflicts = val(await repo.list('finding', 'd1'));
    expect(conflicts.filter(({ conflict }) => conflict?.length === 2)).toHaveLength(100);
    expect(first.state().owed).toHaveLength(100);
    val(await repo.transaction({ writes: conflicts.map((finding) => ({
      kind: 'finding', id: (finding.envelope.data as Finding).id, data: finding.envelope.data, expectedRev: finding.rev,
      resolves: finding.conflict?.map(({ id }) => id),
    })) }));
  } finally {
    await first.ai.close();
  }
  const second = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter(covers(24), findings.length);
    throw unavailable();
  }, first);
  const transact = repo.transaction;
  repo.transaction = async (tx) => {
    const blocked = tx.writes.some((write) => (write.data as Finding)?.sources?.some(({ loc }) => loc === 'p. 24'));
    if (blocked) return { ok: false, error: { kind: 'storageFull', message: 'Disk full' } };
    return transact.call(repo, tx);
  };
  try {
    await second.sweep();
    expect(second.state().owed).toHaveLength(100);
    expect(second.state().owed.every(({ sources }) => sources[0].loc === 'p. 24')).toBe(true);
  } finally {
    repo.transaction = transact;
    await second.ai.close();
  }
  const last = await reader(() => '{"issues":[]}', second);
  try {
    await last.sweep();
    expect(last.state().owed).toEqual([]);
    const saved = val(await repo.list('finding', 'd1')).map(({ envelope }) => envelope.data as Finding);
    expect(saved).toHaveLength(100);
    expect(saved.every(({ sources }) => sources.map(({ loc }) => loc).join(',') === 'p. 12,p. 24')).toBe(true);
    expect(last.state().read.get(docId)?.issues).toHaveLength(200);
  } finally {
    await last.ai.close();
  }
});
