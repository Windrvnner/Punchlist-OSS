import { cleanName, EditDeal } from './commands/deals';
import { type FieldDraft, unsavedFields } from './fieldDrafts';
import { fieldSaveOutcome, type FieldSaveOutcome } from './fieldSave';
import type { Store } from './store';

type RenameInput = { render(): void; close(): void; focus(): void };

/** Saves the deal name on Enter or blur, its typing kept like an edit field's. Escape restores the entry draft. */
export class DealRename {
  editing = false;
  changedElsewhere = false;
  private entry?: FieldDraft;
  private over = { base: '', rev: 0 };   // the name typed over
  private saving = false;
  private gone = false;

  constructor(private store: Store, private id: string, private input: RenameInput) {}

  get kept() { return unsavedFields.get('deal-name:' + this.id); }
  get text() { return this.kept?.text ?? this.over.base; }
  typed(text: string) { this.keep({ ...this.over, text }); }
  escape() { this.close(this.entry); }
  takeTheirs() { this.close(undefined); }
  dispose() { this.gone = true; }

  open() {
    const { name, rev } = this.store.get().deals[this.id];
    this.entry = this.kept;
    this.over = this.entry ?? { base: name, rev };
    this.editing = true;
    this.changedElsewhere = false;
    this.input.render();
  }

  private keep(draft: FieldDraft | undefined) {
    if (draft) unsavedFields.set('deal-name:' + this.id, draft);
    else unsavedFields.delete('deal-name:' + this.id);
  }

  private close(draft: FieldDraft | undefined) {
    this.keep(draft);
    this.editing = false;
    this.input.close();
  }

  async submit(event: 'enter' | 'blur' | 'mine') {
    if (this.gone || !this.editing || this.saving || (this.changedElsewhere && event !== 'mine')) return;
    const deal = this.store.get().deals[this.id];
    const name = cleanName(this.text);
    if (!name && event !== 'blur') return this.store.toast('A deal needs a name', 'warn');
    if (!name || name === deal.name) return this.takeTheirs();
    if (event === 'mine') this.over = { base: deal.name, rev: deal.rev };
    const sent = { ...this.over, text: this.text };
    this.saving = true;
    const result = await this.store.dispatch(EditDeal, { dealId: this.id, name }, { quiet: true, over: sent.base });
    this.saving = false;
    const outcome = fieldSaveOutcome(result, 'record');
    // FieldSave's rule: a result settles only the text sent; newer typing stays kept.
    if ((this.kept?.text ?? sent.text) === sent.text) this.keep(outcome.kind === 'saved' ? undefined : sent);
    if (!this.gone) this.show(outcome, sent);
  }

  private show(outcome: FieldSaveOutcome, sent: FieldDraft) {
    if (outcome.kind === 'saved') return this.kept || !this.editing ? this.input.render() : this.close(undefined);
    this.entry = sent;
    this.changedElsewhere = outcome.kind === 'changedElsewhere';
    if (outcome.kind === 'changedElsewhere') return this.input.render();
    const locked = this.store.readOnly();
    this.store.toast(locked ?? outcome.reason, 'warn');
    if (!this.editing) this.input.render();
    else if (locked) this.close(this.kept);
    else this.input.focus();
  }
}
