/**
 * The file pick the import dialogs share: a hidden file input, and a drop zone that takes a dropped file and lights up
 * while a file is dragged over it. Every drop zone shows the import icon above its words (design.md, drop areas).
 */
import type { ComponentChildren, Ref } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { Icon } from './icons';

/** The hidden file input. It is cleared after each pick, so choosing the same file again still reads it. */
export function FileInput({ id, accept, inputRef, onFile }: {
  id: string;
  accept: string;
  inputRef: Ref<HTMLInputElement>;
  onFile: (file: File) => void;
}) {
  const picked = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) onFile(file);
  };
  return <input type="file" id={id} hidden accept={accept} ref={inputRef} onChange={picked} />;
}

/**
 * The drop zone: its words and the "choose a file…" button come in as children. `tall` is the 160px area that stands in
 * for an empty list (the firm's checklist with no lists yet). `compact` is the one-line area under a list, with the
 * icon at 16px before its words (Folders). `onDrop` takes the whole drop, for folders, in place of `onFile`.
 */
export function DropZone({ id, onFile, onDrop, tall, compact, children }: {
  id: string;
  onFile?: (file: File) => void;
  onDrop?: (e: DragEvent) => void;
  tall?: boolean;
  compact?: boolean;
  children: ComponentChildren;
}) {
  const [over, setOver] = useState(false);
  const dragOver = (e: DragEvent) => {
    e.preventDefault();
    setOver(true);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    if (onDrop) {
      onDrop(e);
      return;
    }
    const file = e.dataTransfer?.files[0];
    if (file) onFile?.(file);
  };
  const leave = () => setOver(false);
  return (
    <div class={['dropzone', over ? 'over' : '', tall ? 'tall' : '', compact ? 'row' : ''].filter(Boolean).join(' ')}
      id={id} onDragOver={dragOver} onDragLeave={leave} onDrop={drop}>
      <Icon name="import" size={compact ? 16 : 20} />
      <div>{children}</div>
    </div>
  );
}

/** The File row of an import before a file is read: the drop zone, and under it why the last file could not be read */
export function PickFileRow({ dropId, errorId, error, onFile, children }: {
  dropId: string;
  errorId: string;
  error: string;
  onFile: (file: File) => void;
  children: ComponentChildren;
}) {
  return (
    <div class="srow"><div class="k">File</div><div>
      <DropZone id={dropId} onFile={onFile}>{children}</DropZone>
      {error && <p class="emptyline" id={errorId} role="alert" style="margin-top:10px">{error}</p>}
    </div></div>
  );
}

/** A drop zone with its own "choose a file…" button and file input, for a dialog that needs neither elsewhere */
export function FileDrop(props: {
  /** ids of the zone, its "choose a file…" button and its hidden file input, which the tests find it by */
  id: string;
  browseId: string;
  fileId: string;
  accept: string;
  /** the words before "choose a file…", such as "Drop a file here, or" */
  words: string;
  /** the tooltip on "choose a file…", naming the kinds of file it takes */
  browseTitle?: string;
  tall?: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <DropZone id={props.id} onFile={props.onFile} tall={props.tall}>
      {props.words}{' '}
      <button type="button" class="linkb" id={props.browseId} title={props.browseTitle}
        onClick={() => inputRef.current?.click()}>choose a file…</button>
      <FileInput id={props.fileId} accept={props.accept} inputRef={inputRef} onFile={props.onFile} />
    </DropZone>
  );
}

/** The box a list is pasted into, under the file row, as the checklist and issues-list imports both take one */
export function PasteRow({ id, value, onInput }: { id: string; value: string; onInput: (text: string) => void }) {
  return (
    <div class="srow top cl-pasterow"><div class="k">Paste</div><div>
      <textarea class="field cl-paste" id={id} aria-label="Paste a list" placeholder="Paste a list"
        spellcheck={false} value={value} onInput={(e) => onInput((e.currentTarget as HTMLTextAreaElement).value)} />
    </div></div>
  );
}

/** The paste box's Next, off until something is pasted; its tooltip then says what it waits for */
export function PasteNext({ id, lines, busy, onNext }: {
  id: string;
  lines: number;
  busy: boolean;
  onNext: () => void;
}) {
  return (
    <span class="needs" title={lines ? undefined : 'Paste a list, or choose a file'}>
      <button class="btn sm pri" type="button" id={id} disabled={!lines || busy} onClick={onNext}>Next</button>
    </span>
  );
}
