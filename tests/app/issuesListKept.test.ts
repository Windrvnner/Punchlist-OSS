// @vitest-environment node
// The issues list import as kept on this PC, the import that lets it go, and a finding's points grouped by list (#951).
import { expect, it } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { ImportIssuesList } from '../../src/app/commands/issuesList';
import {
  importKey, initializeKeptImports, keepImport, keptImport, keptImportsReady,
} from '../../src/app/keptImports';
import {
  keepIssuesPaste, keptIssuesList, keptIssuesPaste, pointsByList, reviewIssuesList, submitIssuesList, type ReadIssuesList,
} from '../../src/app/issuesList';
import { dealFindings } from '../../src/app/state';
import type { ListPoint } from '../../src/domain/model';
import { failRecoveryWrite, holdRecoveryWrite, recoveryApp, recoveryDeal } from './recoveryKit';

const POINTS = 120;

function readList(): ReadIssuesList {
  const points = Array.from({ length: POINTS }, (_, at) => ({
    n: String(at + 1), text: `Point ${at + 1}: the reserve account mechanics need a cure period.`,
    title: `Reserve account point ${at + 1}`, workstream: 'Legal',
  }));
  return { doc: { docId: 'doc_lenderlist', doc: 'Lender list.pdf' }, points };
}

async function keptPort() {
  initializeKeptImports(new MemoryKeptImports());
  await keptImportsReady;
}

it('reads back a kept list and its marks, and opens fresh past a damaged one', async () => {
  await keptPort();
  const key = importKey.issues('d_kept');
  expect(keptIssuesList(key)).toBeNull();
  const list = readList();
  keepImport(key, { list, kept: new Set([3, 7]) });
  expect(keptIssuesList(key)).toEqual({ list, kept: new Set([3, 7]) });
  const damaged = [
    { list, kept: [3, 7] },
    { list: { ...list, doc: { doc: 'Lender list.pdf' } }, kept: new Set() },
    { list: { ...list, points: [...list.points, { n: 41, text: 'x', title: 'x', workstream: 'Legal' }] },
      kept: new Set() },
    { list: { ...list, points: 'none' }, kept: new Set() },
  ];
  for (const entry of damaged) {
    keepImport(key, entry);
    expect(keptIssuesList(key)).toBeNull();
  }
});

it('lets the kept list go while the import runs and keeps it again when the import fails', async () => {
  await keptPort();
  const app = recoveryApp(undefined, [ImportIssuesList]);
  try {
    const dealId = await recoveryDeal(app);
    const key = importKey.issues(dealId);
    const list = readList();
    const kept = new Set([5]);
    const { input } = reviewIssuesList(app.store.get(), dealId, list, kept);
    keepImport(key, { list, kept, paste: '1. a' });
    // the import keeps the state as it is when it fails, not as Import found it
    let atFailure = kept;
    const now = () => ({ list, kept: atFailure });
    const restore = failRecoveryWrite(app, (tx) => {
      atFailure = new Set([5, 9]);
      return tx.writes.some((write) => write.kind === 'finding');
    }, 'Disk full');
    const refused = await submitIssuesList(app.store, key, { dealId, list, points: input }, now);
    restore();
    expect(refused.ok).toBe(false);
    expect(keptIssuesList(key)).toMatchObject({ list, kept: new Set([5, 9]) });
    // the paste typed and not read survives the failed import, and goes with a successful one (#1021)
    expect(keptIssuesPaste(key)).toBe('1. a');
    const held = holdRecoveryWrite(app, (tx) => tx.writes.some((write) => write.kind === 'finding'));
    const sending = submitIssuesList(app.store, key, { dealId, list, points: input }, now);
    await held.entered;
    expect(keptImport(key)).toBeUndefined();
    held.release();
    expect((await sending).ok).toBe(true);
    expect(keptImport(key)).toBeUndefined();
    expect(keptIssuesPaste(key)).toBe('');
    expect(dealFindings(app.store.get(), dealId)).toHaveLength(POINTS);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('keeps the paste typed in the box, and writes nothing for a box that is empty or only spaces', async () => {
  await keptPort();
  const key = importKey.issues('d_paste');
  keepIssuesPaste(key, ' \n ', false);
  expect(keptImport(key)).toBeUndefined();
  keepIssuesPaste(key, '1. Fees letter', false);
  expect(keptIssuesPaste(key)).toBe('1. Fees letter');
  keepIssuesPaste(key, '', false);
  expect(keptIssuesPaste(key)).toBe('');
});

it('leaves a kept paste alone when the dialog opened fresh past a kept import it could not show', async () => {
  await keptPort();
  const key = importKey.issues('d_fresh');
  keepImport(key, { paste: '1. Fees letter' });
  keepIssuesPaste(key, '', true);
  expect(keptIssuesPaste(key)).toBe('1. Fees letter');
  keepIssuesPaste(key, '2. New', true);
  expect(keptIssuesPaste(key)).toBe('2. New');
});

it('takes a kept paste only when it is text', async () => {
  await keptPort();
  const key = importKey.issues('d_notext');
  keepImport(key, { paste: 7 });
  expect(keptIssuesPaste(key)).toBe('');
});

it('groups a finding\'s points by list in first-seen order, with a heading for each list file', () => {
  const docs = [['doc_a', 'Lender list.pdf'], ['doc_b', 'Sponsor list.docx'], ['doc_c', 'Lender list.pdf']];
  const marks: ListPoint[] = Array.from({ length: 120 }, (_, at) => {
    const [doc, list] = docs[at % 3];
    return { doc, list, n: String(at + 1), text: `Point ${at + 1}` };
  });
  const groups = pointsByList(marks);
  expect(groups.map(({ title }) => title)).toEqual(['Lender list', 'Sponsor list', 'Lender list']);
  expect(groups.map(({ points }) => points.length)).toEqual([40, 40, 40]);
  expect(groups[2].points.every(({ doc }) => doc === 'doc_c')).toBe(true);
  expect(groups[0].points.slice(0, 3).map(({ n }) => n)).toEqual(['1', '4', '7']);
});
