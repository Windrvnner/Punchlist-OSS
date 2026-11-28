// @vitest-environment node
// Every issue an outside advisor raises in a report is a finding (docs/decisions.md, Findings;
// reports.ts).
// Acceptance criteria: on a deal-sized data room (the 1,779-file Relecloud room) every third-party report is found and
// read through, every issue its stand-in advisor raises becomes one finding citing the report's page, however many
// pages of issues it takes and however the replies are cut; nothing is raised twice (an issue a finding already covers,
// a second sweep, a second PC, a read that stopped partway); a new draft raises only what is new and marks what it
// drops.
import { describe, it, expect } from 'vitest';
import {
  sweep,
  stateOf,
  SORT_PART,
  type ReportKit,
  type ReportLine,
  type Issue,
  type Known,
} from '../../src/backend/reports';
import type { DocRecord } from '../../src/backend/documents';
import type { Sent, Cited } from '../../src/backend/agent';
import type { Unusable } from '../../src/backend/agentKit';
import { paths } from './fixtures/relecloudRoom';
import { setup, deal, val, itemsIn, OK, Mem, clauseChanges, wasLines, checkLines, type Call } from './reviewKit';
import { fromStoreName } from '../../src/backend/storeKeeper';
import type { Finding } from '../../src/domain/model';

/** the Relecloud room as the document service lists it: the room's own folder, then the path inside it */
const room = (): DocRecord[] =>
  paths.map((p, i) => ({
    docId: `doc_${String(i + 1).padStart(24, '0')}`,
    hash: 'h',
    name: p.split('/').pop()!,
    folder: 'C:/Deals/Relecloud VDR',
    rel: p.split('/').slice(1).join('/'),
    size: 1,
    pages: 80,
  }));
const where = (r: DocRecord) => `Relecloud VDR/${r.rel}`;

/**
 * what a stand-in advisor raises in each report, by file name: issues of a realistic deal, enough of them to take
 * several pages
 */
const ISSUES: Record<string, string[]> = {
  'Independent Engineer Report.pdf': Array.from(
    { length: 60 },
    (_, i) =>
      [
        'Inverter warranty shorter than the debt tenor',
        'Module degradation above the base case assumption',
        'Substation completion behind the EPC schedule',
        'O&M budget omits inverter replacement',
        'Liquidated damages cap below lost revenue',
      ][i % 5] + (i >= 5 ? ` (point ${i + 1})` : ''),
  ),
  'Phase I Environmental Site Assessment.pdf': [
    'Stormwater permit for the laydown area has expired',
    'Recognized environmental condition at the former fuel tank',
  ],
  'Legal Due Diligence Report.pdf': [
    'Two lease parcels lack recorded memoranda',
    'PPA assignment needs offtaker consent not yet given',
    'Pending litigation on the access road easement',
  ],
  'Insurance Consultant Report.pdf': ['Business interruption cover is 6 months, lenders require 12'],
  'Tax Opinion.pdf': ['ITC basis may be challenged for interconnection costs'],
};
/** a scope note, as advisors write them: never a finding */
const SCOPE = 'Given this is desktop research we were unable to verify the soil quality';

/** the id a prompt shows the report by (#1162) */
const reportId = (prompt: string) => /^(doc_\w+): /m.exec(prompt)?.[1] ?? 'doc_?';
/**
 * the stand-in fast model sorting paths: an advisor's report, study or assessment is one; a memo or opinion it cannot
 * tell from the path
 */
function sortReply(prompt: string) {
  const rows = [...prompt.matchAll(/^(doc_\w+): (.*)$/gm)].map((m) => ({ n: m[1], path: m[2] }));
  const reports = rows
    .filter(
      (r) =>
        /(Report|Assessment|Study|Survey|Audit|Appraisal|ESA)\.pdf$/.test(r.path) &&
        !/Monthly|Operating|Title Report/.test(r.path),
    )
    .map((r) => r.n);
  const unsure = rows.filter((r) => /\b(Opinion|Memo)\b[^/]*\.pdf$/.test(r.path)).map((r) => r.n);
  return { reports, unsure };
}
/**
 * the stand-in standard model reading a report: all its issues in one reply, an issue a listed finding has as
 * {"covered"}
 */
function readReply(prompt: string, name: string, issues = ISSUES[name] ?? []) {
  // the deal's findings, each by its id (#1162)
  const listed = prompt.split('These findings are already on the deal:\n')[1]?.split('\nAn issue an open finding')[0];
  const known = [...(listed ?? '').matchAll(/^(.*?): (.*?)(?: \((?:closed|deleted)\))?$/gm)].map((m) => ({
    f: m[1],
    title: m[2],
  }));
  const earlier = [...prompt.matchAll(/^E(\d+): (.*)$/gm)].map((m) => ({ e: `E${m[1]}`, title: m[2] }));
  const fresh = issues.filter((t) => !earlier.some((e) => e.title === t));
  return {
    advisor: 'the advisor',
    dropped: earlier.filter((e) => !issues.includes(e.title)).map((e) => e.e),
    issues: fresh
      .map((t, i) => {
        const k = known.find((x) => x.title === t);
        return k
          ? { covered: k.f, sources: [{ doc: reportId(prompt), page: 30 + i, quote: t }] }
          : {
              title: t,
              workstream: 'Technical',
              body: [`The advisor raises that ${t.toLowerCase()}. [1]`],
              next: 'Ask the sponsor to address it.',
              sources: [{ doc: reportId(prompt), page: 10 + (i % 60), quote: t }],
            };
      })
      .concat(
        earlier
          .filter((e) => issues.includes(e.title))
          .map((e, n) => ({ still: e.e, sources: [{ doc: reportId(prompt), page: 60 + n, quote: e.title }] }) as never),
      ),
  };
}

