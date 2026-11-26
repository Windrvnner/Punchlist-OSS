/**
 * The Excel exports of the Q&A log and the findings. Each opens on the filter of the page it was opened from; the
 * footer counts what the export will hold.
 */
import { useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Modal, DialogHead } from './dialogs';
import { plural } from './counts';
import { checkedOf, chosenOf } from './fieldValue';
import {
  exportQuestions, exportFindings, qaExportView, qaFilterFromPage, findingExportView, findingFilterFromPage,
  type QaExportFilter, type FindingExportFilter,
} from '../app/transfer';
import type { Store } from '../app/store';
import type { Result } from '../domain/result';

type QaStatus = QaExportFilter['status'];
type FindingStatus = FindingExportFilter['status'];
const QA_STATUSES: readonly (readonly [QaStatus, string])[] = [
  ['open', 'Open'],
  ['answered', 'Answered'],
  ['closed', 'Closed'],
  ['all', 'All'],
];
const FINDING_STATUSES: readonly (readonly [FindingStatus, string])[] = [
  ['open', 'Open'],
  ['closed', 'Closed'],
  ['all', 'All'],
];

/** Export Q&A log: by status, by the parties who submitted the questions, and by workstream */
export function ExportQaDialog({ dealId }: { dealId: string }) {
  const store = useStore();
  const state = useAppState();
  const [filter, setFilter] = useState<QaExportFilter>(() => qaFilterFromPage(state, dealId));
  const change = (part: Partial<QaExportFilter>) => setFilter({ ...filter, ...part });
  const exporting = useExport(store, () => exportQuestions(store, dealId, filter), 'question');
  const { firms, firmCounts, firmsTotal, total, workstreams } = qaExportView(state, dealId, filter);
  const allFirms = firms.every((firm) => filter.askedBy.includes(firm));
  const pickFirm = (firm: string, on: boolean) => {
    change({ askedBy: on ? [...filter.askedBy, firm] : filter.askedBy.filter((x) => x !== firm) });
  };
  return (
    <Modal onClose={exporting.close} label="Export Q&A log" blur className="sdlg xdlg">
      <DialogHead title="Export Q&A Log" onClose={exporting.close} disabled={exporting.busy} />
      <div class="srow"><div class="k">Status</div>
        <Segmented id="x-status" options={QA_STATUSES} value={filter.status} onPick={(status) => change({ status })} />
      </div>
      <div class="srow top"><div class="k">Submitted By</div><div class="xlist" id="x-by">
        <label class="xall">
          <input type="checkbox" checked={allFirms} onChange={(e) => change({ askedBy: checkedOf(e) ? firms : [] })} />
          <span>All firms</span><span class="c">{firmsTotal}</span>
        </label>
        {firms.map((firm) => <label key={firm}>
          <input type="checkbox" checked={filter.askedBy.includes(firm)}
            onChange={(e) => pickFirm(firm, checkedOf(e))} />
          <span>{firm.trim() ? firm : 'Not recorded'}</span><span class="c">{firmCounts.get(firm)}</span>
        </label>)}
      </div></div>
      <div class="srow"><div class="k">Workstream</div>
        <WorkstreamSelect id="x-ws" value={filter.workstream} choices={workstreams}
          onPick={(ws) => change({ workstream: ws })} />
      </div>
      <ExportFoot countId="x-count" goId="x-go" word="question" total={total} exporting={exporting} />
    </Modal>
  );
}

/** Export findings: by status, by workstream, and reviewed ones only */
export function ExportFindingsDialog({ dealId }: { dealId: string }) {
  const store = useStore();
  const state = useAppState();
  const [filter, setFilter] = useState<FindingExportFilter>(() => findingFilterFromPage(state));
  const change = (part: Partial<FindingExportFilter>) => setFilter({ ...filter, ...part });
  const exporting = useExport(store, () => exportFindings(store, dealId, filter), 'finding');
  const { total, workstreams } = findingExportView(state, dealId, filter);
  return (
    <Modal onClose={exporting.close} label="Export findings" blur className="sdlg xdlg">
      <DialogHead title="Export Findings" onClose={exporting.close} disabled={exporting.busy} />
      <div class="srow"><div class="k">Status</div>
        <Segmented id="fx-status" options={FINDING_STATUSES} value={filter.status}
          onPick={(status) => change({ status })} />
      </div>
      <div class="srow"><div class="k">Workstream</div>
        <WorkstreamSelect id="fx-ws" value={filter.workstream} choices={workstreams}
          onPick={(ws) => change({ workstream: ws })} />
      </div>
      <div class="srow"><div class="k">Reviewed</div><label class="xcheck">
        <input type="checkbox" id="fx-rev" checked={filter.reviewedOnly}
          onChange={(e) => change({ reviewedOnly: checkedOf(e) })} />
        <span>Reviewed findings only</span>
      </label></div>
      <ExportFoot countId="fx-count" goId="fx-go" word="finding" total={total} exporting={exporting} />
    </Modal>
  );
}

/**
 * Runs an export: the dialog closes with a toast when the file is written, stays as it was when the person cancels the
 * save, and shows the failure in its footer (with Retry) when the file could not be built. It can't close while it
 * runs.
 */
function useExport(store: Store, write: () => Promise<Result<number | 'canceled'>>, word: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => {
    if (!busy) store.ui({ dialog: null });
  };
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const written = await write();
    setBusy(false);
    if (!written.ok) {
      setError('Couldn’t build the export');
      return;
    }
    if (written.value === 'canceled') return;
    store.ui({ dialog: null });
    store.toast(`Exported ${plural(written.value, word)} to Excel`);
  };
  return { busy, error, close, run };
}
type Exporting = ReturnType<typeof useExport>;

/** The export's footer: how many rows it will hold (or why it failed), and the button that writes it */
function ExportFoot({ countId, goId, word, total, exporting }: {
  countId: string;
  goId: string;
  word: string;
  total: number;
  exporting: Exporting;
}) {
  const { error, busy, run } = exporting;
  return (
    <div class="xfoot">
      <span id={countId} class={error ? 'err' : ''} role={error ? 'alert' : undefined}>
        {error || plural(total, word)}
      </span>
      <span class="grow" />
      <button class="btn sm pri" type="button" id={goId} disabled={!total || busy} onClick={() => void run()}>
        {error ? 'Retry' : 'Export to Excel'}
      </button>
    </div>
  );
}

/** A row of buttons of which one is on, such as the status to export */
function Segmented<T extends string>({ id, options, value, onPick }: {
  id: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <div class="seg" id={id}>
      {options.map(([key, label]) => (
        <button type="button" key={key} class={value === key ? 'on' : ''} onClick={() => onPick(key)}>{label}</button>
      ))}
    </div>
  );
}

/** The workstream to export, or all of them */
function WorkstreamSelect({ id, value, choices, onPick }: {
  id: string;
  value: string;
  choices: string[];
  onPick: (workstream: string) => void;
}) {
  const picked = (e: Event) => onPick(chosenOf(e));
  return (
    <select class="field" id={id} aria-label="Workstream" value={value} onChange={picked}>
      <option value="">All Workstreams</option>
      {choices.map((w) => <option key={w} value={w}>{w}</option>)}
    </select>
  );
}
