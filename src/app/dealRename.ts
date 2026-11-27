import { cleanName, EditDeal } from './commands/deals';
import { type FieldDraft, unsavedFields } from './fieldDrafts';
import { fieldSaveOutcome, type FieldSaveOutcome } from './fieldSave';
import type { Store } from './store';

type RenameInput = { render(): void; close(): void; focus(): void };

/**
 * The deal name saves on Enter or blur, keeping its typing as EditField does (`deal-name:<id>` in `unsavedFields`).
 * Escape restores the draft kept when the box opened, or the one last refused.
 */
export class DealRename {
  editing = false;
  changedElsewhere = false;
  private entry?: FieldDraft;
  private over = { base: '', rev: 0 };
  private saving = false;
  private gone = false;

  constructor(private store: Store, private id: string, private input: RenameInput) {}

  get kept() {
    return unsavedFields.get('deal-name:' + this.id);
  }

  get text() {
    return this.kept?.text ?? this.over.base;
  }

  private keep(draft: FieldDraft | undefined) {
    if (draft) unsavedFields.set('deal-name:' + this.id, draft);
    else unsavedFields.delete('deal-name:' + this.id);
  }

  open() {
    const deal = this.store.get().deals[this.id];
    this.entry = this.kept;
    this.over = this.entry ?? { base: deal.name, rev: deal.rev };
    this.editing = true;
    this.changedElsewhere = false;
    this.input.render();
  }

  typed(text: string) {
    this.keep({ text, base: this.over.base, rev: this.over.rev });
  }

  escape() {
    this.keep(this.entry);
    this.close();
  }

  takeTheirs() {
    this.keep(undefined);
    this.close();
  }

  private close() {
    this.editing = false;
    this.input.close();
  }

  dispose() {
    this.gone = true;
  }

  async submit(event: 'enter' | 'blur' | 'mine') {
    if (this.gone || !this.editing || this.saving || (this.changedElsewhere && event !== 'mine')) return;
    const deal = this.store.get().deals[this.id];
    const name = cleanName(this.text);
    if (!name && event !== 'blur') return this.store.toast('A deal needs a name', 'warn');
    if (!name || name === deal.name) return this.takeTheirs();
    if (event === 'mine') this.over = { base: deal.name, rev: deal.rev };
    const sent = { text: this.text, base: this.over.base, rev: this.over.rev };
    this.saving = true;
    const result = await this.store.dispatch(EditDeal, { dealId: this.id, name }, { quiet: true, over: sent.base });
    this.saving = false;
    const outcome = fieldSaveOutcome(result, 'record');
    // FieldSave's rule: a kept draft is forgotten only if it is the text sent; newer typing stays kept.
    if (outcome.kind === 'saved' && this.kept?.text === sent.text) this.keep(undefined);
    if (outcome.kind !== 'saved' && (this.kept?.text ?? sent.text) === sent.text) this.keep(sent);
    if (!this.gone) this.show(outcome, sent);
  }

  private show(outcome: FieldSaveOutcome, sent: FieldDraft) {
    if (!this.editing) return this.input.render();
    if (outcome.kind === 'saved') return this.kept ? this.input.render() : this.close();
    this.entry = sent;
    this.changedElsewhere = outcome.kind === 'changedElsewhere';
    if (outcome.kind === 'changedElsewhere') return this.input.render();
    const locked = this.store.readOnly();
    this.store.toast(locked ?? outcome.reason, 'warn');
    if (locked) this.close();
    else this.input.focus();
  }
}
