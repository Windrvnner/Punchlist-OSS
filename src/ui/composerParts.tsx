// The controls in a composer: the files attached to the next message, Attach, the model, and Send.
import { useRef } from 'preact/hooks';
import { useAppState, useStore, useDismiss } from './hooks';
import { Icon } from './icons';
import { ChoiceCheck } from './moreMenu';
import { DocName } from './docName';
import { attachFiles, removeAttachment, addToSources, MAX_ATTACHED } from '../app/attachments';
import { canAddToSources } from '../app/citations';
import type { Scope } from '../app/conversations';
import type { Attachment } from '../app/state';

/** Where the files attached in a conversation go: a deal (and finding), or the person's own files. */
export type AttachTarget = { dealId: string; findingId?: string; conv: string };

/** Send; off, with why in its tip, while read-only. */
export function SendButton({ readOnly }: { readOnly: string | null }) {
  return (
    <span class="needs" title={readOnly ?? undefined}>
      <button class="send" type="submit" aria-label="Send" title={readOnly ?? 'Send'} disabled={!!readOnly}>
        <Icon name="send" size={16} />
      </button>
    </span>
  );
}

/**
 * A file attached to the next message: it can be removed, and under a finding, once attached, added to the finding's
 * sources when it is not among them already.
 */
export function Chip({ chip, scope }: { chip: Attachment; scope: Scope }) {
  const store = useStore();
  const state = useAppState();
  const finding = scope.kind === 'finding' ? state.findings[scope.findingId] : null;
  const canAdd = canAddToSources(finding, chip);
  const add = () => void addToSources(store, finding!.dealId, finding!.id, { doc: chip.doc!, docId: chip.docId! });
  return (
    <span class={`chip att ${chip.state === 'pending' ? 'pending' : ''} ${chip.missing ? 'missing' : ''}`}
      title={chip.missing ? `Couldn’t find ${chip.name} — attach it again` : undefined}>
      <Icon name={chip.missing ? 'warn' : 'doc'} size={12} />
      <DocName name={chip.name} />
      {canAdd && <button type="button" class="addsrc" data-addsrc onClick={add}>Add to Sources</button>}
      <button type="button" aria-label={`Remove ${chip.name}`} onClick={() => removeAttachment(store, chip.id)}>
        <Icon name="close" size={11} />
      </button>
    </span>
  );
}

/**
 * Attach, with how many files go with the next message, out of the most it can take; at that many, Attach is off
 */
export function AttachButton({ target, count, readOnly }: {
  target: AttachTarget; count: number; readOnly: string | null;
}) {
  const store = useStore();
  const file = useRef<HTMLInputElement>(null);
  const full = count >= MAX_ATTACHED;
  const tip = readOnly ?? (full ? `${MAX_ATTACHED} files is the most for one message` : 'Attach');
  const choose = () => {
    if (!readOnly && !full) file.current?.click();
  };
  const chosen = (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) void attachFiles(store, target, files);
  };
  return (
    <>
      <button type="button" class="scopebtn attach" id="p-attach" title={tip}
        aria-disabled={readOnly || full ? true : undefined} onClick={choose}>
        <Icon name="clip" size={13} /><span class="t">Attach</span>
        {count > 0 && <span class="acount">{count}/{MAX_ATTACHED}</span>}
      </button>
      <input type="file" ref={file} hidden multiple accept=".pdf,.docx,.xlsx,.xls,.csv"
        onChange={(e) => chosen(e.currentTarget as HTMLInputElement)} />
    </>
  );
}

/** The model a question is asked of, chosen from a menu; shown only when there is more than one. */
export function ModelPill({ open, setOpen, up = true }: {
  open: boolean; setOpen: (open: boolean) => void; up?: boolean;
}) {
  const store = useStore();
  const state = useAppState();
  useDismiss(open, () => setOpen(false), '.mwrap');
  if (state.models.length < 2) return null;
  const current = state.models.find((model) => model.id === state.model);
  const choose = (id: string) => {
    store.setPrefs({ model: id });
    setOpen(false);
  };
  return (
    <span class="mwrap">
      <button type="button" class="scopebtn" title="Answer mode" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <Icon name="model" size={13} /> {current?.name ?? ''}<span class="chev"><Icon name="chev" size={13} /></span>
      </button>
      {open && <ModelMenu up={up} choose={choose} />}
    </span>
  );
}

function ModelMenu({ up, choose }: { up: boolean; choose: (id: string) => void }) {
  const state = useAppState();
  return (
    <div class={`colmenu glass mmenu ${up ? '' : 'down'}`} role="menu">{state.models.map((model) => (
      <button type="button" role="menuitemradio" aria-checked={model.id === state.model} key={model.id}
        class={`mi ${model.id === state.model ? 'on' : ''}`} onClick={() => choose(model.id)}>
        {model.name}<ChoiceCheck on={model.id === state.model} />
      </button>
    ))}</div>
  );
}