/** a kit over memory: the check log, the findings and the calls, with the stand-in models answering */
function kit(
  docs: DocRecord[],
  o: {
    earlier?: Map<string, string[]>;
    answer?: (k: { kind: string; prompt: string; name: string; n: number }) => unknown;
    elsewhere?: Set<string>;
    log?: ReportLine[];
    findings?: Map<string, Known & { issue?: Issue }>;
    citeFails?: boolean;
  } = {},
) {
  const log: ReportLine[] = o.log ?? [];
  const findings = o.findings ?? new Map<string, Known & { issue?: Issue }>();
  const calls: { kind: string; prompt: string; name: string; unusable?: Unusable }[] = [];
  const shownTo: (readonly string[] | undefined)[] = [];
  const marks: { id: string; why: string }[] = [];
  const cites: { id: string; locs: string[] }[] = [];
  const held = new Set<string>();
  const byFile = new Map(docs.map((r) => [`file:${r.docId}`, r]));
  const k: ReportKit = {
    dealId: 'd1',
    docs,
    earlier: o.earlier ?? new Map(),
    where,
    models: { fast: 'fast', standard: 'standard' },
    system: 'rules',
    workstreams: ['Legal', 'Technical'],
    workstreamOf: (w) => (typeof w === 'string' ? w : ''),
    fitParas: (p) => p,
    lines: async () => log.slice(),
    say: async (l) => {
      log.push(l);
    },
    // as the app's claims are: only another PC's claim keeps this one out
    claim: async (keys) => {
      const free = keys.filter((x) => !o.elsewhere?.has(x));
      for (const x of free) held.add(x);
      return free;
    },
    release: async (keys) => {
      for (const x of keys) held.delete(x);
    },
    unusable: (_sent, _keys, shown) => {
      shownTo.push(shown);
      return () => false;
    },
    ask: async (input) => {
      const name = input.files?.length ? byFile.get(input.files[0])!.name : '';
      calls.push({ kind: input.kind, prompt: input.prompt, name, unusable: input.unusable });
      const custom = o.answer?.({ kind: input.kind, prompt: input.prompt, name, n: calls.length });
      if (custom !== undefined) {
        if (custom instanceof Error) throw custom;
        return custom as Record<string, unknown>;
      }
      if (input.kind === 'reportSort') return sortReply(input.prompt);
      if (input.kind === 'reportLook') return { report: /Tax Opinion/.test(name) };
      return readReply(input.prompt, name);
    },
    send: async (rec) => ({
      files: [`file:${rec.docId}`],
      listing: `${rec.docId}: ${where(rec)} (${rec.pages} pages)`,
      sent: [{ dealId: 'd1', rec }] as Sent[],
    }),
    fit: (text, cited: Cited[] | undefined, sent) => ({
      text,
      sources: (cited ?? [])
        .filter((c) => c.doc === sent[0].rec.docId && typeof c.page === 'number' && c.page <= (sent[0].rec.pages ?? 0))
        .map((c) => ({
          doc: sent[0].rec.name,
          docId: sent[0].rec.docId,
          loc: `p. ${c.page}`,
          quote: String(c.quote ?? ''),
        })),
    }),
    findings: async () => [...findings.values()].map(({ issue: _i, ...f }) => f),
    raise: async (id, issue) => {
      if (!findings.has(id)) findings.set(id, { id, title: issue.title, issue });
      return true;
    },
    mark: async (id, why) => {
      marks.push({ id, why });
    },
    cite: async (id, sources) => {
      if (o.citeFails) return false;
      cites.push({ id, locs: sources.map((x) => x.loc) });
      return true;
    },
    idFor: (doc, title, n) => `f_${doc}_${title}_${n}`,
  };
  return { k, log, findings, calls, marks, cites, shownTo };
}
const raisedTitles = (f: Map<string, Known & { issue?: Issue }>) =>
  [...f.values()].filter((x) => x.issue).map((x) => x.title);
const all = Object.values(ISSUES).flat();

