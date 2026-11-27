import { cleanName, EditDeal, withProject } from './commands/deals';
import type { FieldDraft } from './fieldDrafts';
import { FieldSave, type FieldSaveOutcome } from './fieldSave';
import { hasTexts, keptDrafts } from './keptText';
import { pendingSave, sendSave } from './saveOut';
import type { Store } from './store';

const legacyNames = keptDrafts('deal-name', hasTexts('text', 'base'));
type RenameInput = { render(): void; close(): void; focus(): void };
type Landed = { sent: FieldDraft; outcome: FieldSaveOutcome; matches: boolean; rebased?: FieldDraft };

const sameBase = (a: FieldDraft, b: FieldDraft) => a.base === b.base && a.rev === b.rev;

/** The name saves only on Enter or blur. Escape restores the rename that was waiting when the box opened. */
export class DealRename extends FieldSave {
  editing = false;
  changedElsewhere = false;
  private entry?: FieldDraft;
  private gone = false;
  private key: string;

  constructor(private store: Store, private id: string, private input: RenameInput) {
    const key = 'deal-name:' + id;
    const deal = store.get().deals[id];
    super({ value: deal.name, rev: deal.rev }, key);
    this.key = key;
    const old = legacyNames.get(id);
    if (old) {
      if (!this.kept) this.restore({ ...old, rev: old.base === deal.name ? deal.rev : -1 });
      if (this.kept?.text === old.text && this.kept.base === old.base) legacyNames.delete(id);
    }
    void (pendingSave(key) as Promise<Landed> | undefined)?.then((landed) => this.show(landed));
  }

  get text() {
    return this.kept?.text ?? this.base;
  }

  open() {
    this.entry = this.kept;
    const deal = this.store.get().deals[this.id];
    this.base = this.entry?.base ?? deal.name;
    this.baseRev = this.entry?.rev ?? deal.rev;
    this.editing = true;
    this.changedElsewhere = false;
    this.input.render();
  }

  typed(text: string) {
    this.keepOverBase(text);
  }

  escape() {
    this.restore(this.entry);
    this.close();
  }

  takeTheirs() {
    this.restore(undefined);
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
    if (this.gone || !this.editing || pendingSave(this.key) || (this.changedElsewhere && event !== 'mine')) return;
    const deal = this.store.get().deals[this.id];
    const name = cleanName(this.text);
    if (!name && event !== 'blur') {
      this.store.toast('A deal needs a name', 'warn');
      return;
    }
    if (!name || name === deal.name) {
      this.takeTheirs();
      return;
    }
    if (event === 'mine') {
      this.base = deal.name;
      this.baseRev = deal.rev;
      this.changedElsewhere = false;
    }
    const sent = { text: this.text, base: this.base, rev: this.baseRev };
    this.restore(sent);
    const pending = sendSave(this.key, () => this.write(name, sent));
    if (pending) this.show(await pending);
  }

  /** Settle the snapshot, even after leaving the page. A new draft over a different base is independent (#771). */
  private async write(name: string, sent: FieldDraft): Promise<Landed> {
    const commit = (value: string, over: string) =>
      this.store.dispatch(EditDeal, { dealId: this.id, name: value }, { quiet: true, over });
    const outcome = await this.send(name, sent.base, commit, 'record');
    const deal = this.store.get().deals[this.id];
    const current = this.kept;
    const related = deal && current && sameBase(current, sent);
    const matches = !!related && current.text === sent.text;
    if (outcome.kind === 'saved' && related) {
      const base = withProject(name);
      const rebased = matches ? undefined : { text: current.text, base, rev: deal.name === base ? deal.rev : -1 };
      this.restore(rebased);
      return { sent, outcome, matches, rebased };
    }
    return { sent, outcome, matches };
  }

  /** A reopened editor also observes the result. Only the matching rename can close or show a refusal. */
  private show(landed: Landed) {
    if (this.gone) return;
    if (!this.editing) {
      this.input.render();
      return;
    }
    const { sent, outcome, matches } = landed;
    if (outcome.kind === 'saved') {
      this.saved(landed);
      return;
    }
    if (!matches) return;
    this.entry = sent;
    if (outcome.kind === 'changedElsewhere') {
      this.changedElsewhere = true;
      this.input.render();
      return;
    }
    const locked = this.store.readOnly();
    this.store.toast(locked ?? outcome.reason, 'warn');
    if (locked) this.close();
    else this.input.focus();
  }

  private saved({ sent, matches, rebased }: Landed) {
    if (this.entry && sameBase(this.entry, sent)) {
      if (this.entry.text === sent.text) this.entry = undefined;
      else if (rebased) this.entry = { ...rebased, text: this.entry.text };
    }
    if (rebased) {
      this.base = rebased.base;
      this.baseRev = rebased.rev;
    } else if (matches && !this.kept) this.close();
  }
}
