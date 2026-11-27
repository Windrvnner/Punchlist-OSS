import { cleanName, EditDeal } from './commands/deals';
import { fieldSaveOutcome, type FieldSaveOutcome } from './fieldSave';
import { hasTexts, keptDrafts } from './keptText';
import type { Store } from './store';

type RenameInput = { render(): void; close(): void; focus(): void };
type NameDraft = { text: string; base: string };

/** A deal name being typed, by deal, kept on this PC until it is saved or let go: `base` is the name typed over. */
const keptNames = keptDrafts('deal-name', hasTexts('text', 'base'));

/** Saves the deal name on Enter or blur, its typing kept like an edit field's. Escape restores the entry draft. */
export class DealRename {
  editing = false;
  changedElsewhere = false;
  private entry?: NameDraft;
  private over = { base: '' };   // the name typed over
  private saving = false;
  private next?: 'enter' | 'blur';   // Enter or leaving the box while a save is out, sent once it lands
  private gone = false;

  constructor(private store: Store, private id: string, private input: RenameInput) {}

  get kept() { return keptNames.get(this.id); }
  get text() { return this.kept?.text ?? this.over.base; }
  typed(text: string) { this.keep({ ...this.over, text }); }
  escape() { this.close(this.entry); }
  takeTheirs() { this.close(undefined); }
  dispose() { this.gone = true; }

  open() {
    this.entry = this.kept;
    this.over = this.entry ?? { base: this.store.get().deals[this.id].name };
    this.editing = true;
    this.changedElsewhere = false;
    this.input.render();
  }

  private keep(draft: NameDraft | undefined) {
    if (draft) keptNames.set(this.id, draft);
    else keptNames.delete(this.id);
  }

  private close(draft: NameDraft | undefined) {
    this.keep(draft);
    this.editing = false;
    this.input.close();
  }

  async submit(event: 'enter' | 'blur' | 'mine') {
    if (this.saving && event !== 'mine') this.next = event;
    if (this.gone || !this.editing || this.saving || (this.changedElsewhere && event !== 'mine')) return;
    const deal = this.store.get().deals[this.id];
    const name = cleanName(this.text);
    if (!name && event !== 'blur') return this.store.toast('A deal needs a name', 'warn');
    if (!name || name === deal.name) return this.takeTheirs();
    if (event === 'mine') this.over = { base: deal.name };
    const sent = { ...this.over, text: this.text };
    this.saving = true;
    const result = await this.store.dispatch(EditDeal, { dealId: this.id, name }, { quiet: true, over: sent.base });
    this.saving = false;
    const outcome = fieldSaveOutcome(result, 'record');
    // FieldSave's rule: a result settles only the text sent; newer typing stays kept.
    if ((this.kept?.text ?? sent.text) === sent.text) this.keep(outcome.kind === 'saved' ? undefined : sent);
    else if (outcome.kind === 'saved') this.adoptSaved();
    if (!this.gone) this.show(outcome, sent);
    const next = this.next;
    this.next = undefined;
    if (next && outcome.kind === 'saved' && this.kept) await this.submit(next);
  }

  /** Newer typing now lies over the name just saved, as FieldSave adopts a base; Escape lets it go (#1204). */
  private adoptSaved() {
    const deal = this.store.get().deals[this.id];
    const kept = this.kept;
    if (!deal || !kept) return;
    this.over = { base: deal.name };
    this.keep({ ...kept, ...this.over });
    this.entry = undefined;
  }

  private show(outcome: FieldSaveOutcome, sent: NameDraft) {
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