describe('third-party reports at deal scale', () => {
  it('sorts all 1,779 files, reads every advisor report through, '
    + 'and raises each issue once, citing its page', async () => {
    const docs = room();
    expect(docs.length).toBe(1779);
    const { k, log, findings, calls } = kit(docs);
    const t0 = performance.now();
    const r = await sweep(k);
    const ms = performance.now() - t0;
    // 12 calls of paths only
    expect(calls.filter((c) => c.kind === 'reportSort').length).toBe(Math.ceil(1779 / SORT_PART));
    // every issue of every report is a finding, once; the IE's 60 issues take one call
    expect(raisedTitles(findings).sort()).toEqual([...all].sort());
    expect(calls.filter((c) => c.kind === 'report' && c.name === 'Independent Engineer Report.pdf').length).toBe(1);
    for (const f of findings.values()) {
      expect(f.issue!.sources.length).toBe(1);
      expect(f.issue!.sources[0].loc).toMatch(/^p\. \d+$/);
      expect(f.issue!.body[0]).toContain('[1]');
    }
    // the tax opinion, unclear from its path, was looked at and read; the legal opinions it said are not reports were
    // not
    expect(
      calls
        .filter((c) => c.kind === 'reportLook')
        .map((c) => c.name)
        .sort(),
    ).toEqual([
      'ITC Eligibility Memo.pdf',
      'Legal Opinion - Borrower Counsel.pdf',
      'Legal Opinion - Local Counsel.pdf',
      'Tax Opinion.pdf',
    ]);
    expect(calls.some((c) => c.kind === 'report' && c.name === 'Tax Opinion.pdf')).toBe(true);
    expect(calls.some((c) => c.kind === 'report' && /Legal Opinion|Monthly/.test(c.name))).toBe(false);
    expect(r.raised).toBe(all.length);
    expect(stateOf(log).read.size).toBe(r.read);
    expect(ms).toBeLessThan(5_000);
  });

  it('reads a report of 600 issues in one call', async () => {
    const name = 'Independent Engineer Report.pdf';
    const docs = room().filter((d) => d.name === name);
    const was = ISSUES[name];
    ISSUES[name] = Array.from({ length: 600 }, (_, i) => `Unique engineering issue number ${i + 1}`);
    try {
      const { k, log, findings, calls } = kit(docs);
      await sweep(k);
      expect(raisedTitles(findings).length).toBe(600);
      expect(raisedTitles(findings)).toContain('Unique engineering issue number 600');
      expect(calls.filter((c) => c.kind === 'report' && c.name === name).length).toBe(1);
      expect(stateOf(log).read.size).toBe(1);
    } finally {
      ISSUES[name] = was;
    }
  });

  it('tells the model the rule: anything flagged is an issue, unclear ones are raised, notes on the '
    + 'advisor’s own scope are not', async () => {
    const docs = room().filter((d) => d.name === 'Phase I Environmental Site Assessment.pdf');
    const { k, calls } = kit(docs);
    await sweep(k);
    const ask = calls.find((c) => c.kind === 'report')!.prompt;
    expect(ask).toContain('Where it is unclear whether something is an issue, list it.');
    expect(ask).toContain('as this was desktop research we could not verify the soil quality');
    expect(ask).toMatch(/permit, consent or license/);
    expect(ask).not.toContain(SCOPE);
  });

  it('keeps the issue title, body and advisor as the model wrote them, spacing and all (#1215)', async () => {
    const docs = room().filter((d) => d.name === 'Legal Due Diligence Report.pdf');
    const issue = (prompt: string) => ({
      title: ' Edge title\t',
      workstream: 'Legal',
      body: [' First paragraph.\t', ' Second paragraph. '],
      next: '',
      sources: [{ doc: reportId(prompt), page: 4 }],
    });
    const reply = (prompt: string) => ({ advisor: ' Counsel\t', issues: [issue(prompt)] });
    const answer = ({ kind, prompt }: { kind: string; prompt: string }) =>
      (kind === 'report' ? reply(prompt) : undefined);
    const log: ReportLine[] = [];
    const { k, findings } = kit(docs, { log, answer });
    await sweep(k);
    const raised = [...findings.values()].filter((x) => x.issue).map((x) => x.issue!);
    expect(raised.map((x) => x.title)).toEqual([' Edge title\t']);
    expect(raised[0].body).toEqual([' First paragraph.\t', ' Second paragraph. ']);
    expect(stateOf(log).read.values().next().value!.advisor).toBe(' Counsel\t');
  });

  it('a second sweep with nothing new asks nothing, and a second PC raises nothing again', async () => {
    const docs = room();
    const first = kit(docs);
    await sweep(first.k);
    const again = kit(docs, { log: first.log, findings: first.findings });
    const r = await sweep(again.k);
    expect(again.calls).toEqual([]);
    expect(r).toEqual({ read: 0, raised: 0 });
    expect(raisedTitles(first.findings).length).toBe(all.length);
  });

  it('an issue a finding on the deal already covers raises no second finding, and is kept as covered', async () => {
    const docs = room().filter((d) => d.name === 'Legal Due Diligence Report.pdf');
    const findings = new Map<string, Known & { issue?: Issue }>([
      ['f_check', { id: 'f_check', title: 'PPA assignment needs offtaker consent not yet given' }],
      ['f_gone', { id: 'f_gone', title: 'Pending litigation on the access road easement', deleted: true }],
    ]);
    const { k, log, cites } = kit(docs, { findings });
    await sweep(k);
    // the report is a source of the finding that covers its issue; a deleted one is left alone
    expect(cites).toEqual([{ id: 'f_check', locs: ['p. 31'] }]);
    // the one a person deleted is not raised again either
    expect(raisedTitles(findings)).toEqual(['Two lease parcels lack recorded memoranda']);
    const read = stateOf(log).read.values().next().value!;
    expect(read.issues.map((x) => x.covered ?? x.finding)).toEqual([
      expect.stringMatching(/^f_doc_/),
      'f_check',
      'f_gone',
    ]);
  });

  it('a cutoff saves the verified prefix and leaves the report unfinished for the next sweep (#1212)', async () => {
    const docs = room().filter((d) => d.name === 'Independent Engineer Report.pdf');
    const { k, findings, calls, log } = kit(docs, {
      answer: ({ kind, prompt, name }) => {
        if (kind !== 'report') return undefined;
        const r = readReply(prompt, name);
        return Object.assign(new Error('cut'), { code: 'cutoff', partial: { ...r, issues: r.issues.slice(0, 7) } });
      },
    });
    await sweep(k);
    expect(raisedTitles(findings)).toEqual(ISSUES['Independent Engineer Report.pdf'].slice(0, 6));
    expect(stateOf(log).read.has(docs[0].docId)).toBe(false);
    await sweep(k);
    expect(calls.at(-1)?.prompt).toContain('remaining issues');
    expect(calls.at(-1)?.prompt).toContain(ISSUES['Independent Engineer Report.pdf'][5]);
    expect(calls.filter((c) => c.kind === 'report').length).toBe(2);
  });

  it('keeps an earlier draft issue that the cutoff verified as still raised (#1212)', async () => {
    const report = room().find((doc) => doc.name === 'Independent Engineer Report.pdf')!;
    const before = 'doc_111111111111111111111111';
    const earlier = new Map([[report.docId, [before]]]);
    const issue = { title: 'Substation completion behind schedule', finding: 'f_substation' };
    const log: ReportLine[] = [{ read: { doc: before, advisor: 'the engineer', issues: [issue] } }];
    let first = true;
    const { k, marks } = kit([report], {
      log, earlier,
      answer: ({ kind }) => {
        if (kind !== 'report') return undefined;
        if (!first) return { issues: [], dropped: ['E1'] };
        first = false;
        const still = { still: 'E1', sources: [{ doc: report.docId, page: 17 }] };
        return Object.assign(new Error('cut'), { code: 'cutoff', partial: { issues: [still, {}] } });
      },
    });
    await sweep(k);
    await sweep(k);
    expect(stateOf(log).read.get(report.docId)?.issues).toEqual([issue]);
    expect(marks).toEqual([]);
  });

  it('compares a new draft with both the last completed draft and verified intervening issues (#1212)', async () => {
    const report = room().find((doc) => doc.name === 'Independent Engineer Report.pdf')!;
    const complete = 'doc_111111111111111111111111';
    const cut = 'doc_222222222222222222222222';
    const permit = { title: 'The stormwater permit has expired', finding: 'f_permit' };
    const switchgear = { title: 'The switchgear test report is missing', finding: 'f_switchgear' };
    const log: ReportLine[] = [
      { read: { doc: complete, advisor: 'the engineer', issues: [permit] } },
      { tried: { doc: cut, step: 'read', cut: { advisor: 'the engineer', issues: [{
        issue: switchgear, sources: [{ docId: cut, doc: 'Engineer Report v2.pdf', loc: 'p. 8' }],
      }] } } },
    ];
    const { k, marks } = kit([report], {
      log, earlier: new Map([[report.docId, [cut, complete]]]),
      answer: ({ kind, prompt }) => kind === 'report'
        ? { issues: [], dropped: [...prompt.matchAll(/^(E\d+): /gm)].map((match) => match[1]) }
        : undefined,
    });
    await sweep(k);
    expect(marks.map(({ id }) => id).sort()).toEqual([permit.finding, switchgear.finding].sort());
    expect(stateOf(log).read.get(report.docId)?.from).toBe(complete);
  });

  it('a read that fails writes nothing; the next sweep reads it again', async () => {
    const docs = room().filter((d) => d.name === 'Independent Engineer Report.pdf');
    const findings = new Map<string, Known & { issue?: Issue }>();
    const log: ReportLine[] = [];
    const down = kit(docs, {
      findings,
      log,
      answer: ({ kind, prompt }) =>
        kind === 'report' ? Object.assign(new Error('unreachable'), { code: 'unreachable' }) : undefined,
    });
    await expect(sweep(down.k)).rejects.toThrow('unreachable');
    expect(raisedTitles(findings).length).toBe(0);
    expect(stateOf(log).read.size).toBe(0);
    const up = kit(docs, { findings, log });
    await sweep(up.k);
    expect(raisedTitles(findings).sort()).toEqual([...ISSUES['Independent Engineer Report.pdf']].sort());
    expect(stateOf(log).read.size).toBe(1);
  });

  it('a new draft raises only its new issues and marks the finding of each issue it drops; a third draft is '
    + 'compared with both', async () => {
    const [v1, v2, v3] = ['2025-01-10', '2025-03-02', '2025-05-20'].map((d, i) => ({
      ...room()[0],
      docId: `doc_ie_${i + 1}`,
      name: 'Independent Engineer Report.pdf',
      rel: `06 Reports/${d}/Independent Engineer Report.pdf`,
    }));
    const said: Record<string, string[]> = {
      doc_ie_1: [
        'Inverter warranty shorter than the debt tenor',
        'Substation completion behind the EPC schedule',
        'O&M budget omits inverter replacement',
      ],
      doc_ie_2: [
        'Inverter warranty shorter than the debt tenor',
        'O&M budget omits inverter replacement',
        'Spare parts stock below the O&M requirement',
      ],
      doc_ie_3: ['O&M budget omits inverter replacement', 'Spare parts stock below the O&M requirement'],
    };
    const version = (prompt: string) =>
      prompt.includes('2025-01-10') ? 'doc_ie_1' : prompt.includes('2025-03-02') ? 'doc_ie_2' : 'doc_ie_3';
    const answer = ({ kind, prompt }: { kind: string; prompt: string }) =>
      kind === 'report' ? readReply(prompt, '', said[version(prompt)]) : undefined;
    const findings = new Map<string, Known & { issue?: Issue }>();
    const log: ReportLine[] = [];
    await sweep(kit([v1], { findings, log, answer }).k);
    const second = kit([v2], { findings, log, answer, earlier: new Map([['doc_ie_2', ['doc_ie_1']]]) });
    await sweep(second.k);
    expect(raisedTitles(findings)).toEqual([...said.doc_ie_1, 'Spare parts stock below the O&M requirement']);
    expect(second.cites.map((c) => c.id)).toEqual(
      said.doc_ie_1.filter((t) => said.doc_ie_2.includes(t)).map((t) => `f_doc_ie_1_${t}_1`),
    ); // what the new draft still raises cites it too
    expect(second.marks).toEqual([
      {
        id: 'f_doc_ie_1_Substation completion behind the EPC schedule_1',
        why: 'No longer raised in Independent Engineer Report.pdf',
      },
    ]);
    const third = kit([v3], { findings, log, answer, earlier: new Map([['doc_ie_3', ['doc_ie_2', 'doc_ie_1']]]) });
    await sweep(third.k);
    expect(third.marks.map((m) => m.id)).toEqual(['f_doc_ie_1_Inverter warranty shorter than the debt tenor_1']);
    expect(raisedTitles(findings).length).toBe(4);
  });

  it('a later draft that drops an issue of an earlier draft marks its finding', async () => {
    const [v1, v2] = ['2025-01-10', '2025-03-02'].map((d, i) => ({
      ...room()[0],
      docId: `doc_ie_${i + 1}`,
      name: 'Independent Engineer Report.pdf',
      rel: `06 Reports/${d}/Independent Engineer Report.pdf`,
    }));
    const ie = ISSUES['Independent Engineer Report.pdf'];
    const findings = new Map<string, Known & { issue?: Issue }>();
    const log: ReportLine[] = [];
    await expect(
      sweep(
        kit([v1], {
          findings,
          log,
          answer: ({ kind }) =>
            kind === 'report' ? Object.assign(new Error('unreachable'), { code: 'unreachable' }) : undefined,
        }).k,
      ),
    ).rejects.toThrow();
    await sweep(kit([v1], { findings, log }).k);
    const answer = ({ kind, prompt }: { kind: string; prompt: string }) =>
      kind === 'report' ? readReply(prompt, '', ie.slice(1)) : undefined;
    const second = kit([v2], { findings, log, answer, earlier: new Map([['doc_ie_2', ['doc_ie_1']]]) });
    await sweep(second.k);
    expect(second.marks.map((m) => m.id)).toEqual([`f_doc_ie_1_${ie[0]}_1`]);
    expect(raisedTitles(findings).length).toBe(ie.length);
  });

  it('a report the model refuses as too long is a try that could not finish: the reports after it are read, '
    + 'and after three tries it is not asked again', async () => {
    const docs = room().filter((d) =>
      /^(Independent Engineer Report|Phase I Environmental Site Assessment|Legal Due Diligence Report)\.pdf$/.test(
        d.name,
      ),
    );
    const log: ReportLine[] = [];
    const findings = new Map<string, Known & { issue?: Issue }>();
    let refused = 0;
    const answer = ({ kind, name }: { kind: string; name: string }) =>
      kind === 'report' && name.startsWith('Independent')
        ? (refused++, Object.assign(new Error('too long'), { code: 'toolong' }))
        : undefined;
    for (let i = 0; i < 5; i++) await sweep(kit(docs, { log, findings, answer }).k);
    expect(refused).toBe(3);
    expect(raisedTitles(findings).sort()).toEqual(
      [...ISSUES['Phase I Environmental Site Assessment.pdf'], ...ISSUES['Legal Due Diligence Report.pdf']].sort(),
    );
  });

  it('a failure that is not the document’s own (a usage limit, a bad key) stops the sweep and counts no try, '
    + 'so every report is read once it is put right', async () => {
    const docs = room().filter((d) =>
      /^(Independent Engineer Report|Phase I Environmental Site Assessment|Legal Due Diligence Report)\.pdf$/.test(
        d.name,
      ),
    );
    const log: ReportLine[] = [];
    const findings = new Map<string, Known & { issue?: Issue }>();
    const limit = ({ kind }: { kind: string }) =>
      kind === 'report'
        ? Object.assign(new Error('You have reached your specified API usage limits'), { status: 400 })
        : undefined;
    for (let i = 0; i < 4; i++)
      await expect(sweep(kit(docs, { log, findings, answer: limit }).k)).rejects.toThrow('usage limits');
    expect(log.filter((l) => l.tried).length).toBe(0);
    await sweep(kit(docs, { log, findings }).k);
    expect(raisedTitles(findings).length).toBe(ISSUES['Independent Engineer Report.pdf'].length + 2 + 3);
  });

  it('an issue only a closed finding covers is raised again, naming the closed one, as a checklist item’s '
    + 'is; an open finding’s is not', async () => {
    const docs = room().filter((d) => d.name === 'Legal Due Diligence Report.pdf');
    const findings = new Map<string, Known & { issue?: Issue }>([
      ['f_open', { id: 'f_open', title: 'PPA assignment needs offtaker consent not yet given' }],
      ['f_closed', { id: 'f_closed', title: 'Two lease parcels lack recorded memoranda', closed: true }],
    ]);
    const answer = ({ kind, prompt, name }: { kind: string; prompt: string; name: string }) => {
      if (kind !== 'report') return undefined;
      // the stand-in gives {"covered"} for both: a model told the rule writes the closed one out with "earlier"
      const r = readReply(prompt, name);
      expect(prompt).toContain(
        'An issue only a finding marked (closed) covers is written up in full like any other, '
          + 'with "earlier": "<finding id>".',
      );
      return {
        ...r,
        issues: r.issues.map((x, i) =>
          'covered' in x && x.covered === 'f_closed'
            ? {
                title: 'Two lease parcels lack recorded memoranda',
                workstream: 'Legal',
                body: ['Raised again. [1]'],
                next: '',
                sources: [{ doc: reportId(prompt), page: 4 + i }],
                earlier: 'f_closed',
              }
            : x,
        ),
      };
    };
    const { k } = kit(docs, { findings, answer });
    await sweep(k);
    const raised = [...findings.values()].filter((x) => x.issue);
    expect(raised.map((x) => [x.title, x.issue!.earlier])).toEqual([
      ['Two lease parcels lack recorded memoranda', 'f_closed'],
      ['Pending litigation on the access road easement', undefined],
    ]);
  });

  it('a failure that is one document’s own (a file the service will not take) counts as its try once a later '
    + 'report is read, and the rest are read', async () => {
    const docs = room().filter((d) =>
      /^(Independent Engineer Report|Phase I Environmental Site Assessment|Legal Due Diligence Report)\.pdf$/.test(
        d.name,
      ),
    );
    const log: ReportLine[] = [];
    const findings = new Map<string, Known & { issue?: Issue }>();
    let refused = 0;
    const answer = ({ kind, name }: { kind: string; name: string }) =>
      kind === 'report' && name.startsWith('Independent')
        ? (refused++, Object.assign(new Error('The file type is not supported'), { status: 415 }))
        : undefined;
    await sweep(kit(docs, { log, findings, answer }).k);
    expect(raisedTitles(findings).sort()).toEqual(
      [...ISSUES['Phase I Environmental Site Assessment.pdf'], ...ISSUES['Legal Due Diligence Report.pdf']].sort(),
    );
    const ie = docs.find((d) => d.name.startsWith('Independent'))!.docId;
    expect(stateOf(log).tries('read', ie)).toBe(1);
    // with nothing else left to read, its failure cannot be told from the deal's: the sweep stops, to be tried again
    // later, and no try is counted
    await expect(sweep(kit(docs, { log, findings, answer }).k)).rejects.toThrow('not supported');
    expect(stateOf(log).tries('read', ie)).toBe(1);
    expect(refused).toBe(2);
  });

  it('two reports that fail at the head of the list hold up none after them: those are read, and each '
    + 'failure counts as its document’s try', async () => {
    const docs = room()
      .filter((d) =>
        /^(Independent Engineer Report|Phase I Environmental Site Assessment|Legal Due Diligence Report)\.pdf$/.test(
          d.name,
        ),
      )
      .sort((a, b) => Number(a.name.startsWith('Legal')) - Number(b.name.startsWith('Legal')));
    const log: ReportLine[] = [];
    const findings = new Map<string, Known & { issue?: Issue }>();
    const answer = ({ kind, name }: { kind: string; name: string }) =>
      kind === 'report' && !name.startsWith('Legal')
        ? Object.assign(new Error('The file type is not supported'), { status: 415 })
        : undefined;
    await sweep(kit(docs, { log, findings, answer }).k);
    expect(raisedTitles(findings).sort()).toEqual([...ISSUES['Legal Due Diligence Report.pdf']].sort());
    for (const d of docs.filter((x) => !x.name.startsWith('Legal')))
      expect(stateOf(log).tries('read', d.docId)).toBe(1);
  });

  it('a report’s page that cannot be added to the finding covering its issue now is owed: the read goes on, '
    + 'and a later sweep adds it with no call to the model', async () => {
    const docs = room().filter((d) => d.name === 'Legal Due Diligence Report.pdf');
    const findings = new Map<string, Known & { issue?: Issue }>([
      ['f_check', { id: 'f_check', title: 'PPA assignment needs offtaker consent not yet given' }],
    ]);
    const log: ReportLine[] = [];
    // the finding is in two versions, say, until a person chooses
    await sweep(kit(docs, { log, findings, citeFails: true }).k);
    expect(raisedTitles(findings).sort()).toEqual([
      'Pending litigation on the access road easement',
      'Two lease parcels lack recorded memoranda',
    ]);
    expect(stateOf(log).owed.map((o) => [o.finding, o.sources.map((x) => x.loc)])).toEqual([['f_check', ['p. 31']]]);
    await sweep(kit(docs, { log, findings, citeFails: true }).k);
    expect(stateOf(log).owed.length).toBe(1); // still waiting
    const later = kit(docs, { log, findings });
    await sweep(later.k);
    expect(later.calls).toEqual([]);
    expect(later.cites).toEqual([{ id: 'f_check', locs: ['p. 31'] }]);
    expect(stateOf(log).owed).toEqual([]);
    const after = kit(docs, { log, findings });
    await sweep(after.k);
    expect(after.cites).toEqual([]);
  });

  it('pages owed by a second PC’s read of the same report are paid too', () => {
    const page = { doc: 'IE.pdf', docId: 'd', loc: 'p. 4' };
    const lines: ReportLine[] = [
      { read: { doc: 'd', advisor: '', issues: [] } },
      { read: { doc: 'd', advisor: '', issues: [], owe: [{ finding: 'f1', sources: [page] }] } },
    ];
    expect(stateOf(lines).owed).toEqual([{ doc: 'd', finding: 'f1', sources: [page] }]);
    expect(stateOf([...lines, { cited: { doc: 'd', finding: 'f1' } }]).owed).toEqual([]);
  });

  it('keeps a report with a closed-only reference unfinished and saves a complete sibling issue', async () => {
    const docs = room().filter((d) => d.name === 'Legal Due Diligence Report.pdf');
    const findings = new Map<string, Known & { issue?: Issue }>([
      ['f_closed', { id: 'f_closed', title: 'Two lease parcels lack recorded memoranda', closed: true }],
    ]);
    const answer = ({ kind, prompt }: { kind: string; prompt: string }) =>
      kind === 'report'
        ? {
            advisor: 'Counsel',
            issues: [
              { covered: 'f_closed', sources: [{ doc: reportId(prompt), page: 3 }] },
              {
                covered: 'f_closed',
                title: 'Lease parcels unrecorded',
                workstream: 'Legal',
                body: ['Raised again. [1]'],
                next: '',
                sources: [{ doc: reportId(prompt), page: 4 }],
              },
            ],
          }
        : undefined;
    const log: ReportLine[] = [];
    const { k, cites } = kit(docs, { findings, log, answer });
    for (let i = 0; i < 3; i++) await sweep(k);
    expect(cites).toEqual([]);
    expect([...findings.values()].filter((x) => x.issue).map((x) => [x.title, x.issue!.earlier])).toEqual([
      ['Lease parcels unrecorded', 'f_closed'],
    ]);
    const state = stateOf(log);
    expect(state.read.size).toBe(0);
    expect(state.cuts.get(docs[0].docId)?.issues.map(({ issue }) => issue.title)).toEqual(['Lease parcels unrecorded']);
  });

  it('issues the last try gave with no page that opens are counted on the read, '
    + 'never lost without a trace', async () => {
    const docs = room().filter((d) => d.name === 'Insurance Consultant Report.pdf');
    const log: ReportLine[] = [];
    const answer = ({ kind, prompt, name }: { kind: string; prompt: string; name: string }) => {
      if (kind !== 'report') return undefined;
      const r = readReply(prompt, name);
      return { ...r, issues: r.issues.map((x) => ({ ...x, sources: [] })) };
    };
    for (let i = 0; i < 3; i++) await sweep(kit(docs, { log, answer }).k);
    expect([...stateOf(log).read.values()][0].unplaced).toBe(1);
  });

  it('a report another PC is reading is left to it, and a document the read finds is not a report is set '
    + 'aside for good', async () => {
    const docs = room().filter((d) => /^(Market Consultant Report|Appraisal)\.pdf$/.test(d.name));
    const market = docs.find((d) => d.name.startsWith('Market'))!;
    const { k, log, calls } = kit(docs, {
      elsewhere: new Set([`reports:read:${market.docId}`]),
      answer: ({ kind, name }) => (kind === 'report' && name === 'Appraisal.pdf' ? { report: false } : undefined),
    });
    await sweep(k);
    expect(calls.filter((c) => c.kind === 'report').map((c) => c.name)).toEqual(['Appraisal.pdf']);
    expect(stateOf(log).verdict.get(docs.find((d) => d.name === 'Appraisal.pdf')!.docId)).toBe(false);
    const again = kit(docs, { log });
    await sweep(again.k);
    expect(again.calls.map((c) => c.name)).toEqual(['Market Consultant Report.pdf']);
  });

  it('a sort reply that cannot be used leaves those files for the next sweep; an issue with no page that '
    + 'opens has the read done again, three tries, then kept as it stands', async () => {
    const docs = room().filter((d) => d.rel.startsWith('06 Reports/') && !d.rel.includes('/Geotechnical/'));
    let n = 0;
    let reads = 0;
    const { k, findings, log } = kit(docs, {
      answer: ({ kind, prompt, name }) => {
        if (kind === 'reportSort' && n++ === 0) return null;
        if (kind === 'report' && name === 'Insurance Consultant Report.pdf') {
          reads++;
          const r = readReply(prompt, name);
          return { ...r, issues: r.issues.map((x) => ({ ...x, sources: [{ doc: reportId(prompt), page: 999 }] })) };
        }
        return undefined;
      },
    });
    await sweep(k);
    expect(stateOf(log).verdict.size).toBe(0);
    expect(findings.size).toBe(0);
    await sweep(k);
    expect(raisedTitles(findings)).toContain('Recognized environmental condition at the former fuel tank');
    const ins = docs.find((d) => d.name === 'Insurance Consultant Report.pdf')!.docId;
    expect(stateOf(log).read.has(ins)).toBe(false);
    expect(stateOf(log).tries('read', ins)).toBe(1);
    await sweep(k);
    await sweep(k);
    await sweep(k);
    expect(reads).toBe(3);
    expect(stateOf(log).read.has(ins)).toBe(true); // the third try is kept, and it is not asked again
    expect(raisedTitles(findings)).not.toContain(ISSUES['Insurance Consultant Report.pdf'][0]);
  });

  it('two reports that raise the same issue make one finding: '
    + 'the second read is shown what the first raised', async () => {
    const docs = room().filter((d) =>
      /^(Independent Engineer Report|Phase I Environmental Site Assessment)\.pdf$/.test(d.name),
    );
    const both = 'Stormwater permit for the laydown area has expired';
    const { k, findings } = kit(docs, {
      answer: ({ kind, prompt, name }) =>
        kind === 'report'
          ? readReply(
              prompt,
              name,
              name.startsWith('Independent') ? [both, 'Module degradation above the base case assumption'] : [both],
            )
          : undefined,
    });
    await sweep(k);
    expect(raisedTitles(findings).sort()).toEqual([both, 'Module degradation above the base case assumption'].sort());
  });

  it('a model that names a covering finding and writes the issue out too raises each issue once', async () => {
    const docs = room().filter((d) => d.name === 'Independent Engineer Report.pdf');
    const findings = new Map<string, Known & { issue?: Issue }>([
      ['f_check', { id: 'f_check', title: 'Inverter warranty shorter than the debt tenor' }],
    ]);
    const { k } = kit(docs, {
      findings,
      answer: ({ kind, prompt, name }) => {
        if (kind !== 'report') return undefined;
        const r = readReply(prompt, name);
        const issues = r.issues.map((x) =>
          'covered' in x
            ? {
                ...x,
                title: 'Inverter warranty shorter than the debt tenor',
                body: ['Again. [1]'],
                sources: [{ doc: reportId(prompt), page: 3 }],
              }
            : x,
        );
        return { ...r, issues };
      },
    });
    await sweep(k);
    const titles = raisedTitles(findings);
    expect(titles.length).toBe(new Set(titles).size);
    expect(titles.sort()).toEqual(
      ISSUES['Independent Engineer Report.pdf']
        .filter((t) => t !== 'Inverter warranty shorter than the debt tenor')
        .sort(),
    );
  });
});

