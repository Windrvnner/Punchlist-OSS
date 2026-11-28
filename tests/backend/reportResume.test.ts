// @vitest-environment node
import { expect, it } from 'vitest';
import type { Finding } from '../../src/domain/model';
import { val } from './reviewKit';
import { cutAfter, docId, reader, report, row } from './reportCutoffKit';

it('keeps reading after a cutoff when a single reply both denies the report and claims on its issues', async () => {
  const kept = row('the inverter warranty ends before debt maturity');
  const s = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter([kept], 1);
    return '{"report":false,"issues":[]}';
  });
  try {
    await s.sweep();
    expect(s.state().read.has(docId)).toBe(false);
    expect(s.state().tries('read', docId)).toBe(3);
    expect(val(await s.ai.progress('d1')).incompleteReports).toEqual([{ docId, name: report.name }]);
  } finally {
    await s.ai.close();
  }
});

it('accepts the same explicit non-report string as report look', async () => {
  const s = await reader(() => '{"report":"false"}');
  try {
    await s.sweep();
    expect(s.state().verdict.get(docId)).toBe(false);
    expect(s.state().tries('read', docId)).toBe(0);
  } finally {
    await s.ai.close();
  }
});

it.each([false, true])('checks a legacy writer’s issue during cutoff continuation (same: %s)', async (same) => {
  const kept = row('the inverter warranty ends before debt maturity');
  const issue = row('the switchgear has no commissioning certificate', 3);
  let reachable = false;
  const s = await reader((_call, attempt) => {
    if (attempt === 1) cutAfter([kept], 1);
    if (attempt > 2 && !reachable) throw Object.assign(new Error('Service unreachable'), { code: 'unreachable' });
    return JSON.stringify({ issues: [issue] });
  });
  const transact = s.repo.transaction.bind(s.repo);
  let rival = '';
  s.repo.transaction = async (tx) => {
    const write = tx.writes.find((candidate) => candidate.kind === 'finding'
      && (candidate.data as Finding).title === issue.title);
    if (write && !rival) {
      rival = write.id;
      const data = { ...(write.data as Finding) };
      if (!same) {
        data.body = ['Different commissioning evidence was missing on p. 6.'];
        data.sources = [{ ...data.sources[0], loc: 'p. 6' }];
      }
      delete data.reportIssueSignature;
      val(await transact({ ...tx, writes: [{ ...write, data }] }));
    }
    return transact(tx);
  };
  try {
    await s.sweep();
    expect(s.state().read.has(docId)).toBe(same);
    reachable = true;
    await s.sweep();
    const findings = val(await s.repo.list('finding', 'd1')).map(({ envelope }) => envelope.data as Finding);
    const saved = findings.find(({ body }) => body[0] === issue.body[0]);
    expect(saved).toBeDefined();
    expect(saved?.id === rival).toBe(same);
    expect(findings).toHaveLength(same ? 2 : 3);
    expect(s.state().read.get(docId)?.issues).toHaveLength(2);
  } finally {
    await s.ai.close();
  }
});
