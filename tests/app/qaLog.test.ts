// The deal's Q&A log as the team's own file where it lives, read and updated there; the app keeps no copy.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse, EditQuestionField, SetQuestionStatus } from '../../src/app/commands/questions';
import { KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs, ChooseQaVersion, RestoreQaVersion, TakeFromQaLog, RestoreQuestionSnapshots } from '../../src/app/commands/qaLogs';
import { Undo } from '../../src/app/commands/undo';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, qaKept, qaVersions, qaChanged } from '../../src/app/state';
import { RestoreVersion, entriesOf } from '../../src/app/commands/keptVersions';
import { keepImportedLog, chooseVersion, exportQaLog, logName, logOf, logChoice, logTakenBy } from '../../src/app/qaLog';
import { suggestMapping } from '../../src/domain/importExport';
import { ok, fail } from '../../src/domain/result';
import type { QaLogFiles } from '../../src/ports';

const COMMANDS = [CreateDeal, CreateQuestion, SetResponse, EditQuestionField, SetQuestionStatus, KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs, ChooseQaVersion, RestoreQaVersion, TakeFromQaLog, RestoreQuestionSnapshots, Undo, RestoreVersion];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 15, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

const columns = ['No.', 'Question', 'Response'];
const PATH = 'X:\\Deals\\Proseware\\Q&A\\Lender A Q&A.xlsx';
/** the log's rows as the import read them */
const LOG = [['1', 'What is the DSCR?', ''], ['2', 'Who is the EPC contractor?', 'Fabrikam']];
/** a stand-in for the files: the log on the drive holds two questions; what each read and save was asked */
function files(over: Partial<QaLogFiles> = {}) {
  const saves: Parameters<QaLogFiles['save']>[0][] = []; const reads: Parameters<QaLogFiles['read']>[0][] = []; const made: Parameters<QaLogFiles['create']>[0][] = [];
  const f: QaLogFiles = {
    read: async (at) => {
      reads.push(at);
      return ok({
        columns,
        cols: [0, 1, 2],
        lines: [2, 3],
        lastRow: 3,
        rows: [
          ['1', 'What is the DSCR?', ''],
          ['2', 'Who is the EPC contractor?', 'Fabrikam'],
        ],
        stamp: 's1',
      });
    },
    save: async (req) => { saves.push(req); return ok({ status: 'written' as const, archive: `Lender A Q&A 2026-11-15 100${saves.length}.xlsx` }); },
    create: async (req) => { made.push(req); return ok({ file: req.file }); },
    ...over,
  };
  return { f, saves, reads, made };
}
async function make(qaLogs: QaLogFiles, picks: string[] = ['X:\\Deals\\Proseware\\Q&A v2'], path: string | null = PATH, rows = LOG) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
  const asked: number[] = [];
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: async () => { asked.push(1); return ok(picks); }, pathFor: null, save: async () => ok('saved' as const) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), qaLogs, clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
  await store.dispatch(CreateQuestion, { dealId, text: 'What is the DSCR?' }); await store.dispatch(CreateQuestion, { dealId, text: 'Who is the EPC contractor?' });
  const [q1, q2] = dealQuestions(store.get(), dealId);
  for (const q of [q1, q2]) await store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'askedBy', value: 'Lender A' });
  await store.dispatch(SetResponse, { dealId, questionId: q2.id, response: 'Fabrikam' });
  expect((await keepImportedLog(store, dealId, { path, sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns), make: true, rows })).ok).toBe(true);
  return { store, dealId, asked };
}