/**
 * The app's backend on stand-in services, with the reports sweep's calls answered by `reports` (the stand-in service
 * keeps them from the check's script) and kept in `reportCalls`.
 */
function setupReports(
  script: (c: Call) => unknown,
  recs: Record<string, DocRecord[]>,
  more: Parameters<typeof setup>[2] & { reports: (c: Call) => unknown },
) {
  const { reports, ...rest } = more;
  const s = setup(script, recs, rest);
  const reportCalls: Call[] = [];
  s.svc.reports = (c) => {
    reportCalls.push(c as Call);
    const r = reports(c as Call);
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
  return { ...s, reportCalls };
}

async function sweepReply(
  reply: (call: Call) => unknown,
  options: { repair?: object; sweeps?: number } = {},
) {
  const report = room().find((doc) => doc.name === 'Independent Engineer Report.pdf')!;
  const shared = new Mem();
  const reader = setupReports(() => ({}), { d1: [report] }, {
    shared,
    installId: 'pc1',
    reports: (call) => call.files.length ? reply(call) : sortReply(call.prompt),
    fix: () => options.repair ?? {},
  });
  try {
    await deal(reader.repo);
    for (let sweep = 0; sweep < (options.sweeps ?? 1); sweep++) {
      val(await reader.ai.firstPass('d1'));
      await reader.ai.settled();
    }
    const lines: ReportLine[] = checkLines(shared).flatMap((line) => line.report ? [line.report] : []);
    return {
      report,
      state: stateOf(lines),
      reads: reader.reportCalls.filter((call) => call.files.length),
      repairs: reader.fixCalls,
      findings: val(await reader.repo.list('finding', 'd1')).map((line) => line.envelope.data as Finding),
    };
  } finally {
    await reader.ai.close();
  }
}

describe('advisor report reply shape (#1212)', () => {
  it.each([
    { report: true }, { issues: null }, { issues: 'Missing inverter warranty' }, { issues: {} },
    { advisor: 'Independent engineer' }, {}, { report: null }, { report: false, issues: null },
    { report: true, issues: [null, {}] },
    { issues: [{ title: 'The inverter warranty is missing' }] },
    { issues: [{ still: 'E42' }] },
  ])('sends a thin reply back once and leaves it unread if still thin (%j)', async (reply) => {
    const { report, state, reads, repairs, findings } = await sweepReply(() => reply);
    expect(reads).toHaveLength(2);
    expect(reads[1].prompt).toContain('provide an issues array');
    expect(reads[1].files).toEqual(reads[0].files);
    expect(repairs).toHaveLength(0);
    expect(state.tries('read', report.docId)).toBe(1);
    expect(state.read.has(report.docId)).toBe(false);
    expect(state.verdict.get(report.docId)).toBe(true);
    expect(findings).toHaveLength(0);
  });

  it.each(['{"issues":[]}', '[]', '{"advisor":"Aside"}\n{"issues":[]}'])(
    'saves an explicit empty list in one read (%s)', async (reply) => {
      const { report, state, reads, repairs } = await sweepReply(() => reply);
      expect(reads).toHaveLength(1);
      expect(repairs).toHaveLength(0);
      expect(state.read.get(report.docId)?.issues).toEqual([]);
    },
  );

  it('keeps the explicit non-report classification', async () => {
    const { report, state, reads, repairs } = await sweepReply(() => ({ report: false }));
    expect(reads).toHaveLength(1);
    expect(repairs).toHaveLength(0);
    expect(state.verdict.get(report.docId)).toBe(false);
    expect(state.read.has(report.docId)).toBe(false);
  });

  it('can finish on a later sweep after both replies were thin', async () => {
    let calls = 0;
    const reply = () => ++calls <= 2 ? { report: true } : { issues: [] };
    const { report, state, reads } = await sweepReply(reply, { sweeps: 2 });
    expect(reads).toHaveLength(3);
    expect(state.tries('read', report.docId)).toBe(1);
    expect(state.read.get(report.docId)?.issues).toEqual([]);
  });

  it('keeps an existing single-issue object with its verified report page', async () => {
    const title = 'The inverter warranty ends before debt maturity';
    const { report, state, reads, findings } = await sweepReply(({ prompt }) => {
      const reply = readReply(prompt, '', [title]);
      return { ...reply, issues: reply.issues[0] };
    });
    expect(reads).toHaveLength(1);
    expect(findings.map((finding) => finding.title)).toEqual([title]);
    expect(findings[0].sources).toMatchObject([{ docId: report.docId, loc: 'p. 10' }]);
    expect(state.read.get(report.docId)?.issues).toEqual([{ title, finding: findings[0].id }]);
  });

  it('writes a finding from the corrected reply with the report page', async () => {
    const title = 'The inverter warranty ends before debt maturity';
    const { report, state, reads, findings } = await sweepReply(({ prompt }) => (
      prompt.includes('provide an issues array') ? readReply(prompt, '', [title]) : { report: true }
    ));
    expect(reads).toHaveLength(2);
    expect(findings.map((finding) => finding.title)).toEqual([title]);
    expect(findings[0].sources).toMatchObject([{ docId: report.docId, loc: 'p. 10' }]);
    expect(state.read.get(report.docId)?.issues).toEqual([{ title, finding: findings[0].id }]);
  });

  it.each([{ report: true }, { issues: [] }])('uses only format repair for unreadable replies (%j)', async (repair) => {
    const { report, state, reads, repairs } = await sweepReply(() => 'Unreadable reply.', { repair });
    expect(reads).toHaveLength(1);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].files).toHaveLength(0);
    if ('issues' in repair) {
      expect(state.read.get(report.docId)?.issues).toEqual([]);
    } else {
      expect(state.read.has(report.docId)).toBe(false);
      expect(state.tries('read', report.docId)).toBe(1);
    }
  });

  it.each([false, true])('keeps known-id validation and its existing retries (corrected: %s)', async (corrected) => {
    const { report, state, reads, repairs, findings } = await sweepReply(({ prompt }) => (
      corrected && !prompt.includes('provide an issues array')
        ? { report: true }
        : { issues: [{ covered: 'f_unknown', sources: [{ doc: reportId(prompt), page: 4 }] }] }
    ));
    expect(reads).toHaveLength(corrected ? 4 : 3);
    expect(repairs).toHaveLength(0);
    expect(state.read.has(report.docId)).toBe(false);
    expect(state.tries('read', report.docId)).toBe(1);
    expect(findings).toHaveLength(0);
  });
});

