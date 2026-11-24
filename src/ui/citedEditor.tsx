/**
 * A finding's detail, edited in place with its citations as small tags (#636). Each "[n]" marker
 * shows as a tag naming the source it cites, after the sentence it supports, and it moves with that sentence as
 * the words around it are edited. What the editor gives back is the stored form: plain text with "[n]" markers.
 *
 * The box is filled once, when it opens. From then on the browser edits it as a person types, so the caret and
 * the browser's own Undo are never disturbed by a redraw.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Source } from '../domain/model';
import { type MarkerPiece, markerPieces, remapMarkerPieces, takeMarkerPieces, withoutMarkers } from '../domain/cite';
import { TEXT_MAX } from '../domain/importExport';
import { docTitle, displayName, graphemes } from './docName';
import { showTip, hideTip } from './tip';

/** a tag shows at most this many characters of its source's name, the last of them "…" */
export const TAG_MAX = 30;

/** The words a tag shows: the document's title, cut to TAG_MAX characters with an ellipsis. */
export function tagLabel(name: string): string {
  const letters = graphemes(docTitle(name));
  if (letters.length <= TAG_MAX) return letters.join('');
  return `${letters.slice(0, TAG_MAX - 1).join('').trimEnd()}…`;
}

/** One citation as a tag: the browser moves and deletes it as one character, and it holds its marker. */
function citationTag(marker: string, source: Source): HTMLSpanElement {
  const tag = document.createElement('span');
  tag.className = 'ctag';
  tag.contentEditable = 'false';
  tag.dataset.marker = marker;
  tag.dataset.name = displayName(source.doc);
  tag.textContent = tagLabel(source.doc);
  return tag;
}

/** Text with markers as the nodes the editor shows: the words as text, each marker as its tag. */
function citedNodes(pieces: MarkerPiece[], sources: Source[]): Node[] {
  return pieces.map((piece) =>
    piece.ref ? citationTag(piece.text, sources[piece.ref - 1]) : document.createTextNode(piece.text));
}

/** Lines the browser may make of its own when text is typed or dropped: each starts a new line. */
const LINE_ELEMENTS = new Set(['DIV', 'P']);

/** The stored form of what the editor (or part of it) holds: its words, a tag as its marker, a line break as "\n". */
export function editorText(root: Node): string {
  let out = '';
  for (const node of Array.from(root.childNodes)) out += nodeText(node);
  return out;
}

function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  if (element.dataset.marker) return element.dataset.marker;
  if (element.tagName === 'BR') return '\n';
  const inner = editorText(element);
  return LINE_ELEMENTS.has(element.tagName) ? `\n${inner}` : inner;
}

/** what is selected now, in the stored form ("" with nothing selected) */
function selectedText(): string {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
  return editorText(selection.getRangeAt(0).cloneContents());
}

/** what the box still has room for: whole characters only, so a letter or an emoji is never cut in half */
function fitTo(pieces: MarkerPiece[], room: number): MarkerPiece[] {
  const text = pieces.map((piece) => piece.text).join('');
  if (text.length <= room) return pieces;
  let end = 0;
  for (const character of graphemes(text)) {
    if (end + character.length > room) break;
    end += character.length;
  }
  return takeMarkerPieces(pieces, end);
}

/**
 * Text put in where the caret is, as plain text with its markers as tags, as far as the box has room, in one step
 * of the browser's editing (two with a break at its end), so Undo takes it back. Line breaks inside it stay "\n"
 * text, as the box's own are; a break at its very end goes in as the browser's own, so what is typed next starts
 * the new line.
 */
function insertCited(pieces: MarkerPiece[], box: HTMLElement, sources: Source[]) {
  const room = TEXT_MAX - editorText(box).length + selectedText().length;
  const fitting = fitTo(pieces, Math.max(0, room));
  const fitted = fitting.map((piece) => piece.text).join('');
  const words = fitted.replace(/\n+$/, '');
  if (words) {
    const holder = document.createElement('div');
    const inline = words.length === fitted.length ? fitting : takeMarkerPieces(fitting, words.length);
    holder.append(...citedNodes(inline, sources));
    document.execCommand('insertHTML', false, holder.innerHTML);
  }
  if (fitted.length > words.length) document.execCommand('insertLineBreak');
}

/** the clipboard type that carries copied words with the sources their markers name, for a paste in the app */
const CITED_TYPE = 'application/x-punchlist-cited';
type CitedClip = { text: string; sources: Source[] };

/** a copied passage as it came back from the clipboard, or null when it is missing or not one of ours */
function readClip(raw: string): CitedClip | null {
  try {
    const clip = raw ? JSON.parse(raw) : null;
    const sourcesOk = Array.isArray(clip?.sources)
      && clip.sources.every((x: Source) => typeof x?.docId === 'string' && typeof x?.loc === 'string');
    return typeof clip?.text === 'string' && sourcesOk ? clip : null;
  } catch {
    return null;
  }
}