describe('a deal\'s Q&A log', () => {
  it('is named after its file, without the extension or " - vCurrent"', () => {
    expect(logName('Lender A Q&A - vCurrent.xlsx')).toBe('Lender A Q&A'); expect(logName('Lender A Q&A.v2.csv')).toBe('Lender A Q&A.v2');
  });
  it('is the first file the deal imports, by where that file is: nothing of it is copied', async () => {
    const { store, dealId } = await make(files().f);
    expect(store.get().deals[dealId].qaLogs).toEqual([{ name: 'Lender A Q&A', file: 'Lender A Q&A.xlsx', folder: 'X:\\Deals\\Proseware\\Q&A', sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns), last: expect.objectContaining({ sent: expect.any(Object) }) }]);
  });
  it('stays the one log when another party\'s list is imported; the same file imported again keeps where its table is', async () => {
    const { store, dealId } = await make(files().f);
    await keepImportedLog(store, dealId, { path: 'C:\\Users\\a\\Downloads\\Bidder C questions.xlsx', sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns), make: true, rows: LOG });
    expect(store.get().deals[dealId].qaLogs.map((l) => l.file)).toEqual(['Lender A Q&A.xlsx']);
    await keepImportedLog(store, dealId, { path: PATH, sheet: 'Q&A', headerRow: 3, mapping: suggestMapping(columns), make: true, rows: LOG });
    expect(logOf(store, dealId)).toMatchObject({ file: 'Lender A Q&A.xlsx', sheet: 'Q&A', headerRow: 3 });
  });
  it('is never a file in one of the deal\'s document folders: that is a document, not the log', async () => {
    const { store, dealId } = await make(files().f, [], null);
    store.get().deals[dealId].folders.push({ path: 'X:\\Deals\\Proseware\\Data room', label: 'Data room', files: 1, size: '1 MB' } as never);
    await keepImportedLog(store, dealId, { path: 'X:\\Deals\\Proseware\\Data room\\Q&A\\Lender Q&A.xlsx', sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns), make: true, rows: LOG });
    expect(store.get().deals[dealId].qaLogs).toEqual([]);
  });
  it('is a file only when the person leaves "Make this file the deal\'s Q&A log" checked at the import', async () => {
    const { store, dealId } = await make(files().f, [], null);
    expect(logChoice(store, dealId, PATH)).toBe('new');
    await keepImportedLog(store, dealId, { path: PATH, sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns), make: false, rows: LOG });
    expect(store.get().deals[dealId].qaLogs).toEqual([]);
  });
  it('is not offered again once the deal has one; its own file imported again is kept up to date without asking', async () => {
    const { store, dealId } = await make(files().f);
    expect([logChoice(store, dealId, PATH), logChoice(store, dealId, 'X:\\Other\\Bidder C.xlsx'), logChoice(store, dealId, null)]).toEqual(['same', null, null]);
    await keepImportedLog(store, dealId, { path: PATH, sheet: 'Q&A', headerRow: 3, mapping: suggestMapping(columns), make: false, rows: LOG });
    expect(logOf(store, dealId)).toMatchObject({ sheet: 'Q&A', headerRow: 3 });
  });
  it('is the same file when only the path\'s case or slashes differ, as Windows treats them', async () => {
    const { store, dealId } = await make(files().f);
    expect(logChoice(store, dealId, PATH.toLowerCase().replace(/\\/g, '/'))).toBe('same');
  });
  it('is not kept from a file whose place is not known (the browser demo)', async () => {
    const { store, dealId } = await make(files().f, [], null);
    expect(store.get().deals[dealId].qaLogs).toEqual([]);
  });
  it('is updated where it is, from the file as it is now, and records what the app holds in it', async () => {
    const { f, saves, reads } = files(); const { store, dealId, asked } = await make(f);
    const [q1, q2] = dealQuestions(store.get(), dealId);
    await store.dispatch(SetResponse, { dealId, questionId: q1.id, response: '1.20x' });
    expect(await exportQaLog(store, dealId)).toEqual({ ok: true, value: { status: 'written', archive: 'Lender A Q&A 2026-11-15 1001.xlsx', added: 0, answered: 1, updated: 0, changed: 0, kept: [], keptText: {}, clashed: [], unmerged: 0 } });
    expect(reads[0]).toEqual({ folder: 'X:\\Deals\\Proseware\\Q&A', file: 'Lender A Q&A.xlsx' });
    expect(saves[0]).toEqual({ folder: 'X:\\Deals\\Proseware\\Q&A', file: 'Lender A Q&A.xlsx', sheet: 'Log', stamp: 's1', steps: [{ kind: 'cell', row: 1, col: 2, value: '1.20x' }] });
    expect(logOf(store, dealId)!.last).toMatchObject({
      archive: 'Lender A Q&A 2026-11-15 1001.xlsx',
      sent: { [q1.id]: { response: '1.20x', text: 'What is the DSCR?', n: '1' }, [q2.id]: { response: 'Fabrikam' } },
    });
    expect(asked).toEqual([]);                                                            // its folder is known from the import
  });
  it('writes nothing, and records nothing new, when the file is in use', async () => {
    const { f } = files({ save: async () => ok({ status: 'later' as const }) }); const { store, dealId } = await make(f);
    await store.dispatch(SetResponse, { dealId, questionId: dealQuestions(store.get(), dealId)[0].id, response: '1.20x' });
    const before = logOf(store, dealId)!.last;
    expect(await exportQaLog(store, dealId)).toEqual({ ok: true, value: { status: 'later' } }); expect(logOf(store, dealId)!.last).toEqual(before);
  });
  // An answer changed in the app to a question that came in with the log never reached it
  it('takes what the file held when it became the log as what the app wrote, so an answer changed in the app reaches it', async () => {
    const { f, saves } = files(); const { store, dealId } = await make(f);
    const q2 = dealQuestions(store.get(), dealId)[1];
    expect(logOf(store, dealId)!.last!.sent[q2.id]).toEqual({
      text: 'Who is the EPC contractor?',
      response: 'Fabrikam',
    });
    await store.dispatch(SetResponse, { dealId, questionId: q2.id, response: 'Fabrikam Construction, fixed price' });
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', updated: 1, kept: [] } });
    expect(saves[0].steps).toEqual([{ kind: 'cell', row: 2, col: 2, value: 'Fabrikam Construction, fixed price' }]);
  });
  it('clears a response erased in the app, when the file still holds what it took in (#39)', async () => {
    const { f, saves } = files();
    const { store, dealId } = await make(f);
    const q2 = dealQuestions(store.get(), dealId)[1];
    await store.dispatch(SetResponse, { dealId, questionId: q2.id, response: '' });
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', updated: 1, kept: [] } });
    expect(saves[0].steps).toEqual([{ kind: 'cell', row: 2, col: 2, value: '' }]);
    expect(logOf(store, dealId)!.last!.sent[q2.id].response).toBe('');
  });
  it('keeps an answer someone changed in the file, and writes the app\'s over it once a person keeps the app\'s', async () => {
    const theirs = {
      columns,
      cols: [0, 1, 2],
      lines: [2, 3],
      lastRow: 3,
      rows: [
        ['1', 'What is the DSCR?', ''],
        ['2', 'Who is the EPC contractor?', 'Contoso (changed by a colleague)'],
      ],
      stamp: 's2',
    };
    let changed = false; const { f, saves } = files({ read: async () => ok(changed ? theirs : { columns, cols: [0, 1, 2], lines: [2, 3], lastRow: 3, rows: LOG, stamp: 's1' }) });
    const { store, dealId } = await make(f); const q2 = dealQuestions(store.get(), dealId)[1];
    changed = true; await store.dispatch(SetResponse, { dealId, questionId: q2.id, response: 'Fabrikam Construction' });
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [2] } }); expect(saves).toEqual([]);   // theirs stands
    const kept = await exportQaLog(store, dealId); const shown = kept.ok && kept.value.status === 'written' ? kept.value.keptText[q2.id] : {};
    expect(shown).toEqual({ response: 'Contoso (changed by a colleague)' });
    expect(shown).toBeTruthy(); expect((await chooseVersion(store, dealId, q2.id, 'app')).ok).toBe(true);
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', updated: 1, kept: [] } });
    expect(saves[0].steps).toEqual([{ kind: 'cell', row: 2, col: 2, value: 'Fabrikam Construction' }]);
  });
  it('takes in an answer only the log changed, as the latest, and marks the question Changed with what it held', async () => {
    const at = (r: string) => ({ columns, cols: [0, 1, 2], lines: [2, 3], lastRow: 3, rows: [['1', 'What is the DSCR?', ''], ['2', 'Who is the EPC contractor?', r]], stamp: r });
    const box = { file: at('Fabrikam') }; const { f, saves } = files({ read: async () => ok(box.file) });
    const { store, dealId } = await make(f); const q2 = dealQuestions(store.get(), dealId)[1];
    // changed in the file; the app's still says Fabrikam
    box.file = at('Fabrikam SA, signed November 14');
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', changed: 1, kept: [] } }); expect(saves).toEqual([]);
    const q = store.get().questions[q2.id];
    expect([
      q.response,
      qaVersions(store.get(), q),
      qaChanged(store.get(), q),
      logOf(store, dealId)!.last!.changed[q2.id],
    ]).toEqual(['Fabrikam SA, signed November 14', '', ['response'], { response: 'Fabrikam' }]);
    // the next update finds nothing to write, and the question no longer counts as changed then
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', changed: 0, updated: 0, kept: [] } }); expect(saves).toEqual([]);
  });
  it('a response saved in the app while the update saves the file is kept as two versions, never replaced (#40)', async () => {
    const at = (r: string) => ({ columns, cols: [0, 1, 2], lines: [2, 3], lastRow: 3, rows: [['1', 'What is the DSCR?', ''], ['2', 'Who is the EPC contractor?', r]], stamp: r });
    const box = { file: at('Fabrikam') }; const { f } = files({ read: async () => ok(box.file) });
    const { store, dealId } = await make(f); const [q1, q2] = dealQuestions(store.get(), dealId);
    box.file = at('Fabrikam SA, signed November 14');                                     // changed in the file
    await store.dispatch(SetResponse, { dealId, questionId: q1.id, response: '1.20x' });  // so the update saves
    const save = store.services.qaLogs!.save;
    store.services.qaLogs!.save = async (req) => {
      const saved = await save(req);
      const typed = await store.dispatch(SetResponse, { dealId, questionId: q2.id, response: 'Fabrikam Construction, app revision' });
      expect(typed.ok).toBe(true);
      return saved;
    };
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', changed: 0, kept: [2] } });
    const q = store.get().questions[q2.id];
    expect([q.response, qaVersions(store.get(), q), qaKept(store.get(), q)])
      .toEqual(['Fabrikam Construction, app revision', 'Two versions', { response: 'Fabrikam SA, signed November 14' }]);
    expect(logOf(store, dealId)!.last!.sent[q2.id].response).toBe('Fabrikam');
  });
  // a log that writes a status or a date its own way ("Outstanding", 11/20/2026) is read in the app's terms
  it('takes in a status or date only the log changed, written its own way, as Changed and not as two versions', async () => {
    const cols4 = ['No.', 'Question', 'Response', 'Status', 'Date'];
    const at = (st: string, dt: string) => ({
      columns: cols4,
      cols: [0, 1, 2, 3, 4],
      lines: [2, 3],
      lastRow: 3,
      rows: [
        ['1', 'What is the DSCR?', '', 'Open', ''],
        ['2', 'Who is the EPC contractor?', 'Fabrikam', st, dt],
      ],
      stamp: st + dt,
    });
    const box = { file: at('Answered', '2026-11-12') }; const { f, saves } = files({ read: async () => ok(box.file) });
    const { store, dealId } = await make(f, undefined, PATH, box.file.rows);
    const q2 = dealQuestions(store.get(), dealId)[1];
    await store.dispatch(SetQuestionStatus, { dealId, questionId: q2.id, status: 'answered' }); await store.dispatch(EditQuestionField, { dealId, questionId: q2.id, field: 'responded', value: '2026-11-12' });
    await keepImportedLog(store, dealId, { path: PATH, sheet: 'Log', headerRow: 1, mapping: suggestMapping(cols4), make: true, rows: box.file.rows });
    box.file = at('Outstanding', '11/20/2026');
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', changed: 1, kept: [] } }); expect(saves).toEqual([]);
    const q = store.get().questions[q2.id];
    expect([q.status, q.responded, qaVersions(store.get(), q), qaChanged(store.get(), q).sort()]).toEqual(['open', '2026-11-20', '', ['responded', 'status']]);
  });
  describe('two versions, resolved', () => {
    // the log says "Contoso" where the app now says "Fabrikam Construction":
    // the update leaves the file's and lists the question
    async function twoVersions(response = 'Contoso') {
      const at = (r: string) => ({ columns, cols: [0, 1, 2], lines: [2, 3], lastRow: 3, rows: [['1', 'What is the DSCR?', ''], ['2', 'Who is the EPC contractor?', r]], stamp: r });
      const box = { file: at('Fabrikam') }; const { f, saves } = files({ read: async () => ok(box.file) });
      const { store, dealId } = await make(f); const q2 = dealQuestions(store.get(), dealId)[1];
      box.file = at(response);
      await store.dispatch(SetResponse, { dealId, questionId: q2.id, response: 'Fabrikam Construction' });
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [2] } });
      const q = () => store.get().questions[q2.id];
      expect([qaVersions(store.get(), q()), qaKept(store.get(), q())]).toEqual(['Two versions', { response }]);
      return { store, dealId, q, saves, box, at };
    }
    it('the log\'s version is taken into the app, and the next update leaves the file as it is', async () => {
      const { store, dealId, q, saves } = await twoVersions();
      const r = await chooseVersion(store, dealId, q().id, 'log'); expect(r.ok).toBe(true);
      expect([q().response, qaVersions(store.get(), q())]).toEqual(['Contoso', '']);
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [] } }); expect(saves).toEqual([]);
    });
    it('Undo straight after puts the question back in two versions', async () => {
      const { store, dealId, q } = await twoVersions();
      const r = await chooseVersion(store, dealId, q().id, 'log'); await store.dispatch(Undo, { opId: r.ok ? r.value.opId : '' });
      expect([q().response, qaVersions(store.get(), q())]).toEqual(['Fabrikam Construction', 'Two versions']);
    });
    it('the app\'s version, or a merged response, is written into the log at the next update', async () => {
      for (const [pick, merged, want] of [
        ['app', undefined, 'Fabrikam Construction'],
        [
          'merged',
          'Fabrikam Construction, with Contoso for civil works',
          'Fabrikam Construction, with Contoso for civil works',
        ],
      ] as const) {
        const { store, dealId, q, saves } = await twoVersions();
        expect((await chooseVersion(store, dealId, q().id, pick, { merged })).ok).toBe(true);
        expect([q().response, qaVersions(store.get(), q())]).toEqual([want, '']);
        expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', updated: 1, kept: [] } });
        expect(saves[0].steps).toEqual([{ kind: 'cell', row: 2, col: 2, value: want }]);
      }
    });
    // the file is not read again at the choice: the next update finds the cell changed again and leaves it
    it('a cell changed in the file again after the person saw it is in two versions again at the next update, never written over', async () => {
      const { store, dealId, q, box, at, saves } = await twoVersions();
      box.file = at('Contoso, revised');
      expect((await chooseVersion(store, dealId, q().id, 'app')).ok).toBe(true); expect(qaVersions(store.get(), q())).toBe('');
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [2] } }); expect(saves).toEqual([]);
      expect(qaKept(store.get(), q())).toEqual({ response: 'Contoso, revised' });
    });
    it('keeps the app\'s even while the log cannot be reached', async () => {
      const { store, dealId, q } = await twoVersions();
      store.services.qaLogs!.read = async () => fail({ kind: 'unreachable', message: 'The drive is offline' });
      expect((await chooseVersion(store, dealId, q().id, 'app')).ok).toBe(true); expect(qaVersions(store.get(), q())).toBe('');
    });
    it('a merged response used as the AI drafted it keeps the AI label; once changed it is the person\'s', async () => {
      for (const [merged, origin] of [
        ['Fabrikam, with Contoso for civil works', 'ai'],
        ['Fabrikam, with Contoso for civil works (checked)', 'human'],
      ] as const) {
        const { store, dealId, q } = await twoVersions();
        expect(
          (
            await chooseVersion(store, dealId, q().id, 'merged', {
              merged,
              drafted: 'Fabrikam, with Contoso for civil works',
            })
          ).ok,
        ).toBe(true);
        expect([q().response, q().provenance?.origin]).toEqual([merged, origin]);
      }
    });    // a choice is kept on its question, so it never rewrites the deal's log record (which holds every
    // question's cells) and two PCs resolving different questions never write one record
    it('writes only its question, never the deal; the choice reaches the file at the next update, and then is spent', async () => {
      const { store, dealId, q, saves } = await twoVersions(); const deal = store.get().deals[dealId];
      expect((await chooseVersion(store, dealId, q().id, 'app')).ok).toBe(true);
      expect(store.get().deals[dealId]).toBe(deal);
      expect(q().logPick).toEqual({ of: deal.qaLogs[0].last!.at, sent: { response: 'Contoso' } });
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', updated: 1, kept: [] } });
      expect(saves[0].steps).toEqual([{ kind: 'cell', row: 2, col: 2, value: 'Fabrikam Construction' }]);
      expect(store.get().deals[dealId].qaLogs[0].last!.sent[q().id]).toMatchObject({
        response: 'Fabrikam Construction',
      });
    });
    it('is refused when another update has replaced the one it answers, so it never settles cells the person did not see', async () => {
      const { store, dealId, q } = await twoVersions(); const of = store.get().deals[dealId].qaLogs[0].last!.at;
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [2] } });
      expect(
        await store.dispatch(ChooseQaVersion, {
          dealId,
          questionId: q().id,
          of,
          set: {},
          sent: { response: 'Contoso' },
        }),
      ).toMatchObject({ ok: false, error: { message: expect.stringContaining('updated since') } });
      expect(qaVersions(store.get(), q())).toBe('Two versions');
    });
    it('is refused when the versions the person saw are from an update that another has replaced, so nothing they did not see is written over', async () => {
      const { store, dealId, q, box, at } = await twoVersions(); const seen = store.get().deals[dealId].qaLogs[0].last!.at;
      box.file = at('Contoso, revised by the lender');
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [2] } });
      expect(
        await chooseVersion(store, dealId, q().id, 'merged', { merged: 'Fabrikam, with Contoso', seen }),
      ).toMatchObject({ ok: false, error: { message: expect.stringContaining('updated since') } });
      expect([q().response, qaKept(store.get(), q())]).toEqual([
        'Fabrikam Construction',
        { response: 'Contoso, revised by the lender' },
      ]);
    });
    // nothing is thrown away: the app's version a choice replaces is listed under Deleted and can be restored
    it('sets the app\'s version aside under Deleted when the log\'s or a merged one is taken; Undo takes the entry back', async () => {
      for (const [pick, merged] of [
        ['log', undefined],
        ['merged', 'Fabrikam, with Contoso for civil works'],
      ] as const) {
        const { store, dealId, q } = await twoVersions();
        const r = await chooseVersion(store, dealId, q().id, pick, { merged });
        const [e] = entriesOf(store.get(), q().id);
        expect([
          entriesOf(store.get(), q().id).length,
          (e?.snapshot as { response?: string })?.response,
          e?.edited,
          e?.from,
          e?.actor,
        ]).toEqual([1, 'Fabrikam Construction', true, 'In the app', store.get().user?.name ?? expect.any(String)]);
        await store.dispatch(Undo, { opId: r.ok ? r.value.opId : '' });
        expect([entriesOf(store.get(), q().id).length, q().response]).toEqual([0, 'Fabrikam Construction']);
      }
    });
    it('makes no entry when the app\'s version is kept: the log\'s stays in the file\'s archive', async () => {
      const { store, dealId, q } = await twoVersions();
      expect((await chooseVersion(store, dealId, q().id, 'app')).ok).toBe(true); expect(entriesOf(store.get(), q().id)).toEqual([]);
    });
    it('makes no entry when a merge used as the AI drafted it repeats the app\'s words: only the label differs', async () => {
      const { store, dealId, q } = await twoVersions();
      expect(
        (
          await chooseVersion(store, dealId, q().id, 'merged', {
            merged: 'Fabrikam Construction',
            drafted: 'Fabrikam Construction',
          })
        ).ok,
      ).toBe(true);
      expect(entriesOf(store.get(), q().id)).toEqual([]);
    });
    it('restores the app\'s version from Deleted after the update, as RestoreVersion restores any set-aside version', async () => {
      const { store, dealId, q } = await twoVersions();
      expect((await chooseVersion(store, dealId, q().id, 'log')).ok).toBe(true); expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written' } });
      const [e] = entriesOf(store.get(), q().id); expect((await store.dispatch(RestoreVersion, { dealId, entryId: e.id })).ok).toBe(true);
      expect(entriesOf(store.get(), q().id)).toEqual([]);   // written beside the kept one (keptVersions; two PCs' repositories show it as two versions: tests/app/keepBoth.test.ts)
    });
    it('cannot be undone once an update has written it into the file: Undo says so and changes nothing', async () => {
      for (const pick of ['app', 'log'] as const) {
        const { store, dealId, q } = await twoVersions();
        const r = await chooseVersion(store, dealId, q().id, pick); expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written' } }); const after = q().response;
        expect(await store.dispatch(Undo, { opId: r.ok ? r.value.opId : '' })).toMatchObject({ ok: false });
        expect([q().response, qaVersions(store.get(), q())]).toEqual([after, '']);
      }
    });
    it('survives the deal\'s own log being imported again before the next update', async () => {
      const { store, dealId, q, saves } = await twoVersions();
      expect((await chooseVersion(store, dealId, q().id, 'app')).ok).toBe(true);
      const rows = [['1', 'What is the DSCR?', ''], ['2', 'Who is the EPC contractor?', 'Contoso']];
      expect((await keepImportedLog(store, dealId, { path: PATH, sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns), make: false, rows })).ok).toBe(true);
      expect(qaVersions(store.get(), q())).toBe('');
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', updated: 1, kept: [] } });
      expect(saves[0].steps).toEqual([{ kind: 'cell', row: 2, col: 2, value: 'Fabrikam Construction' }]);
    });
    it('made while an update is saving the file, is counted by that update rather than asked again', async () => {
      const { store, dealId, q, box, at } = await twoVersions();
      await store.dispatch(SetResponse, { dealId, questionId: dealQuestions(store.get(), dealId)[0].id, response: '1.35x' });   // something for the update to write
      const save = store.services.qaLogs!.save; store.services.qaLogs!.save = async (req) => { expect((await chooseVersion(store, dealId, q().id, 'app')).ok).toBe(true); return save(req); };
      expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [] } });
      expect(qaVersions(store.get(), q())).toBe(''); box.file = at('Contoso');
      store.services.qaLogs!.save = save; const r = await exportQaLog(store, dealId);
      expect(r).toMatchObject({ value: { status: 'written', updated: 1, kept: [] } });
    });
  });
  it('keeps an answer the file held before it became the log when the import added its rows as new questions', async () => {
    const { f, saves } = files({
      read: async () =>
        ok({
          columns,
          cols: [0, 1, 2],
          lines: [2, 3],
          lastRow: 3,
          rows: [
            ['1', 'What is the DSCR?', ''],
            ['2', 'Who is the EPC contractor?', 'Contoso (in the file before import)'],
          ],
          stamp: 's',
        }),
    });
    const { store, dealId } = await make(f, undefined, PATH, [
      ['1', 'What is the DSCR?', ''],
      ['2', 'Who is the EPC contractor?', 'Contoso (in the file before import)'],
    ]);
    // the app's Fabrikam never went over it
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', kept: [2] } });
    expect(saves).toEqual([]);
  });
  it('one file is one deal\'s log: another deal can\'t import it (#38)', async () => {
    const { store, dealId } = await make(files().f);                                      // its log is PATH
    await store.dispatch(CreateDeal, { name: 'Contoso', folders: [] });
    const other = Object.keys(store.get().deals).find((id) => id !== dealId)!; await store.loadDeal(other);
    const said = /^Project Proseware already uses “Lender A Q&A\.xlsx” in this folder as its Q&A log\. Choose another file$/;
    for (const path of [PATH, PATH.toLowerCase(), PATH.replace(/\\/g, '/')]) expect(logTakenBy(store, other, path)).toMatch(said);
    expect(logTakenBy(store, dealId, PATH)).toBeNull();                                  // its own log imports again
    const had = store.get().deals[dealId].qaLogs;
    const log = { name: 'Lender A Q&A', file: 'Lender A Q&A.xlsx', folder: 'X:/Deals/Proseware/Q&A/', sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns) };
    const r = await store.dispatch(KeepQaLog, { dealId: other, log });
    expect(!r.ok && r.error.message).toMatch(said);
    expect([store.get().deals[other].qaLogs, store.get().deals[dealId].qaLogs]).toEqual([[], had]);
  });
  it('of two deals with one name, each keeps its own file: one file is one deal\'s log, and a log the app starts says which deal it is', async () => {
    const { f, made } = files(); const { store, dealId } = await make(f);                // the first Proseware's log is X:\\Deals\\Proseware\\Q&A\\Lender A Q&A.xlsx
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [], counterparty: 'Tailwind' }); const twin = Object.keys(store.get().deals).find((id) => id !== dealId)!; await store.loadDeal(twin);
    expect((await keepImportedLog(store, twin, { path: 'X:\\Deals\\Proseware 2\\Lender A Q&A.xlsx', sheet: 'Log', headerRow: 1, mapping: suggestMapping(columns), make: true, rows: LOG })).ok).toBe(true);
    const r = await store.dispatch(SetQaLogFolder, { dealId: twin, name: 'Lender A Q&A', folder: 'x:\\deals\\proseware\\q&a\\' });
    expect(!r.ok && r.error.message).toBe('Project Proseware already uses “Lender A Q&A.xlsx” in this folder as its Q&A log. Choose another folder');
    // the first deal moves its log away, the twin takes the folder, and the first move's Undo is refused rather than share it
    expect((await store.dispatch(SetQaLogFolder, { dealId, name: 'Lender A Q&A', folder: 'X:\\Elsewhere' })).ok).toBe(true);
    expect((await store.dispatch(SetQaLogFolder, { dealId: twin, name: 'Lender A Q&A', folder: 'X:\\Deals\\Proseware\\Q&A' })).ok).toBe(true);
    const back = await store.dispatch(RestoreQaLogs, { dealId, logs: [{ ...store.get().deals[dealId].qaLogs[0], folder: 'X:\\Deals\\Proseware\\Q&A' }] });
    expect(!back.ok && back.error.message).toMatch(/already uses “Lender A Q&A.xlsx” in this folder/); expect(store.get().deals[dealId].qaLogs[0].folder).toBe('X:\\Elsewhere');
    // an undo that leaves the place as it is is never refused over it
    expect((await store.dispatch(RestoreQaLogs, { dealId: twin, logs: store.get().deals[twin].qaLogs })).ok).toBe(true);
    // a deal with no log of its own: the one the app starts is named with what tells it apart
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [], counterparty: 'Northwind' }); const third = Object.keys(store.get().deals).find((id) => id !== dealId && id !== twin)!; await store.loadDeal(third);
    expect((await exportQaLog(store, third)).ok).toBe(true); expect(made.at(-1)!.file).toMatch(/^Project Proseware \(Northwind\) Q&A log\./);
  });
  it('leaves the file alone when it already holds everything', async () => {
    const { f, saves } = files(); const { store, dealId } = await make(f);
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { status: 'written', added: 0, answered: 0, updated: 0 } }); expect(saves).toEqual([]);
  });
  it('says so when the file is not where it was, and can be found again in another folder', async () => {
    const gone = fail({ kind: 'notFound', message: 'The Q&A log isn’t at X:\\Deals\\Proseware\\Q&A\\Lender A Q&A.xlsx any more' });
    const { f } = files({ read: async () => gone }); const { store, dealId } = await make(f);
    expect(await exportQaLog(store, dealId)).toEqual(gone);
    await store.dispatch(SetQaLogFolder, { dealId, name: 'Lender A Q&A', folder: 'X:\\Deals\\Proseware\\Q&A v2' });
    expect(logOf(store, dealId)).toMatchObject({ folder: 'X:\\Deals\\Proseware\\Q&A v2', file: 'Lender A Q&A.xlsx' });
  });
  it('carries every party\'s questions: it is the one log of the deal', async () => {
    const { f, saves } = files(); const { store, dealId } = await make(f);
    await store.dispatch(CreateQuestion, { dealId, text: 'Is there a tax equity investor?' });
    await store.dispatch(EditQuestionField, { dealId, questionId: dealQuestions(store.get(), dealId)[2].id, field: 'askedBy', value: 'Bidder C' });
    expect(await exportQaLog(store, dealId)).toMatchObject({ value: { added: 1 } });
    expect(saves[0].steps).toContainEqual({ kind: 'cell', row: 3, col: 1, value: 'Is there a tax equity investor?' });
  });
  it('is made in the app\'s own layout, in a folder a person picks, at the first update of a deal with none imported', async () => {
    const { f, made } = files(); const { store, dealId, asked } = await make(f, ['X:\\Deals\\Proseware\\Q&A v2'], null);
    expect(await exportQaLog(store, dealId)).toMatchObject({ ok: true, value: { status: 'written', created: true } });
    expect(asked).toEqual([1]); expect(made.map((m) => [m.folder, m.file])).toEqual([['X:\\Deals\\Proseware\\Q&A v2', 'Project Proseware Q&A log.csv']]);
    expect(logOf(store, dealId)).toMatchObject({ name: 'Project Proseware Q&A log', file: 'Project Proseware Q&A log.csv', folder: 'X:\\Deals\\Proseware\\Q&A v2', sheet: 'Q&A log', headerRow: 1 });
  });
  it('is not made when the person cancels the folder picker', async () => {
    const { f, made } = files(); const { store, dealId } = await make(f, [], null);
    expect(await exportQaLog(store, dealId)).toEqual({ ok: true, value: { status: 'canceled' } });
    expect(made).toEqual([]);
  });
});