describe('third-party reports by their permanent ids (#1162)', () => {
  it('the sort lists each file by its docId, and a reply naming an id it was not shown is refused', async () => {
    const docs = room().slice(0, 3);
    const asked: { prompt: string; unusable?: (text: string) => boolean | Promise<boolean> }[] = [];
    const { k } = kit(docs);
    const ask = k.ask;
    k.ask = (input, keys) => {
      asked.push(input);
      return ask(input, keys);
    };
    await sweep(k);
    const sort = asked.find((x) => x.prompt.includes('each by its id and path'))!;
    expect(sort.prompt).toContain(`${docs[0].docId}: ${where(docs[0])}`);
    expect(sort.prompt).not.toMatch(/^\d+: /m);
    expect(await sort.unusable!(JSON.stringify({ reports: [docs[1].docId], unsure: [] }))).toBe(false);
    expect(await sort.unusable!(JSON.stringify({ reports: [docs[1].docId.toUpperCase()], unsure: [] }))).toBe(true);
    expect(await sort.unusable!(JSON.stringify({ reports: [2], unsure: [] }))).toBe(true);
  });
});

describe('third-party reports in the app’s checks', () => {
  /**
   * the room's reports, two dated drafts of the IE report with a blackline, and another project's IE report among the
   * precedents
   */
  const recs = () => {
    const base = room().filter(
      (d) =>
        d.rel.startsWith('06 Reports/') &&
        !d.rel.includes('/Geotechnical/') &&
        d.name !== 'Independent Engineer Report.pdf',
    );
    const extra = (n: number, rel: string) => ({
      ...base[0],
      docId: `doc_${'f'.repeat(22)}0${n}`,
      name: rel.split('/').pop()!,
      rel,
    });
    return [
      ...base,
      extra(1, '06 Reports/IE/2025-01-10/Independent Engineer Report.pdf'),
      extra(2, '06 Reports/IE/2025-03-02/Independent Engineer Report.pdf'),
      extra(3, '06 Reports/IE/2025-03-02/Independent Engineer Report (blackline).pdf'),
      extra(4, '05 Financing/Precedents/Project Coho Independent Engineer Report.pdf'),
    ];
  };
  const script = (c: Call) => {
    if (c.prompt.includes('Which of them are reports by a third-party advisor'))
      return c.files.length ? { report: false } : sortReply(c.prompt);
    if (c.prompt.includes('is a report by an outside advisor'))
      return readReply(c.prompt, fromStoreName(c.files[0].name)!.name);
    return { items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) };
  };
  const checklist = () => ({
    broad: [{ id: 'x1', text: 'The independent engineer confirms the energy yield' }],
    product: [],
    sector: [],
  });

  it('once the first pass gets to the end, each issue of every report is a finding on the deal, citing the '
    + 'newest draft; precedents, earlier drafts and blacklines are not read', async () => {
    const shared = new Mem();
    const s = setupReports(script, { d1: recs() }, { shared, installId: 'pc1', checklist, reports: script });
    await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    await s.ai.settled();
    const read = s.reportCalls
      .filter((c) => c.prompt.includes('is a report by an outside advisor'))
      .map((c) => `${fromStoreName(c.files[0].name)!.name}`);
    // 60 issues, one call, one draft
    expect(read.filter((n) => n === 'Independent Engineer Report.pdf').length).toBe(1);
    expect(read.some((n) => /Project Coho|blackline/.test(n))).toBe(false);
    const fs = val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as Finding);
    const expected = Object.entries(ISSUES)
      .filter(([n]) => n !== 'Tax Opinion.pdf')
      .flatMap(([, t]) => t);
    expect(fs.map((f) => f.title).sort()).toEqual([...expected].sort());
    const newest = recs().find((r) => r.docId.endsWith('f02'))!;
    for (const f of fs.filter((x) => x.title.startsWith('Inverter') || x.title.includes('(point')))
      expect(f.sources.map((x) => x.docId)).toEqual([newest.docId]);
    for (const f of fs) {
      expect(f.origin).toBe('ai');
      expect(f.status).toBe('open');
      expect(f.sources[0].loc).toMatch(/^p\. \d+$/);
    }
    expect(s.usage.some((u) => u.run === 'reports')).toBe(true);
    // a check that gets to the end again sweeps again, and asks nothing: every report has been read
    const before = s.reportCalls.length;
    val(await s.ai.checkAll({ dealId: 'd1' }));
    await s.ai.settled();
    expect(s.reportCalls.length).toBe(before);
  });

  it('a report draft refused as too long for its tracked changes is read with fewer of them listed, and raises '
    + 'every issue (#1381)', async () => {
    const shared = new Mem();
    // the newest IE draft, read as a report by its path, and the tax opinion, looked at first
    const tax = { ...room().find((r) => r.name === 'Tax Opinion.pdf')!, tracked: 1_000 };
    const marked = [...recs().map((r) => (r.docId.endsWith('f02') ? { ...r, tracked: 1_000 } : r)), tax];
    const looks = (c: Call) => (c.prompt.includes('Read the first pages') ? { report: true } : script(c));
    const s = setupReports(script, { d1: marked },
      { shared, installId: 'pc1', checklist, reports: looks, changes: clauseChanges(1_000) });
    await deal(s.repo);
    const orig = s.svc.complete.bind(s.svc);
    let refused = 0;
    s.svc.complete = async (input) => {
      if (wasLines(input.prompt).length > 300) {
        if (/is a report by an outside advisor|Read the first pages/.test(input.prompt)) refused++;
        throw Object.assign(new Error('too long'), { code: 'toolong' });
      }
      return orig(input);
    };
    val(await s.ai.firstPass('d1'));
    await s.ai.settled();
    const marks = ['Independent Engineer Report.pdf', 'Tax Opinion.pdf'];
    const answered = s.reportCalls.filter((c) => c.files.length && marks.includes(fromStoreName(c.files[0].name)!.name))
      .map((c) => wasLines(c.prompt).length);
    const looked = s.reportCalls.filter((c) => c.prompt.includes('Read the first pages'));
    expect(refused).toBe(6);                                    // 1,000 then 500 changes, for each of three calls
    expect(answered).toEqual([250, 250, 250]);
    expect(looked.map((c) => fromStoreName(c.files[0].name)!.name)).toEqual(['Tax Opinion.pdf']);
    const titles = val(await s.repo.list('finding', 'd1')).map((l) => (l.envelope.data as Finding).title);
    expect(titles).toEqual(expect.arrayContaining([
      ...ISSUES['Independent Engineer Report.pdf'], ...ISSUES['Tax Opinion.pdf'],
    ]));
  });

  it('a second PC on the deal reads no report again and raises nothing again', async () => {
    const shared = new Mem();
    const a = setupReports(script, { d1: recs() }, { shared, installId: 'pc1', checklist, reports: script });
    await deal(a.repo);
    val(await a.ai.firstPass('d1'));
    await a.ai.settled();
    const fs = val(await a.repo.list('finding', 'd1'));
    const n = fs.length;
    expect(n).toBeGreaterThan(60);
    const b = setupReports(
      script,
      { d1: recs() },
      { shared, installId: 'pc2', checklist, repo: a.repo, reports: script },
    );
    val(await b.ai.checkAll({ dealId: 'd1' }));
    await b.ai.settled();
    expect(b.reportCalls.some((c) => c.prompt.includes('is a report by an outside advisor'))).toBe(false);
    expect(val(await a.repo.list('finding', 'd1')).length).toBe(n);
  });

  it('a read reply cut off mid-issue keeps the whole issues before the cut and asks on after them: it is '
    + 'never asked again shorter, so no issue is lost', async () => {
    const five = ['A1 issue', 'A2 issue', 'A3 issue', 'A4 issue', 'A5 issue'];
    const docs = recs().filter((r) => r.name === 'Market Consultant Report.pdf');
    let first = true;
    const reports = (c: Call) => {
      if (!c.files.length) return sortReply(c.prompt);
      const r = readReply(c.prompt, '', five);
      if (first) {
        first = false;
        const text = JSON.stringify(r);
        return text.slice(0, text.indexOf('A4 issue') - 30);
      } // stops in the middle of the third issue's write-up
      return r;
    };
    const s = setupReports(script, { d1: docs }, { shared: new Mem(), installId: 'pc1', checklist, reports });
    await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    await s.ai.settled();
    expect(s.reportCalls.some((c) => c.prompt.includes('about half as long'))).toBe(false);
    expect(
      val(await s.repo.list('finding', 'd1'))
        .map((l) => (l.envelope.data as Finding).title)
        .sort(),
    ).toEqual(five);
  });

  it('a sweep the service could not finish is taken up again, by the next first pass when nothing else asks '
    + 'for it', async () => {
    const docs = recs().filter((r) => r.name === 'Legal Due Diligence Report.pdf');
    let down = true;
    const reports = (c: Call) => {
      if (down) throw Object.assign(new Error('The service cannot be reached.'), { code: 'unreachable' });
      return script(c);
    };
    const s = setupReports(script, { d1: docs }, { shared: new Mem(), installId: 'pc1', checklist, reports });
    await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    await s.ai.settled();
    expect(val(await s.repo.list('finding', 'd1')).length).toBe(0);
    down = false;
    val(await s.ai.firstPass('d1'));
    await s.ai.settled();
    expect(
      val(await s.repo.list('finding', 'd1'))
        .map((l) => (l.envelope.data as Finding).title)
        .sort(),
    ).toEqual([...ISSUES['Legal Due Diligence Report.pdf']].sort());
    await s.ai.close();
  });

  it('a deal checked before and unchanged since is swept once when the app starts looking over its deals', async () => {
    const docs = recs().filter((r) => r.name === 'Legal Due Diligence Report.pdf');
    const s = setupReports(
      script,
      { d1: docs },
      { shared: new Mem(), installId: 'pc1', checklist, reports: script, timing: { watch: 20 } },
    );
    await deal(s.repo);
    s.ai.watchDeals!();
    for (let i = 0; i < 50 && val(await s.repo.list('finding', 'd1')).length < 3; i++)
      await new Promise((r) => setTimeout(r, 20));
    await s.ai.close();
    await s.ai.settled();
    expect(
      val(await s.repo.list('finding', 'd1'))
        .map((l) => (l.envelope.data as Finding).title)
        .sort(),
    ).toEqual([...ISSUES['Legal Due Diligence Report.pdf']].sort());
    expect(s.reportCalls.filter((c) => c.files.length).length).toBe(1); // swept once, not on every look
  });

  it('an issue a checklist finding already covers adds the report’s page to that finding’s sources, after '
    + 'its own, and changes nothing else', async () => {
    const docs = recs().filter((r) => r.name === 'Legal Due Diligence Report.pdf');
    const s = setupReports(script, { d1: docs }, { shared: new Mem(), installId: 'pc1', checklist, reports: script });
    await deal(s.repo);
    const body = ['The offtaker has not consented to the assignment of the PPA. [1]'];
    val(
      await s.repo.transaction({
        writes: [
          {
            kind: 'finding',
            id: 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ',
            data: {
              id: 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ',
              dealId: 'd1',
              title: 'PPA assignment needs offtaker consent not yet given',
              workstream: 'Legal',
              status: 'open',
              raisedAt: '2026-11-10T09:00:00.000Z',
              body,
              next: '',
              sources: [{ doc: 'Power Purchase Agreement.pdf', docId: 'doc_000000000000000000000abc', loc: 'p. 12' }],
              origin: 'ai',
              note: 'kept',
              reviewed: null,
              updated: false,
            },
            expectedRev: null,
          },
        ],
        index: { dealId: 'd1', add: [{ kind: 'finding', id: 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ' }] },
      }),
    );
    val(await s.ai.firstPass('d1'));
    await s.ai.settled();
    const fs = val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as Finding);
    const had = fs.find((f) => f.id === 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ')!;
    expect(had.sources.map((x) => [x.doc, x.loc])).toEqual([
      ['Power Purchase Agreement.pdf', 'p. 12'],
      ['Legal Due Diligence Report.pdf', expect.stringMatching(/^p\. \d+$/)],
    ]);
    expect(had.body).toEqual(body);
    expect(had.note).toBe('kept');
    expect(had.updated).toBe(false);
    expect(fs.length).toBe(3); // the other two issues are findings of their own
  });
});

describe('a report read names the deal\'s findings by their ids (#1162)', () => {
  const docs = () => room().filter((d) => d.name === 'Legal Due Diligence Report.pdf');
  const known = () => new Map<string, Known & { issue?: Issue }>([
    ['f_open', { id: 'f_open', title: 'PPA assignment needs offtaker consent not yet given' }],
    ['f_closed', { id: 'f_closed', title: 'Two lease parcels lack recorded memoranda', closed: true }],
  ]);

  it('lists each finding by its id and asks for "covered" and "earlier" by id', async () => {
    const { k, calls } = kit(docs(), { findings: known() });
    await sweep(k);
    const prompt = calls.find((c) => c.kind === 'report')!.prompt;
    expect(prompt).toContain('\nf_open: PPA assignment needs offtaker consent not yet given\n'
      + 'f_closed: Two lease parcels lack recorded memoranda (closed)\n');
    expect(prompt).not.toMatch(/^F\d+: /m);
    expect(prompt).toContain('already covers is given as {"covered": "<finding id>"}');
    expect(prompt).toContain('with "earlier": "<finding id>".');
  });

  it('maps "covered" and "earlier" back to the findings with those ids', async () => {
    const findings = known();
    const answer = ({ kind, prompt }: { kind: string; prompt: string }) => (kind !== 'report' ? undefined : {
      advisor: 'Counsel',
      issues: [
        { covered: 'f_open', sources: [{ doc: reportId(prompt), page: 3 }] },
        { title: 'Lease parcels unrecorded', earlier: 'f_closed', workstream: 'Legal', body: ['Again. [1]'],
          sources: [{ doc: reportId(prompt), page: 4 }] },
      ],
    });
    const { k, cites } = kit(docs(), { findings, answer });
    await sweep(k);
    expect(cites).toEqual([{ id: 'f_open', locs: ['p. 3'] }]);
    expect(raisedTitles(findings)).toEqual(['Lease parcels unrecorded']);
    expect([...findings.values()].find((f) => f.issue)!.issue!.earlier).toBe('f_closed');
  });

  it('refuses a reply whose "covered" or "earlier" is a label or an id it was not shown, to be asked again',
    async () => {
      const { k, calls, shownTo } = kit(docs(), { findings: known() });
      await sweep(k);
      const unusable = calls.find((c) => c.kind === 'report')!.unusable!;
      const reply = (row: object) => JSON.stringify({ advisor: 'Counsel', issues: [row] });
      expect(await unusable(reply({ covered: 'F1' }))).toBe(true);
      expect(await unusable(reply({ title: 'T', earlier: 'f_9' }))).toBe(true);
      expect(await unusable(reply({ covered: 'f_open ' }))).toBe(true);
      expect(await unusable(reply({ covered: 'f_open' }))).toBe(false);
      expect(await unusable(reply({ title: 'T', earlier: 'f_closed', covered: '' }))).toBe(false);
      // and the words of the reply are held to the same ids (docsUnusable's `shown`)
      expect(shownTo.at(-1)).toEqual(['f_open', 'f_closed']);
    });
});