function markupWords(markup: string): string {
  const page = new DOMParser().parseFromString(markup, 'text/html');
  for (const code of Array.from(page.querySelectorAll('script, style'))) code.remove();
  return page.body.textContent ?? '';
}

const pasteLines = (text: string) => text.replace(/\r\n?/g, '\n');

/** Preserve the roles in a native passage. External text uses the receiving editor's source count. */
function incomingPieces(data: DataTransfer | null, sources: Source[]): MarkerPiece[] {
  if (!data) return [];
  const clip = readClip(data.getData(CITED_TYPE));
  if (clip) return remapMarkerPieces(pasteLines(clip.text), clip.sources, sources);
  const text = data.getData('text/plain') || markupWords(data.getData('text/html'));
  return markerPieces(pasteLines(text), sources.length);
}

function pasteCited(event: ClipboardEvent, box: HTMLElement, sources: Source[]) {
  event.preventDefault();
  insertCited(incomingPieces(event.clipboardData, sources), box, sources);
}

/** Text dropped from outside goes in where it is dropped, as a paste would. */
function dropCited(event: DragEvent, box: HTMLElement, sources: Source[]) {
  event.preventDefault();
  const at = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  box.focus();
  // on a tag, the text goes in after it: a tag cannot be typed into
  const tag = document.elementFromPoint(event.clientX, event.clientY)?.closest('.ctag');
  if (at && tag) at.setStartAfter(tag);
  if (at && box.contains(at.startContainer)) {
    at.collapse(true);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(at);
  }
  insertCited(incomingPieces(event.dataTransfer, sources), box, sources);
}

/**
 * Copy and Cut: other apps get the words without markers, as any copy does (decisions: Conversations); a paste
 * in a finding's editor gets the markers with their sources, so the sentence keeps its citation.
 */
function copyCited(event: ClipboardEvent, cut: boolean, sources: Source[]) {
  const text = selectedText();
  if (!text) return;
  event.preventDefault();
  event.clipboardData?.setData('text/plain', withoutMarkers(text, sources.length));
  event.clipboardData?.setData(CITED_TYPE, JSON.stringify({ text, sources }));
  if (cut) document.execCommand('delete');
}

/**
 * Keeps the box plain text: no bold or italic, Enter makes a line break, and nothing is typed past TEXT_MAX
 * (the limit the text box had).
 */
function guardInput(event: InputEvent, box: HTMLElement) {
  const kind = event.inputType;
  if (kind.startsWith('format')) {
    event.preventDefault();
    return;
  }
  const typing = kind === 'insertText' || kind === 'insertLineBreak' || kind === 'insertParagraph';
  const full = editorText(box).length - selectedText().length >= TEXT_MAX;
  if (typing && full) {
    event.preventDefault();
    return;
  }
  if (kind === 'insertParagraph') {
    event.preventDefault();
    document.execCommand('insertLineBreak');
  }
}

/** a tag's tooltip is its source's whole name */
const tagUnder = (event: MouseEvent) => (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.ctag') ?? null;
function showTagName(event: MouseEvent) {
  const tag = tagUnder(event);
  if (tag) showTip(tag, tag.dataset.name ?? '');
}
function hideTagName(event: MouseEvent) {
  const tag = tagUnder(event);
  if (tag) hideTip(tag);
}

type CitedEditorProps = { id: string; label: string; text: string; sources: Source[]; onText: (text: string) => void };

export function CitedEditor({ id, label, text, sources, onText }: CitedEditorProps) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    box.current?.replaceChildren(...citedNodes(markerPieces(text, sources.length), sources));
  }, []);
  const changed = () => {
    if (box.current) onText(editorText(box.current));
  };
  const element = () => box.current as HTMLDivElement;
  // text is not dragged out of the box (Cut and Paste move it), so a tag is never left behind its sentence
  const noDrag = (event: DragEvent) => event.preventDefault();
  return (
    <div class="in ta ced" id={id} ref={box} role="textbox" aria-multiline="true" aria-label={label}
      contentEditable spellcheck onInput={changed}
      onBeforeInput={(event) => guardInput(event as InputEvent, element())}
      onPaste={(event) => pasteCited(event, element(), sources)}
      onCopy={(event) => copyCited(event, false, sources)} onCut={(event) => copyCited(event, true, sources)}
      onDragStart={noDrag} onDragOver={noDrag} onDrop={(event) => dropCited(event, element(), sources)}
      onMouseOver={showTagName} onMouseOut={hideTagName} />
  );
}
